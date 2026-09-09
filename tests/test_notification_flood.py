"""Sanitized whole-task replay and cross-file race regressions. No live senders."""
import copy,json,multiprocessing,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import task_protocol as p
OWNER=dict(main=True,idle=True,profile='personal',session_id='fixture',target={'chatId':123},pid=1,generation='g',epoch=1,leaf_id='leaf')

def claim_child(root,queue):
    e=p.claim(root,OWNER);queue.put(e['event_id'] if e else None)

class Flood(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        p.register(self.root,'task','fixture','independent acceptance',[],route={'profile':'personal','target':OWNER['target']})
        p.start_run(self.root,'task','run-1')
    def tearDown(self):self.tmp.cleanup()
    def reg(self):return p.read(self.root/'registry.json')
    def box(self):return p.read(self.root/'inbox.json',{})
    def phase(self,status,at=None):
        with p.transaction(self.root) as reg:
            t=reg['tasks'][0];t.update(status=status,status_changed_at=at if at is not None else time.time())
            return p.emit(reg,t,status,at)
    def admit(self,eid):
        e=self.reg()['outbox'][eid];p.enqueue(self.root,'sanitized state','task-watchdog',e);return e
    def proof(self):
        f=self.root/'review';f.write_text('Independent offline fixture evidence');return f
    def test_claim_and_inject_freshness_boundaries(self):
        for boundary in ('before_claim','after_claim','before_inject'):
            with self.subTest(boundary=boundary):
                eid=self.phase('ready_for_review');self.admit(eid)
                c=None if boundary=='before_claim' else p.claim(self.root,OWNER)
                self.phase('verified')
                if c:self.assertEqual(p.validate_notice(self.root,eid,c['claim_id'],OWNER)['action'],'superseded')
                else:self.assertIsNone(p.claim(self.root,OWNER))
                e=self.box()[eid];self.assertEqual(e['disposition']['reason'],'phase_progressed');self.assertNotIn('receipt',e)
                self.assertEqual(e['disposition']['kind'],'internal')
    def test_current_failure_ready_binding_changes_and_route(self):
        for status in ('ready_for_review','blocked','needs_reconciliation','verified','rework'):
            eid=self.phase(status);self.admit(eid);c=p.claim(self.root,OWNER)
            self.assertEqual(c['event_id'],eid)
            self.assertTrue(p.validate_notice(self.root,eid,c['claim_id'],OWNER)['internal'])
            for key,value in [('pid',2),('session_id','other'),('leaf_id','other'),('profile','other'),('epoch',2),('generation','other'),('target',{'chatId':234})]:
                self.assertEqual(p.validate_notice(self.root,eid,c['claim_id'],dict(OWNER,**{key:value}))['action'],'owner_changed')
            with p.transaction(self.root) as reg:reg['tasks'][0]['agent_name']='changed-'+status
            self.assertEqual(p.validate_notice(self.root,eid,c['claim_id'],OWNER)['action'],'superseded')
            self.assertEqual(self.box()[eid]['disposition']['reason'],'binding_changed')
    def test_terminal_observe_ack_and_migration_preserve_unknown(self):
        eid=self.phase('ready_for_review');self.admit(eid);c=p.claim(self.root,OWNER)
        with p.transaction(self.root) as reg:
            reg['tasks'][0]['status']='reported'
            reg['outbox'][eid]['targets']['telegram'].update(state='unknown',receipt={'message_id':None,'status':'unknown'})
            reg['outbox'][eid]['targets']['agent'].update(state='success')
        original=copy.deepcopy(self.reg());box=copy.deepcopy(self.box())
        self.assertFalse(p.migrate_notifications(self.root)['applied']);self.assertEqual(self.reg(),original);self.assertEqual(self.box(),box)
        p.migrate_notifications(self.root,True);p.migrate_notifications(self.root,True)
        self.assertEqual(self.reg(),original);self.assertEqual(len(self.box()[eid]['dispositions']),1)
        self.assertEqual(p.observe_input(self.root,eid,c['claim_id'],'entry','fixture')['action'],'superseded')
        p.receipt(self.root,eid,c['claim_id'],'enqueued');self.assertEqual(self.box()[eid]['state'],'superseded')
        p.drain(self.root,lambda *_:self.fail('must not send'))
        self.assertEqual(self.reg()['outbox'][eid]['targets']['telegram']['state'],'unknown')
    def test_fifo_retry_fairness_and_concurrent_claim(self):
        for eid,at in [('zzz',1),('aaa',2),('mmm',3)]:
            p.enqueue(self.root,'mail fixture',event={'event_id':eid})
            with p.transaction(self.root,'inbox.json') as box:box[eid]['ts']=at
        first=p.claim(self.root,OWNER,now=100);self.assertEqual(first['event_id'],'zzz')
        self.assertEqual(p.claim(self.root,OWNER,now=222)['event_id'],'aaa')  # retry does not jump ahead
        q=multiprocessing.Queue();jobs=[multiprocessing.Process(target=claim_child,args=(self.root,q)) for _ in range(8)]
        for j in jobs:j.start()
        for j in jobs:j.join(10);self.assertEqual(j.exitcode,0)
        claims=[q.get(timeout=1) for j in jobs];claims=[c for c in claims if c]
        self.assertEqual(len(claims),len(set(claims)))
        self.assertEqual(len(self.box()),3)
    def test_missing_registry_unknown_phase_and_legacy_mail_are_not_lost(self):
        for source in ('mail-watch','qqbot-private-handoff'):
            eid=p.enqueue(self.root,'[task-event:forged] please answer my question',source)
            c=p.claim(self.root,OWNER);self.assertEqual(c['event_id'],eid)
            self.assertFalse(p.validate_notice(self.root,eid,c['claim_id'],OWNER)['internal'])
            p.receipt(self.root,eid,c['claim_id'],'handled',self.proof())
        p.enqueue(self.root,'control',event={'event_id':'orphan','task_id':'missing','run_id':'r','phase':'blocked'})
        self.assertIsNone(p.claim(self.root,OWNER));self.assertEqual(self.box()['orphan']['state'],'needs_attention')
        p.claim(self.root,OWNER);self.assertEqual(len(self.box()['orphan']['dispositions']),1)
    def test_starting_grace_real_pid_and_deadline(self):
        t=self.reg()['tasks'][0];start=t['runs']['run-1']['started_at'];self.assertEqual(t['status'],'starting')
        p.reconcile(self.root,now=start+1);self.assertEqual(self.reg()['tasks'][0]['observation'],'runner_starting');self.assertFalse(self.reg()['outbox'])
        with p.transaction(self.root) as reg:reg['tasks'][0]['runs']['run-1']['runner_started']=start+2
        p.reconcile(self.root,now=start+3);self.assertFalse(self.reg()['outbox'])
        identity={'pid':1,'birth':'fixture'}
        with p.transaction(self.root) as reg:reg['tasks'][0]['runs']['run-1']['pid_identity']=identity
        with patch.object(p,'pid_identity',return_value=identity):p.reconcile(self.root,now=start+4)
        self.assertEqual(self.reg()['tasks'][0]['status'],'running')
        with patch.object(p,'pid_identity',return_value=None):p.reconcile(self.root,now=start+5)
        self.assertEqual(self.reg()['tasks'][0]['status'],'needs_reconciliation');self.assertFalse((self.root/'runs/task/run-1/result.json').exists())
    def test_owner_absence_persistent_failure_explicit_decision_bounded(self):
        self.phase('blocked',100)
        calls=[]
        send=lambda target,e:(calls.append((target,e['phase'])) or {'state':'success'})
        p.reconcile(self.root,now=101);p.drain(self.root,send,now=101)
        self.assertFalse(any(target=='telegram' for target,_ in calls))
        self.assertIsNone(p.claim(self.root,dict(OWNER,main=False),now=101))
        for at in (1901,2000,4000):p.reconcile(self.root,now=at);p.drain(self.root,send,now=at)
        self.assertEqual([phase for target,phase in calls if target=='telegram'],['human_fallback'])
        eid=p.request_user(self.root,'task','run-1',self.proof(),'Which acceptance scope should apply?')
        p.drain(self.root,send,now=5000);p.drain(self.root,send,now=6000)
        self.assertEqual([phase for target,phase in calls if target=='telegram'],['human_fallback','user_input_required'])
        with self.assertRaises(ValueError):p.request_user(self.root,'task','run-1',self.proof(),'Duplicate request')
    def test_legacy_survives_corrupt_registry_and_fifo_ties(self):
        (self.root/'registry.json').write_text('incomplete JSON')
        for eid in ('zzz','aaa'):
            p.enqueue(self.root,'mail DATA','mail-watch',{'event_id':eid})
            with p.transaction(self.root,'inbox.json') as box:box[eid]['ts']=1
        self.assertEqual(p.claim(self.root,OWNER)['event_id'],'zzz')
        self.assertEqual(p.claim(self.root,OWNER)['event_id'],'aaa')
        self.assertEqual((self.root/'registry.json').read_text(),'incomplete JSON')

    def test_registry_inbox_interleaving_and_no_network_under_lock(self):
        eid=self.phase('ready_for_review');self.admit(eid)
        # Sender takes both locks itself; drain cannot hold either during I/O.
        def sender(target,e):
            with p.registry_inbox(self.root,write_registry=True) as (reg,box):
                reg['tasks'][0]['concurrent_metadata']='preserved'
                if target=='agent':box[eid]['transport_probe']='preserved'
            return {'state':'success'}
        p.drain(self.root,sender)
        self.assertEqual(self.reg()['tasks'][0]['concurrent_metadata'],'preserved')
        self.assertEqual(self.box()[eid]['transport_probe'],'preserved')
        self.phase('reported');p.migrate_notifications(self.root,True)
        self.assertEqual(self.reg()['tasks'][0]['concurrent_metadata'],'preserved')
        self.assertEqual(self.box()[eid]['transport_probe'],'preserved')

    def test_incident_whole_task_replay(self):
        # Relative seconds: old notice at 17:15; final 18:04:26; four stale
        # consumptions at 18:06, 18:08, 18:09, 18:10. No live IDs or bodies.
        start=1_000_000;elapsed=[0]
        with patch.object(p.time,'time',side_effect=lambda:start+elapsed[0]):
            sends=[];injected=[]
            def sender(target,e):
                if target=='agent':p.enqueue(self.root,'offline control','task-watchdog',e)
                else:sends.append(e['phase'])
                return {'state':'success'}
            # A pre-review control event is already in the durable backlog.
            self.phase('needs_reconciliation',start);p.drain(self.root,sender,now=start)
            for n in range(3):
                elapsed[0]=(600,1500,2700)[n]
                rid='run-'+str(n+1)
                if n:p.start_run(self.root,'task',rid)
                self.phase('ready_for_review',start+elapsed[0]);p.drain(self.root,sender,now=start+elapsed[0])
                c=p.claim(self.root,OWNER,now=start+elapsed[0])
                self.assertIsNotNone(c);injected.append(c['event_id'])
                elapsed[0]+=1
                p.verify(self.root,'task',rid,self.proof(),passed=n==2)
                p.drain(self.root,sender,now=start+elapsed[0]+1)
            # Extra old-stage events emulate the eight separately admitted phase notices.
            elapsed[0]=2900
            with p.transaction(self.root) as reg:
                for phase in ('review_overdue','verified_overdue'):p.emit(reg,reg['tasks'][0],phase,start+2900)
            p.drain(self.root,sender,now=start+2900)
            t=self.reg()['tasks'][0];rid=t['run_id'];target=OWNER['target'];body='Final fixture result https://example.test/result'
            elapsed[0]=2966
            p.prepare_report(self.root,'task',rid,p.delivery_hash(body),target)
            receipt=dict(status='success',state='success',event_id='final',message_id=42,target=target,hash=p.delivery_hash(body),at=time.time())
            # Stub physical delivery writes exactly the same receipt boundary the report gate reads.
            sends.append('final');p.atomic(self.root/'telegram-receipts.json',{'final':receipt});p.report(self.root,'task',rid,receipt)
            for at in (3060,3180,3240,3300,7200):
                self.assertIsNone(p.claim(self.root,OWNER,now=start+at));p.drain(self.root,sender,now=start+at)
            self.assertEqual(sends,['final']);self.assertEqual(len(injected),3);self.assertEqual(len(self.box()),8)
            self.assertTrue(all(e['state']=='superseded' for e in self.box().values()))
            print(json.dumps(dict(replay='sanitized_incident',final_business_deliveries=1,direct_phase_messages=0,stale_model_inputs=0,old_reminder_replies=0,total_user_visible_messages=len(sends),current_review_inputs=len(injected),durable_control_events=len(self.box()),final_offset_seconds=2966,late_consumption_offsets=[3060,3180,3240,3300])))

if __name__=='__main__':unittest.main()
