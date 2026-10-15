// pages/scripts/aibudget.mjs — Gemini 무료 한도를 하루에 걸쳐 나눠 쓰는 예산 관리 (순수 로직, 네트워크 없음)
//
// 실측(2026-10-15): 무료 한도는 모델별 하루 약 20~30회이고 미 태평양시 자정(KST 16:00, 겨울 17:00)에 리셋된다.
// 제한 없이 쓰면 리셋 직후 30분 만에 바닥나 국내 장중엔 새 AI 분석이 거의 없었다.
//  · 하루 예산을 '장 시간 가중치'에 비례해 시간에 따라 풀어준다 — 국내 정규장 3, 미국 정규장 1, 그 외 0.
//    덜 쓴 만큼은 이월되고, 리셋 1시간 전부터는 남은 한도를 다 써도 된다(리셋되면 어차피 사라짐).
//  · 무료 한도는 모델마다 따로다 → 쓸 수 있는 모델 수만큼 예산이 커진다.
//    덜 쓴 모델부터 골라 한도를 고루 쓰고, 대체 모델이 막혀 있으면 하루 초반에 바로 알아채 예산에서 뺀다.

export const DAILY_PER_MODEL = Math.max(1, Number(process.env.AI_DAILY_BUDGET) || 20); // 모델당 하루 예산(실측보다 약간 보수적)
const MIN = 60 * 1000;
const LAST_HOUR_MS = 60 * MIN;

const fmt = (timeZone) => new Intl.DateTimeFormat('en-US', {
  timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const PT = fmt('America/Los_Angeles'), KST = fmt('Asia/Seoul'), ET = fmt('America/New_York');
function parts(f, ms) { const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value; return o; }
const isWeekday = (p) => p.weekday !== 'Sat' && p.weekday !== 'Sun';

// 한도가 리셋되는 '한도일' = 미 태평양시 날짜
export function quotaDay(ms) { const p = parts(PT, ms); return `${p.year}-${p.month}-${p.day}`; }

// 장 시간대 — 국내 평일 09:00~15:59 KST(마감 동시호가·시간외 일부 포함), 미국 평일 09:30~15:59 ET. 공휴일은 구분하지 않는다.
export function isKrSession(ms) { const k = parts(KST, ms); const m = +k.hour * 60 + +k.minute; return isWeekday(k) && m >= 9 * 60 && m < 16 * 60; }
export function isUsSession(ms) { const e = parts(ET, ms); const m = +e.hour * 60 + +e.minute; return isWeekday(e) && m >= 9 * 60 + 30 && m < 16 * 60; }
export const inSession = (market, ms) => (market === 'KR' ? isKrSession(ms) : isUsSession(ms));

// 그 순간의 장 시간 가중치 — 국내 정규장 3, 미국 정규장 1, 그 외 0
export function marketWeight(ms) { return isKrSession(ms) ? 3 : isUsSession(ms) ? 1 : 0; }

// 지금 한도일의 시작·끝 — 태평양시 날짜가 바뀌는 분을 찾는다(서머타임 전환일도 정확). 1시간 단위로 접근 후 분 단위로 맞춤.
export function quotaDayRange(ms) {
  const day = quotaDay(ms);
  const base = ms - (ms % MIN);
  let start = base;
  while (quotaDay(start - 60 * MIN) === day) start -= 60 * MIN;
  while (quotaDay(start - MIN) === day) start -= MIN;
  let end = base + MIN;
  while (quotaDay(end + 60 * MIN) === day) end += 60 * MIN;
  while (quotaDay(end) === day) end += MIN;
  return { day, start, end };
}

// 한도일 중 지금까지 지나간 장 시간 가중치의 비율 [0,1], 그리고 리셋 1시간 전인지
export function elapsedFraction(ms) {
  const { start, end } = quotaDayRange(ms);
  let total = 0, done = 0;
  for (let t = start; t < end; t += MIN) { const w = marketWeight(t); total += w; if (t < ms) done += w; }
  return { fraction: total ? done / total : 0, lastHour: end - ms <= LAST_HOUR_MS };
}

// 저장된 기록에서 형식이 맞는 항목만 남긴다(손상·수동 편집된 파일이 계산을 망치지 않게)
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const clean = (o, ok) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([, v]) => ok(v)));

// 회차 시작: 저장된 기록(status.json의 budget)을 이어받되 한도일이 바뀌었으면 새로 시작한다.
// fraction·lastHour·rolled는 이번 회차 계산용이라 저장하지 않는다(toStored 참고).
export function startBudget(prev, ms = Date.now()) {
  const day = quotaDay(ms);
  const rolled = !isObj(prev) || prev.day !== day;
  const used = rolled ? {} : clean(prev.used, (v) => Number.isInteger(v) && v >= 0);
  const out = rolled ? {} : clean(prev.out, (v) => typeof v === 'string' && v !== '');
  return { day, used, out, ...elapsedFraction(ms), rolled };
}
export const toStored = (b) => ({ day: b.day, used: b.used, out: b.out });
// 오늘 쓴 횟수 — 지금 설정된 모델만 센다(설정에서 뺀 모델의 사용분은 남은 모델의 한도와 무관)
export const totalUsed = (b, models) => models.reduce((a, m) => a + (b.used[m] || 0), 0);

// 오늘 쓸 수 있는 총량 — 아직 쓸 수 있는 모델은 모델당 예산, 한도 소진·사용 불가로 빠진 모델은 실제로 쓴 만큼만
export function capacity(b, models) {
  return models.reduce((a, m) => a + (b.out[m] ? (b.used[m] || 0) : DAILY_PER_MODEL), 0);
}

// 지금 더 쓸 수 있는 호출 수 — 리셋 1시간 전부터는 제한 없음(쓸 수 있는 모델이 남아 있는 한)
export function allowance(b, models) {
  if (!models.some((m) => !b.out[m])) return 0;
  if (b.lastHour) return Infinity;
  return Math.max(0, Math.floor(capacity(b, models) * b.fraction) - totalUsed(b, models));
}

// 덜 쓴 모델부터(같으면 목록 순서 = 주 모델 우선). 쓸 수 있는 모델이 없으면 null.
export function pickModel(b, models) {
  let best = null;
  for (const m of models) if (!b.out[m] && (best === null || (b.used[m] || 0) < (b.used[best] || 0))) best = m;
  return best;
}
