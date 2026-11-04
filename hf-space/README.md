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
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Secret | Full Firebase service-account JSON contents for project `vivara-forge`. |
| `ADMIN_UID` | Variable | Firebase Authentication UID allowed to enqueue and run lookups. |
| `ALLOWED_ORIGINS` | Variable | `https://fugthmanagement.github.io` (add `http://localhost:8000` only for local development). |
| `BRAVE_SEARCH_API_KEY` | Secret, optional | Enables the optional Brave Search route. Without it, web search is skipped. |
| `OVERPASS_URL` | Variable, optional | OpenStreetMap Overpass endpoint; default is the public interpreter endpoint. |

The service-account private key is powerful. Restrict access to the Space and rotate the key if it is ever exposed.

## Deploy

Create a **new** Docker Space for this worker, then upload the files in this folder (`README.md`, `Dockerfile`, `requirements.txt`, `app.py`, `enrichment.py`). Do not replace an existing model or AI Space. Hugging Face's current docs say creating compute-based Docker Spaces on a personal account may require a paid plan, even though CPU Basic hardware itself has no hourly charge. Confirm the plan prompt before proceeding. After it builds, copy the Space URL into the web app's Settings and use **Check status**.

The worker verifies Firebase ID tokens and checks `ADMIN_UID`. Firestore's client Rules do not protect Admin SDK writes, so the worker authorization check is mandatory. CPU Basic Spaces sleep after 48 hours of inactivity, so queued work resumes after the worker wakes; uninterrupted processing requires always-on compute.

## Runtime behavior

- `POST /api/wake` starts or resumes a queued batch; Firestore is the durable queue.
- `/health` reports whether Firebase worker credentials were initialized.
- `POST /api/local-search` uses OpenStreetMap Overpass and returns attributed source records.
- The crawler fetches only explicitly supplied business website/source URLs and a small number of same-site contact pages. It does not crawl Google Maps.
- Public emails are emitted only when found in fetched text. It does not generate likely address patterns. Filing and directory contacts are marked for review.
- MX lookup means the domain advertises mail exchange records; it does not verify that a mailbox exists or accepts mail.
- Request caps and timeouts are deliberately small for a personal research tool. Respect each source's terms and robots policy.

Hugging Face Spaces can sleep or restart based on the Space's hardware/plan. A Firestore queue can resume when the worker starts again. A closed phone browser alone does not stop a running server job.
