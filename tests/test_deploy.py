import json, shutil, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import deploy_fix as d

class Deploy(unittest.TestCase):
 def test_idempotent_install_and_rollback_in_isolated_home(self):
  with tempfile.TemporaryDirectory() as temp:
   home=Path(temp)
   module='.pi/agent/npm/node_modules/@llblab/pi-telegram'
   shutil.copytree(Path.home()/module,home/module)
   host=home/'.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/package.json'
   host.parent.mkdir(parents=True);host.write_text('{"version":"0.84.1"}')
   baseline=json.loads((d.BASE/'patches/pi-delivery/deployment-baseline.json').read_text())
   for dest,item in baseline.items():
    if item['before']:
     p=home/dest;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(Path.home()/dest,p)
   before={str(p.relative_to(home)):d.sha(p) for p in home.rglob('*') if p.is_file()}
   with patch.object(d.subprocess,'check_output',side_effect=lambda args,**kw:'testcommit\n' if args[1]=='rev-parse' else ''):
    self.assertEqual(d.deploy(home)['status'],'plan')
    result=d.deploy(home,True,'testcommit',True)
    self.assertEqual(d.deploy(home,True,'testcommit',True)['status'],'already_applied')
    for dest,item in baseline.items():self.assertEqual(d.sha(home/dest),d.sha(d.BASE/item['source']))
    backup=Path(result['backup']);d.rollback(backup,True,True);d.rollback(backup,True,True)
    for rel,h in before.items():self.assertEqual(d.sha(home/rel),h)
    self.assertFalse((home/'bin/task_protocol.py').exists())
    # Changed baseline fails closed before any new install.
    f=home/module/'lib/activity.ts';f.write_text(f.read_text()+'\n// third party change\n')
    with self.assertRaises(ValueError):d.deploy(home,True,'testcommit',True)
