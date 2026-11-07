"""Consent-gated public business image research and Drive archival.

This module deliberately has no broad social-media search. It reads only public
pages supplied with a prospect (website, source URL, or imported social URL),
does not log in, and keeps every candidate tied to its source page.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import ipaddress
import json
import os
import re
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import urljoin, urlparse, urldefrag

import httpx
from bs4 import BeautifulSoup
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

MAX_PAGE_BYTES = 1_500_000
MAX_IMAGE_BYTES = 10_000_000
MAX_CANDIDATES = 24
USER_AGENT = "VivaraForge/1.0 (consent-gated public business media research)"
BLOCKED_HOSTS = {"google.com", "www.google.com", "maps.google.com", "googleusercontent.com"}
SOCIAL_HOSTS = (
    "facebook.com", "instagram.com", "linkedin.com", "youtube.com", "youtu.be",
    "tiktok.com", "pinterest.com", "x.com", "twitter.com",
)


@dataclass(frozen=True)
class ImageCandidate:
    image_url: str
    source_page_url: str
    label: str
    source_kind: str

    def as_dict(self) -> dict:
        return {
            "imageUrl": self.image_url,
            "sourcePageUrl": self.source_page_url,
            "label": self.label,
            "sourceKind": self.source_kind,
        }


def _public_url(value: object) -> str:
    value = str(value or "").strip()
    if not value or len(value) > 2048:
        return ""
    try:
        parsed = urlparse(value)
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower().strip(".")
    if parsed.scheme not in {"https", "http"} or not host or host in BLOCKED_HOSTS or host.endswith(".google.com"):
        return ""
    if host == "localhost" or host.endswith(".local"):
        return ""
    try:
        if ipaddress.ip_address(host).is_private or ipaddress.ip_address(host).is_loopback:
            return ""
    except ValueError:
        pass
    return urldefrag(value)[0]


async def _host_is_public(url: str) -> bool:
    host = urlparse(url).hostname or ""
    try:
        records = await asyncio.to_thread(socket.getaddrinfo, host, None, 0, socket.SOCK_STREAM)
        addresses = {item[4][0] for item in records}
        if not addresses:
            return False
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except (socket.gaierror, ValueError):
        return False


async def _read_limited(client: httpx.AsyncClient, url: str, accepted: tuple[str, ...], maximum: int) -> tuple[bytes, str]:
    if not await _host_is_public(url):
        raise ValueError("Source host is not a public internet address.")
    async with client.stream("GET", url, follow_redirects=False) as response:
        if response.is_redirect:
            raise ValueError("Redirected sources are not followed.")
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").lower().split(";", 1)[0]
        if not any(content_type.startswith(item) for item in accepted):
            raise ValueError("Source returned an unsupported content type.")
        advertised = response.headers.get("content-length")
        if advertised and advertised.isdigit() and int(advertised) > maximum:
            raise ValueError("Source exceeds the image-size limit.")
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > maximum:
                raise ValueError("Source exceeds the image-size limit.")
    return bytes(body), content_type


def _source_pages(prospect: dict, import_meta) -> list[str]:
    meta = import_meta(prospect)
    values = [prospect.get("website"), prospect.get("manualSourceUrl")]
    values.extend(re.split(r"[\s,|]+", str(prospect.get("sourceUrlsText") or "")))
    values.extend(meta.get("socialUrls") or [])
    pages = []
    for value in values:
        url = _public_url(value)
        if url and url not in pages:
            pages.append(url)
    return pages[:5]


def _image_urls(html: str, page_url: str) -> list[ImageCandidate]:
    soup = BeautifulSoup(html, "html.parser")
    found: list[ImageCandidate] = []
    seen = set()

    def add(raw: object, label: object, kind: str) -> None:
        raw = str(raw or "").strip()
        if not raw or raw.startswith("data:"):
            return
        url = _public_url(urljoin(page_url, raw))
        if not url or url in seen:
            return
        seen.add(url)
        found.append(ImageCandidate(url, page_url, str(label or "Public page image")[:180], kind))

    for tag in soup.select('meta[property="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]'):
        add(tag.get("content"), tag.get("property") or tag.get("name") or "Social preview", "metadata")
    for tag in soup.find_all("img"):
        add(tag.get("src") or tag.get("data-src") or tag.get("data-lazy-src"), tag.get("alt") or "Public page image", "page_image")
        srcset = str(tag.get("srcset") or tag.get("data-srcset") or "")
        for part in srcset.split(",")[:4]:
            add(part.strip().split(" ", 1)[0], tag.get("alt") or "Responsive page image", "page_image")
    return found[:MAX_CANDIDATES]


def _linked_public_social_pages(html: str, page_url: str) -> list[str]:
    """Return a few public social/profile links advertised by the business site.

    This deliberately does not search a social network by name. The link has to
    be published by the business on one of the prospect's own supplied pages.
    """
    soup = BeautifulSoup(html, "html.parser")
    pages: list[str] = []
    for anchor in soup.find_all("a", href=True):
        url = _public_url(urljoin(page_url, str(anchor.get("href") or "")))
        host = (urlparse(url).hostname or "").lower() if url else ""
        if not url or not any(host == domain or host.endswith("." + domain) for domain in SOCIAL_HOSTS):
            continue
        if url not in pages:
            pages.append(url)
    return pages[:4]


async def discover_public_images(prospect: dict, import_meta) -> tuple[list[dict], list[str]]:
    pages = _source_pages(prospect, import_meta)
    if not pages:
        return [], ["Add a public business website, source URL, or public social-page URL before searching for images."]
    candidates: list[ImageCandidate] = []
    errors: list[str] = []
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
    async with httpx.AsyncClient(timeout=15, headers=headers) as client:
        position = 0
        # A homepage can introduce a small number of its own public social links.
        # Never turn this into broad name-based social-network search.
        while position < len(pages) and position < 6:
            page = pages[position]
            position += 1
            try:
                data, _ = await _read_limited(client, page, ("text/html", "application/xhtml+xml"), MAX_PAGE_BYTES)
                html = data.decode("utf-8", "replace")
                candidates.extend(_image_urls(html, page))
                for social_page in _linked_public_social_pages(html, page):
                    if social_page not in pages and len(pages) < 6:
                        pages.append(social_page)
            except (httpx.HTTPError, ValueError):
                errors.append("Could not read " + (urlparse(page).hostname or "public source") + ".")
    unique: list[ImageCandidate] = []
    seen = set()
    for candidate in candidates:
        if candidate.image_url not in seen:
            seen.add(candidate.image_url)
            unique.append(candidate)
    return [item.as_dict() for item in unique[:MAX_CANDIDATES]], errors[:5]


async def download_as_jpeg(image_url: str) -> tuple[bytes, dict]:
    url = _public_url(image_url)
    if not url:
        raise HTTPException(400, "Choose a valid public image URL.")
    headers = {"User-Agent": USER_AGENT, "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}
    try:
        async with httpx.AsyncClient(timeout=25, headers=headers) as client:
            raw, content_type = await _read_limited(client, url, ("image/",), MAX_IMAGE_BYTES)
    except (httpx.HTTPError, ValueError):
        raise HTTPException(422, "The public image could not be downloaded safely.")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            image = image.convert("RGB")
            image.thumbnail((2400, 2400))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=90, optimize=True)
            jpeg = output.getvalue()
            width, height = image.size
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(422, "The downloaded file was not a readable image.")
    if not jpeg or len(jpeg) > MAX_IMAGE_BYTES:
        raise HTTPException(422, "The converted image exceeds the archive size limit.")
    return jpeg, {"mimeType": "image/jpeg", "width": width, "height": height, "sourceContentType": content_type}


def archive_to_drive(jpeg: bytes, filename: str) -> dict:
    folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID", "").strip()
    credential_json = os.getenv("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON", os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")).strip()
    if not folder_id or not credential_json:
        raise HTTPException(503, "Image archive needs GOOGLE_DRIVE_FOLDER_ID and a Drive-capable service-account secret.")
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseUpload
        info = json.loads(credential_json)
        credentials = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/drive.file"])
        service = build("drive", "v3", credentials=credentials, cache_discovery=False)
        name = PurePosixPath(filename).name[:180] or "business-image.jpg"
        media = MediaIoBaseUpload(io.BytesIO(jpeg), mimetype="image/jpeg", resumable=False)
        result = service.files().create(body={"name": name, "parents": [folder_id], "mimeType": "image/jpeg"}, media_body=media, fields="id,name,mimeType,createdTime").execute()
        return {"id": result["id"], "name": result.get("name", name), "mimeType": result.get("mimeType", "image/jpeg"), "createdTime": result.get("createdTime", "")}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, "Drive archive failed. Confirm the Drive API is enabled and the archive folder is shared with the service account.")


def archive_filename(prospect: dict, source_url: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", str(prospect.get("businessName") or "business").strip()).strip("-")[:80] or "business"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    suffix = hashlib.sha256(source_url.encode()).hexdigest()[:10]
    return f"{safe}-{stamp}-{suffix}.jpg"
