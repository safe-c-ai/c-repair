"""Opt-in synthetic fixture smoke, launched by tools/local-smoke.mjs. No external LLM."""
import os, json, hashlib, time
from pathlib import Path
from fastapi.testclient import TestClient
import httpx
from repair_api.local import LocalBackend, LocalFailure
from repair_api.config_override import load_effective_config
from repair_api.main import CONFIG_PATH, create_app

original_send=httpx.Client.send
calls=[]
metrics={'stages': [], 'completions': []}
current_stage='token-probe'
def guarded(self, request, *args, **kwargs):
    assert request.url.host in ('127.0.0.1','testserver'), 'Unexpected external HTTP request'
    calls.append(request.url.path)
    started=time.monotonic()
    response = original_send(self,request,*args,**kwargs)
    if request.url.path == '/v1/chat/completions' and response.status_code == 200:
        data = response.json()
        # Keep counters only; never persist final answers or reasoning traces here.
        metrics['completions'].append({
            'stage': current_stage, 'seconds': round(time.monotonic()-started, 3),
            'usage': data.get('usage', {}), 'timings': data.get('timings', {}),
            'finish_reason': data.get('choices', [{}])[0].get('finish_reason')})
    return response
httpx.Client.send=guarded
cfg=load_effective_config(CONFIG_PATH).config
# Real model truncation -> explicit setting increase -> successful retry.
os.environ['CREPAIR_LOCAL_COMPLETION']='8'
try:
    LocalBackend(cfg).generate('What is 17 multiplied by 23? Explain briefly.')
    raise AssertionError('Expected truncation with 8 tokens')
except LocalFailure as e:
    assert e.code=='local_generation_limit',e.code
    print('real length error: correct actionable code',flush=True)
os.environ['CREPAIR_LOCAL_COMPLETION']='32768'
assert '391' in LocalBackend(cfg).generate('What is 17 multiplied by 23? Answer with the number.')
print('increased token limit: successful final answer',flush=True)
content='int divide(int numerator, int denominator) {\n    return numerator / denominator;\n}\n'
source={'source_id':'src-local-live','filename':'local_live.c','language':'c','content':content,
        'content_hash':'sha256:'+hashlib.sha256(content.encode()).hexdigest(),
        'size_bytes':len(content.encode()),'origin':'fixture'}
with TestClient(create_app()) as client:
    def post(route,body):
        global current_stage
        current_stage=route
        t=time.monotonic(); r=client.post(route,json=body)
        elapsed=round(time.monotonic()-t,2)
        metrics['stages'].append({'route': route, 'status': r.status_code, 'seconds': elapsed})
        print(route,r.status_code,elapsed,'s',flush=True)
        assert r.status_code==200, r.text[:400]
        return r.json()
    # Exercise actual LLM context inference, not only the compiles-as-is shortcut.
    missing = 'int read_sensor(void) { return sensor_value; }\n'
    missing_source = {**source, 'content': missing,
        'content_hash': 'sha256:' + hashlib.sha256(missing.encode()).hexdigest(),
        'size_bytes': len(missing.encode())}
    inferred = post('/context/infer', {'source_document': missing_source})
    assert inferred['items'], 'Expected missing declaration to be inferred'
    print('LLM context inference: items', len(inferred['items']), flush=True)
    aug=post('/context/infer',{'source_document':source})
    for item in aug['items']:item['confirmed']=True
    aug=post('/context/confirm',{'context_augmentation_set':aug})
    body={'source_document':source,'context_augmentation_set':aug}
    scan=post('/scan',body)
    findings=[(f,v) for f in scan['functions'] for v in f['findings'] if v['kind']=='violation']
    print('violations',len(findings),flush=True)
    assert findings, 'No violation for divide fixture'
    f,v=findings[0]
    candidate=post('/repair',{**body,'function_id':f['function_id'],'finding':v})
    print('candidate',candidate['status'],'hunks',len(candidate['hunks']),
          'gates',[(g['name'],g['status']) for g in candidate['validations']],flush=True)
    Path(os.environ['CREPAIR_SMOKE_OUTPUT']).write_text(json.dumps({'source':content,'candidate':candidate,'metrics':metrics}))
    assert candidate['hunks'], 'No applicable candidate'
    assert len(candidate['validations']) == 5 and all(g['status'] == 'pass' for g in candidate['validations']), 'Validation failed'
print('HTTP paths',sorted(set(calls)),flush=True)
