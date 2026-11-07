import sys,copy,unittest,hashlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'hf-space'))
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
import api_access

class Snapshot:
 def __init__(self,ref):self.id=ref.path.split('/')[-1];self.value=copy.copy(ref.db.data.get(ref.path));self.exists=self.value is not None
 def to_dict(self):return copy.copy(self.value)
class Ref:
 def __init__(self,db,path):self.db=db;self.path=path
 def collection(self,p):return Ref(self.db,self.path+'/'+p)
 def document(self,p):return Ref(self.db,self.path+'/'+p)
 def get(self,transaction=None):return Snapshot(self)
 def set(self,value,merge=False):
  if not merge:self.db.data[self.path]={}
  self.db.data.setdefault(self.path,{}).update(value)
 def update(self,value):self.set(value,True)
class DB:
 def __init__(self):self.data={}
 def collection(self,p):return Ref(self,p)
 def transaction(self):return self
 def set(self,ref,val,merge=False):ref.set(val,merge)
 def update(self,ref,val):ref.update(val)
 def delete(self,ref):self.data.pop(ref.path,None)

class ApiTests(unittest.TestCase):
 def setUp(self):
  self.db=DB();self.secret='vf_'+('x'*48);self.digest=hashlib.sha256(self.secret.encode()).hexdigest()
  self.db.data['apiKeys/'+self.digest]={'uid':'alice','revoked':False}
  self.db.data['apiAccounts/alice']={'credits':3}
  self.db.data['users/alice/prospects/lead1']={'businessName':'Sample','status':'new'}
  def admin(value):
   if value!='Bearer admin':raise HTTPException(403,'Admin required')
   return {'uid':'admin'}
  self.ctx=SimpleNamespace(db=self.db,firebase_ready=True,require_admin=admin,_prospect_ref=lambda u,i:self.db.collection('users').document(u).collection('prospects').document(i),_job_ref=lambda u,i:self.db.collection('users').document(u).collection('jobs').document(i),_schedule_job=lambda u,i:True)
  self.authpatch=patch('api_access.auth.get_user',return_value=SimpleNamespace(disabled=False,email_verified=True));self.authpatch.start()
  self.txpatch=patch('api_access.firestore.transactional',lambda fn:fn);self.txpatch.start()
  app=FastAPI();api_access.install(app,self.ctx);self.client=TestClient(app)
 def tearDown(self):self.authpatch.stop();self.txpatch.stop();self.client.close()
 def submit(self,ids=['lead1'],key='request-0001'):
  return self.client.post('/v1/jobs',headers={'X-API-Key':self.secret,'Idempotency-Key':key},json={'prospect_ids':ids})
 def test_idempotent_credit_charge(self):
  first=self.submit();self.assertEqual(first.status_code,202)
  self.assertEqual(self.submit().json()['job_id'],first.json()['job_id'])
  self.assertEqual(self.db.data['apiAccounts/alice']['credits'],2)
  self.assertEqual(self.db.data['apiAccounts/alice']['requests'],1)
 def test_no_other_account_access(self):
  self.db.data['users/bob/prospects/other']={'status':'new'}
  self.assertEqual(self.submit(['other']).status_code,404)
  self.assertEqual(self.db.data['apiAccounts/alice']['credits'],3)
 def test_insufficient_credits_no_queue(self):
  self.db.data['apiAccounts/alice']['credits']=0
  self.assertEqual(self.submit().status_code,402)
  self.assertEqual(self.db.data['users/alice/prospects/lead1']['status'],'new')
 def test_revoked_key(self):
  self.db.data['apiKeys/'+self.digest]['revoked']=True
  self.assertEqual(self.submit().status_code,401)
 def test_idempotency_conflict(self):
  self.submit();self.assertEqual(self.submit(['different']).status_code,409)
 def test_nonadmin_cannot_grant(self):
  response=self.client.post('/api/admin/accounts/alice/credits',headers={'Authorization':'Bearer member'},json={'credits':100,'operation_id':'grant-0001'})
  self.assertEqual(response.status_code,403)
 def test_grant_replay_once(self):
  for i in range(2):
   response=self.client.post('/api/admin/accounts/alice/credits',headers={'Authorization':'Bearer admin'},json={'credits':100,'operation_id':'grant-0001'})
   self.assertEqual(response.status_code,200)
  self.assertEqual(self.db.data['apiAccounts/alice']['credits'],103)
 def test_api_import_does_not_erase_enrichment(self):
  body={'prospects':[{'external_id':'management-123','businessName':'Sample Shop','city':'Macon, GA'}]}
  response=self.client.post('/v1/prospects',headers={'X-API-Key':self.secret},json=body)
  ident=response.json()['prospect_ids'][0];path='users/alice/prospects/'+ident
  self.db.data[path]['status']='found'
  response=self.client.post('/v1/prospects',headers={'X-API-Key':self.secret},json=body)
  self.assertEqual(response.json()['existing'],1);self.assertEqual(self.db.data[path]['status'],'found');self.assertEqual(self.db.data[path]['state'],'GA')
 def test_refund_once(self):
  result=self.submit();job_id=result.json()['job_id'];path='users/alice/jobs/'+job_id
  self.db.data[path].update(status='partial',resultStatuses={'lead1':'blocked'})
  for i in range(2):api_access.settle_api_job_impl(self.db,'alice',job_id)
  self.assertEqual(self.db.data['apiAccounts/alice']['credits'],3)
  self.assertEqual(self.db.data['apiAccounts/alice']['reserved'],0)
  self.assertEqual(self.db.data['apiAccounts/alice']['used'],0)
 def test_account_not_key_determines_idempotency(self):
  self.assertEqual(self.submit(key='bad').status_code,400)

if __name__=='__main__':unittest.main()
