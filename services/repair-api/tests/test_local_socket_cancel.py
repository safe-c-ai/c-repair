"""Real TCP regression: local cancel must interrupt an unread completion."""
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from repair_api import cancellation, usage_tracker
from repair_api.local import LocalBackend
from repair_api.main import CONFIG_PATH
from repair_api.config_override import load_effective_config


def test_local_cancel_interrupts_live_socket_and_allows_retry(monkeypatch):
    started, disconnected, release = (threading.Event() for _ in range(3))
    completions = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *_):
            pass
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            if self.path == '/apply-template':
                body = {'prompt': 'Reasoning effort is set to xhigh\n<think>\n'}
            elif self.path == '/tokenize':
                body = {'tokens': [1]}
            else:
                completions.append(1)
                if len(completions) == 1:
                    started.set()
                    self.connection.settimeout(.1)
                    while not release.is_set():
                        try:
                            if self.connection.recv(1) == b'':
                                disconnected.set()
                                return
                        except socket.timeout:
                            pass
                    return
                body = {'choices': [{'finish_reason': 'stop', 'message': {'content': 'OK'}}]}
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    monkeypatch.setenv('CREPAIR_ROUTE', 'local')
    monkeypatch.setenv('CREPAIR_LOCAL_URL', f'http://127.0.0.1:{server.server_port}')
    cfg = load_effective_config(CONFIG_PATH).config
    token = cancellation.CancelToken()
    errors = []
    usage_tracker.install()

    def run():
        cancellation.set_current_token(token)
        try:
            LocalBackend(cfg).generate('test')
        except BaseException as exc:
            errors.append(exc)
        finally:
            cancellation.set_current_token(None)

    worker = threading.Thread(target=run, daemon=True)
    try:
        worker.start()
        assert started.wait(3)
        cancelled_at = time.monotonic()
        token.cancel()
        assert time.monotonic() - cancelled_at < 2, 'cancel callback blocked the event loop'
        assert disconnected.wait(2), 'runtime socket remained open after cancellation'
        worker.join(2)
        assert not worker.is_alive(), 'bridge remained blocked in read'
        assert len(errors) == 1 and isinstance(errors[0], cancellation.RequestCancelled)
        assert LocalBackend(cfg).generate('retry') == 'OK'
        assert len(completions) == 2
    finally:
        release.set()
        worker.join(3)
        server.shutdown()
        server.server_close()
        serving.join(2)
