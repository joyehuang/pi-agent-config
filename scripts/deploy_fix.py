#!/usr/bin/env python3
"""Reviewable code-only deploy/rollback. Does not restart Pi or touch task state.
Caller must pause watchdog scheduling and stop its prior invocation before apply.
Default action is read-only plan. Backups remain private and checksum-fenced.
"""
import argparse, hashlib, json, os, shutil, subprocess, tempfile, time
from pathlib import Path
from apply_delivery_patch import apply, BASE

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).exists() else None

def atomic_copy(src,dest,mode=None):
    dest.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(dir=dest.parent,prefix='.deploy-')
    try:
        with os.fdopen(fd,'wb') as f:
            os.fchmod(f.fileno(),mode if mode is not None else (src.stat().st_mode & 0o777));f.write(src.read_bytes());f.flush();os.fsync(f.fileno())
        os.replace(tmp,dest)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def prepare(home,stage):
    package=home/'.pi/agent/npm/node_modules/@llblab/pi-telegram'
    host=home/'.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/package.json'
    if json.loads(host.read_text()).get('version')!='0.84.1':raise ValueError('unsupported Pi host version')
    apply(package)
    copy=stage/'bridge';shutil.copytree(package,copy);apply(copy,True)
    entries=[]
    for name,hashes in json.loads((BASE/'patches/pi-delivery/manifest.json').read_text())['files'].items():
        entries.append({'target':str(package/name),'source':str(copy/name),'before':hashes['before'],'after':hashes['after']})
    for dest,item in json.loads((BASE/'patches/pi-delivery/deployment-baseline.json').read_text()).items():
        source=BASE/item['source'];entries.append({'target':str(home/dest),'source':str(source),'before':item['before'],'after':sha(source)})
    for e in entries:
        e['before_mode']=Path(e['target']).stat().st_mode & 0o777 if Path(e['target']).exists() else None
        if sha(e['target']) not in (e['before'],e['after']):raise ValueError('deployment baseline mismatch: '+e['target'])
    statuses={sha(e['target'])==e['after'] for e in entries}
    if statuses=={True}:return []
    if len(statuses)>1:raise ValueError('mixed deployment; inspect/rollback before retry')
    return entries

def deploy(home,write=False,accepted=None,paused=False):
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=BASE,text=True).strip()
    if write:
        if accepted!=head or not paused:raise ValueError('accepted current commit and paused watchdog required')
        if subprocess.check_output(['git','status','--porcelain'],cwd=BASE,text=True).strip():raise ValueError('working tree must be clean')
    with tempfile.TemporaryDirectory(prefix='pi-deploy-stage-') as d:
        entries=prepare(home,Path(d))
        if not write:return {'status':'plan','files':[e['target'] for e in entries],'restart_required':True}
        if not entries:return {'status':'already_applied'}
        backup=home/'.config/agent-tasks/deployments'/f'{int(time.time())}-{head[:10]}'
        backup.mkdir(parents=True,mode=0o700)
        for i,e in enumerate(entries):
            e['backup']=str(backup/str(i))
            if e['before'] is not None:atomic_copy(Path(e['target']),Path(e['backup']),0o600)
        journal=backup/'manifest.json';journal.write_text(json.dumps({'commit':head,'entries':entries},indent=2));journal.chmod(0o600)
        installed=[]
        try:
            for e in entries:
                if sha(e['target'])!=e['before']:raise ValueError('concurrent code modification')
                atomic_copy(Path(e['source']),Path(e['target']));installed.append(e)
        except Exception:
            for e in reversed(installed):
                if e['before'] is None:Path(e['target']).unlink()
                else:atomic_copy(Path(e['backup']),Path(e['target']),e['before_mode'])
            raise
        return {'status':'installed_restart_required','backup':str(backup),'production_state_changed':False}

def rollback(backup,write=False,paused=False):
    entries=json.loads((backup/'manifest.json').read_text())['entries']
    for e in entries:
        if sha(e['target']) not in (e['before'],e['after']):raise ValueError('rollback target modified')
        if e['before'] is not None and sha(e['backup'])!=e['before']:raise ValueError('backup checksum mismatch')
    if write:
        if not paused:raise ValueError('watchdog must stay paused through rollback and state reconciliation')
        for e in reversed(entries):
            if sha(e['target'])==e['before']:continue
            if e['before'] is None:Path(e['target']).unlink()
            else:atomic_copy(Path(e['backup']),Path(e['target']),e['before_mode'])
    return {'status':'rolled_back_restart_required' if write else 'rollback_plan','watchdog_must_remain_paused':True,'state_preserved':True}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--home',type=Path,default=Path.home());p.add_argument('--apply',action='store_true')
    p.add_argument('--accepted-commit');p.add_argument('--watchdog-paused',action='store_true');p.add_argument('--rollback',type=Path)
    a=p.parse_args()
    print(json.dumps(rollback(a.rollback,a.apply,a.watchdog_paused) if a.rollback else deploy(a.home,a.apply,a.accepted_commit,a.watchdog_paused),indent=2))
