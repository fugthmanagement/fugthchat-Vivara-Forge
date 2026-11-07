"""State routing without guessing a location from a phone area code."""
import json
import re
from pathlib import Path

REGISTRIES = {r['code']: r for r in json.loads(Path(__file__).with_name('registries.json').read_text())}

def state_of(prospect):
    raw = str(prospect.get('state') or prospect.get('stateCode') or prospect.get('state_code') or '').strip().upper()
    for code, item in REGISTRIES.items():
        if raw in {code, item['name'].upper()}:
            return code
    meta = import_meta(prospect)
    texts = [str(v) for v in [prospect.get('city'), prospect.get('address'), prospect.get('full_address'), prospect.get('formatted_address'), meta.get('address')] if v]
    codes = set(code for text in texts for code in re.findall(r'(?:,|\s)([A-Z]{2})(?=\s+\d{5}(?:-\d{4})?\b|\s*(?:,\s*(?:USA|US|United States))?\s*$)', text)) & REGISTRIES.keys()
    return next(iter(codes)) if len(codes) == 1 else ''

def import_meta(prospect):
    try:
        value = json.loads(str(prospect.get('notes', '')).split('[VF-META]', 1)[1])
        return value if isinstance(value, dict) else {}
    except (ValueError, IndexError):
        return {}

def missing_route_message(prospect, search_enabled):
    state = state_of(prospect)
    if not state:
        return 'NEEDS_INPUT: State is missing. Assign the correct state to selected leads, or add a public source URL.'
    if state != 'FL' and not search_enabled:
        return f'NEEDS_SETUP: {REGISTRIES[state]["name"]} registry needs a source link or uploaded filing; automatic discovery requires a search API. No search was completed.'
    return ''
