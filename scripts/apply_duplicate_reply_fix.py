#!/usr/bin/env python3
"""Current-install checksum guarded code installation. Default: read-only plan.
Does not start processes, reload extensions, touch configuration or receipts.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import uuid

REPO = Path(__file__).resolve().parents[1]
PATCH = REPO / 'patches/pi-duplicate-reply'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'not a regular file: {path}')
    return path.read_bytes()


def private_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('xb') as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def prepare(package, extension, host):
    manifest = json.loads((PATCH / 'manifest.json').read_text())
    p = json.loads((package / 'package.json').read_text())
    if (p['name'], p['version']) != (manifest['package'], manifest['version']):
        raise ValueError('unsupported package/version')
    if json.loads((host / 'package.json').read_text())['version'] != manifest['pi_version']:
        raise ValueError('unsupported Pi version')
    for name, expected in manifest['host_guards'].items():
        if sha(read_regular(host / name)) != expected:
            raise ValueError(f'Pi lifecycle baseline drift: {name}')
    for name, expected in manifest['guards'].items():
        if sha(read_regular(package / name)) != expected:
            raise ValueError(f'untouched package baseline drift: {name}')
    plan = []
    for name, item in manifest['files'].items():
        target = extension if name == 'empty-reply-guard.ts' else package / name
        before = read_regular(target)
        payload = read_regular(REPO / item['source'])
        if sha(payload) != item['after']:
            raise ValueError(f'patch output drift: {name}')
        actual = sha(before)
        if actual not in (item['before'], item['after']):
            raise ValueError(f'baseline mismatch: {name}')
        plan.append(dict(name=name, target=target, before=before, after=payload,
                         state='after' if actual == item['after'] else 'before'))
    for name, item in manifest.get('host_files', {}).items():
        target = host / name
        before = read_regular(target)
        actual = sha(before)
        if actual not in (item['before'], item['after']):
            raise ValueError(f'Pi patch baseline mismatch: {name}')
        payload = before.decode()
        if actual == item['before']:
            for old, new in item['edits']:
                if payload.count(old) != 1:
                    raise ValueError(f'Pi patch context mismatch: {name}')
                payload = payload.replace(old, new)
        payload = payload.encode()
        if sha(payload) != item['after']:
            raise ValueError(f'Pi patch output mismatch: {name}')
        plan.append(dict(name=name, target=target, before=before, after=payload,
                         state='after' if actual == item['after'] else 'before'))
    states = {item['state'] for item in plan}
    if len(states) != 1:
        raise ValueError('mixed installation; use recorded rollback before applying')
    return plan


def replace_all(items):
    staged = []
    changed = []
    try:
        # Prepare every output before replacing any installed file.
        for item in items:
            target = item['target']
            if read_regular(target) != item['before']:
                raise ValueError(f'concurrent modification: {target}')
            temp = target.with_name(target.name + '.duplicate-fix-' + uuid.uuid4().hex)
            private_write(temp, item['after'])
            os.chmod(temp, target.stat().st_mode & 0o777)
            staged.append((item, temp))
        for item, temp in staged:
            if read_regular(item['target']) != item['before']:
                raise ValueError(f'concurrent modification: {item["target"]}')
            os.replace(temp, item['target'])
            changed.append(item)
    except BaseException:
        for item in reversed(changed):
            # Never overwrite a concurrent third-party edit during rollback.
            if read_regular(item['target']) == item['after']:
                temp = item['target'].with_name(item['target'].name + '.rollback-' + uuid.uuid4().hex)
                private_write(temp, item['before'])
                os.chmod(temp, item['target'].stat().st_mode & 0o777)
                os.replace(temp, item['target'])
        raise
    finally:
        for _, temp in staged:
            temp.unlink(missing_ok=True)


def install(package, extension, host, apply=False, backup_root=None):
    plan = prepare(Path(package), Path(extension), Path(host))
    if plan[0]['state'] == 'after':
        return dict(status='already_applied', production_activation=False)
    result = dict(status='plan', files=[dict(path=str(i['target']), before=sha(i['before']), after=sha(i['after'])) for i in plan], production_activation=False)
    if not apply:
        return result
    if backup_root is None:
        raise ValueError('--backup-root is required with --apply')
    backup = Path(backup_root).resolve() / ('duplicate-reply-' + uuid.uuid4().hex)
    backup.mkdir(parents=True, mode=0o700)
    records = []
    for index, item in enumerate(plan):
        private_write(backup / str(index), item['before'])
        records.append(dict(target=str(item['target'].resolve()), file=str(index), before=sha(item['before']), after=sha(item['after'])))
    private_write(backup / 'rollback.json', json.dumps(dict(version=1, files=records), indent=2).encode())
    replace_all(plan)
    return {**result, 'status': 'applied', 'backup': str(backup)}


def rollback(backup, apply=False):
    backup = Path(backup).resolve()
    records = json.loads(read_regular(backup / 'rollback.json'))['files']
    plan = []
    for item in records:
        source = backup / item['file']
        if source.parent != backup:
            raise ValueError('invalid backup file')
        original = read_regular(source)
        target = Path(item['target'])
        current = read_regular(target)
        if sha(original) != item['before'] or sha(current) not in (item['before'], item['after']):
            raise ValueError('rollback checksum mismatch: ' + str(target))
        if current != original:
            plan.append(dict(target=target, before=current, after=original))
    if apply:
        replace_all(plan)
    return dict(status=('rolled_back' if apply else 'rollback_plan') if plan else 'already_rolled_back', files=[str(i['target']) for i in plan], production_activation=False)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--package-root', type=Path, default=Path.home()/'.pi/agent/npm/node_modules/@llblab/pi-telegram')
    p.add_argument('--extension-file', type=Path, default=Path.home()/'.pi/agent/extensions/empty-reply-guard.ts')
    p.add_argument('--host-root', type=Path, default=Path.home()/'.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent')
    p.add_argument('--apply', action='store_true')
    p.add_argument('--backup-root', type=Path)
    p.add_argument('--rollback', type=Path)
    a = p.parse_args()
    result = rollback(a.rollback, a.apply) if a.rollback else install(a.package_root.resolve(), a.extension_file.resolve(), a.host_root.resolve(), a.apply, a.backup_root)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
