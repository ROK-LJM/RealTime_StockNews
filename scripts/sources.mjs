// pages/scripts/sources.mjs
// 데이터 계층 — 국내 시세·수급은 네이버(실패 시 야후 .KS/.KQ), 해외 시세·과거 일봉·환율은 야후, 뉴스는 구글뉴스 RSS,
// 핵심 판단·종합분석은 Gemini 무료 API. 모두 키 없이(Gemini만 Secret 키) 쓰는 무료 소스이며 외부 의존성 없음.

import { mapLimit, sigMove } from './util.mjs';
import { allowance, pickModel, isKrSession } from './aibudget.mjs';

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
    volume: num(d.accumulatedTradingVolume),
    marketStatus: d.marketStatus || null,
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
export async function getMarket() {
  const cached = getCache('market', 8000);
  if (cached) return cached;
  // 한국 지수: 네이버 실시간 우선(야후 폴백) / 미국 지수·VIX: 야후
  const krDefs = [['KOSPI', '^KS11', '코스피'], ['KOSDAQ', '^KQ11', '코스닥']];
  const usDefs = [['^GSPC', 'S&P 500'], ['^IXIC', '나스닥'], ['^VIX', 'VIX']];
  const krIdx = await Promise.all(krDefs.map(async ([naverSym, ySym, name]) => {
    try { return { name, symbol: ySym, currency: 'KRW', ...(await krIndexNaver(naverSym)) }; }
    catch {
      try { const n = normalize(ySym, await yahoo(ySym), name); return { name, symbol: ySym, currency: 'KRW', price: n.price, change: n.change, changePct: n.changePct, marketStatus: n.marketStatus }; }
      catch { return null; }
    }
  }));
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

function computeMood(indices, vix) {
  let score = 50;
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
const NEG = ['급락', '폭락', '하락', '약세', '적자', '손실', '소송', '리콜', '제재', '규제', '감산', '하향', '매도', '우려', '경고', '부진', '쇼크', '미달', '결함', '파업', '횡령', '조사', '벌금', '연기', '취소', '철회', '구조조정', '감자', '디폴트', '하한가',
  'downgrade', 'lawsuit', 'miss', 'plunge', 'fall', 'falls', 'drop', 'cut', 'cuts', 'warning', 'recall', 'probe', 'decline', 'loss', 'weak', 'slump', 'sink', 'tumble', 'bearish', 'selloff'];
const POS = ['급등', '폭등', '상승', '강세', '흑자', '호실적', '수주', '계약', '신고가', '인수', '합병', '자사주', '배당', '상향', '매수', '돌파', '신제품', '승인', '호재', '사상최대', '최대실적', '확대', '성장', '상한가', '훈풍',
  'surge', 'jump', 'soar', 'beat', 'beats', 'upgrade', 'record', 'deal', 'approval', 'approved', 'contract', 'buyback', 'rally', 'gain', 'gains', 'strong', 'bullish', 'rise', 'rises', 'tops'];

// 영문 키워드는 단어 경계로 매칭(예: "mission"이 "miss"로 오탐되지 않도록), 한글은 부분일치
function kwHit(raw, low, w) {
  if (/^[\x00-\x7f]+$/.test(w)) return new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low);
  return raw.includes(w);
}

export function tagSentiment(text) {
  const raw = String(text || '');
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

// recentDays>0 이면 최근 N일 뉴스만(구글 when: 연산자 + pubDate 필터), 최신순 정렬.
async function googleNews(query, ko, recentDays = 0) {
  const hl = ko ? 'ko' : 'en-US', gl = ko ? 'KR' : 'US', ceid = ko ? 'KR:ko' : 'US:en';
  const q = recentDays > 0 ? `${query} when:${recentDays}d` : query;
  const xml = await http(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`, { as: 'text' });
  const items = [];
  for (const b of xml.split('<item>').slice(1, 13)) {
    const pick = (tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : ''; };
    let title = pick('title');
    let source = pick('source');
    if (!source) { const idx = title.lastIndexOf(' - '); if (idx > 0) source = title.slice(idx + 3); }
    for (let i = 0; i < 3 && source && title.endsWith(source); i++) title = title.slice(0, -source.length).replace(/[\s\-–—|]+$/, '');
    const pub = pick('pubDate');
    const pubMs = pub ? Date.parse(pub) : null;
    items.push({ title, source, time: pub ? new Date(pub).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '', pubMs, link: pick('link'), sentiment: tagSentiment(title) });
  }
  let out = items;
  if (recentDays > 0) {
    const cutoff = Date.now() - recentDays * 86400000;
    out = items.filter((it) => it.pubMs == null || it.pubMs >= cutoff);
  }
  out.sort((a, b) => (b.pubMs || 0) - (a.pubMs || 0));
  return out.slice(0, 8);
}

export async function getNews(item) {
  const code = String(item.code).trim();
  const market = item.market || (isKRCode(code) ? 'KR' : 'US');
  const key = `news:${code}`;
  const cached = getCache(key, 180000);
  if (cached) return cached;
  try {
    // 당일 위주(최근 2일) 뉴스만. (급등락 종목의 "왜?"는 aiStockAnalysis가 종합 분석 — 여기선 헤드라인만)
    const items = market === 'KR'
      ? await googleNews(`${item.name || code} 주가`, true, 2)
      : await googleNews(`${item.name || code} ${code} stock`, false, 2);
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

// 헤드라인 목록을 주고 "오늘 가장 가치 있는 핵심 뉴스 1~3개 + 한 줄 요약"을 JSON으로 받는다.
export async function aiCoreNews(name, changePct, headlines) {
  if (!GEMINI_KEY || !headlines || !headlines.length) return null;
  const dir = changePct <= -1 ? '급락' : changePct >= 1 ? '급등' : '보합';
  const list = headlines.map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source})` : ''}`).join('\n');
  const prompt =
    `너는 한국 증시 애널리스트다. 오늘 ${name}이(가) ${changePct.toFixed(2)}% ${dir}했다.\n` +
    `아래 뉴스 제목 중 오늘 이 움직임을 설명하는, 투자자에게 가장 가치 있고 핵심적인 것만 1~3개 골라라.\n` +
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
function historyStats(history) {
  const c = history && history.closes;
  if (!Array.isArray(c) || c.length < 2) return null;
  const last = c[c.length - 1];
  const ret = (n) => { const i = c.length - 1 - n; return i >= 0 && c[i] ? ((last - c[i]) / c[i]) * 100 : null; };
  const hi = Math.max(...c);
  return { w1: ret(5), m1: ret(21), m3: ret(63), fromHigh: hi ? ((last - hi) / hi) * 100 : null };
}

// 뉴스·수급·추세·시세를 모두 넘겨 Gemini가 "오늘 왜 이렇게 움직이는지"를 종합 분석. 키 없거나 실패 시 null.
export async function aiStockAnalysis({ quote, news, flow, history, disclosures, now = Date.now() }) {
  if (!GEMINI_KEY || !quote) return null;
  const name = quote.name || quote.code;
  const pct = quote.changePct ?? 0;
  const dir = pct < 0 ? '하락' : pct > 0 ? '상승' : '보합';
  // 미국 종목은 '미국 증시' 관점으로, 가격은 달러 소수 둘째 자리까지. 투자자별 수급은 국내 종목만 있다.
  const us = quote.market === 'US' || quote.currency === 'USD';
  const money = (v) => (v == null ? 'N/A' : us ? `$${Number(v).toFixed(2)}` : `${Math.round(v).toLocaleString('ko-KR')}원`);
  const p = (v) => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const n = (v) => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}`;
  const st = historyStats(history);
  const heads = (news?.items || []).slice(0, 6).map((it, i) => `${i + 1}. ${it.title}`).join('\n') || '(수집된 뉴스 없음)';
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
  const basis = us ? '뉴스·추세' : discs.length ? '뉴스·공시·수급·추세' : '뉴스·수급·추세';
  const prompt =
    `너는 ${us ? '미국' : '한국'} 증시 애널리스트다(답은 한국어로). 아래 정보를 종합해 '${name}'이(가) 오늘 왜 ${dir}하는지 핵심 원인을 분석하라.\n` +
    `오늘 등락: ${pct.toFixed(2)}% · 현재가 ${money(quote.price)} (고가 ${money(quote.high)} / 저가 ${money(quote.low)})\n` +
    `과거 흐름: ${histLine}\n` +
    (us ? '' : `수급(순매수): ${flowLine}\n`) +
    (discs.length ? `최근 공시(전자공시 2주, 최신순):\n${discLines}\n` : '') +
    `최근 뉴스 제목:\n${heads}\n\n` +
    `단순 시황 중계가 아니라 '원인'에 집중하라. ${basis}를 서로 연결해 설명하고, 근거가 약하면 단정하지 말 것.\n` +
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
      const fresh = await aiCoreNews(name, changePct, items);
      if (fresh) { ai = fresh; aiAt = now; aiSig = sig; }
    }
    return { dir, query: q, headlines: items.slice(0, 4), ai, aiAt, aiSig };
  } catch { return { dir, query: q, headlines: [], ...keep }; }
}
