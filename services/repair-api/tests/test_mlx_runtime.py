"""Product MLX protocol tests run without Metal; real GPU smoke remains on Mac."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys
import threading
from http.server import HTTPServer

import httpx
import pytest

spec = importlib.util.spec_from_file_location('crepair_mlx_runtime', Path(__file__).resolve().parents[3] / 'apps/vscode/resources/mlx-server.py')
mlx_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mlx_server)


@pytest.fixture
def engine(monkeypatch):
    state = {'closed': False, 'sync': False, 'cleared': False}
    mx = SimpleNamespace(synchronize=lambda: state.update(sync=True), clear_cache=lambda: state.update(cleared=True))
    monkeypatch.setitem(sys.modules, 'mlx', SimpleNamespace(core=mx))
    monkeypatch.setitem(sys.modules, 'mlx.core', mx)
    def stream(*args, **kwargs):
        state['generation'] = kwargs
        try:
            for text, finish in [('reasoning</thi', None), ('nk>answer', 'stop')]:
                yield SimpleNamespace(text=text, finish_reason=finish, prompt_tokens=2, generation_tokens=3)
        finally:
            state['closed'] = True
    monkeypatch.setitem(sys.modules, 'mlx_lm', SimpleNamespace(stream_generate=stream))
    monkeypatch.setitem(sys.modules, 'mlx_lm.sample_utils', SimpleNamespace(
        make_sampler=lambda **kw: state.update(sampler=kw), make_logits_processors=lambda **kw: state.update(processors=kw)))
    e=mlx_server.Engine.__new__(mlx_server.Engine)
    e.context=64
    e.model=object()
    e.tokenizer=SimpleNamespace(apply_chat_template=lambda *a, **k: 'prompt<think>\n', encode=lambda *a, **k: [1,2])
    return e, state


def test_reasoning_boundary_budget_sampling_and_cleanup(engine):
    e,s=engine
    result=e.complete({'messages':[], 'max_tokens':32, 'temperature':.7, 'min_p':.1, 'repeat_penalty':1.1, 'presence_penalty':1.5},lambda:False)
    assert result['choices'][0] == {'finish_reason':'stop','message':{'content':'answer'}}
    assert result['usage']['total_tokens']==5
    assert s['generation']['max_tokens']==32
    assert s['sampler']['min_p']==.1
    assert s['processors']['repetition_penalty']==1.1
    assert s['processors']['presence_penalty']==1.5
    assert s['closed'] and s['sync'] and s['cleared']


def test_context_rejected_before_generation(engine):
    e,s=engine
    with pytest.raises(ValueError,match='context length'):
        e.complete({'messages':[],'max_tokens':64},lambda:False)
    assert 'generation' not in s


def test_cancellation_closes_generator_and_releases_cache(engine):
    e,s=engine
    with pytest.raises(ConnectionAbortedError):
        e.complete({'messages':[],'max_tokens':32},lambda:True)
    assert s['closed'] and s['sync'] and s['cleared']


@pytest.mark.parametrize('thinking,text,expected',[(True,'unclosed thought',''),(False,'answer','answer'),(True,'thought</think>answer','answer')])
def test_thought_filter(thinking,text,expected):
    f=mlx_server.ThoughtFilter(thinking)
    for char in text:f.feed(char)
    assert f.answer==expected


def test_http_protocol_and_browser_rejection(engine):
    e,_=engine
    server=HTTPServer(('127.0.0.1',0),mlx_server.handler(e))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with httpx.Client(base_url=f'http://127.0.0.1:{server.server_port}',trust_env=False) as client:
            assert client.get('/props').json()['default_generation_settings']['n_ctx']==64
            assert client.get('/health').status_code==200
            assert client.post('/apply-template',json={'messages':[]}).json()['prompt'].endswith('<think>\n')
            assert client.post('/tokenize',json={'content':'text'}).json()['tokens']==[1,2]
            result=client.post('/v1/chat/completions',json={'messages':[],'max_tokens':32})
            assert result.json()['choices'][0]['message']['content']=='answer'
            assert client.post('/tokenize',json={'content':'text'},headers={'Origin':'http://untrusted.test'}).status_code==403
    finally:
        server.shutdown();server.server_close();thread.join()


def test_client_disconnect_releases_serial_worker():
    import socket
    import time
    entered, stopped = threading.Event(), threading.Event()
    class FakeEngine:
        context=64
        def complete(self,payload,cancelled):
            entered.set()
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                if cancelled():
                    stopped.set()
                    raise ConnectionAbortedError()
                time.sleep(.01)
            raise RuntimeError('Disconnect was not observed')
    server=HTTPServer(('127.0.0.1',0),mlx_server.handler(FakeEngine()))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        conn=socket.create_connection(('127.0.0.1',server.server_port))
        conn.sendall(b'POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}')
        assert entered.wait(1)
        conn.shutdown(socket.SHUT_RDWR);conn.close()
        assert stopped.wait(2)
        assert httpx.get(f'http://127.0.0.1:{server.server_port}/health',trust_env=False).status_code==200
    finally:
        server.shutdown();server.server_close();thread.join()


@pytest.mark.parametrize('link', [False, True])
def test_uv_bootstrap_extracts_only_regular_executable(tmp_path, link):
    import io
    import subprocess
    import tarfile
    script=Path(__file__).resolve().parents[3]/'apps/vscode/resources/install-mlx-uv.py'
    archive=tmp_path/'uv.tar.gz'
    destination=tmp_path/'engine'/'uv'
    with tarfile.open(archive,'w:gz') as tar:
        member=tarfile.TarInfo('uv-aarch64-apple-darwin/uv')
        if link:
            member.type=tarfile.SYMTYPE;member.linkname='/bin/sh';tar.addfile(member)
        else:
            member.size=7;tar.addfile(member,io.BytesIO(b'fixture'))
        other=tarfile.TarInfo('../must-not-extract');other.size=1;tar.addfile(other,io.BytesIO(b'x'))
    result=subprocess.run([sys.executable,str(script),str(archive),str(destination)],capture_output=True)
    assert (result.returncode==0) is not link
    if not link:
        assert destination.read_bytes()==b'fixture'
        assert destination.stat().st_mode & 0o111
    assert not (tmp_path/'must-not-extract').exists()
