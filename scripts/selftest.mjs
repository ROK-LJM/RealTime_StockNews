// pages/scripts/selftest.mjs — 오프라인 자체 테스트 (외부 접속 없음)
// 실행: node scripts/selftest.mjs   (pages 폴더에서)
//
// · 네트워크는 가짜 fetch로 대체한다. 등록되지 않은 주소로 나가려 하면 차단하고 테스트를 실패시킨다.
// · 데이터는 OS 임시 폴더에만 쓰고 지운다 — 실제 docs/data, 외부 API, 저장소를 건드리지 않는다.
// · API 키 자리에는 가짜 값만 넣는다(가짜 fetch만 받으므로 어디에도 전송되지 않음).
// · AI 예산은 시각에 따라 달라지므로 파이프라인은 고정 시각(now)으로 돌린다.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------- 가짜 네트워크 ----------
const NET = { routes: [], calls: [], bodies: [], blocked: [] };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  NET.calls.push(u);
  NET.bodies.push(String(opts?.body ?? ''));
  for (const r of NET.routes) { const m = u.match(r.re); if (m) return r.fn(m, u); }
  NET.blocked.push(u);
  throw new Error(`[selftest] 등록되지 않은 외부 호출 차단: ${u}`);
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const text = (s, status = 200) => new Response(s, { status });
const isGemini = (u) => u.includes('generativelanguage');
const geminiCalls = (model) => NET.calls.filter((u) => isGemini(u) && (!model || u.includes(`/models/${model}:`))).length;
// 지수 브리핑용 AI 요청(프롬프트에 '뉴스 목록'이 들어감) 수
const briefCalls = () => NET.calls.filter((u, i) => isGemini(u) && NET.bodies[i].includes('뉴스 목록')).length;

// ---------- 고정 시각 (한도일 = 미 태평양시 날짜, 2026-10-14 PT는 KST 10/14 16:00 ~ 10/15 16:00) ----------
const T = (s) => Date.parse(s);
const MIN = 60 * 1000;
const NOW_KR = T('2026-10-15T03:00:00Z');   // 목 12:00 KST — 국내 장중, 하루 예산의 약 56%가 풀린 시점
const NOW_EVE = T('2026-10-14T08:00:00Z');  // 수 17:00 KST — 한도 리셋 직후, 아직 장 시간 전(배분 0)
const NEXT_DAY = NOW_KR + 1440 * MIN;       // 다음 한도일 같은 시각
const QDAY = '2026-10-14';

// ---------- 픽스처(실제 응답 형태를 본뜬 최소 데이터) ----------
const DAY = 86400;
// pct를 주면 그만큼 등락한 것으로(전일 종가 조정), 없으면 +0.1% 안팎
function yahooChart(sym, pct) {
  const isKR = /\.K[SQ]$/.test(sym);
  const base = sym === '^VIX' ? 18 : sym === 'KRW=X' ? 1390 : sym === 'JPYKRW=X' ? 9.3 : isKR ? 70000 : 200;
  const now = Math.floor(Date.now() / 1000);
  const ts = Array.from({ length: 130 }, (_, i) => now - (130 - i) * DAY);
  const closes = ts.map((_, i) => +(base * (1 + 0.001 * i)).toFixed(2));
  const prevClose = pct == null ? closes.at(-2) : +(closes.at(-1) / (1 + pct / 100)).toFixed(4);
  return { chart: { result: [{
    meta: {
      regularMarketPrice: closes.at(-1), chartPreviousClose: prevClose, currency: isKR ? 'KRW' : 'USD', shortName: sym,
      regularMarketDayHigh: base * 1.2, regularMarketDayLow: base * 0.9, regularMarketOpen: base, regularMarketVolume: 1000,
      regularMarketTime: now, currentTradingPeriod: { regular: { start: now - 3600, end: now + 3600 } }, instrumentType: 'EQUITY',
    },
    timestamp: ts, indicators: { quote: [{ close: closes }] },
  }] } };
}
const naverStock = (code, pct, status = 'OPEN', at = null) => ({ datas: [{
  stockName: `종목${code}`, closePrice: '70,000', compareToPreviousClosePrice: String(Math.round(Math.abs(70000 * pct / 100))),
  fluctuationsRatio: String(Math.abs(pct)), compareToPreviousPrice: { name: pct > 0 ? 'RISING' : pct < 0 ? 'FALLING' : 'EVEN' },
  openPrice: '69,000', highPrice: '71,000', lowPrice: '68,000', accumulatedTradingVolume: '1,234,567',
  marketStatus: status, localTradedAt: (at == null ? new Date() : new Date(at)).toISOString(),
}] });
const naverIndex = (pct, status = 'OPEN') => ({ datas: [{ closePriceRaw: '2,600.00', compareToPreviousClosePriceRaw: (2600 * pct / 100).toFixed(1), fluctuationsRatioRaw: pct.toFixed(2), marketStatus: status }] });
const trendStock = [{ bizdate: '20261015', foreignerPureBuyQuant: '-1,000', organPureBuyQuant: '500', individualPureBuyQuant: '500', foreignerHoldRatio: '50.00%' }];
const trendIndex = { bizdate: '20261015', personalValue: '+1,000', foreignValue: '-800', institutionalValue: '-200' };
// tag를 바꾸면 헤드라인이 달라진다(= 분석 입력이 바뀐 상황)
// 실제 뉴스처럼 제목에 검색한 종목 이름이 들어간다(관련도 필터 통과) — name은 검색어에서 '주가'·'stock' 앞부분
const queryName = (u) => String(new URL(u).searchParams.get('q') || '').replace(/\s+when:\S+/, '').replace(/\s+(주가|stock)$/, '').trim();
function rss(tag = '', name = '') {
  const pub = new Date(Date.now() - 3600e3).toUTCString(); // 최근 2일 필터 통과
  const items = [1, 2, 3].map((i) => `<item><title>${tag ? `${tag} ` : ''}${name ? `${name} ` : ''}테스트 뉴스 ${i} 급등 - 테스트일보</title><link>https://news.example.com/a${i}</link><pubDate>${pub}</pubDate><source url="https://news.example.com">테스트일보</source></item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}
// 지수 브리핑(summary·items)과 종목 분석(headline·factors) 양쪽 형식을 모두 만족하는 응답
const geminiOk = { candidates: [{ content: { parts: [{ text: JSON.stringify({
  summary: '테스트 요약', items: [{ index: 1, why: '핵심 재료' }], headline: '테스트 진단', factors: ['요인1', '요인2'], outlook: '관전 포인트',
}) }] } }] };
// 실제 무료 한도 초과 응답 형태 — 일일 한도는 quotaId에 PerDay, 분당 한도는 PerMinute가 들어간다
const quota429 = (per) => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.',
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: `GenerateRequestsPer${per}PerProjectPerModel-FreeTier` }] }] } }, 429);

// ---------- 공시(OpenDART) 픽스처 ----------
// ZIP(실제 고유번호 파일 형식) — files: [[이름, 내용]]. descriptor: 로컬 헤더에 크기를 비우고 뒤에 데이터 설명자를 붙이는 형식
function makeZip(files, { method = 8, descriptor = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const flag = descriptor ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flag, 6); lh.writeUInt16LE(method, 8);
    if (!descriptor) { lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); }
    lh.writeUInt16LE(nm.length, 26);
    const dd = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) { dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(data.length, 8); dd.writeUInt32LE(raw.length, 12); }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flag, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, nm, data, dd); central.push(ch, nm);
    offset += lh.length + nm.length + data.length + dd.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
// 고유번호 XML — 테스트 종목 + 가짜 상장사 1,100개 + 비상장사(종목코드 빈칸)
function corpXml(extra = {}) {
  const rows = { '005930': '00126380', '000660': '00164779', ...extra };
  for (let i = 0; i < 1100; i++) rows[String(100000 + i)] ??= String(90000000 + i);
  const list = Object.entries(rows).map(([s, c]) =>
    `  <list>\n    <corp_code>${c}</corp_code>\n    <corp_name>회사${s}</corp_name>\n    <corp_eng_name>Co ${s}</corp_eng_name>\n    <stock_code>${s}</stock_code>\n    <modify_date>20260101</modify_date>\n  </list>`);
  list.push('  <list>\n    <corp_code>00999999</corp_code>\n    <corp_name>비상장</corp_name>\n    <corp_eng_name>X</corp_eng_name>\n    <stock_code> </stock_code>\n    <modify_date>20260101</modify_date>\n  </list>');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n${list.join('\n')}\n</result>\n`;
}
// 공시 목록 — 고유번호별 [접수번호, 제목, 비고(rm)]. 응답 순서는 일부러 섞어 둔다(정렬 확인)
const DART_ROWS = {
  '00126380': [
    ['20261014000500', '임원ㆍ주요주주특정증권등소유상황보고서'],
    ['20261015000321', '단일판매ㆍ공급계약체결'],
    ['20261015000100', '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)', '연'],
    ['20261014000400', '자기주식취득결정', '철'],
    ['20261013000200', '현금ㆍ현물배당결정'],
    ['20261010000050', '기업설명회(IR)개최(안내공시)'],
    ['20261002000010', '분기보고서 (2026.09)'],
  ],
  '00164779': [['20261012000777', '주식등의대량보유상황보고서(일반)']],
};
const dartList = (corp, rows) => ({ status: '000', message: '정상', page_no: 1, page_count: 10, total_count: rows.length, total_page: 1,
  list: rows.map(([no, nm, rm = '']) => ({ corp_cls: 'Y', corp_name: '회사', corp_code: corp, stock_code: '', report_nm: nm, rcept_no: no, flr_nm: '회사', rcept_dt: no.slice(0, 8), rm })) });
const DART_KEY = 'selftest-dart-dummy-key-000000000000000000';
async function withDartKey(fn) {
  process.env.DART_API_KEY = DART_KEY;
  try { return await fn(); } finally { delete process.env.DART_API_KEY; }
}

function routes({ krPct = { '005930': 4.2, '000660': 0.3 }, krAt = null, usPct = {}, idxPct = -1.2, krStatus = 'OPEN', idxStatus = 'OPEN', newsTag = '', news = (m, u) => text(rss(newsTag, queryName(u))),
  yahoo = (m, u) => { // 시간외(5분봉) 요청엔 기본적으로 체결 없음 — 시간외 전용 테스트만 봉을 준다
    const sym = decodeURIComponent(m[1]);
    return json(/interval=5m/.test(u) ? { chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }] } } : yahooChart(sym, usPct[sym]));
  }, gemini = () => json(geminiOk),
  corpZip = () => new Response(makeZip([['CORPCODE.xml', corpXml()]])), dartRows = DART_ROWS,
  dartList: listFn = (corp) => json(dartList(corp, dartRows[corp] || [])) } = {}) {
  return [
    { re: /opendart\.fss\.or\.kr\/api\/corpCode\.xml\?/, fn: (m, u) => corpZip(u) },
    { re: /opendart\.fss\.or\.kr\/api\/list\.json\?/, fn: (m, u) => listFn(new URL(u).searchParams.get('corp_code'), u) },
    { re: /polling\.finance\.naver\.com\/api\/realtime\/domestic\/stock\/(\d{6})/, fn: (m) => json(naverStock(m[1], krPct[m[1]] ?? 0.5, krStatus, krAt)) },
    { re: /polling\.finance\.naver\.com\/api\/realtime\/domestic\/index\/(KOSPI|KOSDAQ)/, fn: () => json(naverIndex(idxPct, idxStatus)) },
    { re: /m\.stock\.naver\.com\/api\/stock\/(\d{6})\/trend/, fn: () => json(trendStock) },
    { re: /m\.stock\.naver\.com\/api\/index\/(KOSPI|KOSDAQ)\/trend/, fn: () => json(trendIndex) },
    { re: /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/([^?]+)/, fn: yahoo },
    { re: /news\.google\.com\/rss\/search/, fn: news },
    { re: /generativelanguage\.googleapis\.com\/v1beta\/models\/([^:]+):generateContent/, fn: (m) => gemini(decodeURIComponent(m[1])) },
  ];
}
// AI를 부를 일이 전혀 없는 회차 — 헤드라인 0건(지수 AI 없음) + 급등락 종목 없음
const CALM = { krPct: { '005930': 0.4, '000660': 0.3 }, news: () => text('<?xml version="1.0"?><rss><channel></channel></rss>') };

// ---------- 임시 작업공간 ----------
const FILES = ['analysis.json', 'history.json', 'investors.json', 'market.json', 'news.json', 'quotes.json', 'status.json'];
const ITEMS = [{ code: '005930', market: 'KR', name: '삼성전자' }, { code: '000660', market: 'KR', name: 'SK하이닉스' }, { code: 'AAPL', market: 'US', name: '애플' }];
// 시드용 AI 상태 — NOW_KR과 같은 한도일, 파이프라인이 쓰는 것과 같은 형식(같은 내용이면 다시 쓰지 않는지 확인용)
const statusSeed = (used = { 'model-primary': 1 }, state = 'ok') => ({
  ai: { state, model: 'model-primary', used: Object.values(used).reduce((a, n) => a + n, 0), cap: 40 },
  budget: { day: QDAY, used, out: {} },
});
const workspaces = [];
function workspace(items = ITEMS, seed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-selftest-'));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'watchlist.json'), typeof items === 'string' ? items : JSON.stringify({ items }));
  if (seed) for (const f of FILES) fs.writeFileSync(file(root, f), JSON.stringify(f === 'status.json' ? statusSeed() : { seed: f }));
  return root;
}
const file = (root, f) => path.join(root, 'docs', 'data', f);
const read = (root, f) => JSON.parse(fs.readFileSync(file(root, f), 'utf8'));
const raw = (root, f) => fs.readFileSync(file(root, f), 'utf8');
const writeData = (root, f, obj) => fs.writeFileSync(file(root, f), JSON.stringify(obj));

// 파이프라인 로그는 모아 두고(실패 시 원인 확인용) 화면에는 결과만 보여준다
async function quiet(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(' '));
  try { return { value: await fn(), lines }; } finally { Object.assign(console, orig); }
}
// 기본은 과거 시세·수급·뉴스를 매번 새로 받는다(refreshAll) — 간격 재사용 자체는 전용 테스트에서 검증
async function pipeline(root, routeOpts, now = NOW_KR, { refreshAll = true } = {}) {
  NET.routes = routes(routeOpts); NET.calls = []; NET.bodies = []; NET.blocked = [];
  return quiet(() => run({ root, now, refreshAll }));
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
delete process.env.AI_DAILY_BUDGET; // 모델당 기본 예산(20회) 기준으로 검증
delete process.env.DART_API_KEY;    // 공시는 기본 꺼짐 — 키가 필요한 테스트만 가짜 키로 켠다(withDartKey)
const util = await import('./util.mjs');
const bud = await import('./aibudget.mjs');
const src = await import('./sources.mjs');
const { run } = await import('./fetch.mjs');
const stocklist = await import('./stocklist.mjs');
const wl = await import('./watchlist-apply.mjs');
const dartm = await import('./dart.mjs');
src.retryTiming.baseMs = 1; // 재시도 대기를 실제로 기다리지 않음

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

// ===== AI 예산(aibudget) 단위 =====
await test('한도일: 미 태평양시 자정 리셋(서머타임 07:00Z · 겨울 08:00Z) · 전환일 25/23시간', () => {
  assert.equal(bud.quotaDay(T('2026-10-15T06:59:00Z')), '2026-10-14');
  assert.equal(bud.quotaDay(T('2026-10-15T07:00:00Z')), '2026-10-15');
  assert.equal(bud.quotaDay(T('2026-12-15T07:59:00Z')), '2026-12-14');
  assert.equal(bud.quotaDay(T('2026-12-15T08:00:00Z')), '2026-12-15');
  for (const at of [NOW_KR, T('2026-10-15T03:17:30Z')]) { // 정각이 아닌 시각도 경계는 정확히 리셋 시각
    const r = bud.quotaDayRange(at);
    assert.deepEqual([r.start, r.end], [T('2026-10-14T07:00:00Z'), T('2026-10-15T07:00:00Z')]);
  }
  const fall = bud.quotaDayRange(T('2026-11-01T12:00:00Z'));
  assert.equal((fall.end - fall.start) / 3600e3, 25);
  const spring = bud.quotaDayRange(T('2026-03-08T12:00:00Z'));
  assert.equal((spring.end - spring.start) / 3600e3, 23);
});
await test('장 시간대·시그니처 등락 구간: 시장별 개장 판정 · 구간만 비교', () => {
  assert.equal(bud.inSession('KR', NOW_KR), true);
  assert.equal(bud.inSession('US', NOW_KR), false);
  assert.equal(bud.inSession('US', T('2026-10-14T15:00:00Z')), true);   // 수 11:00 EDT
  assert.equal(bud.inSession('KR', T('2026-10-14T15:00:00Z')), false);  // 목 00:00 KST
  assert.equal(util.sigMove('4|x|뉴스A'), '4');
  assert.equal(util.sigMove(null), '');
});
await test('장 시간 가중치: 국내장 3 · 미국장 1 · 장외·주말 0 (경계 포함)', () => {
  assert.equal(bud.marketWeight(T('2026-10-15T00:00:00Z')), 3);  // 목 09:00 KST 개장
  assert.equal(bud.marketWeight(T('2026-10-14T23:59:00Z')), 0);  // 08:59 KST
  assert.equal(bud.marketWeight(T('2026-10-15T06:59:00Z')), 3);  // 15:59 KST
  assert.equal(bud.marketWeight(T('2026-10-15T07:00:00Z')), 0);  // 16:00 KST
  assert.equal(bud.marketWeight(T('2026-10-14T13:30:00Z')), 1);  // 수 09:30 EDT 개장
  assert.equal(bud.marketWeight(T('2026-10-14T13:29:00Z')), 0);
  assert.equal(bud.marketWeight(T('2026-10-17T03:00:00Z')), 0);  // 토 12:00 KST
});
await test('예산 배분: 장 시간 비례로 풀림 · 덜 쓴 만큼 이월 · 리셋 1시간 전·주말', () => {
  const models = ['a', 'b'];
  const at = (ms, used = {}) => ({ ...bud.startBudget(null, ms), used });
  assert.equal(bud.allowance(at(NOW_EVE), models), 0, '장 시간 전에는 0');
  assert.equal(bud.allowance(at(NOW_KR), models), 22, '40 × 0.5636');
  assert.equal(bud.allowance(at(NOW_KR, { a: 12, b: 10 }), models), 0);
  assert.equal(bud.allowance(at(NOW_KR, { a: 6, b: 4 }), models), 12, '덜 쓴 만큼 이월');
  assert.equal(bud.allowance(at(T('2026-10-15T06:30:00Z'), { a: 25, b: 20 }), models), Infinity, '리셋 1시간 전');
  assert.equal(bud.allowance(at(T('2026-10-18T03:00:00Z')), models), 0, '일요일 낮(장 없음)');
  assert.equal(bud.allowance(at(T('2026-10-18T06:30:00Z')), models), Infinity, '일요일도 리셋 직전엔 남은 한도 사용');
});
await test('모델 배분: 덜 쓴 모델부터 · 빠진 모델은 쓴 만큼만 예산 · 전부 빠지면 0', () => {
  const models = ['a', 'b'];
  assert.equal(bud.pickModel({ used: { a: 2, b: 1 }, out: {} }, models), 'b');
  assert.equal(bud.pickModel({ used: { a: 1, b: 1 }, out: {} }, models), 'a', '같으면 주 모델');
  assert.equal(bud.pickModel({ used: { a: 0, b: 5 }, out: { a: 'quota' } }, models), 'b');
  assert.equal(bud.pickModel({ used: {}, out: { a: 'quota', b: 'unavailable' } }, models), null);
  const b = { ...bud.startBudget(null, NOW_KR), used: { a: 15, old: 9 }, out: { a: 'quota' } };
  assert.equal(bud.capacity(b, models), 35);
  assert.equal(bud.totalUsed(b, models), 15, '설정에서 뺀 모델(old)은 세지 않음');
  assert.equal(bud.allowance({ ...b, out: { a: 'quota', b: 'quota' } }, models), 0);
});
await test('예산 기록: 한도일이 바뀌면 새로 시작 · 손상된 항목은 버림', () => {
  const b = bud.startBudget({ day: QDAY, used: { a: 3, b: 'x', c: -1, d: 1.5 }, out: { a: 'quota', b: '', c: 5 } }, NOW_KR);
  assert.deepEqual([b.used, b.out, b.rolled], [{ a: 3 }, { a: 'quota' }, false]);
  const next = bud.startBudget({ day: QDAY, used: { a: 3 }, out: { a: 'quota' } }, NEXT_DAY);
  assert.deepEqual([next.day, next.used, next.out, next.rolled], ['2026-10-15', {}, {}, true]);
  for (const bad of [null, 'x', [], { day: QDAY, used: [1], out: 'q' }]) {
    const z = bud.startBudget(bad, NOW_KR);
    assert.deepEqual([z.used, z.out], [{}, {}]);
  }
  assert.deepEqual(bud.toStored(b), { day: QDAY, used: { a: 3 }, out: { a: 'quota' } });
});

// ===== 파이프라인(가짜 네트워크) =====
await test('정상: 9개 파일 생성(파일 지문·급등락 기록 포함) · 급등락만 AI 분석 · 두 모델 고루 사용 · 분석 시각 기록 · 외부 차단 0건', async () => {
  const root = workspace();
  const { value } = await pipeline(root);
  assert.deepEqual([...value.written].sort(), [...FILES, 'manifest.json', 'moves.json'].sort());
  const q = read(root, 'quotes.json').quotes;
  assert.equal(q.length, 3);
  assert.ok(q.every((x) => x.ok));
  const a = read(root, 'analysis.json');
  assert.ok(a['005930']?.headline, '+4.2% 종목은 분석');
  assert.equal(a['000660'], undefined, '+0.3% 종목은 분석 안 함');
  assert.equal(a['005930'].at, NOW_KR);
  const m = read(root, 'market.json');
  assert.equal(m.briefs.length, 2);
  // 호출 순서: 코스피 브리핑 → 코스닥 브리핑 → 종목 분석. 덜 쓴 모델부터 → 주·대체·주
  assert.deepEqual([m.briefs[0].reason.ai.model, m.briefs[1].reason.ai.model, a['005930'].model], ['model-primary', 'model-fallback', 'model-primary']);
  assert.equal(m.briefs[0].reason.aiAt, NOW_KR);
  assert.deepEqual(read(root, 'status.json'), {
    ai: { state: 'ok', model: 'model-primary', used: 3, cap: 40 },
    budget: { day: QDAY, used: { 'model-primary': 2, 'model-fallback': 1 }, out: {} },
  });
  assert.ok(read(root, 'history.json').AAPL.closes.length > 100);
  assert.equal(read(root, 'investors.json').AAPL, undefined, '해외 종목 수급 없음');
  assert.equal(NET.blocked.length, 0, `차단된 호출: ${NET.blocked.join(', ')}`);
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs', 'data')).filter((f) => f.endsWith('.tmp')), []);
});
await test('시그니처 재사용: 입력이 같으면 두 번째 회차 AI 호출 0회 · 상태 파일 그대로', async () => {
  const root = workspace();
  await pipeline(root);
  assert.ok(geminiCalls() > 0);
  const before = raw(root, 'analysis.json');
  const statusBefore = raw(root, 'status.json');
  const { value } = await pipeline(root, {}, NOW_KR + 5 * MIN);
  assert.equal(geminiCalls(), 0);
  assert.equal(raw(root, 'analysis.json'), before);
  assert.equal(raw(root, 'status.json'), statusBefore, 'AI 호출이 없던 회차는 상태 파일을 건드리지 않음');
  assert.ok(!value.written.includes('status.json'));
});
await test('전부 실패: 기존 데이터 파일 모두 그대로 · 예외 없이 종료', async () => {
  const root = workspace(ITEMS, true);
  const seeds = Object.fromEntries(FILES.map((f) => [f, raw(root, f)]));
  NET.routes = [{ re: /./, fn: () => { throw new TypeError('fetch failed'); } }];
  NET.calls = []; NET.bodies = []; NET.blocked = [];
  const { value } = await quiet(() => run({ root, now: NOW_KR }));
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
await test('AI 모델 사용 불가(404): 대체 모델로 분석 · 그날은 다시 시도 안 함 · 다음 한도일에 재확인', async () => {
  const root = workspace();
  const gemini = (model) => (model === 'model-primary'
    ? json({ error: { code: 404, message: 'models/model-primary is not found' } }, 404)
    : json(geminiOk));
  const { lines } = await pipeline(root, { gemini });
  assert.equal(read(root, 'analysis.json')['005930'].model, 'model-fallback');
  assert.equal(geminiCalls('model-primary'), 1);
  assert.ok(lines.some((l) => l.includes('모델 사용 불가(model-primary)')));
  assert.deepEqual(read(root, 'status.json'), {
    ai: { state: 'ok', model: 'model-fallback', used: 3, cap: 20 },
    budget: { day: QDAY, used: { 'model-fallback': 3 }, out: { 'model-primary': 'unavailable' } },
  });
  await pipeline(root, { gemini, newsTag: 'b' }, NOW_KR + 10 * MIN); // 같은 날, 입력 바뀜 → 새 분석 필요
  assert.ok(geminiCalls('model-fallback') > 0);
  assert.equal(geminiCalls('model-primary'), 0, '같은 한도일엔 주 모델을 다시 부르지 않음');
  await pipeline(root, { gemini, newsTag: 'c' }, NEXT_DAY);
  assert.equal(geminiCalls('model-primary'), 1, '다음 한도일엔 한 번 다시 확인');
});
await test('AI 키 오류(403): 첫 호출 뒤 회차 내 AI 중지', async () => {
  const root = workspace();
  const { value } = await pipeline(root, { gemini: () => json({ error: { code: 403 } }, 403) });
  assert.equal(geminiCalls(), 1);
  assert.equal(value.ai.disabled, 'auth');
  assert.equal(read(root, 'status.json').ai.state, 'auth');
  assert.ok(read(root, 'quotes.json').quotes.every((x) => x.ok), 'AI 장애가 시세 갱신을 막지 않음');
});
await test('AI 분당 한도(429): 모델마다 재시도 2회 후 회차 내 중지 · 하루 제외는 안 함', async () => {
  const root = workspace();
  const { value } = await pipeline(root, { gemini: () => quota429('Minute') });
  assert.deepEqual([geminiCalls('model-primary'), geminiCalls('model-fallback')], [3, 3]);
  assert.equal(value.ai.disabled, 'quota');
  const s = read(root, 'status.json');
  assert.equal(s.ai.state, 'quota');
  assert.deepEqual(s.budget.out, {}, '분당 한도는 기록하지 않음');
  await pipeline(root, {}, NOW_KR + 5 * MIN);
  assert.ok(geminiCalls('model-primary') > 0, '다음 회차엔 바로 다시 사용');
  assert.equal(read(root, 'status.json').ai.state, 'ok');
});
await test('AI 일일 한도(429 PerDay): 재시도 없이 대체 모델로 · 그날은 다시 시도 안 함', async () => {
  const root = workspace();
  const gemini = (model) => (model === 'model-primary' ? quota429('Day') : json(geminiOk));
  await pipeline(root, { gemini });
  assert.equal(geminiCalls('model-primary'), 1, '일일 한도는 재시도하지 않음');
  assert.equal(read(root, 'analysis.json')['005930'].model, 'model-fallback');
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.budget.out, s.ai.cap], ['ok', { 'model-primary': 'quota' }, 20], '빠진 모델은 쓴 만큼(0)만 예산에 남음');
  await pipeline(root, { gemini, newsTag: 'b' }, NOW_KR + 10 * MIN);
  assert.equal(geminiCalls('model-primary'), 0);
});
await test('AI 무료 한도 0인 모델(429 limit: 0): 재시도 없이 그날 사용 불가로 제외 · 다른 모델로 분석', async () => {
  const root = workspace();
  const zero = json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
    message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: model-fallback',
    details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }] } }, 429);
  await pipeline(root, { gemini: (model) => (model === 'model-fallback' ? zero : json(geminiOk)) });
  assert.equal(geminiCalls('model-fallback'), 1, '분당 한도로 오인해 재시도하지 않음');
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.budget.out], ['ok', { 'model-fallback': 'unavailable' }]);
  assert.equal(read(root, 'analysis.json')['005930'].model, 'model-primary');
  await pipeline(root, { newsTag: 'b', gemini: (model) => (model === 'model-fallback' ? zero : json(geminiOk)) }, NOW_KR + 10 * MIN);
  assert.equal(geminiCalls('model-fallback'), 0, '같은 한도일엔 다시 부르지 않음');
});
await test('기본 AI 모델: 무료 Flash-Lite 3종(주 2.5 · 대체 3.5 · 3.1) — 환경변수로 바꿀 수 있음', () => {
  const saved = { m: process.env.GEMINI_MODEL, f: process.env.GEMINI_FALLBACK_MODELS };
  try {
    delete process.env.GEMINI_MODEL; delete process.env.GEMINI_FALLBACK_MODELS;
    src.resetState();
    assert.deepEqual(src.aiModels(), ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    process.env.GEMINI_FALLBACK_MODELS = ' gemini-3.5-flash-lite , ,gemini-2.5-flash-lite ';
    src.resetState();
    assert.deepEqual(src.aiModels(), ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'], '공백·빈 항목·중복 정리');
  } finally {
    process.env.GEMINI_MODEL = saved.m; process.env.GEMINI_FALLBACK_MODELS = saved.f;
    src.resetState();
  }
});
await test('모든 모델 일일 한도 소진: 호출 없이 한도 소진 상태 유지 → 다음 한도일에 자동 재개', async () => {
  const root = workspace();
  await pipeline(root, { gemini: () => quota429('Day') });
  assert.deepEqual([geminiCalls('model-primary'), geminiCalls('model-fallback')], [1, 1]);
  assert.equal(read(root, 'status.json').ai.state, 'quota');
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 10 * MIN);
  assert.equal(geminiCalls(), 0, '같은 한도일엔 부르지 않음');
  assert.equal(read(root, 'status.json').ai.state, 'quota');
  await pipeline(root, { newsTag: 'b' }, NEXT_DAY);
  assert.ok(geminiCalls() > 0);
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.budget.day, s.budget.out], ['ok', '2026-10-15', {}]);
});
await test('지수 브리핑: 이전 AI 실패(null)는 재사용하지 않고 한도 회복 후 다시 생성', async () => {
  const root = workspace();
  await pipeline(root, { gemini: () => quota429('Day') });   // 한도 소진 → 브리핑 AI 실패
  assert.equal(read(root, 'market.json').briefs[0].reason.ai, null);
  await pipeline(root, {}, NEXT_DAY);                           // 한도 회복, 입력은 그대로
  assert.ok(read(root, 'market.json').briefs[0].reason.ai, '실패했던 브리핑 AI를 다시 생성해야 함');
});
await test('지수 브리핑: 90분 안엔 헤드라인이 바뀌어도 재사용 · 지나면 갱신 · 방향 바뀌면 즉시 · 실패 시 이전 판단 유지', async () => {
  const root = workspace();
  const brief = () => read(root, 'market.json').briefs[0].reason;
  await pipeline(root, { newsTag: 'a' });
  assert.equal(briefCalls(), 2);
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 30 * MIN);
  assert.equal(briefCalls(), 0, '30분 뒤: 헤드라인만 바뀜 → 재사용');
  assert.ok(brief().headlines[0].title.startsWith('b '), '헤드라인은 최신으로');
  assert.equal(brief().aiAt, NOW_KR);
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 100 * MIN);
  assert.equal(briefCalls(), 2, '90분이 지나면 갱신 — 직전 회차와 입력이 같아도 판단 당시(a)와 다르면');
  assert.equal(brief().aiAt, NOW_KR + 100 * MIN);
  await pipeline(root, { newsTag: 'b', idxPct: 1.5 }, NOW_KR + 110 * MIN);
  assert.equal(briefCalls(), 2, '급락→급등으로 방향이 바뀌면 바로 갱신');
  assert.equal(brief().dir, 'up');
  const kept = brief().ai;
  await pipeline(root, { newsTag: 'd', idxPct: 1.5, gemini: () => json({ error: { code: 500 } }, 500) }, NOW_KR + 210 * MIN);
  assert.ok(briefCalls() > 0, '갱신 시도');
  assert.deepEqual(brief().ai, kept, '실패하면 이전 판단 유지');
  assert.equal(brief().aiAt, NOW_KR + 110 * MIN);
  await pipeline(root, { newsTag: 'd', idxPct: 1.5 }, NOW_KR + 215 * MIN);
  assert.equal(briefCalls(), 2, '실패했던 갱신은 입력이 그대로여도 다음 회차에 다시 시도');
  assert.equal(brief().aiAt, NOW_KR + 215 * MIN);
  await pipeline(root, { newsTag: 'd', idxPct: -0.5, gemini: () => json({ error: { code: 500 } }, 500) }, NOW_KR + 220 * MIN);
  assert.equal(brief().ai, null, '방향이 바뀌었는데 실패하면 이전(다른 방향) 판단은 버림');
});
await test('장 밖 재사용: 마감한 시장의 지수·종목은 뉴스만 바뀌면 다시 분석 안 함 · 한도는 장중인 시장에', async () => {
  const root = workspace();
  const US_OPEN = T('2026-10-15T15:00:00Z');   // 금 00:00 KST · 목 11:00 EDT — 국내 마감 후, 미국 장중(새 한도일)
  const KR_NEXT = T('2026-10-16T01:00:00Z');   // 금 10:00 KST — 국내 장중, 미국 마감 후
  await pipeline(root, { newsTag: 'a' });                                        // 국내 장중: 브리핑 2 + 005930
  const kr = read(root, 'analysis.json')['005930'];
  const kospi = read(root, 'market.json').briefs[0].reason;
  await pipeline(root, { newsTag: 'b', usPct: { AAPL: 3 } }, US_OPEN);
  assert.equal(briefCalls(), 0, '국내 마감 후: 지수 브리핑 재사용');
  assert.equal(geminiCalls(), 1, '한도는 미국 장중 종목(AAPL)에만');
  let a = read(root, 'analysis.json');
  assert.deepEqual(a['005930'], kr, '국내 종목 분석 그대로');
  assert.equal(a.AAPL.at, US_OPEN);
  assert.deepEqual(read(root, 'market.json').briefs[0].reason.ai, kospi.ai);
  await pipeline(root, { newsTag: 'c', usPct: { AAPL: 3 } }, KR_NEXT);
  a = read(root, 'analysis.json');
  assert.equal(a.AAPL.at, US_OPEN, '미국 마감 후: AAPL 분석 그대로');
  assert.equal(a['005930'].at, KR_NEXT, '국내 장중: 새 뉴스로 다시 분석');
  assert.equal(briefCalls(), 2);
  await pipeline(root, { newsTag: 'd', usPct: { AAPL: -3 } }, KR_NEXT + 5 * MIN);
  assert.ok(read(root, 'analysis.json').AAPL.at > US_OPEN, '장 밖이어도 등락 구간이 바뀌면 다시 분석');
});
await test('장 밖 재사용: 지수도 판단 당시와 등락 구간이 달라졌으면(마감 직전 급변) 마감 후 갱신', async () => {
  const root = workspace();
  await pipeline(root, { idxPct: -1.2 });                                        // 장중 -1.2%에 판단
  await pipeline(root, { idxPct: -2.6 }, T('2026-10-15T15:00:00Z'));             // 마감 후 확인해 보니 -2.6%
  assert.equal(briefCalls(), 2);
  assert.equal(read(root, 'market.json').briefs[0].reason.aiSig.split('|')[0], '-3');
});
await test('시간 배분: 리셋 직후(장 시간 전)엔 순서 대기 → 국내 장중에 분석', async () => {
  const root = workspace();
  const { lines } = await pipeline(root, {}, NOW_EVE);
  assert.equal(geminiCalls(), 0);
  assert.equal(read(root, 'status.json').ai.state, 'wait');
  assert.equal(read(root, 'status.json').ai.next, T('2026-10-14T14:12:00Z'), '다음 분석 가능 시각 기록(23:12 KST)');
  assert.ok(lines.some((l) => l.includes('한도 배분 대기 1')), '종목 분석도 배분 대기로 미룸');
  assert.equal(read(root, 'analysis.json')['005930'], undefined);
  assert.equal(read(root, 'market.json').briefs[0].reason.ai, null);
  await pipeline(root, {}, NOW_KR);
  assert.ok(geminiCalls() > 0);
  assert.equal(read(root, 'status.json').ai.state, 'ok');
  assert.ok(read(root, 'analysis.json')['005930']?.headline);
});
await test('시간 배분: 몫을 다 쓰면 대기, 리셋 1시간 전엔 남은 한도 사용', async () => {
  const root = workspace();
  writeData(root, 'status.json', statusSeed({ 'model-primary': 20, 'model-fallback': 19 }));
  await pipeline(root, {}, T('2026-10-15T05:00:00Z'));   // 14:00 KST — 몫 31회 < 사용 39회
  assert.equal(geminiCalls(), 0);
  assert.equal(read(root, 'status.json').ai.state, 'wait');
  await pipeline(root, {}, T('2026-10-15T06:30:00Z'));   // 15:30 KST — 리셋 30분 전
  assert.equal(geminiCalls(), 3);
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.ai.used, s.ai.cap], ['ok', 42, 42]);
});
await test('AI 상태: 호출할 일 없는 첫 회차는 대기(idle) 기록, 이후 호출 있으면 정상', async () => {
  const root = workspace();
  await pipeline(root, CALM);
  assert.equal(geminiCalls(), 0);
  assert.deepEqual(read(root, 'status.json').ai, { state: 'idle', model: null, used: 0, cap: 40 });
  await pipeline(root);                       // 이번엔 급등 종목·헤드라인 있음 → 실제 호출 → 정상
  assert.equal(read(root, 'status.json').ai.state, 'ok');
});
await test('AI 상태: 한도 소진 표시는 그 한도일 동안 유지 · 다음 한도일엔 분석할 게 없어도 풀림', async () => {
  const root = workspace();
  writeData(root, 'status.json', { ai: { state: 'quota', model: 'model-primary', used: 20, cap: 20 },
    budget: { day: QDAY, used: { 'model-primary': 20 }, out: { 'model-primary': 'quota', 'model-fallback': 'quota' } } });
  await pipeline(root, CALM, NOW_KR + 5 * MIN);
  assert.equal(read(root, 'status.json').ai.state, 'quota');
  await pipeline(root, CALM, NEXT_DAY);
  assert.equal(geminiCalls(), 0);
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.budget.day, s.budget.out], ['idle', '2026-10-15', {}]);
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
    assert.deepEqual(read(root, 'status.json'), { ai: { state: 'off' } });
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

// ===== 외부 호출 줄이기 · 휴장일 · 해외 종목 문구 · 다음 분석 시각 =====
const callsTo = (re) => NET.calls.filter((u) => re.test(decodeURIComponent(u))).length;
const HIST_RE = /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/.*range=6mo/;
const STOCK_NEWS_RE = /news\.google\.com\/rss\/search\?q=.*(주가|stock)/;
const STOCK_TREND_RE = /m\.stock\.naver\.com\/api\/stock\/\d{6}\/trend/;
await test('외부 호출 줄이기: 과거시세·수급 30분, 뉴스 15분마다만 새로 받고 그 사이엔 직전 값 · 새 종목은 바로', async () => {
  const root = workspace();
  const opt = { refreshAll: false };
  await pipeline(root, { newsTag: 'a' }, NOW_KR, opt);                       // 12:00 — 모두 갱신 시각
  assert.deepEqual([callsTo(HIST_RE), callsTo(STOCK_NEWS_RE), callsTo(STOCK_TREND_RE)], [3, 3, 2]);
  const hist0 = raw(root, 'history.json');
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 6 * MIN, opt);             // 12:06 — 어느 것도 갱신 시각 아님
  assert.deepEqual([callsTo(HIST_RE), callsTo(STOCK_NEWS_RE), callsTo(STOCK_TREND_RE)], [0, 0, 0], '직전 값 재사용');
  assert.ok(read(root, 'news.json')['005930'].items[0].title.startsWith('a '), '뉴스는 직전 것 그대로');
  assert.equal(raw(root, 'history.json'), hist0);
  assert.equal(geminiCalls(), 0, '뉴스가 그대로라 AI 재분석도 없음');
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 15 * MIN, opt);            // 12:15 — 뉴스만 갱신 시각
  assert.deepEqual([callsTo(HIST_RE), callsTo(STOCK_NEWS_RE), callsTo(STOCK_TREND_RE)], [0, 3, 0]);
  assert.ok(read(root, 'news.json')['005930'].items[0].title.startsWith('b '));
  fs.writeFileSync(path.join(root, 'config', 'watchlist.json'), JSON.stringify({ items: [...ITEMS, { code: '035420', market: 'KR', name: 'NAVER' }] }));
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 21 * MIN, opt);            // 12:21 — 새 종목만 바로
  assert.deepEqual([callsTo(HIST_RE), callsTo(STOCK_NEWS_RE), callsTo(STOCK_TREND_RE)], [1, 1, 1], '추가된 종목만 받음');
  assert.ok(read(root, 'history.json')['035420'] && read(root, 'news.json')['035420'] && read(root, 'investors.json')['035420']);
});
await test('받기에 실패한 종목은 직전 과거시세·뉴스를 유지(파일에서 빠지지 않음)', async () => {
  const root = workspace();
  await pipeline(root);
  const before = read(root, 'history.json').AAPL;
  const yahoo = (m, u) => (/range=6mo/.test(u) && /AAPL/.test(u) ? text('error', 500) : json(yahooChart(decodeURIComponent(m[1]))));
  // 삼성전자 뉴스만 실패(나머지는 성공 → 파일은 새로 써짐) — 실패한 종목은 직전 뉴스를 지켜야 한다
  const news = (m, u) => (decodeURIComponent(u).includes('삼성전자') ? text('error', 500) : text(rss('new', queryName(u))));
  await pipeline(root, { yahoo, news }, NOW_KR + 30 * MIN);
  assert.deepEqual(read(root, 'history.json').AAPL, before, 'AAPL 과거시세 유지');
  const all = read(root, 'news.json');
  assert.ok(all['005930'].ok && all['005930'].items.length && !all['005930'].items[0].title.startsWith('new '), '실패한 종목 → 직전 뉴스 유지');
  assert.ok(all['000660'].items[0].title.startsWith('new '), '성공한 종목은 새 뉴스');
});
await test('휴장일: 장 시간이어도 시세가 마감이면 뉴스만 바뀐 종목·지수는 다시 분석하지 않음', async () => {
  const root = workspace();
  await pipeline(root, { newsTag: 'a' });                                                       // 평일 장중 분석
  await pipeline(root, { newsTag: 'b', krStatus: 'CLOSE', idxStatus: 'CLOSE' }, NOW_KR + 100 * MIN);
  assert.equal(geminiCalls(), 0, '휴장 — 등락 그대로, 뉴스만 바뀜 → 재분석·재판단 없음');
  await pipeline(root, { newsTag: 'c' }, NOW_KR + 200 * MIN);                                    // 장이 열려 있으면 다시
  assert.ok(briefCalls() > 0 && geminiCalls() > briefCalls(), '지수 브리핑·종목 분석 모두 갱신');
});
await test('해외 종목 AI 분석: 미국 증시 관점 · 달러 소수 둘째 자리 · 수급 줄 없음(국내는 그대로)', async () => {
  const root = workspace();
  await pipeline(root, { usPct: { AAPL: 3 } });
  const bodyOf = (name) => NET.bodies.find((b, i) => isGemini(NET.calls[i]) && b.includes(`'${name}'`));
  const us = bodyOf('애플'), kr = bodyOf('삼성전자');
  assert.ok(us && kr, '두 종목 모두 분석 요청');
  assert.ok(us.includes('미국 증시 애널리스트') && !us.includes('수급(순매수)') && /현재가 \$\d+\.\d{2}/.test(us), us.slice(0, 200));
  assert.ok(kr.includes('한국 증시 애널리스트') && kr.includes('수급(순매수)') && /현재가 [\d,]+원/.test(kr));
});
await test('미국 시간외: 시간대(프리 04:00~09:30·애프터 16:00~20:00 ET, 평일·서머타임) · 5분봉 마지막 체결 판정', () => {
  const w = (s) => bud.usExtWindow(T(s));
  assert.deepEqual(['2026-10-15T07:59:00Z', '2026-10-15T08:00:00Z', '2026-10-15T13:29:00Z', '2026-10-15T13:30:00Z', '2026-10-15T19:59:00Z',
    '2026-10-15T20:00:00Z', '2026-10-15T23:59:00Z', '2026-10-16T00:00:00Z', '2026-10-17T22:00:00Z', '2026-12-15T09:00:00Z', '2026-12-15T21:30:00Z'].map(w),
    [null, 'pre', 'pre', null, null, 'post', 'post', null, null, 'pre', 'post'], 'EDT 경계 · 토요일 · 겨울(EST)');
  const S = (s) => T(s) / 1000;
  const chart = (bars, reg = { start: S('2026-10-15T13:30:00Z'), end: S('2026-10-15T20:00:00Z') }) => ({ chart: { result: [{
    meta: { currentTradingPeriod: { regular: reg } }, timestamp: bars.map((b) => S(b[0])), indicators: { quote: [{ close: bars.map((b) => b[1]) }] } }] } });
  assert.deepEqual(src.extFromChart(chart([['2026-10-15T19:55:00Z', 200], ['2026-10-15T21:55:00Z', 206.5], ['2026-10-15T22:00:00Z', null]])),
    { session: 'post', price: 206.5, at: T('2026-10-15T21:55:00Z') }, '빈 봉은 건너뛰고 마지막 체결');
  assert.deepEqual(src.extFromChart(chart([['2026-10-15T11:00:00Z', 199]])), { session: 'pre', price: 199, at: T('2026-10-15T11:00:00Z') });
  assert.equal(src.extFromChart(chart([['2026-10-15T11:00:00Z', 199], ['2026-10-15T15:00:00Z', 201]])), null, '마지막 체결이 정규장 → 시간외 아님');
  assert.equal(src.extFromChart({ chart: { result: [{ meta: {} }] } }), null);
});
await test('미국 시간외(파이프라인): 애프터마켓에 받아 정규장 종가 대비로 · 시간대 밖엔 직전 값 · 새 정규장 뒤엔 버림 · 장중엔 없음', async () => {
  const S = (s) => T(s) / 1000;
  const REG_CLOSE = '2026-10-15T20:00:00Z';
  // 정규장 밖(마감) 시세 — normalize가 실제 현재 시각으로 장 상태를 정하므로 정규장 구간을 과거로, 마지막 정규장 체결은 고정 시각
  const closedQuote = (sym, lastRegular) => {
    const j = yahooChart(sym); const now = Math.floor(Date.now() / 1000);
    Object.assign(j.chart.result[0].meta, { regularMarketTime: S(lastRegular), currentTradingPeriod: { regular: { start: now - 7200, end: now - 3600 } } });
    return j;
  };
  const extChart = { chart: { result: [{ meta: { currentTradingPeriod: { regular: { start: S('2026-10-15T13:30:00Z'), end: S(REG_CLOSE) } } },
    timestamp: [S('2026-10-15T19:55:00Z'), S('2026-10-15T21:55:00Z')], indicators: { quote: [{ close: [225, 230] }] } }] } };
  const yahoo = (lastRegular) => (m, u) => {
    const sym = decodeURIComponent(m[1]);
    if (/interval=5m/.test(u)) return json(extChart);
    return json(sym === 'AAPL' ? closedQuote(sym, lastRegular) : yahooChart(sym));
  };
  const root = workspace();
  await pipeline(root, { yahoo: yahoo(REG_CLOSE) }, T('2026-10-15T22:00:00Z'));          // 목 18:00 ET — 애프터마켓
  const q1 = read(root, 'quotes.json').quotes.find((x) => x.code === 'AAPL');
  assert.equal(q1.marketStatus, 'CLOSE');
  assert.deepEqual(q1.ext, { session: 'post', price: 230, change: Math.round((230 - q1.price) * 10000) / 10000,
    changePct: Math.round(((230 - q1.price) / q1.price) * 10000) / 100, at: T('2026-10-15T21:55:00Z') });
  assert.equal(callsTo(/interval=5m/), 1, '미국 마감 종목만 시간외 요청(국내 제외)');
  await pipeline(root, { yahoo: yahoo(REG_CLOSE) }, T('2026-10-16T01:30:00Z'));          // 21:30 ET — 시간외 끝
  assert.equal(callsTo(/interval=5m/), 0, '시간대 밖엔 요청 안 함');
  assert.deepEqual(read(root, 'quotes.json').quotes.find((x) => x.code === 'AAPL').ext, q1.ext, '직전 값 유지');
  await pipeline(root, { yahoo: yahoo('2026-10-15T22:30:00Z') }, T('2026-10-16T02:00:00Z')); // 그 뒤에 정규장 체결이 생긴 상황
  assert.ok(!('ext' in read(root, 'quotes.json').quotes.find((x) => x.code === 'AAPL')), '새 정규장 체결보다 오래된 시간외는 버림');
  const fresh = workspace();                                                              // 배포 직후처럼 직전 값이 없으면
  await pipeline(fresh, { yahoo: yahoo(REG_CLOSE) }, T('2026-10-16T01:30:00Z'));         // 애프터마켓 끝난 밤에도 한 번 받음
  assert.equal(callsTo(/interval=5m/), 1);
  assert.equal(read(fresh, 'quotes.json').quotes.find((x) => x.code === 'AAPL').ext?.price, 230, '그날 마지막 시간외 가격');
  await pipeline(fresh, { yahoo: yahoo(REG_CLOSE) }, T('2026-10-16T01:35:00Z'));
  assert.equal(callsTo(/interval=5m/), 0, '채운 뒤엔 다시 받지 않음');
  assert.equal(bud.usAfterPostSameDay(T('2026-10-16T04:30:00Z')), false, '자정 지나면(새 날) 아님');
  const open = workspace();
  await pipeline(open, {}, T('2026-10-15T22:00:00Z'));                                   // 시세가 장중(OPEN)이면
  assert.equal(callsTo(/interval=5m/), 0);
  assert.ok(!('ext' in read(open, 'quotes.json').quotes.find((x) => x.code === 'AAPL')), '장중엔 시간외 없음');
});
await test('과거 시세: 최근 봉이 빠진 응답(야후 매일 밤 UTC 자정 무렵)은 직전 봉으로 보완 · 4일 넘게 모자라면 직전 것 유지 · 새 봉이 오면 새 값', async () => {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const series = (endDay, base) => { // endDay까지 평일 130개 일봉, 종가 = base + 순번
    const ts = []; let t = Date.parse(`${endDay}T13:30:00Z`);
    while (ts.length < 130) { const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) ts.unshift(t / 1000); t -= 86400e3; }
    return { chart: { result: [{ meta: { regularMarketPrice: base }, timestamp: ts, indicators: { quote: [{ close: ts.map((_, i) => base + i) }] } }] } };
  };
  const yahoo = (endDay, base) => (m, u) => {
    const sym = decodeURIComponent(m[1]);
    if (/range=6mo/.test(u)) return json(series(endDay, base));
    if (/interval=5m/.test(u)) return json({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }] } });
    return json(yahooChart(sym));
  };
  const root = workspace();
  const tail = () => { const h = read(root, 'history.json').AAPL; return { n: h.closes.length, last: day(h.dates.at(-1)), lastClose: h.closes.at(-1), prevClose: h.closes.at(-2) }; };
  await pipeline(root, { yahoo: yahoo('2026-10-21', 100) });
  assert.deepEqual(tail(), { n: 130, last: '2026-10-21', lastClose: 229, prevClose: 228 });
  await pipeline(root, { yahoo: yahoo('2026-10-20', 200) }, NOW_KR + 5 * MIN);   // 마지막 날(10/21) 봉이 빠진 응답
  assert.deepEqual(tail(), { n: 131, last: '2026-10-21', lastClose: 229, prevClose: 329 }, '10/21 봉은 직전 값, 겹치는 10/20은 새 값');
  await pipeline(root, { yahoo: yahoo('2026-10-15', 300) }, NOW_KR + 10 * MIN);  // 4거래일 넘게 모자란 응답 → 깨진 것으로 보고 직전 것
  assert.deepEqual(tail(), { n: 131, last: '2026-10-21', lastClose: 229, prevClose: 329 });
  await pipeline(root, { yahoo: yahoo('2026-10-22', 400) }, NOW_KR + 15 * MIN);  // 새 날 봉이 들어오면 새 값 그대로
  assert.deepEqual(tail(), { n: 130, last: '2026-10-22', lastClose: 529, prevClose: 528 });
});
const sha10 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
await test('파일 지문(manifest.json): 화면이 받는 파일마다 sha1 앞 10자리 · 실제 내용과 일치 · 없는 파일은 빠짐 · 바뀐 파일만 바뀜 · 쓴 게 없으면 안 씀', async () => {
  const root = workspace();
  const { value } = await pipeline(root);
  assert.ok(value.written.includes('manifest.json'));
  const man = read(root, 'manifest.json');
  const names = ['analysis.json', 'history.json', 'investors.json', 'market.json', 'moves.json', 'news.json', 'quotes.json', 'status.json'];
  assert.deepEqual(Object.keys(man.files).sort(), names, '공시 키가 없으면 disclosures.json이 없어 빠짐(화면은 그 파일만 예전처럼)');
  for (const f of names) assert.equal(man.files[f], sha10(fs.readFileSync(file(root, f))), `${f} 지문`);
  // 다음 회차(간격 밖) — 시세는 바뀌고 과거 시세·뉴스·수급은 직전 값 그대로라 지문도 그대로
  await pipeline(root, { krPct: { '005930': 4.6, '000660': 0.3 } }, NOW_KR + 5 * MIN, { refreshAll: false });
  const man2 = read(root, 'manifest.json');
  assert.notEqual(man2.files['quotes.json'], man.files['quotes.json']);
  for (const f of ['history.json', 'news.json', 'investors.json']) assert.equal(man2.files[f], man.files[f], `${f} 그대로`);
  for (const f of Object.keys(man2.files)) assert.equal(man2.files[f], sha10(fs.readFileSync(file(root, f))), `${f} 지문(2회차)`);
  // 아무것도 못 받은 회차 — 직전 값을 그대로 다시 쓴 파일뿐이라 지문이 같고, 지문 파일도 다시 쓰지 않음
  // (쓴 파일이 하나도 없으면 아예 계산하지 않는 것은 '전부 실패' 테스트가 확인)
  const before = raw(root, 'manifest.json');
  NET.routes = [{ re: /./, fn: () => { throw new TypeError('fetch failed'); } }];
  const { value: v3 } = await quiet(() => run({ root, now: NOW_KR + 10 * MIN }));
  assert.ok(!v3.written.includes('manifest.json'), '같은 내용이면 지문 파일을 다시 쓰지 않음');
  assert.equal(raw(root, 'manifest.json'), before);
});
await test('급등락 기록(moves.json): ±2% 넘은 날의 등락·이유(AI > 공시 > 뉴스) · 시장 현지 날짜 · 2% 아래로 돌아오면 지움 · 더 나은 이유 유지 · 120일·20건·목록에서 빠진 종목 정리', async () => {
  const root = workspace();
  await pipeline(root, { krAt: NOW_KR });
  const mv = () => read(root, 'moves.json');
  assert.deepEqual(mv()['005930'], [{ d: '20261015', p: 4.2, r: '테스트 진단', s: 'ai' }], '+4.2% — 그날 AI 진단');
  assert.equal(mv()['000660'], undefined, '+0.3%는 기록 안 함');
  await pipeline(root, { krAt: NOW_KR + 5 * MIN, krPct: { '005930': 1.5, '000660': 0.3 } }, NOW_KR + 5 * MIN);
  assert.equal(mv()['005930'], undefined, '장중에 2% 아래로 돌아오면 그날 기록을 지움');
  // 이미 AI 이유가 있으면 AI가 실패해 뉴스밖에 없어도 그 이유를 지키고 등락만 고친다
  writeData(root, 'moves.json', { '005930': [{ d: '20261015', p: 3, r: '이전 AI 진단', s: 'ai' }] });
  fs.rmSync(file(root, 'analysis.json'));
  const fail = { gemini: () => text('upstream error', 500) };
  await pipeline(root, { ...fail, krAt: NOW_KR + 10 * MIN, krPct: { '005930': 3.3, '000660': 0.3 } }, NOW_KR + 10 * MIN);
  assert.deepEqual(mv()['005930'], [{ d: '20261015', p: 3.3, r: '이전 AI 진단', s: 'ai' }]);
  // 그날 AI 진단이 없으면(이틀 전 분석만 남아 있으면 쓰지 않음) 뉴스 제목(최근 것) — 길면 140자로 줄임
  const r2 = workspace();
  writeData(r2, 'analysis.json', { '005930': { headline: '이틀 전 진단', summary: 's', factors: [], outlook: 'o', sig: 'old', at: NOW_KR - 2 * 1440 * MIN } });
  await pipeline(r2, { ...fail, krAt: NOW_KR, newsTag: '가'.repeat(200) });
  const e2 = read(r2, 'moves.json')['005930'][0];
  assert.equal(e2.s, 'news');
  assert.ok(e2.r.length === 140 && e2.r.endsWith('…') && e2.r.startsWith('가가'), '긴 제목은 줄임');
  // 주요 공시가 있으면 뉴스보다 공시(최근 3일 안)
  await withDartKey(async () => {
    const r3 = workspace();
    await pipeline(r3, { ...fail, krAt: NOW_KR });
    const key = read(r3, 'disclosures.json')['005930'].items.find((x) => x.key);
    assert.deepEqual(read(r3, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: `[${key.tag}] ${key.title}`, s: 'disc' });
    // 열흘 전 주요 공시는 그날 이유로 보지 않음 → 뉴스
    const r3b = workspace();
    await pipeline(r3b, { ...fail, krAt: NOW_KR, dartRows: { '00126380': [['20261005000100', '단일판매ㆍ공급계약체결']] } });
    assert.ok(read(r3b, 'disclosures.json')['005930'].items[0].key, '공시 자체는 주요 공시');
    assert.equal(read(r3b, 'moves.json')['005930'][0].s, 'news');
  });
  // 뉴스도 전날부터 나온 것만 — 움직인 날보다 이틀 넘게 앞선 기사뿐이면 이유 없음
  const r3c = workspace();
  await pipeline(r3c, { ...fail, krAt: Date.now() + 3 * 1440 * MIN });
  assert.deepEqual(['r', 's'].map((k) => read(r3c, 'moves.json')['005930'][0][k]), ['', '']);
  // 미국 종목은 뉴욕 날짜 — 뉴욕 10/15 16:00(한국 10/16 05:00) 시세면 '20261015'
  const usAt = T('2026-10-15T20:00:00Z');
  const yahoo = (m, u) => {
    const sym = decodeURIComponent(m[1]);
    if (/interval=5m/.test(u)) return json({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }] } });
    const j = yahooChart(sym, sym === 'AAPL' ? -3.1 : undefined);
    if (sym === 'AAPL') j.chart.result[0].meta.regularMarketTime = usAt / 1000;
    return json(j);
  };
  const r4 = workspace();
  await pipeline(r4, { yahoo }, T('2026-10-15T21:00:00Z'));
  const us = read(r4, 'moves.json').AAPL[0];
  assert.deepEqual([us.d, us.p], ['20261015', -3.1]);
  // 정리 — 120일 넘은 기록·종목당 20건 초과·추적 목록에 없는 종목
  const r5 = workspace();
  const many = Array.from({ length: 14 }, (_, i) => ({ d: `202610${String(i + 1).padStart(2, '0')}`, p: -2.5, r: `기록${i}`, s: 'news' })); // 10/01~10/14
  const old = Array.from({ length: 12 }, (_, i) => ({ d: `202609${String(i + 10).padStart(2, '0')}`, p: 3, r: `9월${i}`, s: 'news' }));
  writeData(r5, 'moves.json', { '005930': [{ d: '20260607', p: 5, r: '오래됨', s: 'ai' }], '000660': [...many, ...old], ZZZZ: [{ d: '20261014', p: 3, r: 'x', s: 'ai' }] });
  await pipeline(r5, { krAt: NOW_KR });
  const m5 = read(r5, 'moves.json');
  assert.deepEqual(m5['005930'].map((x) => x.d), ['20261015'], '120일 넘은 기록은 지우고 오늘 것만');
  assert.equal(m5['000660'].length, 20, '종목당 20건');
  assert.equal(m5['000660'][0].d, '20261014', '최신순');
  assert.equal(m5.ZZZZ, undefined, '추적 목록에서 빠진 종목은 지움');
});
await test('뉴스 관련도: 우선주는 보통주 이름 · 영문 핵심 이름 · 별칭 · 미국 티커(대문자 단어) · 무관 기사·도박 스팸 제외', () => {
  assert.deepEqual([src.krBaseName('LG전자우', '066575'), src.krBaseName('현대차2우B', '005387'), src.krBaseName('삼성전자', '005930')], ['LG전자', '현대차', '삼성전자']);
  assert.deepEqual(['Tesla, Inc.', 'Amazon.com, Inc.', 'Super Micro Computer, Inc.', 'Taiwan Semiconductor Manufacturing Company Ltd.', 'Space Exploration Technologies Corp. Class A', 'NVIDIA Corporation']
    .map(src.enCoreName), ['Tesla', 'Amazon', 'Super Micro Computer', 'Taiwan Semiconductor Manufacturing', 'Space Exploration Technologies', 'NVIDIA']);
  const ok = (title, item) => src.isRelevantNews(title, item);
  const kr = (code, name) => ({ code, name, market: 'KR' });
  const us = (code, name, en) => ({ code, name, market: 'US', en });
  assert.equal(ok('여러 기능이 함께 나올 때 읽는 토토미 쌀국수 작동 순서', kr('066575', 'LG전자우')), false, '무관 기사');
  assert.equal(ok('LG전자, 3분기 영업이익 시장 기대 웃돌아', kr('066575', 'LG전자우')), true, '우선주는 보통주 이름으로');
  assert.equal(ok('LS일렉트릭, 사상 최대 실적…100분기 연속 흑자', kr('010120', 'LS ELECTRIC')), true, '별칭');
  assert.equal(ok('대한전선 | 미국 송전망 투자는 이제 시작', kr('010120', 'LS ELECTRIC')), false, '다른 회사 기사');
  assert.equal(ok('한국투자증권, ELW 224종목 신규 상장', kr('000720', '현대건설')), false, '상장 공지');
  assert.equal(ok('현대중공업 주가 2,000원 상승 후 장마감', kr('329180', 'HD현대중공업')), true);
  assert.equal(ok("Did Tesla's Fall Catch You Out?", us('TSLA', '테슬라', 'Tesla, Inc.')), true, '영문 이름');
  assert.equal(ok('Micron stock forecast: AI demand, China competition', us('TSLA', '테슬라', 'Tesla, Inc.')), false);
  assert.equal(ok('Why PLUG stock jumped today', us('PLUG', '플러그파워', 'Plug Power, Inc.')), true, '티커');
  assert.equal(ok('Best plug-in hybrids of 2026', us('PLUG', '플러그파워', 'Plug Power, Inc.')), false, '소문자 일반 단어는 티커 아님');
  assert.equal(ok('Supermicro spikes after raising guidance', us('SMCI', '슈퍼 마이크로 컴퓨터', 'Super Micro Computer, Inc.')), true);
  assert.equal(ok('Advanced Micro rallies on new AI chip', us('AMD', 'AMD', 'Advanced Micro Devices, Inc.')), true, '별칭 없는 세 단어 이름 → 앞 두 단어');
  assert.equal(ok('삼전닉스 반등에도 갈 길 먼 주가', kr('000660', 'SK하이닉스')), true, '줄임말 별칭');
  assert.equal(ok('Musk Vows to Give Each U.S. Child a SpaceX Share', us('SPCX', '스페이스X', 'Space Exploration Technologies Corp. Class A')), true);
  assert.equal(ok('엔비디아 주가 반등', us('NVDA', '엔비디아', '')), true, '한글 이름(목록 없을 때)');
  assert.ok(src.SPAM_RE.test('규칙이 적용되는 순서가 궁금한 a1 카지노') && src.SPAM_RE.test('먹튀 없는 토토사이트 추천'));
  assert.ok(!src.SPAM_RE.test('개미들, 엔비디아에 베팅') && !src.SPAM_RE.test('삼성전자, 새 메모리 슬롯 규격 공개'), '금융 기사의 베팅·슬롯은 스팸 아님');
});
await test('뉴스 관련도: 종목 이름 바로 뒤에 다른 회사 이름(현대차증권·현대건설기계)이 이어지면 그 회사 기사 · 그룹·제대로 된 언급은 관련', () => {
  const car = { code: '005380', market: 'KR', name: '현대차' }, eng = { code: '000720', market: 'KR', name: '현대건설' };
  assert.equal(src.isRelevantNews('현대차증권, LS일렉트릭 내년 이익 전망 상향...“미국 빅테크 수주·매출 증가”', car), false);
  assert.equal(src.isRelevantNews('현대차증권 "현대차 목표가 상향…하이브리드 판매 호조"', car), true, '같은 제목에 현대차 언급이 따로 있으면 관련');
  assert.equal(src.isRelevantNews('현대차그룹, AI 인프라 확충…2029년 새만금서 GPU 1만장 운영 추진', car), true, '그룹 기사는 관련');
  assert.equal(src.isRelevantNews('현대차, 증권가 목표가 상향 잇따라', car), true, '쉼표 뒤 증권가는 다른 말');
  assert.equal(src.isRelevantNews('현대자동차 美 관세 합의 수혜', car), true, '별칭');
  assert.equal(src.isRelevantNews('현대건설기계 장중 3%대 상승', eng), false);
  assert.equal(src.isRelevantNews('로이터 “삼성물산·현대건설, 차세대 SMR 건설 파트너로 부상”', eng), true);
  assert.equal(src.isRelevantNews('Hyundai Motor shares rise', { code: 'HYMTF', market: 'US', name: 'Hyundai', en: 'Hyundai Motor' }), true, '미국 종목은 그대로');
});
await test('뉴스 관련도(파이프라인): 무관 기사·스팸은 빼고 관련 기사만 저장 · 우선주는 보통주로 검색 · 미국은 검색 목록 영문명으로', async () => {
  const root = workspace([...ITEMS, { code: '066575', market: 'KR', name: 'LG전자우' }]);
  writeData(root, 'stocklist.json', { v: 2, kr: [], us: [['AAPL', '애플', 'Apple Inc.', 'NASDAQ', 1]], meta: {} });
  const pub = new Date(Date.now() - 3600e3).toUTCString();
  const item = (t) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/${encodeURIComponent(t)}</link><pubDate>${pub}</pubDate></item>`;
  const news = (m, u) => {
    const name = queryName(u).split(' ')[0];
    const titles = /stock/.test(new URL(u).searchParams.get('q'))
      ? ['Apple stock jumps on iPhone demand', 'Micron stock forecast: AI demand', 'Best plug-in hybrids of 2026']
      : [`${name} 실적 기대에 급등`, '여러 기능이 함께 나올 때 읽는 토토미 쌀국수 작동 순서', `${name} 주가 카지노 바카라 안내`, '한국투자증권, ELW 224종목 신규 상장'];
    return text(`<?xml version="1.0"?><rss><channel>${titles.map(item).join('')}</channel></rss>`);
  };
  await pipeline(root, { news });
  const d = read(root, 'news.json');
  assert.deepEqual(d['005930'].items.map((x) => x.title), ['삼성전자 실적 기대에 급등']);
  assert.deepEqual(d['066575'].items.map((x) => x.title), ['LG전자 실적 기대에 급등'], '우선주 → 보통주 기사');
  assert.deepEqual(d.AAPL.items.map((x) => x.title), ['Apple stock jumps on iPhone demand'], '영문 이름으로 관련 판단');
  const qs = NET.calls.filter((u) => /news\.google\.com/.test(u)).map((u) => new URL(u).searchParams.get('q'));
  assert.ok(qs.some((q) => q.startsWith('LG전자 주가')) && !qs.some((q) => q.startsWith('LG전자우')), qs.join(' / '));
  assert.equal(d['005930'].summary.total, 1, '호재·악재 집계도 관련 기사만');
});
await test('수급 날짜: AI 입력에 오늘 값인지 전 거래일 확정치인지 밝힘(장중엔 전날 값 — 오늘 원인으로 오해 방지)', async () => {
  const bodyOf = () => NET.bodies.find((b, i) => isGemini(NET.calls[i]) && b.includes("'삼성전자'")) || '';
  await pipeline(workspace());                // 10/15 장중, 수급 날짜 20261015 → 오늘
  assert.ok(bodyOf().includes('외국인지분 50.00% (오늘)'), bodyOf().slice(0, 400));
  await pipeline(workspace(), {}, NEXT_DAY);  // 10/16 장중인데 수급은 아직 10/15 값
  assert.ok(bodyOf().includes('(10/15 확정치 — 오늘 장중 수급 아님)'), bodyOf().slice(0, 400));
});
await test('휴장 확인 시간대: 개장 10분 뒤~마감 10분 전 · 시장 날짜 · 주말 제외 · 서머타임', () => {
  const d = (m, s) => bud.closedCheckDay(m, T(s));
  assert.equal(d('KR', '2026-10-15T00:09:00Z'), null, '09:09 KST');
  assert.equal(d('KR', '2026-10-15T00:10:00Z'), '2026-10-15', '09:10 KST');
  assert.equal(d('KR', '2026-10-15T06:19:00Z'), '2026-10-15', '15:19 KST');
  assert.equal(d('KR', '2026-10-15T06:20:00Z'), null, '15:20 KST');
  assert.equal(d('KR', '2026-10-17T03:00:00Z'), null, '토요일');
  assert.equal(d('US', '2026-10-15T13:39:00Z'), null, '09:39 EDT');
  assert.equal(d('US', '2026-10-15T13:40:00Z'), '2026-10-15', '09:40 EDT');
  assert.equal(d('US', '2026-10-15T19:49:00Z'), '2026-10-15', '15:49 EDT');
  assert.equal(d('US', '2026-10-15T19:50:00Z'), null, '15:50 EDT');
  assert.equal(d('US', '2026-12-15T14:39:00Z'), null, '09:39 EST(겨울)');
  assert.equal(d('US', '2026-12-15T14:40:00Z'), '2026-12-15', '09:40 EST(겨울)');
  assert.equal(d('KR', '2026-10-15T15:00:00Z'), null, '미국 장중 = 국내 자정');
});
await test('휴장 기록: 장 시간에 시세가 마감이면 그 시장 날짜를 남김 · 평소엔 없음 · 이어받기 · 이상한 값 버림', async () => {
  const root = workspace();
  await pipeline(root, { krStatus: 'CLOSE' });                                          // 목 12:00 KST, 국내 휴장
  assert.deepEqual(read(root, 'quotes.json').closed, { KR: '2026-10-15' }, '국내만 기록(미국은 확인 시간 아님)');
  await pipeline(root, {}, NOW_KR + 5 * MIN);                                           // 같은 날 장중이 돼도 그날 기록은 유지
  assert.deepEqual(read(root, 'quotes.json').closed, { KR: '2026-10-15' });
  const yahoo = (m) => {                                                                // 미국 휴장 — 정규장 시간이 이미 지난 응답
    const j = yahooChart(decodeURIComponent(m[1])); const s = Math.floor(Date.now() / 1000);
    j.chart.result[0].meta.currentTradingPeriod.regular = { start: s - 7200, end: s - 3600 };
    return json(j);
  };
  await pipeline(root, { yahoo }, T('2026-10-15T15:00:00Z'));                           // 목 11:00 ET
  assert.deepEqual(read(root, 'quotes.json').closed, { KR: '2026-10-15', US: '2026-10-15' });
  writeData(root, 'quotes.json', { quotes: [], closed: { KR: '15일', XX: '2026-10-01', US: '2026-10-01' } });
  await pipeline(root, {}, NOW_KR + 1440 * MIN);
  assert.deepEqual(read(root, 'quotes.json').closed, { US: '2026-10-01' }, '형식이 맞는 시장 기록만 이어받음');
  const plain = workspace();
  await pipeline(plain);
  assert.ok(!('closed' in read(plain, 'quotes.json')), '평소(장중)엔 필드 자체가 없음 — 파일 모양 그대로');
});
await test('화면 지연 경고(app.js): 장중 45분 · 개장 30분 뒤 · 휴장 기록 · 주말 · 장 밖 · 경과 표기', async () => {
  // 브라우저 코드에서 '데이터 지연 경고' 블록만 떼어 빈 환경에서 실행한다(DOM 없이 판정 로직만 검사)
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('// ---------- 데이터 지연 경고'), appJs.indexOf('// 시장별 묶음'));
  assert.ok(block.length > 200 && block.includes('function staleOf'), '블록 추출');
  const { staleOf } = vm.runInNewContext(`${block}; ({ staleOf })`, {});
  const KR_NOON = T('2026-10-15T03:00:00Z'), US_11 = T('2026-10-15T15:00:00Z');
  const q = (status, ageMin, at) => [{ marketStatus: status, asOf: new Date(at - ageMin * MIN).toISOString(), ok: true }];
  const s = (m, list, closed, at) => staleOf(m, list, closed, at);
  assert.equal(s('KR', q('OPEN', 10, KR_NOON), null, KR_NOON), '', '장중 10분 전 시세');
  assert.equal(s('KR', q('OPEN', 45, KR_NOON), null, KR_NOON), '', '45분까지는 정상(15:30~16:00 무체결 26분 + 여유)');
  assert.equal(s('KR', q('OPEN', 46, KR_NOON), null, KR_NOON), '46분째 갱신 없음');
  assert.equal(s('KR', q('OPEN', 180, KR_NOON), null, KR_NOON), '3시간째 갱신 없음');
  assert.equal(s('KR', q('OPEN', 30 * 60, KR_NOON), null, KR_NOON), '30시간째 갱신 없음', '이틀 미만은 시간');
  assert.equal(s('US', q('OPEN', 3 * 1440, KR_NOON), null, KR_NOON), '3일째 갱신 없음', '장중 표시가 굳은 채면 장 밖이어도 경고');
  const yClose = q('CLOSE', 16 * 60, KR_NOON); // 어제 20:00 마감 시세
  assert.equal(s('KR', yClose, null, KR_NOON), '개장 후 갱신 없음');
  assert.equal(s('KR', yClose, { KR: '2026-10-15' }, KR_NOON), '', '봇이 오늘 휴장 확인');
  assert.equal(s('KR', yClose, { KR: '2026-10-14', US: '2026-10-15' }, KR_NOON), '개장 후 갱신 없음', '다른 날·다른 시장 기록은 무관');
  const at = (hhmm) => T(`2026-10-15T${hhmm}:00+09:00`);
  assert.equal(s('KR', q('CLOSE', 600, at('09:29')), null, at('09:29')), '', '개장 30분 전까지는 첫 수집 대기');
  assert.equal(s('KR', q('CLOSE', 600, at('09:30')), null, at('09:30')), '개장 후 갱신 없음');
  assert.equal(s('KR', q('CLOSE', 600, at('15:29')), null, at('15:29')), '개장 후 갱신 없음');
  assert.equal(s('KR', q('CLOSE', 600, at('15:30')), null, at('15:30')), '', '정규장 마감 후');
  assert.equal(s('KR', q('PREOPEN', 46, at('09:45')), null, at('09:45')), '개장 후 갱신 없음', '장 전 상태에서 멈춤');
  assert.equal(s('KR', q('PREOPEN', 5, at('09:45')), null, at('09:45')), '', '상태가 이상해도 방금 받은 시세면 경고 안 함');
  assert.equal(s('KR', q('CLOSE', 600, T('2026-10-17T03:00:00Z')), null, T('2026-10-17T03:00:00Z')), '', '토요일');
  assert.equal(s('KR', q('CLOSE', 600, US_11), null, US_11), '', '국내 자정');
  assert.equal(s('US', q('CLOSE', 19 * 60, US_11), null, US_11), '개장 후 갱신 없음', '미국 장중인데 어제 마감 시세');
  assert.equal(s('US', q('CLOSE', 19 * 60, US_11), { US: '2026-10-15' }, US_11), '', '미국 휴장 확인');
  const et = (hhmm) => T(`2026-10-15T${hhmm}:00-04:00`);
  assert.equal(s('US', q('CLOSE', 600, et('09:59')), null, et('09:59')), '');
  assert.equal(s('US', q('CLOSE', 600, et('10:00')), null, et('10:00')), '개장 후 갱신 없음');
  assert.equal(s('KR', [{ marketStatus: 'OPEN', asOf: 'x', ok: true }], null, KR_NOON), '', '시각을 알 수 없으면 판단 안 함');
  assert.equal(s('KR', [], null, KR_NOON), '');
  const mixed = [...q('OPEN', 50, KR_NOON), ...q('CLOSE', 5, KR_NOON)];
  assert.equal(s('KR', mixed, null, KR_NOON), '', '가장 최근 시세 기준');
});
await test('바뀐 파일만 받기(app.js): 지문이 같으면 다시 안 받음 · 바뀌면 그 파일만 · 내용이 지문과 다르면 예전처럼 새로 받기 · 지문 파일이 없으면 예전 방식', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('async function loadJson('), appJs.indexOf('// ---------- 통계 / 예측'));
  assert.ok(block.includes('function loadData') && block.includes('function loadManifest'), '블록 추출');
  const files = { 'a.json': '{"n":1}', 'b.json': '{"n":2}' };
  let manifest = { files: { 'a.json': sha10(files['a.json']), 'b.json': sha10(files['b.json']) } };
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const name = url.split('?')[0].replace('./data/', '');
    if (name === 'manifest.json') return manifest ? new Response(JSON.stringify(manifest)) : new Response('없음', { status: 404 });
    return files[name] != null ? new Response(files[name]) : new Response('없음', { status: 404 });
  };
  const vmApi = vm.runInNewContext(`${block}; ({ loadManifest, loadData })`, { fetch: fakeFetch, crypto: globalThis.crypto, TextDecoder });
  // 다른 실행 환경에서 만든 객체는 그대로 비교하면 프로토타입이 달라 같지 않다고 나온다 — 이쪽 객체로 바꿔 비교
  const api = { loadManifest: () => vmApi.loadManifest(), loadData: async (n) => JSON.parse(JSON.stringify(await vmApi.loadData(n))) };
  const count = (re) => calls.filter((u) => re.test(u)).length;
  await api.loadManifest();
  assert.deepEqual(await api.loadData('a.json'), { n: 1 });
  assert.deepEqual(await api.loadData('a.json'), { n: 1 });
  assert.equal(count(/^\.\/data\/a\.json\?v=/), 1, '지문이 같으면 다시 안 받음');
  assert.ok(calls.includes(`./data/a.json?v=${manifest.files['a.json']}`), '주소에 지문');
  await api.loadData('b.json');
  files['a.json'] = '{"n":3}'; manifest = { files: { ...manifest.files, 'a.json': sha10(files['a.json']) } };
  await api.loadManifest();
  assert.deepEqual(await api.loadData('a.json'), { n: 3 }, '바뀐 파일은 새로');
  await api.loadData('b.json');
  assert.equal(count(/^\.\/data\/b\.json/), 1, '안 바뀐 파일은 그대로');
  // 지문과 내용이 다르면(배포 중 엇갈림) 예전처럼 새로 받고, 그 지문 주소는 다시 쓰지 않음
  manifest = { files: { ...manifest.files, 'a.json': '0123456789' } };
  await api.loadManifest();
  assert.deepEqual(await api.loadData('a.json'), { n: 3 });
  assert.deepEqual(await api.loadData('a.json'), { n: 3 });
  assert.equal(count(/a\.json\?v=0123456789/), 1, '틀린 지문 주소는 한 번만');
  assert.equal(count(/^\.\/data\/a\.json\?t=/), 2, '대신 매번 새로(예전 방식)');
  // 지문 파일이 없거나 그 파일 지문이 없으면 예전 방식
  manifest = null;
  await api.loadManifest();
  await api.loadData('b.json');
  assert.equal(count(/^\.\/data\/b\.json\?t=/), 1);
  manifest = { files: { 'a.json': sha10(files['a.json']) } };
  await api.loadManifest();
  await api.loadData('b.json');
  assert.equal(count(/^\.\/data\/b\.json\?t=/), 2);
});
await test('시장 비교·6개월 신고가·지난 급등락(app.js): 단순 평균 · 같은 시장 지수 · 오늘 봉 제외 · 시장 현지 날짜', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  assert.ok(block.includes('function sixMonthMark') && block.includes('function pastMoves'), '블록 추출');
  const f = vm.runInNewContext(`${block}; ({ marketYmd, avgPct, benchOf, sixMonthMark, pastMoves })`, {});
  const usClose = T('2026-10-15T20:00:00Z'); // 뉴욕 10/15 16:00 = 한국 10/16 05:00
  assert.deepEqual([f.marketYmd(usClose, 'US'), f.marketYmd(usClose, 'KR')], ['20261015', '20261016']);
  assert.equal(f.avgPct([{ ok: true, changePct: 2 }, { ok: true, changePct: -1 }, { ok: false, changePct: 9 }, { ok: true }]), 0.5);
  assert.equal(f.avgPct([]), null);
  const idx = [{ symbol: '^KS11', changePct: -0.8 }, { symbol: '^KQ11', changePct: 1.2 }, { symbol: '^GSPC', changePct: 0.5 }, { symbol: '^IXIC' }];
  assert.deepEqual(JSON.parse(JSON.stringify(f.benchOf('KR', idx))), [{ name: '코스피', pct: -0.8 }, { name: '코스닥', pct: 1.2 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.benchOf('US', idx))), [{ name: 'S&P 500', pct: 0.5 }], '값 없는 지수는 뺌');
  assert.deepEqual(JSON.parse(JSON.stringify(f.benchOf('XX', idx))), []);
  // 국내 일봉 100개(00:00Z = 한국 09:00), 종가 100~199 — 마지막 봉이 오늘이면 빼고 비교
  const dates = Array.from({ length: 100 }, (_, i) => T('2026-06-01T00:00:00Z') + i * 86400e3);
  const h = { dates, closes: dates.map((_, i) => 100 + i) };
  const today = new Date(dates.at(-1) + 5 * 3600e3).toISOString(); // 마지막 봉과 같은 한국 날짜
  const next = new Date(dates.at(-1) + 30 * 3600e3).toISOString();
  const q = (price, asOf, extra = {}) => ({ ok: true, market: 'KR', price, asOf, ...extra });
  assert.equal(f.sixMonthMark(q(198.5, today), h), 'high', '오늘 봉(199)은 빼고 198과 비교');
  assert.equal(f.sixMonthMark(q(198.5, next), h), null, '마지막 봉이 오늘이 아니면 그 봉(199)까지 비교');
  assert.equal(f.sixMonthMark(q(199.5, next), h), 'high');
  assert.equal(f.sixMonthMark(q(99, today), h), 'low');
  assert.equal(f.sixMonthMark(q(150, today), h), null);
  assert.equal(f.sixMonthMark(q(250, today), { dates: dates.slice(-50), closes: h.closes.slice(-50) }), null, '석 달치도 없으면 판단 안 함');
  assert.equal(f.sixMonthMark(q(250, today, { ok: false }), h), null);
  const list = [{ d: '20261010', p: 3 }, { d: '20261015', p: -4 }, { d: '20261014', p: 2.5 }, { d: 'bad', p: 9 }, { d: '20261001', p: -2 }, { d: '20260920', p: 5 }, { d: '20260901', p: 2 }];
  const pm = [...f.pastMoves({ market: 'US', asOf: new Date(usClose).toISOString() }, list).map((x) => x.d)]; // 다른 실행 환경의 배열 → 이쪽 배열로
  assert.deepEqual(pm, ['20261014', '20261010', '20261001', '20260920'], '오늘(뉴욕 10/15) 것·형식 오류 빼고 최신 4건');
  assert.deepEqual([...f.pastMoves({ market: 'US', asOf: 'x' }, null)], []);
});
// 실제 제목(2026-10-22 news.json) — 시세만 알려 주는 자동 기사 / 이유가 들어 있는 기사
const PRICE_ONLY_YES = ['SK하이닉스 주가, 10월 22일 장중 1,281,000원 1.00% 하락', '삼성전자우 주가, 10월 22일 장중 172,900원 0.41% 상승',
  'SK텔레콤 주가, 10월 21일 애프터마켓 77,300원 0.00% 보합', 'LG에너지솔루션 주가, 10월 21일 411,500원 0.60% 하락', '현대중공업 주가 하락 중',
  '슈퍼 마이크로 컴퓨터 주가 상승 중', 'HD건설기계 장중 3%대 상승', '현대중공업 주가 2,000원 상승 후 장마감', '한화솔루션 주가 50원 하락 후 장마감',
  '[특징주] 한화솔루션 장중 2%대 강세 3만1450원 기록 : 기업주식정보', 'SK텔레콤 거래량 13.6% 감소…20일 65만2578주',
  '[특징주] 한미반도체, 장중 1%대 상승하며 20만2000원 기록 : 기업주식정보'];
const PRICE_ONLY_NO = ['영업이익 추정치 웃돈 파두…주가는 장중 6.75% 하락', '삼성전기 주가 3.08% 상승…엔비디아 기판 생산능력 확대에 공급 수혜 기대',
  '호실적에 자사주 소각까지…삼성E&A 15% 상승세 [특징주]', '[장중수급포착] 대덕전자, 기관 8일 연속 순매수행진... 주가 +4.24%',
  '[개장시황] 삼성전기 5.05% 급등…코스피 차익매물에 하락 출발', 'Why Super Micro Computer Stock Popped Today', '수주 기대감에 장중 3%대 상승',
  '대덕전자, 장중 2.51% 하락…iM증권은 이익 전망 상향', '9개국 이상 거점 둔 한화에어로스페이스…주가 89만9000원으로 상승', '[특징주] SK텔레콤, 뚜렷한 공시 없이 장중 소폭 하락세 : 기업주식정보'];
await test('시세 안내 기사: 날짜·가격만 있는 자동 기사·"주가 상승 중"·"장중 3%대 상승"은 이유에서 제외 · 이유가 붙은 제목은 유지 · 봇과 화면 판정이 같음', async () => {
  for (const t of PRICE_ONLY_YES) assert.equal(src.priceOnly(t), true, t);
  for (const t of PRICE_ONLY_NO) assert.equal(src.priceOnly(t), false, t);
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ priceOnly, pickReasonNews })`, {});
  for (const t of [...PRICE_ONLY_YES, ...PRICE_ONLY_NO, '', '삼성전자 주가 하락 출발']) assert.equal(f.priceOnly(t), src.priceOnly(t), `화면·봇 같은 판정: ${t}`);
  const items = [{ title: PRICE_ONLY_YES[0] }, { title: '' }, { title: PRICE_ONLY_YES[4] }, { title: PRICE_ONLY_NO[0] }, { title: PRICE_ONLY_NO[1] }];
  const none = () => '';
  assert.equal(f.pickReasonNews(items, -2.5, '', none).title, PRICE_ONLY_NO[0], '시세 안내 기사를 건너뛴 가장 최근 기사(방향이 반대인 기사는 제외)');
  assert.equal(f.pickReasonNews([{ title: PRICE_ONLY_YES[1] }], -2.5, '', none), null);
  assert.equal(f.pickReasonNews(null, -2.5, '', none), null);
});
await test('급등락 기록: 이유로 쓸 뉴스는 시세 안내 기사를 건너뛴 가장 최근 기사', async () => {
  const root = workspace();
  const news = (m, u) => {
    const name = queryName(u), now = Date.now();
    const item = (t, ago) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/${ago}</link><pubDate>${new Date(now - ago).toUTCString()}</pubDate><source url="https://news.example.com">테스트일보</source></item>`;
    return text(`<?xml version="1.0"?><rss><channel>${item(`${name} 주가, 10월 15일 장중 70,000원 4.20% 상승`, 600e3)}${item(`${name} 주가 상승 중`, 900e3)}${item(`${name}, 대규모 수주 소식에 급등`, 3600e3)}</channel></rss>`);
  };
  await pipeline(root, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news });
  assert.equal(read(root, 'news.json')['005930'].items[0].title, '삼성전자 주가, 10월 15일 장중 70,000원 4.20% 상승', '뉴스 목록엔 그대로(최신순)');
  assert.deepEqual(read(root, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '삼성전자, 대규모 수주 소식에 급등', s: 'news' });
  // 예전 기록에 시세 안내 기사가 이유로 남아 있고 지금도 그런 기사뿐이면 그 이유를 지키지 않고 비운다
  const r2 = workspace();
  writeData(r2, 'moves.json', { '005930': [{ d: '20261015', p: 4, r: '삼성전자 주가, 10월 15일 장중 70,000원 4.00% 상승', s: 'news' }] });
  const onlyPrice = (m, u) => { const name = queryName(u); return text(`<?xml version="1.0"?><rss><channel><item><title>${name} 주가 상승 중 - 테스트일보</title><link>https://news.example.com/p</link><pubDate>${new Date(Date.now() - 600e3).toUTCString()}</pubDate><source url="https://news.example.com">테스트일보</source></item></channel></rss>`); };
  await pipeline(r2, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news: onlyPrice });
  assert.deepEqual(read(r2, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '', s: '' });
});
await test('이유 고르기: 상품 상장 공지·방향이 반대인 기사 제외 · 그날 같은 방향 [특징주] 먼저 · 나열 기사는 뒤로 · 같은 등급은 최신순 · 봇과 화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ pickReasonNews })`, {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const at = (h) => T(`2026-10-22T${String(h).padStart(2, '0')}:00:00+09:00`), yday = T('2026-10-21T15:00:00+09:00');
  const items = [
    { title: '“삼성전자·SK하이닉스 등락에 투자”…한국투자증권, ELW 224종 상장', pubMs: at(14) },
    { title: '[오늘의 특징주] 엠에스바이오 136% 폭등...SKAI·에이전트AI 상한가, 비나텍·삼성E&A도 급등', pubMs: at(13) },
    { title: '코스피 20% 빠질 때 15% 급등… ESS 동력 삼아 날아오른 LG엔솔', pubMs: at(12) },
    { title: '[특징주] 삼성E&A, 어닝 서프라이즈에 6900억 자사주 소각 얹자 14%↑', pubMs: at(11) },
    { title: 'LG엔솔 악몽이… 개미 울린 ‘중복상장’ 잔혹사', pubMs: at(10) },
    { title: '[특징주] 어제 오른 이유…자사주 소각에 급등', pubMs: yday },
  ];
  const pick = (list, pct, names = []) => {
    const a = src.pickReasonNews(list, pct, '20261022', kst, names), b = f.pickReasonNews(list, pct, '20261022', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택');
    return a ? a.title : null;
  };
  assert.equal(pick(items, 16.1), items[3].title, '오른 날: 그날 같은 방향 [특징주]');
  assert.equal(pick(items.filter((x, i) => i !== 3), 16.1), items[2].title, '[특징주]가 없으면 방향이 어긋나지 않는 가장 최근 기사(상장 공지·나열 기사 제외)');
  assert.equal(pick(items, -3.65), items[4].title, "내린 날: '급등' 기사·오른 [특징주]는 빼고 나열 기사는 뒤로");
  assert.equal(pick([items[2], items[3]], -3.65), null, '방향이 반대인 기사뿐이면 이유 없음');
  assert.equal(pick([items[1], items[0]], 2.5), items[1].title, '나열 기사밖에 없으면 그것이라도');
  assert.equal(pick([{ title: '[오늘의 증권가 콜] LS ELECTRIC, 유니드, 삼성바이오, LIG디펜스, 테스, 한화솔루션 등', pubMs: at(9) }, items[5]], 2.5), items[5].title, '쉼표로 여러 종목 나열 + 등 = 나열 기사');
  assert.equal(pick([items[0], { title: 'SK하이닉스 주가 하락 중' }], -3), null, '상장 공지·시세 안내뿐이면 없음');
  assert.equal(pick(items, 0), items[2].title, '보합이면 방향 판단 없이 최신순(상장 공지·나열 기사 제외)');
  // 한 제목에 두 종목 — 그 종목 이름 바로 뒤의 말로 방향을 본다
  const mixed = [{ title: "[특징주] 삼성전자 '상승' SK하이닉스 1%대 '하락'.. 차익실현 매물 출회", pubMs: at(14) }, { title: '삼성전자, HBM 공급 협상 지연 우려', pubMs: at(12) }];
  assert.equal(pick(mixed, -2.9, ['삼성전자']), mixed[1].title, "삼성전자는 이름 뒤 '상승' — 오늘 하락과 반대라 제외");
  assert.equal(pick(mixed, -3.25, ['SK하이닉스']), mixed[0].title, "SK하이닉스는 이름 뒤 '하락' — 같은 방향 [특징주]");
  assert.equal(pick([{ title: '[특징주] 반도체 대형주 약세 전환…삼성전자, 외국인 매도 확대', pubMs: at(13) }, mixed[1]], -2.9, ['삼성전자']),
    '[특징주] 반도체 대형주 약세 전환…삼성전자, 외국인 매도 확대', '이름 바로 뒤에 방향 말이 없으면 제목 전체(약세)로');
});
await test('시장 대비(app.js): 국내 코스피·코스닥 · 미국 나스닥 상장은 나스닥 · 그 밖은 S&P 500 · 시장 따라(같은 방향·1%p 안쪽·지수 1% 이상) · 모르면 비교 안 함', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ vsMarket })`, {});
  const idx = [{ symbol: '^KS11', changePct: -1.97 }, { symbol: '^KQ11', changePct: -1.85 }, { symbol: '^GSPC', changePct: 0.58 }, { symbol: '^IXIC', changePct: 1.05 }];
  const v = (q) => { const r = f.vsMarket({ ok: true, ...q }, idx); return r ? JSON.parse(JSON.stringify(r)) : null; };
  assert.deepEqual(v({ market: 'KR', exch: 'KOSPI', changePct: -2.5 }), { sym: '^KS11', name: '코스피', pct: -1.97, diff: -0.53, follows: true });
  assert.deepEqual(v({ market: 'KR', exch: 'KOSDAQ', changePct: 3 }), { sym: '^KQ11', name: '코스닥', pct: -1.85, diff: 4.85, follows: false });
  assert.deepEqual(v({ market: 'US', exch: 'NASDAQ', changePct: 2.54 }), { sym: '^IXIC', name: '나스닥', pct: 1.05, diff: 1.49, follows: false }, '1%p 넘게 차이');
  assert.equal(v({ market: 'US', exch: 'NYSE', changePct: 0.9 }).follows, false, '지수가 1% 안 움직인 날은 시장 따라 아님');
  assert.equal(v({ market: 'US', exch: 'NYSE', changePct: 0.9 }).name, 'S&P 500');
  assert.equal(v({ market: 'US', exch: 'NASDAQ ETF', changePct: 1 }).name, '나스닥');
  assert.equal(v({ market: 'KR', exch: 'KOSPI', changePct: 2.5 }).follows, false, '반대 방향');
  assert.equal(v({ market: 'KR', changePct: -2.5 }), null, '상장 시장을 모르면 비교 안 함');
  assert.equal(f.vsMarket({ ok: false, market: 'KR', exch: 'KOSPI', changePct: -2 }, idx), null);
  assert.equal(f.vsMarket({ ok: true, market: 'KR', exch: 'KOSPI', changePct: -2 }, [{ symbol: '^KQ11', changePct: -1 }]), null, '그 지수가 없으면 비교 안 함');
});
await test('상장 시장(quotes.json exch): 검색 목록의 국내 KOSPI·KOSDAQ · 미국 거래소 · 목록에 없으면 없음 · 시세 안내 기사는 "시세" 표시·호재/악재 집계 제외', async () => {
  const root = workspace();
  writeData(root, 'stocklist.json', { v: 2, kr: [['005930', '삼성전자', 'KOSPI', 1]], us: [['AAPL', '애플', 'Apple Inc.', 'NASDAQ', 1]], meta: {} });
  const news = (m, u) => {
    const name = queryName(u), now = Date.now();
    const item = (t, ago) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/${ago}</link><pubDate>${new Date(now - ago).toUTCString()}</pubDate><source url="https://news.example.com">테스트일보</source></item>`;
    return text(`<?xml version="1.0"?><rss><channel>${item(`${name} 주가 상승 중`, 600e3)}${item(`${name}, 대규모 수주 소식`, 900e3)}</channel></rss>`);
  };
  await pipeline(root, { news });
  const q = Object.fromEntries(read(root, 'quotes.json').quotes.map((x) => [x.code, x]));
  assert.deepEqual([q['005930'].exch, q.AAPL.exch, q['000660'].exch], ['KOSPI', 'NASDAQ', undefined]);
  const n = read(root, 'news.json')['005930'];
  assert.deepEqual([n.items[0].sentiment.label, n.items[0].sentiment.tone], ['시세', 'neutral'], "'상승'이 들어 있어도 시세 안내 기사는 호재가 아님");
  assert.equal(n.items[1].sentiment.label, '호재');
  assert.deepEqual([n.summary.pos, n.summary.neg, n.summary.label], [1, 0, '호재 우세']);
});
await test('공시 도구: ZIP(압축·무압축·데이터 설명자) 속 XML · 상장사만 표로 · 우선주는 보통주 회사 · 종류 판정 · 한국 날짜', () => {
  const xml = corpXml();
  for (const opt of [{}, { method: 0 }, { descriptor: true }]) {
    assert.equal(dartm.unzipXml(makeZip([['안내.txt', '설명'], ['CORPCODE.xml', xml]], opt)), xml, JSON.stringify(opt));
  }
  assert.throws(() => dartm.unzipXml(Buffer.from('<result><status>010</status></result>')), /ZIP 형식이 아님/);
  assert.throws(() => dartm.unzipXml(makeZip([['a.txt', 'x']])), /XML 없음/);
  const map = dartm.parseCorpXml(xml);
  assert.equal(Object.keys(map).length, 1102, '비상장사(종목코드 빈칸) 제외');
  assert.equal(map['005930'], '00126380');
  assert.equal(dartm.corpOf(map, '005935'), '00126380', '우선주 → 보통주 회사');
  assert.equal(dartm.corpOf(map, '005936'), null);
  assert.equal(dartm.corpOf(map, 'AAPL'), null);
  const titles = ['단일판매ㆍ공급계약체결', '연결재무제표기준영업(잠정)실적(공정공시)', '유상증자결정', '자기주식취득결정', '현금ㆍ현물배당결정',
    '회사합병결정', '횡령ㆍ배임혐의발생', '조회공시요구(현저한시세변동)에대한답변', '반기보고서 (2026.06)', '임원ㆍ주요주주특정증권등소유상황보고서',
    '기업설명회(IR)개최(안내공시)', '투자판단관련주요경영사항', '주주총회소집공고',
    '결산실적공시예고(안내공시)', '전환청구권행사', '불성실공시법인지정예고']; // 아래 3건은 배포 후 실제 공시 제목에서 발견
  assert.deepEqual(titles.map(dartm.tagOf), ['계약', '실적', '증자·사채', '자사주', '배당', 'M&A', '위험', '해명', '정기보고', '지분', 'IR', '주요사항', '기타',
    '예고', '증자·사채', '위험']);
  assert.equal(dartm.kstYmd(T('2026-10-15T15:30:00Z')), '20261016', '한국은 이미 다음 날 00:30');
});
await test('공시(OpenDART): 키 있을 때만 · 국내 종목만(ETF 제외·우선주는 보통주 회사) · 2주 · 철회 제외 · 최신 5건 · 종류 · 키는 파일·로그에 없음', async () => {
  const off = workspace();
  await pipeline(off);
  assert.equal(callsTo(/opendart/), 0, '키 없음 → 요청 0건');
  assert.ok(!fs.existsSync(file(off, 'disclosures.json')) && !('dart' in read(off, 'status.json')), '키 없음 → 파일·상태 그대로');
  await withDartKey(async () => {
    const items5 = [...ITEMS, { code: '069500', market: 'KR', name: 'KODEX 200' }, { code: '005935', market: 'KR', name: '삼성전자우' }];
    const root = workspace(items5);
    const { lines } = await pipeline(root);
    assert.equal(callsTo(/corpCode\.xml/), 1);
    const lists = NET.calls.filter((u) => /list\.json/.test(u)).map((u) => new URL(u));
    assert.deepEqual(lists.map((u) => u.searchParams.get('corp_code')).sort(), ['00126380', '00126380', '00164779'], 'ETF·미국 종목은 요청 안 함');
    assert.deepEqual(['bgn_de', 'end_de', 'last_reprt_at'].map((k) => lists[0].searchParams.get(k)), ['20261001', '20261015', 'Y']);
    const d = read(root, 'disclosures.json');
    assert.deepEqual(Object.keys(d).sort(), ['000660', '005930', '005935']);
    assert.deepEqual(d['005930'].items, [
      { title: '단일판매ㆍ공급계약체결', date: '20261015', no: '20261015000321', tag: '계약', key: true },
      { title: '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)', date: '20261015', no: '20261015000100', tag: '실적', key: true },
      { title: '임원ㆍ주요주주특정증권등소유상황보고서', date: '20261014', no: '20261014000500', tag: '지분' },
      { title: '현금ㆍ현물배당결정', date: '20261013', no: '20261013000200', tag: '배당', key: true },
      { title: '기업설명회(IR)개최(안내공시)', date: '20261010', no: '20261010000050', tag: 'IR' },
    ]);
    assert.deepEqual(d['005935'], d['005930']);
    assert.deepEqual(d['000660'].items.map((x) => x.tag), ['지분']);
    const corp = read(root, 'dartcorp.json');
    assert.equal(corp.map['005930'], '00126380');
    assert.deepEqual([corp.at, corp.tried, corp.none], [NOW_KR, NOW_KR, ['069500']]);
    assert.equal(read(root, 'status.json').dart, 'ok');
    for (const f of fs.readdirSync(path.join(root, 'docs', 'data'))) assert.ok(!raw(root, f).includes(DART_KEY), `${f}에 키 없음`);
    assert.ok(!lines.join('\n').includes(DART_KEY), '로그에 키 없음');
    await pipeline(root, {}, NOW_KR + 5 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 0, '표가 새것 → 다시 받지 않음');
    await pipeline(root, {}, NOW_KR + 7 * 60 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 0, 'ETF는 없음 목록에 기억 → 6시간이 지나도 다시 받지 않음');
    fs.writeFileSync(path.join(root, 'config', 'watchlist.json'), JSON.stringify({ items: [...items5, { code: '123456', market: 'KR', name: '새 종목' }] }));
    await pipeline(root, {}, NOW_KR + 7 * 60 * MIN + 5 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 1, '표에 없는 새 종목 → 다시 받음');
    assert.deepEqual(read(root, 'dartcorp.json').none, ['069500', '123456']);
    await pipeline(root, {}, NOW_KR + 8 * 1440 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 1, '7일 지나면 다시 받음');
  });
});
await test('공시 오류: 키 오류면 이유 기록·30분 뒤 재시도 · 한도 초과면 그 회차 중단 · 공시 없음·일시 오류는 종목별로', async () => {
  await withDartKey(async () => {
    const root = workspace();
    const keyErr = () => text('<?xml version="1.0" encoding="UTF-8"?>\n<result><status>010</status><message>등록되지 않은 키입니다.</message></result>');
    await pipeline(root, { corpZip: keyErr });
    assert.equal(callsTo(/list\.json/), 0, '고유번호 표가 없으면 목록 요청 안 함');
    assert.equal(read(root, 'status.json').dart, '등록되지 않은 인증키(010)');
    assert.deepEqual([read(root, 'dartcorp.json').at, read(root, 'dartcorp.json').tried], [null, NOW_KR]);
    await pipeline(root, { corpZip: keyErr }, NOW_KR + 20 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 0, '30분 안에는 다시 받지 않음');
    await pipeline(root, {}, NOW_KR + 31 * MIN); // 키를 고친 뒤
    assert.equal(callsTo(/corpCode\.xml/), 1);
    assert.equal(read(root, 'status.json').dart, 'ok');
    const before = read(root, 'disclosures.json');
    assert.equal(before['005930'].items.length, 5);
    await pipeline(root, { dartList: () => json({ status: '020', message: '요청 제한을 초과하였습니다.' }) }, NOW_KR + 45 * MIN);
    assert.equal(callsTo(/list\.json/), 1, '첫 요청에서 멈춤');
    assert.deepEqual(read(root, 'disclosures.json'), before, '직전 값 유지');
    assert.equal(read(root, 'status.json').dart, '하루 요청 한도 초과(020)');
    const mixed = (corp) => (corp === '00126380' ? text('error', 500) : json({ status: '013', message: '조회된 데이타가 없습니다.' }));
    await pipeline(root, { dartList: mixed }, NOW_KR + 60 * MIN);
    const d = read(root, 'disclosures.json');
    assert.deepEqual(d['005930'], before['005930'], '일시 오류 → 그 종목만 직전 값');
    assert.deepEqual(d['000660'], { ok: true, items: [] }, '기간 안에 공시 없음');
    assert.equal(read(root, 'status.json').dart, 'ok', '일시 오류는 중단 사유가 아님');
    const bad = workspace();
    await pipeline(bad, { corpZip: () => new Response(makeZip([['CORPCODE.xml', corpXml().slice(0, 3000)]])) });
    assert.match(read(bad, 'status.json').dart, /고유번호 목록 받기 실패 — 고유번호 목록이 너무 적음/, '잘린 목록은 쓰지 않음');
    assert.deepEqual(read(bad, 'dartcorp.json').map, {});
  });
});
await test('공시 → AI 분석: 국내 급등락 종목 요청에 최근 공시(오늘 표시) · 새 공시면 다시 분석 · 키 없으면 예전 그대로', async () => {
  const stockBodies = () => NET.bodies.filter((b, i) => isGemini(NET.calls[i]) && b.includes("'삼성전자'"));
  const plain = workspace();
  await pipeline(plain);
  assert.ok(stockBodies().length === 1 && !stockBodies()[0].includes('최근 공시'), '키 없음 → 공시 줄 없음');
  assert.ok(!read(plain, 'analysis.json')['005930'].sig.includes('|d:'), '시그니처도 예전 형식');
  await withDartKey(async () => {
    const root = workspace();
    await pipeline(root);
    const body = stockBodies()[0];
    assert.ok(body.includes('최근 공시(전자공시 2주, 최신순)') && body.includes('- 오늘 [계약] 단일판매ㆍ공급계약체결')
      && body.includes('- 10/13 [배당] 현금ㆍ현물배당결정') && body.includes('뉴스+공시+수급+추세'), body.slice(0, 800));
    assert.ok(read(root, 'analysis.json')['005930'].sig.endsWith('|d:20261015000321,20261015000100,20261014000500'));
    await pipeline(root, {}, NOW_KR + 5 * MIN);
    assert.equal(stockBodies().length, 0, '같은 공시 → 재사용');
    const rows = { ...DART_ROWS, '00126380': [['20261015000999', '투자판단관련주요경영사항'], ...DART_ROWS['00126380']] };
    await pipeline(root, { dartRows: rows }, NOW_KR + 10 * MIN);
    assert.equal(stockBodies().length, 1, '새 공시 → 다시 분석');
  });
});
await test('다음 분석 가능 시각: 리셋 직후·모델 수·몫 소진·지금 가능·주말·쓸 모델 없음', () => {
  const mk = (ms, used = {}) => ({ ...bud.startBudget(null, ms), used });
  assert.equal(bud.nextAllowanceAt(mk(NOW_EVE), ['a', 'b'], NOW_EVE), T('2026-10-14T14:12:00Z'), '미국장 시작 42분 뒤(23:12 KST)');
  assert.equal(bud.nextAllowanceAt(mk(NOW_EVE), ['a', 'b', 'c'], NOW_EVE), T('2026-10-14T13:58:00Z'), '모델 3개면 더 빨리(22:58 KST)');
  assert.equal(bud.nextAllowanceAt(mk(NOW_KR, { a: 12, b: 10 }), ['a', 'b'], NOW_KR), T('2026-10-15T03:07:00Z'), '몫을 다 썼으면 7분 뒤');
  assert.equal(bud.nextAllowanceAt(mk(NOW_KR), ['a', 'b'], NOW_KR), NOW_KR, '지금 쓸 수 있으면 지금');
  assert.equal(bud.nextAllowanceAt(mk(NOW_KR, { a: 20, b: 19 }), ['a', 'b'], NOW_KR), T('2026-10-15T06:00:00Z'), '거의 다 썼으면 리셋 1시간 전(15:00 KST)');
  assert.equal(bud.nextAllowanceAt(mk(T('2026-10-18T03:00:00Z')), ['a', 'b'], T('2026-10-18T03:00:00Z')), T('2026-10-18T06:00:00Z'), '일요일 — 리셋 1시간 전(15:00 KST)');
  assert.equal(bud.nextAllowanceAt({ ...mk(NOW_KR), out: { a: 'quota', b: 'quota' } }, ['a', 'b'], NOW_KR), null);
});

// ===== 종목 검색 목록(stocklist) =====
// 국내: 네이버 시가총액 목록(KOSPI 150개 = 2쪽, KOSDAQ 30개, 형식이 다른 코드 1개 섞음) / KIND(EUC-KR 표)
// 시가총액(억원, 쉼표 문자열): KOSPI i번째 (150−i)×1000, 맨 앞 005930은 9,000,000 / KOSDAQ i번째 (30−i)×3000+500
//  → 합친 시가총액 순위: 005930 1위, KOSDAQ 첫 종목(90,500)은 KOSPI 1~59번째(149,000~91,000) 다음인 61위
// caps: 'normal' | 'none'(시가총액 값 없음) | 'flip'(KOSDAQ이 모두 더 큼 — 순위만 바뀐 상황)
const krCap = (market, i, caps) => {
  if (caps === 'none') return undefined;
  if (market === 'KOSPI') return i === 0 ? 9000000 : (150 - i) * 1000;
  return caps === 'flip' ? 20000000 - i : (30 - i) * 3000 + 500;
};
const krPage = (market, page, caps = 'normal') => {
  const total = market === 'KOSPI' ? 150 : 30;
  const from = (page - 1) * 100, to = Math.min(total, page * 100);
  const stocks = [];
  for (let i = from; i < to; i++) {
    const cap = krCap(market, i, caps);
    stocks.push({ itemCode: i === 0 && market === 'KOSPI' ? '005930' : String((market === 'KOSPI' ? 100000 : 200000) + i),
      stockName: i === 0 && market === 'KOSPI' ? '삼성전자' : `${market}종목${i}`, stockEndType: 'stock',
      ...(cap === undefined ? {} : { marketValue: cap.toLocaleString('en-US') }) });
  }
  if (market === 'KOSDAQ' && page === 1) stocks.push({ itemCode: '0000J0', stockName: '새형식코드', stockEndType: 'stock', marketValue: '1' });
  return { stocks, totalCount: total };
};
const EUCKR_SAMSUNG = [0xBB, 0xEF, 0xBC, 0xBA, 0xC0, 0xFC, 0xC0, 0xDA]; // '삼성전자'
function kindBytes(market) {
  const enc = (s) => [...Buffer.from(s, 'latin1')];
  const rows = [enc('<tr><td>'), EUCKR_SAMSUNG, enc('</td><td>KOSPI</td><td>005930</td><td>x</td></tr>')].flat();
  const more = Array.from({ length: 12 }, (_, i) => enc(`<tr><td>KIND ${market} Corp ${i}</td><td>${market}</td><td>${String((market === 'KOSPI' ? 300000 : 400000) + i)}</td></tr>`)).flat();
  const head = enc('<html><head><meta http-equiv="Content-Type" content="text/html; charset=EUC-KR"></head><table><tr><th>name</th><th>code</th></tr>');
  return Uint8Array.from([...head, ...(market === 'KOSPI' ? rows : []), ...more, ...enc('</table></html>')]);
}
const NASDAQ_TXT = [
  'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
  'NVDA|NVIDIA Corporation - Common Stock|Q|N|N|100|N|N',
  'AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N',
  'GOOGL|Alphabet Inc. - Class A Common Stock|Q|N|N|100|N|N',
  'QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N',
  'PLUG|Plug Power, Inc. - Common Stock|Q|N|N|100|N|N',
  'ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N',
  'ABCDW|ABC Acquisition Corp - Warrants|S|N|N|100|N|N',
  'ABCDU|ABC Acquisition Corp - Units|S|N|N|100|N|N',
  'File Creation Time: 1015202608:00|||||||',
].join('\r\n');
const OTHER_TXT = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'BRK.B|Berkshire Hathaway Inc. Class B Common Stock|N|BRK.B|N|100|N|BRK.B',
  'KO|Coca-Cola Company (The) Common Stock|N|KO|N|100|N|KO',
  'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
  'BAC$K|Bank of America Corporation 6.45% Preferred Stock|N|BACpK|N|100|N|BAC-K',
  'XYZP|XYZ Corp 5% Series A Preferred Stock|N|XYZP|N|100|N|XYZP',
  'File Creation Time: 1015202608:00|||||||',
].join('\n');
// 네이버 해외 목록(시가총액 순) — 합친 순위: NVDA 1 · AAPL 2 · BRK-B 3 · KO 4 · PLUG 5 (GOOGL·QQQ·SPY는 목록 밖 → 순위 없음)
const US_KO = { NASDAQ: [{ symbolCode: 'NVDA', stockName: '엔비디아', stockNameEng: 'NVIDIA Corp', marketValue: '4,500' }, { symbolCode: 'AAPL', stockName: '애플', marketValue: '3,500' },
  { symbolCode: 'PLUG', stockName: '플러그 파워', marketValue: '5' }],
  NYSE: [{ symbolCode: 'BRK.B', stockName: '버크셔 해서웨이 B', marketValue: '1,000' }, { symbolCode: 'KO', stockName: 'Coca-Cola', marketValue: '300' }] };
function listRoutes({ naverKr = true, kind = true, nasdaq = true, usKo = true, caps = 'normal' } = {}) {
  const fail = () => text('blocked', 403);
  return [
    { re: /m\.stock\.naver\.com\/api\/stocks\/marketValue\/(KOSPI|KOSDAQ)\?page=(\d+)/, fn: (m) => (naverKr ? json(krPage(m[1], +m[2], caps)) : fail()) },
    { re: /kind\.krx\.co\.kr\/corpgeneral\/corpList\.do\?.*marketType=(stockMkt|kosdaqMkt)/, fn: (m) => (kind ? new Response(kindBytes(m[1] === 'stockMkt' ? 'KOSPI' : 'KOSDAQ'), { headers: { 'content-type': 'text/html; charset=euc-kr' } }) : fail()) },
    { re: /nasdaqtrader\.com\/dynamic\/SymDir\/(nasdaqlisted|otherlisted)\.txt/, fn: (m) => (nasdaq ? text(m[1] === 'nasdaqlisted' ? NASDAQ_TXT : OTHER_TXT) : fail()) },
    { re: /api\.stock\.naver\.com\/stock\/exchange\/(NASDAQ|NYSE|AMEX)\/marketValue\?page=(\d+)/, fn: (m) => (usKo && US_KO[m[1]] && m[2] === '1' ? json({ stocks: US_KO[m[1]] }) : text('not found', 404)) },
  ];
}
async function buildList(root, opts, buildOpts = {}) {
  NET.routes = listRoutes(opts); NET.calls = []; NET.bodies = []; NET.blocked = [];
  return quiet(() => stocklist.build({ root, now: NOW_KR, minKr: 10, minUs: 3, ...buildOpts }));
}
const listOf = (root) => read(root, 'stocklist.json');
const usRow = (l, sym) => l.us.find((r) => r[0] === sym);

await test('검색 목록: 네이버 국내(쪽 넘김·새 형식 코드 제외) + 미국 디렉터리(시험·워런트·유닛·우선주 제외) + 한글명', async () => {
  const root = workspace();
  const { value } = await buildList(root);
  assert.equal(value.written, true);
  const l = listOf(root);
  assert.equal(l.kr.length, 180, 'KOSPI 150 + KOSDAQ 30');
  assert.deepEqual(l.kr.find((r) => r[0] === '005930'), ['005930', '삼성전자', 'KOSPI', 1], '시가총액 1위');
  assert.ok(!l.kr.some((r) => r[0] === '0000J0'), '6자리 숫자가 아닌 코드는 제외(파이프라인이 처리 못함)');
  const krRank = (code) => l.kr.find((r) => r[0] === code)[3];
  assert.deepEqual([krRank('200000'), krRank('100060')], [61, 62], '두 시장을 합쳐 시가총액 순(코스닥 1위 90,500 > 코스피 90,000)');
  assert.deepEqual(l.kr.map((r) => r[3]).sort((a, b) => a - b), Array.from({ length: 180 }, (_, i) => i + 1), '순위는 1~180 빠짐없이');
  assert.deepEqual(l.us.map((r) => r[0]).sort(), ['AAPL', 'BRK-B', 'GOOGL', 'KO', 'NVDA', 'PLUG', 'QQQ', 'SPY']);
  assert.deepEqual(usRow(l, 'NVDA'), ['NVDA', '엔비디아', 'NVIDIA Corporation', 'NASDAQ', 1], '한글명은 네이버 우선 · 시가총액 1위');
  assert.deepEqual(usRow(l, 'PLUG'), ['PLUG', '플러그 파워', 'Plug Power, Inc.', 'NASDAQ', 5], '네이버 이름이 별칭보다 우선');
  assert.deepEqual(usRow(l, 'GOOGL'), ['GOOGL', '알파벳 A(구글)', 'Alphabet Inc. Class A', 'NASDAQ'], '네이버에 없으면 기본 별칭 · 순위 없음');
  assert.deepEqual(usRow(l, 'BRK-B'), ['BRK-B', '버크셔 해서웨이 B', 'Berkshire Hathaway Inc. Class B', 'NYSE', 3], 'BRK.B → 야후 표기 BRK-B · 거래소 합쳐 순위');
  assert.deepEqual(usRow(l, 'KO'), ['KO', '코카콜라', 'Coca-Cola Company (The)', 'NYSE', 4], '한글이 아닌 이름은 별칭으로');
  assert.equal(usRow(l, 'SPY')[3], 'NYSE Arca ETF');
  assert.equal(usRow(l, 'QQQ')[3], 'NASDAQ ETF');
  assert.deepEqual([l.meta.src.KOSPI, l.meta.src.KOSDAQ, l.meta.src.US, l.meta.src.krCap, l.meta.src.usCap], ['naver-KOSPI:150', 'naver-KOSDAQ:30', 'nasdaqtrader:8', 180, 5]);
  assert.equal(l.v, 2);
  assert.equal(NET.blocked.length, 0, `차단된 호출: ${NET.blocked.join(', ')}`);
});
await test('검색 목록: 네이버 국내가 막히면 KRX KIND(EUC-KR) 목록으로 · 한글명 소스가 막혀도 별칭으로', async () => {
  const root = workspace();
  await buildList(root, { naverKr: false, usKo: false });
  const l = listOf(root);
  assert.deepEqual(l.kr.find((r) => r[0] === '005930'), ['005930', '삼성전자', 'KOSPI'], 'EUC-KR 한글 해독');
  assert.equal(l.kr.length, 25, 'KOSPI 13 + KOSDAQ 12');
  assert.equal(l.meta.src.KOSPI, 'kind-KOSPI:13');
  assert.ok(l.kr.every((r) => r.length === 3), 'KIND엔 시가총액이 없어 순위 없음');
  assert.deepEqual(usRow(l, 'NVDA'), ['NVDA', '엔비디아', 'NVIDIA Corporation', 'NASDAQ'], '별칭 · 순위 없음');
  assert.equal(usRow(l, 'SPY')[1], 'SPDR S&P500 ETF');
});
await test('검색 목록: 너무 적거나 실패한 시장은 기존 목록 유지 · 전부 실패면 파일 그대로 · 내용이 같으면 다시 안 씀', async () => {
  const root = workspace();
  await buildList(root);
  const first = raw(root, 'stocklist.json');
  const again = await buildList(root, {}, { now: NOW_KR + 86400e3 });
  assert.equal(again.value.written, false, '날짜만 바뀐 재생성은 쓰지 않음');
  assert.equal(raw(root, 'stocklist.json'), first);
  const allFail = await buildList(root, { naverKr: false, kind: false, nasdaq: false, usKo: false });
  assert.equal(allFail.value.written, true, '소스 상태(실패)는 기록');
  const l = listOf(root);
  assert.equal(l.kr.length, 180, '국내 기존 목록 유지');
  assert.equal(l.us.length, 8, '미국 기존 목록 유지');
  assert.equal(l.kr.find((r) => r[0] === '005930')[3], 1, '유지한 목록의 순위도 그대로');
  assert.equal(l.meta.src.krKept, true);
  const empty = workspace();
  const none = await buildList(empty, { naverKr: false, kind: false, nasdaq: false });
  assert.equal(none.value.written, false);
  assert.equal(fs.existsSync(file(empty, 'stocklist.json')), false, '만들 게 없으면 파일을 만들지 않음');
  const few = await buildList(workspace(), {}, { minKr: 500 });
  assert.equal(few.value.kr, 0, '기준(500)보다 적으면 국내는 기존(없음) 유지');
});

await test('검색 순위: 시가총액 값이 없으면 목록 순서 · 순위만 바뀐 건 7일마다 반영 · 한글명 유지 · 옛 형식은 바로 갱신', async () => {
  const rk = (l, code) => l.kr.find((r) => r[0] === code)[3];
  const none = workspace();
  await buildList(none, { caps: 'none' });
  const ln = listOf(none);
  assert.deepEqual([rk(ln, '005930'), rk(ln, '200000'), rk(ln, '100001'), rk(ln, '200001')], [1, 2, 3, 4], '값이 없으면 시장별 목록 순서를 번갈아(같은 순번은 코스피 먼저)');
  assert.equal(ln.meta.src.krCap, 0);

  const root = workspace();
  await buildList(root);
  assert.equal(rk(listOf(root), '200000'), 61);
  const flip1 = await buildList(root, { caps: 'flip' }, { now: NOW_KR + 86400e3 });
  assert.equal(flip1.value.written, false, '종목·이름이 같고 순위만 바뀌면 7일 안에는 다시 쓰지 않음');
  const flip8 = await buildList(root, { caps: 'flip' }, { now: NOW_KR + 8 * 86400e3 });
  assert.equal(flip8.value.written, true, '7일이 지나면 순위 갱신');
  assert.equal(rk(listOf(root), '200000'), 1, '코스닥이 모두 커진 순위 반영');
  // 네이버 해외 목록이 막혀도 전에 받은 한글명은 그대로(별칭으로 바뀌지 않음) — 순위만 빠짐
  const noKo = await buildList(root, { caps: 'flip', usKo: false }, { now: NOW_KR + 9 * 86400e3 });
  assert.equal(noKo.value.written, false, '이름이 그대로라 바뀐 것 없음');
  const noKo2 = await buildList(root, { caps: 'flip', usKo: false }, { now: NOW_KR + 16 * 86400e3 });
  assert.equal(noKo2.value.written, true);
  assert.deepEqual(usRow(listOf(root), 'PLUG'), ['PLUG', '플러그 파워', 'Plug Power, Inc.', 'NASDAQ'], '네이버 한글명 유지 · 순위 없음');

  // 옛 형식(v1, 순위 없음) 파일은 내용이 같아도 바로 새 형식으로
  const old = workspace();
  await buildList(old);
  const v1 = listOf(old);
  writeData(old, 'stocklist.json', { v: 1, kr: v1.kr.map((r) => r.slice(0, 3)), us: v1.us.map((r) => r.slice(0, 4)), meta: v1.meta });
  const up = await buildList(old, {}, { now: NOW_KR + 3600e3 });
  assert.equal(up.value.written, true);
  assert.deepEqual([listOf(old).v, rk(listOf(old), '005930')], [2, 1]);
});

// ===== 종목 편집 요청 반영(watchlist-apply) =====
const issueBody = (req) => `대시보드에서 보낸 변경 요청입니다.\n\n\`\`\`json\n${typeof req === 'string' ? req : JSON.stringify(req)}\n\`\`\`\n`;
function applyIn(root, body) {
  const out = path.join(root, 'gh-output.txt'), res = path.join(root, 'result.md');
  const log = console.log;
  console.log = () => {}; // 결과 요약 출력은 감춘다(파일로 확인)
  let r;
  try { r = wl.run({ root, body, outputFile: out, resultFile: res }); } finally { console.log = log; }
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'watchlist.json'), 'utf8')); } catch {}
  return { ...r, output: fs.readFileSync(out, 'utf8'), result: fs.readFileSync(res, 'utf8'), cfg };
}
const cfgRaw = (root) => fs.readFileSync(path.join(root, 'config', 'watchlist.json'), 'utf8');

await test('종목 편집 반영: 추가·삭제 · 형식 오류·중복 건너뜀 · 없는 종목 삭제 알림 · 한 줄에 한 종목 형식', async () => {
  const root = workspace();
  const r = applyIn(root, issueBody({
    add: [{ code: 'NVDA', market: 'US', name: '엔비디아' }, { code: 'ABC123', market: 'KR', name: '오타' }, { code: '005930', market: 'KR', name: '삼성전자' }],
    remove: ['000660', 'ZZZZ'],
  }));
  assert.equal(r.changed, true);
  assert.equal(r.output, 'changed=true\n');
  assert.deepEqual(r.cfg.items.map((x) => x.code), ['005930', 'AAPL', 'NVDA']);
  assert.ok(r.result.includes('추가: 엔비디아(NVDA)'), r.result);
  assert.ok(r.result.includes('삭제: SK하이닉스(000660)'));
  assert.ok(r.result.includes('ABC123(코드 형식 오류)') && r.result.includes('005930(이미 있음)'));
  assert.ok(r.result.includes('목록에 없어 삭제하지 않음: ZZZZ'));
  assert.equal(cfgRaw(root).split('\n').filter((l) => l.includes('"code"')).length, 3, '한 줄에 한 종목');
  assert.ok(cfgRaw(root).includes('{ "code": "NVDA", "market": "US", "name": "엔비디아" }'));
  // 깃허브 웹 양식으로 만든 이슈는 줄바꿈이 CRLF — 같은 요청으로 읽혀야 한다
  const crlf = applyIn(workspace(), issueBody({ add: [{ code: 'NVDA', market: 'US', name: '엔비디아' }] }).replace(/\n/g, '\r\n'));
  assert.equal(crlf.changed, true);
  assert.ok(crlf.cfg.items.some((x) => x.code === 'NVDA'));
});
await test('종목 편집 반영: 최대 40개 · 소문자 티커·숫자 코드 보정 · 이름 속 @멘션·서식 순화', async () => {
  const items = Array.from({ length: 39 }, (_, i) => ({ code: String(100000 + i), market: 'KR', name: `종목${i}` }));
  const root = workspace(items);
  const r = applyIn(root, issueBody({ add: [{ code: 'msft', name: '@everyone `x`' }, { code: 'AAPL' }, { code: 'TSLA' }] }));
  assert.equal(r.cfg.items.length, 40);
  assert.equal(r.cfg.items[39].code, 'MSFT', '소문자 티커 대문자로');
  assert.ok(r.result.includes('AAPL(최대 40개)') && r.result.includes('TSLA(최대 40개)'));
  assert.ok(!r.result.includes('@everyone') && r.result.includes('＠everyone'), '멘션 알림 방지');
  const pad = applyIn(workspace(), issueBody({ add: [{ code: 5930 + 1, market: 'KR', name: '숫자코드' }] }));
  assert.ok(pad.cfg.items.some((x) => x.code === '005931'), '숫자로 온 국내 코드는 6자리로');
});
await test('종목 편집 반영: 잘못된 요청·읽을 수 없는 설정 파일이면 아무것도 바꾸지 않음', async () => {
  const bad = [
    '그냥 글만 있는 본문',
    issueBody('{ 깨진 json'),
    issueBody({ add: [], remove: [] }),
    issueBody([1, 2]),
    issueBody({ add: Array.from({ length: 61 }, (_, i) => ({ code: String(100000 + i) })) }),
    issueBody({ add: [{ code: 'NVDA' }] }) + 'x'.repeat(20001), // 요청은 멀쩡해도 본문이 너무 길면 거절
  ];
  for (const body of bad) {
    const root = workspace();
    const before = cfgRaw(root);
    const r = applyIn(root, body);
    assert.equal(r.changed, false);
    assert.equal(r.output, 'changed=false\n');
    assert.ok(r.result.startsWith('⚠️ 반영하지 못했습니다'), r.result);
    assert.equal(cfgRaw(root), before);
  }
  const root = workspace('{ 깨진 설정');
  const r = applyIn(root, issueBody({ add: [{ code: 'NVDA' }] }));
  assert.equal(r.changed, false);
  assert.ok(r.result.includes('읽지 못해 반영하지 않았습니다'));
  assert.equal(cfgRaw(root), '{ 깨진 설정', '깨진 파일을 덮어쓰지 않음');
  const same = applyIn(workspace(), issueBody({ add: [{ code: '005930' }] }));
  assert.equal(same.changed, false, '이미 있는 종목만 → 바뀐 것 없음');
  assert.ok(same.result.startsWith('ℹ️ 바뀐 내용이 없습니다'));
});

// ---------- 정리 · 결과 ----------
for (const d of workspaces) fs.rmSync(d, { recursive: true, force: true });
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     → ${r.err?.message}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n결과: ${results.length}개 중 ${results.length - failed}개 통과${failed ? ` · ${failed}개 실패` : ''}`);
process.exitCode = failed ? 1 : 0;
