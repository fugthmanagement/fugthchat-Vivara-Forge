"""Evidence-only public contact extraction helpers."""

from __future__ import annotations

import asyncio
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
from registry import state_of, import_meta, missing_route_message, REGISTRIES
from pdf_reader import pdf_text

USER_AGENT = "VivaraForgeResearch/1.0"
EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+", re.I)
PHONE_RE = re.compile(r"(?<![A-Za-z0-9])(?:\+\d{1,3}[\s().-]*(?:\d[\s().-]*){7,12}|(?:\+?1[\s().-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4})(?:\s*(?:ext\.?|x)\s*\d{1,6})?(?!\d)", re.I)
PERSON_ROLE = r"registered\s+agent|authorized\s+person(?:\(s\))?|managing\s+member|co[- ]?founder|chief\s+executive\s+officer|owner|founder|president|CEO|organizer|manager|member|director|officer"
PERSON_NAME = r"[A-Z][A-Za-z'’.-]{1,40}(?:\s+(?:[A-Z][A-Za-z'’.-]{1,40}|[A-Z]\.)){1,3}"
ROLE_FIRST_RE = re.compile(rf"(?P<role>{PERSON_ROLE})\s*(?:name\s*)?(?::|[-–]|\bis\b)?\s*(?P<name>{PERSON_NAME})", re.I)
ROLE_LAST_RE = re.compile(rf"(?P<name>{PERSON_NAME})\s*[,|—–-]\s*(?P<role>{PERSON_ROLE})\b", re.I)
MAX_BYTES = 10_000_000
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


def _jsonld_objects(value: object, depth: int = 0) -> list[dict]:
    if depth > 5:
        return []
    if isinstance(value, list):
        return [item for part in value[:100] for item in _jsonld_objects(part, depth + 1)][:100]
    if not isinstance(value, dict):
        return []
    found = [value]
    graph = value.get("@graph")
    if graph is not None:
        found.extend(_jsonld_objects(graph, depth + 1))
    return found[:100]


def _phone_record(value: str, source_url: str, source_route: str, evidence: str = "") -> dict | None:
    raw = re.sub(r"\s+", " ", value).strip(" \t,;|.")[:80]
    if not raw:
        return None
    extension_match = re.search(r"(?:ext\.?|x)\s*(\d{1,6})$", raw, re.I)
    extension = extension_match.group(1) if extension_match else ""
    base = re.sub(r"(?:ext\.?|x)\s*\d{1,6}$", "", raw, flags=re.I).strip()
    digits = re.sub(r"\D", "", base)
    e164 = ""
    formatted = raw
    if base.lstrip().startswith("+") and 8 <= len(digits) <= 15:
        e164 = "+" + digits
    elif len(digits) == 10 and digits[0] in "23456789" and digits[3] in "23456789":
        e164 = "+1" + digits
    elif len(digits) == 11 and digits.startswith("1") and digits[1] in "23456789" and digits[4] in "23456789":
        e164 = "+" + digits
    if e164.startswith("+1") and len(re.sub(r"\D", "", e164)) == 11:
        national = re.sub(r"\D", "", e164)[1:]
        formatted = f"({national[:3]}) {national[3:6]}-{national[6:]}"
        if extension:
            formatted += f" ext. {extension}"
    elif e164 and extension:
        formatted += f" ext. {extension}"
    context = evidence[:300]
    phone_kind = "fax" if re.search(r"\bfax\b|facsimile", context, re.I) else "public_source_number"
    return {
        "raw": raw,
        "formatted": formatted[:80],
        "e164": e164,
        "extension": extension,
        "kind": phone_kind,
        "sourceRoute": source_route,
        "sourceUrl": source_url[:2048],
        "evidenceText": context,
        "requiresReview": True,
    }


def _public_contact_data(text: str, source_url: str, source_route: str, business_name: str = "") -> dict:
    """Extract only public numbers and names attached to an explicit business role."""
    if source_route == "optional_web_search" and business_name and business_name.casefold() not in text.casefold():
        return {"businessPhones": [], "publicContacts": []}
    phones = []
    seen_phones = set()
    for match in PHONE_RE.finditer(text[:MAX_TEXT_CHARS]):
        evidence = re.sub(r"\s+", " ", text[max(0, match.start() - 70):min(len(text), match.end() + 70)]).strip()
        if source_route in {'sunbiz_entity_record','sunbiz_pdf_filing','uploaded_filing'} and not re.search(r'\b(?:phone|telephone|tel|mobile|fax|call)\b', evidence, re.I):
            continue  # Filing/document numbers are not contact numbers.
        item = _phone_record(match.group(0), source_url, source_route, evidence)
        if not item:
            continue
        key = item["e164"] or re.sub(r"\D", "", item["raw"])
        if key and key not in seen_phones:
            seen_phones.add(key)
            phones.append(item)
        if len(phones) >= 20:
            break

    contacts = []
    seen_people = set()
    excluded_names = {"the owner", "business owner", "company owner", "company name", "business name", "the founder", "contact us", "learn more"}
    for pattern in (ROLE_FIRST_RE, ROLE_LAST_RE):
        for match in pattern.finditer(text[:MAX_TEXT_CHARS]):
            name = re.sub(r"\s+", " ", match.group("name")).strip(" .,:;|-")
            role_text = re.sub(r"\s+", " ", match.group("role")).strip().casefold()
            if name.casefold() in excluded_names or len(name) > 100 or re.search(r"\d|@|https?://", name, re.I):
                continue
            if business_name and re.sub(r"\W", "", name).casefold() == re.sub(r"\W", "", business_name).casefold():
                continue
            role = re.sub(r"[^a-z0-9]+", "_", role_text).strip("_")
            key = (name.casefold(), role)
            if key in seen_people:
                continue
            seen_people.add(key)
            contacts.append({
                "name": name[:100],
                "role": role,
                "sourceRoute": source_route,
                "sourceUrl": source_url[:2048],
                "evidenceText": re.sub(r"\s+", " ", text[max(0, match.start() - 80):min(len(text), match.end() + 100)]).strip()[:300],
                "requiresReview": True,
            })
            if len(contacts) >= 20:
                break
        if len(contacts) >= 20:
            break
    return {"businessPhones": phones, "publicContacts": contacts}


def _structured_public_contacts(entity: dict, source_url: str) -> list[dict]:
    contacts = []
    for field, role in (("owner", "owner"), ("founder", "founder"), ("founders", "founder"), ("member", "member")):
        value = entity.get(field)
        values = value if isinstance(value, list) else [value]
        for person in values[:10]:
            name = _plain(person.get("name"), 100) if isinstance(person, dict) else _plain(person, 100)
            if name:
                contacts.append({
                    "name": name,
                    "role": role,
                    "sourceRoute": "business_website",
                    "sourceUrl": source_url[:2048],
                    "evidenceText": f"Schema.org JSON-LD identifies {name} as {role}.",
                    "requiresReview": True,
                })
    return contacts


def _merge_records(*collections: list[dict], key_fields: tuple[str, ...]) -> list[dict]:
    merged = []
    seen = set()
    for items in collections:
        for item in items:
            key = tuple(str(item.get(field, "")).casefold() for field in key_fields)
            if key not in seen:
                seen.add(key)
                merged.append(item)
    return merged


def _profile_from_html(soup: BeautifulSoup, current_url: str) -> dict:
    """Read explicit page metadata and Schema.org JSON-LD; never execute page scripts."""
    profile: dict = {}
    structured_objects: list[dict] = []
    for script in soup.select('script[type="application/ld+json"]')[:20]:
        try:
            raw_json = script.get_text(" ", strip=True)
            if len(raw_json) > 200_000:
                continue
            structured_objects.extend(_jsonld_objects(json.loads(raw_json)))
            if len(structured_objects) > 100:
                structured_objects = structured_objects[:100]
                break
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
    tel_values = [anchor.get("href", "")[4:] for anchor in soup.select('a[href^="tel:"]') if anchor.get("href")]
    if tel_values and not profile.get("phone"):
        profile["phone"] = _plain(tel_values[0], 80)

    # Keep structured data already parsed above, but exclude code and hidden template text
    # from role/name and phone matching so page scripts cannot create contact candidates.
    for node in soup(["script", "style", "noscript", "svg", "template"]):
        node.decompose()
    contact_text = soup.get_text(" ", strip=True)
    structured_phones = selected.get("telephone", [])
    if isinstance(structured_phones, str):
        structured_phones = [structured_phones]
    contact_text += "\n" + "\n".join([*tel_values[:20], *[_plain(item, 80) for item in structured_phones[:20]]])
    contact_data = _public_contact_data(contact_text, current_url, "public_page", profile.get("businessName", ""))
    structured_people = _structured_public_contacts(selected, current_url)
    profile["businessPhones"] = _merge_records(contact_data["businessPhones"], key_fields=("e164", "raw"))
    profile["publicContacts"] = _merge_records(structured_people, contact_data["publicContacts"], key_fields=("name", "role"))
    if not profile.get("phone") and profile["businessPhones"]:
        profile["phone"] = profile["businessPhones"][0].get("formatted") or profile["businessPhones"][0].get("raw", "")

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
            raise ValueError("Page or PDF exceeds the 10 MB fetch limit.")
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
                            text = await asyncio.to_thread(pdf_text, data)
                            return FetchResult(current, text, True)
                        except Exception as exc:  # malformed documents should not fail the whole batch
                            return FetchResult(current, "", True, f"PDF text extraction failed: {type(exc).__name__}.")
                    if not any(kind in content_type for kind in ("text/html", "text/plain", "application/xhtml")):
                        return FetchResult(current, "", False, "Source is not a readable HTML, text, or PDF page.")
                    soup = BeautifulSoup(data, "html.parser")
                    profile = _profile_from_html(soup, current)
                    for node in soup(["script", "style", "noscript", "svg", "template"]):
                        node.decompose()
                    visible = soup.get_text("\n", strip=True)
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


async def _fetch_with_retry(url: str) -> FetchResult:
    """Retry one transient source failure; permanent and policy failures return immediately."""
    result = await fetch_public(url)
    transient = result.error.startswith("Fetch failed:") or any(
        f"HTTP {status}" in result.error for status in (408, 425, 429, 500, 502, 503, 504)
    )
    if transient:
        await asyncio.sleep(0.6)
        return await fetch_public(url)
    return result


def _evidence(text: str, email: str) -> str:
    match = re.search(re.escape(email), text, re.I)
    if not match:
        return ""
    start, end = max(0, match.start() - 95), min(len(text), match.end() + 95)
    return re.sub(r"\s+", " ", text[start:end]).strip()[:300]


def _extract(result: FetchResult, route: str, business_name: str) -> list[dict]:
    if not result.text:
        return []
    if route == "optional_web_search" and business_name and business_name.casefold() not in result.text.casefold():
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


def _profile_with_contacts(result: FetchResult, route: str, business_name: str) -> dict:
    profile = dict(result.profile or {})
    found = _public_contact_data(result.text, result.url, route, business_name)
    phone_records = _merge_records(profile.get("businessPhones", []), found["businessPhones"], key_fields=("e164", "raw"))
    person_records = _merge_records(profile.get("publicContacts", []), [] if route.startswith("sunbiz_") else found["publicContacts"], key_fields=("name", "role"))
    for item in phone_records:
        item["sourceRoute"] = route
        item["sourceUrl"] = result.url[:2048]
    for item in person_records:
        item["sourceRoute"] = route
        item["sourceUrl"] = result.url[:2048]
    profile["businessPhones"] = phone_records[:20]
    profile["publicContacts"] = person_records[:20]
    if not profile.get("phone") and phone_records:
        profile["phone"] = phone_records[0].get("formatted") or phone_records[0].get("raw", "")
    return {key: value for key, value in profile.items() if value not in ("", [], None)}


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


async def _search_urls(name: str, city: str, state: str, api_key: str) -> tuple[list[str], str]:
    if not api_key:
        return [], ""
    query = " ".join(part for part in [f'"{name}"', city, state, "contact email phone owner"] if part).strip()
    last_error = ""
    async with httpx.AsyncClient(timeout=TIMEOUT, headers={"X-Subscription-Token": api_key, "Accept": "application/json"}) as client:
        for attempt in range(2):
            try:
                response = await client.get("https://api.search.brave.com/res/v1/web/search", params={"q": query, "count": 5})
                if response.status_code == 200:
                    body = response.json()
                    results = body.get("web", {}).get("results", [])
                    urls = [item.get("url", "") for item in results if item.get("url")][:5]
                    return urls, ""
                last_error = f"Optional web search returned HTTP {response.status_code}."
                if response.status_code not in {408, 425, 429, 500, 502, 503, 504}:
                    break
            except (httpx.HTTPError, ValueError) as exc:
                last_error = f"Optional web search failed: {type(exc).__name__}."
            if attempt == 0:
                await asyncio.sleep(0.6)
    return [], last_error or "Optional web search did not return usable results."


def _canonical_entity_name(value: str) -> str:
    value = re.sub(r"[,\s]+(L\.?L\.?C\.?|INC(?:ORPORATED)?|CORP(?:ORATION)?|LTD|LIMITED|PLLC|L\.?P\.?|L\.?L\.?P\.?)\.?$", "", value.upper().strip())
    return re.sub(r"[^A-Z0-9]+", "", value)


def sunbiz_people(text: str, url: str) -> list[dict]:
    """Read only explicitly titled registry names, never address lines as people."""
    people = []
    patterns = [
        (r"(?:Registered Agent Name & Address|Name and Address of Current Registered Agent:)\s*(?:\n)?([A-Z][A-Z ,.'’-]{2,100})(?=\n|\s{2,}\d)", "registered_agent"),
        (r"Title[^\S\n]+([A-Z /-]{1,25})[^\S\n]*\n(?:Name\s+)?([^\n]+)", None),
    ]
    for pattern, role in patterns:
        for match in re.finditer(pattern, text):
            name = match.group(1 if role else 2).strip()
            if len(name) < 3 or len(name) > 100 or re.search(r"\d|@", name):
                continue
            people.append({"name": name, "role": role or "authorized_person_" + match.group(1).strip().lower(), "sourceUrl": url, "sourceRoute": "sunbiz_entity_record", "evidenceText": match.group(0)[:300], "requiresReview": True})
    return people[:20]


def _registry_match(prospect: dict, record_text: str) -> dict:
    """Corroborate an exact legal-name match with imported public location data.

    A missing address never converts an exact name match into a different entity.
    It only makes the source more clearly marked for human review.
    """
    meta = import_meta(prospect)
    expected = " ".join(str(v) for v in (prospect.get('address'), meta.get('address'), prospect.get('city'), prospect.get('state'), meta.get('postalCode')) if v).upper()
    zip_codes = set(re.findall(r"\b\d{5}(?:-\d{4})?\b", expected))
    city = re.sub(r"[^A-Z ]", "", str(prospect.get('city', '')).upper()).strip()
    normalized = re.sub(r"\s+", " ", record_text.upper())
    matched_zip = next((code for code in zip_codes if code in normalized), "")
    matched_city = bool(city and len(city) >= 3 and city in normalized)
    return {
        "addressCorroborated": bool(matched_zip or matched_city),
        "matchedZip": matched_zip,
        "matchedCity": city if matched_city else "",
        "matchNote": "Exact legal-name match; imported location also appears in the registry record." if (matched_zip or matched_city) else "Exact legal-name match; imported location was not corroborated in the registry record.",
    }


async def _sunbiz_lookup(prospect: dict) -> tuple[list[dict], list[str], list[dict]]:
    """Look up Florida entities conservatively, then read only exact-name filing sources."""
    name = str(prospect.get('businessName', ''))
    if len(name.strip()) < 3:
        return [], ["Sunbiz search skipped because the business name is too short to match reliably."], []
    if len(name.strip()) > 45:
        return [], ["Sunbiz search skipped because its name search accepts at most 45 characters."], []
    base = "https://search.sunbiz.org/Inquiry/CorporationSearch"
    search_url = base + "/SearchResults?" + urlencode({"inquiryType": "EntityName", "searchTerm": name.strip()})
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            if not await _robots_allows(search_url, client):
                return [], ["BLOCKED: Sunbiz robots policy could not be confirmed or disallows access. Open the registry and upload its PDF; do not keep retrying the same batch."], []
        search_result = await _fetch_with_retry(search_url)
    except httpx.HTTPError:
        return [], ["Sunbiz search could not be reached."], []
    if search_result.error:
        return [], [f"Sunbiz search: {search_result.error}"], []

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
    profiles: list[dict] = []
    detail_rows = []
    for entity_name, detail_url in matches:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            if not await _robots_allows(detail_url, client):
                continue
        detail = await _fetch_with_retry(detail_url)
        if detail.error:
            errors.append(f"Sunbiz entity record: {detail.error}")
            continue
        match = _registry_match(prospect, detail.text)
        detail_rows.append((bool(match['addressCorroborated']), entity_name, detail, match))
    # Prefer a corroborated exact entity, but retain all exact legal-name matches so an
    # operator can review ambiguity instead of the agent silently choosing one.
    for _, entity_name, detail, match in sorted(detail_rows, key=lambda row: not row[0]):
        candidates.extend({**candidate, "registryEntityName": entity_name, "registryMatch": match} for candidate in _extract(detail, "sunbiz_entity_record", name))
        detail.profile["publicContacts"] = sunbiz_people(detail.text, detail.url)
        detail_profile = _profile_with_contacts(detail, "sunbiz_entity_record", name)
        if detail_profile:
            detail_profile["registryEntityName"] = entity_name
            detail_profile["registryState"] = "FL"
            detail_profile["registryMatch"] = match
            profiles.append({"sourceRoute": "sunbiz_entity_record", "sourceUrl": detail.url, "profile": detail_profile, "evidenceText": detail.text[:500]})
        pdf_links = []
        for link in detail.links:
            url = link.get("url", "")
            parts = urlparse(url)
            if parts.hostname == "search.sunbiz.org" and ("converttifftopdf" in parts.path.lower() or "getdocument" in parts.path.lower() or parts.path.lower().endswith(".pdf")):
                if url not in pdf_links:
                    pdf_links.append(url)
        # Newest reports plus original incorporation: contact emails often appear only
        # on the initial filing, which is usually the last document in the table.
        for pdf_url in list(dict.fromkeys(pdf_links[:2] + pdf_links[-2:]))[:4]:
            async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
                if not await _robots_allows(pdf_url, client):
                    continue
            filing = await _fetch_with_retry(pdf_url)
            if filing.error:
                errors.append(f"Sunbiz filing PDF: {filing.error}")
                continue
            filing.profile['publicContacts'] = sunbiz_people(filing.text, filing.url)
            candidates.extend({**candidate, "registryEntityName": entity_name, "registryMatch": match} for candidate in _extract(filing, "sunbiz_pdf_filing", name))
            filing_profile = _profile_with_contacts(filing, "sunbiz_pdf_filing", name)
            if filing_profile:
                filing_profile["registryEntityName"] = entity_name
                filing_profile["registryState"] = "FL"
                filing_profile["registryMatch"] = match
                profiles.append({"sourceRoute": "sunbiz_pdf_filing", "sourceUrl": filing.url, "profile": filing_profile, "evidenceText": filing.text[:500]})
    if not matches:
        errors.append("NOT_FOUND: No exact legal entity name matched in the Florida registry. Try the registered legal name or provide the filing URL.")
    return candidates, errors[:5], profiles[:12]


async def enrich_prospect(prospect: dict, search_api_key: str = "") -> tuple[list[dict], list[str], list[dict]]:
    name = str(prospect.get("businessName", ""))[:160]
    state = state_of(prospect)
    urls: list[tuple[str, str]] = []
    website = str(prospect.get("website", "")).strip()
    if website:
        urls.append((website, "business_website"))
    meta = import_meta(prospect)
    source_values = [prospect.get("sourceUrlsText", ""), prospect.get("manualSourceUrl", ""), prospect.get("registryUrl", ""), prospect.get("filingUrl", "")]
    source_values.extend(meta.get("socialUrls", []) if isinstance(meta.get("socialUrls"), list) else [])
    raw_sources = "\n".join(str(v) for v in source_values if v)
    for source in re.split(r"\s+", raw_sources):
        source = source.strip()
        if source.startswith(("https://", "http://")) and len(source) < 2048:
            urls.append((source, "provided_public_source"))

    search_urls, search_error = await _search_urls(name, str(prospect.get("city", "")), state, search_api_key)
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
    route_errors: list[str] = [search_error] if search_error else []
    profiles: list[dict] = []
    if state in {"FL", "FLORIDA"}:
        sunbiz_candidates, sunbiz_errors, sunbiz_profiles = await _sunbiz_lookup(prospect)
        candidates.extend(sunbiz_candidates)
        route_errors.extend(sunbiz_errors)
        profiles.extend(sunbiz_profiles)

    if not unique_urls and state not in {"FL", "FLORIDA"}:
        if route_errors:
            return [], route_errors[:10], []
        if search_api_key:
            return [], ["Optional web search returned no source pages for this exact business and location."], []
        return [], [missing_route_message(prospect, False)], []
    for url, route in unique_urls:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as robot_client:
                if not await _robots_allows(url, robot_client):
                    route_errors.append(f"{url}: robots.txt disallows crawling or could not be checked.")
                    continue
        except httpx.HTTPError:
            route_errors.append(f"{url}: robots.txt could not be checked.")
            continue
        result = await _fetch_with_retry(url)
        if result.error:
            route_errors.append(f"{url}: {result.error}")
            continue
        candidates.extend(_extract(result, route, name))
        profile = _profile_with_contacts(result, route, name)
        if profile:
            profiles.append({
                "sourceRoute": route,
                "sourceUrl": result.url,
                "profile": profile,
                "evidenceText": profile.get("structuredEvidenceText") or result.text[:500],
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
                contact = await _fetch_with_retry(contact_url)
                if contact.error:
                    route_errors.append(f"{contact_url}: {contact.error}")
                else:
                    candidates.extend(_extract(contact, "same_site_contact_page", name))
                    contact_profile = _profile_with_contacts(contact, "same_site_contact_page", name)
                    if contact_profile:
                        profiles.append({
                            "sourceRoute": "same_site_contact_page",
                            "sourceUrl": contact.url,
                            "profile": contact_profile,
                            "evidenceText": contact_profile.get("structuredEvidenceText") or contact.text[:500],
                        })

    # Stable deduplication keeps the same email from duplicating across routes.
    unique_candidates: list[dict] = []
    seen_candidates = set()
    for item in candidates:
        key = (item["email"].lower(), item["sourceUrl"])
        if key not in seen_candidates:
            seen_candidates.add(key)
            unique_candidates.append(item)
    return unique_candidates[:40], route_errors[:10], profiles[:12]
