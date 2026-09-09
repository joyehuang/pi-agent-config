import importlib.util, json, multiprocessing, os, subprocess, sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import task_protocol as p

def writer(root,tid): p.register(root,tid,'fixture','review',[])
def producer(root,eid):p.enqueue(root,'fixture','test',{'event_id':eid,'task_id':'t','run_id':'r'})
def result_producer(root,result):p.commit_result(root,'t','r',result)

class Protocol(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def reg(self):return p.read(self.root/'registry.json')
 def setup_run(self):
  p.register(self.root,'t','fixture','review',[str(self.root/'artifact')],done_marker='DONE_FIXTURE');return p.start_run(self.root,'t','r')
 def result(self,**kw):
  r=dict(task_id='t',run_id='r',started_at=self.reg()['tasks'][0]['runs']['r']['started_at'],pid_identity={'pid':123,'birth':'fixture'},exit_code=0,marker={'seen':True},artifacts=[{'fresh':True,'size':1,'sha256':'fixture'}],reason='goal_complete',error=None);r.update(kw);return r
 def test_double_writer_and_producer(self):
  jobs=[multiprocessing.Process(target=writer,args=(self.root,'t'+str(i))) for i in range(12)]
  for j in jobs:j.start()
  for j in jobs:j.join();self.assertEqual(j.exitcode,0)
  self.assertEqual(len(self.reg()['tasks']),12)
  jobs=[multiprocessing.Process(target=producer,args=(self.root,'e')) for i in range(8)]
  for j in jobs:j.start()
  for j in jobs:j.join();self.assertEqual(j.exitcode,0)
  self.assertEqual(len(p.read(self.root/'inbox.json')),1)
 def test_evidence_matrix(self):
  self.setup_run()
  for fields in ({'artifacts':[]},{'artifacts':[{'fresh':False,'size':2}]},{'exit_code':1},{'pid_identity':None},{'marker':{'seen':False}},{'reason':'read_error'},{'reason':'http_error'},{'reason':'page_budget'},{'reason':'time_budget'},{'error':'bad'},{'exit_code':None}):
   self.assertNotEqual(p.result_status(self.result(**fields)),'ready_for_review')
  self.assertEqual(p.result_status(self.result(reason='batch_finished')),'batch_finished')
 def test_result_immutable_double_event_new_run(self):
  self.setup_run();r=self.result()
  jobs=[multiprocessing.Process(target=result_producer,args=(self.root,r)) for _ in range(6)]
  for j in jobs:j.start()
  for j in jobs:j.join();self.assertEqual(j.exitcode,0)
  self.assertEqual(len(self.reg()['outbox']),1)
  with self.assertRaises(ValueError):p.commit_result(self.root,'t','r',dict(r,exit_code=2))
  p.start_run(self.root,'t','r2');r2=dict(r,run_id='r2',started_at=self.reg()['tasks'][0]['runs']['r2']['started_at']);p.commit_result(self.root,'t','r2',r2)
  self.assertEqual(len(self.reg()['outbox']),2)
  deliveries=[]
  p.drain(self.root,lambda target,event:(deliveries.append((target,event['run_id'])) or {'state':'success'}))
  self.assertEqual(deliveries,[('agent','r2')])
  old=self.reg()['outbox'][p.event_id('t','r','ready_for_review')]
  self.assertTrue(all(d['state'] in ('superseded','internal') for d in old['targets'].values()))
 def test_probe_merge_cas(self):
  self.setup_run()
  def concurrent():
   with p.transaction(self.root) as reg:reg['tasks'][0]['new_field']='preserved'
  p.reconcile(self.root,after_probe=concurrent)
  self.assertEqual(self.reg()['tasks'][0]['new_field'],'preserved');self.assertEqual(self.reg()['tasks'][0]['status'],'starting')
 def test_legacy_no_replay(self):
  p.atomic(self.root/'registry.json',{'tasks':[{'id':'old','status':'done','artifacts':[]},{'id':'reported','status':'reported'}]})
  p.reconcile(self.root);r=self.reg();self.assertEqual(r['tasks'][0]['status'],'needs_reconciliation');self.assertFalse(r.get('outbox'));self.assertEqual(r['tasks'][1]['status'],'reported')
 def test_notify_failure_recovery_unknown(self):
  self.setup_run();p.commit_result(self.root,'t','r',self.result());calls=[]
  def fail(target,event):calls.append(target);return {'state':'failed'}
  p.drain(self.root,fail,now=100);self.assertEqual(len(calls),1)
  p.drain(self.root,fail,now=101);self.assertEqual(len(calls),1)
  p.drain(self.root,lambda t,e:{'state':'unknown' if t=='telegram' else 'success'},now=200)
  p.drain(self.root,fail,now=9999);self.assertEqual(len(calls),1)
 def test_claim_crash_busy_owner_and_lease(self):
  p.enqueue(self.root,'x',event={'event_id':'e','route':{'profile':'personal','session_id':'main','target':{'chatId':1,'threadId':2}}})
  o=dict(main=True,idle=True,profile='personal',session_id='main',target={'chatId':1,'threadId':2},pid=1)
  for wrong in ({'main':False},{'idle':False},{'session_id':'other'},{'target':{'chatId':1,'threadId':3}},{'profile':'other'}):self.assertIsNone(p.claim(self.root,dict(o,**wrong),now=100))
  c=p.claim(self.root,o,now=100);self.assertIsNotNone(c);self.assertIsNone(p.claim(self.root,o,now=101));c2=p.claim(self.root,o,now=221);self.assertNotEqual(c['claim_id'],c2['claim_id'])
  with self.assertRaises(ValueError):p.receipt(self.root,'e',c['claim_id'],'enqueued')
  p.receipt(self.root,'e',c2['claim_id'],'enqueued','session');self.assertEqual(p.read(self.root/'inbox.json')['e']['state'],'enqueued')
  c3=p.claim(self.root,o,now=time.time()+2000);self.assertIsNotNone(c3)
  evidence=self.root/'review-evidence';evidence.write_text('handled fixture')
  with self.assertRaises(ValueError):p.receipt(self.root,'e',c3['claim_id'],'handled','missing-file')
  p.receipt(self.root,'e',c3['claim_id'],'handled',evidence);self.assertIsNone(p.claim(self.root,o,now=time.time()+4000))
 def test_missing_herdr_pid_reuse_done_overdue_blocked_recovery(self):
  self.setup_run()
  with p.transaction(self.root) as r:r['tasks'][0].update(type='herdr',agent_name='a',workspace_id='w',pane_id='p');r['tasks'][0]['runs']['r']['started_at']-=p.START_GRACE+1
  self.assertEqual(p.probe(self.reg()['tasks'][0],self.root,self.root/'missing')['observed'],'herdr_error')
  p.reconcile(self.root,herdr=self.root/'missing');self.assertEqual(self.reg()['tasks'][0]['status'],'starting');self.assertEqual(self.reg()['tasks'][0]['observation'],'herdr_error')
  p.commit_result(self.root,'t','r',self.result())
  p.reconcile(self.root,now=time.time()+3600);p.reconcile(self.root,now=time.time()+7200)
  self.assertEqual(sum(e['phase']=='review_overdue' for e in self.reg()['outbox'].values()),1)
  proof=self.root/'review';proof.write_text('checked')
  with self.assertRaises(ValueError):p.report(self.root,'t','r',{'status':'success','target':1,'message_id':2})
  p.verify(self.root,'t','r',proof)
  with self.assertRaises(ValueError):p.report(self.root,'t','r',{})
  target={'chatId':1};body_hash=p.delivery_hash('验收结果')
  p.prepare_report(self.root,'t','r',body_hash,target)
  known={'state':'success','target':target,'message_id':2,'event_id':'final','at':time.time(),'hash':'unrelated'}
  p.atomic(self.root/'telegram-receipts.json',{'fixture':known})
  receipt={'status':'success','target':target,'message_id':2,'event_id':'final'}
  with self.assertRaises(ValueError):p.report(self.root,'t','r',receipt)
  known['hash']=body_hash;known['at']=1;p.atomic(self.root/'telegram-receipts.json',{'fixture':known})
  with self.assertRaises(ValueError):p.report(self.root,'t','r',receipt)
  known['at']=time.time();p.atomic(self.root/'telegram-receipts.json',{'fixture':known})
  p.report(self.root,'t','r',receipt);self.assertEqual(self.reg()['tasks'][0]['status'],'reported')
  deliveries=[]
  p.drain(self.root,lambda target,event:(deliveries.append(target) or {'state':'success'}))
  self.assertEqual(deliveries,[])
  self.assertTrue(all(d['state'] in ('superseded','internal') for e in self.reg()['outbox'].values() for d in e['targets'].values()))
 def test_real_runner_success_and_old_artifact(self):
  self.setup_run();code="import os,json,pathlib; pathlib.Path(%r).write_text('new');pathlib.Path(os.environ['TASK_RESULT_PATH']).write_text(json.dumps(dict(task_id=os.environ['TASK_ID'],run_id=os.environ['TASK_RUN_ID'],reason='goal_complete')));print('DONE_FIXTURE')" % str(self.root/'artifact')
  p.run_command(self.root,'t','r',[sys.executable,'-c',code]);self.assertEqual(self.reg()['tasks'][0]['status'],'ready_for_review')
  p.start_run(self.root,'t','r2');code2="import os,json,pathlib;pathlib.Path(os.environ['TASK_RESULT_PATH']).write_text(json.dumps(dict(task_id=os.environ['TASK_ID'],run_id=os.environ['TASK_RUN_ID'],reason='goal_complete')));print('DONE_FIXTURE')"
  p.run_command(self.root,'t','r2',[sys.executable,'-c',code2]);self.assertEqual(self.reg()['tasks'][0]['status'],'needs_reconciliation')
 def test_truncation_keeps_evidence_private(self):
  p.enqueue(self.root,'x'*1000,event={'event_id':'e','task_id':'t','run_id':'r','result_path':'/private/result'})
  e=p.read(self.root/'inbox.json')['e'];self.assertEqual(len(e['text']),500);self.assertEqual(e['result_path'],'/private/result');self.assertEqual((self.root/'inbox.json').stat().st_mode&0o777,0o600)

class Telegram(unittest.TestCase):
 def test_transport_contract(self):
  spec=importlib.util.spec_from_file_location('notify_tg',Path(p.__file__).with_name('notify-telegram.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  import types,itertools
  ticks=itertools.count(1000,100)
  m.time=types.SimpleNamespace(time=lambda:next(ticks))
  with tempfile.TemporaryDirectory() as d:
   cfg=Path(d)/'cfg';self.assertEqual(m.send('x',cfg)['state'],'failed');cfg.write_text(json.dumps({'profiles':{'personal':{'botToken':'FAKE','allowedUserId':1}}}))
   class R:
    status=200
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def read(self):return b'{"ok":true,"result":{"message_id":7}}'
   self.assertEqual(m.send('x',cfg,opener=lambda *a,**k:R())['message_id'],7)
   for payload,state in ((b'{"ok":false}','failed'),(b'{"ok":true,"result":{}}','unknown'),(b'not json','unknown')):
    class Bad(R):
     def read(self):return payload
    self.assertEqual(m.send('x',cfg,opener=lambda *a,**k:Bad())['state'],state)
   for code,state in ((400,'failed'),(429,'failed'),(500,'unknown')):
    def http(*a,**k):raise m.urllib.error.HTTPError('https://invalid.test/FAKE',code,'fixture',{},None)
    self.assertEqual(m.send('x',cfg,opener=http)['state'],state)
   calls=[]
   def unknown(*a,**k):calls.append(1);raise TimeoutError()
   self.assertEqual(m.durable_send(d,'e','x',cfg,'personal',unknown)['state'],'unknown')
   m.durable_send(d,'e','x',cfg,'personal',unknown);self.assertEqual(len(calls),1)

 def test_cooldown_and_bridge_reply_priority(self):
  import io,types
  spec=importlib.util.spec_from_file_location('notify_tg',Path(p.__file__).with_name('notify-telegram.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  clock=[1000.0];m.time=types.SimpleNamespace(time=lambda:clock[0]);calls=[]
  with tempfile.TemporaryDirectory() as d:
   cfg=Path(d)/'cfg';cfg.write_text(json.dumps({'profiles':{'personal':{'botToken':'FAKE','allowedUserId':1}}}))
   def limited(*a,**k):
    calls.append(1)
    raise m.urllib.error.HTTPError('https://invalid.test',429,'limited',{},io.BytesIO(b'{"parameters":{"retry_after":476}}'))
   r=m.send('x',cfg,opener=limited);self.assertEqual(r['retry_at'],1478)
   clock[0]=1400;self.assertEqual(m.send('x',cfg,opener=limited)['reason'],'local_cooldown');self.assertEqual(len(calls),1)
   directory,key=m.cooldown_guard(cfg,'personal','FAKE',1);out=directory/'outbox';out.mkdir()
   f=out/(key+'-fixture.json');f.write_text(json.dumps({'status':'rate-limited','retryAt':1900000}))
   clock[0]=1500;self.assertEqual(m.send('x',cfg,opener=limited)['reason'],'local_cooldown');self.assertEqual(len(calls),1)
   f.write_text(json.dumps({'status':'held-retry-deadline'}))
   m.send('x',cfg,opener=limited);self.assertEqual(len(calls),2)

class FaultInjection(unittest.TestCase):
 setUp=Protocol.setUp
 tearDown=Protocol.tearDown
 reg=Protocol.reg
 setup_run=Protocol.setup_run
 result=Protocol.result
 # Inherits fixture helpers; additional fault windows below exercise the protocol.
 def test_pid_reuse_and_herdr_terminal_not_marker_proof(self):
  self.setup_run()
  with p.transaction(self.root) as r:r['tasks'][0]['runs']['r']['pid_identity']={'pid':123,'birth':'old'}
  original=p.pid_identity;p.pid_identity=lambda pid:{'pid':123,'birth':'new'}
  try:self.assertEqual(p.probe(self.reg()['tasks'][0],self.root)['observed'],'pid_missing_or_reused')
  finally:p.pid_identity=original
  fake=self.root/'herdr';fake.write_text('#!/bin/sh\nprintf \'{"result":{"type":"agent_info","agent":{"agent_status":"done","workspace_id":"w","pane_id":"p","prompt":"DONE_FIXTURE"}}}\\n\'\n');fake.chmod(0o700)
  with p.transaction(self.root) as r:r['tasks'][0].update(type='herdr',agent_name='a',workspace_id='w',pane_id='p');r['tasks'][0]['runs']['r']['started_at']-=p.START_GRACE+1
  obs=p.probe(self.reg()['tasks'][0],self.root,fake);self.assertEqual(obs['observed'],'herdr_done_unverified')
  p.reconcile(self.root,herdr=fake);self.assertEqual(self.reg()['tasks'][0]['status'],'needs_reconciliation')
 def test_outbox_crash_lease_and_duplicate_delivery(self):
  self.setup_run();p.commit_result(self.root,'t','r',self.result())
  with p.transaction(self.root) as reg:
   for e in reg['outbox'].values():
    for receipt in e['targets'].values():receipt.update(state='sending',lease_until=1,claim_id='dead')
  calls=[]
  p.drain(self.root,lambda target,event:(calls.append(target) or {'state':'success'}),now=100)
  self.assertEqual(calls,['agent']);self.assertEqual(next(iter(self.reg()['outbox'].values()))['targets']['telegram']['state'],'unknown')
 def test_blocked_new_run_recovery_and_rework_limit(self):
  self.setup_run();p.commit_result(self.root,'t','r',self.result(reason='read_error'));self.assertEqual(self.reg()['tasks'][0]['status'],'blocked')
  proof=self.root/'review';proof.write_text('review rejected')
  for i in range(3):
   rid='next'+str(i);p.start_run(self.root,'t',rid)
   r=self.result();r.update(run_id=rid,started_at=self.reg()['tasks'][0]['runs'][rid]['started_at'])
   p.commit_result(self.root,'t',rid,r);p.verify(self.root,'t',rid,proof,False)
  self.assertEqual(self.reg()['tasks'][0]['status'],'blocked');self.assertEqual(self.reg()['tasks'][0]['iterations'],3)
  with self.assertRaises(ValueError):p.start_run(self.root,'t','too-many')
 def test_metadata_writer_and_legacy_pending_migration(self):
  self.setup_run();t=self.reg()['tasks'][0];h=p.digest(t)
  p.update_metadata(self.root,'t',{'acceptance':'new'},h)
  with self.assertRaises(ValueError):p.update_metadata(self.root,'t',{'acceptance':'stale'},h)
  spool=self.root/'old';spool.mkdir();(spool/'a.json').write_text(json.dumps({'text':'legacy fixture'}));(spool/'b.json.done').write_text('{}')
  p.migrate_spool(self.root,spool);p.migrate_spool(self.root,spool)
  self.assertEqual(len(p.read(self.root/'inbox.json')),1);self.assertTrue((spool/'a.json').exists())
 def test_wrong_run_and_corrupt_result_never_ready(self):
  self.setup_run();result=self.result(run_id='other')
  dest=self.root/'runs/t/r/result.json';p.atomic(dest,result)
  self.assertEqual(p.probe(self.reg()['tasks'][0],self.root)['observed'],'result_identity_mismatch')
  dest.write_text('not json')
  p.reconcile(self.root);self.assertEqual(self.reg()['tasks'][0]['status'],'needs_reconciliation')
 def test_empty_artifact_and_nonzero_real_runner(self):
  self.setup_run()
  code="import os,json,pathlib;pathlib.Path(%r).write_text('');pathlib.Path(os.environ['TASK_RESULT_PATH']).write_text(json.dumps(dict(task_id='t',run_id='r',reason='goal_complete')));print('DONE_FIXTURE');raise SystemExit(4)" % str(self.root/'artifact')
  result=Path(p.run_command(self.root,'t','r',[sys.executable,'-c',code]))
  self.assertEqual(p.read(result)['exit_code'],4);self.assertFalse(p.read(result)['artifacts'][0]['fresh'])
  self.assertEqual(self.reg()['tasks'][0]['status'],'blocked')
 def test_runner_launch_error_immutable_evidence(self):
  self.setup_run();dest=p.run_command(self.root,'t','r',[str(self.root/'missing-command')])
  r=p.read(dest);self.assertIsNone(r['exit_code']);self.assertEqual(r['reason'],'launch_error')
  self.assertNotEqual(self.reg()['tasks'][0]['status'],'ready_for_review')

if __name__=='__main__':unittest.main(verbosity=2)
