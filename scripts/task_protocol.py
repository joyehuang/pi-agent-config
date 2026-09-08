#!/usr/bin/env python3
"""Private, cooperating-writer task/run evidence and durable target receipts.
No network on import. External writers ignoring flock remain outside the protocol.
"""
import argparse, contextlib, copy, fcntl, hashlib, json, os, re, subprocess, sys, tempfile, time, uuid
from pathlib import Path

ROOT = Path.home() / '.config/agent-tasks'
HERDR = Path.home() / '.local/bin/herdr'

def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()).hexdigest()

def delivery_hash(text):
    # Match the bridge's JSON.stringify(text) UTF-8 ledger, including Chinese.
    return digest(json.dumps(text, ensure_ascii=False, separators=(',', ':')).encode())

def ident(value):
    if value in ('.','..') or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', value):
        raise ValueError('invalid identifier')
    return value

def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return copy.deepcopy(default)

def atomic(path, value, immutable=False):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.write-')
    try:
        with os.fdopen(fd, 'w') as f:
            os.fchmod(f.fileno(), 0o600); json.dump(value, f, ensure_ascii=False, sort_keys=True)
            f.flush(); os.fsync(f.fileno())
        if immutable:
            os.link(tmp, path)
        else:
            os.replace(tmp, path)
        d = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(d)
        finally: os.close(d)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

@contextlib.contextmanager
def transaction(root=ROOT, filename='registry.json'):
    root = Path(root); root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(root / (filename + '.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = read(root / filename, {'tasks': [], 'outbox': {}, 'revision': 0} if filename == 'registry.json' else {})
        before = digest(data)
        yield data
        if digest(data) != before:
            if filename == 'registry.json': data['revision'] = data.get('revision', 0) + 1
            atomic(root / filename, data)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN); os.close(lock)

def task(reg, tid):
    return next(t for t in reg['tasks'] if t['id'] == tid)

def register(root, tid, instruction, acceptance, artifacts, route=None, **fields):
    ident(tid)
    if not acceptance: raise ValueError('acceptance required')
    with transaction(root) as reg:
        if any(t['id'] == tid for t in reg['tasks']): raise ValueError('task exists')
        reg['tasks'].append(dict(id=tid, instruction=instruction, acceptance=acceptance,
          artifacts=artifacts, status='registered', iterations=0, runs={}, route=route or {'profile':'personal'}, **fields))

def summary(path):
    p = Path(path).expanduser()
    try:
        data = p.read_bytes(); st = p.stat()
        return dict(path=str(p), size=len(data), mtime_ns=st.st_mtime_ns, sha256=digest(data))
    except (OSError, ValueError): return dict(path=str(p), error='unreadable')

def pid_identity(pid):
    if not pid: return None
    try:
        p = subprocess.run(['/bin/ps', '-p', str(int(pid)), '-o', 'lstart='], capture_output=True, text=True, timeout=5)
        return {'pid': int(pid), 'birth': p.stdout.strip()} if p.returncode == 0 and p.stdout.strip() else None
    except (OSError, subprocess.SubprocessError, ValueError): return None

def start_run(root, tid, run_id=None):
    rid = ident(run_id or uuid.uuid4().hex)
    with transaction(root) as reg:
        t = task(reg, tid)
        if t.get('status') == 'reported': raise ValueError('reported task requires a new task')
        if t.get('iterations',0)>2: raise ValueError('rework limit exhausted; needs an explicit new task')
        runs = t.setdefault('runs', {})
        if rid in runs: raise ValueError('run exists')
        if t.get('run_id') and t['runs'][t['run_id']].get('result_path') is None and t['status'] == 'running':
            raise ValueError('active run requires reconciliation before replacement')
        runs[rid] = {'run_id': rid, 'started_at': time.time(), 'baseline': [summary(p) for p in t.get('artifacts', [])]}
        t.update(run_id=rid, status='running', status_changed_at=time.time())
        for key in ('verification','report','report_intent','attention_required'): t.pop(key, None)
    return rid

def event_id(tid, rid, phase): return digest([tid, rid, phase])

def emit(reg, t, phase, now=None):
    rid = t.get('run_id', 'legacy'); eid = event_id(t['id'], rid, phase)
    reg.setdefault('outbox', {}).setdefault(eid, dict(event_id=eid, task_id=t['id'], run_id=rid,
      phase=phase, result_path=t.get('runs', {}).get(rid, {}).get('result_path'), route=t.get('route', {'profile':'personal'}),
      created_at=now or time.time(), targets={k: {'state':'pending', 'attempts':0, 'next_at':0} for k in ('agent','telegram')}))
    return eid

def result_status(r):
    if r.get('exit_code') is None: return 'needs_reconciliation'
    if r['exit_code'] != 0 or r.get('error'): return 'blocked'
    if r.get('reason') in ('read_error','http_error','error','time_budget','page_budget','budget_exhausted'): return 'blocked'
    if not r.get('marker', {}).get('seen') or not r.get('pid_identity'): return 'needs_reconciliation'
    arts = r.get('artifacts', [])
    if not arts or not all(a.get('fresh') and a.get('size', 0) > 0 and a.get('sha256') for a in arts): return 'needs_reconciliation'
    if r.get('reason') == 'batch_finished': return 'batch_finished'
    return 'ready_for_review' if r.get('reason') == 'goal_complete' else 'needs_reconciliation'

def commit_result(root, tid, rid, r):
    with transaction(root) as reg:
        t = task(reg, tid); run = t['runs'][rid]
        if r['task_id'] != tid or r['run_id'] != rid or r['started_at'] != run['started_at']:
            raise ValueError('result identity mismatch')
        path = Path(root)/'runs'/ident(tid)/ident(rid)/'result.json'
        old = read(path)
        if old is None: atomic(path, r, immutable=True)
        elif old != r: raise ValueError('immutable result conflict')
        run['result_path'] = str(path)
        if t.get('run_id') == rid and t['status'] not in ('verified','reported'):
            status = result_status(r)
            if t['status'] != status: t.update(status=status, status_changed_at=time.time())
            emit(reg, t, status)
    return str(path)

def run_command(root, tid, rid, command):
    with transaction(root) as reg:
        t = task(reg, tid); run = t['runs'][rid]
        if run.get('runner_started'): raise ValueError('runner already started')
        run['runner_started'] = time.time(); run['command_hash'] = digest(command)
        snapshot = copy.deepcopy(t)
    run = snapshot['runs'][rid]
    business_path = Path(root)/'runs'/tid/rid/'business.json'
    business_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if business_path.exists(): raise ValueError('business result already exists')
    env = dict(os.environ, TASK_ID=tid, TASK_RUN_ID=rid, TASK_RESULT_PATH=str(business_path))
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, umask=0o077)
    except (OSError,ValueError) as error:
        return commit_result(root,tid,rid,dict(task_id=tid,run_id=rid,started_at=run['started_at'],
          finished_at=time.time(),pid_identity=None,exit_code=None,
          marker={'expected':snapshot.get('done_marker',''),'seen':False,'source':'runner_stdout_exact_line'},
          artifacts=[dict(a,fresh=False) for a in run['baseline']],reason='launch_error',
          error=type(error).__name__,stdout_hash=digest(b''),stderr_hash=digest(b'')))
    identity = pid_identity(proc.pid)
    with transaction(root) as reg:
        task(reg,tid)['runs'][rid]['pid_identity'] = identity
    out, err = proc.communicate()
    try: business = read(business_path, {})
    except (ValueError,OSError): business = {'error':'invalid_business_result'}
    if business.get('task_id') != tid or business.get('run_id') != rid:
        business = {'error':'missing_or_mismatched_business_result'}
    artifacts=[]
    for before in run['baseline']:
        after=summary(before['path'])
        after['fresh'] = bool(after.get('size',0)>0 and after.get('mtime_ns',0)>=int(run['started_at']*1e9)
                              and after.get('sha256') != before.get('sha256'))
        artifacts.append(after)
    marker = snapshot.get('done_marker','')
    r=dict(task_id=tid, run_id=rid, started_at=run['started_at'], finished_at=time.time(),
      pid_identity=identity, exit_code=proc.returncode,
      marker={'expected':marker,'seen':bool(marker and marker in out.decode(errors='replace').splitlines()),'source':'runner_stdout_exact_line'},
      artifacts=artifacts, reason=business.get('reason','unknown'), error=business.get('error'),
      stdout_hash=digest(out), stderr_hash=digest(err))
    return commit_result(root,tid,rid,r)

def probe(t, root, herdr=HERDR):
    rid=t.get('run_id'); run=t.get('runs',{}).get(rid,{})
    if not rid: return {'observed':'legacy_unproven'}
    try: r=read(Path(root)/'runs'/t['id']/rid/'result.json')
    except (ValueError,OSError): return {'observed':'result_unreadable'}
    if r:
        if (not isinstance(r,dict) or r.get('task_id')!=t['id'] or r.get('run_id')!=rid
            or r.get('started_at')!=run.get('started_at')):
            return {'observed':'result_identity_mismatch'}
        return {'result':r}
    if t.get('type')=='herdr':
        if not all(t.get(k) for k in ('agent_name','workspace_id','pane_id')): return {'observed':'missing_herdr_identity'}
        try:
            p=subprocess.run([str(herdr),'agent','get',t['agent_name']],capture_output=True,text=True,timeout=20,
              env=dict(os.environ, PATH=str(Path(herdr).parent)+':/usr/bin:/bin'))
            data=json.loads(p.stdout)
            if p.returncode or data.get('ok') is False: return {'observed':'herdr_error'}
            # Terminal text can echo a prompt/marker: never establish success from it.
            return {'observed':'herdr_unverified','snapshot_hash':digest(data)}
        except (OSError,ValueError,subprocess.SubprocessError): return {'observed':'herdr_error'}
    expected=run.get('pid_identity'); live=pid_identity((expected or {}).get('pid'))
    return {'observed':'running' if expected and live==expected else 'pid_missing_or_reused'}

def reconcile(root, now=None, herdr=HERDR, after_probe=None):
    now=now or time.time(); snapshot=read(Path(root)/'registry.json',{'tasks':[]})
    observations=[(t,probe(t,root,herdr)) for t in snapshot['tasks'] if t.get('status')!='reported']
    if after_probe: after_probe()
    for old, obs in observations:
        with transaction(root) as reg:
            t=task(reg,old['id'])
            # Compare the probed task, then merge into the latest registry.
            if digest(t)!=digest(old): continue
            t['last_checked']=now; t['observation']=obs.get('observed','result')
            rid=t.get('run_id')
            if not rid:
                t.setdefault('legacy_status',t.get('status'))
                if t.get('status') in ('running','dispatched','rework','done','blocked'):
                    t['status']='needs_reconciliation'
                # No legacy notification replay. Migration is observable on inspection.
                continue
            if 'result' in obs and t['status'] not in ('verified','reported','rework'):
                status=result_status(obs['result'])
                t['runs'][rid]['result_path']=str(Path(root)/'runs'/t['id']/rid/'result.json')
                if status!=t['status']: t.update(status=status,status_changed_at=now)
                emit(reg,t,status,now)
            elif t['status']=='running' and obs.get('observed')!='running':
                t.update(status='needs_reconciliation',status_changed_at=now);emit(reg,t,'needs_reconciliation',now)
            if t['status'] in ('done','ready_for_review','blocked','needs_reconciliation','verified','rework','batch_finished'):
                since=t.setdefault('status_changed_at',now)
                if now-since>=t.get('review_timeout',1800):
                    phase='review_overdue' if t['status'] in ('done','ready_for_review') else t['status']+'_overdue'
                    emit(reg,t,phase,now);t['attention_required']=phase

# Separate private inbox: old CLI does not depend on a valid task registry.
def enqueue(root, text, source='', event=None):
    e=dict(event or {});e.setdefault('event_id',uuid.uuid4().hex);e.setdefault('route',{'profile':'personal'})
    e.update(text=text[:500],source=source,ts=time.time())
    eid=e['event_id']
    with transaction(root,'inbox.json') as box:
        if eid in box:
            for k in ('task_id','run_id','result_path','route'):
                if box[eid].get(k)!=e.get(k): raise ValueError('event collision')
        else: box[eid]=dict(e,state='pending',attempts=0,next_at=0)
    return eid

def route_matches(want, owner):
    if not owner or not owner.get('main') or not owner.get('idle'): return False
    if want.get('profile','personal')!=owner.get('profile'): return False
    if want.get('session_id') and want['session_id']!=owner.get('session_id'): return False
    target=want.get('target')
    return target is None or target==owner.get('target')

def claim(root, owner, now=None):
    now=now or time.time()
    with transaction(root,'inbox.json') as box:
        for e in box.values():
            if not route_matches(e.get('route',{}),owner) or e['state']=='handled': continue
            if e.get('next_at',0)>now: continue
            if e['state'] in ('claimed','enqueued') and e.get('lease_until',0)>now: continue
            # Redelivery after crash is at least once, with the same event id.
            e.update(state='claimed',claim_id=uuid.uuid4().hex,owner=owner,lease_until=now+120,attempts=e['attempts']+1)
            return copy.deepcopy(e)
    return None

def receipt(root,eid,cid,state,evidence=None):
    if state not in ('pending','enqueued','handled'): raise ValueError('bad receipt')
    proof=summary(evidence) if state=='handled' and evidence else None
    if state=='handled' and (not proof or proof.get('size',0)<=0): raise ValueError('handling evidence file required')
    with transaction(root,'inbox.json') as box:
        e=box[eid]
        if e.get('claim_id')!=cid: raise ValueError('stale claim')
        if e['state']=='handled': return
        e.update(state=state,receipt=proof if state=='handled' else evidence,updated_at=time.time())
        if state=='pending': e['next_at']=time.time()+min(3600,5*2**min(e['attempts'],9))
        if state=='enqueued': e['lease_until']=time.time()+1800

def drain(root, sender, now=None):
    now=now or time.time()
    snapshot=read(Path(root)/'registry.json',{'outbox':{}})
    for eid,event in snapshot.get('outbox',{}).items():
        for target in ('agent','telegram'):
            claim_id=uuid.uuid4().hex
            with transaction(root) as reg:
                d=reg['outbox'][eid]['targets'][target]
                if d['state'] in ('success','unknown') or d.get('next_at',0)>now: continue
                if d['state']=='sending':
                    if d.get('lease_until',0)>now: continue
                    if target=='telegram': d['state']='unknown';continue
                d.update(state='sending',claim_id=claim_id,lease_until=now+60,attempts=d['attempts']+1)
            try: result=sender(target,event)
            except Exception: result={'state':'unknown' if target=='telegram' else 'failed'}
            with transaction(root) as reg:
                d=reg['outbox'][eid]['targets'][target]
                if d.get('claim_id')!=claim_id: continue
                state=result.get('state','failed')
                if state not in ('success','unknown','failed'): state='failed'
                d.update(state=state,receipt=result,next_at=now+min(3600,15*2**min(d['attempts'],8)))


def verify(root,tid,rid,evidence,passed=True):
    proof=summary(evidence)
    if proof.get('size',0)<=0: raise ValueError('verification evidence required')
    with transaction(root) as reg:
        t=task(reg,tid)
        if t.get('run_id')!=rid or t['status'] not in ('ready_for_review','done','blocked','needs_reconciliation'): raise ValueError('not reviewable')
        if passed and t['status']!='ready_for_review': raise ValueError('run evidence not ready')
        t['verification']={'run_id':rid,'passed':passed,'evidence':proof,'at':time.time()}
        t['runs'][rid]['verification']=copy.deepcopy(t['verification'])
        if passed: t['status']='verified'
        else:
            t['iterations']=t.get('iterations',0)+1
            t['status']='rework' if t['iterations']<=2 else 'blocked'
        t['status_changed_at']=time.time(); emit(reg,t,t['status'])

def prepare_report(root,tid,rid,body_hash,target):
    if not re.fullmatch('[0-9a-f]{64}',body_hash) or not target.get('chatId'):
        raise ValueError('expected delivery hash and target required')
    with transaction(root) as reg:
        t=task(reg,tid)
        if t.get('run_id')!=rid or t['status']!='verified': raise ValueError('not verified')
        intent=dict(task_id=tid,run_id=rid,hash=body_hash,target=target,
          verification_hash=digest(t['verification']),at=time.time())
        old=t.get('report_intent')
        if old:
            if any(old[k]!=intent[k] for k in intent if k!='at'): raise ValueError('report intent already bound')
        else: t['report_intent']=intent
    return old or intent

def report(root,tid,rid,proof):
    if proof.get('status')!='success' or not proof.get('message_id') or not proof.get('target'): raise ValueError('confirmed delivery receipt required')
    # A supplied JSON assertion is not a transport receipt. Cross-check the
    # durable sender ledger, or a bridge record referenced by delivery_id.
    candidates=list(read(Path(root)/'telegram-receipts.json',{}).values())
    ledger=Path.home()/'.pi/agent/tmp/telegram/outbox/delivery-ledger.jsonl'
    if proof.get('delivery_id') and ledger.exists():
        with ledger.open() as f:
            for line in f:
                try: item=json.loads(line)
                except ValueError: continue
                if item.get('delivery_id')==proof['delivery_id']:
                    item['target']={'chatId':item.get('target'), **({'threadId':item['thread']} if item.get('thread') is not None else {})}
                    candidates.append(item)
    known=next((r for r in candidates if (r.get('status')=='success' or r.get('state')=='success')
      and r.get('message_id')==proof['message_id'] and r.get('target')==proof['target']
      and ((proof.get('event_id') and r.get('event_id')==proof['event_id']) or
           (proof.get('delivery_id') and r.get('delivery_id')==proof['delivery_id']))),None)
    if not known: raise ValueError('receipt not found in sender ledger')
    with transaction(root) as reg:
        t=task(reg,tid)
        if t.get('run_id')!=rid or t['status']!='verified' or not t.get('verification',{}).get('passed'): raise ValueError('not verified')
        intent=t.get('report_intent',{})
        if (not intent or intent['verification_hash']!=digest(t['verification']) or
            intent['target']!=known.get('target') or intent['hash']!=known.get('hash')):
            raise ValueError('receipt does not match prepared final report')
        if known.get('at',known.get('timestamp',0)/1000) < intent['at']:
            raise ValueError('delivery predates prepared report')
        t.update(status='reported',report=dict(proof,run_id=rid,verification_hash=digest(t['verification'])))
        t['runs'][rid]['report']=copy.deepcopy(t['report'])

def update_metadata(root,tid,delta,expected_hash):
    allowed={'instruction','acceptance','artifacts','route','type','agent_name','workspace_id','pane_id','done_marker','review_timeout'}
    if set(delta)-allowed: raise ValueError('status/result fields must use protocol commands')
    with transaction(root) as reg:
        t=task(reg,tid)
        if digest(t)!=expected_hash: raise ValueError('task changed; reload and retry')
        t.update(delta)

def migrate_spool(root,directory):
    # Old .done files may have been injected; never replay them automatically.
    count=0
    for path in sorted(Path(directory).glob('*.json')):
        data=read(path)
        if not isinstance(data,dict) or not isinstance(data.get('text'),str):continue
        eid='legacy-'+digest([str(path.resolve()),data])
        enqueue(root,data['text'],data.get('source','legacy'),{'event_id':eid})
        # Source remains intact; cutover must stop the old consumer before import.
        count+=1
    return {'imported_pending':count,'source_unchanged':True}

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT)
    sub=p.add_subparsers(dest='cmd',required=True)
    s=sub.add_parser('register');s.add_argument('task_id');s.add_argument('--spec',required=True)
    s=sub.add_parser('start-run');s.add_argument('task_id');s.add_argument('--run-id')
    s=sub.add_parser('run');s.add_argument('task_id');s.add_argument('run_id');s.add_argument('command',nargs=argparse.REMAINDER)
    s=sub.add_parser('result');s.add_argument('task_id');s.add_argument('run_id')
    sub.add_parser('reconcile');sub.add_parser('inspect');sub.add_parser('migrate')
    s=sub.add_parser('migrate-spool');s.add_argument('directory')
    s=sub.add_parser('update');s.add_argument('task_id');s.add_argument('--delta',required=True);s.add_argument('--expected-hash',required=True)
    s=sub.add_parser('claim');s.add_argument('--owner',required=True)
    s=sub.add_parser('ack');s.add_argument('event_id');s.add_argument('claim_id');s.add_argument('state');s.add_argument('--evidence')
    s=sub.add_parser('verify');s.add_argument('task_id');s.add_argument('run_id');s.add_argument('--evidence',required=True);s.add_argument('--reject',action='store_true')
    s=sub.add_parser('report');s.add_argument('task_id');s.add_argument('run_id');s.add_argument('--receipt',required=True)
    s=sub.add_parser('prepare-report');s.add_argument('task_id');s.add_argument('run_id');s.add_argument('--target',required=True)
    group=s.add_mutually_exclusive_group(required=True);group.add_argument('--text-file');group.add_argument('--hash')
    a=p.parse_args(); result=None
    if a.cmd=='register': register(a.root,a.task_id,**read(a.spec))
    elif a.cmd=='start-run': result=start_run(a.root,a.task_id,a.run_id)
    elif a.cmd=='run': result=run_command(a.root,a.task_id,a.run_id,a.command[1:] if a.command[:1]==['--'] else a.command)
    elif a.cmd=='result': result=read(a.root/'runs'/ident(a.task_id)/ident(a.run_id)/'result.json')
    elif a.cmd=='reconcile': reconcile(a.root)
    elif a.cmd=='claim': result=claim(a.root,json.loads(a.owner))
    elif a.cmd=='ack': receipt(a.root,a.event_id,a.claim_id,a.state,a.evidence)
    elif a.cmd=='verify': verify(a.root,a.task_id,a.run_id,a.evidence,not a.reject)
    elif a.cmd=='report': report(a.root,a.task_id,a.run_id,read(a.receipt))
    elif a.cmd=='prepare-report': result=prepare_report(a.root,a.task_id,a.run_id,a.hash or delivery_hash(Path(a.text_file).read_text()),json.loads(a.target))
    elif a.cmd=='migrate-spool': result=migrate_spool(a.root,a.directory)
    elif a.cmd=='update': update_metadata(a.root,a.task_id,read(a.delta),a.expected_hash)
    elif a.cmd=='migrate':
        with transaction(a.root) as reg:
            for t in reg['tasks']:
                if not t.get('run_id'): t.setdefault('legacy_status',t.get('status'));t.setdefault('migration','needs_reconciliation_no_replay')
    elif a.cmd=='inspect':
        result={'registry':read(a.root/'registry.json',{}),'inbox':{}}
        for eid,e in read(a.root/'inbox.json',{}).items():
            result['inbox'][eid]={k:v for k,v in e.items() if k not in ('text','source')}
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
    try: main()
    except Exception as e:
        print(json.dumps({'error':type(e).__name__}),file=sys.stderr);sys.exit(1)
