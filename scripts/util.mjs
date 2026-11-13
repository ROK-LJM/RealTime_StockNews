// pages/scripts/util.mjs — 파이프라인 공통 유틸 (외부 의존성·네트워크 접근 없음)
// fetch.mjs와 selftest.mjs가 함께 쓴다. 여기 함수는 순수 로직이라 오프라인으로 검증할 수 있다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_ITEMS = 60;   // 추적 종목 최대 개수 — 5분 회차 시간(40종목 기준 가장 무거운 회차 약 1분)·무료 뉴스 요청을 생각한 안전장치
const KR_RE = /^\d{6}$/;
const US_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/; // AAPL, BRK.B, BF-B …

// watchlist.json 검증·보정. 고칠 수 있는 건 고치고, 못 고치는 항목은 빼되 이유를 경고로 남긴다.
// (예전에는 잘못된 코드가 그대로 흘러가 엉뚱한 종목을 조회하거나 조용히 실패했다)
export function validateWatchlist(cfg) {
  const warnings = [];
  const raw = cfg && Array.isArray(cfg.items) ? cfg.items : null;
  if (!raw) return { items: [], warnings: ['items 배열이 없습니다'] };
  const seen = new Set();
  const items = [];
  raw.forEach((x, i) => {
    const at = `#${i + 1}`;
    if (!x || (typeof x.code !== 'string' && typeof x.code !== 'number')) { warnings.push(`${at} code 없음 — 제외`); return; }
    let code = String(x.code).trim();
    let market = typeof x.market === 'string' ? x.market.trim().toUpperCase() : '';
    if (market && market !== 'KR' && market !== 'US') { warnings.push(`${at} market "${x.market}"을 알 수 없어 코드로 추정`); market = ''; }
    // 국내 코드를 숫자로 적으면 앞자리 0이 사라진다(005930 → 5930). 6자리로 되돌린다.
    if (/^\d{1,5}$/.test(code) && market !== 'US') {
      const fixed = code.padStart(6, '0');
      warnings.push(`${at} 코드 ${code} → ${fixed} 보정 (국내 코드는 "005930"처럼 6자리 문자열로 적으세요)`);
      code = fixed;
    }
    // 미국 티커는 숫자 6자리일 수 없다 → 시장 표기 실수로 보고 국내로 바로잡는다
    if (market === 'US' && KR_RE.test(code)) { warnings.push(`${at} 코드 ${code}는 국내 6자리 형식 — market을 KR로 보정`); market = 'KR'; }
    if (!market) market = KR_RE.test(code) ? 'KR' : 'US';
    if (market === 'KR' && !KR_RE.test(code)) { warnings.push(`${at} 국내 코드 "${code}" 형식 오류(6자리 숫자) — 제외`); return; }
    if (market === 'US') {
      code = code.toUpperCase();
      if (!US_RE.test(code)) { warnings.push(`${at} 해외 티커 "${code}" 형식 오류 — 제외`); return; }
    }
    if (seen.has(code)) { warnings.push(`${at} 중복 코드 ${code} — 제외`); return; }
    seen.add(code);
    // ai: false = 이 종목은 AI 종합분석을 하지 않음(종목 편집에서 끔 — 무료 AI 한도를 고른 종목에만). 없으면 켜짐
    items.push({ code, market, name: typeof x.name === 'string' ? x.name.trim().slice(0, 30) : '', ...(x.ai === false ? { ai: false } : {}) });
  });
  if (items.length > MAX_ITEMS) {
    warnings.push(`종목 ${items.length}개 — 최대 ${MAX_ITEMS}개만 사용, 제외: ${items.slice(MAX_ITEMS).map((x) => x.code).join(', ')}`);
    items.length = MAX_ITEMS;
  }
  return { items, warnings };
}

// 원자적 쓰기: 임시 파일에 끝까지 쓴 뒤 이름만 바꾼다. 실행이 중간에 끊겨도 반쯤 쓴 JSON이
// 커밋돼 화면이 깨지는 일이 없다. (임시 파일 *.tmp는 .gitignore로 커밋 대상에서 제외)
export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// 화면이 1분마다 받는 파일 — 파일별 내용 지문(sha1 앞 10자리)을 manifest.json에 남기면 화면은 지문만 먼저 받고 바뀐 파일만 다시 받는다
// (평소 1분 갱신 약 220KB → 수 KB, 휴대폰 데이터 절약). fetch.mjs(회차 끝)와 burst.mjs(개장 직후 집중 갱신)가 함께 쓴다.
export const MANIFEST_FILES = ['quotes.json', 'market.json', 'news.json', 'history.json', 'investors.json', 'analysis.json', 'disclosures.json', 'moves.json', 'status.json', 'calendar.json'];
export function manifestOf(dataDir, files = MANIFEST_FILES) {
  const out = {};
  for (const f of files) {
    try { out[f] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dataDir, f))).digest('hex').slice(0, 10); }
    catch { /* 아직 없는 파일 — 화면은 그 파일만 예전처럼 받는다 */ }
  }
  return { files: out };
}

// 동시 실행 개수를 제한한 map — 한꺼번에 수십 개를 쏘아 차단·속도 제한에 걸리는 것을 막는다. 결과 순서는 입력 순서.
export async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}

// 종합분석 입력의 시그니처 — 직전과 같으면 Gemini 재호출 없이 이전 분석을 재사용(과호출·잦은 커밋 방지).
// 등락은 1% 버킷으로 거칠게 본다(매 틱 재계산 방지). 뉴스·수급이 바뀌거나 등락 구간이 바뀔 때만 재분석.
export function analysisSig(q, news, flow, disc) {
  const heads = (news?.items || []).slice(0, 5).map((it) => it.title).join('|');
  const f = flow ? `${flow.date}:${flow.foreign}:${flow.institution}:${flow.individual}` : 'x';
  // 공시(OpenDART 키가 있을 때만)는 새 공시가 올라오면 다시 분석하도록 최근 3건 접수번호를 붙인다 — 없으면 예전 형식 그대로
  const d = (disc?.items || []).slice(0, 3).map((it) => it.no).join(',');
  return `${Math.round(q.changePct ?? 0)}|${f}|${heads}${d ? `|d:${d}` : ''}`;
}
// 시그니처의 등락 구간(맨 앞 1% 버킷) — 종목·지수 시그니처 모두 이 형식으로 시작한다
export const sigMove = (sig) => String(sig ?? '').split('|')[0];
// 등락만 조금 바뀌었나(71차, 장중 재분석 건너뛰기) — 등락 말고는 입력(수급·뉴스·공시)이 같고, 방향이 같고, 5% 선(급등·급락 말의 기준)을 넘나들지 않고,
// 차이가 max(2%p, 직전 등락의 30%) 안쪽. 11/08~13 같은 장 재분석 152번 중 47번(전체 호출 309번의 15%)이 등락 구간(1%p)만 바뀐 것이었다 —
// 슈퍼 마이크로 컴퓨터는 -9~-13%를 오가며 하룻밤 10번, LIG는 11/09 하루 15번 같은 뉴스로 다시 분석됐다
export function nearSig(a, b) {
  const [ma, ...ra] = String(a ?? '').split('|'), [mb, ...rb] = String(b ?? '').split('|');
  const x = Number(ma), y = Number(mb);
  return ra.join('|') === rb.join('|') && Math.sign(x) === Math.sign(y) && (Math.abs(x) > 5) === (Math.abs(y) > 5) && Math.abs(x - y) < Math.max(2, Math.abs(x) * 0.3);
}
