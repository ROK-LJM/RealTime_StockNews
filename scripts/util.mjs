// pages/scripts/util.mjs — 파이프라인 공통 유틸 (외부 의존성·네트워크 접근 없음)
// fetch.mjs와 selftest.mjs가 함께 쓴다. 여기 함수는 순수 로직이라 오프라인으로 검증할 수 있다.
import fs from 'node:fs';

export const MAX_ITEMS = 40;   // 추적 종목 최대 개수
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
    items.push({ code, market, name: typeof x.name === 'string' ? x.name.trim().slice(0, 30) : '' });
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
export function analysisSig(q, news, flow) {
  const heads = (news?.items || []).slice(0, 5).map((it) => it.title).join('|');
  const f = flow ? `${flow.date}:${flow.foreign}:${flow.institution}:${flow.individual}` : 'x';
  return `${Math.round(q.changePct ?? 0)}|${f}|${heads}`;
}
