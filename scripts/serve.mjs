// pages/scripts/serve.mjs — 로컬 테스트용 정적 서버 (배포에는 사용 안 됨; GitHub Pages가 docs/를 서빙)
// 실행: node scripts/serve.mjs  →  http://localhost:5175
//
// --mock-github : '✏️ 종목 편집' 저장을 실제 깃허브 없이 시험하는 가짜 API(/__gh/…)를 켠다.
//   http://localhost:<포트>/?ghapi=/__gh 로 열면 편집 창이 api.github.com 대신 이 가짜 API를 쓴다(localhost에서만).
//   · POST /__gh/repos/:owner/:repo/issues → 201 (받은 요청은 GET /__gh/requests 로 확인)
//   · GET  /__gh/repos/:owner/:repo        → 200 (토큰 확인용)
//   · GET  /__gh/new-issue?title=&body=    → 토큰 없이 저장할 때 열리는 '깃허브 이슈 작성 창' 대용
//   · 토큰에 _fail401_ / _fail403_ / _fail404_ / _fail410_ 이 들어 있으면 그 오류로 응답(오류 안내 시험용)
// --port=5176   : 포트 지정(환경변수 PORT보다 우선)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const arg = (name) => process.argv.slice(2).find((a) => a === name || a.startsWith(name + '='));
const PORT = Number((arg('--port') || '').split('=')[1]) || process.env.PORT || 5175;
const MOCK = !!arg('--mock-github');
// 기본은 이 PC에서만 접속(127.0.0.1). 같은 네트워크의 다른 기기에서 열어야 하면 HOST=0.0.0.0 으로 실행.
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const received = []; // 가짜 API가 받은 이슈 생성 요청
const sendJson = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mockGithub(req, res, url) {
  const p = url.pathname.slice('/__gh'.length);
  const token = String(req.headers.authorization || '');
  const forced = /_fail(\d{3})_/.exec(token);
  if (p === '/requests') return sendJson(res, 200, received);
  if (p === '/new-issue') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>가짜 이슈 작성</title><h1>가짜 깃허브 이슈 작성</h1>`
      + `<p id="t">${escHtml(url.searchParams.get('title') || '')}</p><pre id="b">${escHtml(url.searchParams.get('body') || '')}</pre>`);
  }
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p) && req.method === 'GET') {
    if (!token) return sendJson(res, 401, { message: 'Requires authentication' });
    return forced ? sendJson(res, +forced[1], { message: 'forced' }) : sendJson(res, 200, { full_name: p.slice(7) });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/issues$/.test(p) && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      if (!token) return sendJson(res, 401, { message: 'Requires authentication' });
      if (forced) return sendJson(res, +forced[1], { message: 'forced' });
      let j = null;
      try { j = JSON.parse(body); } catch {}
      if (!j || !j.title) return sendJson(res, 422, { message: 'Validation Failed' });
      received.push({ at: new Date().toISOString(), title: j.title, body: j.body, auth: token.replace(/(Bearer \S{6})\S+/, '$1…') });
      sendJson(res, 201, { number: received.length, html_url: `http://localhost:${PORT}/__gh/issue/${received.length}` });
    });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (MOCK && url.pathname.startsWith('/__gh/')) return mockGithub(req, res, url);
  const p = url.pathname;
  const rel = p === '/' ? '/index.html' : p;
  const file = path.join(root, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  });
}).listen(PORT, HOST, () => console.log(`\n  📈 [Pages 로컬 테스트]  →  http://localhost:${PORT}  (바인딩 ${HOST})${MOCK ? '  · 가짜 깃허브 API: ?ghapi=/__gh' : ''}\n`));
