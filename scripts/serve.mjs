// pages/scripts/serve.mjs — 로컬 테스트용 정적 서버 (배포에는 사용 안 됨; GitHub Pages가 docs/를 서빙)
// 실행: node scripts/serve.mjs  →  http://localhost:5175
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = process.env.PORT || 5175;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const rel = p === '/' ? '/index.html' : p;
  const file = path.join(root, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  });
}).listen(PORT, () => console.log(`\n  📈 [Pages 로컬 테스트]  →  http://localhost:${PORT}\n`));
