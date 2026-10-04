"""Local llama.cpp transport; CertFix retains all detection and repair logic."""
from __future__ import annotations

import os
import json
import math
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from certfix.inference.api import ApiBackend

from . import cancellation


class LocalFailure(BaseException):
    """Bypass CertFix's broad exception/retry handlers, like RequestCancelled.

    Only sanitized, actionable messages cross the HTTP boundary. Partial output
    and private reasoning never become a candidate or a log entry.
    """
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


def local_enabled() -> bool:
    return os.environ.get('CREPAIR_ROUTE') == 'local'


def positive(env, name, default):
    try:
        value = int(env.get(name, default))
    except (TypeError, ValueError):
        raise ValueError(f'{name} must be a positive integer') from None
    if not 1 <= value <= 1048576:
        raise ValueError(f'{name} must be between 1 and 1048576')
    return value


def generation_options(raw):
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError('Custom generation settings must be a JSON object') from None
    if not isinstance(value, dict):
        raise ValueError('Custom generation settings must be a JSON object')
    ranges = {'temperature': (0, 2), 'top_p': (0, 1), 'top_k': (0, 100000),
              'min_p': (0, 1), 'repeat_penalty': (0, 2), 'presence_penalty': (-2, 2)}
    for key, item in value.items():
        if key == 'chat_template_kwargs':
            if not isinstance(item, dict) or any(v is not None and not isinstance(v, (str, bool, int, float)) for v in item.values()):
                raise ValueError('Template kwargs must contain scalar values')
            if any(isinstance(v, float) and not math.isfinite(v) for v in item.values()):
                raise ValueError('Template kwargs must be finite')
        elif (key not in ranges or isinstance(item, bool) or not isinstance(item, (int, float))
              or not math.isfinite(item) or not ranges[key][0] <= item <= ranges[key][1]
              or (key == 'top_k' and int(item) != item)):
            raise ValueError('Unsupported custom generation setting')
    return value


@dataclass(frozen=True)
class LocalSettings:
    url: str
    context: int
    completion: int
    structured: int
    timeout: int
    effort: str
    preset: str
    model_name: str
    generation: dict
    structured_generation: dict
    detection_generation: dict

    @classmethod
    def read(cls, env=None):
        env = os.environ if env is None else env
        url = env.get('CREPAIR_LOCAL_URL', '').rstrip('/')
        p = urlsplit(url)
        # Numeric loopback only: no DNS, redirects, proxy env, or API fallback.
        if (p.scheme != 'http' or p.hostname != '127.0.0.1' or not p.port
                or p.path or p.query or p.fragment or p.username or p.password):
            raise ValueError('Local server must use http://127.0.0.1:<port>')
        preset = env.get('CREPAIR_LOCAL_PRESET', 'qwen38-27b-q4km')
        names = {'qwen38-27b-q4km': 'Qwen3.8-27B', 'qwen36-35b-a3b': 'Qwen3.6-35B-A3B', 'ornith15-35b-a3b': 'Ornith-1.5-35B-A3B', 'custom': 'Custom local model'}
        if preset not in names:
            raise ValueError('Unknown local preset')
        effort = env.get('CREPAIR_LOCAL_EFFORT', 'xhigh' if preset == 'qwen38-27b-q4km' else 'model')
        allowed = ('off', 'medium', 'xhigh') if preset == 'qwen38-27b-q4km' else ('off', 'model')
        if preset != 'custom' and effort not in allowed:
            raise ValueError('Selected effort is not supported by this local preset')
        model_name = env.get('CREPAIR_LOCAL_MODEL_NAME', names[preset]) if preset == 'custom' else names[preset]
        if not model_name.strip() or '\n' in model_name or '\r' in model_name:
            raise ValueError('Local model name must be a nonempty single line')
        generation = generation_options(env.get('CREPAIR_LOCAL_GENERATION', '{}'))
        detection_generation = generation_options(env.get('CREPAIR_LOCAL_DETECTION_GENERATION', '{}'))
        structured_generation = generation_options(env.get('CREPAIR_LOCAL_STRUCTURED_GENERATION', '{}'))
        settings = cls(url, positive(env, 'CREPAIR_LOCAL_CONTEXT', 65536),
                       positive(env, 'CREPAIR_LOCAL_COMPLETION', 32768),
                       positive(env, 'CREPAIR_LOCAL_STRUCTURED', 4096),
                       positive(env, 'CREPAIR_LOCAL_TIMEOUT', 2400), effort, preset, model_name, generation, structured_generation, detection_generation)
        if max(settings.completion, settings.structured) >= settings.context:
            raise ValueError('Context length must exceed both generation token limits')
        return settings


def effective_local(cfg, source, env):
    from .config_override import EffectiveConfig
    settings = LocalSettings.read(env)
    # Local models use the bundled CERT profiles only. A custom YAML could
    # introduce auxiliary remote backends, so it is deliberately not loaded.
    cfg.detection.backend = 'api'
    for api in [cfg.detection.api, *(r.api for r in cfg.models.values())]:
        api.base_url = settings.url + '/v1'
        api.model = settings.model_name
        api.api_key_env = ''
        api.extra_body = {}
        api.retry_attempts = 0
        api.timeout = settings.timeout
    cfg.detection.api.max_tokens = settings.completion
    for role in cfg.models.values():
        role.backend = 'api'
        role.api.max_tokens = settings.completion
        role.max_tokens = settings.completion
    cfg.fix.simple_max_tokens = settings.completion
    return EffectiveConfig(cfg, settings.model_name, [], str(source),
                           'custom template' if settings.preset == 'custom' else settings.effort,
                           'custom template' if settings.preset == 'custom' else settings.effort, 'none')


class LocalBackend(ApiBackend):
    def __init__(self, cfg, *, detection=False, structured=False):
        self.local = LocalSettings.read()
        self.structured = structured
        self.detection = detection
        profile = cfg.detection.prompt_profile if detection else None
        super().__init__(
            base_url=self.local.url + '/v1', model=self.local.model_name, api_key_env='',
            timeout=self.local.timeout, retry_attempts=0, prompt_profile=profile,
            qwen36_rule_id_strategy=cfg.detection.qwen36_rule_id_strategy,
            qwen36_selector_candidate_k=cfg.detection.qwen36_selector_candidate_k,
            qwen36_selector_permutations=cfg.detection.qwen36_selector_permutations,
        )

    def _chat_completion(self, prompt, max_tokens=None, temperature=None):
        cancellation.raise_if_current_cancelled()
        cap = self.local.structured if self.structured else self.local.completion
        thinking = not self.structured and self.local.effort != 'off'
        kwargs = {'enable_thinking': thinking, 'preserve_thinking': True}
        if self.local.preset == 'qwen38-27b-q4km':
            kwargs['reasoning_effort'] = self.local.effort if thinking else 'medium'
        options = self.local.structured_generation if self.structured else {**self.local.generation, **(self.local.detection_generation if self.detection else {})}
        if 'chat_template_kwargs' in options:
            kwargs = options['chat_template_kwargs']
            thinking = kwargs.get('enable_thinking', True) is not False
        sampling = {'temperature': (0.6 if self.local.preset == 'qwen36-35b-a3b' else 1.0) if thinking else 0.7,
                    'top_p': 0.95 if thinking else 0.8, 'top_k': 20, 'min_p': 0.0,
                    'repeat_penalty': 1.0, 'presence_penalty': 0.0 if thinking else 1.5}
        if self.local.preset == 'ornith15-35b-a3b':
            sampling = {'temperature': 0.6, 'top_p': 0.95, 'top_k': 20,
                        'min_p': 0.0, 'repeat_penalty': 1.0, 'presence_penalty': 0.0}
        if self.local.preset == 'custom':
            # No Qwen template or sampling assumptions for custom models.
            kwargs = options.get('chat_template_kwargs', {'enable_thinking': False} if self.structured else {})
            sampling = {k: v for k, v in options.items() if k != 'chat_template_kwargs'}
        messages = [{'role': 'user', 'content': prompt}]
        # Context is checked with the server's actual template and tokenizer.
        with cancellation.local_http_cancellation() as extensions, httpx.Client(timeout=self.local.timeout, trust_env=False,
                          follow_redirects=False) as client:
            def post(path, payload):
                cancellation.raise_if_current_cancelled()
                try:
                    response = client.post(self.local.url + path, json=payload, extensions=extensions)
                except httpx.TimeoutException:
                    raise LocalFailure('local_timeout', 'Local inference timed out. Increase the local inference timeout or adjust GPU/RAM placement.') from None
                except httpx.HTTPError:
                    cancellation.raise_if_current_cancelled()
                    raise LocalFailure('local_unavailable', 'Local inference server disconnected. Check the model runtime and available memory.') from None
                cancellation.raise_if_current_cancelled()
                if response.status_code >= 300:
                    # Inspect only to classify, never echo server text (may contain source).
                    body = response.text.lower()
                    context_error = response.status_code == 400 and any(t in body for t in ('context size', 'context length', 'exceed_context', 'context window'))
                    if context_error:
                        raise LocalFailure('local_context', 'Not enough context capacity. Increase the local context length and reload the model.')
                    raise LocalFailure('local_runtime', f'Local runtime rejected the request (HTTP {response.status_code}). Check runtime compatibility and available memory.')
                try:
                    return response.json()
                except ValueError:
                    raise LocalFailure('local_response', 'Local runtime returned an invalid response.') from None
            rendered = post('/apply-template', {'messages': messages, 'chat_template_kwargs': kwargs})
            if not isinstance(rendered, dict) or not isinstance(rendered.get('prompt'), str):
                raise LocalFailure('local_template', 'The local runtime cannot render the model chat template.')
            text = rendered['prompt']
            if self.local.preset != 'custom' and thinking and (not text.endswith('<think>\n') or (self.local.preset == 'qwen38-27b-q4km' and kwargs.get('reasoning_effort') == 'xhigh' and 'Reasoning effort is set to xhigh' not in text)):
                raise LocalFailure('local_template', 'The model template does not support the selected thinking effort. Use a compatible model template/runtime.')
            tokens = post('/tokenize', {'content': text, 'add_special': False})
            if not isinstance(tokens, dict) or not isinstance(tokens.get('tokens'), list):
                raise LocalFailure('local_response', 'The local runtime cannot count input tokens.')
            count = len(tokens['tokens'])
            if count + cap > self.local.context:
                raise LocalFailure('local_context', f'Input ({count}) + generation limit ({cap}) exceeds context length ({self.local.context}). Increase the local context length and reload the model.')
            payload = {'model': self.model, 'messages': messages, 'max_tokens': cap,
                       **sampling,
                       'chat_template_kwargs': kwargs, 'reasoning_format': 'deepseek',
                       'n': 1, 'stream': False, 'cache_prompt': True}
            data = post('/v1/chat/completions', payload)
        from .usage_tracker import tracker, _record_finish_reason
        try:
            choice = data['choices'][0]
            finish = choice['finish_reason']
            content = choice['message']['content']
        except (KeyError, IndexError, TypeError):
            raise LocalFailure('local_response', 'Local runtime returned an invalid completion.') from None
        tracker.add_from_response_json(data)
        self._record_usage(data)
        _record_finish_reason(finish if isinstance(finish, str) else None)
        if finish in ('length', 'max_tokens'):
            code = 'local_structured_limit' if self.structured else 'local_generation_limit'
            raise LocalFailure(code, f'Generation reached the {cap}-token limit before completing. Increase the local generation limit and try again. A larger context may also be needed.')
        if finish != 'stop' or not isinstance(content, str) or not content.strip() or '<think>' in content or '</think>' in content:
            raise LocalFailure('local_response', 'The local model did not return a complete final answer. Check its chat template and reasoning parser.')
        return content
