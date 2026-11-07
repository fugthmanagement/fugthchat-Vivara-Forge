"""Optional advisory review by the separate small-model gateway.

The gateway receives only a bounded public evidence packet. Its answer changes
the review label, never the extracted contact fields, source URL, or evidence.
"""
import asyncio
import os
import re
import httpx

GATEWAY_URL = os.getenv('FACT_CHECK_GATEWAY_URL', '').strip().rstrip('/')
GATEWAY_TOKEN = os.getenv('FACT_CHECK_GATEWAY_TOKEN', '').strip()
GATEWAY_MODEL = os.getenv('FACT_CHECK_MODEL', '0.5b').strip()

async def review_candidates(business: dict, candidates: list[dict]) -> list[dict]:
    if not GATEWAY_URL or not candidates:
        return candidates
    rows = [{'email':c.get('email',''),'route':c.get('sourceRoute',''),'evidence':str(c.get('evidenceText',''))[:300]} for c in candidates[:40]]
    context = '\n'.join(f"Email: {row['email']}\nRoute: {row['route']}\nEvidence: {row['evidence']}" for row in rows)
    message = (
        'Review each listed email only against its matching evidence. Do not infer or add contacts. '
        'Return one plain-text line per email in exactly this format: email | supported OR uncertain OR unsupported. '
        'Use supported only when the exact email appears in its evidence.'
    )
    headers = {'Content-Type':'application/json', 'X-API-Key': GATEWAY_TOKEN}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(GATEWAY_URL + '/v1/chat', headers=headers, json={
                'task': 'support', 'message': message, 'business_name': str(business.get('businessName',''))[:120],
                # The gateway owns its model catalog. Forge forwards the selected
                # identifier unchanged so adding a gateway model never requires a
                # Forge code release. An empty setting still uses the small default.
                'context': context[:4000], 'model': GATEWAY_MODEL or '0.5b',
                'max_tokens': min(256, max(16, len(rows) * 12)), 'temperature': 0.0,
            })
            if response.status_code != 200:
                return candidates
            completion = str(response.json().get('text') or response.json().get('response') or response.json().get('message') or '')
        labels = {}
        for email, verdict in re.findall(r'([A-Z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Z0-9.-]+)\s*\|\s*(supported|uncertain|unsupported)', completion, re.I):
            labels[email.lower()] = verdict.lower()
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
