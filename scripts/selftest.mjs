// pages/scripts/selftest.mjs — 오프라인 자체 테스트 (외부 접속 없음)
// 실행: node scripts/selftest.mjs   (pages 폴더에서)
//
// · 네트워크는 가짜 fetch로 대체한다. 등록되지 않은 주소로 나가려 하면 차단하고 테스트를 실패시킨다.
// · 데이터는 OS 임시 폴더에만 쓰고 지운다 — 실제 docs/data, 외부 API, 저장소를 건드리지 않는다.
// · API 키 자리에는 가짜 값만 넣는다(가짜 fetch만 받으므로 어디에도 전송되지 않음).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- 가짜 네트워크 ----------
const NET = { routes: [], calls: [], blocked: [] };
globalThis.fetch = async (url) => {
  const u = String(url);
  NET.calls.push(u);
  for (const r of NET.routes) { const m = u.match(r.re); if (m) return r.fn(m, u); }
  NET.blocked.push(u);
  throw new Error(`[selftest] 등록되지 않은 외부 호출 차단: ${u}`);
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const text = (s, status = 200) => new Response(s, { status });
const geminiCalls = (model) => NET.calls.filter((u) => u.includes('generativelanguage') && (!model || u.includes(`/models/${model}:`))).length;

// ---------- 픽스처(실제 응답 형태를 본뜬 최소 데이터) ----------
const DAY = 86400;
function yahooChart(sym) {
  const isKR = /\.K[SQ]$/.test(sym);
  const base = sym === '^VIX' ? 18 : sym === 'KRW=X' ? 1390 : sym === 'JPYKRW=X' ? 9.3 : isKR ? 70000 : 200;
  const now = Math.floor(Date.now() / 1000);
  const ts = Array.from({ length: 130 }, (_, i) => now - (130 - i) * DAY);
  const closes = ts.map((_, i) => +(base * (1 + 0.001 * i)).toFixed(2));
  return { chart: { result: [{
    meta: {
      regularMarketPrice: closes.at(-1), chartPreviousClose: closes.at(-2), currency: isKR ? 'KRW' : 'USD', shortName: sym,
      regularMarketDayHigh: base * 1.2, regularMarketDayLow: base * 0.9, regularMarketOpen: base, regularMarketVolume: 1000,
      regularMarketTime: now, currentTradingPeriod: { regular: { start: now - 3600, end: now + 3600 } }, instrumentType: 'EQUITY',
    },
    timestamp: ts, indicators: { quote: [{ close: closes }] },
  }] } };
}
const naverStock = (code, pct) => ({ datas: [{
  stockName: `종목${code}`, closePrice: '70,000', compareToPreviousClosePrice: String(Math.round(Math.abs(70000 * pct / 100))),
  fluctuationsRatio: String(Math.abs(pct)), compareToPreviousPrice: { name: pct > 0 ? 'RISING' : pct < 0 ? 'FALLING' : 'EVEN' },
  openPrice: '69,000', highPrice: '71,000', lowPrice: '68,000', accumulatedTradingVolume: '1,234,567',
  marketStatus: 'OPEN', localTradedAt: new Date().toISOString(),
}] });
const naverIndex = { datas: [{ closePriceRaw: '2,600.00', compareToPreviousClosePriceRaw: '-31.5', fluctuationsRatioRaw: '-1.20', marketStatus: 'OPEN' }] };
const trendStock = [{ bizdate: '20261015', foreignerPureBuyQuant: '-1,000', organPureBuyQuant: '500', individualPureBuyQuant: '500', foreignerHoldRatio: '50.00%' }];
const trendIndex = { bizdate: '20261015', personalValue: '+1,000', foreignValue: '-800', institutionalValue: '-200' };
function rss() {
  const pub = new Date(Date.now() - 3600e3).toUTCString(); // 최근 2일 필터 통과
  const items = [1, 2, 3].map((i) => `<item><title>테스트 뉴스 ${i} 급등 - 테스트일보</title><link>https://news.example.com/a${i}</link><pubDate>${pub}</pubDate><source url="https://news.example.com">테스트일보</source></item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}
// 지수 브리핑(summary·items)과 종목 분석(headline·factors) 양쪽 형식을 모두 만족하는 응답
const geminiOk = { candidates: [{ content: { parts: [{ text: JSON.stringify({
  summary: '테스트 요약', items: [{ index: 1, why: '핵심 재료' }], headline: '테스트 진단', factors: ['요인1', '요인2'], outlook: '관전 포인트',
}) }] } }] };

function routes({ krPct = { '005930': 4.2, '000660': 0.3 }, yahoo = (m) => json(yahooChart(decodeURIComponent(m[1]))), gemini = () => json(geminiOk) } = {}) {
  return [
    { re: /polling\.finance\.naver\.com\/api\/realtime\/domestic\/stock\/(\d{6})/, fn: (m) => json(naverStock(m[1], krPct[m[1]] ?? 0.5)) },
    { re: /polling\.finance\.naver\.com\/api\/realtime\/domestic\/index\/(KOSPI|KOSDAQ)/, fn: () => json(naverIndex) },
    { re: /m\.stock\.naver\.com\/api\/stock\/(\d{6})\/trend/, fn: () => json(trendStock) },
    { re: /m\.stock\.naver\.com\/api\/index\/(KOSPI|KOSDAQ)\/trend/, fn: () => json(trendIndex) },
    { re: /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/([^?]+)/, fn: yahoo },
    { re: /news\.google\.com\/rss\/search/, fn: () => text(rss()) },
    { re: /generativelanguage\.googleapis\.com\/v1beta\/models\/([^:]+):generateContent/, fn: (m) => gemini(decodeURIComponent(m[1])) },
  ];
}

// ---------- 임시 작업공간 ----------
const FILES = ['analysis.json', 'history.json', 'investors.json', 'market.json', 'news.json', 'quotes.json', 'status.json'];
const ITEMS = [{ code: '005930', market: 'KR', name: '삼성전자' }, { code: '000660', market: 'KR', name: 'SK하이닉스' }, { code: 'AAPL', market: 'US', name: '애플' }];
const workspaces = [];
function workspace(items = ITEMS, seed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-selftest-'));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'watchlist.json'), typeof items === 'string' ? items : JSON.stringify({ items }));
  if (seed) for (const f of FILES) fs.writeFileSync(file(root, f), JSON.stringify({ seed: f }));
  return root;
}
const file = (root, f) => path.join(root, 'docs', 'data', f);
const read = (root, f) => JSON.parse(fs.readFileSync(file(root, f), 'utf8'));
const raw = (root, f) => fs.readFileSync(file(root, f), 'utf8');

// 파이프라인 로그는 모아 두고(실패 시 원인 확인용) 화면에는 결과만 보여준다
async function quiet(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(' '));
  try { return { value: await fn(), lines }; } finally { Object.assign(console, orig); }
}
async function pipeline(root, routeOpts) {
  NET.routes = routes(routeOpts); NET.calls = []; NET.blocked = [];
  return quiet(() => run({ root }));
}

// ---------- 테스트 러너 ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (e) { results.push({ ok: false, name, err: e }); }
}

// 가짜 키·모델명 — 가짜 fetch만 받는다
process.env.GEMINI_API_KEY = 'selftest-dummy-key';
process.env.GEMINI_MODEL = 'model-primary';
process.env.GEMINI_FALLBACK_MODELS = 'model-fallback';
const util = await import('./util.mjs');
const src = await import('./sources.mjs');
const { run } = await import('./fetch.mjs');

console.log('[selftest] 오프라인 자체 테스트 — 외부 접속 없음\n');

// ===== 단위 =====
await test('설정 검증: 숫자로 적은 국내 코드의 앞자리 0 보정', () => {
  const r = util.validateWatchlist({ items: [{ code: 5930, market: 'KR', name: '삼성' }] });
  assert.equal(r.items[0].code, '005930');
  assert.ok(r.warnings.some((w) => w.includes('보정')));
});
await test('설정 검증: 티커 대문자·시장 추정·중복·형식 오류 제외', () => {
  const r = util.validateWatchlist({ items: [{ code: 'aapl' }, { code: 'AAPL', market: 'US' }, { code: '005930' }, { code: 'ABC123', market: 'KR' }, { code: '<script>', market: 'US' }, {}] });
  assert.deepEqual(r.items.map((x) => [x.code, x.market]), [['AAPL', 'US'], ['005930', 'KR']]);
  assert.equal(r.warnings.length, 4);
});
await test('설정 검증: 국내 6자리 코드를 US로 잘못 적으면 KR로 보정', () => {
  const r = util.validateWatchlist({ items: [{ code: '222800', market: 'US', name: '심텍' }] });
  assert.deepEqual(r.items[0], { code: '222800', market: 'KR', name: '심텍' });
  assert.ok(r.warnings[0].includes('KR로 보정'));
});
await test('설정 검증: 40개 초과분 제외 · items 누락', () => {
  const r = util.validateWatchlist({ items: Array.from({ length: 45 }, (_, i) => ({ code: String(100000 + i) })) });
  assert.equal(r.items.length, 40);
  assert.ok(r.warnings.some((w) => w.includes('최대 40')));
  assert.equal(util.validateWatchlist({}).items.length, 0);
  assert.equal(util.validateWatchlist(null).warnings[0], 'items 배열이 없습니다');
});
await test('원자적 쓰기: 내용 일치 · 임시 파일 안 남음', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-atomic-'));
  workspaces.push(dir);
  const f = path.join(dir, 'a.json');
  util.writeJsonAtomic(f, { x: 1 });
  util.writeJsonAtomic(f, { x: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { x: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
});
await test('동시 실행 제한: 최대 동시 수 준수 · 결과 순서 유지', async () => {
  let active = 0, peak = 0;
  const out = await util.mapLimit([...Array(12).keys()], 5, async (x) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--; return x * 2;
  });
  assert.equal(peak, 5);
  assert.deepEqual(out, [...Array(12).keys()].map((x) => x * 2));
});
await test('분석 시그니처: 1% 구간 안의 변동은 같음 · 구간·뉴스 변화는 다름', () => {
  const n = { items: [{ title: 'A' }] };
  assert.equal(util.analysisSig({ changePct: 2.2 }, n, null), util.analysisSig({ changePct: 2.4 }, n, null));
  assert.notEqual(util.analysisSig({ changePct: 2.4 }, n, null), util.analysisSig({ changePct: 2.6 }, n, null));
  assert.notEqual(util.analysisSig({ changePct: 2.2 }, n, null), util.analysisSig({ changePct: 2.2 }, { items: [{ title: 'B' }] }, null));
});
await test('감성 태깅: 한글 부분일치 · 영문 단어경계(mission≠miss)', () => {
  assert.equal(src.tagSentiment('삼성전자 급등, 사상최대 실적').tone, 'pos');
  assert.equal(src.tagSentiment('실적 쇼크로 급락').tone, 'neg');
  assert.equal(src.tagSentiment('NASA mission update').tone, 'neutral');
});

// ===== 파이프라인(가짜 네트워크) =====
await test('정상: 7개 파일 생성 · 급등락만 AI 분석 · AI 상태 정상 · 외부 차단 0건', async () => {
  const root = workspace();
  const { value } = await pipeline(root);
  assert.deepEqual([...value.written].sort(), FILES);
  const q = read(root, 'quotes.json').quotes;
  assert.equal(q.length, 3);
  assert.ok(q.every((x) => x.ok));
  const a = read(root, 'analysis.json');
  assert.ok(a['005930']?.headline, '+4.2% 종목은 분석');
  assert.equal(a['000660'], undefined, '+0.3% 종목은 분석 안 함');
  assert.equal(a['005930'].model, 'model-primary');
  assert.deepEqual(read(root, 'status.json'), { ai: { state: 'ok', model: 'model-primary', fallback: false } });
  const m = read(root, 'market.json');
  assert.equal(m.briefs.length, 2);
  assert.ok(m.briefs[0].reason.ai, '지수 브리핑 AI');
  assert.ok(read(root, 'history.json').AAPL.closes.length > 100);
  assert.equal(read(root, 'investors.json').AAPL, undefined, '해외 종목 수급 없음');
  assert.equal(NET.blocked.length, 0, `차단된 호출: ${NET.blocked.join(', ')}`);
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs', 'data')).filter((f) => f.endsWith('.tmp')), []);
});
await test('시그니처 재사용: 입력이 같으면 두 번째 회차 AI 호출 0회', async () => {
  const root = workspace();
  await pipeline(root);
  assert.ok(geminiCalls() > 0);
  const before = raw(root, 'analysis.json');
  await pipeline(root);
  const statusBefore = raw(root, 'status.json');
  assert.equal(geminiCalls(), 0);
  assert.equal(raw(root, 'analysis.json'), before);
  assert.equal(raw(root, 'status.json'), statusBefore, 'AI 호출이 없던 회차는 상태 파일을 건드리지 않음');
});
await test('전부 실패: 기존 데이터 파일 모두 그대로 · 예외 없이 종료', async () => {
  const root = workspace(ITEMS, true);
  const seeds = Object.fromEntries(FILES.map((f) => [f, raw(root, f)]));
  NET.routes = [{ re: /./, fn: () => { throw new TypeError('fetch failed'); } }];
  NET.calls = []; NET.blocked = [];
  const { value } = await quiet(() => run({ root }));
  assert.deepEqual(value.written, []);
  for (const f of FILES) assert.equal(raw(root, f), seeds[f], `${f} 보존`);
});
await test('부분 실패: 야후 장애 → 국내 시세는 갱신, 과거시세 파일은 보존', async () => {
  const root = workspace(ITEMS, true);
  const histSeed = raw(root, 'history.json');
  await pipeline(root, { yahoo: () => text('upstream error', 500) });
  const q = read(root, 'quotes.json').quotes;
  assert.ok(q.find((x) => x.code === '005930').ok);
  assert.equal(q.find((x) => x.code === 'AAPL').ok, false);
  assert.equal(raw(root, 'history.json'), histSeed, '과거시세는 기존 유지');
  assert.equal(read(root, 'market.json').indices.length, 2, '국내 지수만');
});
await test('AI 대체 모델: 주 모델 404 → 대체 모델로 분석, 주 모델은 1회만 시도', async () => {
  const root = workspace();
  const gemini = (model) => (model === 'model-primary'
    ? json({ error: { code: 404, message: 'models/model-primary is not found' } }, 404)
    : json(geminiOk));
  const { lines } = await pipeline(root, { gemini });
  assert.equal(read(root, 'analysis.json')['005930'].model, 'model-fallback');
  assert.equal(geminiCalls('model-primary'), 1);
  assert.ok(lines.some((l) => l.includes('모델 사용 불가(model-primary)')));
  assert.deepEqual(read(root, 'status.json').ai, { state: 'ok', model: 'model-fallback', fallback: true });
});
await test('AI 키 오류(403): 첫 호출 뒤 회차 내 AI 중지', async () => {
  const root = workspace();
  const { value } = await pipeline(root, { gemini: () => json({ error: { code: 403 } }, 403) });
  assert.equal(geminiCalls(), 1);
  assert.equal(value.ai.disabled, 'auth');
  assert.equal(read(root, 'status.json').ai.state, 'auth');
  assert.ok(read(root, 'quotes.json').quotes.every((x) => x.ok), 'AI 장애가 시세 갱신을 막지 않음');
});
await test('AI 할당량 소진(429): 재시도 2회 후 회차 내 중지', async () => {
  const root = workspace();
  const { value } = await pipeline(root, { gemini: () => json({ error: { code: 429 } }, 429) });
  assert.equal(geminiCalls(), 3);
  assert.equal(value.ai.disabled, 'quota');
  assert.equal(read(root, 'status.json').ai.state, 'quota');
});
await test('지수 브리핑: 이전 AI 실패(null)는 재사용하지 않고 한도 회복 후 다시 생성', async () => {
  const root = workspace();
  await pipeline(root, { gemini: () => json({ error: { code: 429 } }, 429) }); // 한도 소진 → 브리핑 AI 실패
  assert.equal(read(root, 'market.json').briefs[0].reason.ai, null);
  await pipeline(root);                                                         // 한도 회복, 입력은 그대로
  assert.ok(read(root, 'market.json').briefs[0].reason.ai, '실패했던 브리핑 AI를 다시 생성해야 함');
});
await test('AI 상태: 호출할 일 없는 첫 회차는 대기(idle) 기록, 이후 호출 없으면 유지', async () => {
  const root = workspace();
  const quietNews = () => text('<?xml version="1.0"?><rss><channel></channel></rss>'); // 헤드라인 0건 → 지수 AI 호출 없음
  NET.routes = routes({ krPct: { '005930': 0.4, '000660': 0.3 } }).map((r) => (String(r.re).includes('news') ? { ...r, fn: quietNews } : r));
  NET.calls = []; NET.blocked = [];
  await quiet(() => run({ root }));
  assert.equal(geminiCalls(), 0);
  assert.deepEqual(read(root, 'status.json').ai, { state: 'idle', model: 'model-primary', fallback: false });
  await pipeline(root);                       // 이번엔 급등 종목·헤드라인 있음 → 실제 호출 → 정상
  assert.equal(read(root, 'status.json').ai.state, 'ok');
});
await test('AI 키 없음: 호출 0회 · 나머지는 정상 갱신', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const root = workspace();
    const { value, lines } = await pipeline(root);
    assert.equal(geminiCalls(), 0);
    assert.equal(value.ai.enabled, false);
    assert.ok(value.written.includes('quotes.json'));
    assert.ok(lines.some((l) => l.includes('키 없음')));
    assert.deepEqual(read(root, 'status.json').ai, { state: 'off', model: null, fallback: false });
  } finally { process.env.GEMINI_API_KEY = saved; }
});
await test('잘못된 설정: 유효 종목 0개·깨진 JSON → 아무것도 쓰지 않음', async () => {
  for (const cfg of [JSON.stringify({ items: [{ code: 'ABC', market: 'KR' }] }), '{ 깨진 json']) {
    const root = workspace(cfg, true);
    const seeds = Object.fromEntries(FILES.map((f) => [f, raw(root, f)]));
    const { value } = await pipeline(root);
    assert.deepEqual(value.written, []);
    for (const f of FILES) assert.equal(raw(root, f), seeds[f]);
    assert.equal(NET.calls.length, 0, '설정이 틀리면 외부 호출도 안 함');
  }
});

// ---------- 정리 · 결과 ----------
for (const d of workspaces) fs.rmSync(d, { recursive: true, force: true });
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     → ${r.err?.message}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n결과: ${results.length}개 중 ${results.length - failed}개 통과${failed ? ` · ${failed}개 실패` : ''}`);
process.exitCode = failed ? 1 : 0;
