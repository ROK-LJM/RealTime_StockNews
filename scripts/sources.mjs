// cloud/lib/sources.js
// 클라우드(서버리스)용 데이터 계층 — 전 세계 어디서나 동작하도록 야후 파이낸스 + 구글뉴스만 사용.
// 한국 종목은 야후의 .KS(코스피)/.KQ(코스닥) 심볼로 조회한다. 외부 의존성 없음.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------- 캐시 (서버리스 인스턴스 재사용 시 유효) ----------
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

export async function getQuote(item) {
  const code = String(item.code).trim();
  const market = item.market || (isKRCode(code) ? 'KR' : 'US');
  const key = `q:${code}`;
  const cached = getCache(key, 8000);
  if (cached) return item.name ? { ...cached, name: item.name } : cached;
  try {
    const symbol = market === 'KR' && isKRCode(code) ? await resolveKR(code) : code;
    const m = await yahoo(symbol);
    const q = { code, market, ...normalize(symbol, m, item.name), ok: true };
    setCache(key, q);
    return item.name ? { ...q, name: item.name } : q;
  } catch (e) {
    return { code, market, name: item.name || code, ok: false, error: String(e.message || e) };
  }
}

export async function getQuotes(items) { return Promise.all(items.map(getQuote)); }

// ---------- 지수 + 분위기 ----------
export async function getMarket() {
  const cached = getCache('market', 8000);
  if (cached) return cached;
  const defs = [
    ['^KS11', '코스피', 'KRW'], ['^KQ11', '코스닥', 'KRW'],
    ['^GSPC', 'S&P 500', 'USD'], ['^IXIC', '나스닥', 'USD'], ['^VIX', 'VIX', 'USD'],
  ];
  const settled = await Promise.all(defs.map(async ([sym, name, cur]) => {
    try { const m = await yahoo(sym); const n = normalize(sym, m, name); return { name, symbol: sym, currency: cur, price: n.price, change: n.change, changePct: n.changePct, marketStatus: n.marketStatus }; }
    catch { return null; }
  }));
  const indices = settled.filter(Boolean);
  const vix = indices.find((i) => i.symbol === '^VIX');
  const mood = computeMood(indices.filter((i) => i.symbol !== '^VIX'), vix?.price);
  return setCache('market', { indices, vix: vix || null, mood });
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

async function googleNews(query, ko) {
  const hl = ko ? 'ko' : 'en-US', gl = ko ? 'KR' : 'US', ceid = ko ? 'KR:ko' : 'US:en';
  const xml = await http(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`, { as: 'text' });
  const items = [];
  for (const b of xml.split('<item>').slice(1, 7)) {
    const pick = (tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : ''; };
    let title = pick('title');
    let source = pick('source');
    if (!source) { const idx = title.lastIndexOf(' - '); if (idx > 0) source = title.slice(idx + 3); }
    for (let i = 0; i < 3 && source && title.endsWith(source); i++) title = title.slice(0, -source.length).replace(/[\s\-–—|]+$/, '');
    const pub = pick('pubDate');
    items.push({ title, source, time: pub ? new Date(pub).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '', link: pick('link'), sentiment: tagSentiment(title) });
  }
  return items;
}

export async function getNews(item) {
  const code = String(item.code).trim();
  const market = item.market || (isKRCode(code) ? 'KR' : 'US');
  const key = `news:${code}`;
  const cached = getCache(key, 180000);
  if (cached) return cached;
  try {
    const items = market === 'KR'
      ? await googleNews(`${item.name || code} 주가`, true)
      : await googleNews(`${item.name || code} ${code} stock`, false);
    let pos = 0, neg = 0;
    for (const it of items) { if (it.sentiment.tone === 'pos') pos++; else if (it.sentiment.tone === 'neg') neg++; }
    const summary = { label: pos > neg ? '호재 우세' : neg > pos ? '악재 우세' : '중립', tone: pos > neg ? 'pos' : neg > pos ? 'neg' : 'neutral', pos, neg, total: items.length };
    return setCache(key, { items, summary, ok: true });
  } catch (e) {
    return { items: [], summary: null, ok: false, error: String(e.message || e) };
  }
}
