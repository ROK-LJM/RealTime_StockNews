// pages/scripts/dart.mjs — 국내 종목 최근 공시(OpenDART, 금융감독원 전자공시) — 무료 인증키(DART_API_KEY)가 있을 때만
//
// · 인증키는 깃허브 Secret(DART_API_KEY)으로만 받는다. 요청 주소에 키가 들어가므로 오류 메시지·로그에 주소를 남기지 않는다.
// · 공시 검색은 회사 고유번호(8자리)로 한다 → 고유번호 목록(corpCode.xml, ZIP)을 받아 '종목코드→고유번호' 표를
//   docs/data/dartcorp.json에 둔다(상장사 전체 약 3,900개). 7일마다, 또는 표에 없는 새 국내 종목이 생겼을 때만 다시 받는다.
//   받다가 실패하면 6시간 뒤에 다시 시도한다(5분마다 큰 파일을 반복 요청하지 않게).
// · 종목마다 최근 2주 공시를 최대 10건 받아 철회된 것은 빼고 최근 5건을 남긴다. 제목으로 종류(실적·계약·증자…)를 붙인다.
// · 키 오류·하루 한도 초과·점검이면 그 회차의 나머지 요청을 멈춘다(화면은 직전 값 유지, 이유는 status.json에).
// · 하루 요청 한도는 2만 건 — 국내 20종목을 15분마다 받아도 하루 2천 건 정도다.
// · 공시 일정 달력(calendar.mjs)도 여기의 목록·본문 받기를 쓴다(3시간마다 · 본문은 공시마다 한 번).
import zlib from 'node:zlib';

const API = 'https://opendart.fss.or.kr/api';
export const CORP_REFRESH_MS = 7 * 86400e3; // 고유번호 표 정기 갱신(새 상장사 반영)
export const CORP_RETRY_MS = 6 * 3600e3;    // 표 받기 실패·새 종목 재확인 최소 간격
export const CORP_FIRST_RETRY_MS = 30 * 60e3; // 아직 표가 한 번도 없을 때(키 처음 등록·키 오류 수정 직후)는 30분 뒤 재시도
const LOOKBACK_DAYS = 14;
const KEEP = 5;
const MIN_LISTED = 1000; // 고유번호 표가 이보다 적으면 잘못 받은 것으로 보고 쓰지 않는다(실제 약 3,900개)
// 이 상태 코드면 그 회차의 나머지 요청을 멈춘다(키·IP 문제, 하루 한도 초과, 점검)
const FATAL = {
  '010': '등록되지 않은 인증키', '011': '사용할 수 없는 인증키', '012': '허용되지 않은 접속 IP',
  '020': '하루 요청 한도 초과', '800': '시스템 점검 중', '901': '인증키 보유기간 만료',
};

const dartKey = () => String(process.env.DART_API_KEY || '').trim();
export const dartEnabled = () => !!dartKey();

let halted = null; // 이번 회차에서 멈춘 이유
export function resetDart() { halted = null; }
export const dartHalted = () => halted;

class DartError extends Error {
  constructor(status, message) { super(`${FATAL[status] || message || '오류'}(${status})`); this.status = status; }
}
function noteFatal(e) { if (e?.status && FATAL[e.status] && !halted) halted = e.message; }

// 키가 들어간 주소로 요청 — 실패해도 주소가 메시지에 섞이지 않게 원인만 남긴다
async function get(name, params, timeout = 10000) {
  const qs = new URLSearchParams({ crtfc_key: dartKey(), ...params });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    let res;
    try { res = await fetch(`${API}/${name}?${qs}`, { signal: ctrl.signal }); }
    catch (e) { throw new Error(e?.name === 'AbortError' ? '응답 시간 초과' : '접속 실패'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
}

// 오류 응답(XML 또는 JSON)의 상태 코드·메시지
function errorOf(buf) {
  const s = buf.toString('utf8', 0, Math.min(buf.length, 4000));
  const status = s.match(/<status>\s*(\d{3})\s*<\/status>/)?.[1] ?? s.match(/"status"\s*:\s*"(\d{3})"/)?.[1];
  const message = s.match(/<message>([^<]*)<\/message>/)?.[1] ?? s.match(/"message"\s*:\s*"([^"]*)"/)?.[1] ?? '';
  return status ? new DartError(status, message.trim()) : new Error('알 수 없는 응답');
}

// 원본 바이트 → { text, enc } — XML 선언은 없거나 실제와 다를 수 있어 바이트로 판단한다(공시 원본은 EUC-KR인 것이 있다).
// BOM이 있으면 UTF-16 · UTF-8로 깨짐 없이 읽히면 UTF-8 · 아니면 EUC-KR(CP949)과 UTF-8 중 한글이 제대로 많이 나오는 쪽
const hangulScore = (t) => {
  let n = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) n++;          // 한글 음절
    else if (c === 0xfffd) n -= 2;                // 깨진 글자
    else if (c >= 0x4e00 && c <= 0x9fff) n--;     // 한자 — 다른 인코딩으로 잘못 읽으면 한자가 쏟아진다
  }
  return n;
};
export function decodeBytes(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b), enc: 'utf16le' };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b), enc: 'utf16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), enc: 'utf8' }; } catch { /* UTF-8이 아님 — 아래에서 고른다 */ }
  const u = b.toString('utf8'), k = new TextDecoder('euc-kr').decode(b);
  return hangulScore(k) >= hangulScore(u) ? { text: k, enc: 'euckr' } : { text: u, enc: 'utf8(깨짐)' };
}

// ZIP 항목 [{ name, size, read() }] — 중앙 디렉터리 기준으로 읽어 로컬 헤더에 크기가 비어 있는 형식(데이터 설명자)도 처리
export function unzipEntries(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 형식이 아님');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 끝 정보 없음');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 목록 손상');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), full = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    out.push({ name, size: full, read: () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 항목 손상');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`지원하지 않는 압축 방식(${method})`);
    } });
  }
  return out;
}

// 본문 XML 고르기 — '{접수번호}.xml'이 있으면 그것, 없으면 첨부('…_00760.xml'처럼 번호가 붙은 감사보고서 등)가 아닌 것 중 가장 큰 것
export function pickXml(entries, no = '') {
  const xs = entries.filter((e) => /\.xml$/i.test(e.name));
  if (!xs.length) throw new Error('ZIP 안에 XML 없음');
  const file = (e) => e.name.split('/').pop().toLowerCase();
  const main = no ? xs.find((e) => file(e) === `${no}.xml`) : null;
  if (main) return main;
  const own = xs.filter((e) => !/_\d+\.xml$/.test(file(e)));
  return (own.length ? own : xs).reduce((a, b) => (b.size > a.size ? b : a));
}

// ZIP 안의 본문 XML 글자(고유번호 목록·공시 원본)
export function unzipXml(buf, no = '') {
  return decodeBytes(pickXml(unzipEntries(buf), no).read()).text;
}

// 고유번호 XML → { 종목코드: 고유번호 } — 상장사만(비상장사는 종목코드가 빈칸)
export function parseCorpXml(xml) {
  const map = {};
  for (const m of String(xml).matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const corp = m[1].match(/<corp_code>\s*(\d{8})\s*<\/corp_code>/)?.[1];
    const stock = m[1].match(/<stock_code>\s*([0-9A-Z]{6})\s*<\/stock_code>/)?.[1];
    if (corp && stock) map[stock] = corp;
  }
  return map;
}

// 종목코드 → 고유번호. 우선주(끝자리 5·7·9)는 같은 회사(보통주 코드 끝자리 0)의 공시를 쓴다 — 005935 → 005930
export function corpOf(map, code) {
  const c = String(code ?? '').trim();
  if (map[c]) return map[c];
  return /^\d{5}[579]$/.test(c) ? map[c.slice(0, 5) + '0'] || null : null;
}

// 고유번호 표 준비. prev = 직전 dartcorp.json, codes = 지금 국내 종목 코드. 반환 { table, changed, error }
//  · 표가 없거나 7일 지났거나, 표에도 '없음' 목록에도 없는 새 종목이 있으면 다시 받는다 — 직전 시도 6시간(표가 아직 없으면 30분) 안이면 미룬다.
//  · '없음'(none) = 마지막으로 받을 때 표에 없던 종목(ETF 등 공시 대상이 아닌 것) — 매번 다시 받지 않게 기억한다.
export async function ensureCorpTable(prev, codes, now) {
  const ok = prev && typeof prev === 'object' && prev.map && typeof prev.map === 'object' && !Array.isArray(prev.map);
  const table = {
    v: 1,
    at: ok && Number.isFinite(prev.at) ? prev.at : null,
    tried: ok && Number.isFinite(prev.tried) ? prev.tried : null,
    map: ok ? prev.map : {},
    none: ok && Array.isArray(prev.none) ? prev.none.filter((c) => typeof c === 'string') : [],
  };
  const unknown = codes.filter((c) => !corpOf(table.map, c) && !table.none.includes(c));
  const due = !table.at || now - table.at > CORP_REFRESH_MS || unknown.length > 0;
  const retry = table.at ? CORP_RETRY_MS : CORP_FIRST_RETRY_MS;
  if (!due || (table.tried && now - table.tried >= 0 && now - table.tried < retry)) return { table, changed: false, error: null };
  table.tried = now;
  try {
    const buf = await get('corpCode.xml', {}, 30000);
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw errorOf(buf);
    const map = parseCorpXml(unzipXml(buf));
    const n = Object.keys(map).length;
    if (n < MIN_LISTED) throw new Error(`고유번호 목록이 너무 적음(${n}개)`);
    Object.assign(table, { at: now, map, none: codes.filter((c) => !corpOf(map, c)) });
    return { table, changed: true, error: null };
  } catch (e) {
    noteFatal(e);
    return { table, changed: true, error: e.message }; // 시도 시각(tried)만 바뀐 표를 남겨 6시간 동안 재요청하지 않는다
  }
}

// 공시 종류 — 제목으로 판단(앞에서부터 처음 맞는 것). key: 주가에 영향이 큰 종류(화면에서 강조, AI 입력에서 표시)
const TAGS = [
  ['위험', /횡령|배임|상장폐지|상장적격성|관리종목|불성실공시|거래정지|회생절차|파산|부도|감사의견|감자결정|소송등의제기|영업정지/],
  ['해명', /조회공시|풍문|해명/],
  ['예고', /공시예고/], // 결산실적공시예고 = 발표 날짜 안내일 뿐 실적이 아님
  ['실적', /실적|매출액또는손익구조/],
  ['계약', /공급계약|수주/],
  ['증자·사채', /증자결정|사채권발행결정|전환사채|신주인수권부사채|교환사채|증권신고서|전환청구권행사|신주인수권행사|교환청구권행사/],
  ['자사주', /자기주식|주식소각/],
  ['배당', /배당/],
  ['M&A', /합병|분할|양수|양도|타법인주식및출자증권|최대주주변경|공개매수/],
  ['정기보고', /사업보고서|반기보고서|분기보고서/],
  ['지분', /소유상황보고서|대량보유|특정증권등|소유주식변동/],
  ['IR', /기업설명회|\(IR\)/],
  ['주요사항', /주요경영사항|주요사항보고서/],
];
const KEY_TAGS = new Set(['위험', '해명', '실적', '계약', '증자·사채', '자사주', '배당', 'M&A', '주요사항']);
export function tagOf(title) {
  for (const [tag, re] of TAGS) if (re.test(title)) return tag;
  return '기타';
}

// 한국 날짜 YYYYMMDD (한국은 서머타임이 없어 고정 +9시간)
export const kstYmd = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

// 공시 목록 한 번 받기 → [{ title, date, no }] — 철회된 공시 제외, 기간 안에 없으면 []. 키·한도 오류는 회차를 멈춘다
async function fetchList(params) {
  let j;
  try { j = JSON.parse((await get('list.json', params)).toString('utf8')); }
  catch (e) { throw e instanceof SyntaxError ? new Error('응답 형식 오류') : e; }
  const status = String(j?.status ?? '');
  if (status === '013') return []; // 기간 안에 공시 없음
  if (status !== '000') { const err = new DartError(status, String(j?.message ?? '')); noteFatal(err); throw err; }
  return (Array.isArray(j.list) ? j.list : [])
    .filter((x) => x && /^\d{14}$/.test(String(x.rcept_no)) && !String(x.rm ?? '').includes('철')) // 철회된 공시 제외
    .map((x) => {
      const title = String(x.report_nm ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const no = String(x.rcept_no);
      return { title, date: /^\d{8}$/.test(String(x.rcept_dt)) ? String(x.rcept_dt) : no.slice(0, 8), no };
    })
    .filter((x) => x.title);
}

// 한 종목의 최근 공시 → { ok: true, items: [{ title, date, no, tag, key? }] }
// 국내 종목이 아니거나 고유번호가 없으면(ETF 등) null — 이번 회차가 멈췄어도 null(직전 값 유지)
export async function getDisclosures(item, map, now) {
  if (halted || !dartEnabled() || item?.market !== 'KR') return null;
  const corp = corpOf(map || {}, item.code);
  if (!corp) return null;
  const params = { corp_code: corp, bgn_de: kstYmd(now - LOOKBACK_DAYS * 86400e3), end_de: kstYmd(now), last_reprt_at: 'Y', page_count: '10' };
  const items = (await fetchList(params))
    .map((x) => { const tag = tagOf(x.title); return KEY_TAGS.has(tag) ? { ...x, tag, key: true } : { ...x, tag }; })
    .sort((a, b) => (a.no < b.no ? 1 : a.no > b.no ? -1 : 0)) // 접수번호 = 날짜+순번 → 최신 먼저
    .slice(0, KEEP);
  return { ok: true, items };
}

// 공시 일정 달력용 — 한 회사의 기간 안 공시 목록(공시 유형 type: I 거래소·B 주요사항·A 정기 …, 최대 100건). 멈췄으면 null
export async function listFilings(corp, bgn, end, type) {
  if (halted || !dartEnabled()) return null;
  return fetchList({ corp_code: corp, bgn_de: bgn, end_de: end, last_reprt_at: 'Y', page_count: '100', ...(type ? { pblntf_ty: type } : {}) });
}

// 공시서류원본(ZIP) — 일정 날짜를 뽑는 데 쓴다 → { xml: 본문 글자, files: [[이름, 크기]], pick: 고른 파일, enc: 글자 인코딩 }
// 멈췄으면 null · 원문이 없으면(013·014) 상태 코드(status)가 붙은 오류
export async function getDocument(no) {
  if (halted || !dartEnabled()) return null;
  try {
    const buf = await get('document.xml', { rcept_no: no }, 15000);
    if (!(buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50)) throw errorOf(buf); // ZIP이 아니면 오류 응답(파일 없음 등)
    const entries = unzipEntries(buf), pick = pickXml(entries, no);
    const { text, enc } = decodeBytes(pick.read());
    return { xml: text, files: entries.map((e) => [e.name, e.size]), pick: pick.name, enc };
  } catch (e) { noteFatal(e); throw e; }
}
