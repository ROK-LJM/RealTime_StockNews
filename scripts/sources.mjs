// pages/scripts/sources.mjs
// 데이터 계층 — 국내 시세·수급은 네이버(실패 시 야후 .KS/.KQ), 해외 시세·과거 일봉·환율은 야후, 뉴스는 구글뉴스 RSS,
// 핵심 판단·종합분석은 Gemini 무료 API. 모두 키 없이(Gemini만 Secret 키) 쓰는 무료 소스이며 외부 의존성 없음.

import { mapLimit, sigMove } from './util.mjs';
import { allowance, pickModel, isKrSession, krHours } from './aibudget.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------- 캐시 (한 회차 안에서 같은 요청을 다시 보내지 않게) ----------
const cache = new Map();
const krSuffix = new Map(); // 6자리코드 -> '.KS' | '.KQ'
function getCache(k, ttl) { const h = cache.get(k); return h && Date.now() - h.t < ttl ? h.v : null; }
function setCache(k, v) { cache.set(k, { t: Date.now(), v }); return v; }

async function http(url, { as = 'text', timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'json' ? await res.json() : await res.text();
  } finally { clearTimeout(timer); }
}

function num(v) { if (v == null) return null; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function isKRCode(code) { return /^\d{6}$/.test(String(code).trim()); }
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

// ---------- 야후 차트 ----------
async function yahoo(symbol, { interval = '1d', range = '1d' } = {}) {
  const j = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`, { as: 'json' });
  const r = j?.chart?.result?.[0];
  if (!r?.meta) throw new Error(`야후 응답 없음: ${symbol}`);
  return r.meta;
}

function normalize(symbol, m, fallbackName) {
  const price = m.regularMarketPrice;
  const prevClose = m.chartPreviousClose ?? m.previousClose;
  const change = price != null && prevClose != null ? price - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
  const now = Math.floor(Date.now() / 1000);
  const reg = m.currentTradingPeriod?.regular;
  const marketStatus = reg && now >= reg.start && now < reg.end ? 'OPEN' : 'CLOSE';
  return {
    symbol, name: m.shortName || m.longName || fallbackName || symbol, currency: m.currency || 'USD',
    price, prevClose, change, changePct,
    high: m.regularMarketDayHigh ?? null, low: m.regularMarketDayLow ?? null,
    open: m.regularMarketOpen ?? null, volume: m.regularMarketVolume ?? null,
    marketStatus, asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
  };
}

// 한국 6자리 코드 -> 야후 심볼(.KS 우선, 실패 시 .KQ)
async function resolveKR(code) {
  if (krSuffix.has(code)) return code + krSuffix.get(code);
  let fallback = null;
  for (const sfx of ['.KS', '.KQ']) {
    try {
      const m = await yahoo(code + sfx);
      if (m.regularMarketPrice != null) {
        // 같은 6자리 코드가 코스피·코스닥에 모두 존재할 수 있고, 한쪽이 펀드(MUTUALFUND)인
        // 경우가 있어 주식(EQUITY)을 우선 선택한다. (예: 440110 → .KS는 펀드, .KQ가 파두)
        if (m.instrumentType === 'EQUITY' || m.instrumentType == null) { krSuffix.set(code, sfx); return code + sfx; }
        if (!fallback) fallback = sfx;
      }
    } catch {}
  }
  if (fallback) { krSuffix.set(code, fallback); return code + fallback; }
  throw new Error(`한국 종목을 찾지 못함: ${code}`);
}

// 한국 종목 실시간 시세 (네이버 polling, 지연 0분). 미국 IP에서도 동작 확인됨.
async function krStockNaver(code) {
  const j = await http(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, { as: 'json' });
  const d = j?.datas?.[0];
  if (!d || d.closePrice == null) throw new Error('네이버 종목 응답 없음: ' + code);
  const price = num(d.closePrice);
  let change = num(d.compareToPreviousClosePrice);
  let changePct = num(d.fluctuationsRatio);
  const dir = d.compareToPreviousPrice?.name;
  if (dir === 'FALLING') { change = -Math.abs(change ?? 0); changePct = -Math.abs(changePct ?? 0); }
  else if (dir === 'RISING') { change = Math.abs(change ?? 0); changePct = Math.abs(changePct ?? 0); }
  const prevClose = price != null && change != null ? price - change : null;
  return {
    name: d.stockName || code, currency: 'KRW', price, prevClose, change, changePct,
    open: num(d.openPrice), high: num(d.highPrice), low: num(d.lowPrice),
    volume: num(d.accumulatedTradingVolume), // 오늘 아직 체결이 없으면 없음(null) — 화면이 '체결 전'으로 본다
    marketStatus: d.marketStatus || null,
    // 매매 정지(tradeStopType HALTED) — 'market' = 서킷브레이커 같은 시장 전체 정지(tradableStatusCode 'marketOperationHalt'), 'stock' = 그 종목만.
    // 정지 중엔 값이 멈춰 있다(멈추기 직전 가격). 평소엔 이 칸이 없다
    ...(d.tradeStopType?.name === 'HALTED' ? { halt: d.tradableStatusCode === 'marketOperationHalt' ? 'market' : 'stock', haltAt: d.tradableStatusUpdatedAt || null } : {}),
    asOf: d.localTradedAt || new Date().toISOString(),
  };
}

// 한국 지수 실시간 (네이버). naverSym: 'KOSPI' | 'KOSDAQ'
async function krIndexNaver(naverSym) {
  const j = await http(`https://polling.finance.naver.com/api/realtime/domestic/index/${naverSym}`, { as: 'json' });
  const d = j?.datas?.[0];
  if (!d) throw new Error('네이버 지수 응답 없음: ' + naverSym);
  return {
    price: num(d.closePriceRaw ?? d.closePrice),
    change: num(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice),
    changePct: num(d.fluctuationsRatioRaw ?? d.fluctuationsRatio),
    marketStatus: d.marketStatus || null,
  };
}

export async function getQuote(item) {
  const code = String(item.code).trim();
  const market = item.market || (isKRCode(code) ? 'KR' : 'US');
  const key = `q:${code}`;
  const cached = getCache(key, 8000);
  if (cached) return item.name ? { ...cached, name: item.name } : cached;
  try {
    let q;
    if (market === 'KR' && isKRCode(code)) {
      // 한국 종목: 네이버 실시간 우선, 실패하면 야후(.KS/.KQ, 20분 지연)로 폴백
      try { q = { code, market, ...(await krStockNaver(code)), ok: true }; }
      catch { const symbol = await resolveKR(code); q = { code, market, ...normalize(symbol, await yahoo(symbol), item.name), ok: true }; }
    } else {
      q = { code, market, ...normalize(code, await yahoo(code), item.name), ok: true };
    }
    setCache(key, q);
    return item.name ? { ...q, name: item.name } : q;
  } catch (e) {
    return { code, market, name: item.name || code, ok: false, error: String(e.message || e) };
  }
}

// 종목이 많아도 한꺼번에 쏘지 않는다(차단·속도 제한 방지). 5개씩 동시 조회.
const QUOTE_CONCURRENCY = 5;
export async function getQuotes(items) { return mapLimit(items, QUOTE_CONCURRENCY, getQuote); }
// 국내 종목 네이버 실시간만(야후 대체 없음) — 개장 직후 집중 갱신(burst.mjs)용. 실패한 종목은 ok:false(그 종목은 직전 값을 그대로 쓴다)
export async function getKrQuotesLive(items) {
  return mapLimit(items, QUOTE_CONCURRENCY, async (it) => {
    const code = String(it.code).trim();
    try { return { code, market: 'KR', ...(await krStockNaver(code)), ok: true, ...(it.name ? { name: it.name } : {}) }; }
    catch (e) { return { code, market: 'KR', name: it.name || code, ok: false, error: String(e.message || e) }; }
  });
}

// ---------- 미국 시간외(프리·애프터마켓) 가격 ----------
// 정규장 밖에서 증권 앱은 시간외 가격을 보여주는데 대시보드는 정규장 종가뿐이라 '가격이 다르다'고 보이기 쉽다
// (예: 실적 발표 직후 애프터마켓 급변). 야후 차트 5분봉(includePrePost)의 마지막 체결을 시간외 가격으로 쓴다.
// 그 봉이 정규장 시간 안이면 시간외 거래가 아직 없는 것 → null.
export function extFromChart(j) {
  const r = j?.chart?.result?.[0];
  const reg = r?.meta?.currentTradingPeriod?.regular;
  const ts = r?.timestamp || [], close = r?.indicators?.quote?.[0]?.close || [];
  if (!reg || !Number.isFinite(reg.start) || !Number.isFinite(reg.end)) return null;
  for (let i = ts.length - 1; i >= 0; i--) {
    if (close[i] == null || !Number.isFinite(close[i]) || !Number.isFinite(ts[i])) continue;
    const session = ts[i] >= reg.end ? 'post' : ts[i] < reg.start ? 'pre' : null;
    return session ? { session, price: Math.round(close[i] * 10000) / 10000, at: ts[i] * 1000 } : null;
  }
  return null;
}
export async function getUsExt(symbol) {
  const j = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d&includePrePost=true`, { as: 'json' });
  return extFromChart(j);
}

// ---------- 과거 시세(일봉) ----------
// 야후 차트(무료, 키 불필요)로 약 6개월 일봉 종가를 받아온다 → 과거 등락 차트 + 예측의 입력.
export async function getHistory(item, range = '6mo') {
  const code = String(item.code).trim();
  const market = item.market || (isKRCode(code) ? 'KR' : 'US');
  try {
    const symbol = market === 'KR' && isKRCode(code) ? await resolveKR(code) : code;
    const j = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`, { as: 'json' });
    const r = j?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const closes = r?.indicators?.quote?.[0]?.close || [];
    const out = { dates: [], closes: [] };
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] != null) { out.dates.push(ts[i] * 1000); out.closes.push(Math.round(closes[i] * 100) / 100); }
    }
    return out.closes.length >= 2 ? out : null;
  } catch { return null; }
}

// ---------- 지수 + 분위기 ----------
// 한국 지수(코스피·코스닥) — 네이버 실시간, 실패하면 야후(20분 지연). fallback=false면 네이버만(개장 직후 집중 갱신 — 지연 값보다 직전 값이 낫다)
export async function getKrIndices(fallback = true) {
  return Promise.all([['KOSPI', '^KS11', '코스피'], ['KOSDAQ', '^KQ11', '코스닥']].map(async ([naverSym, ySym, name]) => {
    try { return { name, symbol: ySym, currency: 'KRW', ...(await krIndexNaver(naverSym)) }; }
    catch {
      if (!fallback) return null;
      try { const n = normalize(ySym, await yahoo(ySym), name); return { name, symbol: ySym, currency: 'KRW', price: n.price, change: n.change, changePct: n.changePct, marketStatus: n.marketStatus }; }
      catch { return null; }
    }
  }));
}
export async function getMarket() {
  const cached = getCache('market', 8000);
  if (cached) return cached;
  // 한국 지수: 네이버 실시간 우선(야후 폴백) / 미국 지수·VIX: 야후
  const usDefs = [['^GSPC', 'S&P 500'], ['^IXIC', '나스닥'], ['^VIX', 'VIX']];
  const krIdx = await getKrIndices();
  const usIdx = await Promise.all(usDefs.map(async ([sym, name]) => {
    try { const n = normalize(sym, await yahoo(sym), name); return { name, symbol: sym, currency: 'USD', price: n.price, change: n.change, changePct: n.changePct, marketStatus: n.marketStatus }; }
    catch { return null; }
  }));
  const indices = [...krIdx, ...usIdx].filter(Boolean);
  const vix = indices.find((i) => i.symbol === '^VIX');
  const mood = computeMood(indices.filter((i) => i.symbol !== '^VIX'), vix?.price);

  // 환율 (원/달러, 원/100엔) — 야후 무료 환율
  const fxDefs = [['KRW=X', '원/달러', 1], ['JPYKRW=X', '원/100엔', 100]];
  const fxSettled = await Promise.all(fxDefs.map(async ([sym, name, mult]) => {
    try {
      const m = await yahoo(sym);
      const price = m.regularMarketPrice * mult;
      const prev = (m.chartPreviousClose ?? m.previousClose) * mult;
      const change = price != null && prev != null ? price - prev : null;
      const r = (x) => x == null ? null : Math.round(x * 100) / 100;
      return { name, symbol: sym, price: r(price), change: r(change), changePct: change != null && prev ? (change / prev) * 100 : null };
    } catch { return null; }
  }));
  const forex = fxSettled.filter(Boolean);

  return setCache('market', { indices, vix: vix || null, mood, forex });
}

// 시장 분위기(공포·탐욕) — 개장 직후 집중 갱신(burst.mjs)도 같은 식으로 다시 계산한다
// 개장 전 예상 지수 — 동시호가가 막 시작된 08:55 전 값은 주문이 적어 크게 튄다(실측 08:50 코스피 → 실제 시가: 11/05 -3.6 → -1.7 · 11/06 -12.6 → -8.8 · 11/09 -21.9 → -0.9 · 11/10 +0.4 → +4.8).
// 그 값은 어제 종가·0%로 되돌린다(화면은 그대로 '개장 전') — 개장 5분 전(08:55 · 수능일처럼 10시에 여는 날은 09:55, 46차)부터는 '예상'으로 보여 준다
export function calmExpected(indices, now = Date.now()) {
  const k = new Date(now + 9 * 3600e3);
  if (k.getUTCHours() * 60 + k.getUTCMinutes() >= krHours(now)[0] - 5) return indices;
  return (indices || []).map((i) => (i && i.marketStatus === 'PREOPEN' && i.changePct && Number.isFinite(i.price) && Number.isFinite(i.change)
    ? { ...i, price: Math.round((i.price - i.change) * 100) / 100, change: 0, changePct: 0 } : i));
}
export function computeMood(indices0, vix) {
  let score = 50;
  // 개장 전 예상 지수는 분위기에 넣지 않는다(08:50 코스피 -21.86%에 점수가 43 → 13으로 떨어졌다 9시에 40으로) — 어제 종가와 같은 0%로 본다
  const indices = indices0.map((i) => (i && i.marketStatus === 'PREOPEN' ? { ...i, changePct: 0 } : i));
  const pcts = indices.map((i) => i.changePct).filter((x) => Number.isFinite(x));
  if (pcts.length) { const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length; score += clamp(avg, -4, 4) * 7; }
  if (Number.isFinite(vix)) score += clamp(18 - vix, -15, 12) * 1.2;
  score = Math.round(clamp(score, 0, 100));
  let label, tone;
  if (score < 25) { label = '극도의 공포'; tone = 'fear'; }
  else if (score < 45) { label = '공포'; tone = 'fear'; }
  else if (score <= 55) { label = '중립'; tone = 'neutral'; }
  else if (score <= 75) { label = '탐욕'; tone = 'greed'; }
  else { label = '극도의 탐욕'; tone = 'greed'; }
  const bits = [];
  const big = [...indices].sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))[0];
  if (big && Number.isFinite(big.changePct)) bits.push(`${big.name} ${big.changePct >= 0 ? '강세' : '약세'}(${big.changePct.toFixed(2)}%)`);
  if (Number.isFinite(vix)) bits.push(vix >= 25 ? `VIX 급등(${vix.toFixed(1)})` : vix >= 20 ? `VIX 다소 높음(${vix.toFixed(1)})` : `VIX 안정(${vix.toFixed(1)})`);
  const risk = score >= 55 ? '위험선호(리스크온)' : score <= 45 ? '위험회피(리스크오프)' : '관망';
  return { score, label, tone, summary: `${bits.join(' · ')} → ${risk} 심리` };
}

// ---------- 뉴스 + 호재/악재 태깅 ----------
const NEG = ['급락', '폭락', '하락', '약세', '적자', '손실', '소송', '리콜', '제재', '규제', '감산', '하향', '매도', '우려', '경고', '부진', '쇼크', '미달', '결함', '파업', '횡령', '조사', '벌금', '연기', '취소', '철회', '구조조정', '감자', '디폴트', '하한가', '휘청', '붕괴', '무너', '곤두박질', '증발', '반토막', '낮춰', '낮춘', '낮췄', '물린', '눈물', '미미',
  'downgrade', 'lawsuit', 'miss', 'plunge', 'fall', 'falls', 'drop', 'cut', 'cuts', 'warning', 'recall', 'probe', 'decline', 'loss', 'weak', 'slump', 'sink', 'tumble', 'bearish', 'selloff',
  // 영어 활용형(31차) — 'Stock Slides'·'Shares Slip'·'Stock Sinks'·'Plunges'를 중립으로 보던 것(미국 종목 이유·호재/악재 집계)
  'plunges', 'plunged', 'drops', 'dropped', 'sinks', 'sank', 'tumbles', 'tumbled', 'declines', 'declined', 'slide', 'slides', 'slid', 'sliding', 'slip', 'slips', 'slipped',
  'fell', 'falling', 'slumps', 'slumped', 'tanks', 'tanked', 'downgraded', 'downgrades', 'misses', 'missed', 'sell-off', 'rout'];
const POS = ['급등', '폭등', '상승', '강세', '흑자', '호실적', '수주', '계약', '신고가', '인수', '합병', '자사주', '배당', '상향', '매수', '돌파', '신제품', '승인', '호재', '사상최대', '최대실적', '확대', '성장', '상한가', '훈풍', '껑충', '불기둥', '훨훨', '랠리', '쾌재', '들썩', '높여', '높인', '높였', '수혜',
  'surge', 'jump', 'soar', 'beat', 'beats', 'upgrade', 'record', 'deal', 'approval', 'approved', 'contract', 'buyback', 'rally', 'gain', 'gains', 'strong', 'bullish', 'rise', 'rises', 'tops',
  'surges', 'surged', 'jumps', 'jumped', 'soars', 'soared', 'rallies', 'rallied', 'rose', 'climb', 'climbs', 'climbed', 'spikes', 'spiked', 'upgraded', 'upgrades', 'rebound', 'rebounds', 'rebounded', 'skyrockets'];

// 영문 키워드는 단어 경계로 매칭(예: "mission"이 "miss"로 오탐되지 않도록), 한글은 부분일치
function kwHit(raw, low, w) {
  if (/^[\x00-\x7f]+$/.test(w)) return new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low);
  return raw.includes(w);
}

export function tagSentiment(text) {
  const raw = String(text || '').replace(/(?:원화|달러|엔화|유로)\s?(?:강세|약세)/g, ''); // 환율 강세·약세는 종목 호재·악재가 아니다('현대차, 원화 강세·원자재 부담…목표가 하향')
  const low = raw.toLowerCase();
  const hits = { pos: [], neg: [] };
  for (const w of POS) if (kwHit(raw, low, w)) hits.pos.push(w);
  for (const w of NEG) if (kwHit(raw, low, w)) hits.neg.push(w);
  const score = hits.pos.length - hits.neg.length;
  let label = '중립', tone = 'neutral';
  if (score > 0) { label = '호재'; tone = 'pos'; }
  else if (score < 0) { label = '악재'; tone = 'neg'; }
  return { label, tone, score, keywords: [...new Set([...hits.pos, ...hits.neg])].slice(0, 4) };
}

// 같은 기사·같은 소식이 매체·표현만 바꿔 거듭 실린 것 — 괄호 꼬리표·문장부호를 빼고(종목 뉴스는 종목 이름·별칭 keys도 빼고)
// 글자쌍이 짧은 쪽 기준으로 겹치는 비율. 이름을 뺀 한글 제목은 70%, 영문(흔한 낱말이 많아 'Why … rising today'/'… falling today'도 0.84)과
// 이름 정보가 없는 지수 뉴스는 90%. 방향 말·호재·악재가 서로 반대면 글자가 비슷해도 다른 기사.
// 실측 10/22: 같은 소식('…추진선 건조…11월 초 인도' / '…테라 클로브호 오는 11월 인도') 0.7~0.8, 같은 재료의 다른 날 기사 0.47
const squashTitle = (t) => String(t ?? '').replace(/\[[^\]]*\]|\([^)]*\)|[\s'"‘’“”…·,.!?:\-–—|]/g, '').toLowerCase();
const titleGrams = (t, keys = []) => {
  let s = squashTitle(t);
  for (const k of keys.map(squashTitle).filter((x) => x.length >= 2).sort((x, y) => y.length - x.length)) s = s.split(k).join('|');
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
};
export function sameStory(a, b, keys = []) {
  const A = titleGrams(a, keys), B = titleGrams(b, keys);
  if (A.size < 4 || B.size < 4) return String(a ?? '').trim() === String(b ?? '').trim();
  const da = titleDir(String(a ?? '')), db = titleDir(String(b ?? '')), ta = tagSentiment(a).tone, tb = tagSentiment(b).tone;
  if ((da && db && da !== db) || (ta !== tb && ta !== 'neutral' && tb !== 'neutral')) return false;
  let k = 0;
  for (const x of A) if (B.has(x)) k++;
  const need = keys.length && !/^[\x00-\x7f]*$/.test(`${a}${b}`) ? 0.7 : 0.9;
  return k / Math.min(A.size, B.size) >= need;
}

// 제목 끝의 매체 꼭지 이름(' : 금융'·' : 기업주식정보'·' : 기업·산업' — 11/02~11/10 뉴스 2,821건 중 98건) — 기사 내용이 아니라 받을 때 뗀다(45차)
const SECTION_TAIL_RE = /\s:\s[가-힣·]{2,8}$/;
// recentDays>0 이면 최근 N일 뉴스만(구글 when: 연산자 + pubDate 필터), 최신순 정렬.
// 같은 기사·같은 소식은 최신 하나만(keys: 종목 이름·별칭 — 빼고 비교), 시세 안내 기사는 뒤로 — 8건 안에 서로 다른 실제 뉴스가 먼저(카드·AI 입력 모두)
// keep(title): 남길 기사 판정(종목 뉴스의 관련도 필터). 주면 후보를 넉넉히(40건) 읽고 걸러 8건까지.
// 도박·카지노 광고 같은 스팸 제목은 어느 검색이든 뺀다.
// more: 3건이 안 되면 넓혀서 한 번 더 찾을 검색어(37차 — 합쳐서 고른다. 두 번째가 실패해도 첫 결과는 지킨다)
async function googleNews(query, ko, recentDays = 0, keep = null, keys = [], more = null) {
  const hl = ko ? 'ko' : 'en-US', gl = ko ? 'KR' : 'US', ceid = ko ? 'KR:ko' : 'US:en';
  const read = async (one) => {
  const q = recentDays > 0 ? `${one} when:${recentDays}d` : one;
  const xml = await http(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`, { as: 'text' });
  const items = [];
  for (const b of xml.split('<item>').slice(1, keep ? 41 : 13)) {
    const pick = (tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : ''; };
    let title = pick('title');
    let source = pick('source');
    if (!source) { const idx = title.lastIndexOf(' - '); if (idx > 0) source = title.slice(idx + 3); }
    for (let i = 0; i < 3 && source && title.endsWith(source); i++) title = title.slice(0, -source.length).replace(/[\s\-–—|]+$/, '');
    title = title.replace(SECTION_TAIL_RE, ''); // 매체 꼭지 꼬리(45차)
    const pub = pick('pubDate');
    const pubMs = pub ? Date.parse(pub) : null;
    items.push({ title, source, time: pub ? new Date(pub).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '', pubMs, link: pick('link'), sentiment: tagSentiment(title) });
  }
  return items;
  };
  const pipe = (items) => {
  let out = items.filter((it) => it.title && !SPAM_RE.test(it.title) && !QUOTE_PAGE_RE.test(it.title) && !HOLDINGS_RE.test(it.title) && (!keep || keep(it.title)));
  if (recentDays > 0) {
    const cutoff = Date.now() - recentDays * 86400000;
    out = out.filter((it) => it.pubMs == null || it.pubMs >= cutoff);
  }
  out.sort((a, b) => (b.pubMs || 0) - (a.pubMs || 0));
  out = out.filter((it, i) => !out.slice(0, i).some((p) => sameStory(p.title, it.title, keys)));
  out = [...out.filter((it) => !priceOnly(it.title)), ...out.filter((it) => priceOnly(it.title))];
  return out.slice(0, 8);
  };
  const first = await read(query);
  let out = pipe(first);
  if (more && out.length < 3) out = pipe([...first, ...(await read(more).catch(() => []))]);
  return out;
}

// ---------- 시장 조치(사이드카) — 뉴스 속보로 ----------
// 사이드카(프로그램매매 호가 효력정지 — 코스피200 선물 ±5%, 코스닥은 코스닥150 선물 ±6%·지수 ±3%가 1분 넘게 이어지면 프로그램 매수/매도 주문 5분 정지,
// 하루 한 번)는 시장 전체 조치라 종목 시세엔 표시가 없고, 무료 실시간 출처도 없다(네이버 지수 응답엔 칸이 없고, 네이버 PC·모바일 페이지는
// robots.txt가 모든 수집을 막고, 거래소 KIND는 방화벽이 막음 — 2026-11-06 확인). → 구글 뉴스 속보 제목으로 그날 시장·방향·시각을 찾는다.
// 방향은 '사이드카' 바로 앞 매수/매도, 시장은 그 앞의 가장 가까운 시장 이름('코스피 이어 코스닥도 매도 사이드카' → 코스닥),
// '코스피·코스닥 동반'처럼 둘을 함께 쓰면 둘 다. 방향이 없거나 '사이드카 해제'면 아님
const SIDECAR_RE = /(매수|매도)\s*['‘’"“”]?\s*사이드카/;
export function sidecarOf(title) {
  const t = String(title ?? '');
  const m = t.match(SIDECAR_RE);
  if (!m || /사이드카\S*\s*(?:해제|종료)/.test(t)) return [];
  const dir = m[1] === '매수' ? 'buy' : 'sell';
  const head = t.slice(0, m.index);
  if (!/이어/.test(head) && /코스피\s*[·ㆍ,]\s*코스닥|코스닥\s*[·ㆍ,]\s*코스피|코스피와\s*코스닥|코스닥과\s*코스피/.test(head)) return [{ mk: 'KOSPI', dir }, { mk: 'KOSDAQ', dir }];
  const i = Math.max(head.lastIndexOf('코스피'), head.lastIndexOf('코스닥'));
  return i < 0 ? [] : [{ mk: head.startsWith('코스닥', i) ? 'KOSDAQ' : 'KOSPI', dir }];
}
// 그날(한국시간) 09:00~15:40 기사에서 시장·방향마다 시각 하나 — 같은 시장·방향 기사가 3분 안에 3건 이상 몰린 첫 묶음의 두 번째 기사 시각.
// 실제 사이드카는 속보가 한꺼번에 쏟아진다(11/06 코스닥 09:06~09:10 15건 넘게·코스피 09:36~09:37 7건). 시각을 잘못 찍는 언론사가 있어
// (09:04 서킷브레이커 기사를 08:40·08:54로, 09:35쯤 코스피 사이드카 기사를 09:13·09:14로 — 두 건이 1분 간격으로 붙기도 함) 2건으론 부족하다.
// 두 번째로 보도한 시각이라 실제 발동보다 1~2분 늦을 수는 있어도 이르지는 않다
const KST_OFF = 9 * 3600e3;
const kstDay = (ms) => new Date(ms + KST_OFF).toISOString().slice(0, 10);
const kstMinOf = (ms) => { const d = new Date(ms + KST_OFF); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export function sidecarEvents(items, now = Date.now()) {
  const day = kstDay(now), by = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !Number.isFinite(it.pubMs) || kstDay(it.pubMs) !== day || kstMinOf(it.pubMs) < 9 * 60 || kstMinOf(it.pubMs) > 15 * 60 + 40) continue;
    for (const e of sidecarOf(it.title)) { const k = `${e.mk}|${e.dir}`; if (!by.has(k)) by.set(k, []); by.get(k).push(it.pubMs); }
  }
  const out = [];
  for (const [k, ts] of by) {
    ts.sort((a, b) => a - b);
    const i = ts.findIndex((t, j) => j + 2 < ts.length && ts[j + 2] - t <= 3 * 60e3);
    if (i >= 0) { const [mk, dir] = k.split('|'); out.push({ kind: 'sidecar', mk, dir, at: new Date(ts[i + 1]).toISOString() }); }
  }
  return out;
}
// 구글 뉴스 '사이드카' 최근 하루 기사 [{ title, pubMs }] — 발행 시각 없는 기사는 뺀다
export async function getSidecarNews() {
  const xml = await http(`https://news.google.com/rss/search?q=${encodeURIComponent('사이드카 when:1d')}&hl=ko&gl=KR&ceid=KR:ko`, { as: 'text' });
  return xml.split('<item>').slice(1).map((b) => {
    const pick = (tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : ''; };
    const pub = Date.parse(pick('pubDate'));
    return { title: pick('title'), pubMs: Number.isFinite(pub) ? pub : null };
  }).filter((it) => it.title && it.pubMs != null);
}
// 그날 시장 조치 기록 { day: 'YYYY-MM-DD'(한국), v: 판, items[{ kind: 'cb'(서킷브레이커)|'sidecar', mk: 'KOSPI'|'KOSDAQ', dir?: 'buy'|'sell', at: ISO }] }
// — 그날 시각인 것만(날이 바뀌면 새로), 같은 조치(종류·시장·방향)는 가장 이른 시각 하나, 시각순. 없으면 null.
// v: 사이드카 판정 규칙의 판 — 다르면 그날 사이드카 기록을 버리고 다시 찾는다(서킷브레이커는 시세 정지 시각이라 유지)
export const MEASURES_V = 2;
export function mergeMeasures(prev, found, now = Date.now()) {
  const day = kstDay(now), keepSc = prev?.v === MEASURES_V;
  const ok = (x) => !!x && (x.kind === 'cb' || (x.kind === 'sidecar' && (x.dir === 'buy' || x.dir === 'sell'))) && (x.mk === 'KOSPI' || x.mk === 'KOSDAQ')
    && Number.isFinite(Date.parse(x.at)) && kstDay(Date.parse(x.at)) === day;
  const items = (Array.isArray(prev?.items) ? prev.items : []).filter((x) => ok(x) && (x.kind === 'cb' || keepSc)).map((x) => ({ ...x }));
  for (const e of (Array.isArray(found) ? found : []).filter(ok)) {
    const same = items.find((x) => x.kind === e.kind && x.mk === e.mk && x.dir === e.dir);
    if (!same) items.push({ kind: e.kind, mk: e.mk, ...(e.kind === 'sidecar' ? { dir: e.dir } : {}), at: e.at });
    else if (Date.parse(e.at) < Date.parse(same.at)) same.at = e.at;
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return items.length ? { day, v: MEASURES_V, items } : null;
}

// ---------- 종목 뉴스 관련도 ----------
// 구글 뉴스 검색은 느슨해서 도박·카지노 광고, 다른 종목이 주인공인 시황·상장 공지 기사가 섞인다
// (실측 2026-10-21: 238건 중 93건(39%)이 제목에 종목 이름 없음 — '토토미 쌀국수', 'a1 카지노', 'ELW 224종목 신규 상장' 등).
// → 제목에 그 종목의 이름·별칭·티커가 있는 기사만 남긴다. 다른 이름으로 불리는 종목은 별칭으로 보완.
export const SPAM_RE = /카지노|바카라|토토\s?사이트|스포츠\s?토토|먹튀|꽁머니|홀덤|양방\s?배팅|파워볼|릴게임|슬롯\s?머신|온라인\s?슬롯|#[^\s#]{2,}.*#[^\s#]{2,}|채널\s?지웁니다|반드시\s?체크해\s?보세요|\*[^*\s]{0,6}\s?속보\*/; // 뒤 넷은 유튜브 낚시 제목(41차)
// 기사가 아닌 시세 페이지('NVIDIA Corporation (NVDA) Stock Price, News, Quote & History'·'Apple AAPL Stock Price and Chart | Live AAPL Quote Today'·'TSM Stock Price — TSMC Chart')
// — 구글 뉴스가 늘 새 날짜로 잡아 뉴스 칸과 AI 입력을 차지했다(11/02~11/10 미국 뉴스 55건 중 1~3건씩). 어느 검색이든 뺀다(45차)
export const QUOTE_PAGE_RE = /\b(?:stock\s+price|quote)\s*[,&]?\s*(?:news|quote|history|chart|analysis)\s*[,&]\s*(?:and\s+)?(?:news|quote|history|analysis)\b|\bstock\s+price\s+and\s+chart\b|\blive\s+[A-Z.]{1,6}\s+quote\b|\bstock\s+price\s*[—–-]\s*[^—–-]*\bchart\s*$/i;
// 기관의 13F 보유 변동 공시 자동 기사(MarketBeat — 'Apple Inc. $AAPL Stock: Axxcess Wealth Management LLC Lowers Stake'·'2,311 Amazon.com, Inc. $AMZN Shares Sold by Gibson Capital LLC')
// — 회사 소식이 아니라 분기 지분 신고라 뺀다. 11/02~11/10 미국 뉴스 칸 6,907개 중 470개(6.8%), 제목의 캐시태그($AMZN)로 가린다(48차)
export const HOLDINGS_RE = /^(?=.*\$[A-Z]{1,5}\b).*\b(?:Stock|Shares?|Stake|Position|Holdings?)\b/;
// 뉴스에서 흔히 쓰는 다른 이름(종목코드·티커별). 없는 종목은 이름·영문명·티커로만 판단.
const NEWS_ALIAS = {
  '000660': ['하이닉스', '삼전닉스'], '010120': ['LS일렉트릭'], '329180': ['현대중공업'], '005380': ['현대자동차'],
  '373220': ['LG엔솔', '엘지에너지솔루션'], '028050': ['삼성이앤에이', '삼성엔지니어링'], '012450': ['한화에어로'],
  '079550': ['LIG D&A', 'LIG디펜스', 'LIG넥스원'], '005930': ['삼전'],
  SPCX: ['SpaceX'], TSM: ['TSMC', 'Taiwan Semi'], SMCI: ['Supermicro'], GOOGL: ['Google', 'Alphabet'], GOOG: ['Google', 'Alphabet'], META: ['Meta'],
};
const normTitle = (s) => String(s ?? '').toLowerCase().replace(/[\s·.,'"’‘“”()[\]\-–—]/g, '');
// 우선주(코드 끝자리 5·7·9 + 이름 끝 '우', '2우B' 등)는 보통주 이름으로 — 'LG전자우' → 'LG전자'
export function krBaseName(name, code) {
  const n = String(name ?? '').trim();
  return /^\d{5}[579]$/.test(String(code ?? '')) ? n.replace(/\d?우[A-C]?$/, '') || n : n;
}
// 영문 회사명에서 법인 형태·주식 종류를 뗀 핵심 이름 — 'Tesla, Inc.' → 'Tesla', 'Amazon.com, Inc.' → 'Amazon'
export function enCoreName(en) {
  return String(en ?? '').replace(/\.com\b/i, '')
    .replace(/,?\s+(Inc\.?|Incorporated|Corporation|Corp\.?|Co\.|Company|Ltd\.?|Limited|Holdings?|plc|N\.V\.|S\.A\.|AG|SE|Class [A-Z]|Common Stock|Ordinary Shares|American Depositary.*|ADR|ADS)\b.*$/i, '')
    .replace(/[,.]\s*$/, '').trim();
}
// 제목에서 찾을 열쇠말(정규화) — 이름·보통주 이름·영문 핵심 이름(두 단어 이상이면 앞 두 단어도)·별칭
export function newsKeys(item) {
  const keys = new Set();
  const add = (s) => { const k = normTitle(s); if (k.length >= 2) keys.add(k); };
  const code = String(item?.code ?? '').trim();
  add(item?.name);
  if (item?.market === 'KR') add(krBaseName(item.name, code));
  else {
    const core = enCoreName(item?.en);
    if (core) { add(core); const w = core.split(/\s+/); if (w.length > 2) add(w.slice(0, 2).join(' ')); }
  }
  for (const a of NEWS_ALIAS[code] || []) add(a);
  return [...keys];
}
// 이름 바로 뒤에 계열사·다른 회사 이름이 이어지면('현대차' → '현대차증권, LS일렉트릭…', '현대건설' → '현대건설기계') 그 회사 기사
// (실측 2026-10-22: 현대차 이유로 '현대차증권' 기사가 잡힘, '…-현대차證'처럼 한자로 줄여 쓰기도 함). '현대차그룹'처럼 그 회사 묶음은 관련 기사로 둔다.
const AFFILIATE_SUFFIX = /^(?:증권|證|투자증권|캐피탈|카드|생명|화재|손해보험|손보|자산운용|기계|엔지니어링|중공업|모비스|글로비스|제철|로템|위아|오토에버|바이오로직스|바이오에피스|리츠|인베스트먼트|파트너스)/;
function onlyAffiliate(raw, item) {
  if (item?.market !== 'KR') return false;
  const code = String(item.code ?? '').trim();
  const names = [...new Set([item.name, krBaseName(item.name, code), ...(NEWS_ALIAS[code] || [])].filter(Boolean))];
  let found = false;
  for (const n of names) {
    for (let i = raw.indexOf(n); i >= 0; i = raw.indexOf(n, i + 1)) {
      found = true;
      if (!AFFILIATE_SUFFIX.test(raw.slice(i + n.length))) return false; // 제대로 된 언급이 하나라도 있으면 관련 기사
    }
  }
  return found; // 찾은 이름이 모두 다른 회사 이름의 앞부분(이름을 못 찾았으면 아래 일반 판정 그대로)
}
// 관련 기사인가 — 열쇠말이 제목에 있거나, 미국 종목이면 티커가 대문자 단어로 있으면('PLUG'는 되고 'plug-in'은 안 됨)
export function isRelevantNews(title, item, keys = newsKeys(item)) {
  const t = normTitle(title);
  if (keys.some((k) => t.includes(k))) return !onlyAffiliate(String(title ?? ''), item);
  const code = String(item?.code ?? '').trim();
  return item?.market !== 'KR' && /^[A-Z][A-Z.\-]{0,9}$/.test(code)
    && new RegExp(`(^|[^A-Za-z])${code.replace(/[.\-]/g, '\\$&')}([^A-Za-z]|$)`).test(String(title ?? ''));
}
// 시세만 알려 주는 자동 기사(이유 없음) — '왜 움직였나'·급등락 기록의 이유로는 건너뛴다(뉴스 목록엔 그대로).
// 실측(2026-10-22): 뉴스 224건 중 약 45건 — 'SK하이닉스 주가, 10월 22일 장중 1,281,000원 1.00% 하락', '현대건설 주가 상승 중',
// 'HD건설기계 장중 3%대 상승'. 이유가 붙은 제목('…추정치 웃돈 파두…주가는 장중 6.75% 하락')은 거르지 않도록 틀을 좁게 잡는다.
// docs/app.js의 PRICE_ONLY와 같게 유지(자체 테스트가 두 곳 결과를 비교).
export const PRICE_ONLY = [
  /주가,?\s*\d{1,2}월\s*\d{1,2}일\s*(?:장중|장\s?마감|애프터마켓|프리마켓|시간외|오전|오후)?\s*[\d,.]+원\s*(?:[\d,.]+원\s*)?[\d.]+%\s*(?:상승|하락|보합)(?:\s*(?:기록|마감|중))?$/,
  /^\S+(?:\s\S+){0,3}\s주가\s*(?:상승|하락|강세|약세|보합)\s*중$/,
  /^(?:\[특징주\]\s*)?[^\s,…·]+,?\s(?:\d{1,2}일\s*)?(?:장중|장\s?초반|오전|오후)\s*[\d.]+%대?\s*(?:상승|하락|강세|약세|급등|급락)(?:\s*중|세)?$/,
  /^\S+(?:\s\S+){0,3}\s주가\s*[\d,]+원\s*(?:상승|하락|보합)\s*(?:후\s*)?장\s?마감$/,
  /^(?:\[특징주\]\s*)?[^\s,…·]+(?:\s[^\s,…·]+)?,?\s장중\s*[\d.]+%대?\s*(?:상승|하락|강세|약세|급등|급락)세?(?:하며|\s*보이며)?…?\s*[\d만,.]+원선?\s*(?:기록|거래)/,
  /^[^\s,…·]+(?:\s[^\s,…·]+)?,?\s장중\s*[\d.]+%대?\s*(?:상승|하락)해\s*[\d만,.]+원$/,
  /^\S+(?:\s\S+){0,3}\s거래량\s*[\d.]+%\s*(?:증가|감소)/,
  /^\d{1,2}일\s*[^\s,…·]+(?:\s[^\s,…·]+)?\s*[\d,]+원\s*[\d.]+%\s*(?:내려|올라)/,           // '4일 한화오션 52,400원 2.60% 내려 하락률 동일업종 평균보다…'
  /거래량\s*[\d,]+만?주…?\s*[\d만,]+원서\s*[\d.]+%\s*(?:상승|하락|강세|약세)/,                   // '한화솔루션 거래량 1342만주…2만7050원서 3.39% 약세'
  /\|\s*Price:\s*[\d.,]+\s*\|\s*Chg%:/i,
  /주가,?\s*\d{1,2}월\s*\d{1,2}일\s*(?:장중|장\s?마감|오전|오후)?\s*[\d.]+%\s*(?:상승|하락)\s*동일업종/, // 'LS ELECTRIC 주가, 11월 5일 장중 11.94% 하락 동일업종 동반 약세'
  /^\[마감분석\][^…]*?[\d.]+%\s*(?:상승|하락|급등|급락|강세|약세|내린|오른)\s*(?:[\d만,.]+원\s*)?마감/,                          // '[마감분석] 대덕전자 19.80% 급락 마감 7만9800원 기록'                                                       // 'NVDA|NVIDIA Corp|Price:200.130|Chg%:-6.560'
  /\bstock\s+(?:(?:rises|falls)\s+\w+day,\s+(?:still\s+)?(?:out|under)performs\s+market|(?:out|under)performs\s+(?:competitors|market|\w+day\s+when\s+compared\s+to\s+competitors)(?:\s+on\s+(?:a\s+)?(?:strong|weak)\s+trading\s+day|\s+despite\s+(?:losses\s+on\s+the\s+day|daily\s+gains))?)$/i, // MarketWatch 자동 기사 'Plug Power Inc. stock outperforms competitors on strong trading day'·'… stock falls Tuesday, underperforms market'(45차)
  /\b(?:moved|opened|closed)\s+(?:up|down)\s+by\s+[\d.]+%\s+on\s+[a-z]{3,9}\.?\s+\d{1,2}\b/i, // 'Microsoft Corp Stock (MSFT) Moved Up by 3.24% on Nov 9: Facts Behind the Movement'(45차)
];
// 제목 끝에 붙는 매체의 꼭지 이름(' : 기업주식정보'·' : 경제')은 떼고 판단한다
const coreTitle = (t) => String(t ?? '').trim().replace(/\s:\s\S{1,10}$/, '');
export const priceOnly = (title) => { const t = coreTitle(title); return PRICE_ONLY.some((re) => re.test(t)); };
// 이유로 쓸 뉴스 고르기(급등락 기록) — docs/app.js의 pickReasonNews와 같게 유지(자체 테스트가 비교).
// 시세 안내·상품 상장 공지('…ELW 224종 상장')·방향이 반대인 기사('15% 급등' 기사인데 오늘은 하락 — 이유일 수 없음)는 빼고
// ① 그날 나온 같은 방향의 [특징주] → ② 같은 방향 기사(미국은 티커 뒤에 움직임 + 원인이 오는 제목 먼저) → ③ 방향을 알 수 없는 기사 → ④ 여러 종목 나열·'[오늘의 …]' 모음·리포트 요약·주가 전망 글·칼럼 꼭지 순.
// 같은 등급 안에서는 최신순. 방향은 제목의 오름·내림 말, 없으면 호재·악재 태그(내린 날의 '수주 1조 돌파' 같은 호재 기사는 이유 아님).
export const LISTING_RE = /(ELW|ETN|ETF|리츠|스팩)[^…]{0,30}상장|신규\s*상장/;
// 기부·봉사 같은 사회공헌 기사('…김장 김치 2500박스 이웃에 전달') — 주가 움직임의 원인이 아니라 이유에서 뺀다(31차, 봇·화면 같게)
// 채용(공채)·사내 행사 기사도 같은 규칙(39차 — '안랩, 하반기 공채…', 'HD현대중공업, 난타 공연 관람…근로자 화합 목적', 'K리그-HD현대일렉트릭, 축구 교실')
// 미국 13F 보유 변동 공시('… $AMZN Shares Sold by … LLC')도 이유 아님(48차 — 봇은 받을 때도 뺀다)
const CSR_RE = /김장|기부|후원|봉사|성금|장학금|헌혈|연탄|사회공헌|이웃\s*사랑|나눔\s*(?:행사|활동|캠페인)|공채|(?:신입|경력|하반기|상반기)\s?(?:사원\s?)?채용|채용\s?(?:공고|설명회|박람회)|인턴\s?(?:모집|채용)|화합\s?(?:행사|목적)|축구\s?교실|공연\s?관람|직업\s?훈련|산학\s?협력|인재\s?양성|브랜드\s?평판|^(?=.*\$[A-Z]{1,5}\b).*\b(?:Stock|Shares?|Stake|Position|Holdings?)\b/;
const UP_RE = /상승|(?<!(?:원화|달러|엔화|유로)\s?)강세|급등|반등|↑|오름|올라|올랐|오른(?!쪽|손|팔)|치솟|솟구|폭등|껑충|뛰었|훨훨|불기둥|랠리|들썩|상한가|신고가/;
// '…2.80% 조정'·'조정세'·'조정 국면'도 내림 말('목표가 상향 조정'처럼 방향이 붙은 조정은 아님)
const DOWN_RE = /하락|(?<!(?:원화|달러|엔화|유로)\s?)약세|급락|↓|내림|내려|내린|내렸|떨어|폭락|하한가|신저가|주춤|추락|증발|반토막|휘청|무너|붕괴|곤두박질|주저앉|미끄러|뒷걸음|고꾸라|털썩|빠졌|밀려(?!들)|밀린|[\d.]+%\s*조정|조정\s*(?:국면|장세|세|받)/;
const roundupTitle = (t) => ((t.match(/[,，]/g) || []).length >= 3 && /등\s*$/.test(t)) || /^\[오늘의\s?[^\]]*\]/.test(t) || (t.match(/·/g) || []).length >= 3; // 'A·B·C·D 강세'도 나열(41차)
const titleDir = (t) => (UP_RE.test(t) ? 1 : 0) - (DOWN_RE.test(t) ? 1 : 0); // 1 오름 말만 · -1 내림 말만 · 0 둘 다·없음
// 그 종목의 방향 — 한 제목에 여러 종목이면('[특징주] 삼성전자 '상승' SK하이닉스 1%대 '하락'') 종목 이름 바로 뒤 10자 안의
// 오름·내림 말로, 없으면 제목 전체로 판단
function nameDir(t, names) {
  for (const n of names || []) {
    const i = n ? t.indexOf(n) : -1;
    if (i < 0) continue;
    const seg = t.slice(i + n.length, i + n.length + 10);
    const d = (UP_RE.test(seg) ? 1 : 0) - (DOWN_RE.test(seg) ? 1 : 0);
    if (d) return d;
    // 10자 안에 없으면 그 이름이 든 절(…·...·쉼표·쌍반점까지)에서 — 'A·B·C 휘청...D·E는 상승'의 A는 내림(36차)
    const rest = t.slice(i + n.length), cut = rest.search(/\.\.\.|…|,|;/);
    if (cut > 0) { const c = titleDir(rest.slice(0, cut)); if (c) return c; }
  }
  return titleDir(t);
}
// 증권사 리포트 요약('[리포트 브리핑]심텍, … 목표가 180,000원 - 교보증권') — 목표가와 함께 나와 대개 좋은 쪽이라 나쁜 말이 없으면 오름으로 본다
const REPORT_RE = /^\[리포트\s?브리핑\]|목표가\s*[\d,]+\s*원/;
// 주가 전망·기술적 분석 글(자동 생성 해설 — '…주가는 ₩370,322 지지선을 지킬 수 있을까?'·'과매도 RSI가 반전 가능성…'·'…상승세는 지속될까?'·'… 주가 횡보')
// — 원인이 아니라 해설이라 나열·리포트 요약과 함께 맨 뒤로(사실이 섞인 제목도 있어 빼지는 않는다)
// 물음표로 끝나는 제목('…급락한 이유는?'·'… Time to Sell?')도 원인을 말하지 않는 해설이라 같은 등급
// 번호 붙은 연재·기획 기사('[한화에어로 해부⑤] …'·'[전자 3형제 경쟁 공식①] …')도 그날 움직임의 원인이 아닌 해설이라 같은 등급
// 종목 추천·리포트·전망 칼럼 꼭지('… [오늘, 이 종목]'·'[버핏 리포트] …'·'… [주식 초고수는 지금]'·'[○○ 주가전망] …')도 앞이든 끝이든 같은 등급
// — 사실을 전하는 꼭지('[핫종목]'·'[종목NOW]'·'[특징주]')는 그대로
// 외국인·기관 매매만 전하는 자동 기사('[장중수급포착] … 외국인/기관 동시 순매수… 주가 +6.00%'·'[거래소 외국인] …'·'[공매도 브리핑] …')·매경 자동 신호('[MK시그널] …')·영어 'Stock Price Forecast'·'Is a Trending Stock'도 같은 등급(45차)
const SPEC_RE = /지지선|저항선|과매도|과매수|\bRSI\b|기술적\s*분석|횡보|무슨\s?일|주가\s?전망|봤더니|[‘'"]이것[’'"]|(?:있을까|될까|갈까|할까)\s*\??\s*(?:$|…|\.\.\.)|\?\s*$|^\[[^\]]*[①-⑳][^\]]*\]|\[[^\]]*(?:이\s?종목|[eE]종목|추천|전망|리포트|고수|탐구|풍향계|돋보기|줌인)[^\]]*\]|\b[Ss]tock\s+[Ff]orecasts?\b|\b[Pp]rice\s+[Pp]redictions?\b|\b[Pp]rice\s+[Ff]orecasts?\b|\b[Tt]rending\s+[Ss]tock\b|\[(?:장중)?수급포착\]|\[MK시그널\]|\[공매도[^\]]*\]|^\[(?:거래소|유가증권|코스피|코스닥)\s?(?:외국인|기관|개인)[^\]]*\]/;
const weakTitle = (t) => { const c = coreTitle(t); return roundupTitle(c) || REPORT_RE.test(c) || SPEC_RE.test(c); };
// '소식에도'·'불구'처럼 거스르는 말이 있으면 호재·악재 낱말로 방향을 짐작하지 않는다
const CONTRA_RE = /에도[\s,.…'"‘’“”]|에도$|불구|무색/;
// 기사가 가리키는 그 종목의 방향 — ① 이름 뒤·제목의 오름·내림 말 ② 없으면 호재·악재 태그 ③ 리포트 요약은 좋은 쪽
function newsDir(it, names) {
  const d = nameDir(it.title, names);
  if (d) return d;
  if (CONTRA_RE.test(it.title)) return 0;
  const tone = it.sentiment && it.sentiment.tone;
  return tone === 'pos' ? 1 : tone === 'neg' ? -1 : REPORT_RE.test(it.title) ? 1 : 0;
}
// items: 최신순 뉴스, pct: 그날 등락률, day: 그 시장 현지 날짜(YYYYMMDD), ymd(ms): 같은 기준의 날짜 함수, names: 종목 이름들
// '시장 흐름'보다 나은 종목 이유인가 — 나열·리포트·전망 글이 아니고 그날 방향을 말하는 기사(docs/app.js preferMarket의 반대, 32차 급등락 기록)
export function strongNews(it, pct, names = []) {
  return !!(it && it.title && !weakTitle(it.title) && newsDir(it, names) === Math.sign(Number(pct) || 0));
}
// 미국 종목의 '움직임 + 원인' 제목 — 티커 뒤에 오름·내림 말과 after/as/on/amid/following이 이어지면('Amazon (AMZN) and Meta (META) Soar After JPMorgan Hails…'·
// 'Nvidia Stock (NVDA) Rises 2.8% as Chip Stocks Rebound') 같은 방향 기사 안에서 먼저 쓴다(47차). 티커 앞의 말은 다른 회사 얘기일 수 있어 보지 않는다
// ('TSMC rises on report … for Nvidia'·'IREN stock plunges 18% as Microsoft …'). 국내 종목은 이름에 영문 티커가 없어 해당 없음
const MOVE_WHY_RE = /\b(?:soar(?:s|ed|ing)?|jump(?:s|ed|ing)?|surg(?:e|es|ed|ing)|ris(?:e|es|ing)|rose|rall(?:y|ies|ied|ying)|climb(?:s|ed|ing)?|gain(?:s|ed|ing)?|spik(?:e|es|ed|ing)|rebound(?:s|ed|ing)?|pop(?:s|ped|ping)?|fall(?:s|ing)?|fell|drop(?:s|ped|ping)?|slid(?:e|es|ing)?|sink(?:s|ing)?|sank|plung(?:e|es|ed|ing)|tumbl(?:e|es|ed|ing)|slump(?:s|ed|ing)?|declin(?:e|es|ed|ing)|slip(?:s|ped|ping)?)\b(?:[^.?!]|\.\d)*?\b(?:after|as|on|amid|following)\b/i;
const tickerAt = (t, n) => { const m = /^[A-Z][A-Z.\-]{0,9}$/.test(n || '') ? t.match(new RegExp('(?:^|[^A-Za-z])' + n.replace(/[.\-]/g, (c) => '\\' + c) + '(?:[^A-Za-z]|$)')) : null; return m ? m.index : -1; };
const moveWhy = (t, names) => (names || []).some((n) => { const i = tickerAt(t, n); return i >= 0 && MOVE_WHY_RE.test(t.slice(i)); });
export function pickReasonNews(items, pct, day, ymd, names = []) {
  const s = Math.sign(Number(pct) || 0);
  const dir = (it) => newsDir(it, names);
  const tier = (it) => (/\[특징주\]/.test(it.title) && s && dir(it) === s && Number.isFinite(it.pubMs) && ymd(it.pubMs) === day ? 0
    : weakTitle(it.title) ? 3 : s && dir(it) === s ? (moveWhy(it.title, names) ? 1 : 1.5) : 2);
  return (Array.isArray(items) ? items : []).filter((it) => it && it.title && !priceOnly(it.title) && !LISTING_RE.test(it.title) && !CSR_RE.test(it.title) && !(s && dir(it) === -s))
    .map((it, i) => [tier(it), i, it]).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0]?.[2] || null;
}

// days: 찾을 기간(일) — 호출부가 그 종목의 마지막 거래일 기준으로 준다(43차, 평일 장중 2일 · 주말엔 금요일 기사까지)
export async function getNews(item, days = 2) {
  const code = String(item.code).trim();
  const market = item.market || (isKRCode(code) ? 'KR' : 'US');
  const key = `news:${code}`;
  const cached = getCache(key, 180000);
  if (cached) return cached;
  try {
    // 당일 위주(최근 2일) 뉴스만. (급등락 종목의 "왜?"는 aiStockAnalysis가 종합 분석 — 여기선 헤드라인만)
    // 제목에 종목 이름·별칭·티커가 있는 기사만(관련도), 우선주는 보통주 이름으로 검색(그 회사 뉴스가 우선주도 움직임)
    const it = { ...item, code, market };
    const keys = newsKeys(it);
    const keep = (title) => isRelevantNews(title, it, keys);
    // 검색어 — 국내는 '이름 주가', 미국은 영문 이름(영문 별칭이 있으면 별칭)과 티커(한글 이름을 섞은 영어 검색은 기사가 거의 안 잡혔다 — 11/10 PLUG 0건·TSLA 2건).
    // 3건이 안 되면 넓혀서 한 번 더 — 국내는 '주가'를 뺀 이름과 별칭, 미국은 한글 이름과 티커(예전 검색어)
    const base = krBaseName(item.name || code, code), alias = NEWS_ALIAS[code] || [];
    const enName = alias.find((a) => /^[\x00-\x7f]+$/.test(a)) || enCoreName(item.en);
    const items = market === 'KR'
      ? await googleNews(`${base} 주가`, true, days, keep, keys, [base, ...alias.slice(0, 1)].join(' OR '))
      : await googleNews(`${enName || item.name || code} ${code} stock`, false, days, keep, keys, enName ? `${item.name || code} ${code} stock` : null);
    // 시세 안내 기사의 '상승·하락'은 가격 설명일 뿐 호재·악재가 아니다 — '시세' 표시로 바꾸고 호재·악재 집계에서 뺀다
    for (const it of items) if (priceOnly(it.title)) it.sentiment = { label: '시세', tone: 'neutral', score: 0, keywords: [] };
    let pos = 0, neg = 0;
    for (const it of items) { if (it.sentiment.tone === 'pos') pos++; else if (it.sentiment.tone === 'neg') neg++; }
    const summary = { label: pos > neg ? '호재 우세' : neg > pos ? '악재 우세' : '중립', tone: pos > neg ? 'pos' : neg > pos ? 'neg' : 'neutral', pos, neg, total: items.length };
    return setCache(key, { items, summary, ok: true });
  } catch (e) {
    return { items: [], summary: null, ok: false, error: String(e.message || e) };
  }
}

// ---------- 투자자별 순매매(수급) — 네이버 ----------
// 종목별 외국인/기관/개인 순매수 수량(최근 거래일). 한국 종목만. (해외 IP에서 막히면 null)
// 네이버는 장 마감 후 저녁(실측 20:30 회차쯤)에 그날 확정치를 올린다 → 장중엔 전 거래일 값(date로 구분, 화면·AI에 날짜 표시).
export async function getStockInvestors(item) {
  const code = String(item.code).trim();
  if (!isKRCode(code)) return null;
  try {
    const arr = await http(`https://m.stock.naver.com/api/stock/${code}/trend`, { as: 'json' });
    if (!Array.isArray(arr) || !arr.length) return null;
    const r = arr[0];
    return {
      date: r.bizdate || null,
      foreign: num(r.foreignerPureBuyQuant),
      institution: num(r.organPureBuyQuant),
      individual: num(r.individualPureBuyQuant),
      foreignRatio: r.foreignerHoldRatio || null,
    };
  } catch { return null; }
}

// 지수(코스피/코스닥) 투자자별 순매매(억원). symbol: 'KOSPI' | 'KOSDAQ'
export async function getIndexFlow(symbol) {
  try {
    const r = await http(`https://m.stock.naver.com/api/index/${symbol}/trend`, { as: 'json' });
    return { date: r.bizdate || null, personal: num(r.personalValue), foreign: num(r.foreignValue), institution: num(r.institutionalValue) };
  } catch { return null; }
}

// ---------- 무료 AI(Gemini) — 핵심 뉴스/종합 분석 판단 ----------
// GEMINI_API_KEY(저장소 Secret)가 있으면 AI가 핵심을 분석. 없거나 실패하면 null → 헤드라인 폴백.
// 무료 한도는 모델마다 따로이고 하루 수십 회뿐이라(실측), 주 모델과 대체 모델(GEMINI_FALLBACK_MODELS)을 함께 쓰고
// 하루 예산을 장 시간에 맞춰 나눠 쓴다(aibudget.mjs). 2.5는 기존 사용자에게만 열려 있어 막히면 대체 모델만 쓴다.
// 기본 모델은 모두 공식 가격표의 무료 등급("Free of charge", 2026-10-15 확인) Flash-Lite 계열:
//   gemini-2.5-flash-lite · gemini-3.5-flash-lite · gemini-3.1-flash-lite(가장 이른 종료 2027-05-07 — 종료되면 자동 제외)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 일시 오류 재시도 간격(밀리초, 시도마다 배수로 늘어남). 자체 테스트가 실제로 기다리지 않도록 바꿀 수 있게 객체로 둔다.
export const retryTiming = { baseMs: 1500 };
let GEMINI_KEY = '';
let GEMINI_MODELS = [];
// 한 회차 동안의 AI 상태. 키 오류면 모든 모델 공통이라 남은 호출을 바로 건너뛴다.
// skipped: 시간 배분상 아껴 두느라 부르지 않은 횟수(화면에 'AI 대기'로 표시)
const ai = { disabled: '', calls: 0, ok: 0, failures: 0, skipped: 0, lastModel: null };
// 이번 회차 예산(fetch.mjs가 status.json 기록을 이어받아 설정). 없으면 제한 없이 돌고 모델 사용 가능 여부만 추적한다.
let budget = null;
// 이번 회차에만 빼 둘 모델 — 분당 한도(재시도로도 안 풀린 429), 그리고 예산 없이 돌 때의 사용 불가·한도 소진
let runOut = {};

// 회차 시작 시 상태 초기화(설정 재로딩·캐시 비움). Action은 매 회차 새 프로세스라 영향이 없고,
// 한 프로세스에서 여러 번 실행하는 자체 테스트가 서로 섞이지 않게 해 준다.
export function resetState() {
  cache.clear();
  krSuffix.clear();
  GEMINI_KEY = process.env.GEMINI_API_KEY || '';
  const primary = (process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite').trim();
  const fallbacks = String(process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',');
  GEMINI_MODELS = [...new Set([primary, ...fallbacks].map((s) => s.trim()).filter(Boolean))];
  Object.assign(ai, { disabled: '', calls: 0, ok: 0, failures: 0, skipped: 0, lastModel: null });
  budget = null;
  runOut = {};
}
resetState();

export function setAiBudget(b) { budget = b; }
export const aiModels = () => [...GEMINI_MODELS];
// 그날(예산) + 이번 회차에 빠진 모델을 합쳐, 덜 쓴 모델부터 고른다. 남은 모델이 없으면 null.
const outNow = () => ({ ...(budget ? budget.out : {}), ...runOut });
const nextModel = () => pickModel({ used: budget ? budget.used : {}, out: outNow() }, GEMINI_MODELS);
// 사용 불가·일일 한도 소진은 그날 하루 뺀다(예산 기록에 남아 다음 회차도 건너뜀). 예산이 없으면 이번 회차만.
const markOut = (model, why) => { if (budget) budget.out[model] = why; else runOut[model] = why; };
// 지금 AI를 부를 수 있나 — 'go' | 'off'(키 없음·이번 회차 중지·쓸 모델 없음) | 'wait'(시간 배분상 보류). 예산이 없으면 제한 없음.
export function aiGate() {
  if (!GEMINI_KEY || ai.disabled || !nextModel()) return 'off';
  return !budget || allowance(budget, GEMINI_MODELS) > 0 ? 'go' : 'wait';
}
// 시간 배분상 이번엔 부르지 않았음을 기록(호출부가 aiGate로 직접 판단해 건너뛸 때 — 화면에 '순서 대기'로 보인다)
export function noteAiSkipped() { ai.skipped++; }
export function aiStatus() {
  return { enabled: !!GEMINI_KEY, model: ai.lastModel, disabled: ai.disabled, calls: ai.calls, ok: ai.ok, failures: ai.failures, skipped: ai.skipped };
}

// 모델 1개에 요청. 429·503·500·타임아웃은 백오프 재시도, 나머지는 원인을 분류해 돌려준다.
async function geminiCall(model, prompt, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      ai.calls++;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json();
        const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!txt) return { kind: 'empty' };
        try { return { kind: 'ok', json: JSON.parse(txt) }; } catch { return { kind: 'parse' }; }
      }
      const body = await res.text().catch(() => '');
      if (res.status === 404 || (res.status === 400 && /not found|not supported|no longer available|not available/i.test(body))) return { kind: 'model' };
      if (res.status === 401 || res.status === 403 || (res.status === 400 && /api[ _]?key|permission/i.test(body))) return { kind: 'auth' };
      // 한도가 아예 0("limit: 0") = 이 프로젝트의 무료 등급에서 쓸 수 없는 모델 — 사용 불가로 보고 그날 뺀다
      // (분당 한도로 오인해 회차마다 재시도를 되풀이하지 않게)
      if (res.status === 429 && /\blimit:\s*0\b/i.test(body)) return { kind: 'model' };
      // 일일 한도 소진(…PerDay…)은 기다려도 안 풀린다 — 재시도 없이 바로 알린다. 분당 한도(429)만 재시도.
      if (res.status === 429 && /per ?day|daily/i.test(body)) return { kind: 'quota' };
      if ((res.status === 429 || res.status === 503 || res.status === 500) && attempt < retries) { await sleep(retryTiming.baseMs * (attempt + 1)); continue; }
      return { kind: res.status === 429 ? 'rate' : 'http', status: res.status };
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries && e.name === 'AbortError') { await sleep(retryTiming.baseMs); continue; }
      console.error('    Gemini 실패:', e.message);
      return { kind: 'network' };
    }
  }
  return { kind: 'http' };
}

// 모델 고르기(예산·가용성) → 호출. 성공하면 { json, model }, 아니면 null(호출부가 기존 분석을 유지).
//  · 사용 불가·일일 한도 소진 → 그 모델은 그날 빼고, 같은 요청을 다른 모델로 다시 시도
//  · 분당 한도(재시도로도 안 풀린 429) → 그 모델은 이번 회차만 빼고 다른 모델로 다시 시도
//  · 시간 배분상 지금은 아껴 둘 차례 → 호출하지 않음 · 키 오류 → 이번 회차 AI 중지 · 일시 오류 → 이 요청만 실패
async function geminiJSON(prompt, { retries = 2 } = {}) {
  if (!GEMINI_KEY || ai.disabled) return null;
  for (;;) {
    const model = nextModel();
    if (!model) { // 쓸 모델이 하나도 없음 — 전부 '사용 불가'면 설정 문제, 아니면 한도 소진
      const outs = Object.values(outNow());
      ai.disabled = outs.length && outs.every((w) => w === 'unavailable') ? 'no-model' : 'quota';
      console.error(`    사용 가능한 Gemini 모델 없음(${ai.disabled}) — 이번 회차 AI 중지, 기존 분석 유지`);
      return null;
    }
    if (aiGate() === 'wait') { ai.skipped++; return null; }
    const r = await geminiCall(model, prompt, retries);
    if (r.kind === 'ok') {
      ai.ok++;
      ai.lastModel = model;
      if (budget) budget.used[model] = (budget.used[model] || 0) + 1;
      return { json: r.json, model };
    }
    if (r.kind === 'model') { console.warn(`    Gemini 모델 사용 불가(${model}) — 오늘은 다른 모델 사용`); markOut(model, 'unavailable'); continue; }
    if (r.kind === 'quota') { console.warn(`    Gemini 일일 한도 소진(${model}) — 오늘은 다른 모델 사용`); markOut(model, 'quota'); continue; }
    if (r.kind === 'rate') { console.warn(`    Gemini 분당 한도 초과(${model}) — 이번 회차는 다른 모델 사용`); runOut[model] = 'rate'; continue; }
    if (r.kind === 'auth') { ai.disabled = 'auth'; console.error('    Gemini 인증 오류 — 키 확인 필요, 이번 회차 AI 중지'); return null; }
    ai.failures++;
    if (r.kind !== 'network') console.error(`    Gemini 응답 오류(${r.status || r.kind})`);
    return null;
  }
}

// AI 입력의 기사 날짜 — 그 시장 현지 날짜 '[월/일] 제목'(30차). 발행 시각을 모르면 제목만
const ymdIn = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms).replace(/-/g, '');
const mdOf = (ymd) => `${+ymd.slice(4, 6)}/${+ymd.slice(6, 8)}`;
const datedTitle = (h, timeZone) => `${Number.isFinite(h && h.pubMs) ? `[${mdOf(ymdIn(h.pubMs, timeZone))}] ` : ''}${h.title}`;

// 헤드라인 목록을 주고 "오늘 가장 가치 있는 핵심 뉴스 1~3개 + 한 줄 요약"을 JSON으로 받는다.
// 이틀치 기사라 제목 앞에 기사 날짜(한국 날짜)를 붙인다 — 어제 기사를 오늘 원인으로 고르지 않게(30차)
export async function aiCoreNews(name, changePct, headlines, now = Date.now()) {
  if (!GEMINI_KEY || !headlines || !headlines.length) return null;
  const dir = changePct <= -1 ? '급락' : changePct >= 1 ? '급등' : '보합';
  const list = headlines.map((h, i) => `${i + 1}. ${datedTitle(h, 'Asia/Seoul')}${h.source ? ` (${h.source})` : ''}`).join('\n');
  const prompt =
    `너는 한국 증시 애널리스트다. 오늘(${mdOf(ymdIn(now, 'Asia/Seoul'))}) ${name}이(가) ${changePct.toFixed(2)}% ${dir}했다.\n` +
    `아래 뉴스 제목 중 오늘 이 움직임을 설명하는, 투자자에게 가장 가치 있고 핵심적인 것만 1~3개 골라라.\n` +
    `제목 앞 [월/일]은 기사 날짜다 — 오늘 기사를 먼저 보고, 지난 기사는 오늘까지 이어진 원인일 때만 고른다.\n` +
    `광고·홍보·중복·단순 시황중계·무관한 것은 제외하고, 실제 원인/재료가 되는 것만 고른다.\n` +
    `반드시 이 JSON만 출력: {"summary":"오늘 ${name} ${dir} 핵심 이유 한 문장(한국어, 45자 내외)","items":[{"index":뉴스번호,"why":"왜 핵심인지 한 줄(한국어)"}]}\n\n` +
    `뉴스 목록:\n${list}`;
  const r = await geminiJSON(prompt);
  const parsed = r?.json;
  if (!parsed || !Array.isArray(parsed.items)) return null;
  const items = parsed.items
    .map((it) => { const h = headlines[(parseInt(it.index, 10) || 0) - 1]; return h ? { title: h.title, source: h.source, time: h.time, link: h.link, why: String(it.why || '') } : null; })
    .filter(Boolean).slice(0, 3);
  if (!items.length) return null;
  return { summary: String(parsed.summary || ''), items, model: r.model };
}

// 보유 종목 ±이 임계치 이상 변동 시, 뉴스만이 아니라 수급·추세·시세를 종합해 "왜 오르내리는지" 분석.
export const STOCK_ANALYSIS_THRESHOLD = 2;

// 과거 일봉에서 기간별 등락·고점대비 위치를 뽑아 분석 입력으로 쓴다.
// 6개월 종가에 지금 가격을 끝값으로(44차, docs/app.js liveSeries와 같은 규칙) — 그날 봉이 있으면 바꾸고 없으면 덧붙임. 개장 전·첫 체결 전·날짜를 모르면 그대로
export function liveCloses(history, quote) {
  const c = history && Array.isArray(history.closes) ? history.closes : null;
  if (!c || !c.length) return c;
  const d = Array.isArray(history.dates) && history.dates.length === c.length ? history.dates : null;
  const at = +new Date(quote && quote.asOf);
  const kr = !!quote && (quote.market || (quote.currency === 'KRW' ? 'KR' : 'US')) === 'KR';
  const pending = kr && quote.marketStatus === 'OPEN' && !(quote.volume > 0) && !quote.halt;
  if (!quote || quote.ok === false || !(quote.price > 0) || !d || !Number.isFinite(at) || quote.marketStatus === 'PREOPEN' || pending) return c;
  const tz = kr ? 'Asia/Seoul' : 'America/New_York';
  const day = ymdIn(at, tz), lastDay = ymdIn(d[d.length - 1], tz);
  if (lastDay > day) return c;
  return [...c.slice(0, lastDay === day ? c.length - 1 : c.length), quote.price];
}
export function historyStats(history, quote = null) {
  const c = liveCloses(history, quote);
  if (!Array.isArray(c) || c.length < 2) return null;
  const last = c[c.length - 1];
  const ret = (n) => { const i = c.length - 1 - n; return i >= 0 && c[i] ? ((last - c[i]) / c[i]) * 100 : null; };
  const hi = Math.max(...c);
  return { w1: ret(5), m1: ret(21), m3: ret(63), fromHigh: hi ? ((last - hi) / hi) * 100 : null };
}

// 뉴스·수급·추세·시세를 모두 넘겨 Gemini가 "오늘 왜 이렇게 움직이는지"를 종합 분석. 키 없거나 실패 시 null.
export async function aiStockAnalysis({ quote, news, flow, history, disclosures, schedule, market = null, now = Date.now() }) {
  if (!GEMINI_KEY || !quote) return null;
  const name = quote.name || quote.code;
  const pct = quote.changePct ?? 0;
  const dir = pct < 0 ? '하락' : pct > 0 ? '상승' : '보합';
  // 미국 종목은 '미국 증시' 관점으로, 가격은 달러 소수 둘째 자리까지. 투자자별 수급은 국내 종목만 있다.
  const us = quote.market === 'US' || quote.currency === 'USD';
  const money = (v) => (v == null ? 'N/A' : us ? `$${Number(v).toFixed(2)}` : `${Math.round(v).toLocaleString('ko-KR')}원`);
  const p = (v) => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const n = (v) => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}`;
  const st = historyStats(history, quote); // 끝값은 지금 가격(44차 — 오늘 등락과 같은 기준)
  // 기사 날짜(그 시장 현지 날짜)와 등락이 난 거래일(시세 시각의 그 시장 날짜) — 거래일 전 기사를 그날 원인으로 오해하지 않게(30차)
  const tz = us ? 'America/New_York' : 'Asia/Seoul';
  const qt = Date.parse(quote.asOf);
  const tradeDay = ymdIn(Number.isFinite(qt) ? qt : now, tz);
  const heads = (news?.items || []).slice(0, 6).map((it, i) => `${i + 1}. ${datedTitle(it, tz)}`).join('\n') || '(수집된 뉴스 없음)';
  // 시장 흐름(30차) — 같은 시장 지수(호출부가 화면 '시장 대비'와 같은 규칙으로 고름)와 그날 시장 조치. 지수가 1% 넘게 움직인 날엔 시장 몫과 종목 몫을 나눠 보게 한다
  const mk = market && market.name && Number.isFinite(market.pct) ? market : null;
  const sgn = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  const mkLine = mk ? `${mk.name} ${sgn(mk.pct)}%${Array.isArray(mk.events) && mk.events.length ? ` (오늘 ${mk.events.join('·')})` : ''} — 이 종목은 시장 대비 ${sgn(pct - mk.pct)}%p` : '';
  const today = new Date(now + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''); // 한국 날짜 YYYYMMDD
  // 종목 수급은 장 마감 후 저녁에 그날 확정치가 나와 장중엔 전 거래일 값이다 — 오늘 움직임의 원인으로 오해하지 않게 날짜를 밝힌다
  const fd = /^\d{8}$/.test(String(flow?.date ?? '')) ? String(flow.date) : '';
  const flowWhen = !fd ? '최근 거래일' : fd === today ? '오늘' : `${+fd.slice(4, 6)}/${+fd.slice(6, 8)} 확정치 — 오늘 장중 수급 아님`;
  const flowLine = flow
    ? `외국인 ${n(flow.foreign)}주, 기관 ${n(flow.institution)}주, 개인 ${n(flow.individual)}주${flow.foreignRatio ? ` · 외국인지분 ${flow.foreignRatio}` : ''} (${flowWhen})`
    : '(수급 데이터 없음)';
  const histLine = st
    ? `1주 ${p(st.w1)} · 1개월 ${p(st.m1)} · 3개월 ${p(st.m3)} · 6개월 고점대비 ${p(st.fromHigh)}`
    : '(과거 시세 없음)';
  // 국내 종목 최근 공시(OpenDART 키가 있을 때만) — 오늘 접수분은 '오늘'로 적어 원인 후보로 먼저 보게 한다
  const discs = us ? [] : (disclosures?.items || []).slice(0, 5);
  const discLines = discs.map((d) => {
    const ds = String(d.date || '');
    return `- ${ds === today ? '오늘' : `${ds.slice(4, 6)}/${ds.slice(6, 8)}`} [${d.tag || '기타'}] ${d.title}`;
  }).join('\n');
  // 가까운 일정(공시 일정 달력 — 국내는 공시에 적힌 일정, 미국은 나스닥 실적·배당) — 그 시장 날짜 기준 '오늘'·'어제'·'내일', 그 밖은 날짜
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: us ? 'America/New_York' : 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).replace(/-/g, '');
  const dayNo = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 864e5;
  const rel = (d) => { const k = dayNo(d) - dayNo(localDay); return k === 0 ? '오늘' : k === -1 ? '어제' : k === 1 ? '내일' : `${+d.slice(4, 6)}/${+d.slice(6, 8)}`; };
  const sched = (Array.isArray(schedule) ? schedule : []).filter((e) => e && /^\d{8}$/.test(String(e.d)) && e.t).slice(0, 5);
  const schedLines = sched.map((e) => `- ${rel(e.d)}${e.tm ? ` ${e.tm}` : ''} ${e.t}${e.s ? ` — ${String(e.s).slice(0, 60)}` : ''}`).join('\n');
  const basis = `${mk ? '시장·' : ''}${us ? '뉴스·추세' : discs.length ? '뉴스·공시·수급·추세' : '뉴스·수급·추세'}`;
  const prompt =
    `너는 ${us ? '미국' : '한국'} 증시 애널리스트다(답은 한국어로). 아래 정보를 종합해 '${name}'이(가) 오늘 왜 ${dir}하는지 핵심 원인을 분석하라.\n` +
    `오늘 등락(${mdOf(tradeDay)} 거래일): ${pct.toFixed(2)}% · 현재가 ${money(quote.price)} (고가 ${money(quote.high)} / 저가 ${money(quote.low)})\n` +
    (mk ? `시장: ${mkLine}\n` : '') +
    `과거 흐름: ${histLine}\n` +
    (us ? '' : `수급(순매수): ${flowLine}\n`) +
    (discs.length ? `최근 공시(전자공시 2주, 최신순):\n${discLines}\n` : '') +
    (sched.length ? `가까운 일정(${us ? '나스닥' : '전자공시'} 기준 — 오늘 움직임과 이어질 때만 원인으로):\n${schedLines}\n` : '') +
    `최근 뉴스 제목(앞의 [월/일]은 기사 날짜 — 거래일 전 기사는 그날까지 이어진 재료일 때만 원인으로):\n${heads}\n\n` +
    `단순 시황 중계가 아니라 '원인'에 집중하라. ${basis}를 서로 연결해 설명하고, 근거가 약하면 단정하지 말 것.\n` +
    (mk && Math.abs(mk.pct) >= 1 ? `시장 전체가 크게 움직인 날이다 — 시장 흐름 탓인 몫과 이 종목만의 요인을 나눠, 시장보다 더(덜) 움직인 까닭을 짚어라.\n` : '') +
    `반드시 이 JSON만 출력:\n` +
    `{"headline":"오늘 왜 ${dir}하는지 한 문장 진단(한국어, 50자 내외)",` +
    `"summary":"종합 분석 2~3문장(한국어, ${basis.replace(/·/g, '+')}를 연결)",` +
    `"factors":["핵심 요인 2~4개, 각 25자 내외"],` +
    `"outlook":"단기 관전 포인트 한 줄(조심스럽게, 단정·투자권유 금지)"}`;
  const r = await geminiJSON(prompt);
  const parsed = r?.json;
  if (!parsed || !parsed.headline) return null;
  return {
    headline: String(parsed.headline).slice(0, 140),
    summary: String(parsed.summary || ''),
    factors: Array.isArray(parsed.factors) ? parsed.factors.map((x) => String(x)).filter(Boolean).slice(0, 4) : [],
    outlook: String(parsed.outlook || ''),
    model: r.model,
    ...(mk ? { mkt: mk.name } : {}), // 화면 면책 문구의 근거에 '시장'
  };
}

// 지수 급등락 "핵심 이유" — 구글뉴스 헤드라인 + (키 있으면) AI 핵심 판단. (전 세계 접근 가능)
// prev(직전 reason)의 AI 판단은 같은 방향(급락/급등/보합)일 때만 이어 쓴다 — 방향이 바뀌면 이유도 달라지므로.
// aiSig = 그 판단을 만들 때의 입력(등락 1% 구간 + 헤드라인). 지금 입력과 비교해:
//  · 같으면 재사용
//  · 헤드라인만 바뀌어도 INDEX_AI_MIN_INTERVAL_MS 안에는 재사용(헤드라인은 수시로 바뀌어 한도를 금방 소모)
//  · 국내 장 시간이 아니면(마감 후·주말) 등락 구간이 그대로인 한 재사용 — 한도는 장중인 시장에 양보
//  · 새로 부르다 실패·보류되면 이전 판단을 유지하고, aiAt(분석 시각)을 남겨 화면에 '몇 시 분석'으로 보여준다.
// 재사용은 이전에 AI가 '성공'했을 때만. 실패(null)까지 재사용하면 한도가 풀려도 다시 시도하지 않는다.
export const INDEX_AI_MIN_INTERVAL_MS = 90 * 60 * 1000;
// open: 국내 시장이 열려 있는지(기본은 시계 기준 장 시간 — 호출부가 시세의 '마감' 상태로 휴장일을 반영해 넘긴다)
export async function getIndexReason(name, changePct, prev = null, now = Date.now(), open = isKrSession(now)) {
  const dir = changePct <= -1 ? 'down' : changePct >= 1 ? 'up' : 'flat';
  const q = dir === 'down' ? `${name} 급락 이유` : dir === 'up' ? `${name} 급등 이유` : `${name} 증시 마감`;
  // (aiSig가 없던 이전 형식은 sig가 곧 판단 당시 입력)
  const keep = prev && prev.dir === dir && prev.ai
    ? { ai: prev.ai, aiAt: prev.aiAt ?? null, aiSig: prev.aiSig ?? prev.sig ?? null }
    : { ai: null, aiAt: null, aiSig: null };
  try {
    const items = await googleNews(q, true, 2);
    const sig = `${Math.round(changePct ?? 0)}|${items.slice(0, 4).map((i) => i.title).join('|')}`;
    let { ai, aiAt, aiSig } = keep;
    const recent = ai && aiAt != null && now - aiAt >= 0 && now - aiAt < INDEX_AI_MIN_INTERVAL_MS;
    const settled = !open && sigMove(aiSig) === sigMove(sig); // 장 밖(휴장 포함) + 등락 그대로 → 뉴스만 바뀜
    if (!ai || (aiSig !== sig && !recent && !settled)) {
      const fresh = await aiCoreNews(name, changePct, items, now);
      if (fresh) { ai = fresh; aiAt = now; aiSig = sig; }
    }
    return { dir, query: q, headlines: items.slice(0, 4), ai, aiAt, aiSig };
  } catch { return { dir, query: q, headlines: [], ...keep }; }
}
