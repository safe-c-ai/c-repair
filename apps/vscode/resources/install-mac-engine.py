"""Extract a verified llama.cpp Mac release without creating archive symlinks."""
import sys, tarfile, pathlib, shutil
bundle, destination, prefix = sys.argv[1:]
root = pathlib.Path(destination)
root.mkdir(parents=True, exist_ok=False)
engine = root / 'engine'
engine.mkdir()
with tarfile.open(bundle, 'r:gz') as archive:
    members = {}
    for item in archive.getmembers():
        p = pathlib.PurePosixPath(item.name)
        if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] != prefix:
            raise ValueError('Invalid Mac engine archive path')
        if item.isdir():
            continue
        if len(p.parts) != 2 or not (item.isfile() or item.issym()):
            raise ValueError('Invalid Mac engine archive entry')
        if p.name in members:
            raise ValueError('Duplicate Mac engine archive entry')
        members[p.name] = item
    def resolve(name, seen):
        if name in seen or name not in members:
            raise ValueError('Invalid Mac engine archive link')
        item = members[name]
        if item.issym():
            target = pathlib.PurePosixPath(item.linkname)
            if target.is_absolute() or len(target.parts) != 1 or target.name in ('.', '..'):
                raise ValueError('Invalid Mac engine archive link')
            return resolve(target.name, seen | {name})
        return item
    for name in members:
        if name != 'llama-server' and not name.endswith('.dylib') and name != 'LICENSE':
            continue
        item = resolve(name, set())
        target = engine / name
        with archive.extractfile(item) as src, target.open('wb') as out:
            shutil.copyfileobj(src, out)
        target.chmod(0o644 if name == 'LICENSE' else 0o755)
    if not (engine / 'llama-server').is_file() or not (engine / 'libggml-metal.0.dylib').is_file():
        raise ValueError('Mac engine archive is missing the server or Metal backend')
