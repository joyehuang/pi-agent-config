#!/usr/bin/env python3
"""No model, no real sender, no production state mutations."""
import argparse, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
from apply_delivery_patch import apply
REPO=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,default=Path.home()/'artifacts/2026-09-08/pi-delivery-watchdog-fix/rework-1');a=p.parse_args();a.evidence.mkdir(parents=True,exist_ok=True)
source=Path.home()/'.pi/agent/npm/node_modules/@llblab/pi-telegram'
node=Path.home()/'.nvm/versions/node/v24.19.0/bin/node'
with tempfile.TemporaryDirectory(prefix='pi-fix-offline-') as d:
 stage=Path(d)/'module';shutil.copytree(source,stage)
 deps=stage/'node_modules';deps.mkdir(exist_ok=True)
 host=Path.home()/'.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent'
 for namespace in ('@earendil-works','@sinclair'):(deps/namespace).mkdir(exist_ok=True)
 for dep in (host/'node_modules/@earendil-works').iterdir():
  (deps/'@earendil-works'/dep.name).symlink_to(dep)
 (deps/'@earendil-works/pi-coding-agent').symlink_to(host)
 (deps/'@sinclair/typebox').symlink_to(host/'node_modules/typebox')
 (deps/'typebox').symlink_to(host/'node_modules/typebox')
 types=host/'node_modules/@types/node'
 if not types.exists():types=Path.home()/'.nvm/versions/node/v24.19.0/lib/node_modules/vercel/node_modules/@types/node'
 (deps/'@types').mkdir(exist_ok=True)
 if types.exists():(deps/'@types/node').symlink_to(types)
 tsc=Path.home()/'.nvm/versions/node/v24.19.0/lib/node_modules/vercel/node_modules/typescript/lib/tsc.js'
 shutil.copy2(Path.home()/'.pi/agent/extensions/relay-notify.ts',stage/'relay-notify.ts')
 typecmd=[str(node),str(tsc),'--noEmit','--skipLibCheck','--allowImportingTsExtensions','--target','es2022','--module','nodenext',str(stage/'index.ts'),str(stage/'relay-notify.ts')]
 before=subprocess.run(typecmd,capture_output=True,text=True)
 (a.evidence/'typecheck-baseline.txt').write_text(before.stdout+before.stderr)
 baseline=subprocess.run([str(node),'tests/delivery.mjs',str(stage),'--baseline'],cwd=REPO,capture_output=True,text=True)
 (a.evidence/'baseline-reproduction.txt').write_text(baseline.stdout+baseline.stderr)
 apply(stage,True)
 shutil.copy2(REPO/'extensions/relay-notify.ts',stage/'relay-notify.ts')
 after=subprocess.run(typecmd,capture_output=True,text=True)
 (a.evidence/'typecheck-patched.txt').write_text(after.stdout+after.stderr)
 import re
 normalize=lambda value: re.sub(r'\(\d+,\d+\)', '(line,column)',value).replace(str(stage),'MODULE')
 added=set(normalize(after.stdout+after.stderr).splitlines())-set(normalize(before.stdout+before.stderr).splitlines())
 (a.evidence/'typecheck-new-errors.json').write_text(json.dumps(sorted(added),indent=2))
 commands=[[sys.executable,'-m','unittest','discover','-s','tests','-p','test_*.py'],[str(node),'tests/delivery.mjs',str(stage)],[str(node),'tests/relay.mjs'],[str(node),'tests/end_to_end.mjs']]
 results=[{'suite':'typecheck_new_errors','exit_code':int(bool(added))},{'suite':'installed_baseline_duplicate_reproduction','exit_code':baseline.returncode}]
 for i,cmd in enumerate(commands):
  r=subprocess.run(cmd,cwd=REPO,capture_output=True,text=True)
  (a.evidence/f'offline-{i}.txt').write_text(r.stdout+r.stderr)
  results.append({'suite':i,'exit_code':r.returncode})
 (a.evidence/'tests.json').write_text(json.dumps(results,indent=2))
 print(json.dumps(results));sys.exit(any(r['exit_code'] for r in results))
