// pages/scripts/selftest.mjs — 오프라인 자체 테스트 (외부 접속 없음)
// 실행: node scripts/selftest.mjs   (pages 폴더에서)
//
// · 네트워크는 가짜 fetch로 대체한다. 등록되지 않은 주소로 나가려 하면 차단하고 테스트를 실패시킨다.
// · 데이터는 OS 임시 폴더에만 쓰고 지운다 — 실제 docs/data, 외부 API, 저장소를 건드리지 않는다.
// · API 키 자리에는 가짜 값만 넣는다(가짜 fetch만 받으므로 어디에도 전송되지 않음).
// · AI 예산은 시각에 따라 달라지므로 파이프라인은 고정 시각(now)으로 돌린다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const naverStock = (code, pct) => ({ datas: [{
  stockName: `종목${code}`, closePrice: '70,000', compareToPreviousClosePrice: String(Math.round(Math.abs(70000 * pct / 100))),
  fluctuationsRatio: String(Math.abs(pct)), compareToPreviousPrice: { name: pct > 0 ? 'RISING' : pct < 0 ? 'FALLING' : 'EVEN' },
  openPrice: '69,000', highPrice: '71,000', lowPrice: '68,000', accumulatedTradingVolume: '1,234,567',
  marketStatus: 'OPEN', localTradedAt: new Date().toISOString(),
}] });
const naverIndex = (pct) => ({ datas: [{ closePriceRaw: '2,600.00', compareToPreviousClosePriceRaw: (2600 * pct / 100).toFixed(1), fluctuationsRatioRaw: pct.toFixed(2), marketStatus: 'OPEN' }] });
const trendStock = [{ bizdate: '20261015', foreignerPureBuyQuant: '-1,000', organPureBuyQuant: '500', individualPureBuyQuant: '500', foreignerHoldRatio: '50.00%' }];
const trendIndex = { bizdate: '20261015', personalValue: '+1,000', foreignValue: '-800', institutionalValue: '-200' };
// tag를 바꾸면 헤드라인이 달라진다(= 분석 입력이 바뀐 상황)
function rss(tag = '') {
  const pub = new Date(Date.now() - 3600e3).toUTCString(); // 최근 2일 필터 통과
  const items = [1, 2, 3].map((i) => `<item><title>${tag ? `${tag} ` : ''}테스트 뉴스 ${i} 급등 - 테스트일보</title><link>https://news.example.com/a${i}</link><pubDate>${pub}</pubDate><source url="https://news.example.com">테스트일보</source></item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}
// 지수 브리핑(summary·items)과 종목 분석(headline·factors) 양쪽 형식을 모두 만족하는 응답
const geminiOk = { candidates: [{ content: { parts: [{ text: JSON.stringify({
  summary: '테스트 요약', items: [{ index: 1, why: '핵심 재료' }], headline: '테스트 진단', factors: ['요인1', '요인2'], outlook: '관전 포인트',
}) }] } }] };
// 실제 무료 한도 초과 응답 형태 — 일일 한도는 quotaId에 PerDay, 분당 한도는 PerMinute가 들어간다
const quota429 = (per) => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.',
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: `GenerateRequestsPer${per}PerProjectPerModel-FreeTier` }] }] } }, 429);

function routes({ krPct = { '005930': 4.2, '000660': 0.3 }, usPct = {}, idxPct = -1.2, newsTag = '', news = () => text(rss(newsTag)),
  yahoo = (m) => { const sym = decodeURIComponent(m[1]); return json(yahooChart(sym, usPct[sym])); }, gemini = () => json(geminiOk) } = {}) {
  return [
    { re: /polling\.finance\.naver\.com\/api\/realtime\/domestic\/stock\/(\d{6})/, fn: (m) => json(naverStock(m[1], krPct[m[1]] ?? 0.5)) },
    { re: /polling\.finance\.naver\.com\/api\/realtime\/domestic\/index\/(KOSPI|KOSDAQ)/, fn: () => json(naverIndex(idxPct)) },
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
async function pipeline(root, routeOpts, now = NOW_KR) {
  NET.routes = routes(routeOpts); NET.calls = []; NET.bodies = []; NET.blocked = [];
  return quiet(() => run({ root, now }));
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
const util = await import('./util.mjs');
const bud = await import('./aibudget.mjs');
const src = await import('./sources.mjs');
const { run } = await import('./fetch.mjs');
const stocklist = await import('./stocklist.mjs');
const wl = await import('./watchlist-apply.mjs');
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
await test('정상: 7개 파일 생성 · 급등락만 AI 분석 · 두 모델 고루 사용 · 분석 시각 기록 · 외부 차단 0건', async () => {
  const root = workspace();
  const { value } = await pipeline(root);
  assert.deepEqual([...value.written].sort(), FILES);
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

// ===== 종목 검색 목록(stocklist) =====
// 국내: 네이버 시가총액 목록(KOSPI 150개 = 2쪽, KOSDAQ 30개, 형식이 다른 코드 1개 섞음) / KIND(EUC-KR 표)
const krPage = (market, page) => {
  const total = market === 'KOSPI' ? 150 : 30;
  const from = (page - 1) * 100, to = Math.min(total, page * 100);
  const stocks = [];
  for (let i = from; i < to; i++) stocks.push({ itemCode: String((market === 'KOSPI' ? 100000 : 200000) + i), stockName: `${market}종목${i}`, stockEndType: 'stock' });
  if (market === 'KOSPI' && page === 1) stocks[0] = { itemCode: '005930', stockName: '삼성전자', stockEndType: 'stock' };
  if (market === 'KOSDAQ' && page === 1) stocks.push({ itemCode: '0000J0', stockName: '새형식코드', stockEndType: 'stock' });
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
const US_KO = { NASDAQ: [{ symbolCode: 'NVDA', stockName: '엔비디아', stockNameEng: 'NVIDIA Corp' }, { symbolCode: 'AAPL', stockName: '애플' }],
  NYSE: [{ symbolCode: 'BRK.B', stockName: '버크셔 해서웨이 B' }, { symbolCode: 'KO', stockName: 'Coca-Cola' }] };
function listRoutes({ naverKr = true, kind = true, nasdaq = true, usKo = true } = {}) {
  const fail = () => text('blocked', 403);
  return [
    { re: /m\.stock\.naver\.com\/api\/stocks\/marketValue\/(KOSPI|KOSDAQ)\?page=(\d+)/, fn: (m) => (naverKr ? json(krPage(m[1], +m[2])) : fail()) },
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
  assert.deepEqual(l.kr.find((r) => r[0] === '005930'), ['005930', '삼성전자', 'KOSPI']);
  assert.ok(!l.kr.some((r) => r[0] === '0000J0'), '6자리 숫자가 아닌 코드는 제외(파이프라인이 처리 못함)');
  assert.deepEqual(l.us.map((r) => r[0]).sort(), ['AAPL', 'BRK-B', 'GOOGL', 'KO', 'NVDA', 'QQQ', 'SPY']);
  assert.deepEqual(usRow(l, 'NVDA'), ['NVDA', '엔비디아', 'NVIDIA Corporation', 'NASDAQ'], '한글명은 네이버 우선');
  assert.deepEqual(usRow(l, 'GOOGL'), ['GOOGL', '알파벳 A(구글)', 'Alphabet Inc. Class A', 'NASDAQ'], '네이버에 없으면 기본 별칭');
  assert.deepEqual(usRow(l, 'BRK-B'), ['BRK-B', '버크셔 해서웨이 B', 'Berkshire Hathaway Inc. Class B', 'NYSE'], 'BRK.B → 야후 표기 BRK-B');
  assert.deepEqual(usRow(l, 'KO'), ['KO', '코카콜라', 'Coca-Cola Company (The)', 'NYSE'], '한글이 아닌 이름은 별칭으로');
  assert.equal(usRow(l, 'SPY')[3], 'NYSE Arca ETF');
  assert.equal(usRow(l, 'QQQ')[3], 'NASDAQ ETF');
  assert.deepEqual([l.meta.src.KOSPI, l.meta.src.KOSDAQ, l.meta.src.US], ['naver-KOSPI:150', 'naver-KOSDAQ:30', 'nasdaqtrader:7']);
  assert.equal(NET.blocked.length, 0, `차단된 호출: ${NET.blocked.join(', ')}`);
});
await test('검색 목록: 네이버 국내가 막히면 KRX KIND(EUC-KR) 목록으로 · 한글명 소스가 막혀도 별칭으로', async () => {
  const root = workspace();
  await buildList(root, { naverKr: false, usKo: false });
  const l = listOf(root);
  assert.deepEqual(l.kr.find((r) => r[0] === '005930'), ['005930', '삼성전자', 'KOSPI'], 'EUC-KR 한글 해독');
  assert.equal(l.kr.length, 25, 'KOSPI 13 + KOSDAQ 12');
  assert.equal(l.meta.src.KOSPI, 'kind-KOSPI:13');
  assert.equal(usRow(l, 'NVDA')[1], '엔비디아', '별칭');
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
  assert.equal(l.us.length, 7, '미국 기존 목록 유지');
  assert.equal(l.meta.src.krKept, true);
  const empty = workspace();
  const none = await buildList(empty, { naverKr: false, kind: false, nasdaq: false });
  assert.equal(none.value.written, false);
  assert.equal(fs.existsSync(file(empty, 'stocklist.json')), false, '만들 게 없으면 파일을 만들지 않음');
  const few = await buildList(workspace(), {}, { minKr: 500 });
  assert.equal(few.value.kr, 0, '기준(500)보다 적으면 국내는 기존(없음) 유지');
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
