#!/usr/bin/env python3
"""Real installed modules copied into isolation; fake streams and senders only."""
import argparse,json,os,re,shutil,subprocess,sys,tempfile
from pathlib import Path
from apply_notification_flood_fix import DEFAULTS,install,rollback
REPO=Path(__file__).resolve().parents[1]

def stage(root):
    roots={g:root/g for g in DEFAULTS}
    shutil.copytree(DEFAULTS['host'],roots['host'],ignore=shutil.ignore_patterns('node_modules'))
    deps=roots['host']/'node_modules';deps.mkdir()
    for source in (DEFAULTS['host']/'node_modules').iterdir():
        if source.name=='@earendil-works':
            (deps/source.name).mkdir()
            for package in source.iterdir():
                if package.name=='pi-agent-core':shutil.copytree(package,deps/source.name/package.name)
                else:(deps/source.name/package.name).symlink_to(package)
        else:(deps/source.name).symlink_to(source)
    shutil.copytree(DEFAULTS['package'],roots['package'])
    d=roots['package']/'node_modules';(d/'@earendil-works').mkdir(parents=True,exist_ok=True);(d/'@sinclair').mkdir(exist_ok=True)
    links={str(Path('@earendil-works')/p.name):p for p in (deps/'@earendil-works').iterdir()}
    links.update({'@earendil-works/pi-coding-agent':roots['host'],'typebox':deps/'typebox','@sinclair/typebox':deps/'typebox'})
    types=DEFAULTS['host'].parents[1]/'vercel/node_modules/@types/node'
    if types.exists():(d/'@types').mkdir(exist_ok=True);links['@types/node']=types
    for name,source in links.items():
        target=d/name
        if not target.exists():target.symlink_to(source)
    for group,names in [('bin',['task_protocol.py','task-watchdog.py','notify-agent.py','notify-telegram.py']),('extension',['relay-notify.ts','empty-reply-guard.ts'])]:
        roots[group].mkdir()
        for name in names:shutil.copy2(DEFAULTS[group]/name,roots[group]/name)
    return roots

def main():
    p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);a=p.parse_args();a.evidence.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.environ['PYTHONDONTWRITEBYTECODE']='1'
    results=[]
    def run(name,cmd):
        r=subprocess.run([str(x) for x in cmd],cwd=REPO,capture_output=True,text=True,timeout=180)
        log=a.evidence/(name+'.log');log.write_text(r.stdout+r.stderr)
        results.append(dict(name=name,command=[str(x) for x in cmd],exit_code=r.returncode,log=str(log)))
        print(name,r.returncode,flush=True);return r
    # Short isolated socket paths; never create a network listener.
    with tempfile.TemporaryDirectory(prefix='nf-') as tmp:
        work=Path(tmp);os.environ['PI_FIX_SOCKET_DIR']=str(work)
        roots=stage(work/'stage');node=DEFAULTS['host'].parents[3]/'bin/node'
        (a.evidence/'live-dry-run.json').write_text(json.dumps(install(),indent=2))
        tsc=DEFAULTS['host'].parents[1]/'vercel/node_modules/typescript/lib/tsc.js'
        # Resolve extension peer imports using isolated bridge dependencies.
        for name in ('relay-notify.ts','empty-reply-guard.ts'):shutil.copy2(roots['extension']/name,roots['package']/name)
        typecmd=[node,tsc,'--noEmit','--skipLibCheck','--allowImportingTsExtensions','--target','es2022','--module','nodenext',roots['package']/'index.ts',roots['package']/'relay-notify.ts',roots['package']/'empty-reply-guard.ts']
        before=subprocess.run([str(x) for x in typecmd],capture_output=True,text=True)
        receipt=install(roots,True,work/'backups');assert install(roots)['status']=='already_applied'
        rollback(receipt['backup'],True,roots);assert install(roots)['status']=='plan'
        install(roots,True,work/'backups')
        results.append(dict(name='isolated_apply_rollback_idempotence',exit_code=0))
        for name in ('relay-notify.ts','empty-reply-guard.ts'):shutil.copy2(roots['extension']/name,roots['package']/name)
        after=subprocess.run([str(x) for x in typecmd],capture_output=True,text=True)
        norm=lambda s:set(re.sub(r'\(\d+,\d+\)','(line,column)',s).splitlines())
        added=sorted(norm(after.stdout+after.stderr)-norm(before.stdout+before.stderr))
        for label,r in [('baseline',before),('patched',after)]:(a.evidence/('typecheck-'+label+'.log')).write_text(r.stdout+r.stderr)
        (a.evidence/'typecheck-new-errors.json').write_text(json.dumps(added,indent=2));results.append(dict(name='no_new_type_diagnostics',exit_code=int(bool(added))))
        run('notification-lifecycle',[node,'tests/notification_lifecycle.mjs',roots['package'],roots['host'],work/'lifecycle'])
        for scenario in ('incident','empty-stop','empty-error','abort','abort-backoff'):
            run('duplicate-'+scenario,[node,'tests/duplicate_lifecycle.mjs',roots['package'],roots['host'],roots['extension']/'empty-reply-guard.ts',work/scenario,scenario])
        run('empty-guard',[node,'tests/empty_reply_guard.mjs',roots['host']])
        run('transport',[node,'tests/duplicate_transport.mjs',roots['package'],work/'transport'])
        run('rendering',[node,'tests/duplicate_rendering.mjs',roots['package'],work/'rendering'])
        run('bus-lost-ack',[node,'tests/duplicate_bus.mjs',roots['package'],work/'bus',work/'bus.sock'])
        run('delivery',[node,'tests/delivery.mjs',roots['package']])
        run('relay',[node,'tests/relay.mjs'])
        run('end-to-end',[node,'tests/end_to_end.mjs'])
        for name in ('test_task_protocol.py','test_rework.py','test_notification_flood.py','test_notification_installer.py'):
            run(name,[sys.executable,'-m','unittest','discover','-s','tests','-p',name])
    (a.evidence/'tests.json').write_text(json.dumps(results,indent=2));return int(any(i['exit_code'] for i in results))
if __name__=='__main__':sys.exit(main())
