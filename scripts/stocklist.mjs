// pages/scripts/stocklist.mjs — '종목 편집' 검색용 전체 종목 목록(국내·미국) → docs/data/stocklist.json
// 워크플로 stocklist.yml이 하루 한 번 실행. 목록이 실제로 바뀔 때만 파일을 쓴다(불필요한 커밋 방지).
//
// 소스 — 모두 무료·키 불필요(일부 비공식, 개인 용도):
//  · 국내: 네이버 증권 시가총액 목록(코스피·코스닥) → 실패하면 KRX KIND 상장법인 목록
//  · 미국: 나스닥 트레이더 종목 디렉터리(나스닥·NYSE 등, 영문명) + 네이버 해외주식 목록(한글명, 실패해도 무방)
// 검색 순위: 네이버 목록의 시가총액으로 매긴다('삼성' → 삼성전자 먼저). 순위를 모르는 종목(KIND·상위 목록 밖)은 뒤로.
// 예외 처리: 소스별로 격리. 결과가 너무 적으면(차단·형식 변경 의심) 그 시장은 기존 목록을 유지한다.
//
// `node scripts/stocklist.mjs`로 실행하면 바로 1회 갱신. 자체 테스트는 build()를 가져다 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KR_RE = /^\d{6}$/;
const US_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/; // util.mjs의 watchlist 검증과 같은 규칙
const MAX_PAGES = 40;                    // 페이지 목록 소스의 안전 상한(100개 × 40쪽)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { as = 'text', timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (as === 'json') return await res.json();
    if (as === 'bytes') return new Uint8Array(await res.arrayBuffer());
    return await res.text();
  } finally { clearTimeout(timer); }
}

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
const HANGUL = /[가-힣]/;

// 시가총액 문자열("3,343,123") → 숫자. 없거나 이상하면 null
const capOf = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

// ---------- 국내 ----------
// 네이버 증권 시가총액 목록 — 시장별로 100개씩 넘겨 받는다. 시가총액(cap)·목록 순서(pos)는 검색 순위용.
async function krNaver(market) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await get(`https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=100`, { as: 'json' });
    const list = Array.isArray(j?.stocks) ? j.stocks : [];
    for (const s of list) {
      const code = clean(s.itemCode ?? s.reutersCode);
      const name = clean(s.stockName ?? s.itemName).slice(0, 40);
      if (KR_RE.test(code) && name) out.push({ code, name, market, cap: capOf(s.marketValue), pos: out.length });
    }
    if (list.length < 100) break;
    await sleep(120); // 과호출 방지
  }
  return out;
}

// KRX KIND 상장법인 목록(HTML 표, EUC-KR). 열 순서가 바뀌어도 되도록 '첫 칸 = 회사명, 6자리 숫자 칸 = 종목코드'로 읽는다.
function decodeKr(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
  const declared = /charset=["']?\s*utf-?8/i.test(head) ? 'utf-8' : 'euc-kr';
  return new TextDecoder(declared).decode(bytes);
}
const stripTags = (s) => clean(String(s).replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
export function parseKind(html, market) {
  const out = [];
  for (const row of String(html).split(/<tr[\s>]/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (cells.length < 2) continue;
    const code = cells.find((c) => KR_RE.test(c));
    const name = cells[0].slice(0, 40);
    if (code && name && !KR_RE.test(name)) out.push([code, name, market]);
  }
  return out;
}
async function krKind(market) { // 시가총액 정보가 없어 검색 순위는 매기지 않는다
  const type = market === 'KOSPI' ? 'stockMkt' : 'kosdaqMkt';
  const bytes = await get(`https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13&marketType=${type}`, { as: 'bytes' });
  return parseKind(decodeKr(bytes), market).map(([code, name]) => ({ code, name, market, cap: null, pos: null }));
}

// ---------- 미국 ----------
// 나스닥 트레이더 종목 디렉터리(파이프 구분 텍스트). 시험 종목·워런트·유닛·권리·우선주는 뺀다.
const EXCHANGE = { N: 'NYSE', A: 'NYSE American', P: 'NYSE Arca', Z: 'Cboe', V: 'IEX' };
const SKIP_NAME = /\b(warrants?|units?|rights?|subordinated|notes? due|perpetual)\b|\bpreferred (stock|shares?)\b/i;
function cleanUsName(raw) {
  let s = clean(raw);
  const [company, detail = ''] = s.split(' - ');
  const cls = /\bClass ([A-Z])\b/i.exec(detail || company);
  s = clean(company.replace(/\b(Common Stock|Ordinary Shares|Common Shares|Class [A-Z] (Common Stock|Ordinary Shares))\b.*$/i, ''));
  if (cls && !new RegExp(`Class ${cls[1]}\\b`, 'i').test(s)) s += ` Class ${cls[1].toUpperCase()}`;
  return s.slice(0, 60);
}
export function parseNasdaqDir(text, kind) {
  const lines = String(text).split(/\r?\n/).filter((l) => l && !l.startsWith('File Creation Time'));
  if (!lines.length) return [];
  const head = lines[0].split('|');
  const col = (n) => head.indexOf(n);
  const iSym = kind === 'nasdaq' ? col('Symbol') : col('ACT Symbol');
  const iName = col('Security Name'), iTest = col('Test Issue'), iEtf = col('ETF'), iEx = col('Exchange');
  if (iSym < 0 || iName < 0) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const f = line.split('|');
    if (f[iTest] === 'Y') continue;
    const rawSym = clean(f[iSym]);
    if (!rawSym || /[$^+=#*]/.test(rawSym)) continue;          // 우선주·특수 표기
    const sym = rawSym.replace(/\./g, '-');                      // BRK.B → BRK-B (야후 표기)
    if (!US_RE.test(sym)) continue;
    const name = f[iName] || '';
    const etf = f[iEtf] === 'Y';
    if (!etf && SKIP_NAME.test(name)) continue;
    const ex = kind === 'nasdaq' ? 'NASDAQ' : (EXCHANGE[f[iEx]] || 'US');
    out.push([sym, '', cleanUsName(name), etf ? `${ex} ETF` : ex]);
  }
  return out;
}
async function usDirectory() {
  const [nas, other] = await Promise.all([
    get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt'),
    get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'),
  ]);
  return [...parseNasdaqDir(nas, 'nasdaq'), ...parseNasdaqDir(other, 'other')];
}

// 네이버 해외주식 시가총액 목록(거래소별 상위 1,500) — 한글 종목명(엔비디아 등)과 검색 순위용 시가총액.
// 실패해도 영문명·기본 별칭으로 검색되고 순위만 빠진다.
async function usNaverList(exchange, pages = 15) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const j = await get(`https://api.stock.naver.com/stock/exchange/${exchange}/marketValue?page=${page}&pageSize=100`, { as: 'json' });
    const list = Array.isArray(j?.stocks) ? j.stocks : [];
    for (const s of list) {
      const sym = clean(s.symbolCode).toUpperCase().replace(/\./g, '-');
      const ko = clean(s.stockName).slice(0, 40);
      if (sym) out.push({ sym, ko: HANGUL.test(ko) ? ko : '', cap: capOf(s.marketValue), pos: out.length, ex: exchange });
    }
    if (list.length < 100) break;
    await sleep(120);
  }
  return out;
}

// 검색 순위 — 시가총액이 있는 것은 큰 순서, 없는 것은 그 뒤에 목록 순서(같은 순번이면 앞 시장 먼저). 1부터.
const MARKET_ORDER = { KOSPI: 0, KOSDAQ: 1, NASDAQ: 0, NYSE: 1, AMEX: 2 };
function rankEntries(list) {
  const ranked = list.filter((e) => e.pos != null);
  ranked.sort((a, b) => (b.cap ?? -1) - (a.cap ?? -1) || a.pos - b.pos || (MARKET_ORDER[a.market ?? a.ex] ?? 9) - (MARKET_ORDER[b.market ?? b.ex] ?? 9));
  ranked.forEach((e, i) => { e.rank = i + 1; });
  return ranked.filter((e) => e.cap != null).length; // 시가총액으로 매긴 개수(점검용)
}

// 자주 찾는 미국 종목·ETF의 한글 이름 — 네이버 목록을 못 받아도 한글로 검색되게 하는 최소 별칭
export const KO_ALIAS = {
  AAPL: '애플', MSFT: '마이크로소프트', NVDA: '엔비디아', AMZN: '아마존닷컴', GOOGL: '알파벳 A(구글)', GOOG: '알파벳 C(구글)',
  META: '메타 플랫폼스', TSLA: '테슬라', AVGO: '브로드컴', AMD: 'AMD', INTC: '인텔', QCOM: '퀄컴', TSM: 'TSMC', ASML: 'ASML',
  MU: '마이크론 테크놀로지', PLTR: '팔란티어', NFLX: '넷플릭스', ORCL: '오라클', CRM: '세일즈포스', ADBE: '어도비', CSCO: '시스코',
  IBM: 'IBM', UBER: '우버', ABNB: '에어비앤비', COIN: '코인베이스', PYPL: '페이팔', SHOP: '쇼피파이', SPOT: '스포티파이',
  DIS: '디즈니', NKE: '나이키', SBUX: '스타벅스', MCD: '맥도날드', KO: '코카콜라', PEP: '펩시코', WMT: '월마트', COST: '코스트코',
  V: '비자', MA: '마스터카드', JPM: 'JP모건 체이스', BAC: '뱅크오브아메리카', GS: '골드만삭스', 'BRK-B': '버크셔 해서웨이 B',
  JNJ: '존슨앤드존슨', LLY: '일라이 릴리', NVO: '노보 노디스크', PFE: '화이자', MRNA: '모더나', UNH: '유나이티드헬스',
  BA: '보잉', LMT: '록히드 마틴', XOM: '엑슨모빌', CVX: '셰브론', CPNG: '쿠팡', RIVN: '리비안', LCID: '루시드', NIO: '니오',
  BABA: '알리바바', PDD: '핀둬둬', ARM: 'ARM 홀딩스', SMCI: '슈퍼마이크로컴퓨터', IONQ: '아이온큐', RBLX: '로블록스',
  SNOW: '스노우플레이크', CRWD: '크라우드스트라이크', PANW: '팔로알토 네트웍스', NOW: '서비스나우', PLUG: '플러그파워',
  ENPH: '엔페이즈 에너지', FSLR: '퍼스트 솔라', SOFI: '소파이', HOOD: '로빈후드', DELL: '델 테크놀로지스', TXN: '텍사스 인스트루먼트',
  AMAT: '어플라이드 머티어리얼즈', LRCX: '램리서치', KLAC: 'KLA', MRVL: '마벨 테크놀로지', ON: '온 세미컨덕터', ADI: '아날로그디바이스',
  T: 'AT&T', VZ: '버라이즌', TMUS: 'T모바일', SPY: 'SPDR S&P500 ETF', QQQ: '인베스코 QQQ', TQQQ: '프로셰어즈 울트라프로 QQQ(3배)',
  SQQQ: '프로셰어즈 울트라프로 숏 QQQ', SOXL: '디렉시온 반도체 3배', SOXX: '아이셰어즈 반도체 ETF', SCHD: '슈왑 미국 배당주 ETF',
  VOO: '뱅가드 S&P500 ETF', VTI: '뱅가드 토탈 스톡마켓 ETF', IVV: '아이셰어즈 코어 S&P500 ETF', DIA: 'SPDR 다우존스 ETF',
  IWM: '아이셰어즈 러셀2000 ETF', ARKK: 'ARK 이노베이션 ETF', TLT: '아이셰어즈 미국채 20년+ ETF', GLD: 'SPDR 금 ETF',
  JEPI: 'JP모건 프리미엄 인컴 ETF', JEPQ: 'JP모건 나스닥 프리미엄 인컴 ETF',
};

// ---------- 조립 ----------
// 같은 코드는 한 번만, 정렬은 코드순(내용이 같으면 파일도 같도록)
function uniqSorted(list) {
  const seen = new Map();
  for (const row of list) if (!seen.has(row[0])) seen.set(row[0], row);
  return [...seen.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function tryAll(steps) { // 앞에서부터 시도, 처음 성공(비어 있지 않음)한 결과와 소스 이름
  for (const [name, fn] of steps) {
    try { const r = await fn(); if (r.length) return { name, rows: r }; console.warn(`  ! ${name}: 결과 없음`); }
    catch (e) { console.warn(`  ! ${name} 실패:`, e.message); }
  }
  return { name: null, rows: [] };
}

// 파일 형식: v2 = 행 끝에 검색 순위(시가총액 순, 1부터. 순위를 모르면 생략)
//  kr: [code, name, market, rank?] · us: [ticker, 한글명, 영문명, 거래소, rank?]
const FORMAT = 2;
const RANK_REFRESH_MS = 7 * 86400e3; // 순위만 바뀐 경우엔 이 간격으로만 다시 쓴다(시가총액 순서는 날마다 조금씩 바뀌므로)

// 1회 생성. minKr/minUs: 이보다 적으면 그 시장은 기존 목록 유지(차단·형식 변경으로 일부만 받은 결과로 덮지 않게)
export async function build({ root = ROOT, dataDir = path.join(root, 'docs', 'data'), now = Date.now(), minKr = 1500, minUs = 3000 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'stocklist.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const prevKr = Array.isArray(prev?.kr) ? prev.kr : [], prevUs = Array.isArray(prev?.us) ? prev.us : [];
  const src = {};

  // 국내: 시장별로 네이버 → KIND 순서로 시도. 순위는 두 시장을 합쳐 시가총액 순으로.
  const krAll = [];
  for (const market of ['KOSPI', 'KOSDAQ']) {
    const r = await tryAll([[`naver-${market}`, () => krNaver(market)], [`kind-${market}`, () => krKind(market)]]);
    src[market] = r.name ? `${r.name}:${r.rows.length}` : 'fail';
    krAll.push(...r.rows);
  }
  src.krCap = rankEntries(krAll);
  let kr = uniqSorted(krAll.map((e) => (e.rank ? [e.code, e.name, e.market, e.rank] : [e.code, e.name, e.market])));
  if (kr.length < minKr) { console.warn(`  ! 국내 ${kr.length}개 — 너무 적어 기존 목록(${prevKr.length}개) 유지`); kr = prevKr; src.krKept = true; }

  // 미국: 디렉터리 + 네이버 목록(한글명·순위)
  let us = [];
  try { us = await usDirectory(); src.US = `nasdaqtrader:${us.length}`; }
  catch (e) { console.warn('  ! 미국 종목 디렉터리 실패:', e.message); src.US = 'fail'; }
  us = uniqSorted(us);
  if (us.length < minUs) { console.warn(`  ! 미국 ${us.length}개 — 너무 적어 기존 목록(${prevUs.length}개) 유지`); us = prevUs; src.usKept = true; }
  else {
    const naver = [];
    for (const ex of ['NASDAQ', 'NYSE', 'AMEX']) {
      try { naver.push(...await usNaverList(ex)); }
      catch (e) { console.warn(`  ! 네이버 해외 목록(${ex}) 실패:`, e.message); }
    }
    src.usCap = rankEntries(naver);
    const info = new Map();
    for (const e of naver) if (!info.has(e.sym)) info.set(e.sym, e);
    // 한글명은 한 번 얻으면 유지 — 상위 목록 경계를 오가며 이름이 생겼다 사라졌다 하는 것 방지
    const prevKo = new Map(prevUs.filter((r) => Array.isArray(r) && r[1]).map((r) => [r[0], r[1]]));
    us = us.map(([sym, , en, ex]) => {
      const n = info.get(sym);
      const ko = n?.ko || prevKo.get(sym) || KO_ALIAS[sym] || '';
      return n?.rank ? [sym, ko, en, ex, n.rank] : [sym, ko, en, ex];
    });
    src.usKo = us.filter((r) => r[1]).length;
  }

  console.log(`[stocklist] 국내 ${kr.length} · 미국 ${us.length} — ${JSON.stringify(src)}`);
  if (!kr.length && !us.length) { console.warn('  ✗ 목록을 만들지 못함 — 파일 유지'); return { written: false, kr: 0, us: 0, src }; }

  // 목록 내용(종목·이름)이나 소스 상태가 바뀌었을 때만 쓴다. 순위만 바뀐 건 RANK_REFRESH_MS마다 반영(잦은 큰 커밋 방지).
  const rows = (list, n) => (Array.isArray(list) ? list.map((r) => (Array.isArray(r) ? r.slice(0, n) : r)) : []);
  const state = (s = {}) => [s.KOSPI, s.KOSDAQ, s.US, !!s.krKept, !!s.usKept];
  const sig = (o) => JSON.stringify([o?.v, rows(o?.kr, 3), rows(o?.us, 4), state(o?.meta?.src)]);
  const updated = new Date(now).toISOString().slice(0, 10);
  const next = { v: FORMAT, kr, us, meta: { updated, src } };
  const age = now - Date.parse(prev?.meta?.updated ?? '');
  if (prev && sig(prev) === sig(next) && age < RANK_REFRESH_MS) { console.log('  · 변경 없음'); return { written: false, kr: kr.length, us: us.length, src }; }
  writeJsonAtomic(file, next);
  console.log('  ✓ data/stocklist.json 갱신');
  return { written: true, kr: kr.length, us: us.length, src };
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  build().catch((e) => { console.error('[stocklist] 치명적 오류(기존 목록 유지):', e); process.exitCode = 0; });
}
