"""A bounded, evidence-first GOAP planner for prospect research.

This module plans which public-source tools may run. It never turns a model
answer into a contact record and never treats a registry role as an owner.
"""
from dataclasses import dataclass, asdict
from registry import state_of

@dataclass(frozen=True)
class Action:
    tool: str
    purpose: str
    requires: tuple[str, ...]

def plan(prospect: dict, web_search_configured: bool) -> list[Action]:
    """Create the smallest legal/public route plan for this lead.

    GOAP state: location is known, sources are acquired, entity is corroborated,
    filing is read, then evidence is reviewed. Actions without prerequisites are
    omitted instead of guessing a route.
    """
    state = state_of(prospect)
    has_source = bool(prospect.get('website') or prospect.get('sourceUrlsText') or prospect.get('manualSourceUrl'))
    actions = [Action('validate_lead', 'Normalize name, state, address and source links.', ('business_name',))]
    if state == 'FL':
        actions += [
            Action('sunbiz_entity_lookup', 'Find exact legal-name candidates in the Florida registry.', ('business_name', 'state=FL')),
            Action('sunbiz_entity_corroboration', 'Compare filing address, city or ZIP against the imported lead.', ('sunbiz_entity_lookup',)),
            Action('sunbiz_document_reader', 'Read newest and original filing documents; discard document bytes after extraction.', ('sunbiz_entity_corroboration',)),
        ]
    if has_source:
        actions.append(Action('public_source_reader', 'Read supplied business pages and same-site contact/about pages.', ('public_url',)))
    if web_search_configured:
        actions.append(Action('bounded_web_discovery', 'Discover up to five public business pages for the exact business and location.', ('business_name', 'web_search_key')))
    if prospect.get('imageConsent') is True:
        actions.append(Action('consented_public_image_discovery', 'Inspect supplied public business pages for image candidates; archive only a user-approved candidate.', ('recorded_business_consent', 'public_url')))
    actions.append(Action('evidence_fact_check', 'Check candidate evidence against its source text; never create facts.', ('source_evidence',)))
    actions.append(Action('honest_result', 'Return sourced profiles, review candidates, or an explicit missing/blocked/not-found outcome.', ('completed_routes',)))
    return actions

def plan_trace(prospect: dict, web_search_configured: bool) -> list[dict]:
    return [asdict(action) for action in plan(prospect, web_search_configured)]
