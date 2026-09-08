#!/usr/bin/env python3
"""Version and complete content guarded patch; defaults to check-only."""
import argparse, hashlib, json, subprocess, tempfile, shutil
from pathlib import Path
BASE=Path(__file__).resolve().parents[1]
def apply(target,write=False):
    target=Path(target).resolve();m=json.loads((BASE/'patches/pi-delivery/manifest.json').read_text())
    p=json.loads((target/'package.json').read_text())
    if (p['name'],p['version'])!=(m['package'],m['version']):raise ValueError('unsupported package/version')
    states=[]
    for name,h in m['files'].items():
        actual=hashlib.sha256((target/name).read_bytes()).hexdigest()
        if actual not in h.values():raise ValueError('baseline mismatch: '+name)
        states.append('after' if actual==h['after'] else 'before')
    if all(s=='after' for s in states):return 'already_applied'
    if any(s!='before' for s in states):raise ValueError('mixed baseline')
    if not write:return 'baseline_verified'
    # Prepare all files before touching a target. Deployment script owns backups.
    with tempfile.TemporaryDirectory() as d:
        stage=Path(d)
        for name in m['files']:
            (stage/name).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target/name,stage/name)
        subprocess.run(['/usr/bin/patch','--batch','-p1','-i',str(BASE/'patches/pi-delivery/fix.patch')],cwd=stage,check=True,capture_output=True)
        for name,h in m['files'].items():
            if hashlib.sha256((stage/name).read_bytes()).hexdigest()!=h['after']:raise ValueError('output checksum mismatch')
        for name in m['files']:
            temporary=target/(name+'.delivery-fix.tmp');shutil.copy2(stage/name,temporary);temporary.replace(target/name)
    return 'applied'
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('target');p.add_argument('--apply',action='store_true');a=p.parse_args();print(apply(a.target,a.apply))
