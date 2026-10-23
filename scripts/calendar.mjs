// pages/scripts/calendar.mjs — 공시 일정 달력(docs/data/calendar.json) — 내 종목의 앞으로의 일정과 지난 공시
//
// · 국내(OpenDART — 인증키 DART_API_KEY가 있을 때): 회사마다 최근 90일 공시 목록(거래소·주요사항·정기 공시 — 수가 많은 지분 공시는 뺌)을 받아
//   ① 공시한 날에 그 공시를 두고 ② 일정이 적힌 공시는 본문(공시서류원본, ZIP 속 XML)에서 날짜를 뽑아 그날에 일정을 둔다.
//   결산실적공시 예고 → 실적 발표 예정일 · 기업설명회(IR) → 일시 · 기준일 설정 → 기준일(사유로 배당·주총 구분) ·
//   배당 결정 → 배당 기준일·지급일 · 주총 소집 → 주총일·의결권 기준일 · 주식 소각·자기주식 취득/처분 → 기간·소각일 ·
//   유·무상증자 → 배정 기준일·신주 상장일 · 분할·병합·감자 → 신주 상장일.
//   본문 형식(실측 2026-10 공시 원문): '3. 결산실적 공시예정일 | 2026-10-29', '1. 일시 및 장소 | 일시 | 2026-10-29 | 15:45',
//   '1. 기준일 | 2026-10-29', '2. 일시 | 2026-12-11 | 09 : 00', '5. 소각을 위한 자기주식 취득 예정기간 | 시작일 | 2026-10-23' 다음 줄 '종료일 | 2027-01-22'.
//   정정 공시는 앞에 '정정전 | 정정후' 표가 붙으므로 같은 항목이 여러 번이면 마지막(고친 본문)을 쓴다.
//   본문은 접수번호마다 한 번만 받아 결과를 기억한다(공시는 바뀌지 않는다. 고치면 새 접수번호).
// · 미국(나스닥 공개 자료 — 키 없음): 다음 실적 발표일(장 시작 전·마감 후, '*'가 붙으면 예상일)과 배당(배당락·지급일)
// · 3시간마다(종목이 바뀌면 바로) 다시 만든다. 받기에 실패한 종목은 직전 일정을 그대로 쓴다.
import { dartEnabled, dartHalted, corpOf, tagOf, kstYmd, listFilings, getDocumentXml } from './dart.mjs';
import { mapLimit } from './util.mjs';

export const CAL_REFRESH_MS = 3 * 3600e3;
const BACK_DAYS = 90;       // 지난 공시·일정
const AHEAD_DAYS = 400;     // 앞으로의 일정(자사주 매입 기간 끝 등)
const DOCS_PER_RUN = 40;    // 한 번에 새로 받는 본문 수 — 나머지는 다음 갱신 때
const TYPES = ['I', 'B', 'A']; // 공시 유형: 거래소 · 주요사항보고 · 정기(사업·분기보고서)
// 본문에서 일정을 찾는 공시(제목)
export const SCHEDULE_RE = /결산실적공시\s*예고|기업설명회|\(IR\)|주주명부폐쇄|기준일\s*설정|배당\s*결정|주주총회\s*소집|주식\s*소각\s*결정|자기주식\s*(?:취득|처분)\s*결정|증자\s*결정|주식\s*(?:분할|병합)\s*결정|감자\s*결정/;
const EARN_FILED_RE = /영업\(잠정\)실적|매출액또는손익구조/; // 실적 공시 — 그날이 곧 발표일
const KIND_ORDER = { earn: 0, ir: 1, meet: 2, div: 3, rec: 4, cap: 5, disc: 6 };
const cut = (s, n = 80) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const ymd = (y, m, d) => (y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}` : null);
const dot = (d) => `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;

// ---------- 국내 공시 본문 ----------
// 본문(XML·HTML) → 표의 줄·칸 [['1. 기준일', '2026-10-29'], …] — 줄은 표의 줄(과 표 앞뒤)로만 나눈다(칸 안의 문단은 한 칸)
export function docRows(xml) {
  const s = String(xml ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/TR\s*>|<\/?TABLE\b[^>]*>/gi, '\n')
    .replace(/<\/(?:TD|TH|TE|TU)\s*>/gi, '\t')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/gi, '&');
  return s.split('\n').map((r) => r.split('\t').map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean)).filter((r) => r.length);
}
// '2026-10-29' · '2026.10.29' · '2026/10/29' · '2026년 10월 29일' → '20261029'
export function dateIn(s) {
  const m = String(s ?? '').match(/(20\d{2})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})(?!\d)/);
  return m ? ymd(+m[1], +m[2], +m[3]) : null;
}
// '15:45' · '09 : 00' · '오후 3시 30분' → '15:45'
export function timeIn(s) {
  const t = String(s ?? '');
  let m = t.match(/(?:^|[^\d])([01]?\d|2[0-3])\s*:\s*([0-5]\d)(?!\d)/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  m = t.match(/(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (!m) return null;
  let h = +m[2];
  if (m[1] === '오후' && h < 12) h += 12;
  if (m[1] === '오전' && h === 12) h = 0;
  return h <= 23 && +(m[3] || 0) < 60 ? `${String(h).padStart(2, '0')}:${String(+(m[3] || 0)).padStart(2, '0')}` : null;
}
// 항목 이름 칸 — 짧은 칸만(설명 문장 속 '상기 공시예정일에…' 같은 낱말은 이름이 아니다)
const isLabel = (c, re) => c.length <= 40 && re.test(c);
// 이름(re)이 있는 마지막 줄에서 그 뒤 칸의 날짜(·시각) → { d, tm, r } · 이름은 있는데 날짜가 없으면('-') d: null
function labeled(rows, re, { time = false } = {}) {
  for (let r = rows.length - 1; r >= 0; r--) {
    const row = rows[r];
    const i = row.findIndex((c) => isLabel(c, re));
    if (i < 0) continue;
    for (let j = i; j < row.length; j++) {
      const cell = j === i ? row[i].replace(re, '') : row[j];
      const d = dateIn(cell);
      if (!d) continue;
      const rest = cell.slice(cell.search(/20\d{2}/) + 10);
      return { d, tm: time ? timeIn(rest) || timeIn(row[j + 1] || '') : null, r };
    }
    return { d: null, r };
  }
  return null;
}
// 이름(re) 뒤 칸들의 글 — '개최목적 | 2026년 3분기 경영실적 발표'
function textOf(rows, re) {
  for (let r = rows.length - 1; r >= 0; r--) {
    const i = rows[r].findIndex((c) => isLabel(c, re));
    if (i >= 0) return rows[r].slice(i + 1).filter((c) => c !== '-').join(' ').trim();
  }
  return '';
}
// 기간(시작일·종료일) — 이름 있는 줄의 날짜가 시작, 같은 줄이나 바로 다음 줄의 '종료일'이 끝
function periodOf(rows, re) {
  const a = labeled(rows, re);
  if (!a || !a.d) return null;
  const same = rows[a.r].slice(rows[a.r].findIndex((c) => isLabel(c, re)) + 1).map(dateIn).filter(Boolean);
  let end = same[1] || null;
  if (!end && rows[a.r + 1] && /종료/.test(rows[a.r + 1][0])) end = rows[a.r + 1].map(dateIn).find(Boolean) || null;
  return { start: a.d, end };
}

// 공시 제목 + 본문 → 일정 [{ d, tm?, k, t, s? }]
//   k: earn 실적 · ir 기업설명회 · meet 주총 · div 배당 · rec 권리 기준일 · cap 자사주·증자·분할
export function parseDocEvents(title, xmlOrRows) {
  const rows = Array.isArray(xmlOrRows) ? xmlOrRows : docRows(xmlOrRows);
  const T = String(title ?? '');
  const out = [];
  const add = (hit, k, t, s = '') => {
    if (hit && hit.d) out.push({ d: hit.d, ...(hit.tm ? { tm: hit.tm } : {}), k, t, ...(s ? { s: cut(s) } : {}) });
  };
  const period = (re, name) => {
    const p = periodOf(rows, re);
    if (!p) return;
    add({ d: p.start }, 'cap', `${name} 시작`, p.end ? `${dot(p.start)} ~ ${dot(p.end)}` : '');
    if (p.end) add({ d: p.end }, 'cap', `${name} 끝`, `${dot(p.start)} ~ ${dot(p.end)}`);
  };
  if (/결산실적공시\s*예고/.test(T)) {
    const end = labeled(rows, /^종료일$/)?.d;
    const q = end ? { '03': '1분기', '06': '2분기', '09': '3분기', '12': '4분기' }[end.slice(4, 6)] || '' : '';
    add(labeled(rows, /공시\s*예정\s*일/), 'earn', `${q ? `${q} ` : ''}실적 발표 예정`, '결산실적 공시 예정일');
  } else if (/기업설명회|\(IR\)/.test(T)) {
    const s = [textOf(rows, /개최\s*목적/), textOf(rows, /개최\s*방법/)].filter(Boolean).join(' · ');
    add(labeled(rows, /^(?:\d+\.\s*)?(?:개최\s*)?일\s*시(?:\s*및\s*장소)?$/, { time: true }), 'ir', '기업설명회(IR)', s);
  } else if (/주주명부폐쇄|기준일\s*설정/.test(T)) {
    const why = textOf(rows, /설정\s*사유/);
    const k = /배당/.test(why) ? 'div' : /주주총회|주총/.test(why) ? 'meet' : 'rec';
    add(labeled(rows, /^(?:\d+\.\s*)?기준일$/), k, k === 'div' ? '배당 기준일' : k === 'meet' ? '주총 기준일' : '권리 기준일', why);
  } else if (/배당\s*결정/.test(T)) {
    const per = textOf(rows, /1주당\s*배당금/).match(/\d[\d,]*(?:\.\d+)?/)?.[0];
    const s = per ? `주당 ${per}원` : '';
    add(labeled(rows, /배당\s*기준일/), 'div', '배당 기준일', s);
    add(labeled(rows, /지급\s*예정\s*일/), 'div', '배당 지급', s);
  } else if (/주주총회\s*소집/.test(T)) {
    const kind = textOf(rows, /^(?:\d+\.\s*)?구분$/).match(/임시|정기/)?.[0] || (/임시/.test(T) ? '임시' : '정기');
    add(labeled(rows, /^(?:\d+\.\s*)?(?:개최\s*)?일\s*시$/, { time: true }), 'meet', `${kind}주주총회`, textOf(rows, /^(?:\d+\.\s*)?장\s*소$/));
    add(labeled(rows, /의결권\s*행사\s*기준일/), 'meet', '주총 기준일', `${kind}주주총회 의결권 기준`);
  } else if (/주식\s*소각\s*결정/.test(T)) {
    period(/취득\s*예(?:정|상)\s*기간/, '자사주 매입');
    add(labeled(rows, /소각\s*예정\s*일/), 'cap', '주식 소각');
  } else if (/자기주식\s*취득\s*결정/.test(T)) {
    period(/취득\s*예(?:정|상)\s*기간/, '자사주 매입');
  } else if (/자기주식\s*처분\s*결정/.test(T)) {
    period(/처분\s*예(?:정|상)\s*기간/, '자사주 처분');
  } else if (/증자\s*결정/.test(T)) {
    const what = `${T.match(/유무상|유상|무상/)?.[0] || ''}증자`;
    add(labeled(rows, /신주\s*배정\s*기준일/), 'cap', `${what} 배정 기준일`);
    add(labeled(rows, /상장\s*예정\s*일/), 'cap', `${what} 신주 상장`);
  } else if (/주식\s*(?:분할|병합)\s*결정|감자\s*결정/.test(T)) {
    const what = T.match(/분할|병합|감자/)[0];
    add(labeled(rows, /상장\s*예정\s*일/), 'cap', `${what} 신주 상장`);
  }
  return out;
}

// ---------- 미국(나스닥 공개 자료) ----------
const NASDAQ = 'https://api.nasdaq.com/api';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function nasdaq(path, timeout = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(`${NASDAQ}/${path}`, { signal: ctrl.signal, headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } });
    } catch (e) { throw new Error(e?.name === 'AbortError' ? '응답 시간 초과' : '접속 실패'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const usDate = (s) => { const m = String(s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/); return m ? ymd(+m[3], +m[1], +m[2]) : null; };
// 실적 발표일 — reportText '…expected* to report earnings on 11/02/2026 after market close.' · announcement '…: Nov 02, 2026'
export function parseNasdaqEarnings(j) {
  const a = String(j?.data?.announcement ?? ''), r = String(j?.data?.reportText ?? '');
  let d = null;
  const m1 = r.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/);
  if (m1) d = ymd(+m1[3], +m1[1], +m1[2]);
  else {
    const m2 = a.match(/\b([A-Z][a-z]{2})\s+(\d{1,2}),\s*(20\d{2})/);
    if (m2 && MON[m2[1]]) d = ymd(+m2[3], MON[m2[1]], +m2[2]);
  }
  if (!d) return null;
  return { d, when: /after market close/i.test(r) ? 'amc' : /before market open/i.test(r) ? 'bmo' : '', est: /\*/.test(a + r) };
}
// 배당 — rows [{ exOrEffDate, amount, recordDate, paymentDate }] → 배당락·지급일
export function parseNasdaqDividends(j) {
  const rows = j?.data?.dividends?.rows;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const amt = /^\$?\d/.test(String(row?.amount ?? '').trim()) ? `주당 $${String(row.amount).trim().replace(/^\$/, '')}` : '';
    const ex = usDate(row?.exOrEffDate), pay = usDate(row?.paymentDate);
    if (ex) out.push({ d: ex, k: 'div', t: '배당락', ...(amt ? { s: amt } : {}) });
    if (pay) out.push({ d: pay, k: 'div', t: '배당 지급', ...(amt ? { s: amt } : {}) });
  }
  return out;
}

// ---------- 달력 만들기 ----------
const sameCodes = (prev, items) => Array.isArray(prev?.codes) && prev.codes.join(',') === items.map((it) => it.code).sort().join(',');
// 다시 만들 때인가 — 없거나 3시간 지났거나 종목이 바뀜
export function calendarDue(prev, items, now) {
  return !prev || !Number.isFinite(prev.at) || now - prev.at >= CAL_REFRESH_MS || now < prev.at || !sameCodes(prev, items);
}

// items: 추적 종목, corpMap: 종목코드→고유번호(없으면 국내 생략), prev: 직전 calendar.json
export async function buildCalendar({ items, corpMap = null, prev = null, now }) {
  const today = kstYmd(now);
  const from = kstYmd(now - BACK_DAYS * 86400e3), until = kstYmd(now + AHEAD_DAYS * 86400e3);
  const inRange = (d) => d >= from && d <= until;
  const prevEvents = Array.isArray(prev?.events) ? prev.events : [];
  const keepPrev = (code) => prevEvents.filter((e) => e && e.c === code && inRange(e.d));
  const docs = {};
  for (const [no, evs] of Object.entries(prev?.docs || {})) if (/^\d{14}$/.test(no) && no.slice(0, 8) >= from && Array.isArray(evs)) docs[no] = evs;
  const events = [];
  const base = (it) => ({ c: it.code, n: it.name || it.code, m: it.market });

  // 국내 — 회사(고유번호)마다 목록 한 번(우선주는 보통주 회사 공시를 같이 씀)
  const kr = items.filter((it) => it.market === 'KR');
  let krState = 'off', krFail = 0, newDocs = 0;
  if (kr.length && dartEnabled() && corpMap) {
    const lists = new Map(); // 고유번호 → [{ title, date, no }] | null(실패)
    const corps = [...new Set(kr.map((it) => corpOf(corpMap, it.code)).filter(Boolean))];
    await mapLimit(corps, 4, async (corp) => {
      try {
        const seen = new Map();
        for (const type of TYPES) {
          const l = await listFilings(corp, from, today, type);
          if (l == null) throw new Error(dartHalted() || '공시 멈춤');
          for (const f of l) seen.set(f.no, f);
        }
        lists.set(corp, [...seen.values()]);
      } catch (e) { lists.set(corp, null); console.error(`    공시 일정 목록 실패(${corp}):`, e.message); }
    });
    // 일정이 적힌 공시 본문 — 처음 보는 것만, 한 번에 DOCS_PER_RUN건까지
    const want = [...new Set([...lists.values()].filter(Boolean).flat().filter((f) => SCHEDULE_RE.test(f.title) && !docs[f.no]).map((f) => f.no))]
      .sort().reverse().slice(0, DOCS_PER_RUN);
    const titleOf = new Map([...lists.values()].filter(Boolean).flat().map((f) => [f.no, f.title]));
    await mapLimit(want, 4, async (no) => {
      try {
        const xml = await getDocumentXml(no);
        if (xml == null) return;
        docs[no] = parseDocEvents(titleOf.get(no), xml).filter((e) => inRange(e.d));
        newDocs++;
      } catch (e) { console.error(`    공시 본문 실패(${no}):`, e.message); }
    });
    for (const it of kr) {
      const corp = corpOf(corpMap, it.code);
      if (!corp) continue; // ETF 등 공시 대상이 아닌 종목
      const list = lists.get(corp);
      if (!list) { krFail++; events.push(...keepPrev(it.code)); continue; }
      for (const f of list) {
        if (!inRange(f.date)) continue;
        const tag = tagOf(f.title);
        events.push(EARN_FILED_RE.test(f.title)
          ? { d: f.date, ...base(it), k: 'earn', t: '실적 공시', s: cut(f.title), no: f.no }
          : { d: f.date, ...base(it), k: 'disc', t: cut(f.title), tag, no: f.no });
        for (const e of docs[f.no] || []) events.push({ ...e, ...base(it), no: f.no });
      }
    }
    krState = dartHalted() ? `공시 멈춤 — ${dartHalted()}` : krFail ? `일부 실패(${krFail}종목 — 직전 일정 유지)` : 'ok';
  } else if (kr.length) {
    for (const it of kr) events.push(...keepPrev(it.code));
    krState = dartEnabled() ? '고유번호 목록 없음' : 'off';
  }

  // 미국 — 종목마다 실적 발표일·배당(나스닥)을 따로 받는다. 실패한 쪽만 직전 일정, 자료가 없는 종목(400·404)은 일정 없음
  const us = items.filter((it) => it.market === 'US');
  let usFail = 0;
  await mapLimit(us, 3, async (it) => {
    const sym = encodeURIComponent(it.code);
    const get = async (path, parse) => {
      try { return parse(await nasdaq(path)); }
      catch (e) {
        if (/HTTP 40[04]/.test(e.message)) return [];
        console.error(`    미국 일정 실패(${it.code}):`, e.message);
        return null;
      }
    };
    const earn = await get(`analyst/${sym}/earnings-date`, (j) => {
      const x = parseNasdaqEarnings(j);
      return x ? [{ d: x.d, k: 'earn', t: x.est ? '실적 발표(예상일)' : '실적 발표',
        ...(x.when ? { s: x.when === 'amc' ? '미국 장 마감 뒤' : '미국 장 시작 전' } : {}), ...(x.est ? { est: true } : {}) }] : [];
    });
    const div = await get(`quote/${sym}/dividends?assetclass=stocks`, parseNasdaqDividends);
    if (!earn || !div) usFail++;
    for (const [got, k] of [[earn, 'earn'], [div, 'div']]) {
      if (got) { for (const e of got) if (inRange(e.d)) events.push({ ...e, ...base(it) }); }
      else events.push(...keepPrev(it.code).filter((e) => e.k === k));
    }
  });

  // 같은 날 같은 종목의 같은 일정은 하나로 · 실적 공시가 있는 날의 '발표 예정'은 뺀다
  const filed = new Set(events.filter((e) => e.k === 'earn' && e.t === '실적 공시').map((e) => `${e.c}|${e.d}`));
  const seen = new Set();
  const out = events.filter((e) => {
    if (e.k === 'earn' && /예정/.test(e.t) && filed.has(`${e.c}|${e.d}`)) return false;
    const key = `${e.c}|${e.d}|${e.k}|${e.t}|${e.tm || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0) || (KIND_ORDER[a.k] ?? 9) - (KIND_ORDER[b.k] ?? 9)
    || (a.m === b.m ? 0 : a.m === 'KR' ? -1 : 1) || String(a.n).localeCompare(String(b.n), 'ko') || String(a.tm || '').localeCompare(String(b.tm || '')));
  const usState = !us.length ? 'none' : usFail === us.length ? '받기 실패 — 직전 일정 유지' : usFail ? `일부 실패(${usFail}종목 — 직전 일정 유지)` : 'ok';
  console.log(`  · 공시 일정: ${out.length}건(국내 ${krState}${newDocs ? ` · 본문 ${newDocs}건 새로` : ''} · 미국 ${usState})`);
  return { v: 1, at: now, codes: items.map((it) => it.code).sort(), kr: krState, us: usState, events: out, docs };
}
