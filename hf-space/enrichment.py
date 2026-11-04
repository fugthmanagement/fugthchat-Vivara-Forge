"""Evidence-only public contact extraction helpers."""

from __future__ import annotations

import ipaddress
import json
import re
import socket
from dataclasses import dataclass, field
from io import BytesIO
from urllib.parse import urlencode, urljoin, urlparse, urlunparse

import httpx
from bs4 import BeautifulSoup
from pypdf import PdfReader

USER_AGENT = "VivaraForgeResearch/1.0"
EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+", re.I)
MAX_BYTES = 2_500_000
MAX_TEXT_CHARS = 500_000
TIMEOUT = httpx.Timeout(12.0, connect=5.0)


@dataclass
class FetchResult:
    url: str
    text: str
    is_pdf: bool
    error: str = ""
    links: list[dict] = field(default_factory=list)
    profile: dict = field(default_factory=dict)


def _plain(value: object, limit: int = 500) -> str:
    if isinstance(value, (str, int, float)):
        return re.sub(r"\s+", " ", str(value)).strip()[:limit]
    return ""


def _jsonld_objects(value: object) -> list[dict]:
    if isinstance(value, list):
        return [item for part in value for item in _jsonld_objects(part)]
    if not isinstance(value, dict):
        return []
    found = [value]
    graph = value.get("@graph")
    if graph is not None:
        found.extend(_jsonld_objects(graph))
    return found


def _profile_from_html(soup: BeautifulSoup, current_url: str) -> dict:
    """Read explicit page metadata and Schema.org JSON-LD; never execute page scripts."""
    profile: dict = {}
    structured_objects: list[dict] = []
    for script in soup.select('script[type="application/ld+json"]')[:20]:
        try:
            structured_objects.extend(_jsonld_objects(json.loads(script.get_text(" ", strip=True))))
        except (ValueError, TypeError):
            continue

    selected = next((obj for obj in structured_objects if any(
        kind in " ".join(obj.get("@type", []) if isinstance(obj.get("@type"), list) else [str(obj.get("@type", ""))]).casefold()
        for kind in ("organization", "localbusiness", "store", "professionalservice", "medicalbusiness", "automotivebusiness")
    )), {})
    if not selected and structured_objects:
        selected = structured_objects[0]

    for key, source, cap in (
        ("businessName", selected.get("name"), 160),
        ("phone", selected.get("telephone"), 80),
        ("email", selected.get("email"), 254),
        ("description", selected.get("description"), 500),
        ("hours", selected.get("openingHours"), 300),
        ("priceRange", selected.get("priceRange"), 80),
        ("services", selected.get("serviceType") or selected.get("knowsAbout"), 250),
    ):
        if isinstance(source, list):
            source = ", ".join(_plain(item, 80) for item in source if _plain(item, 80))
        value = _plain(source, cap)
        if value:
            profile[key] = value

    address = selected.get("address")
    if isinstance(address, dict):
        parts = [address.get(key) for key in ("streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry") if _plain(address.get(key), 120)]
        if parts:
            profile["address"] = ", ".join(_plain(part, 120) for part in parts)[:300]
        for key, schema_key, cap in (("city", "addressLocality", 100), ("state", "addressRegion", 50), ("postalCode", "postalCode", 20)):
            value = _plain(address.get(schema_key), cap)
            if value:
                profile[key] = value
    hours_spec = selected.get("openingHoursSpecification")
    if hours_spec and "hours" not in profile:
        rows = hours_spec if isinstance(hours_spec, list) else [hours_spec]
        hours = []
        for row in rows[:7]:
            if not isinstance(row, dict):
                continue
            days = row.get("dayOfWeek", [])
            if isinstance(days, str):
                days = [days]
            day_names = ",".join(_plain(item, 24).rsplit("/", 1)[-1] for item in days[:7])
            opening = _plain(row.get("opens"), 10)
            closing = _plain(row.get("closes"), 10)
            if day_names and opening and closing:
                hours.append(f"{day_names} {opening}-{closing}")
        if hours:
            profile["hours"] = "; ".join(hours)[:300]

    same_as = selected.get("sameAs", [])
    if isinstance(same_as, str):
        same_as = [same_as]
    social_urls = []
    for item in same_as[:12] if isinstance(same_as, list) else []:
        value = _plain(item, 2048)
        if value.startswith(("https://", "http://")) and value not in social_urls:
            social_urls.append(value)
    if social_urls:
        profile["socialUrls"] = social_urls[:8]

    metadata = {
        "website": (soup.select_one('link[rel="canonical"]') or {}).get("href", "") or current_url,
        "description": "",
    }
    for name in ("description", "og:description"):
        tag = soup.find("meta", attrs={"name": name}) or soup.find("meta", attrs={"property": name})
        if tag and tag.get("content"):
            metadata["description"] = tag.get("content", "")
            break
    if not profile.get("description") and metadata["description"]:
        profile["description"] = _plain(metadata["description"], 500)
    if metadata["website"].startswith(("http://", "https://")):
        profile["website"] = metadata["website"][:2048]
    tel = next((anchor.get("href", "")[4:] for anchor in soup.select('a[href^="tel:"]') if anchor.get("href")), "")
    if tel and not profile.get("phone"):
        profile["phone"] = _plain(tel, 80)

    if structured_objects:
        evidence = json.dumps(selected, ensure_ascii=False, separators=(",", ":"))
        profile["structuredEvidenceText"] = evidence[:500]
    return {key: value for key, value in profile.items() if value not in ("", [], None)}


def _public_url(url: str) -> bool:
    """Reject non-web schemes, credentials, nonstandard ports and private hosts."""
    try:
        parts = urlparse(url.strip())
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            return False
        if parts.username or parts.password or parts.port not in (None, 80, 443):
            return False
        host = parts.hostname.rstrip(".").lower()
        if host in {"localhost", "localhost.localdomain"} or host.endswith((".local", ".internal", ".localhost")):
            return False
        try:
            addresses = {ipaddress.ip_address(host)}
        except ValueError:
            addresses = {ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)}
        return bool(addresses) and all(address.is_global for address in addresses)
    except (ValueError, OSError, UnicodeError):
        return False


async def _read_limited(response: httpx.Response) -> bytes:
    parts: list[bytes] = []
    size = 0
    async for part in response.aiter_bytes():
        size += len(part)
        if size > MAX_BYTES:
            raise ValueError("Page or PDF exceeds the 2.5 MB fetch limit.")
        parts.append(part)
    return b"".join(parts)


async def fetch_public(url: str) -> FetchResult:
    url = url.strip()
    if not _public_url(url):
        return FetchResult(url, "", False, "URL is not a permitted public HTTP(S) address.")
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/pdf,text/plain;q=0.8,*/*;q=0.3"}
    current = url
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False, headers=headers) as client:
            for _ in range(4):
                async with client.stream("GET", current) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            return FetchResult(current, "", False, "Redirect had no target.")
                        next_url = urljoin(current, location)
                        if not _public_url(next_url):
                            return FetchResult(current, "", False, "Redirect target is not a permitted public URL.")
                        current = next_url
                        continue
                    if response.status_code >= 400:
                        return FetchResult(current, "", False, f"Source returned HTTP {response.status_code}.")
                    content_type = response.headers.get("content-type", "").lower()
                    data = await _read_limited(response)
                    is_pdf = "application/pdf" in content_type or current.lower().split("?", 1)[0].endswith(".pdf") or data.startswith(b"%PDF-")
                    if is_pdf:
                        try:
                            reader = PdfReader(BytesIO(data), strict=False)
                            if reader.is_encrypted:
                                return FetchResult(current, "", True, "Encrypted PDF cannot be read.")
                            text = "\n".join((page.extract_text() or "") for page in reader.pages[:100])
                            return FetchResult(current, text[:MAX_TEXT_CHARS], True)
                        except Exception as exc:  # malformed documents should not fail the whole batch
                            return FetchResult(current, "", True, f"PDF text extraction failed: {type(exc).__name__}.")
                    if not any(kind in content_type for kind in ("text/html", "text/plain", "application/xhtml")):
                        return FetchResult(current, "", False, "Source is not a readable HTML, text, or PDF page.")
                    soup = BeautifulSoup(data, "html.parser")
                    profile = _profile_from_html(soup, current)
                    for node in soup(["script", "style", "noscript", "svg", "template"]):
                        node.decompose()
                    visible = soup.get_text(" ", strip=True)
                    emails_from_links = [a.get("href", "")[7:] for a in soup.select('a[href^="mailto:"]')]
                    profile_text = "\n".join(
                        _plain(value, 500) if not isinstance(value, list) else "\n".join(_plain(item, 2048) for item in value)
                        for value in profile.values()
                    )
                    text = (visible + "\n" + "\n".join(emails_from_links) + "\n" + profile_text)[:MAX_TEXT_CHARS]
                    links = [
                        {"url": urljoin(current, anchor.get("href", "")), "text": anchor.get_text(" ", strip=True)[:180]}
                        for anchor in soup.select("a[href]")[:300]
                    ]
                    return FetchResult(current, text, False, links=links, profile=profile)
            return FetchResult(current, "", False, "Too many redirects.")
    except (httpx.HTTPError, ValueError, OSError) as exc:
        return FetchResult(current, "", False, f"Fetch failed: {type(exc).__name__}.")


def _evidence(text: str, email: str) -> str:
    match = re.search(re.escape(email), text, re.I)
    if not match:
        return ""
    start, end = max(0, match.start() - 95), min(len(text), match.end() + 95)
    return re.sub(r"\s+", " ", text[start:end]).strip()[:300]


def _extract(result: FetchResult, route: str, business_name: str) -> list[dict]:
    if not result.text:
        return []
    candidates = []
    for email in dict.fromkeys(EMAIL_RE.findall(result.text)):
        email = email.strip(".,;:()[]{}<>\"'").lower()
        if len(email) > 254 or ".." in email or email.startswith(("noreply@", "no-reply@", "example@")):
            continue
        excerpt = _evidence(result.text, email)
        # Evidence score is a rubric score, not a measured probability.
        score = 7 if route == "business_website" else 5 if route == "same_site_contact_page" else 3 if result.is_pdf else 2
        if business_name and business_name.lower() in result.text.lower():
            score = min(10, score + 1)
        candidates.append({
            "email": email,
            "sourceRoute": route,
            "sourceRouteLabel": {
                "business_website": "Business website",
                "same_site_contact_page": "Business website contact page",
                "provided_public_source": "Provided public source",
                "optional_web_search": "Search result source",
                "sunbiz_entity_record": "Florida Sunbiz entity record",
                "sunbiz_pdf_filing": "Florida Sunbiz filing PDF",
            }.get(route, route),
            "sourceUrl": result.url,
            "evidenceText": excerpt,
            "confidenceScore": score,
            "domainCheckLabel": "MX not checked; mailbox not verified",
            "requiresReview": result.is_pdf or route in {"provided_public_source", "optional_web_search", "sunbiz_entity_record", "sunbiz_pdf_filing"},
        })
    return candidates


async def _robots_allows(url: str, client: httpx.AsyncClient) -> bool:
    parts = urlparse(url)
    robots_url = urlunparse((parts.scheme, parts.netloc, "/robots.txt", "", "", ""))
    if not _public_url(robots_url):
        return False
    try:
        response = await client.get(robots_url, follow_redirects=False)
        if response.status_code == 404:
            return True
        if response.status_code >= 400 or len(response.content) > 100_000:
            return False
        from urllib.robotparser import RobotFileParser
        parser = RobotFileParser()
        parser.set_url(robots_url)
        parser.parse(response.text.splitlines())
        return parser.can_fetch("VivaraForgeResearch", url)
    except (httpx.HTTPError, ValueError):
        return False


async def _search_urls(name: str, city: str, state: str, api_key: str) -> list[str]:
    if not api_key:
        return []
    query = " ".join(part for part in [f'"{name}"', city, state, "contact email"] if part).strip()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"X-Subscription-Token": api_key, "Accept": "application/json"}) as client:
            response = await client.get("https://api.search.brave.com/res/v1/web/search", params={"q": query, "count": 5})
            if response.status_code != 200:
                return []
            body = response.json()
            results = body.get("web", {}).get("results", [])
            return [item.get("url", "") for item in results if item.get("url")][:5]
    except (httpx.HTTPError, ValueError):
        return []


def _canonical_entity_name(value: str) -> str:
    value = re.sub(r"[,\s]+(L\.?L\.?C\.?|INC(?:ORPORATED)?|CORP(?:ORATION)?|LTD|LIMITED|PLLC|L\.?P\.?|L\.?L\.?P\.?)\.?$", "", value.upper().strip())
    return re.sub(r"[^A-Z0-9]+", "", value)


async def _sunbiz_lookup(name: str) -> tuple[list[dict], list[str]]:
    """Look up Florida entities conservatively, then read only exact-name filing sources."""
    if len(name.strip()) < 3:
        return [], ["Sunbiz search skipped because the business name is too short to match reliably."]
    if len(name.strip()) > 45:
        return [], ["Sunbiz search skipped because its name search accepts at most 45 characters."]
    base = "https://search.sunbiz.org/Inquiry/CorporationSearch"
    search_url = base + "/SearchResults?" + urlencode({"inquiryType": "EntityName", "searchTerm": name.strip()})
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            if not await _robots_allows(search_url, client):
                return [], ["Sunbiz search is disallowed by robots.txt or its robots file could not be checked."]
        search_result = await fetch_public(search_url)
    except httpx.HTTPError:
        return [], ["Sunbiz search could not be reached."]
    if search_result.error:
        return [], [f"Sunbiz search: {search_result.error}"]

    wanted = _canonical_entity_name(name)
    matches = []
    for item in search_result.links:
        parsed = urlparse(item.get("url", ""))
        if parsed.hostname != "search.sunbiz.org" or "/SearchResultDetail" not in parsed.path:
            continue
        entity_name = item.get("text", "").strip()
        if entity_name and _canonical_entity_name(entity_name) == wanted:
            matches.append((entity_name, item["url"]))
    # Do not pick near-matches. Several exact legal entities may be returned, so retain their
    # source identity and mark every filing-derived contact for a person to review.
    matches = list(dict.fromkeys(matches))[:3]
    candidates: list[dict] = []
    errors: list[str] = []
    for entity_name, detail_url in matches:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            if not await _robots_allows(detail_url, client):
                continue
        detail = await fetch_public(detail_url)
        if detail.error:
            errors.append(f"Sunbiz entity record: {detail.error}")
            continue
        candidates.extend({**candidate, "registryEntityName": entity_name} for candidate in _extract(detail, "sunbiz_entity_record", name))
        pdf_links = []
        for link in detail.links:
            url = link.get("url", "")
            parts = urlparse(url)
            if parts.hostname == "search.sunbiz.org" and ("ConvertTiffToPDF" in parts.path or parts.path.lower().endswith(".pdf")):
                if url not in pdf_links:
                    pdf_links.append(url)
        for pdf_url in pdf_links[:3]:
            async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
                if not await _robots_allows(pdf_url, client):
                    continue
            filing = await fetch_public(pdf_url)
            if filing.error:
                errors.append(f"Sunbiz filing PDF: {filing.error}")
                continue
            candidates.extend({**candidate, "registryEntityName": entity_name} for candidate in _extract(filing, "sunbiz_pdf_filing", name))
    return candidates, errors[:5]


async def enrich_prospect(prospect: dict, search_api_key: str = "") -> tuple[list[dict], list[str], list[dict]]:
    name = str(prospect.get("businessName", ""))[:160]
    state = re.sub(r"[^A-Z]", "", str(prospect.get("state", "")).upper())
    urls: list[tuple[str, str]] = []
    website = str(prospect.get("website", "")).strip()
    if website:
        urls.append((website, "business_website"))
    raw_sources = str(prospect.get("sourceUrlsText", ""))
    for source in re.split(r"[\s,;]+", raw_sources):
        source = source.strip()
        if source.startswith(("https://", "http://")) and len(source) < 2048:
            urls.append((source, "provided_public_source"))

    search_urls = await _search_urls(name, str(prospect.get("city", "")), str(prospect.get("state", "")), search_api_key)
    urls.extend((url, "optional_web_search") for url in search_urls)

    unique_urls = []
    seen = set()
    for url, route in urls:
        normalized = url.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            unique_urls.append((normalized, route))
        if len(unique_urls) >= 8:
            break

    candidates: list[dict] = []
    route_errors: list[str] = []
    profiles: list[dict] = []
    if state in {"FL", "FLORIDA"}:
        sunbiz_candidates, sunbiz_errors = await _sunbiz_lookup(name)
        candidates.extend(sunbiz_candidates)
        route_errors.extend(sunbiz_errors)

    if not unique_urls and state not in {"FL", "FLORIDA"}:
        return [], ["No public source URL was provided and optional web search is not configured."], []
    for url, route in unique_urls:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as robot_client:
                if not await _robots_allows(url, robot_client):
                    route_errors.append(f"{url}: robots.txt disallows crawling or could not be checked.")
                    continue
        except httpx.HTTPError:
            route_errors.append(f"{url}: robots.txt could not be checked.")
            continue
        result = await fetch_public(url)
        if result.error:
            route_errors.append(f"{url}: {result.error}")
            continue
        candidates.extend(_extract(result, route, name))
        if result.profile:
            profiles.append({
                "sourceRoute": route,
                "sourceUrl": result.url,
                "profile": result.profile,
                "evidenceText": result.profile.get("structuredEvidenceText") or result.text[:500],
            })

        # Discover a few same-site Contact/About pages using parsed links from the source page.
        # For privacy and request caps, only pages whose visible link text/path signals Contact/About are followed.
        if not result.is_pdf and route == "business_website":
            base = urlparse(result.url)
            found_links = []
            for link in result.links:
                href = link.get("url", "")
                parts = urlparse(href)
                label = (link.get("text", "") + " " + parts.path).lower()
                if parts.netloc.lower() == base.netloc.lower() and any(term in label for term in ("contact", "about", "team", "staff")):
                    if _public_url(href) and href != result.url and href not in found_links:
                        found_links.append(href)
                if len(found_links) >= 3:
                    break
            for contact_url in found_links:
                async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
                    if not await _robots_allows(contact_url, client):
                        continue
                contact = await fetch_public(contact_url)
                if contact.error:
                    route_errors.append(f"{contact_url}: {contact.error}")
                else:
                    candidates.extend(_extract(contact, "same_site_contact_page", name))
                    if contact.profile:
                        profiles.append({
                            "sourceRoute": "same_site_contact_page",
                            "sourceUrl": contact.url,
                            "profile": contact.profile,
                            "evidenceText": contact.profile.get("structuredEvidenceText") or contact.text[:500],
                        })

    # Stable deduplication keeps the same email from duplicating across routes.
    unique_candidates: list[dict] = []
    seen_candidates = set()
    for item in candidates:
        key = (item["email"].lower(), item["sourceUrl"])
        if key not in seen_candidates:
            seen_candidates.add(key)
            unique_candidates.append(item)
    return unique_candidates[:20], route_errors[:10], profiles[:12]
