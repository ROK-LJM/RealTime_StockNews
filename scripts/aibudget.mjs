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

// 휴장 확인 시간대 — 정규장 개장 10분 뒤 ~ 마감 10분 전(국내 09:10~15:19 KST, 미국 09:40~15:49 ET)이면 그 시장의 날짜, 아니면 null.
// 이 시간에 시세가 '장중'이 아니면 그날은 휴장(또는 조기 폐장)이다 — 화면의 '갱신 없음' 경고가 휴장일에 뜨지 않게 기록한다.
export function closedCheckDay(market, ms) {
  const p = parts(market === 'KR' ? KST : ET, ms);
  const m = +p.hour * 60 + +p.minute;
  const [open, close] = market === 'KR' ? [9 * 60, 15 * 60 + 30] : [9 * 60 + 30, 16 * 60];
  return isWeekday(p) && m >= open + 10 && m < close - 10 ? `${p.year}-${p.month}-${p.day}` : null;
}

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

// 한도일의 분 단위 장 시간 가중치 — 시작·끝, 분마다의 가중치, 합계
function dayWeights(ms) {
  const { start, end } = quotaDayRange(ms);
  const w = [];
  let total = 0;
  for (let t = start; t < end; t += MIN) { const x = marketWeight(t); w.push(x); total += x; }
  return { start, end, w, total };
}

// 한도일 중 지금까지 지나간 장 시간 가중치의 비율 [0,1], 그리고 리셋 1시간 전인지
export function elapsedFraction(ms, dw = dayWeights(ms)) {
  let done = 0;
  for (let i = 0, t = dw.start; i < dw.w.length && t < ms; i++, t += MIN) done += dw.w[i];
  return { fraction: dw.total ? done / dw.total : 0, lastHour: dw.end - ms <= LAST_HOUR_MS };
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
  const dw = dayWeights(ms); // 다음 배분 시각 계산(nextAllowanceAt)에 다시 쓴다 — 저장하지 않음
  return { day, used, out, ...elapsedFraction(ms, dw), rolled, dw };
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

// 지금은 몫이 없을 때, 다음에 1회 이상 쓸 수 있게 되는 시각(ms, 분 단위) — 화면의 '다음 분석 ○○:○○부터' 표시용.
// 같은 한도일 안에서 리셋 1시간 전이 되면 무조건 가능. 쓸 모델이 하나도 없으면 null(다음 한도일까지 불가).
// 예산 상태(day·used·out)가 같으면 결과도 같아 상태 파일이 회차마다 바뀌지 않는다.
export function nextAllowanceAt(b, models, ms) {
  if (!models.some((m) => !b.out[m])) return null;
  const dw = b.dw || dayWeights(ms);
  const lastHourAt = dw.end - LAST_HOUR_MS;
  if (ms >= lastHourAt || allowance(b, models) > 0) return ms;
  const cap = capacity(b, models), used = totalUsed(b, models);
  let done = 0;
  for (let i = 0, t = dw.start; i < dw.w.length; i++, t += MIN) {
    done += dw.w[i];
    const at = t + MIN; // 이 분이 지난 시각
    if (at <= ms) continue;
    if (at >= lastHourAt) return lastHourAt;
    if (dw.total && Math.floor(cap * done / dw.total) - used >= 1) return at;
  }
  return lastHourAt;
}

// 덜 쓴 모델부터(같으면 목록 순서 = 주 모델 우선). 쓸 수 있는 모델이 없으면 null.
export function pickModel(b, models) {
  let best = null;
  for (const m of models) if (!b.out[m] && (best === null || (b.used[m] || 0) < (b.used[best] || 0))) best = m;
  return best;
}
