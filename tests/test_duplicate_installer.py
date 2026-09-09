import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('duplicate_installer', REPO/'scripts/apply_duplicate_reply_fix.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
HOST = Path.home()/'.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent'
SOURCE = Path.home()/'.pi/agent/npm/node_modules/@llblab/pi-telegram'
EXT = Path.home()/'.pi/agent/extensions/empty-reply-guard.ts'


class Installer(unittest.TestCase):
    def test_copy_only_install_rollback_drift_and_transaction(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            package = root/'package'
            shutil.copytree(SOURCE, package)
            extension = root/'empty-reply-guard.ts'
            shutil.copy2(EXT, extension)
            host = root/'host'
            shutil.copytree(HOST, host, ignore=shutil.ignore_patterns('node_modules'))
            (host/'node_modules').symlink_to(HOST/'node_modules')
            args = (package, extension, host)
            initial = {p: p.read_bytes() for p in [extension, package/'lib/send-queue.ts', package/'lib/bindings.ts', host/'dist/core/agent-session.js', host/'dist/core/agent-session.d.ts', host/'dist/core/extensions/types.d.ts']}
            with patch.object(m, 'private_write', side_effect=AssertionError('dry run wrote a file')):
                self.assertEqual(m.install(*args)['status'], 'plan')
            result = m.install(*args, True, root/'backups')
            self.assertEqual(m.install(*args, True, root/'backups')['status'], 'already_applied')
            backup = Path(result['backup'])
            self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
            for p in backup.iterdir():
                self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            self.assertEqual(m.rollback(backup)['status'], 'rollback_plan')
            self.assertEqual(m.rollback(backup, True)['status'], 'rolled_back')
            self.assertEqual(m.rollback(backup, True)['status'], 'already_rolled_back')
            for p, data in initial.items():
                self.assertEqual(p.read_bytes(), data)
            for drift in [extension, package/'lib/send-queue.ts', package/'lib/queue.ts']:
                data = drift.read_bytes()
                drift.write_bytes(data+b'\n// drift\n')
                with self.assertRaises(ValueError):
                    m.install(*args, True, root/'backups')
                drift.write_bytes(data)
            # Output staging failure and partial-replacement failure restore inputs.
            replace = m.os.replace
            attempts = 0
            def fault(source, destination):
                nonlocal attempts
                attempts += 1
                if attempts == 2:
                    raise OSError('injected replacement failure')
                return replace(source, destination)
            with patch.object(m.os, 'replace', side_effect=fault):
                with self.assertRaises(OSError):
                    m.install(*args, True, root/'backups')
            for p, data in initial.items():
                self.assertEqual(p.read_bytes(), data)
            self.assertFalse(list(package.rglob('*.duplicate-fix-*')))
            # A mixed install is not accepted as idempotent.
            item = json.loads((m.PATCH/'manifest.json').read_text())['files']['lib/send-queue.ts']
            (package/'lib/send-queue.ts').write_bytes((REPO/item['source']).read_bytes())
            with self.assertRaises(ValueError):
                m.install(*args)
