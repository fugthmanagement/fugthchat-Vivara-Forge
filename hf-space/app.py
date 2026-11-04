from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from typing import Any

import firebase_admin
import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from firebase_admin import auth as firebase_auth, credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from enrichment import enrich_prospect

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("vivara-worker")

PROJECT_ID = "vivara-forge"
ADMIN_UID = os.getenv("ADMIN_UID", "").strip()
ORIGINS = [item.strip().rstrip("/") for item in os.getenv("ALLOWED_ORIGINS", "https://fugthmanagement.github.io").split(",") if item.strip()]
OVERPASS_URL = os.getenv("OVERPASS_URL", "https://overpass-api.de/api/interpreter").strip()
SEARCH_KEY = os.getenv("BRAVE_SEARCH_API_KEY", "").strip()
db = None
firebase_ready = False
active_jobs: dict[str, asyncio.Task] = {}


def init_firebase() -> None:
    global db, firebase_ready
    if firebase_ready:
        return
    service_account = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if not service_account:
        log.warning("FIREBASE_SERVICE_ACCOUNT_JSON is not configured")
        return
    try:
        payload = json.loads(service_account)
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(payload), {"projectId": PROJECT_ID})
        db = firestore.client()
        firebase_ready = True
        log.info("Firebase worker initialized")
    except Exception:
        log.exception("Firebase worker initialization failed")
        db = None
        firebase_ready = False


def require_admin(authorization: str | None) -> dict[str, Any]:
    if not firebase_ready or db is None:
        raise HTTPException(status_code=503, detail="Worker credentials are not configured.")
    if not ADMIN_UID:
        raise HTTPException(status_code=503, detail="ADMIN_UID is not configured.")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="A Firebase sign-in token is required.")
    try:
        decoded = firebase_auth.verify_id_token(authorization.split(" ", 1)[1].strip(), check_revoked=True)
    except Exception:
        raise HTTPException(status_code=401, detail="Firebase sign-in token is invalid or expired.")
    if decoded.get("uid") != ADMIN_UID:
        raise HTTPException(status_code=403, detail="This account is not allowed to use the private worker.")
    return decoded


class WakeRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=160)


class LocalSearchRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius_m: int = Field(default=5000, ge=500, le=10000)
    category: str = Field(default="all", max_length=30)


def _job_ref(uid: str, job_id: str):
    return db.collection("users").document(uid).collection("jobs").document(job_id)


def _prospect_ref(uid: str, prospect_id: str):
    return db.collection("users").document(uid).collection("prospects").document(prospect_id)


def _calibrate_candidates(candidates: list[dict], feedback_docs: list[dict], prospect: dict) -> list[dict]:
    name = str(prospect.get("businessName", "")).strip().casefold()
    route_signals: dict[str, list[float]] = {}
    known_wrong = set()
    for item in feedback_docs:
        route = str(item.get("sourceRoute", ""))
        label = item.get("label")
        rating = min(10, max(1, int(item.get("rating", 5))))
        # Direction comes from the reviewer label; the rating fine-tunes evidence quality.
        direction = {"correct": 1.0, "wrong": -1.5, "stale": -0.7}.get(label)
        if direction is None:
            continue
        route_signals.setdefault(route, []).append(direction + (rating - 5) * 0.12)
        if label == "wrong" and str(item.get("businessName", "")).strip().casefold() == name:
            known_wrong.add(str(item.get("email", "")).strip().casefold())

    adjusted = []
    for candidate in candidates:
        if str(candidate.get("email", "")).strip().casefold() in known_wrong:
            continue
        route = str(candidate.get("sourceRoute", ""))
        signals = route_signals.get(route, [])
        base = int(candidate.get("confidenceScore", 1))
        # Shrink early feedback toward zero; cap route history's effect at two score points.
        delta = round(max(-2.0, min(2.0, (sum(signals) / (len(signals) + 2)) * 2))) if signals else 0
        adjusted.append({
            **candidate,
            "baseEvidenceScore": base,
            "confidenceScore": max(1, min(10, base + delta)),
            "scoreBasis": f"Evidence rubric; route calibration from {len(signals)} prior reviews; not a probability.",
            "calibrationReviews": len(signals),
        })
    return adjusted


async def _process_job(uid: str, job_id: str) -> None:
    job_ref = _job_ref(uid, job_id)
    try:
        job_snapshot = await asyncio.to_thread(job_ref.get)
        if not job_snapshot.exists:
            return
        job = job_snapshot.to_dict() or {}
        if job.get("status") not in {"queued", "running"}:
            return
        await asyncio.to_thread(job_ref.update, {"status": "running", "updatedAt": firestore.SERVER_TIMESTAMP})
        prospect_ids = job.get("prospectIds") or []
        if not prospect_ids:
            # Older queue records are handled conservatively; only queued prospects are eligible.
            docs = await asyncio.to_thread(
                lambda: list(db.collection("users").document(uid).collection("prospects")
                             .where(filter=FieldFilter("status", "==", "queued")).limit(400).stream())
            )
            prospect_ids = [item.id for item in docs]
        prospect_ids = [item for item in prospect_ids if isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", item)]

        requested = max(1, int(job.get("requestedCount", len(prospect_ids) or 1)))
        feedback_refs = db.collection("users").document(uid).collection("feedback")
        feedback_docs = await asyncio.to_thread(lambda: [item.to_dict() or {} for item in feedback_refs.order_by("createdAt", direction=firestore.Query.DESCENDING).limit(200).stream()])
        completed = 0
        failures = 0
        for prospect_id in prospect_ids[:400]:
            prospect_ref = _prospect_ref(uid, prospect_id)
            snapshot = await asyncio.to_thread(prospect_ref.get)
            if not snapshot.exists:
                completed += 1
                continue
            prospect = snapshot.to_dict() or {}
            if prospect.get("status") not in {"queued", "running"}:
                completed += 1
                continue
            await asyncio.to_thread(prospect_ref.update, {"status": "running", "updatedAt": firestore.SERVER_TIMESTAMP})
            try:
                candidates, errors = await enrich_prospect(prospect, SEARCH_KEY)
                extracted_count = len(candidates)
                candidates = _calibrate_candidates(candidates, feedback_docs, prospect)
                if candidates:
                    for candidate in candidates:
                        candidate_doc = {
                            **candidate,
                            "prospectId": prospect_id,
                            "businessName": prospect.get("businessName", ""),
                            "createdAt": firestore.SERVER_TIMESTAMP,
                            "extractedAt": firestore.SERVER_TIMESTAMP,
                        }
                        candidate_key = hashlib.sha256(
                            f"{prospect_id}\n{candidate['email'].lower()}\n{candidate['sourceUrl']}".encode("utf-8")
                        ).hexdigest()[:40]
                        candidate_ref = db.collection("users").document(uid).collection("candidates").document(candidate_key)
                        await asyncio.to_thread(candidate_ref.set, candidate_doc)
                    review_needed = any(item.get("requiresReview") for item in candidates)
                    status = "needs_review" if review_needed else "found"
                    update = {"status": status, "updatedAt": firestore.SERVER_TIMESTAMP}
                    if errors:
                        update["lastLookupNote"] = "Some routes could not be checked: " + " | ".join(errors[:2])[:500]
                    await asyncio.to_thread(prospect_ref.update, update)
                elif extracted_count:
                    await asyncio.to_thread(prospect_ref.update, {
                        "status": "needs_review",
                        "lastLookupNote": "Only an email previously marked wrong was found; it was suppressed.",
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                    })
                elif errors:
                    failures += 1
                    await asyncio.to_thread(prospect_ref.update, {
                        "status": "failed",
                        "lastLookupNote": "No route returned readable evidence. " + " | ".join(errors[:3])[:500],
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                    })
                else:
                    await asyncio.to_thread(prospect_ref.update, {
                        "status": "not_found",
                        "lastLookupNote": "No email was found in the checked public sources.",
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                    })
            except Exception as exc:
                log.exception("Prospect lookup failed for %s", prospect_id)
                failures += 1
                await asyncio.to_thread(prospect_ref.update, {
                    "status": "failed",
                    "lastLookupNote": f"Lookup failed: {type(exc).__name__}.",
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                })
            completed += 1
            await asyncio.to_thread(job_ref.update, {
                "progress": completed,
                "progressPercent": min(100, round(100 * completed / requested)),
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
            await asyncio.sleep(0.35)

        status = "partial" if failures else "completed"
        await asyncio.to_thread(job_ref.update, {
            "status": status,
            "progress": min(completed, requested),
            "progressPercent": 100,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
    except Exception:
        log.exception("Job failed: %s", job_id)
        try:
            await asyncio.to_thread(job_ref.update, {"status": "failed", "lastError": "Worker failed; queued prospects remain available for retry.", "updatedAt": firestore.SERVER_TIMESTAMP})
        except Exception:
            log.exception("Could not save job failure state")
    finally:
        active_jobs.pop(job_id, None)


def _schedule_job(uid: str, job_id: str) -> bool:
    running = active_jobs.get(job_id)
    if running and not running.done():
        return False
    active_jobs[job_id] = asyncio.create_task(_process_job(uid, job_id), name=f"vivara-job-{job_id}")
    return True


async def _resume_loop() -> None:
    while True:
        try:
            if firebase_ready and ADMIN_UID:
                jobs_ref = db.collection("users").document(ADMIN_UID).collection("jobs")
                for status in ("queued", "running"):
                    docs = await asyncio.to_thread(lambda s=status: list(jobs_ref.where(filter=FieldFilter("status", "==", s)).limit(20).stream()))
                    for item in docs:
                        _schedule_job(ADMIN_UID, item.id)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Queue resume check failed")
        await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_firebase()
    resume_task = asyncio.create_task(_resume_loop(), name="vivara-queue-resume")
    yield
    resume_task.cancel()
    for task in list(active_jobs.values()):
        task.cancel()


app = FastAPI(title="Vivara Forge Enrichment Worker", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/")
def root():
    return {"service": "Vivara Forge Enrichment Worker", "health": "/health"}


@app.get("/health")
def health():
    return {"status": "ok", "worker_ready": bool(firebase_ready and ADMIN_UID), "queue_runner": True}


@app.post("/api/wake")
async def wake(payload: WakeRequest, authorization: str | None = Header(default=None)):
    user = require_admin(authorization)
    uid = user["uid"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", payload.job_id):
        raise HTTPException(status_code=400, detail="Queue job ID is malformed.")
    snapshot = await asyncio.to_thread(_job_ref(uid, payload.job_id).get)
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="Queue job was not found for this account.")
    job = snapshot.to_dict() or {}
    if job.get("status") not in {"queued", "running"}:
        return {"status": job.get("status", "unknown"), "started": False}
    started = _schedule_job(uid, payload.job_id)
    return {"status": "running" if started else "already_running", "started": started}


def _query_tags(category: str) -> list[tuple[str, str]]:
    mapping = {
        "mechanic": [("shop", "car_repair"), ("craft", "car_repair"), ("amenity", "car_repair")],
        "contractor": [("craft", "electrician|plumber|carpenter|roofer|builder|painter|hvac"), ("office", "construction")],
        "restaurant": [("amenity", "restaurant|cafe|fast_food|bar")],
        "beauty": [("shop", "hairdresser|beauty|barber"), ("amenity", "spa")],
        "health": [("healthcare", ""), ("amenity", "clinic|pharmacy|doctors|dentist")],
        "retail": [("shop", "")],
        "all": [("shop", ""), ("craft", ""), ("office", ""), ("amenity", "restaurant|cafe|fast_food|bar|clinic|pharmacy|doctors|dentist")],
    }
    return mapping.get(category, mapping["all"])


def build_overpass_query(lat: float, lon: float, radius: int, category: str) -> str:
    clauses = []
    for key, value in _query_tags(category):
        selector = f'[{key}="{value}"]' if value and "|" not in value else f'[{key}~"^({value})$"]' if value else f'[{key}]'
        clauses.append(f'nwr(around:{radius},{lat:.6f},{lon:.6f}){selector}["name"];')
    return "[out:json][timeout:20];(\n" + "\n".join(clauses) + "\n);out center tags;"


@app.post("/api/local-search")
async def local_search(payload: LocalSearchRequest, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    query = build_overpass_query(payload.lat, payload.lon, payload.radius_m, payload.category)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=8.0), headers={"User-Agent": "VivaraForgeResearch/1.0"}) as client:
            response = await client.post(OVERPASS_URL, data={"data": query})
            response.raise_for_status()
            raw = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"OpenStreetMap search failed ({type(exc).__name__}). Try again later.")

    results = []
    for element in raw.get("elements", [])[:100]:
        tags = element.get("tags") or {}
        name = str(tags.get("name", "")).strip()
        if not name:
            continue
        location = element.get("center") or element
        address_parts = [tags.get(key) for key in ("addr:housenumber", "addr:street", "addr:city", "addr:state") if tags.get(key)]
        category = tags.get("shop") or tags.get("craft") or tags.get("amenity") or tags.get("office") or tags.get("healthcare") or "business"
        osm_type = element.get("type", "node")
        osm_url = f"https://www.openstreetmap.org/{osm_type}/{element.get('id')}"
        results.append({
            "name": name[:160],
            "category": str(category)[:80],
            "city": tags.get("addr:city", ""),
            "state": tags.get("addr:state", ""),
            "address": ", ".join(address_parts) or "Address not listed",
            "phone": tags.get("contact:phone") or tags.get("phone") or "",
            "website": tags.get("contact:website") or tags.get("website") or "",
            "email": tags.get("contact:email") or tags.get("email") or "",
            "emailEvidence": "Email tag supplied on the OpenStreetMap source record." if tags.get("contact:email") or tags.get("email") else "",
            "sourceUrl": osm_url,
            "lat": location.get("lat"),
            "lon": location.get("lon"),
            "sourceRoute": "openstreetmap_overpass",
        })
    return {"results": results, "source": "OpenStreetMap contributors", "attribution": "© OpenStreetMap contributors"}
