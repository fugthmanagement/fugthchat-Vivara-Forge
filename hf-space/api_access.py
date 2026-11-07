"""Account-scoped API credentials and atomic credit reservations for durable jobs."""
import asyncio
import hashlib
import re
import secrets
from datetime import datetime, timezone
from fastapi import Header, HTTPException
from pydantic import BaseModel, Field
from firebase_admin import auth, firestore

class KeyRequest(BaseModel):
    name: str = Field(default='Integration', min_length=1, max_length=80)

class GrantRequest(BaseModel):
    credits: int = Field(ge=1, le=100000)
    operation_id: str = Field(pattern=r'^[A-Za-z0-9_-]{8,100}$')

class JobRequest(BaseModel):
    prospect_ids: list[str] = Field(min_length=1, max_length=400)

class ImportLead(BaseModel):
    external_id: str = Field(min_length=1,max_length=160)
    businessName: str = Field(min_length=1,max_length=160)
    city: str = Field(default='',max_length=100)
    state: str = Field(default='',max_length=50)
    phone: str = Field(default='',max_length=40)
    website: str = Field(default='',max_length=2048)
    category: str = Field(default='',max_length=80)
    sourceUrlsText: str = Field(default='',max_length=4000)
    address: str = Field(default='',max_length=240)

class ImportRequest(BaseModel):
    prospects: list[ImportLead] = Field(min_length=1,max_length=100)

def settle_api_job_impl(db, uid, job_id):
    job_ref = db.collection('users').document(uid).collection('jobs').document(job_id)
    balance_ref = db.collection('apiAccounts').document(uid)
    pointer = db.collection('apiPendingJobs').document(job_id)
    @firestore.transactional
    def settle(tx):
        job = job_ref.get(transaction=tx).to_dict() or {}
        if not job.get('apiKeyId') or job.get('status') in {'queued','running'}:
            return
        balance = balance_ref.get(transaction=tx).to_dict() or {}
        if job.get('creditsSettled'):
            tx.delete(pointer)
            return
        rows = [{'status':job.get('resultStatuses',{}).get(i,'failed')} for i in job.get('prospectIds',[])]
        refund = sum(row.get('status') in {'failed','blocked','needs_setup','needs_input','queued','running'} for row in rows)
        total = len(rows)
        tx.set(balance_ref, {'credits':balance.get('credits',0)+refund,'reserved':max(0,balance.get('reserved',0)-total),'used':balance.get('used',0)+total-refund},merge=True)
        tx.update(job_ref,{'creditsSettled':True,'creditsUsed':total-refund,'creditsRefunded':refund})
        tx.delete(pointer)
    return settle(db.transaction())

def install(app, ctx):
    def account(authorization):
        if not ctx.firebase_ready:
            raise HTTPException(503, 'Worker credentials are not configured.')
        try:
            if not authorization or not authorization.startswith('Bearer '):
                raise ValueError()
            user = auth.verify_id_token(authorization[7:], check_revoked=True)
        except Exception:
            raise HTTPException(401, 'Sign in again.')
        if not user.get('email_verified'):
            raise HTTPException(403, 'Verify your email first.')
        return user

    def key_identity(value):
        if not ctx.firebase_ready or not value or not value.startswith('vf_') or len(value) > 200:
            raise HTTPException(401, 'Invalid API key.')
        digest = hashlib.sha256(value.encode()).hexdigest()
        ref = ctx.db.collection('apiKeys').document(digest)
        data = ref.get().to_dict() or {}
        if not data or data.get('revoked'):
            raise HTTPException(401, 'Invalid or revoked API key.')
        try:
            user = auth.get_user(data['uid'])
        except Exception:
            raise HTTPException(401, 'Account unavailable.')
        if user.disabled or not user.email_verified:
            raise HTTPException(403, 'Account is disabled or unverified.')
        return data['uid'], digest

    @app.post('/api/keys')
    def create_key(payload: KeyRequest, authorization: str | None = Header(default=None)):
        user = account(authorization)
        # Keep credentials server-side; the only plaintext copy is this response.
        active = list(ctx.db.collection('apiKeys').where('uid', '==', user['uid']).stream())
        if sum(not (d.to_dict() or {}).get('revoked') for d in active) >= 10:
            raise HTTPException(409, 'Revoke an old key before creating another (maximum 10).')
        secret = 'vf_' + secrets.token_urlsafe(36)
        digest = hashlib.sha256(secret.encode()).hexdigest()
        ctx.db.collection('apiKeys').document(digest).set({'uid':user['uid'], 'name':payload.name, 'prefix':secret[:10], 'revoked':False, 'createdAt':firestore.SERVER_TIMESTAMP})
        return {'id':digest, 'key':secret, 'message':'Copy now. This secret will not be shown again.'}

    @app.get('/api/keys')
    def keys(authorization: str | None = Header(default=None)):
        user = account(authorization)
        docs = ctx.db.collection('apiKeys').where('uid', '==', user['uid']).stream()
        return {'keys':[{'id':d.id, **d.to_dict()} for d in docs], 'usage':ctx.db.collection('apiAccounts').document(user['uid']).get().to_dict() or {'credits':0,'reserved':0,'requests':0}}

    @app.put('/api/keys/{key_id}/revoke')
    def revoke(key_id: str, authorization: str | None = Header(default=None)):
        user = account(authorization)
        if not re.fullmatch(r'[a-f0-9]{64}', key_id):
            raise HTTPException(404, 'Key not found.')
        ref = ctx.db.collection('apiKeys').document(key_id)
        if (ref.get().to_dict() or {}).get('uid') != user['uid']:
            raise HTTPException(404, 'Key not found.')
        ref.update({'revoked':True})
        return {'revoked':True}

    @app.post('/api/admin/accounts/{uid}/credits')
    def grant(uid: str, payload: GrantRequest, authorization: str | None = Header(default=None)):
        admin = ctx.require_admin(authorization)
        try:
            auth.get_user(uid)
        except auth.UserNotFoundError:
            raise HTTPException(404, 'Account not found.')
        target = ctx.db.collection('apiAccounts').document(uid)
        ledger = target.collection('ledger').document(payload.operation_id)
        @firestore.transactional
        def apply(tx):
            old = ledger.get(transaction=tx)
            balance = target.get(transaction=tx).to_dict() or {}
            if old.exists:
                if old.to_dict().get('credits') != payload.credits:
                    raise HTTPException(409, 'Operation ID already used with another amount.')
                return balance
            tx.set(target, {'credits':balance.get('credits',0)+payload.credits}, merge=True)
            tx.set(ledger, {'credits':payload.credits,'actor':admin['uid'],'createdAt':firestore.SERVER_TIMESTAMP})
            return {**balance,'credits':balance.get('credits',0)+payload.credits}
        return apply(ctx.db.transaction())

    @app.get('/api/admin/accounts/{uid}/credits')
    def admin_usage(uid: str, authorization: str | None = Header(default=None)):
        ctx.require_admin(authorization)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',uid):
            raise HTTPException(400,'Invalid account UID.')
        return ctx.db.collection('apiAccounts').document(uid).get().to_dict() or {'credits':0,'reserved':0,'used':0,'requests':0}

    @app.post('/v1/jobs', status_code=202)
    async def submit(payload: JobRequest, x_api_key: str | None = Header(default=None), idempotency_key: str | None = Header(default=None)):
        uid, digest = await asyncio.to_thread(key_identity, x_api_key)
        if not idempotency_key or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', idempotency_key):
            raise HTTPException(400, 'Send an Idempotency-Key header (8–100 letters, digits, underscores or hyphens).')
        ids = list(dict.fromkeys(payload.prospect_ids))
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', i) for i in ids):
            raise HTTPException(400, 'Invalid prospect ID.')
        job_id = 'api_' + hashlib.sha256((uid+':'+idempotency_key).encode()).hexdigest()[:40]
        job_ref = ctx._job_ref(uid, job_id)
        balance_ref = ctx.db.collection('apiAccounts').document(uid)
        @firestore.transactional
        def reserve(tx):
            previous = job_ref.get(transaction=tx)
            balance = balance_ref.get(transaction=tx).to_dict() or {}
            key = ctx.db.collection('apiKeys').document(digest).get(transaction=tx).to_dict() or {}
            if key.get('revoked') or key.get('uid') != uid:
                raise HTTPException(401, 'Key revoked.')
            if previous.exists:
                if previous.to_dict().get('prospectIds') != ids:
                    raise HTTPException(409, 'Idempotency-Key was used for a different request.')
                return previous.to_dict().get('status')
            refs = [ctx._prospect_ref(uid,i) for i in ids]
            snapshots = [r.get(transaction=tx) for r in refs]
            if any(not d.exists for d in snapshots):
                raise HTTPException(404, 'A prospect does not belong to this account.')
            if any(d.to_dict().get('status') in {'queued','running'} for d in snapshots):
                raise HTTPException(409, 'A selected prospect is already queued or running.')
            if balance.get('credits',0) < len(ids):
                raise HTTPException(402, 'Insufficient lookup credits.')
            tx.set(balance_ref, {'credits':balance.get('credits',0)-len(ids),'reserved':balance.get('reserved',0)+len(ids),'requests':balance.get('requests',0)+1}, merge=True)
            tx.update(ctx.db.collection('apiKeys').document(digest),{'requests':key.get('requests',0)+1,'prospectsSubmitted':key.get('prospectsSubmitted',0)+len(ids),'lastUsedAt':firestore.SERVER_TIMESTAMP})
            for ref in refs:
                tx.update(ref, {'status':'queued','updatedAt':firestore.SERVER_TIMESTAMP})
            tx.set(job_ref, {'status':'queued','prospectIds':ids,'requestedCount':len(ids),'progress':0,'progressPercent':0,'apiKeyId':digest,'apiUid':uid,'createdAt':firestore.SERVER_TIMESTAMP,'updatedAt':firestore.SERVER_TIMESTAMP})
            # Durable global pointer for resuming non-admin API jobs after restarts.
            tx.set(ctx.db.collection('apiPendingJobs').document(job_id), {'uid':uid,'jobId':job_id})
            return 'queued'
        status = await asyncio.to_thread(lambda:reserve(ctx.db.transaction()))
        if status in {'queued','running'}:
            ctx._schedule_job(uid,job_id)
        return {'job_id':job_id,'status':status,'credits_reserved':len(ids)}

    @app.post('/v1/prospects')
    def import_prospects(payload: ImportRequest, x_api_key: str | None = Header(default=None)):
        import json
        from registry import state_of
        uid, _ = key_identity(x_api_key)
        values = {}
        for lead in payload.prospects:
            ident = 'ext_' + hashlib.sha256(lead.external_id.encode()).hexdigest()[:36]
            row = lead.model_dump(exclude={'external_id','address'})
            row['state'] = state_of(lead.model_dump())
            row['notes'] = '[VF-META]'+json.dumps({'address':lead.address},ensure_ascii=False)
            row['status'] = 'new'
            values[ident] = row
        @firestore.transactional
        def save(tx):
            refs = {i:ctx._prospect_ref(uid,i) for i in values}
            existing = {i:r.get(transaction=tx) for i,r in refs.items()}
            created = 0
            for ident,row in values.items():
                if existing[ident].exists:
                    continue  # Repeated imports never erase enriched evidence or user corrections.
                tx.set(refs[ident],{**row,'createdAt':firestore.SERVER_TIMESTAMP,'updatedAt':firestore.SERVER_TIMESTAMP})
                created += 1
            return {'prospect_ids':list(values),'created':created,'existing':len(values)-created}
        return save(ctx.db.transaction())

    @app.get('/v1/jobs/{job_id}')
    def result(job_id: str, x_api_key: str | None = Header(default=None)):
        uid, _ = key_identity(x_api_key)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',job_id):
            raise HTTPException(404,'Job not found.')
        job = ctx._job_ref(uid,job_id).get()
        if not job.exists:
            raise HTTPException(404,'Job not found.')
        value = job.to_dict()
        results = []
        for ident in value.get('prospectIds',[])[:400]:
            row = ctx._prospect_ref(uid,ident).get()
            if row.exists:
                evidence = ctx.db.collection('users').document(uid).collection('candidates').where('prospectId','==',ident).limit(100).stream()
                results.append({'id':ident, **row.to_dict(), 'evidence':[d.to_dict() for d in evidence]})
        return {'job_id':job_id,**value,'results':results}

    return account
