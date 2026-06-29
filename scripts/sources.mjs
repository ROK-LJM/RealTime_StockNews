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

export async function getQuotes(items) { return Promise.all(items.map(getQuote)); }

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

export async function getNews(item, changePct = 0) {
  const code = String(item.code).trim();
  const market = item.market || (isKRCode(code) ? 'KR' : 'US');
  const key = `news:${code}`;
  const cached = getCache(key, 180000);
  if (cached) return cached;
  try {
    // 당일 위주(최근 2일) 뉴스만
    const items = market === 'KR'
      ? await googleNews(`${item.name || code} 주가`, true, 2)
      : await googleNews(`${item.name || code} ${code} stock`, false, 2);
    let pos = 0, neg = 0;
    for (const it of items) { if (it.sentiment.tone === 'pos') pos++; else if (it.sentiment.tone === 'neg') neg++; }
    const summary = { label: pos > neg ? '호재 우세' : neg > pos ? '악재 우세' : '중립', tone: pos > neg ? 'pos' : neg > pos ? 'neg' : 'neutral', pos, neg, total: items.length };
    // 급락/급등 종목(±임계치 이상)이면 Gemini로 당일 핵심 뉴스만 선별·요약
    const ai = Math.abs(changePct) >= STOCK_AI_THRESHOLD ? await aiCoreNews(item.name || code, changePct, items) : null;
    return setCache(key, { items, summary, ai, ok: true });
  } catch (e) {
    return { items: [], summary: null, ai: null, ok: false, error: String(e.message || e) };
  }
}

// ---------- 투자자별 순매매(수급) — 네이버 ----------
// 종목별 외국인/기관/개인 순매수 수량(최근 거래일). 한국 종목만. (해외 IP에서 막히면 null)
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

// ---------- 무료 AI(Gemini) — 당일 핵심 뉴스 판단 ----------
// GEMINI_API_KEY(저장소 Secret)가 있으면 AI가 가치 있는 핵심 뉴스를 골라 요약. 없거나 실패하면 null → 헤드라인 폴백.
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const STOCK_AI_THRESHOLD = 3; // 보유종목 ±3% 이상 변동(급락/급등) 시 Gemini로 핵심뉴스 판단

async function geminiJSON(prompt) {
  if (!GEMINI_KEY) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });
    if (!res.ok) throw new Error('Gemini HTTP ' + res.status);
    const j = await res.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    return txt ? JSON.parse(txt) : null;
  } catch (e) { console.error('    Gemini 실패:', e.message); return null; }
  finally { clearTimeout(timer); }
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
  const parsed = await geminiJSON(prompt);
  if (!parsed || !Array.isArray(parsed.items)) return null;
  const items = parsed.items
    .map((it) => { const h = headlines[(parseInt(it.index, 10) || 0) - 1]; return h ? { title: h.title, source: h.source, time: h.time, link: h.link, why: String(it.why || '') } : null; })
    .filter(Boolean).slice(0, 3);
  if (!items.length) return null;
  return { summary: String(parsed.summary || ''), items, model: GEMINI_MODEL };
}

// 지수 급등락 "핵심 이유" — 구글뉴스 헤드라인 + (키 있으면) AI 핵심 판단. (전 세계 접근 가능)
export async function getIndexReason(name, changePct) {
  const dir = changePct <= -1 ? 'down' : changePct >= 1 ? 'up' : 'flat';
  const q = dir === 'down' ? `${name} 급락 이유` : dir === 'up' ? `${name} 급등 이유` : `${name} 증시 마감`;
  try {
    const items = await googleNews(q, true, 2);
    const ai = await aiCoreNews(name, changePct, items);
    return { dir, query: q, headlines: items.slice(0, 4), ai };
  } catch { return { dir, query: q, headlines: [], ai: null }; }
}
