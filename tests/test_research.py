import sys, unittest, asyncio
from pathlib import Path
from unittest.mock import patch, AsyncMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'hf-space'))
import enrichment as e
from registry import state_of,REGISTRIES
from pdf_reader import pdf_text
from research_agent import plan_trace

class StateTests(unittest.TestCase):
 def test_all_states(self): self.assertEqual(len(REGISTRIES),51)
 def test_explicit(self):
  self.assertEqual(state_of({'state':'Florida'}),'FL')
  self.assertEqual(state_of({'state':'ga'}),'GA')
 def test_saved_city(self): self.assertEqual(state_of({'city':'Macon, GA'}),'GA')
 def test_saved_address(self): self.assertEqual(state_of({'notes':'[VF-META]{"address":"123 Test St, Miami, FL 33142"}'}),'FL')
 def test_no_phone_guess(self): self.assertEqual(state_of({'phone':'305-555-1234','city':'Miami'}),'')
 def test_conflicting_address(self): self.assertEqual(state_of({'city':'Macon, GA','address':'123 Test, FL 33142'}),'')

class ParserTests(unittest.TestCase):
 def test_multiple_emails_evidence(self):
  result=e.FetchResult('https://example.org/filing.pdf','Sample Shop contact: ONE@example.org and two@example.org',True)
  rows=e._extract(result,'sunbiz_pdf_filing','Sample Shop')
  self.assertEqual({r['email'] for r in rows},{'one@example.org','two@example.org'})
  self.assertTrue(all(r['requiresReview'] and r['evidenceText'] for r in rows))
 def test_no_invented_contact(self): self.assertEqual(e._extract(e.FetchResult('https://example.org','Sample Shop',False),'business_website','Sample Shop'),[])
 def test_unrelated_search_page(self): self.assertEqual(e._extract(e.FetchResult('https://example.org','Other company contact sales@example.org',False),'optional_web_search','Sample Shop'),[])
 def test_registry_document_number_is_not_phone(self):
  self.assertEqual(e._public_contact_data('7121792598CC document 3055551234','https://example.org','sunbiz_pdf_filing')['businessPhones'],[])
 def test_labeled_registry_phone(self):
  self.assertEqual(len(e._public_contact_data('Telephone: (305) 555-1234','https://example.org','sunbiz_pdf_filing')['businessPhones']),1)
 def test_sunbiz_roles_not_owner(self):
  text='Registered Agent Name & Address\nDOE, JANE\n123 STREET\nTitle MGR\nDOE, JANE\n123 STREET'
  rows=e.sunbiz_people(text,'https://example.org')
  self.assertEqual([(x['name'],x['role']) for x in rows],[('DOE, JANE','registered_agent'),('DOE, JANE','authorized_person_mgr')])
 def test_text_pdf(self):
  import pymupdf
  doc=pymupdf.open();p=doc.new_page();p.insert_text((40,80),'Sample Shop business contact: office@example.org. This is a test fixture.')
  text=pdf_text(doc.tobytes());self.assertIn('office@example.org',text)
 def test_blank_pdf_never_succeeds(self):
  import pymupdf
  doc=pymupdf.open();doc.new_page()
  with self.assertRaises(Exception):pdf_text(doc.tobytes())

 def test_sunbiz_detail_line_extracts_registered_agent(self):
  rows=e.sunbiz_people('Registered Agent Name & Address MORALES HERNANDEZ, ROLANDO\n750 W 73 PL', 'https://search.sunbiz.org/example')
  self.assertEqual(rows[0]['name'],'MORALES HERNANDEZ, ROLANDO')
  self.assertEqual(rows[0]['role'],'registered_agent')

class RoutingTests(unittest.IsolatedAsyncioTestCase):
 def test_florida_agent_plan_has_registry_and_document_tools(self):
  tools=[item['tool'] for item in plan_trace({'businessName':'Sample Shop','state':'FL'},False)]
  self.assertEqual(tools[:4],['validate_lead','sunbiz_entity_lookup','sunbiz_entity_corroboration','sunbiz_document_reader'])
  self.assertIn('evidence_fact_check',tools)
 def test_agent_never_plans_registry_without_state(self):
  tools=[item['tool'] for item in plan_trace({'businessName':'Sample Shop'},False)]
  self.assertNotIn('sunbiz_entity_lookup',tools)
 async def test_missing_state_actionable(self):
  c,errors,p=await e.enrich_prospect({'businessName':'Sample Shop'})
  self.assertTrue(errors[0].startswith('NEEDS_INPUT:'));self.assertEqual(c,[])
 async def test_georgia_honest_capability(self):
  c,errors,p=await e.enrich_prospect({'businessName':'Sample Shop','city':'Macon, GA'})
  self.assertTrue(errors[0].startswith('NEEDS_SETUP:'))
 async def test_fl_full_name_calls_registry(self):
  with patch.object(e,'_sunbiz_lookup',AsyncMock(return_value=([],[],[]))) as route:
   await e.enrich_prospect({'businessName':'Sample Shop','state':'Florida'})
   route.assert_awaited_once_with({'businessName':'Sample Shop','state':'Florida'})
 async def test_getdocument_and_original_filing(self):
  base='https://search.sunbiz.org/Inquiry/CorporationSearch/'
  detail=base+'SearchResultDetail?id=test'
  links=[{'url':base+'GetDocument?formatType=PDF&id='+str(i),'text':'Report'} for i in range(5)]
  visited=[]
  async def fetch(url):
   visited.append(url)
   if 'SearchResults?' in url:return e.FetchResult(url,'Search',False,links=[{'url':detail,'text':'SAMPLE SHOP LLC'}])
   if url==detail:return e.FetchResult(url,'SAMPLE SHOP LLC\nTitle MGR\nDOE, JANE',False,links=links)
   return e.FetchResult(url,'SAMPLE SHOP LLC contact filing@example.org',True)
  with patch.object(e,'_robots_allows',AsyncMock(return_value=True)),patch.object(e,'_fetch_with_retry',fetch):
   contacts,errors,profiles=await e._sunbiz_lookup({'businessName':'Sample Shop'})
  self.assertIn(links[-1]['url'],visited);self.assertTrue(contacts);self.assertEqual(errors,[])
 async def test_wrong_entity_never_followed(self):
  with patch.object(e,'_robots_allows',AsyncMock(return_value=True)),patch.object(e,'_fetch_with_retry',AsyncMock(return_value=e.FetchResult('https://search.sunbiz.org','',False,links=[{'url':'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?id=x','text':'OTHER SHOP LLC'}]))) as fetch:
   contacts,errors,profiles=await e._sunbiz_lookup({'businessName':'Sample Shop'})
  self.assertEqual(fetch.await_count,1);self.assertEqual(contacts,[]);self.assertTrue(errors[0].startswith('NOT_FOUND:'))

 def test_sunbiz_location_corroboration(self):
  match=e._registry_match({'businessName':'Sample Shop','city':'Hialeah','notes':'[VF-META]{"address":"4121 W 9 CT, Hialeah, FL 33012"}'},'Principal Address\n4121 W 9 CT\nHIALEAH, FL 33012')
  self.assertTrue(match['addressCorroborated']);self.assertEqual(match['matchedZip'],'33012')

if __name__=='__main__': unittest.main()
