#!/usr/bin/env python3
"""Offline copies, fake streams/senders only; no runtime startup or config loading."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from apply_duplicate_reply_fix import install, rollback

REPO = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--evidence', type=Path, required=True)
a = p.parse_args()
a.evidence = a.evidence.resolve()
a.evidence.mkdir(parents=True, exist_ok=True)
tmp = a.evidence/'tmp'
tmp.mkdir(exist_ok=True)
os.environ['TMPDIR'] = str(tmp)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
# Short task-local path for Unix sockets (Darwin sun_path is limited).
socket_dir = a.evidence.parent
os.environ['PI_FIX_SOCKET_DIR'] = str(socket_dir)
tempfile.tempdir = str(tmp)
host = Path.home()/'.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent'
node = host.parents[3]/'bin/node'
source = Path.home()/'.pi/agent/npm/node_modules/@llblab/pi-telegram'
extension = Path.home()/'.pi/agent/extensions/empty-reply-guard.ts'
results = []


def run(name, cmd):
    r = subprocess.run([str(c) for c in cmd], cwd=REPO, capture_output=True, text=True, timeout=180)
    (a.evidence/(name+'.log')).write_text(r.stdout+r.stderr)
    results.append(dict(name=name, command=[str(c) for c in cmd], exit_code=r.returncode))
    print(name, r.returncode, flush=True)
    return r


with tempfile.TemporaryDirectory(prefix='verify-') as work:
    work = Path(work)
    baseline, patched = work/'baseline', work/'patched'
    patched_host = work/'host-patched'
    shutil.copytree(host, patched_host, ignore=shutil.ignore_patterns('node_modules'))
    (patched_host/'node_modules').symlink_to(host/'node_modules')
    for package in (baseline, patched):
        shutil.copytree(source, package)
        deps = package/'node_modules'
        (deps/'@earendil-works').mkdir(parents=True, exist_ok=True)
        (deps/'@sinclair').mkdir(exist_ok=True)
        (deps/'@types').mkdir(exist_ok=True)
        links = {**{str(Path('@earendil-works')/d.name): d for d in (host/'node_modules/@earendil-works').iterdir()},
                 '@earendil-works/pi-coding-agent': host,
                 '@sinclair/typebox': host/'node_modules/typebox', 'typebox': host/'node_modules/typebox'}
        types = host.parents[1]/'vercel/node_modules/@types/node'
        if types.exists():
            links['@types/node'] = types
        for name, target in links.items():
            if not (deps/name).exists():
                (deps/name).symlink_to(target)
        shutil.copy2(extension, package/'empty-reply-guard.ts')
    plan = install(source, extension, host)
    (a.evidence/'live-dry-run.json').write_text(json.dumps(plan, indent=2))
    receipt = install(patched, patched/'empty-reply-guard.ts', patched_host, True, work/'backups')
    assert install(patched, patched/'empty-reply-guard.ts', patched_host)['status'] == 'already_applied'
    rollback(receipt['backup'], True)
    assert (patched/'empty-reply-guard.ts').read_bytes() == extension.read_bytes()
    install(patched, patched/'empty-reply-guard.ts', patched_host, True, work/'backups')
    results.append(dict(name='isolated_apply_idempotence_rollback_apply', exit_code=0))
    (a.evidence/'guard-baseline.ts').write_bytes(extension.read_bytes())
    for label, package, guard in [('baseline',baseline,baseline/'empty-reply-guard.ts'), ('transport-only',patched,baseline/'empty-reply-guard.ts'), ('patched',patched,patched/'empty-reply-guard.ts')]:
        run('lifecycle-'+label,[node,'tests/duplicate_lifecycle.mjs',package,host if label=='baseline' else patched_host,guard,work/label])
    for scenario in ('empty-stop','empty-error','abort','abort-backoff'):
        run(scenario,[node,'tests/duplicate_lifecycle.mjs',patched,patched_host,patched/'empty-reply-guard.ts',work/scenario,scenario])
    run('guard-edges',[node,'tests/empty_reply_guard.mjs',host])
    run('transport-edges',[node,'tests/duplicate_transport.mjs',patched,work/'transport'])
    run('rendering',[node,'tests/duplicate_rendering.mjs',patched,work/'rendering'])
    run('bus-lost-ack',[node,'tests/duplicate_bus.mjs',patched,work/'bus',socket_dir/'verify-bus.sock'])
    run('delivery-regression',[node,'tests/delivery.mjs',patched])
    run('relay-regression',[node,'tests/relay.mjs'])
    run('end-to-end-regression',[node,'tests/end_to_end.mjs'])
    for name in ('test_task_protocol.py','test_rework.py','test_duplicate_installer.py'):
        run(name,[sys.executable,'-m','unittest','discover','-s','tests','-p',name])
    # Compare standalone compiler diagnostics against CURRENT installation, which
    # already has upstream/peer-compatibility errors. No dependency installation.
    tsc = host.parents[1]/'vercel/node_modules/typescript/lib/tsc.js'
    outputs = []
    for label, package in [('baseline',baseline),('patched',patched)]:
        r = subprocess.run([str(node),str(tsc),'--noEmit','--skipLibCheck','--allowImportingTsExtensions','--target','es2022','--module','nodenext',str(package/'index.ts'),str(package/'empty-reply-guard.ts')],capture_output=True,text=True)
        (a.evidence/('typecheck-'+label+'.log')).write_text(r.stdout+r.stderr)
        outputs.append(set(re.sub(r'\(\d+,\d+\)', '(line,column)', (r.stdout+r.stderr).replace(str(package),'MODULE').replace(os.path.relpath(package,REPO),'MODULE')).splitlines()))
    added = sorted(outputs[1]-outputs[0])
    (a.evidence/'typecheck-new-errors.json').write_text(json.dumps(added,indent=2))
    results.append(dict(name='typecheck_no_new_diagnostics',exit_code=int(bool(added))))
(a.evidence/'tests.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results,indent=2))
sys.exit(any(item['exit_code'] for item in results))
