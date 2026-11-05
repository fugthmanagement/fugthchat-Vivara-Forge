---
title: Vivara Forge Enrichment Worker
emoji: 🔎
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Vivara Forge Enrichment Worker

Private-use API worker for the GitHub Pages workspace. It receives Firebase-authenticated requests, stores queue state in Firestore, checks supplied public business pages and PDF URLs, and optionally queries a configured search API. PDFs are parsed in memory and are not written to disk.

## Required Space variables and secrets

Add these in the Space settings; never commit the service-account JSON to GitHub.

| Name | Type | Purpose |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Secret | Full Firebase Admin SDK service-account JSON contents for project `vivara-forge`. Generate it in Firebase Project settings → Service accounts, then paste the full JSON into this Space secret. Never place it in GitHub, the web app, or chat. |
| `ADMIN_EMAILS` | Variable, optional | Comma-separated allowlist; defaults to the verified accounts `fugthchat@gmail.com,fugthmanagement@gmail.com`. |
| `ADMIN_UID` / `ADMIN_UIDS` | Variable, optional | Pin one or more Firebase Authentication UIDs. Not required for the two verified admin emails, which are allowlisted by default. |
| `ALLOWED_ORIGINS` | Variable | `https://fugthmanagement.github.io` (add `http://localhost:8000` only for local development). |
| `BRAVE_SEARCH_API_KEY` | Secret, optional | Enables search from a business name and location. Without it, supply a website/source URL; Florida names can also use Sunbiz. |
| `WORKER_WAKE_TOKEN` | Secret, optional | Protects scheduled wake requests from GitHub Actions; use at least 32 random characters. |
| `OVERPASS_URLS` | Variable, optional | Up to three comma-separated HTTPS OpenStreetMap Overpass endpoints, tried in order. The older `OVERPASS_URL` variable still works. |
| `MAX_CONCURRENT_JOBS` | Variable, optional | Concurrent prospect batches from 1 to 4; default is 2. |

The service-account private key is powerful. Restrict access to the Space and rotate the key if it is ever exposed.

If `/health` responds with `worker_ready: false`, the Space is online but Firebase Admin did not initialize. `POST /api/wake` will return HTTP 503 and queued Firestore jobs will wait safely. Add or repair the `FIREBASE_SERVICE_ACCOUNT_JSON` secret and restart the Space. Copying a UID or setting `ADMIN_UID` does not replace this required secret. Once `/health` reports `worker_ready: true`, the existing admin emails are recognized automatically after email verification.

## Deploy

Create a **new** Docker Space for this worker, then upload the files in this folder (`README.md`, `Dockerfile`, `requirements.txt`, `app.py`, `enrichment.py`). Do not replace an existing model or AI Space. Hugging Face's current docs say creating compute-based Docker Spaces on a personal account may require a paid plan, even though CPU Basic hardware itself has no hourly charge. Confirm the plan prompt before proceeding. After it builds, copy the Space URL into the web app's Settings and use **Check status**.

The worker verifies Firebase ID tokens and checks for a verified allowlisted email or an explicitly pinned UID. The two default admin emails can create accounts in Firebase Authentication and become worker admins after email verification. Firestore's client Rules do not protect Admin SDK writes, so the worker authorization check is mandatory. CPU Basic Spaces sleep after 48 hours of inactivity, so queued work resumes after the worker wakes; uninterrupted processing requires always-on compute.

## Runtime behavior

- `POST /api/wake` starts or resumes a queued batch; Firestore is the durable queue.
- Interrupted jobs retry automatically up to three times. The worker returns an interrupted prospect to the queue, limits concurrent batches, and retries transient source and Firestore operations with short bounded delays.
- The admin dashboard can list Authentication accounts and last sign-in, update non-admin rank claims, and save a scheduled wake interval. Rank claims are account labels; the two allowlisted emails remain protected admins.
- To wake a sleeping Space, configure `HF_WORKER_URL` and `WORKER_WAKE_TOKEN` as GitHub Actions secrets and `WORKER_WAKE_TOKEN` in the Space. The repository workflow calls the Space every 15 minutes; the saved schedule controls whether it starts queued jobs on that check.
- `/health` reports whether Firebase worker credentials were initialized.
- `POST /api/local-search` uses OpenStreetMap Overpass and returns attributed source records.
- The crawler fetches explicitly supplied business website/source URLs, a small number of same-site contact pages, exact-name Florida Sunbiz entity matches and up to three linked PDFs per matching record. It does not crawl Google Maps.
- It collects multiple public email candidates and publicly listed phone numbers. A public person's name is retained only when a page or filing explicitly associates it with a role such as owner, registered agent, officer, or manager. Roles are not conflated: a registered agent is not automatically considered an owner. Each result keeps its source and evidence and requires human review.
- It does not invent likely email patterns or search for private personal phone numbers. PDF bytes are parsed in memory, then discarded; the source URL and extracted evidence remain available for review.
- A conclusive lookup marks older evidence as superseded. If every route is temporarily unavailable, prior successful evidence remains current so a temporary outage cannot erase the last usable result.
- MX lookup means the domain advertises mail exchange records; it does not verify that a mailbox exists or accepts mail.
- Request caps and timeouts are deliberately small for a personal research tool. Respect each source's terms and robots policy.

Hugging Face Spaces can sleep or restart based on the Space's hardware/plan. A Firestore queue can resume when the worker starts again. A closed phone browser alone does not stop a running server job.
