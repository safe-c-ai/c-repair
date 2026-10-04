"""Private loopback MLX runtime. One serial Metal worker; no source/prompt logs."""
import argparse
import json
import select
import socket
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


class ThoughtFilter:
    def __init__(self, thinking):
        self.thinking, self.pending, self.answer = thinking, '', ''

    def feed(self, text):
        if not self.thinking:
            self.answer += text
            return
        self.pending += text
        if '</think>' in self.pending:
            _, self.answer = self.pending.split('</think>', 1)
            self.pending = ''
            self.thinking = False
        elif len(self.pending) > 16:
            self.pending = self.pending[-16:]


class Engine:
    def __init__(self, model_path, context, template=''):
        import mlx.core as mx
        from mlx_lm import load
        if not mx.metal.is_available():
            raise RuntimeError('Metal unavailable')
        self.model, self.tokenizer = load(model_path, tokenizer_config={'trust_remote_code': False})
        if template:
            self.tokenizer.chat_template = Path(template).read_text()
        mx.eval(self.model.parameters())
        self.context = context

    def render(self, payload):
        return self.tokenizer.apply_chat_template(payload['messages'], tokenize=False,
            add_generation_prompt=True, **payload.get('chat_template_kwargs', {}))

    def tokens(self, text):
        return self.tokenizer.encode(text, add_special_tokens=False)

    def complete(self, payload, cancelled):
        import mlx.core as mx
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler, make_logits_processors
        prompt = self.render(payload)
        tokens = self.tokens(prompt)
        cap = payload.get('max_tokens', 32768)
        if not isinstance(cap, int) or cap < 1 or len(tokens) + cap > self.context:
            raise ValueError('context length exceeded')
        thought = ThoughtFilter(prompt.endswith('<think>\n'))
        generator = stream_generate(self.model, self.tokenizer, tokens, max_tokens=cap,
            prefill_step_size=512,
            sampler=make_sampler(temp=payload.get('temperature',1), top_p=payload.get('top_p',.95),
                top_k=payload.get('top_k',20), min_p=payload.get('min_p',0)),
            logits_processors=make_logits_processors(
                repetition_penalty=payload.get('repeat_penalty',1) or None,
                repetition_context_size=64, presence_penalty=payload.get('presence_penalty',0) or None,
                presence_context_size=64))
        out = None
        try:
            for out in generator:
                if cancelled():
                    raise ConnectionAbortedError('Client disconnected')
                thought.feed(out.text)
        finally:
            generator.close()
            mx.synchronize()
            mx.clear_cache()
        if out is None:
            raise ValueError('Empty generation')
        return {'choices':[{'finish_reason':out.finish_reason, 'message':{'content':thought.answer if not thought.thinking else ''}}],
            'usage':{'prompt_tokens':out.prompt_tokens,'completion_tokens':out.generation_tokens,
                'total_tokens':out.prompt_tokens+out.generation_tokens}}


def handler(engine):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *args):
            pass

        def send_json(self, status, payload):
            data=json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == '/health': self.send_json(200, {'status':'ok'})
            elif self.path == '/props': self.send_json(200, {'default_generation_settings':{'n_ctx':engine.context}})
            else: self.send_json(404, {'error':'Unknown endpoint'})

        def do_POST(self):
            try:
                # Browser pages must not be able to submit inference to the private runtime.
                if self.headers.get('Origin') or not self.headers.get('Content-Type','').startswith('application/json'):
                    self.send_json(403, {'error':'Forbidden'}); return
                size=int(self.headers.get('Content-Length','0'))
                if size <= 0 or size > 16*1024*1024:
                    self.send_json(413, {'error':'Invalid request size'}); return
                payload=json.loads(self.rfile.read(size))
                def cancelled():
                    if select.select([self.connection],[],[],0)[0]:
                        return self.connection.recv(1,socket.MSG_PEEK) == b''
                    return False
                if self.path == '/apply-template': result={'prompt':engine.render(payload)}
                elif self.path == '/tokenize': result={'tokens':engine.tokens(payload['content'])}
                elif self.path == '/v1/chat/completions': result=engine.complete(payload,cancelled)
                else: self.send_json(404, {'error':'Unknown endpoint'}); return
                self.send_json(200,result)
            except (BrokenPipeError, ConnectionError):
                pass
            except ValueError as error:
                self.send_json(400, {'error':'context length exceeded' if str(error)=='context length exceeded' else 'Invalid model request'})
            except Exception:
                self.send_json(500, {'error':'MLX inference failed'})
    return Handler


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--model',required=True)
    parser.add_argument('--port',type=int,required=True)
    parser.add_argument('--context',type=int,required=True)
    parser.add_argument('--template',default='')
    args=parser.parse_args()
    engine=Engine(args.model,args.context,args.template)
    server=HTTPServer(('127.0.0.1',args.port),handler(engine))
    server.serve_forever()


if __name__ == '__main__':
    main()
