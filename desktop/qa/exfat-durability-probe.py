#!/usr/bin/env python3
"""Empirical probe of macOS FSKit exFAT durability, on a scratch 3 GB sparse image only.

Run by hand: python3 desktop/qa/exfat-durability-probe.py [runs=20]
Never touches real drives: it creates its own image and mountpoint under a temporary folder and
only detaches the device that its own `hdiutil attach` reported.

B1  append + sync of the file only (no folder sync): does the new size survive a forced detach?
B2  create + sync of the file only: does the name survive?
B3  does unlink(X) remove ._X; does rename(X, Y) move or remove ._X?
B4  does a directory rename keep the inode numbers of the files inside?
"""
import fcntl, json, os, subprocess, sys, tempfile, time

RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 20
base = os.path.realpath(tempfile.mkdtemp(prefix='exfat-probe-'))
mount = os.path.join(base, 'mount'); os.mkdir(mount)
image = os.path.join(base, 'drive.sparseimage')
device = None

def sh(*args, check=True):
    return subprocess.run(args, capture_output=True, text=True, check=check)

def attach():
    global device
    out = sh('hdiutil', 'attach', '-nobrowse', '-mountpoint', mount, image).stdout
    # First column of the first line is the whole-disk device of THIS image.
    device = out.split()[0]
    assert device.startswith('/dev/disk'), out
    return device

def detach(mode='clean'):
    if mode == 'clean': sh('hdiutil', 'detach', '-quiet', mount, check=False)
    elif mode == 'hdiutil-force': sh('hdiutil', 'detach', '-force', mount, check=False)
    elif mode == 'diskutil-force': sh('diskutil', 'unmountDisk', 'force', device, check=False); sh('hdiutil', 'detach', '-quiet', '-force', device, check=False)
    else: raise ValueError(mode)

def inspect_after(mode, path_in_volume):
    """Simulate the crash for `mode` and return (stat or None) of the file as the re-attached volume shows it."""
    if mode == 'snapshot':
        snap = os.path.join(base, 'snap.sparseimage'); snapmount = os.path.join(base, 'snapmount'); os.makedirs(snapmount, exist_ok=True)
        sh('cp', '-c', image, snap)
        sh('hdiutil', 'attach', '-quiet', '-nobrowse', '-mountpoint', snapmount, snap)
        try: return os.stat(os.path.join(snapmount, os.path.relpath(path_in_volume, mount)))
        except FileNotFoundError: return None
        finally:
            sh('hdiutil', 'detach', '-quiet', '-force', snapmount, check=False); os.unlink(snap)
    return None

def fsync_variant(fd, variant):
    if variant == 'none': return
    if variant == 'fsync': os.fsync(fd)  # plain fsync(2) on macOS
    elif variant == 'F_FULLFSYNC': fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
    else: raise ValueError(variant)

def dir_fsync(path):
    fd = os.open(path, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def cleanup():
    detach('hdiutil-force')
    subprocess.run(['rm', '-rf', base])

try:
    sh('hdiutil', 'create', '-quiet', '-type', 'SPARSE', '-size', '3g', '-fs', 'ExFAT', '-volname', 'PROBE', os.path.join(base, 'drive'))
    attach()
    fstype = sh('diskutil', 'info', mount).stdout
    assert 'ExFAT' in fstype, fstype
    fskit = [line.strip() for line in fstype.splitlines() if 'File System Personality' in line or 'Type (Bundle)' in line]
    results = {'fs': fskit, 'b1': [], 'b2': []}
    variants = [(s, d) for d in ('hdiutil-force', 'diskutil-force', 'snapshot') for s in ('fsync', 'F_FULLFSYNC')] + [('none', 'hdiutil-force'), ('none', 'snapshot')]
    per = RUNS
    # Baseline: every file exists durably with 4096 bytes (file and folder synced, then a clean detach).
    total = per * len(variants)
    for i in range(total):
        p = os.path.join(mount, f'b1-{i:03d}')
        fd = os.open(p, os.O_WRONLY | os.O_CREAT, 0o644); os.write(fd, b'a' * 4096); os.fsync(fd); os.close(fd)
    dir_fsync(mount); os.sync(); detach('clean'); attach()
    k = 0
    for sync, mode in variants:
        for r in range(per):
            p = os.path.join(mount, f'b1-{k:03d}'); k += 1
            fd = os.open(p, os.O_WRONLY | os.O_APPEND)
            os.write(fd, b'b' * 8192)
            fsync_variant(fd, sync)
            before = os.fstat(fd).st_size
            if mode == 'snapshot':
                found = inspect_after(mode, p)   # no close, no folder fsync, volume still mounted
                after = found.st_size if found else None
                os.close(fd)
            else:
                detach(mode)               # no close, no folder fsync
                try: os.close(fd)
                except OSError: pass
                attach()
                after = os.stat(p).st_size
            results['b1'].append({'sync': sync, 'detach': mode, 'run': r, 'before': before, 'after': after, 'kept': after == 12288})
    # B2: create + sync(file) only.
    k = 0
    for sync, mode in variants:
        for r in range(per):
            p = os.path.join(mount, f'b2-{k:03d}'); k += 1
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            os.write(fd, b'c' * 4096)
            fsync_variant(fd, sync)
            if mode == 'snapshot':
                found = inspect_after(mode, p); exists = found is not None; size = found.st_size if found else None
                os.close(fd)
            else:
                detach(mode)
                try: os.close(fd)
                except OSError: pass
                attach()
                exists = os.path.exists(p); size = os.stat(p).st_size if exists else None
            results['b2'].append({'sync': sync, 'detach': mode, 'run': r, 'name_survived': exists, 'size': size})
    # B3: AppleDouble companions.
    b3 = {}
    def listing(): return sorted(n for n in os.listdir(mount) if n.endswith('b3x') or n.endswith('b3y') or n.endswith('b3z'))
    for name in ('b3x',):
        p = os.path.join(mount, name)
        with open(p, 'wb') as f: f.write(b'x')
        sh('xattr', '-w', 'com.probe.test', 'value', p)
        b3['after_create_with_xattr'] = listing()
        os.rename(p, os.path.join(mount, 'b3y'))
        b3['after_rename_x_to_y'] = listing()
        os.unlink(os.path.join(mount, 'b3y'))
        b3['after_unlink_y'] = listing()
    p = os.path.join(mount, 'b3z')
    with open(p, 'wb') as f: f.write(b'x')
    sh('xattr', '-w', 'com.probe.test', 'value', p)
    b3['z_after_create_with_xattr'] = listing()
    os.unlink(p)
    b3['z_after_unlink'] = listing()
    results['b3'] = b3
    # B4: directory rename and inode numbers, before and after a remount.
    d = os.path.join(mount, 'b4d'); os.mkdir(d)
    names = [f'f{i}' for i in range(5)]
    for n in names:
        fd = os.open(os.path.join(d, n), os.O_WRONLY | os.O_CREAT, 0o644); os.write(fd, b'z' * 1000); os.fsync(fd); os.close(fd)
    dir_fsync(d); dir_fsync(mount)
    before = {n: os.stat(os.path.join(d, n)).st_ino for n in names}
    e = os.path.join(mount, 'b4e'); os.rename(d, e)
    after = {n: os.stat(os.path.join(e, n)).st_ino for n in names}
    dir_fsync(mount); os.sync(); detach('clean'); attach()
    remounted = {n: os.stat(os.path.join(e, n)).st_ino for n in names}
    results['b4'] = {'before': before, 'after_rename': after, 'after_remount': remounted,
                     'same_after_rename': before == after, 'same_after_remount': before == remounted}
    print(json.dumps(results, indent=1))
    for key in ('b1', 'b2'):
        print(f'\n{key.upper()} summary (kept/total)')
        for sync, mode in variants:
            rows = [x for x in results[key] if x['sync'] == sync and x['detach'] == mode]
            kept = sum(1 for x in rows if x.get('kept', x.get('name_survived')))
            print(f'  {sync:12s} {mode:15s} {kept}/{len(rows)}')
    open(os.path.join(os.environ.get('PROBE_OUT', '.'), 'exfat-probe-results.json'), 'w').write(json.dumps(results, indent=1))
finally:
    cleanup()
