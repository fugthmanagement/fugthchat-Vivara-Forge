"""Optional advisory review by the separate small-model gateway.

The gateway receives only a bounded public evidence packet. Its answer changes
the review label, never the extracted contact fields, source URL, or evidence.
"""
import asyncio
import json
import os
from typing import Any
import httpx

GATEWAY_URL = os.getenv('FACT_CHECK_GATEWAY_URL', '').strip().rstrip('/')
GATEWAY_TOKEN = os.getenv('FACT_CHECK_GATEWAY_TOKEN', '').strip()

async def review_candidates(business: dict, candidates: list[dict]) -> list[dict]:
    if not GATEWAY_URL or not candidates:
        return candidates
    packet = {
        'instruction': 'For each candidate, return only supported, uncertain, or unsupported. Use source evidence only. Do not infer missing people, email addresses, phone numbers, or ownership.',
        'business': {k: str(business.get(k, ''))[:160] for k in ('businessName','city','state','phone')},
        'candidates': [{'email':c.get('email',''),'route':c.get('sourceRoute',''),'evidence':str(c.get('evidenceText',''))[:300]} for c in candidates[:40]],
    }
    headers = {'Content-Type':'application/json'}
    if GATEWAY_TOKEN:
        headers['Authorization'] = 'Bearer ' + GATEWAY_TOKEN
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(GATEWAY_URL + '/v1/fact-check', headers=headers, json=packet)
            if response.status_code != 200:
                return candidates
            findings = response.json().get('findings', [])
        labels = {str(item.get('email','')).lower():str(item.get('verdict','uncertain')).lower() for item in findings if isinstance(item,dict)}
        output = []
        for candidate in candidates:
            item = dict(candidate)
            verdict = labels.get(str(item.get('email','')).lower(), 'uncertain')
            if verdict not in {'supported','uncertain','unsupported'}:
                verdict = 'uncertain'
            item['factCheck'] = verdict
            item['requiresReview'] = True
            if verdict == 'unsupported':
                item['confidenceScore'] = min(int(item.get('confidenceScore', 0) or 0), 2)
            output.append(item)
        return output
    except (httpx.HTTPError, ValueError, TypeError, asyncio.TimeoutError):
        return candidates
