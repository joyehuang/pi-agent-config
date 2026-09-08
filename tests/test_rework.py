"""Rework regressions: official CLI shape, orphan legacy run ids, bounded relay recovery."""
import copy,json,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import task_protocol as p
SCHEMA=json.loads((Path(__file__).parent/'fixtures/herdr-agent-schema.json').read_text())

class Rework(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def reg(self):return p.read(self.root/'registry.json')
 def setup_run(self):
  p.register(self.root,'t','fixture','review',[],type='herdr',agent_name='fixture',workspace_id='w1',pane_id='w1:p1')
  p.start_run(self.root,'t','r')
 def response(self,status):
  data=copy.deepcopy(SCHEMA['observed_response']);data['result']['agent']['agent_status']=status
  return data
 def observe(self,data,code=0,**kw):
  response=subprocess.CompletedProcess([],code,json.dumps(data) if not code else '',json.dumps(data) if code else '')
  with patch.object(p.subprocess,'run',return_value=response) as command:
   p.reconcile(self.root,herdr=self.root/'herdr',**kw)
   if command.called:
    args=command.call_args.args[0];self.assertEqual(args,[str(self.root/'herdr'),'agent','get','fixture'])
    self.assertEqual(command.call_args.kwargs['env']['PATH'],str(self.root)+':/usr/bin:/bin')
 def test_official_working_and_compatibility_running_do_not_alert(self):
  self.setup_run();self.assertIn('working',SCHEMA['AgentStatus']['enum'])
  for state in ('working','running'):  # running is a defensive alias, not an observed enum.
   self.observe(self.response(state));t=self.reg()['tasks'][0]
   self.assertEqual(t['status'],'running');self.assertEqual(t['observation'],'running');self.assertFalse(self.reg()['outbox'])
 def test_blocked_recovers_working_done_still_needs_result(self):
  self.setup_run();self.observe(self.response('blocked'));self.assertEqual(self.reg()['tasks'][0]['status'],'blocked')
  self.observe(self.response('working'));self.assertEqual(self.reg()['tasks'][0]['status'],'running')
  self.observe(self.response('done'));self.assertEqual(self.reg()['tasks'][0]['status'],'needs_reconciliation')
  self.assertFalse(any(e['phase']=='ready_for_review' for e in self.reg()['outbox'].values()))
 def test_unknown_notfound_schema_and_identity_errors_are_observations(self):
  self.setup_run()
  cases=[(self.response('unknown'),0,'herdr_unknown'),({'error':{'code':'agent_not_found'}},1,'herdr_not_found'),
   ({'error':{'code':'unavailable'}},1,'herdr_error'),({'result':{'agent_status':'working'}},0,'herdr_schema_unknown')]
  wrong=self.response('working');wrong['result']['agent']['pane_id']='w1:p2';cases.append((wrong,0,'herdr_identity_mismatch'))
  for data,code,observed in cases:
   self.observe(data,code,now=100);t=self.reg()['tasks'][0]
   self.assertEqual(t['status'],'running');self.assertEqual(t['observation'],observed);self.assertFalse(self.reg()['outbox'])
  self.observe(self.response('unknown'),now=2000);self.observe(self.response('unknown'),now=4000)
  self.assertEqual([e['phase'] for e in self.reg()['outbox'].values()],['observation_overdue'])
 def test_runner_pid_birth_precedes_herdr_and_exit_not_guessed(self):
  self.setup_run();identity={'pid':123,'birth':'test birth'}
  with p.transaction(self.root) as reg:reg['tasks'][0]['runs']['r'].update(runner_started=1,pid_identity=identity)
  with patch.object(p,'pid_identity',return_value=identity),patch.object(p.subprocess,'run',side_effect=AssertionError('must not query herdr')):
   p.reconcile(self.root)
  self.assertEqual(self.reg()['tasks'][0]['status'],'running');self.assertFalse(self.reg()['outbox'])
  with patch.object(p,'pid_identity',return_value={'pid':123,'birth':'reused'}):p.reconcile(self.root)
  self.assertEqual(self.reg()['tasks'][0]['observation'],'runner_exit_unknown')
  self.assertEqual(self.reg()['tasks'][0]['status'],'needs_reconciliation')
  # A genuine immutable result outranks both the missing PID and CLI state.
  run=self.reg()['tasks'][0]['runs']['r']
  result=dict(task_id='t',run_id='r',started_at=run['started_at'],exit_code=8,pid_identity=identity,error='worker failed')
  p.commit_result(self.root,'t','r',result)
  with patch.object(p,'pid_identity',side_effect=AssertionError('result must win')):p.reconcile(self.root)
  self.assertEqual(self.reg()['tasks'][0]['status'],'blocked')
 def test_real_running_supervisor_does_not_require_herdr_query(self):
  self.setup_run();gate=self.root/'release'
  worker="import os,json,time,pathlib\ngate=pathlib.Path(%r)\nend=time.time()+8\nwhile not gate.exists() and time.time()<end:time.sleep(0.02)\npathlib.Path(os.environ['TASK_RESULT_PATH']).write_text(json.dumps(dict(task_id='t',run_id='r',reason='batch_finished')))\n" % str(gate)
  wrapper="import sys;sys.path.insert(0,%r);import task_protocol as p;p.run_command(%r,'t','r',%r)" % (str(Path(p.__file__).parent),str(self.root),[sys.executable,'-c',worker])
  proc=subprocess.Popen([sys.executable,'-c',wrapper],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  try:
   deadline=time.time()+5
   while time.time()<deadline:
    if self.reg()['tasks'][0]['runs']['r'].get('pid_identity'):break
    time.sleep(0.01)
   self.assertIsNotNone(self.reg()['tasks'][0]['runs']['r'].get('pid_identity'))
   p.reconcile(self.root,herdr=self.root/'does-not-exist')
   t=self.reg()['tasks'][0];self.assertEqual(t['status'],'running');self.assertEqual(t['observation_evidence']['evidence'],'runner_pid_birth')
   self.assertFalse(self.reg()['outbox'])
  finally:
   gate.write_text('release');out,err=proc.communicate(timeout=10)
  self.assertEqual(proc.returncode,0,err.decode())
  result=p.read(self.root/'runs/t/r/result.json');self.assertEqual(result['exit_code'],0)
  # Empty artifacts still cannot be laundered into successful readiness on exit.
  self.assertEqual(self.reg()['tasks'][0]['status'],'needs_reconciliation')
 def make_legacy(self):
  p.register(self.root,'t','old instruction','review',[])
  with p.transaction(self.root) as reg:
   t=reg['tasks'][0];del t['runs'];t.update(run_id='implementation-1',status='done',pid=123,old_result_path='/historical/reference',observation='old evidence')
  return copy.deepcopy(self.reg()['tasks'][0])
 def inspection(self,decision):
  reference=self.root/'independent-review';reference.write_text('Read-only independent inspection fixture')
  h=p.digest(self.reg()['tasks'][0]);proof=self.root/'inspection.json'
  p.atomic(proof,dict(task_id='t',task_hash=h,decision=decision,findings='Inspected old evidence; no runner exit code can be inferred',references=[str(reference)]))
  return proof,h
 def test_orphan_run_migrate_reconcile_no_replay_and_adopt_cli(self):
  old=self.make_legacy()
  with self.assertRaisesRegex(ValueError,'adopt-legacy'):p.start_run(self.root,'t','r2')
  cli=[sys.executable,str(Path(p.__file__)),'--root',str(self.root)]
  failed=subprocess.run(cli+['start-run','t','--run-id','r2'],capture_output=True,text=True)
  self.assertEqual(failed.returncode,1);self.assertEqual(json.loads(failed.stderr)['error'],'legacy_adoption_required')
  subprocess.run(cli+['migrate'],check=True,capture_output=True)
  p.reconcile(self.root);t=self.reg()['tasks'][0]
  self.assertEqual(t['legacy_snapshot'],old);self.assertEqual(t['run_id'],'implementation-1');self.assertFalse(self.reg()['outbox'])
  proof,h=self.inspection('adopt')
  with self.assertRaises(ValueError):p.resolve_legacy(self.root,'t','adopt',proof,h,'implementation-1')
  subprocess.run(cli+['adopt-legacy','t','--run-id','r2','--evidence',str(proof),'--expected-hash',h],check=True,capture_output=True)
  t=self.reg()['tasks'][0];self.assertEqual(t['status'],'running');self.assertEqual(t['run_id'],'r2');self.assertEqual(t['legacy_snapshot'],old)
  self.assertIsNotNone(p.current_run(t));self.assertNotIn('result_path',t['runs']['r2']);self.assertFalse(self.reg()['outbox'])
  self.assertFalse((self.root/'runs/t/implementation-1/result.json').exists())
 def test_legacy_close_is_explicit_non_success_and_cas_guarded(self):
  old=self.make_legacy();proof,h=self.inspection('close')
  with p.transaction(self.root) as reg:reg['tasks'][0]['new_field']='main update'
  with self.assertRaises(ValueError):p.resolve_legacy(self.root,'t','close',proof,h)
  proof,h=self.inspection('close');p.resolve_legacy(self.root,'t','close',proof,h)
  t=self.reg()['tasks'][0];self.assertEqual(t['status'],'closed_legacy');self.assertEqual(t['old_result_path'],old['old_result_path'])
  p.reconcile(self.root);self.assertFalse(self.reg()['outbox']);self.assertNotIn('report',t)
  with self.assertRaises(ValueError):p.resolve_legacy(self.root,'t','close',proof,h)
  with self.assertRaises(ValueError):p.start_run(self.root,'t','unexpected')
 def test_missing_run_mapping_shapes_and_reference_validation(self):
  self.make_legacy()
  for runs in (None,{}, {'implementation-1':{}}, {'implementation-1':{'started_at':1}}):
   with p.transaction(self.root) as reg:reg['tasks'][0]['runs']=runs
   self.assertTrue(p.is_legacy(self.reg()['tasks'][0]));self.assertEqual(p.probe(self.reg()['tasks'][0],self.root)['observed'],'legacy_unproven')
   with self.assertRaises(ValueError):p.start_run(self.root,'t','r2')
  proof,h=self.inspection('close');data=p.read(proof);data['references']=['/missing/fixture'];p.atomic(proof,data)
  with self.assertRaises(ValueError):p.resolve_legacy(self.root,'t','close',proof,h)
 def test_persisted_unhandled_deadline_not_renewed_and_attention_bounded(self):
  owner=dict(main=True,idle=True,profile='personal',session_id='s',leaf_id='leaf')
  p.enqueue(self.root,'fixture',event={'event_id':'e'});c=p.claim(self.root,owner,now=100)
  self.assertEqual(p.observe_input(self.root,'e',c['claim_id'],'input','s',entry_at=100,now=200)['action'],'defer')
  self.assertEqual(p.read(self.root/'inbox.json')['e']['lease_until'],1900)
  c=p.claim(self.root,owner,now=1901);self.assertEqual(p.observe_input(self.root,'e',c['claim_id'],'input','s',now=1901)['action'],'recover')
  # Lost injection: claim lease expires; same stable recovery remains eligible.
  c=p.claim(self.root,owner,now=2022);self.assertEqual(p.observe_input(self.root,'e',c['claim_id'],'input','s',now=2022)['action'],'recover')
  self.assertEqual(p.observe_input(self.root,'e',c['claim_id'],'input','s','recovery',now=2023)['action'],'attention')
  self.assertIsNone(p.claim(self.root,owner,now=2024))
  self.assertIsNotNone(p.claim(self.root,dict(owner,leaf_id='other-branch'),now=2024))
 def test_actual_qq_receipt_grammar_and_legacy_cli_call_shapes(self):
  import re,os
  script=Path(p.__file__).with_name('notify-agent.py')
  for prefix,source in (([str(script)],'mail-watch'),([sys.executable,str(script)],'qqbot-private-handoff')):
   result=subprocess.run(prefix+['fixture\nmultiline',source,'--root',str(self.root)],capture_output=True,text=True,check=True)
   # Exact consumer regex from dev/qqbot/src/agent-handoff.ts (body omitted).
   match=re.fullmatch(r'queued (\d+-\d+\.json)\s*',result.stdout);self.assertIsNotNone(match)
   self.assertTrue(any(e.get('legacy_receipt')==match[1] and e['source']==source for e in p.read(self.root/'inbox.json').values()))
  result=subprocess.run([str(script),'fixture','--json','--root',str(self.root)],capture_output=True,text=True,check=True)
  self.assertEqual(json.loads(result.stdout)['state'],'success')
  tg=script.with_name('notify-telegram.py')
  for prefix in ([str(tg)],[sys.executable,'-u',str(tg)]):
   result=subprocess.run(prefix+['fixture','--root',str(self.root),'--config',str(self.root/'missing-config')],env=dict(os.environ,NOTIFY_PROFILE='personal'),capture_output=True,text=True)
   self.assertEqual(result.returncode,1);self.assertEqual(json.loads(result.stdout)['state'],'failed')

if __name__=='__main__':unittest.main()
