"""Stage an already-built, pinned Linux CUDA engine for the development VSIX.
Usage: python3 tools/build-local-engine.py <llama-source> <build/bin>
Build with GGML_NATIVE=OFF, AVX2=ON, CUDA architectures=75;80;86;89;90;120, NCCL=OFF.
"""
import sys, pathlib, subprocess, tempfile, shutil, tarfile, json, hashlib, re
root=pathlib.Path(__file__).resolve().parent.parent
source=pathlib.Path(sys.argv[1]).resolve(); binaries=pathlib.Path(sys.argv[2]).resolve()
commit=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
if commit != '9b05354ec6fb58b4e665e9a39ebc40285c015638': raise SystemExit('Unexpected engine source revision')
subprocess.run(['git', '-C', str(source), 'diff', '--quiet', 'HEAD'], check=True)
cache=(binaries.parent/'CMakeCache.txt').read_text()
for option in ['GGML_NATIVE:BOOL=OFF','GGML_CUDA_NCCL:BOOL=OFF','GGML_AVX2:BOOL=ON','GGML_CUDA:BOOL=ON','GGML_FMA:BOOL=ON','GGML_F16C:BOOL=ON']:
    if option not in cache: raise SystemExit('Missing build option: '+option)
architectures = ['75', '80', '86', '89', '90', '120']
match = re.search(r'^CMAKE_CUDA_ARCHITECTURES:[^=]+=(.+)$', cache, re.M)
if not match or match.group(1).split(';') != architectures:
    raise SystemExit('Build must include all supported CUDA targets: ' + ';'.join(architectures))
# Check the binary, not only the build configuration.
elf = subprocess.check_output(['/usr/local/cuda/bin/cuobjdump', '--list-elf', str(binaries/'libggml-cuda.so')], text=True)
for arch in architectures:
    if not re.search(r'sm_' + arch + (r'a?' if arch == '120' else '') + r'(?:[._\s]|$)', elf):
        raise SystemExit('CUDA binary is missing sm_' + arch)
dest=root/'apps/vscode/engine-dist';dest.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='crepair-engine-package-') as temp:
    staging=pathlib.Path(temp); engine=staging/'engine'; engine.mkdir()
    for f in binaries.iterdir():
        if f.name=='llama-server' or '.so' in f.name:
            if f.is_symlink(): (engine/f.name).symlink_to(f.resolve().name)
            else: shutil.copyfile(f,engine/f.name); (engine/f.name).chmod(0o755)
    licenses=staging/'licenses';licenses.mkdir()
    shutil.copyfile(source/'LICENSE',licenses/'llama.cpp-LICENSE')
    for f in (source/'vendor').rglob('*'):
        if f.is_file() and (f.name.upper().startswith(('LICENSE','COPYING')) or f.suffix in ('.h', '.hpp')):
            shutil.copyfile(f,licenses/('-'.join(f.relative_to(source).parts)))
    (licenses/'BUILD.txt').write_text('llama.cpp '+commit+'\nLinux x64 / CUDA sm75,80,86,89,90,120 / AVX2 / NCCL disabled\nBuilt for C Repair; NVIDIA GPU libraries are obtained separately.\n')
    archive=dest/'engine.tar.gz'
    with tarfile.open(archive,'w:gz',dereference=False) as tar:
        for f in sorted(staging.rglob('*')):
            if f.is_file(): tar.add(f,arcname=str(f.relative_to(staging)))
manifest=root/'apps/vscode/resources/local-engine.json'
d=json.loads(manifest.read_text());d.pop('computeCapability', None);d['computeCapabilities']=['7.5','8.0','8.6','8.9','9.0','12.0'];d['id']='linux-x64-cuda-multi-9b05354e-v2';d['sha256']=hashlib.sha256(archive.read_bytes()).hexdigest();d['bytes']=archive.stat().st_size;d['sourceCommit']=commit
manifest.write_text(json.dumps(d,indent=2)+'\n')
print('Packaged',archive.stat().st_size,'bytes',d['sha256'])
