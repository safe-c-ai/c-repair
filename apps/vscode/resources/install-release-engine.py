"""Extract hash-verified official CPU/Windows releases to an isolated directory."""
import pathlib, shutil, stat, sys, tarfile, zipfile
root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=False)
engine = root / 'engine'
engine.mkdir()

def valid(name):
    p = pathlib.PurePosixPath(name)
    if '\\' in name or ':' in name or p.is_absolute() or '..' in p.parts:
        raise ValueError('Invalid engine archive path')
    return p

def wanted(name):
    return name in ('llama-server', 'llama-server.exe') or '.so' in name or name.endswith('.dll') or name.lower().startswith(('license', 'copying'))

def write(name, src):
    target = engine / name
    if target.exists():
        raise ValueError('Duplicate engine archive filename')
    with target.open('wb') as out:
        shutil.copyfileobj(src, out)
    target.chmod(0o755)

for filename in sys.argv[2:]:
    if zipfile.is_zipfile(filename):
        with zipfile.ZipFile(filename) as archive:
            for item in archive.infolist():
                p = valid(item.filename)
                if item.is_dir():
                    continue
                if stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError('Unexpected ZIP symlink')
                if wanted(p.name):
                    with archive.open(item) as src:
                        write(p.name, src)
    else:
        with tarfile.open(filename, 'r:gz') as archive:
            members = {}
            for item in archive.getmembers():
                p = valid(item.name)
                if item.isdir():
                    continue
                if not item.isfile() and not item.issym():
                    raise ValueError('Unexpected TAR entry')
                if item.name in members:
                    raise ValueError('Duplicate TAR entry')
                members[item.name] = item
            def resolve(item, seen):
                if item.name in seen:
                    raise ValueError('Cyclic archive link')
                if item.issym():
                    target = valid(item.linkname)
                    name = str(pathlib.PurePosixPath(item.name).parent / target)
                    if name not in members:
                        raise ValueError('Missing archive link target')
                    return resolve(members[name], seen | {item.name})
                return item
            for item in members.values():
                name = pathlib.PurePosixPath(item.name).name
                if wanted(name):
                    with archive.extractfile(resolve(item, set())) as src:
                        write(name, src)
if not any((engine / name).is_file() for name in ('llama-server', 'llama-server.exe')):
    raise ValueError('Missing llama-server in release')
