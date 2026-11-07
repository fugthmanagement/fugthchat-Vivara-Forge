"""Interactive recovery routes for existing, account-owned prospects."""
import asyncio
import base64
import hashlib
import re
import csv
import io
import httpx
from fastapi import Header, HTTPException
from pydantic import BaseModel, Field
from firebase_admin import firestore
from registry import REGISTRIES, state_of, import_meta
from enrichment import FetchResult, _extract, _profile_with_contacts
from pdf_reader import pdf_text

class StateUpdate(BaseModel):
    prospect_ids: list[str] = Field(min_length=1,max_length=400)
    state: str = Field(min_length=2,max_length=2)

class PdfUpload(BaseModel):
    data: str = Field(max_length=14_000_000)
    filename: str = Field(default='filing.pdf',max_length=150)
    source_url: str = Field(default='',max_length=2048)

class MapSettings(BaseModel):
    latitude: float = Field(ge=-90,le=90)
    longitude: float = Field(ge=-180,le=180)
    addressLabel: str = Field(default='',max_length=240)
    radius: int = Field(default=10,ge=0,le=200)

class GeocodeRequest(BaseModel):
    prospect_ids: list[str] = Field(min_length=1,max_length=50)

def install(app, ctx, account):
    reverse_lock = asyncio.Lock()
    reverse_cache = {}

    @app.post('/api/map/reverse')
    async def reverse(payload: MapSettings, authorization: str | None = Header(default=None)):
        account(authorization)
        key = (round(payload.latitude,5),round(payload.longitude,5))
        async with reverse_lock:
            if key in reverse_cache:
                return {'address':reverse_cache[key]}
            try:
                async with httpx.AsyncClient(timeout=12,headers={'User-Agent':'VivaraForge/1.0 (user-requested address lookup)'}) as client:
                    response = await client.get('https://nominatim.openstreetmap.org/reverse',params={'lat':payload.latitude,'lon':payload.longitude,'format':'jsonv2','zoom':18})
                    response.raise_for_status()
                    address = str(response.json().get('display_name',''))[:240]
                if not address:
                    raise ValueError()
                if len(reverse_cache)>128:
                    reverse_cache.clear()
                reverse_cache[key]=address
                return {'address':address}
            except (httpx.HTTPError,ValueError):
                raise HTTPException(502,'Street address could not be resolved. You can keep a manual address label.')
            finally:
                await asyncio.sleep(1)  # Respect public reverse-geocoder request limits.

    @app.get('/api/registries')
    def registries():
        return {'states':list(REGISTRIES.values()),'search_enabled':bool(ctx.SEARCH_KEY),'version':'2026.11.05-routes-2'}

    @app.put('/api/prospects/state')
    def assign(payload: StateUpdate, authorization: str | None = Header(default=None)):
        user = account(authorization)
        if payload.state not in REGISTRIES:
            raise HTTPException(400,'Choose a valid state.')
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',i) for i in payload.prospect_ids):
            raise HTTPException(400,'Invalid prospect ID.')
        refs = [ctx._prospect_ref(user['uid'],i) for i in set(payload.prospect_ids)]
        @firestore.transactional
        def save(tx):
            docs = [r.get(transaction=tx) for r in refs]
            if any(not d.exists for d in docs):
                raise HTTPException(404,'Prospect not found.')
            if any(d.to_dict().get('status') in {'running','queued'} for d in docs):
                raise HTTPException(409,'Wait for the active lookup before changing its state.')
            for ref in refs:
                tx.update(ref,{'state':payload.state,'updatedAt':firestore.SERVER_TIMESTAMP})
        save(ctx.db.transaction())
        return {'updated':len(refs)}

    @app.post('/api/prospects/{prospect_id}/pdf')
    async def upload(prospect_id: str, payload: PdfUpload, authorization: str | None = Header(default=None)):
        user = ctx.require_admin(authorization)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',prospect_id):
            raise HTTPException(404,'Prospect not found.')
        ref = ctx._prospect_ref(user['uid'],prospect_id)
        snapshot = await asyncio.to_thread(ref.get)
        if not snapshot.exists:
            raise HTTPException(404,'Prospect not found.')
        row = snapshot.to_dict()
        if row.get('status') in {'queued','running'}:
            raise HTTPException(409,'Wait for the active lookup before adding a filing.')
        try:
            data = base64.b64decode(payload.data,validate=True)
            if len(data)>10_000_000 or not data.startswith(b'%PDF-'):
                raise ValueError('Upload a PDF smaller than 10 MB.')
            text = await asyncio.to_thread(pdf_text,data)
        except Exception as exc:
            raise HTTPException(422,'PDF could not be read: '+type(exc).__name__)
        digest = hashlib.sha256(data).hexdigest()
        del data
        source = payload.source_url if payload.source_url.startswith(('https://','http://')) else ''
        result = FetchResult(source,text,True)
        emails = _extract(result,'uploaded_filing',row.get('businessName',''))
        profile = _profile_with_contacts(result,'uploaded_filing',row.get('businessName',''))
        # An uploaded document is evidence supplied by the user, not a verified entity match.
        docs = [{**c,'requiresReview':True} for c in emails]
        if profile:
            docs.append({'candidateType':'business_profile','profile':profile,'evidenceText':text[:500]})
        if not docs:
            return {'emails':0,'profiles':0,'message':'PDF was readable but no public contact fields were found.'}
        batch = ctx.db.batch()
        for index,item in enumerate(docs):
            key = hashlib.sha256(f'{prospect_id}:{digest}:{index}'.encode()).hexdigest()[:40]
            dest = ctx.db.collection('users').document(user['uid']).collection('candidates').document(key)
            batch.set(dest,{**item,'prospectId':prospect_id,'businessName':row.get('businessName',''),'sourceRoute':'uploaded_filing','sourceUrl':source,'documentSha256':digest,'documentName':payload.filename,'requiresReview':True,'isCurrent':True,'createdAt':firestore.SERVER_TIMESTAMP,'extractedAt':firestore.SERVER_TIMESTAMP})
        batch.update(ref,{'status':'needs_review','lastLookupNote':'Uploaded filing parsed. Confirm the document belongs to this business; contacts are not mailbox-verified.','updatedAt':firestore.SERVER_TIMESTAMP})
        await asyncio.to_thread(batch.commit)
        return {'emails':len(emails),'profiles':int(bool(profile)),'message':'Evidence saved; PDF bytes discarded.'}

    @app.get('/api/map-settings')
    def map_settings(authorization: str | None = Header(default=None)):
        user = account(authorization)
        return ctx.db.collection('users').document(user['uid']).collection('preferences').document('map').get().to_dict() or {}

    @app.put('/api/map-settings')
    def save_map(payload: MapSettings, authorization: str | None = Header(default=None)):
        user = account(authorization)
        ctx.db.collection('users').document(user['uid']).collection('preferences').document('map').set(payload.model_dump())
        return payload.model_dump()

    @app.post('/api/map/geocode')
    async def geocode(payload: GeocodeRequest, authorization: str | None = Header(default=None)):
        user = account(authorization)
        ids = list(dict.fromkeys(payload.prospect_ids))
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',i) for i in ids):
            raise HTTPException(400,'Invalid prospect ID.')
        snapshots = await asyncio.to_thread(lambda:list(ctx.db.get_all([ctx._prospect_ref(user['uid'],i) for i in ids])))
        stream = io.StringIO()
        writer = csv.writer(stream)
        sent = set()
        for snap in snapshots:
            if not snap.exists:
                continue
            row = snap.to_dict()
            meta = import_meta(row)
            address = str(meta.get('address') or row.get('address') or '').strip()
            state = state_of(row)
            if not re.match(r'^\d+\s+\S',address) or not state:
                continue
            # Only street addresses are geocoded; business-name guesses are never mapped.
            writer.writerow([snap.id,address,str(row.get('city','')).split(',')[0],state,meta.get('postalCode','')])
            sent.add(snap.id)
        if not sent:
            return {'matched':0,'unmapped':len(ids),'message':'These leads need street addresses and states before they can be placed on the map.'}
        try:
            async with httpx.AsyncClient(timeout=45) as client:
                response = await client.post('https://geocoding.geo.census.gov/geocoder/locations/addressbatch',data={'benchmark':'Public_AR_Current'},files={'addressFile':('addresses.csv',stream.getvalue(),'text/csv')})
                response.raise_for_status()
            matched = 0
            batch = ctx.db.batch()
            for row in csv.reader(io.StringIO(response.text)):
                if len(row)<6 or row[0] not in sent or row[2] != 'Match':
                    continue
                lon,lat = map(float,row[5].split(','))
                if not (-90<=lat<=90 and -180<=lon<=180):
                    continue
                ref = ctx.db.collection('users').document(user['uid']).collection('candidates').document('map_'+row[0])
                batch.set(ref,{'candidateType':'business_profile','prospectId':row[0],'sourceRoute':'address_geocode','sourceUrl':'https://geocoding.geo.census.gov/','profile':{'latitude':lat,'longitude':lon,'address':row[4],'coordinateAccuracy':'street range; approximate'},'evidenceText':'Street address matched by public geocoder; not rooftop GPS.','isCurrent':True,'createdAt':firestore.SERVER_TIMESTAMP})
                matched += 1
            await asyncio.to_thread(batch.commit)
            return {'matched':matched,'unmapped':len(ids)-matched,'message':'Matched coordinates saved to your account.'}
        except (httpx.HTTPError,ValueError,IndexError):
            raise HTTPException(502,'Address service unavailable. Existing saved coordinates were retained.')
