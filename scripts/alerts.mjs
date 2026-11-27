// pages/scripts/alerts.mjs — 아침 조건 알림(123차, 11/27 사용자 요청 — 텔레그램 · 평일 08:00~10:00)
// 국내 종목이 정한 조건을 처음 넘으면 텔레그램으로 알린다: 등락(전날 종가 대비) +N% · 시가 대비 +N%(장 시작 뒤 추가 상승) ·
// 넥스트레이드 프리마켓 +N%(08:00~08:50, 국내 첫 체결 전에만 — 9시 뒤 남아 있는 프리마켓 값으론 안 보냄).
// 같은 종목·같은 조건은 하루 한 번(보낸 기록 state/alerts.json — 사이트엔 안 올림), 한 번에 걸린 것은 한 메시지로 묶는다.
// 기준 숫자는 config/alerts.json(없거나 이상하면 기본 — 등락 3% · 시가 대비 2% · 프리마켓 2%).
// 텔레그램 봇 토큰·대화 번호는 저장소 Secret(TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID)에서만 읽는다 — 없으면 아무것도 보내지 않고 끝(기록도 안 씀).
// update.yml이 정규 회차 뒤와 아침 집중 갱신 눈금마다 부른다. 보내기에 실패하면 기록하지 않아 다음에 다시 보낸다 · 어떤 오류도 회차를 실패로 만들지 않는다.
// 이 알림은 지금까지의 움직임을 알려 줄 뿐 사거나 팔라는 신호가 아니다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { krHours } from './aibudget.mjs';
import { writeJsonAtomic } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://rok-ljm.github.io/RealTime_StockNews/';
export const ALERT_DEFAULTS = { pct: 3, fromOpen: 2, pre: 2 };
const KST_MS = 9 * 3600e3;
const num = (v) => Number(String(v ?? '').replace(/,/g, ''));
const kstDay = (ms) => new Date(ms + KST_MS).toISOString().slice(0, 10);
const kstHm = (ms) => new Date(ms + KST_MS).toISOString().slice(11, 16);
const sign = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;

// 아침 창 — 평일 08:00~10:00(늦게 여는 날은 09:00~11:00 — krHours, 화면 아침 흐름과 같음)
export function alertWindow(now) {
  const k = new Date(now + KST_MS), min = k.getUTCHours() * 60 + k.getUTCMinutes(), late = krHours(now)[0] - 9 * 60;
  return k.getUTCDay() !== 0 && k.getUTCDay() !== 6 && min >= 8 * 60 + late && min < 10 * 60 + late;
}

// 기준 숫자 — 설정 값이 0보다 크고 30 미만일 때만, 아니면 기본
export function alertRules(cfg) {
  const out = { ...ALERT_DEFAULTS };
  for (const k of Object.keys(out)) { const v = Number(cfg && cfg[k]); if (Number.isFinite(v) && v > 0 && v < 30) out[k] = v; }
  return out;
}

// 새로 걸린 알림 — quotes: quotes.json의 quotes, sent: 오늘 보낸 '코드|종류' 모음
export function findAlerts(quotes, rules, sent, now) {
  const day = kstDay(now), out = [];
  for (const q of quotes || []) {
    if (!q || !q.ok || q.market !== 'KR') continue;
    const has = (kind) => sent.has(`${q.code}|${kind}`);
    if (q.marketStatus === 'OPEN' && Number.isFinite(q.changePct) && Number.isFinite(q.price)) {
      if (!has('pct') && q.changePct >= rules.pct) out.push({ code: q.code, kind: 'pct', q });
      if (!has('fromOpen') && q.open > 0) { const fo = (q.price / q.open - 1) * 100; if (fo >= rules.fromOpen) out.push({ code: q.code, kind: 'fromOpen', q, fo }); }
    }
    const o = q.over, at = Date.parse(o && o.localTradedAt);
    if (!has('pre') && o && o.tradingSessionType === 'PRE_MARKET' && num(o.accumulatedTradingVolumeRaw) > 0 && Number.isFinite(at) && kstDay(at) === day && q.marketStatus === 'PREOPEN') {
      const p = num(o.fluctuationsRatio);
      if (Number.isFinite(p) && p >= rules.pre) out.push({ code: q.code, kind: 'pre', q, p });
    }
  }
  return out;
}

// 메시지 — 머리 '[아침 알림 09:07]' · 걸린 것마다 한 줄 · 끝에 대시보드 주소
export function alertText(found, rules, now) {
  const lines = found.map((a) => {
    const q = a.q, nm = q.name || q.code;
    if (a.kind === 'pre') return `${nm} 프리마켓 ${sign(a.p)} — ${rules.pre}% 넘음 (${num(q.over.overPrice).toLocaleString('ko-KR')}원)`;
    const fh = q.high > 0 ? (q.price / q.high - 1) * 100 : null;
    const high = fh == null ? '' : fh > -0.05 ? '지금이 고가' : `고가 대비 ${sign(fh, 1)}`;
    if (a.kind === 'fromOpen') return `${nm} 시가 대비 ${sign(a.fo, 1)} — ${rules.fromOpen}% 넘음 (지금 ${sign(q.changePct)}${high ? ` · ${high}` : ''})`;
    const fo = q.open > 0 ? `시가 대비 ${sign((q.price / q.open - 1) * 100, 1)}` : '';
    const extra = [fo, high].filter(Boolean).join(' · ');
    return `${nm} ${sign(q.changePct)} — 등락 ${rules.pct}% 넘음${extra ? ` (${extra})` : ''}`;
  });
  return `[아침 알림 ${kstHm(now)}]\n${lines.join('\n')}\n${SITE}`;
}

export async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true) throw new Error(`텔레그램 보내기 실패(${res.status})`); // 토큰이 든 주소는 남기지 않는다
}

export async function runAlerts({ root = ROOT, now = Date.now(), env = process.env } = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim(), chat = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chat) return '설정 없음';
  if (!alertWindow(now)) return '창 밖';
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const quotes = readJson(path.join(root, 'docs', 'data', 'quotes.json'));
  if (!quotes || !Array.isArray(quotes.quotes)) return '시세 없음';
  const statePath = path.join(root, 'state', 'alerts.json'), day = kstDay(now), st = readJson(statePath);
  const sent = new Set(st && st.day === day && Array.isArray(st.sent) ? st.sent : []);
  const rules = alertRules(readJson(path.join(root, 'config', 'alerts.json')));
  const found = findAlerts(quotes.quotes, rules, sent, now);
  if (!found.length) return '새 알림 없음';
  await sendTelegram(token, chat, alertText(found, rules, now));
  for (const a of found) sent.add(`${a.code}|${a.kind}`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeJsonAtomic(statePath, { day, sent: [...sent] });
  return `보냄 ${found.length}`;
}

// 직접 실행(`node scripts/alerts.mjs`)일 때만 — 어떤 결과든 종료 코드 0(회차를 실패로 만들지 않음)
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runAlerts().then((r) => console.log(`[alerts] ${new Date().toISOString()} ${r}`), (e) => console.error('[alerts] 오류 —', e.message)).finally(() => { process.exitCode = 0; });
}
