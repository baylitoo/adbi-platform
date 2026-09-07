import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/query_remote.py"


class RemoteScriptTests(unittest.TestCase):
    def test_chat_reads_env_file_and_sends_bearer(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((self.path, self.headers.get('Authorization'), payload))
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"choices":[{"message":{"content":"ok"}}]}')

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                with tempfile.TemporaryDirectory() as directory:
                    env = Path(directory) / '.env'
                    env.write_text(f'ADBI_LLM_BASE_URL=http://127.0.0.1:{server.server_port}/v1\n'
                                   'ADBI_LLM_MODEL=lfm-test\nADBI_LLM_API_KEY="test-key"\n', encoding='utf-8')
                    result = subprocess.run([sys.executable, str(SCRIPT), 'chat', '--env', str(env)],
                                            capture_output=True, text=True, timeout=10)
            finally:
                server.shutdown()
                worker.join()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(received[0][0], '/v1/chat/completions')
        self.assertEqual(received[0][1], 'Bearer test-key')
        self.assertEqual(received[0][2]['model'], 'lfm-test')
        self.assertNotIn('test-key', result.stdout + result.stderr)
        self.assertIn('Elapsed:', result.stderr)
