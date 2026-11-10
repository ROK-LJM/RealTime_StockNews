// pages/scripts/burst.mjs — 개장 직후 집중 갱신(국내 09:00~09:10, 1분마다)
// 평소 회차는 5분 간격이라 장 시작 직후엔 첫 값이 09:01~09:02에야 들어오고 그다음은 09:06 무렵이어서 처음 10분의 분위기를 보기 어렵다
// (9시 전엔 네이버 시세가 모두 '개장 전'·어제 종가(0%)라 '한눈에' 칸이 모두 무채색). 이 10분만 1분마다 국내 종목 시세·코스피·코스닥만
// 다시 받아 quotes.json·market.json·manifest.json을 고친다 — 뉴스·AI·공시·급등락 기록은 다음 정규 회차가 이어 받는다.
//
// update.yml 마지막 단계가 되풀이 실행한다: 종료 코드 0 = 새 값을 썼거나 아직 첫 체결 전(다시 부름 — 쓴 게 있으면 커밋·푸시) · 3 = 끝.
// 부를 때마다 다음 1분 눈금(매분 10초 — 첫 눈금 09:00:10, 끝 눈금 09:10:10)까지 기다렸다가 한 번 받는다.
// 창은 평일 08:54부터라 08:55 회차가 이 단계에 들어오면 첫 눈금까지 기다린다(그동안 다음 회차는 같은 동시 실행 묶음이라 대기했다가
// 집중 갱신이 끝나면 이어서 돈다). 휴장일(국내 시세가 '개장 전'·'장중'이 아님)·창 밖·받기 실패면 바로 끝 — 어떤 오류도 회차를 실패로 만들지 않는다.
// 국내 시세·지수는 네이버 실시간만 쓴다(실패한 종목은 직전 값 — 20분 지연인 야후 값으로 대신하지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKrQuotesLive, getKrIndices, computeMood } from './sources.mjs';
import { writeJsonAtomic, manifestOf } from './util.mjs';
import { krHours } from './aibudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 한국시간 분(평소 09:00 개장 기준) — from부터 이 단계에 들어올 수 있고, 눈금은 first~last 분의 offsetSec초.
// 수능일·새해 첫 거래일처럼 10시에 여는 날은 그만큼 늦춘다(09:54~10:10 — krHours, 46차)
export const BURST = { from: 8 * 60 + 54, first: 9 * 60, last: 9 * 60 + 10, offsetSec: 10 };
const KST_MS = 9 * 3600e3;

// 다음에 받을 시각 { at } 또는 끝낼 이유 { stop } — prevQuotes: 지금의 quotes.json
export function burstPlan(now, prevQuotes) {
  const k = new Date(now + KST_MS); // 한국시간을 UTC 칸에 담아 읽는다
  const min = k.getUTCHours() * 60 + k.getUTCMinutes(), late = krHours(now)[0] - 9 * 60; // 늦게 여는 날 늦출 분
  if (k.getUTCDay() === 0 || k.getUTCDay() === 6) return { stop: '주말' };
  if (min < BURST.from + late || min > BURST.last + late) return { stop: '창 밖' };
  const kr = (prevQuotes?.quotes || []).filter((q) => q && q.ok && q.market === 'KR');
  if (!kr.length) return { stop: '국내 시세 없음' };
  const today = k.toISOString().slice(0, 10);
  if (prevQuotes.closed?.KR === today || !kr.some((q) => q.marketStatus === 'PREOPEN' || q.marketStatus === 'OPEN')) return { stop: '휴장' };
  const midnight = now - ((now + KST_MS) % 86400e3); // 오늘 한국시간 0시
  const off = BURST.offsetSec * 1000;
  const first = midnight + (BURST.first + late) * 60e3 + off, last = midnight + (BURST.last + late) * 60e3 + off;
  const at = Math.max(first, Math.ceil((now - off) / 60e3) * 60e3 + off);
  return at > last ? { stop: '창 끝' } : { at };
}

// 국내 종목만 새 값으로 — 받기 실패한 종목·해외 종목·휴장 기록은 그대로 두고, 상장 시장(exch)·AI 끔 표시는 이어 붙인다(fetch.mjs와 같은 모양)
export function mergeKrQuotes(prev, fresh) {
  const byCode = new Map((fresh || []).filter((q) => q && q.ok && q.market === 'KR').map((q) => [q.code, q]));
  let n = 0;
  const quotes = (prev?.quotes || []).map((q) => {
    const f = q && q.market === 'KR' ? byCode.get(q.code) : null;
    if (!f) return q;
    n++;
    const out = { ...f };
    if (q.exch) out.exch = q.exch;
    if (q.ai === false) out.ai = false;
    return out;
  });
  return { file: { ...prev, quotes }, n };
}

// 코스피·코스닥만 새 값으로 — 지수 브리핑의 등락·지수와 시장 분위기(공포·탐욕)도 같은 값으로 맞춘다(이유·수급·환율·미국 지수는 그대로)
const BRIEF_KEY = { '^KS11': 'KOSPI', '^KQ11': 'KOSDAQ' };
export function mergeKrIndices(prev, kr) {
  const bySym = new Map((kr || []).filter((i) => i && BRIEF_KEY[i.symbol] && Number.isFinite(i.price) && Number.isFinite(i.changePct)).map((i) => [i.symbol, i]));
  if (!bySym.size || !Array.isArray(prev?.indices)) return null;
  const indices = prev.indices.map((i) => (i && bySym.has(i.symbol) ? { ...i, ...bySym.get(i.symbol) } : i));
  const out = { ...prev, indices, mood: computeMood(indices.filter((i) => i && i.symbol !== '^VIX'), prev.vix?.price) };
  if (Array.isArray(prev.briefs)) out.briefs = prev.briefs.map((b) => {
    const sym = Object.keys(BRIEF_KEY).find((s) => BRIEF_KEY[s] === b?.key), i = sym && bySym.get(sym);
    return i ? { ...b, changePct: i.changePct, price: i.price } : b;
  });
  return out;
}

// 한 번: 다음 눈금까지 기다렸다가 받아서 쓴다. 돌려줌: 'written' 또는 끝낸 이유. clock·sleep은 자체 테스트가 바꿔 넣는다
export async function burstOnce({ root = ROOT, dataDir = path.join(root, 'docs', 'data'), clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const readJson = (name) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')); } catch { return null; } };
  const prevQuotes = readJson('quotes.json');
  const plan = burstPlan(clock(), prevQuotes);
  if (plan.stop) return plan.stop;
  const wait = plan.at - clock();
  if (wait > 0) await sleep(wait);
  const items = prevQuotes.quotes.filter((q) => q && q.market === 'KR').map((q) => ({ code: q.code, name: q.name }));
  const [fresh, krIdx] = await Promise.all([getKrQuotesLive(items), getKrIndices(false).catch(() => [])]);
  const { file, n } = mergeKrQuotes(prevQuotes, fresh);
  if (!n) return '시세 받기 실패';
  // 아직 첫 체결 전(수능일·새해 첫날처럼 늦게 여는 날, 9시 몇 초 안)이면 쓰지 않는다 — 값이 그대로라 커밋만 늘어난다. 다음 눈금에 다시
  if (fresh.every((q) => !q || !q.ok || q.marketStatus === 'PREOPEN')) return '개장 전';
  writeJsonAtomic(path.join(dataDir, 'quotes.json'), file);
  const market = mergeKrIndices(readJson('market.json'), krIdx);
  if (market) writeJsonAtomic(path.join(dataDir, 'market.json'), market);
  writeJsonAtomic(path.join(dataDir, 'manifest.json'), manifestOf(dataDir));
  return 'written';
}

// 종료 코드 — 새 값을 썼거나 아직 첫 체결 전이면 0(워크플로가 다시 부른다), 그 밖(창 끝·휴장·실패·오류)은 3(반복이 멈춘다)
export const exitCodeOf = (r) => (r === 'written' || r === '개장 전' ? 0 : 3);
// 직접 실행(`node scripts/burst.mjs`)일 때만
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  burstOnce().then((r) => {
    console.log(`[burst] ${new Date().toISOString()} ${r === 'written' ? '국내 시세·지수 갱신' : r === '개장 전' ? '아직 첫 체결 전 — 다음 눈금에' : `끝 — ${r}`}`);
    process.exitCode = exitCodeOf(r);
  }, (e) => { console.error('[burst] 오류 — 끝:', e); process.exitCode = 3; });
}
