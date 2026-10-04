"""Opt-in sample_sensor Scan timing against an already running loopback model.

Usage: CREPAIR_LOCAL_URL=http://127.0.0.1:PORT <venv>/python
       services/repair-api/scripts/local-scan-benchmark.py OUTPUT.json
No runtime is started/stopped. No source, prompts or reasoning traces are logged.
The fixture context is fixed so comparisons measure Scan, not declaration inference.
"""
import hashlib
import json
import os
import sys
import subprocess
import threading
import time
from pathlib import Path

import httpx

os.environ['CREPAIR_ROUTE'] = 'local'
os.environ['CREPAIR_LOCAL_PRESET'] = 'custom'
os.environ['CREPAIR_LOCAL_GENERATION'] = json.dumps({
    'temperature': 1.0, 'top_p': 0.95, 'top_k': 20, 'min_p': 0.0,
    'repeat_penalty': 1.0, 'presence_penalty': 0.0,
    'chat_template_kwargs': {'enable_thinking': True, 'reasoning_effort': 'medium'},
})
from repair_api.local import LocalBackend
from repair_api.main import CONFIG_PATH
from repair_api.config_override import load_effective_config
from repair_api.adapter.certfix_adapter import run_scan

root = Path(__file__).resolve().parents[3]
source = (root / 'tests/fixtures/source/sample_sensor.c').read_text()
context = json.loads((root / 'tests/fixtures/context/sample_sensor.augmentation.json').read_text())
output = Path(sys.argv[1])
metrics = {'fixture': 'sample_sensor.c', 'reasoning': 'medium', 'seed': 42,
           'context': 'fixed confirmed fixture', 'requests': [], 'status': 'running',
           'gpu_peak_used_mib': 0}
stop_sampling = threading.Event()
def sample_memory():
    while not stop_sampling.is_set():
        try:
            used = int(subprocess.check_output(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], text=True, timeout=2).splitlines()[0])
            metrics['gpu_peak_used_mib'] = max(metrics.get('gpu_peak_used_mib', 0), used)
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        stop_sampling.wait(2)
sampler = threading.Thread(target=sample_memory, daemon=True)
sampler.start()
original_send = httpx.Client.send
started = time.monotonic()
current_step = 'violation_check'
def tag_step(method, step):
    def tagged(self, *args, **kwargs):
        global current_step
        previous = current_step
        current_step = step
        try:
            return method(self, *args, **kwargs)
        finally:
            current_step = previous
    return tagged
for method, step in [('_complete_rule_candidate_prompt', 'rule_candidates'),
                     ('_complete_rule_selector_prompt', 'rule_voting'),
                     ('_complete_rule_selection_prompt', 'rule_selection')]:
    setattr(LocalBackend, method, tag_step(getattr(LocalBackend, method), step))

def save():
    output.write_text(json.dumps(metrics, indent=2) + '\n')

def measured(self, request, *args, **kwargs):
    assert request.url.host == '127.0.0.1', 'Benchmark must remain local'
    if request.url.path == '/v1/chat/completions':
        payload = json.loads(request.content)
        payload['seed'] = 42
        request = httpx.Request(request.method, request.url, json=payload,
                                extensions=request.extensions)
    t = time.monotonic()
    response = original_send(self, request, *args, **kwargs)
    row = {'stage': current_step, 'path': request.url.path, 'seconds': time.monotonic() - t,
           'status': response.status_code}
    if request.url.path == '/v1/chat/completions' and response.status_code == 200:
        data = response.json()
        row.update(usage=data.get('usage', {}), timings=data.get('timings', {}),
                   finish=data.get('choices', [{}])[0].get('finish_reason'))
        print(json.dumps(row), flush=True)
    metrics['requests'].append(row)
    save()
    return response

httpx.Client.send = measured
try:
    backend = LocalBackend(load_effective_config(CONFIG_PATH).config, detection=True)
    result = run_scan(backend=backend, source_id='src-mtp-benchmark', original_content=source,
                      original_hash='sha256:' + hashlib.sha256(source.encode()).hexdigest(),
                      context_revision_id='ctx-benchmark', items=context['items'],
                      prelude_line_count=context['prelude_line_count'])
    metrics['findings'] = [{'function': f['name'], 'kind': v['kind'], 'rule': v.get('rule_id')}
                           for f in result['functions'] for v in f['findings']]
    metrics['status'] = 'complete'
except BaseException as error:
    metrics['status'] = 'failed'
    metrics['error_type'] = type(error).__name__
    raise
finally:
    stop_sampling.set()
    sampler.join(timeout=3)
    metrics['seconds'] = time.monotonic() - started
    save()
    print(json.dumps({k: v for k, v in metrics.items() if k != 'requests'}), flush=True)
