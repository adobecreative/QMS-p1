import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0)))
        d = json.loads(body)
        with open('/tmp/mail.log', 'a') as f:
            for m in d.get('messages', []):
                f.write(json.dumps({'to': m['to'], 'subject': m['subject'], 'rows': m['html'].count('<tr>') - 1, 'from': d.get('fromName'), 'token': d.get('token')}, ensure_ascii=False) + '\n')
            if d.get('messages'):
                open('/tmp/mail_last.html', 'w').write(d['messages'][0]['html'])
        ok = d.get('token') == 'tok-123'
        out = json.dumps({'ok': ok, 'sent': len(d.get('messages', [])) if ok else 0, 'error': None if ok else 'unauthorized'}).encode()
        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', 9000), H).serve_forever()
