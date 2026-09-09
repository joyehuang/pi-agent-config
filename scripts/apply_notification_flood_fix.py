#!/usr/bin/env python3
"""Install the notification fix onto the exact current patched baseline. Read-only by default.
No service, model, configuration, registry, inbox, outbox or receipt operations.
"""
import argparse
import json
import os
import subprocess
from pathlib import Path
import uuid
from apply_duplicate_reply_fix import sha, read_regular, private_write, replace_all

REPO = Path(__file__).resolve().parents[1]
PATCH = REPO/'patches/pi-notification-flood'
DEFAULTS = dict(package=Path.home()/'.pi/agent/npm/node_modules/@llblab/pi-telegram',
    host=Path.home()/'.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent',
    bin=Path.home()/'bin', extension=Path.home()/'.pi/agent/extensions')


def safe_target(roots, group, name):
    base=Path(roots[group]).absolute(); target=base/name
    if Path(name).is_absolute() or '..' in Path(name).parts: raise ValueError('invalid manifest path')
    if target.resolve() != base.resolve()/name: raise ValueError('symlink in target path')
    return target


def prepare(roots):
    manifest=json.loads((PATCH/'manifest.json').read_text())
    for group, expected in [('package',manifest['bridge_version']),('host',manifest['pi_version'])]:
        if json.loads(read_regular(Path(roots[group])/'package.json'))['version'] != expected: raise ValueError('version mismatch')
    for item in manifest['guards']:
        if sha(read_regular(safe_target(roots,item['group'],item['path']))) != item['sha256']: raise ValueError('guard drift: '+item['path'])
    plan=[]
    for item in manifest['files']:
        target=safe_target(roots,item['group'],item['path']); before=read_regular(target); actual=sha(before)
        if actual not in (item['before'],item['after']): raise ValueError('baseline drift: '+str(target))
        if 'source' in item: after=read_regular(REPO/item['source'])
        elif actual == item['after']: after=before
        else:
            after=before.decode()
            for old,new in item['edits']:
                if after.count(old)!=1: raise ValueError('patch context drift')
                after=after.replace(old,new)
            after=after.encode()
        if sha(after)!=item['after']: raise ValueError('output hash drift: '+item['path'])
        plan.append(dict(target=target,before=before,after=after,state='after' if actual==item['after'] else 'before'))
    if len({i['state'] for i in plan})!=1: raise ValueError('mixed installation; use private rollback')
    return plan


def install(roots=DEFAULTS, apply=False, backup_root=None):
    plan=prepare(roots)
    if plan[0]['state']=='after': return dict(status='already_applied',activation=False)
    result=dict(status='plan',files=[dict(path=str(i['target']),before=sha(i['before']),after=sha(i['after'])) for i in plan],activation=False)
    if not apply:return result
    if backup_root is None:raise ValueError('private --backup-root required')
    backup=Path(backup_root).absolute()/('notification-flood-'+uuid.uuid4().hex);backup.mkdir(parents=True,mode=0o700)
    records=[]
    for n,item in enumerate(plan):
        private_write(backup/str(n),item['before'])
        records.append(dict(group=next(g for g,b in roots.items() if item['target'].is_relative_to(Path(b).absolute())),target=str(item['target']),file=str(n),before=sha(item['before']),after=sha(item['after'])))
    private_write(backup/'rollback.json',json.dumps(dict(version=1,files=records),indent=2).encode())
    replace_all(plan)
    return {**result,'status':'applied','backup':str(backup)}


def rollback(backup, apply=False, roots=DEFAULTS):
    backup=Path(backup).absolute(); manifest=json.loads((PATCH/'manifest.json').read_text())
    accepted={str(safe_target(roots,i['group'],i['path'])):i for i in manifest['files']}
    data=json.loads(read_regular(backup/'rollback.json')); plan=[]
    if len(data['files']) != len(accepted) or len({r['target'] for r in data['files']})!=len(accepted): raise ValueError('invalid rollback targets')
    for r in data['files']:
        expected=accepted.get(r['target'])
        if not expected or any(r[k]!=expected[k] for k in ('before','after')): raise ValueError('rollback target outside accepted patch')
        if not r['file'].isdigit(): raise ValueError('invalid backup member')
        target=Path(r['target']); before=read_regular(target); original=read_regular(backup/r['file'])
        if sha(original)!=r['before'] or sha(before) not in (r['before'],r['after']):raise ValueError('rollback drift')
        if before!=original:plan.append(dict(target=target,before=before,after=original))
    if apply:replace_all(plan)
    return dict(status=('rolled_back' if apply else 'rollback_plan') if plan else 'already_rolled_back',files=[str(i['target']) for i in plan],activation=False)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for group,base in DEFAULTS.items():p.add_argument('--'+group+'-root',type=Path,default=base)
    p.add_argument('--accepted-commit')
    p.add_argument('--watchdog-paused',action='store_true',help='operator confirms watchdog writers are quiesced; does not pause them')
    p.add_argument('--apply',action='store_true');p.add_argument('--backup-root',type=Path);p.add_argument('--rollback',type=Path)
    a=p.parse_args()
    if a.apply and not a.watchdog_paused: raise ValueError('operator must quiesce watchdog writers before --apply')
    if a.apply and not a.rollback:
        head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
        dirty=subprocess.check_output(['git','status','--porcelain'],cwd=REPO,text=True).strip()
        if a.accepted_commit!=head or dirty: raise ValueError('apply requires clean independently accepted current commit')
    roots={g:getattr(a,g+'_root') for g in DEFAULTS}
    print(json.dumps(rollback(a.rollback,a.apply,roots) if a.rollback else install(roots,a.apply,a.backup_root),indent=2))

if __name__=='__main__':main()
