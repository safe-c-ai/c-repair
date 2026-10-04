"""Extract only the verified uv archive's regular executable; no tar paths."""
import os
from pathlib import Path
import shutil
import sys
import tarfile

archive, destination = map(Path, sys.argv[1:])
destination.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive, 'r:gz') as tar:
    matches=[m for m in tar.getmembers() if m.name=='uv-aarch64-apple-darwin/uv']
    if len(matches)!=1 or not matches[0].isfile() or matches[0].size>256*1024*1024:
        raise ValueError('Invalid uv executable')
    temporary=destination.with_suffix('.staging')
    try:
        with tar.extractfile(matches[0]) as source, temporary.open('wb') as target:
            shutil.copyfileobj(source,target)
        temporary.chmod(0o755)
        os.replace(temporary,destination)
    finally:
        temporary.unlink(missing_ok=True)
