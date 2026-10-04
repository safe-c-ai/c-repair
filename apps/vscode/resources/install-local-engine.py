"""Extract only verified engine/library archives into a new staging directory."""
import sys, tarfile, zipfile, pathlib, shutil, os
bundle, dest, *wheels = sys.argv[1:]
root = pathlib.Path(dest)
root.mkdir(parents=True, exist_ok=False)
with tarfile.open(bundle, 'r:gz') as archive:
    aliases = []
    for item in archive.getmembers():
        p = pathlib.PurePosixPath(item.name)
        if p.is_absolute() or '..' in p.parts or '\\' in item.name:
            raise ValueError('Invalid engine archive entry')
        if item.isdir(): continue
        if item.issym():
            link = pathlib.PurePosixPath(item.linkname)
            if len(p.parts) != 2 or p.parts[0] != 'engine' or len(link.parts) != 1 or link.is_absolute() or link.name in ('.', '..') or '\\' in item.linkname:
                raise ValueError('Invalid engine archive entry')
            aliases.append((root / p, root / 'engine' / link.name))
            continue
        if not item.isfile(): raise ValueError('Invalid engine archive entry')
        target = root / p
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(item) as src, target.open('xb') as out: shutil.copyfileobj(src, out)
        target.chmod(0o755 if target.name == 'llama-server' or '.so' in target.name else 0o644)
    # Alias only an already-extracted regular library; never create symlinks.
    for target, source in aliases:
        if not source.is_file() or source.is_symlink() or '.so' not in source.name or '.so' not in target.name:
            raise ValueError('Invalid engine archive entry')
        os.link(source, target)
for wheel in wheels:
    with zipfile.ZipFile(wheel) as archive:
        for item in archive.infolist():
            p = pathlib.PurePosixPath(item.filename)
            if p.is_absolute() or '..' in p.parts: raise ValueError('Invalid GPU library archive')
            if item.is_dir(): continue
            if p.name.startswith(('libcublas', 'libcudart')) and '.so' in p.name:
                target = root / 'engine' / p.name
            elif 'license' in p.name.lower():
                target = root / 'licenses' / pathlib.Path(wheel).stem / p.name
            else: continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as src, target.open('wb') as out: shutil.copyfileobj(src, out)
