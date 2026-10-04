"""Local inference must never fall back, lose thinking budget or apply truncation."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from repair_api.local import LocalBackend, LocalFailure, LocalSettings
from repair_api.main import CONFIG_PATH, create_app, _default_backend_factory, _default_repair_factory
from repair_api.config_override import load_effective_config
from test_api import _source_document


@pytest.fixture
def local_env(monkeypatch):
    monkeypatch.setenv('CREPAIR_ROUTE', 'local')
    monkeypatch.setenv('CREPAIR_LOCAL_URL', 'http://127.0.0.1:8950')
    # Poison API config overrides: local must ignore ALL of them.
    monkeypatch.setenv('CREPAIR_CONFIG_PATH', '/nonexistent/remote.yaml')
    monkeypatch.setenv('CREPAIR_MODEL_ID', 'remote/model')
    monkeypatch.setenv('CREPAIR_REASONING_EFFORT', 'off')
    monkeypatch.setenv('CREPAIR_PROVIDER_ORDER', 'SomeRemoteProvider')
    return load_effective_config(CONFIG_PATH).config


def mock_server(monkeypatch, *, finish='stop', token_count=10, status=200):
    calls = []
    original = httpx.Client
    def respond(request):
        assert request.url.host == '127.0.0.1'
        assert 'authorization' not in request.headers
        body = json.loads(request.content)
        calls.append((request.url.path, body))
        if status != 200:
            return httpx.Response(status, text='SECRET SOURCE', headers={'Location': 'https://example.com'})
        if request.url.path == '/apply-template':
            think = body['chat_template_kwargs'].get('enable_thinking', True)
            return httpx.Response(200, json={'prompt': 'Reasoning effort is set to xhigh\n<think>\n' if think else 'no thinking'})
        if request.url.path == '/tokenize':
            return httpx.Response(200, json={'tokens': [1] * token_count})
        return httpx.Response(200, json={'choices': [{'finish_reason': finish, 'message': {'content': 'FINAL', 'reasoning_content': 'PRIVATE REASONING'}}]})
    def client(**kw):
        assert kw['trust_env'] is False and kw['follow_redirects'] is False
        return original(transport=httpx.MockTransport(respond), **kw)
    monkeypatch.setattr(httpx, 'Client', client)
    return calls


def test_all_roles_local_and_api_overrides_ignored(local_env):
    deps = _default_repair_factory()
    assert deps.config.local_completion_limit == 32768
    for backend in (_default_backend_factory(), deps.backend, deps.infer_backend, deps.semantic_backend, deps.violation_backend):
        assert isinstance(backend, LocalBackend)
        assert backend.base_url == 'http://127.0.0.1:8950/v1'
        assert backend.api_key_env == ''
        assert backend._extra_body == {}
    assert deps.infer_backend.structured and not deps.violation_backend.structured
    assert not deps.backend.structured and not deps.semantic_backend.structured
    cfg = load_effective_config(CONFIG_PATH)
    assert cfg.reasoning_effort == 'xhigh'
    assert cfg.config_source == str(CONFIG_PATH)


@pytest.mark.parametrize('url', ['https://example.com', 'http://localhost:1234', 'http://127.0.0.1.evil:1234', 'http://127.0.0.1:1234/v1', 'http://user@127.0.0.1:1234'])
def test_non_loopback_or_ambiguous_url_rejected(url):
    with pytest.raises(ValueError): LocalSettings.read({'CREPAIR_LOCAL_URL': url})


def test_exact_generation_cap_not_callers_api_budget(local_env, monkeypatch):
    calls = mock_server(monkeypatch)
    assert LocalBackend(local_env).generate('prompt', max_tokens=8, temperature=0) == 'FINAL'
    payload = calls[-1][1]
    assert payload['max_tokens'] == 32768 and payload['temperature'] == 1
    assert payload['chat_template_kwargs']['reasoning_effort'] == 'xhigh'
    assert 'provider' not in payload and 'reasoning' not in payload
    assert 'PRIVATE' not in LocalBackend(local_env).generate('prompt')


def test_structured_roles_disable_thinking(local_env, monkeypatch):
    calls = mock_server(monkeypatch)
    LocalBackend(local_env, structured=True).generate('prompt')
    assert calls[-1][1]['max_tokens'] == 4096
    assert calls[-1][1]['chat_template_kwargs']['enable_thinking'] is False


@pytest.mark.parametrize('structured,code', [(False, 'local_generation_limit'), (True, 'local_structured_limit')])
def test_length_never_returns_partial_output(local_env, monkeypatch, structured, code):
    calls = mock_server(monkeypatch, finish='length')
    with pytest.raises(LocalFailure) as error: LocalBackend(local_env, structured=structured).generate('prompt')
    assert error.value.code == code
    assert len(calls) == 3  # no redraw, retry or reasoning-off fallback


def test_context_failure_before_generation(local_env, monkeypatch):
    calls = mock_server(monkeypatch, token_count=40000)
    with pytest.raises(LocalFailure) as error: LocalBackend(local_env).generate('prompt')
    assert error.value.code == 'local_context'
    assert len(calls) == 2


def test_redirect_is_not_followed_or_logged(local_env, monkeypatch):
    calls = mock_server(monkeypatch, status=307)
    with pytest.raises(LocalFailure) as error: LocalBackend(local_env).generate('prompt')
    assert len(calls) == 1 and 'SECRET' not in error.value.message


def test_scan_propagates_local_failure_instead_of_uncertain(local_env):
    class Failing:
        line_aware_detection = False
        def detect(self, *a, **kw):
            raise LocalFailure('local_structured_limit', 'Increase structured token limit.')
    app = create_app(backend_factory=lambda: Failing())
    with TestClient(app) as client:
        src = _source_document('int f(int n) { return n + 1; }\n')
        aug = client.post('/context/infer', json={'source_document': src}).json()
        aug = client.post('/context/confirm', json={'context_augmentation_set': aug}).json()
        response = client.post('/scan', json={'source_document': src, 'context_augmentation_set': aug})
        assert response.status_code == 422
        assert response.json()['detail']['code'] == 'local_structured_limit'
        assert client.get('/health').json()['capabilities']['routes'] == ['local']


@pytest.mark.parametrize('preset,name', [('qwen36-35b-a3b', 'Qwen3.6-35B-A3B'), ('ornith15-35b-a3b', 'Ornith-1.5-35B-A3B')])
def test_native_thinking_not_qwen38_effort(local_env, monkeypatch, preset, name):
    monkeypatch.setenv('CREPAIR_LOCAL_PRESET', preset)
    monkeypatch.delenv('CREPAIR_LOCAL_EFFORT', raising=False)
    calls = mock_server(monkeypatch)
    cfg = load_effective_config(CONFIG_PATH)
    assert cfg.model == name
    assert cfg.reasoning_effort == 'model'
    assert LocalBackend(cfg.config).generate('code') == 'FINAL'
    payload = calls[-1][1]
    assert payload['model'] == name
    assert payload['temperature'] == 0.6
    assert payload['chat_template_kwargs']['enable_thinking'] is True
    assert 'reasoning_effort' not in payload['chat_template_kwargs']
    monkeypatch.setenv('CREPAIR_LOCAL_EFFORT', 'xhigh')
    with pytest.raises(ValueError): LocalSettings.read()


def test_custom_uses_independent_generation_profiles(local_env, monkeypatch):
    monkeypatch.setenv('CREPAIR_LOCAL_PRESET', 'custom')
    monkeypatch.setenv('CREPAIR_LOCAL_MODEL_NAME', 'My GGUF')
    monkeypatch.setenv('CREPAIR_LOCAL_GENERATION', json.dumps({'temperature': 0.5, 'chat_template_kwargs': {'enable_thinking': True}}))
    monkeypatch.setenv('CREPAIR_LOCAL_STRUCTURED_GENERATION', json.dumps({'top_k': 12, 'chat_template_kwargs': {'enable_thinking': False}}))
    calls = mock_server(monkeypatch)
    cfg = load_effective_config(CONFIG_PATH)
    assert cfg.model == 'My GGUF'
    assert cfg.reasoning_effort == 'custom template'
    LocalBackend(cfg.config).generate('code')
    assert calls[-1][1]['temperature'] == 0.5
    assert 'presence_penalty' not in calls[-1][1]
    LocalBackend(cfg.config, structured=True).generate('declarations')
    assert calls[-1][1]['top_k'] == 12
    assert 'temperature' not in calls[-1][1]
    assert calls[-1][1]['chat_template_kwargs'] == {'enable_thinking': False}
    assert calls[-1][1]['max_tokens'] == 4096


@pytest.mark.parametrize('options', [{'max_tokens': 8}, {'messages': []}, {'base_url': 'https://example.com'}, {'temperature': -1}, {'chat_template_kwargs': []}])
def test_custom_rejects_transport_or_budget_overrides(local_env, monkeypatch, options):
    monkeypatch.setenv('CREPAIR_LOCAL_PRESET', 'custom')
    monkeypatch.setenv('CREPAIR_LOCAL_GENERATION', json.dumps(options))
    with pytest.raises(ValueError): LocalSettings.read()

def test_ornith_structured_stage_disables_thinking_with_own_sampling(local_env, monkeypatch):
    monkeypatch.setenv('CREPAIR_LOCAL_PRESET', 'ornith15-35b-a3b')
    monkeypatch.delenv('CREPAIR_LOCAL_EFFORT', raising=False)
    calls = mock_server(monkeypatch)
    assert LocalBackend(local_env, structured=True).generate('code') == 'FINAL'
    payload = calls[-1][1]
    assert payload['chat_template_kwargs']['enable_thinking'] is False
    assert payload['temperature'] == 0.6
    assert payload['top_p'] == 0.95
    assert payload['presence_penalty'] == 0


@pytest.mark.parametrize('preset', ['qwen38-27b-q4km', 'ornith15-35b-a3b', 'custom'])
@pytest.mark.parametrize('kwargs', [{}, {'enable_thinking': False}, {'enable_thinking': True, 'reasoning_effort': 'low'}])
def test_selected_reasoning_options_reach_template_and_generation(local_env, monkeypatch, preset, kwargs):
    monkeypatch.setenv('CREPAIR_LOCAL_PRESET', preset)
    monkeypatch.setenv('CREPAIR_LOCAL_GENERATION', json.dumps({'chat_template_kwargs': kwargs}))
    calls = mock_server(monkeypatch)
    LocalBackend(local_env).generate('prompt')
    assert calls[0][1]['chat_template_kwargs'] == kwargs
    assert calls[-1][1]['chat_template_kwargs'] == kwargs
    assert calls[-1][1]['max_tokens'] == 32768
    calls.clear()
    LocalBackend(local_env, structured=True).generate('prompt')
    if preset != 'custom':
        assert calls[-1][1]['chat_template_kwargs']['enable_thinking'] is False


def test_explicit_declaration_reasoning_is_independent(local_env, monkeypatch):
    monkeypatch.setenv('CREPAIR_LOCAL_STRUCTURED_GENERATION', json.dumps({'chat_template_kwargs': {'enable_thinking': True, 'reasoning_effort': 'low'}}))
    calls = mock_server(monkeypatch)
    LocalBackend(local_env, structured=True).generate('prompt')
    assert calls[-1][1]['chat_template_kwargs'] == {'enable_thinking': True, 'reasoning_effort': 'low'}
    assert calls[-1][1]['max_tokens'] == 4096

@pytest.mark.parametrize('options,expected', [({}, {'enable_thinking': False}), ({'temperature': 0.5}, {'enable_thinking': False}), ({'chat_template_kwargs': {}}, {}), ({'chat_template_kwargs': {'enable_thinking': True}}, {'enable_thinking': True})])
def test_custom_detection_default_and_explicit_model_default(local_env, monkeypatch, options, expected):
    monkeypatch.setenv('CREPAIR_LOCAL_PRESET', 'custom')
    monkeypatch.setenv('CREPAIR_LOCAL_STRUCTURED_GENERATION', json.dumps(options))
    calls = mock_server(monkeypatch)
    LocalBackend(local_env, structured=True).generate('prompt')
    assert calls[0][1]['chat_template_kwargs'] == expected
    assert calls[-1][1]['chat_template_kwargs'] == expected
    calls.clear()
    LocalBackend(local_env).generate('prompt')
    assert calls[-1][1]['chat_template_kwargs'] == {}


@pytest.mark.parametrize('preset,effort', [('qwen38-27b-q4km', 'medium'), ('qwen38-27b-q4km', 'off'), ('ornith15-35b-a3b', 'off'), ('custom', 'model')])
def test_detection_matches_repair_options_and_budget(local_env, monkeypatch, preset, effort):
    monkeypatch.setenv('CREPAIR_LOCAL_PRESET', preset)
    monkeypatch.setenv('CREPAIR_LOCAL_EFFORT', effort)
    monkeypatch.setenv('CREPAIR_LOCAL_GENERATION', json.dumps({'chat_template_kwargs': {'enable_thinking': effort != 'off', 'reasoning_effort': 'medium'}}))
    monkeypatch.setenv('CREPAIR_LOCAL_STRUCTURED_GENERATION', json.dumps({'chat_template_kwargs': {'enable_thinking': False}}))
    calls = mock_server(monkeypatch)
    LocalBackend(local_env).generate('repair')
    repair = calls[-1][1]
    LocalBackend(local_env, detection=True).generate('scan', max_tokens=1024)
    detection = calls[-1][1]
    assert detection['chat_template_kwargs'] == repair['chat_template_kwargs']
    assert detection['max_tokens'] == repair['max_tokens']
    assert detection['max_tokens'] > 4096

def test_scan_xhigh_repair_medium_and_declarations_off(local_env, monkeypatch):
    monkeypatch.setenv('CREPAIR_LOCAL_PRESET', 'custom')
    monkeypatch.setenv('CREPAIR_LOCAL_GENERATION', json.dumps({
        'temperature': 0.8, 'chat_template_kwargs': {'enable_thinking': True, 'reasoning_effort': 'medium'}}))
    monkeypatch.setenv('CREPAIR_LOCAL_DETECTION_GENERATION', json.dumps({
        'chat_template_kwargs': {'enable_thinking': True, 'reasoning_effort': 'xhigh'}}))
    calls = mock_server(monkeypatch)
    for detection, expected in [(False, 'medium'), (True, 'xhigh')]:
        calls.clear()
        LocalBackend(local_env, detection=detection).generate('prompt')
        assert calls[0][1]['chat_template_kwargs']['reasoning_effort'] == expected
        assert calls[-1][1]['chat_template_kwargs']['reasoning_effort'] == expected
        assert calls[-1][1]['temperature'] == 0.8
        assert calls[-1][1]['max_tokens'] == 32768
    LocalBackend(local_env, structured=True).generate('declarations')
    assert calls[-1][1]['chat_template_kwargs'] == {'enable_thinking': False}
    assert calls[-1][1]['max_tokens'] == 4096
