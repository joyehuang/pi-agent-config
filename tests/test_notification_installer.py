import sys,tempfile,unittest,json
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import apply_notification_flood_fix as m
from verify_notification_flood_fix import stage
class Installer(unittest.TestCase):
 def test_isolated_transaction_and_rollback(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);roots=stage(root/'stage')
   plan=m.prepare(roots);original={i['target']:i['before'] for i in plan}
   with patch.object(m,'private_write',side_effect=AssertionError('dry-run write')):self.assertEqual(m.install(roots)['status'],'plan')
   result=m.install(roots,True,root/'backups');backup=Path(result['backup']);self.assertEqual(backup.stat().st_mode&0o777,0o700)
   self.assertTrue(all(p.stat().st_mode&0o777==0o600 for p in backup.iterdir()))
   self.assertEqual(m.install(roots)['status'],'already_applied');self.assertEqual(m.rollback(backup,False,roots)['status'],'rollback_plan')
   m.rollback(backup,True,roots);self.assertEqual(m.rollback(backup,True,roots)['status'],'already_rolled_back')
   for p,data in original.items():self.assertEqual(p.read_bytes(),data)
   for name in ('lib/send-queue.ts','lib/queue.ts','lib/bindings.ts'):
    p=roots['package']/name;data=p.read_bytes();p.write_bytes(data+b'\n// drift')
    with self.assertRaises(ValueError):m.install(roots,True,root/'backups')
    p.write_bytes(data)
   replace=m.replace_all.__globals__['os'].replace;calls=0
   def fault(source,target):
    nonlocal calls
    calls+=1
    if calls==3:raise OSError('test replacement fault')
    return replace(source,target)
   with patch.object(m.os,'replace',side_effect=fault):
    with self.assertRaises(OSError):m.install(roots,True,root/'backups')
   for p,data in original.items():self.assertEqual(p.read_bytes(),data)
   # Crash partial install: recover only accepted target hashes, no state files.
   first=plan[0];first['target'].write_bytes(first['after']);m.rollback(backup,True,roots)
   for p,data in original.items():self.assertEqual(p.read_bytes(),data)
   manifest=json.loads((backup/'rollback.json').read_text());manifest['files'][0]['target']=str(root/'unrelated')
   (backup/'rollback.json').write_text(json.dumps(manifest))
   with self.assertRaises(ValueError):m.rollback(backup,True,roots)
