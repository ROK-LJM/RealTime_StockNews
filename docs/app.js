// pages/app.js — GitHub Pages 정적 버전. 서버 없이 ./data/*.json 을 읽어 렌더링.
'use strict';

const MOVER_THRESHOLD = 3;
const FORECAST_DAYS = 20; // 예측 지평(거래일)
const DRIFT_DAMP = 0.35;  // 추세 감쇠 계수 — 최근 급등락이 그대로 이어진다고 보지 않도록 보수적으로
const CHART_H = 120;      // 차트 높이(px). style.css의 .chart/.chart canvas 높이와 반드시 같아야 한다.

const $ = (s) => document.querySelector(s);
// openAnalysis: 펼쳐 둔 AI 종합분석의 종목코드. 자동 새로고침으로 카드를 다시 그려도 접히지 않게 유지한다.
// loadedOnce: 한 번이라도 시세를 그렸는지. 이후의 일시적 로드 실패로 화면을 비우지 않기 위한 표시.
// sort: 카드 순서('mine' 내 순서 | 'move' 등락 큰 순, 이 기기에 기억). whyAll: '왜 움직였나' 전체 펼침. data: 마지막으로 받은 quotes.json
const state = { timer: null, intervalSec: 60, hist: {}, news: {}, inv: {}, analysis: {}, disc: {}, openAnalysis: new Set(), loadedOnce: false,
  sort: 'mine', view: 'full', whyAll: false, data: null, market: null, moves: {}, briefOpen: new Map() };

// ---------- 포맷 ----------
function fmtPrice(q) {
  if (q.price == null) return '—';
  if (q.currency === 'KRW') return Math.round(q.price).toLocaleString('ko-KR');
  return '$' + q.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtChange(q) {
  if (q.change == null) return '';
  const v = q.change;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  if (q.currency === 'KRW') return sign + Math.abs(Math.round(v)).toLocaleString('ko-KR');
  if (q.currency === 'KRW2') return sign + Math.abs(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(pct) { return pct == null ? '' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`; }
function fmtPctP(d) { return d == null ? '' : `${d >= 0 ? '+' : ''}${d.toFixed(2)}%p`; } // 두 등락률의 차이(%포인트)
function dirClass(pct) { return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'; }
function fmtVol(v) {
  if (v == null) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '억';
  if (v >= 1e4) return (v / 1e4).toFixed(0) + '만';
  return v.toLocaleString();
}
// 차트 축 라벨용. 통화를 알면 카드 상단의 가격 표기와 같은 형식으로 맞춘다.
function fmtCompact(v, cur) {
  if (cur === 'KRW') return Math.round(v).toLocaleString('ko-KR');
  if (cur) return '$' + (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2));
  return v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2);
}
function fmtFlow(v) { // 지수 순매매(억원)
  if (v == null) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString() + '억';
}
function fmtShares(v) { // 종목 순매매(주) → 만주
  if (v == null) return '—';
  const s = v > 0 ? '+' : v < 0 ? '−' : '', a = Math.abs(v);
  if (a >= 10000) return s + (a / 10000).toFixed(a >= 1e6 ? 0 : 1) + '만주';
  return s + a.toLocaleString() + '주';
}
// AI 분석 시각 — 오늘이면 '14:05', 아니면 '10. 14. 14:05'. 값이 없거나 이상하면 빈 문자열(표시 생략).
function fmtAiTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const opt = { hour: '2-digit', minute: '2-digit', hour12: false };
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('ko-KR', opt)
    : d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', ...opt });
}
function cssId(code) { return String(code).replace(/[^a-zA-Z0-9]/g, '_'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// 외부(뉴스 RSS·AI 응답) 링크는 http/https만 허용 — javascript: 같은 실행 스킴이 섞여 들어와도 클릭으로 실행되지 않게.
function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (!s) return '#'; // 빈 링크가 현재 페이지 주소로 풀리지 않게
  try { const x = new URL(s, location.href); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : '#'; }
  catch { return '#'; }
}
// 외부 링크 앵커 — 주소 검증 + 속성 이스케이프 + 새 탭(원래 페이지 주소를 넘기지 않음)
function extLink(url, label) { return `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`; }

async function loadJson(name) {
  const r = await fetch(`./data/${name}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(name + ' ' + r.status);
  return r.json();
}

// ---------- 바뀐 파일만 받기 ----------
// 봇이 회차마다 data/manifest.json에 파일별 내용 지문(sha1 앞 10자리)을 남긴다. 화면은 지문만 먼저 받고(1KB 미만)
// 지문이 바뀐 파일만 '?v=지문' 주소로 받는다 — 같으면 이미 받은 것을 그대로 쓴다(1분 갱신 기준 매번 약 220KB → 평소 수 KB).
// 지문 파일이 없거나(배포 직후·옛 데이터) 받은 내용이 지문과 다르면(배포 중 엇갈림) 그 파일은 예전처럼 매번 새로 받는다.
const _files = new Map();     // 파일 이름 → { v: 지문, data }
const _mismatch = new Set();  // 내용이 지문과 달랐던 '이름@지문' — 그 주소는 다시 쓰지 않는다(캐시에 틀린 내용이 남아 있을 수 있어서)
let _manifest = null;
async function loadManifest() {
  try {
    const r = await fetch(`./data/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
    const m = r.ok ? await r.json() : null;
    _manifest = m && m.files && typeof m.files === 'object' ? m.files : null;
  } catch { _manifest = null; }
}
async function sha1Hex(buf) {
  const d = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function loadData(name) {
  const v = _manifest && _manifest[name];
  if (typeof v !== 'string' || !/^[0-9a-f]{8,40}$/.test(v) || _mismatch.has(`${name}@${v}`)) return loadJson(name);
  const hit = _files.get(name);
  if (hit && hit.v === v) return hit.data;
  const r = await fetch(`./data/${name}?v=${v}`); // 주소에 지문이 들어 있어 캐시에서 와도 내용이 같다
  if (!r.ok) throw new Error(name + ' ' + r.status);
  const buf = await r.arrayBuffer();
  if (globalThis.crypto?.subtle && !(await sha1Hex(buf)).startsWith(v)) { _mismatch.add(`${name}@${v}`); return loadJson(name); }
  const data = JSON.parse(new TextDecoder().decode(buf));
  _files.set(name, { v, data });
  return data;
}

// ---------- 통계 / 예측 ----------
function periodReturn(closes, n) {
  const L = closes.length;
  if (L <= n) return null;
  const a = closes[L - 1 - n], b = closes[L - 1];
  return a ? (b - a) / a * 100 : null;
}
// 단순 통계 예측: 최근 일간 로그수익률의 평균(추세)·표준편차(변동성)로
// 기하 랜덤워크 중앙값과 ±1σ(≈68%) 밴드를 horizon일까지 투영. (참고용, 투자조언 아님)
function forecast(closes, horizon) {
  if (!closes || closes.length < 25) return null;
  if (!(closes[closes.length - 1] > 0)) return null; // 마지막 종가가 0/비정상이면 0으로 나눠 NaN이 되므로 중단
  const rets = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  const recent = rets.slice(-60);
  const n = recent.length;
  const mu = recent.reduce((a, b) => a + b, 0) / n;
  const variance = recent.reduce((a, b) => a + (b - mu) * (b - mu), 0) / Math.max(1, n - 1);
  const sigma = Math.sqrt(variance);
  const muUsed = mu * DRIFT_DAMP; // 추세는 감쇠, 변동성(밴드)은 실제 그대로 유지
  const last = closes[closes.length - 1];
  const median = [], upper = [], lower = [];
  for (let t = 1; t <= horizon; t++) {
    const m = last * Math.exp(muUsed * t);
    const band = Math.exp(sigma * Math.sqrt(t));
    median.push(m); upper.push(m * band); lower.push(m / band);
  }
  const end = median[horizon - 1];
  return {
    median, upper, lower, last,
    expReturnPct: (end - last) / last * 100,
    endBandPct: (Math.exp(sigma * Math.sqrt(horizon)) - 1) * 100,
  };
}

// ---------- 시장 분위기(공포·탐욕 막대) ----------
// 0~100점을 다섯 구간 막대(극도의 공포·공포·중립·탐욕·극도의 탐욕 — sources.mjs 기준 25·45·55·75점) 위의 표시로 보여준다.
// 막대는 HTML·CSS라 화면 크기·밝기 테마가 바뀌어도 다시 그릴 필요가 없다.
function renderMood(mood) {
  const n = Number(mood.score);
  const pos = mood.score != null && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  const sc = $('#moodScore');
  if (sc) {
    sc.textContent = mood.score ?? '--';
    sc.className = 'mood-score' + (mood.tone === 'fear' ? ' down-c' : mood.tone === 'greed' ? ' up-c' : '');
  }
  $('#moodLabel').textContent = mood.label || '—';
  $('#moodSummary').textContent = mood.summary || '';
  const pin = $('#moodPin');
  if (pin) { pin.hidden = pos == null; if (pos != null) pin.style.left = pos + '%'; }
  $('#moodMeter')?.setAttribute('aria-label', pos == null ? '공포·탐욕 점수 없음' : `공포·탐욕 ${mood.score}점 — ${mood.label || ''}`);
}

// 차트 색은 CSS 토큰에서 읽는다(밝은·어두운 화면). 테마가 바뀔 때만 다시 읽는다.
let _cc = null, _ccKey = null;
function chartColors() {
  const key = document.documentElement.getAttribute('data-theme') || '';
  if (_cc && _ccKey === key) return _cc;
  const s = getComputedStyle(document.documentElement);
  const v = (name, d) => s.getPropertyValue(name).trim() || d;
  _ccKey = key;
  return (_cc = {
    up: v('--up', '#e3263d'), down: v('--down', '#1f66e5'), warn: v('--warn', '#b26400'), warnRgb: v('--warn-rgb', '222, 135, 0'),
    muted: v('--muted', '#6e7380'), line: v('--line-2', '#d3d7dd'), surface: v('--surface', '#ffffff'), font: v('--font', 'sans-serif'),
  });
}

// ---------- 과거 + 예측 차트 ----------
function drawChart(canvas, closes, fc, opts = {}) {
  const ctx = canvas.getContext('2d');
  const C = chartColors();
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300, H = CHART_H;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (!closes || closes.length < 2) {
    ctx.fillStyle = C.muted; ctx.font = `11px ${C.font}`; ctx.textAlign = 'center';
    ctx.fillText('과거 시세 수집 중…', W / 2, H / 2);
    canvas.__c = null;
    return;
  }
  const hist = closes, HN = hist.length, FN = fc ? fc.median.length : 0, N = HN + FN;
  // 실제 시세의 최고/최저 — 라벨은 반드시 이 값을 쓴다(예측 밴드를 섞으면 없던 가격이 표시된다).
  const hHi = Math.max(...hist), hLo = Math.min(...hist);
  let lo = hLo, hi = hHi;
  if (fc) {
    // 예측 밴드가 y축을 통째로 잠식해 실제 시세선이 납작해지지 않도록 기여도를 30%로 제한한다.
    const hSpan = (hHi - hLo) || 1;
    hi = Math.max(hHi, Math.min(Math.max(...fc.upper), hHi + hSpan * 0.30));
    lo = Math.min(hLo, Math.max(Math.min(...fc.lower), hLo - hSpan * 0.30));
  }
  const padTop = 10, padBot = 18, padL = 2, padR = 2, span = (hi - lo) || 1;
  const x = (i) => padL + (i / (N - 1)) * (W - padL - padR);
  const y = (v) => padTop + (1 - (v - lo) / span) * (H - padTop - padBot);
  // 색 판정은 '화면에 그려진 구간'(6개월) 기준이어야 한다. 다른 구간을 쓰면 보이는 방향과 색이 어긋난다.
  const up = hist[HN - 1] >= hist[0];
  const histCol = up ? C.up : C.down;
  // 호버용 메타데이터 저장
  canvas.__c = { hist, fc, dates: opts.dates, currency: opts.currency, geom: { padL, padR, W, padTop, padBot, lo, span, N, HN, FN } };

  if (fc) {
    // ±1σ 밴드 — y축을 clamp했으므로 밖으로 새지 않게 클립한 뒤, 경계선을 그려 형태가 보이게 한다.
    ctx.save();
    ctx.beginPath(); ctx.rect(0, padTop, W, H - padTop - padBot); ctx.clip();
    ctx.beginPath();
    ctx.moveTo(x(HN - 1), y(hist[HN - 1]));
    fc.upper.forEach((v, i) => ctx.lineTo(x(HN + i), y(v)));
    for (let i = FN - 1; i >= 0; i--) ctx.lineTo(x(HN + i), y(fc.lower[i]));
    ctx.closePath();
    const grad = ctx.createLinearGradient(x(HN - 1), 0, x(N - 1), 0);
    grad.addColorStop(0, `rgba(${C.warnRgb},0.22)`); grad.addColorStop(1, `rgba(${C.warnRgb},0.05)`);
    ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = `rgba(${C.warnRgb},0.45)`; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }
  // 과거 라인
  ctx.beginPath(); ctx.moveTo(x(0), y(hist[0]));
  hist.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.strokeStyle = histCol; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  if (fc) {
    // 예측 중앙값(점선)
    ctx.beginPath(); ctx.moveTo(x(HN - 1), y(hist[HN - 1]));
    fc.median.forEach((v, i) => ctx.lineTo(x(HN + i), y(v)));
    ctx.setLineDash([4, 3]); ctx.strokeStyle = C.warn; ctx.lineWidth = 1.6; ctx.stroke(); ctx.setLineDash([]);
    // 오늘 구분선
    ctx.beginPath(); ctx.moveTo(x(HN - 1), padTop); ctx.lineTo(x(HN - 1), H - padBot);
    ctx.setLineDash([2, 3]); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  // 라벨 — 반드시 실제 시세의 최고/최저(hHi/hLo). y축 상한(hi/lo)은 예측 밴드가 섞여 있어 쓰면 안 된다.
  ctx.font = `500 10.5px ${C.font}`; ctx.fillStyle = C.muted;
  ctx.textAlign = 'left'; ctx.fillText('6개월 최고 ' + fmtCompact(hHi, opts.currency), 2, padTop);
  ctx.fillText('6개월 최저 ' + fmtCompact(hLo, opts.currency), 2, H - 5);
  if (fc) { ctx.fillStyle = C.warn; ctx.textAlign = 'right'; ctx.fillText('예측 →', W - 2, padTop); }

  // 호버 커서(세로선 + 점)
  if (opts.cursor != null && opts.cursor >= 0 && opts.cursor < N) {
    const i = opts.cursor;
    const val = i < HN ? hist[i] : (fc ? fc.median[i - HN] : null);
    if (val != null) {
      ctx.beginPath(); ctx.moveTo(x(i), padTop); ctx.lineTo(x(i), H - padBot);
      ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.stroke();
      ctx.beginPath(); ctx.arc(x(i), y(val), 4, 0, 2 * Math.PI);
      ctx.fillStyle = i < HN ? histCol : C.warn; ctx.fill();
      ctx.strokeStyle = C.surface; ctx.lineWidth = 2; ctx.stroke();
    }
  }
}

// ---------- 차트 호버 툴팁 ----------
let _tip;
function getTip() {
  if (!_tip) { _tip = document.createElement('div'); _tip.className = 'chart-tip'; document.body.appendChild(_tip); }
  return _tip;
}
function hideTip() { if (_tip) _tip.style.display = 'none'; }
function showTip(c, i, e) {
  const HN = c.geom.HN;
  let html;
  if (i < HN) {
    const ms = c.dates && c.dates[i];
    const ds = ms ? new Date(ms).toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' }) : `${i + 1}일차`;
    html = `<div class="tt-d">${ds}</div><div class="tt-p">${fmtPrice({ price: c.hist[i], currency: c.currency })}</div>`;
  } else {
    const j = i - HN, m = c.fc.median[j], lo = c.fc.lower[j], up = c.fc.upper[j];
    html = `<div class="tt-d">예측 +${j + 1}거래일</div><div class="tt-p">${fmtPrice({ price: m, currency: c.currency })}</div>
      <div class="tt-r">범위 ${fmtPrice({ price: lo, currency: c.currency })} ~ ${fmtPrice({ price: up, currency: c.currency })}</div>`;
  }
  const tip = getTip(); tip.innerHTML = html; tip.style.display = 'block';
  let x = e.clientX + 14, yy = e.clientY - 12;
  if (x + tip.offsetWidth > window.innerWidth - 8) x = e.clientX - tip.offsetWidth - 14;
  if (yy + tip.offsetHeight > window.innerHeight - 8) yy = window.innerHeight - tip.offsetHeight - 8;
  tip.style.left = x + 'px'; tip.style.top = Math.max(8, yy) + 'px';
}
function attachHover(cv) {
  cv.onmousemove = (e) => {
    const c = cv.__c; if (!c || !c.hist) return;
    const rect = cv.getBoundingClientRect();
    const { padL, padR, W, N } = c.geom;
    let i = Math.round((e.clientX - rect.left - padL) / (W - padL - padR) * (N - 1));
    i = Math.max(0, Math.min(N - 1, i));
    drawChart(cv, c.hist, c.fc, { dates: c.dates, currency: c.currency, cursor: i });
    showTip(c, i, e);
  };
  cv.onmouseleave = () => {
    const c = cv.__c; if (c) drawChart(cv, c.hist, c.fc, { dates: c.dates, currency: c.currency });
    hideTip();
  };
}

// ---------- 시장 분위기 + 지수 ----------
async function loadMarket() {
  try {
    const m = await loadData('market.json');
    state.market = m;
    renderMood(m.mood || {});
    // 국내 / 미국 / 환율 세 묶음의 줄 목록 — 작은 카드 7개가 줄바꿈되며 하나만 남던 배치를 없애고, 휴대폰에서 높이를 절반으로.
    // 지수 변동폭은 '포인트'라 통화 기호를 붙이지 않는다(예전엔 미국 지수에 $가 붙었다).
    const num2 = (v) => Math.abs(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const row = (name, price, change, pct, unit = '') => {
      const c = dirClass(pct);
      const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '–';
      return `<div class="idx-row"><span class="nm">${esc(name)}</span>
        <span class="pv">${price}${unit ? `<span class="fx-u">${unit}</span>` : ''}</span>
        <span class="ch ${c}-c">${arrow} ${num2(change)}</span><span class="pc ${c}-c">${fmtPct(pct)}</span></div>`;
    };
    const idxRow = (i) => row(i.name, (i.price ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 }), i.change, i.changePct);
    const fxRow = (f) => row(f.name, (f.price ?? 0).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), f.change, f.changePct, '원');
    const idx = m.indices || [];
    const groups = [
      ['국내 지수', idx.filter((i) => i.currency === 'KRW').map(idxRow)],
      ['미국 지수', idx.filter((i) => i.currency !== 'KRW').map(idxRow)],
      ['환율', (m.forex || []).map(fxRow)],
    ].filter(([, rows]) => rows.length);
    $('#indices').innerHTML = groups.map(([title, rows]) => `<div class="idx-group"><div class="idx-gt">${title}</div>${rows.join('')}</div>`).join('')
      || '<div class="muted">지수 데이터를 불러오지 못했습니다.</div>';
    try { renderBriefs(m.briefs); } catch (e) { console.warn('브리핑 렌더 실패:', e); } // 브리핑이 깨져도 게이지·지수는 유지
  } catch (e) {
    $('#moodLabel').textContent = '시장 데이터 대기 중'; $('#moodSummary').textContent = '아직 데이터가 생성되지 않았을 수 있어요(첫 갱신 대기).';
  }
}

// ---------- 코스피·코스닥 급등락 핵심 이유 + 수급 (메인 배너) ----------
function renderBriefs(briefs) {
  const el = $('#briefs');
  if (!el) return;
  if (!briefs || !briefs.length) { el.innerHTML = ''; return; }
  el.innerHTML = briefs.map((b) => {
    const pct = b.changePct ?? 0;
    const dirCls = pct < 0 ? 'down' : pct > 0 ? 'up' : 'flat';
    const cardCls = pct < 0 ? 'brief-down' : pct > 0 ? 'brief-up' : '';
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '–';
    const label = pct <= -1 ? '급락 핵심 이유' : pct >= 1 ? '급등 핵심 이유' : '오늘의 핵심';
    const ai = b.reason && b.reason.ai;
    let reasonBlock;
    if (ai && ai.items && ai.items.length) {
      const items = ai.items.map((it) => `<div class="ai-item">
        ${extLink(it.link, it.title)}
        ${it.why ? `<span class="ai-why">— ${esc(it.why)}</span>` : ''}</div>`).join('');
      const at = fmtAiTime(b.reason.aiAt); // 한도 배분으로 이전 판단을 이어 쓸 수 있어 분석 시각을 함께 보여준다
      // 근거 뉴스는 접을 수 있게 — 휴대폰에선 처음에 접어 둔다(펼친 상태는 새로고침해도 유지)
      const key = String(b.key || b.name);
      const open = state.briefOpen.has(key) ? state.briefOpen.get(key) : !isNarrow();
      reasonBlock = `<div class="brief-reason"><span class="ai-badge">AI 핵심</span>${esc(ai.summary)}${at ? ` <span class="ai-at">${esc(at)} 분석</span>` : ''}</div>
        <details class="ai-items-d" data-key="${esc(key)}"${open ? ' open' : ''}><summary>근거 뉴스 ${ai.items.length}건</summary>
        <div class="ai-items">${items}</div></details>`;
    } else {
      const heads = (b.reason && b.reason.headlines) || [];
      const top = heads[0];
      const reasonHtml = top
        ? `${extLink(top.link, top.title)} <span class="brief-src">${esc(top.source || '')}</span>`
        : '<span class="muted">관련 뉴스를 찾지 못했습니다.</span>';
      const more = heads.slice(1, 3).map((h) => extLink(h.link, h.title)).join('<span class="dot">·</span>');
      reasonBlock = `<div class="brief-reason">${reasonHtml}</div>${more ? `<div class="brief-more">${more}</div>` : ''}`;
    }
    const f = b.flow;
    const flowHtml = f
      ? `<div class="brief-flow">수급<span class="u">(억원${flowWhen(f.date)})</span>
          <span><i>외국인</i> <b class="${dirClass(f.foreign)}-c">${fmtFlow(f.foreign)}</b></span>
          <span><i>기관</i> <b class="${dirClass(f.institution)}-c">${fmtFlow(f.institution)}</b></span>
          <span><i>개인</i> <b class="${dirClass(f.personal)}-c">${fmtFlow(f.personal)}</b></span></div>`
      : '<div class="brief-flow muted">수급 데이터 없음</div>';
    return `<div class="brief ${cardCls}">
      <div class="brief-head">
        <span class="brief-name">${esc(b.name)}</span>
        <span class="brief-chg ${dirCls}-c">${arrow} ${fmtPct(pct)}</span>
        <span class="brief-tag ${dirCls}">${label}</span>
      </div>
      ${reasonBlock}
      ${flowHtml}
    </div>`;
  }).join('');
  el.querySelectorAll('details.ai-items-d').forEach((d) => d.addEventListener('toggle', () => state.briefOpen.set(d.dataset.key, d.open)));
}
const isNarrow = () => window.matchMedia('(max-width: 720px)').matches;

// ---------- 보유 종목 ----------
async function loadQuotes() {
  let data, news, hist, inv, analysis, disc, moves;
  try {
    [data, news, hist, inv, analysis, disc, moves] = await Promise.all([
      loadData('quotes.json'),
      loadData('news.json').catch(() => ({})),
      loadData('history.json').catch(() => ({})),
      loadData('investors.json').catch(() => ({})),
      loadData('analysis.json').catch(() => ({})),
      loadData('disclosures.json').catch(() => ({})),
      loadData('moves.json').catch(() => ({})),
    ]);
  } catch (e) {
    // 자동 새로고침 중 일시적 실패(5xx·오프라인 등)로 이미 그려진 화면을 지우지 않는다.
    // 첫 로딩 전이라면 안내를 띄우고, 이미 표시 중이라면 기존 시세를 유지한 채 실패만 알린다.
    console.warn('시세 로드 실패:', e);
    if (state.loadedOnce) { $('#clock').textContent = '갱신 실패'; $('#clock').classList.add('warn'); $('#clock').title = '잠시 후 다시 시도합니다 — 화면은 마지막 시세'; }
    else $('#grid').innerHTML = `<div class="muted">아직 데이터가 없습니다. GitHub Actions 첫 실행을 기다려주세요.</div>`;
    return;
  }
  state.news = news || {};
  state.hist = hist || {};
  state.inv = inv || {};
  state.analysis = analysis || {};
  state.disc = disc || {};
  state.moves = moves || {};
  state.data = data;
  const clock = $('#clock');
  if (clock) { // 좁은 화면에선 '확인' 글자를 숨겨 상단바를 한 줄로
    clock.innerHTML = `<span class="clock-l">확인 </span>${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    clock.title = '화면이 마지막으로 데이터를 확인한 시각';
    clock.classList.remove('warn');
  }
  renderQuotes();
}

// 받은 데이터로 '한눈에'와 카드를 그린다 — 카드 순서만 바꿀 때는 다시 받지 않고 이것만 호출
function renderQuotes() {
  const data = state.data;
  if (!data) return;
  const quotes = data.quotes || [];
  if (!quotes.length) { $('#grid').innerHTML = '<div class="muted">추적 종목이 없습니다. 종목 편집으로 추가하세요.</div>'; return; }

  // 갱신 시각·장 상태는 시장마다 다르므로(국내 마감인데 미국은 장중 등) 그룹 헤더에서 각각 보여준다.
  $('#updated').textContent = `총 ${quotes.length}종목`;

  const ordered = orderedGroups(quotes);
  try { renderBoard(ordered, data.closed); } catch (e) { console.warn('한눈에 렌더 실패:', e); }
  // '등락 큰 순'이면 그룹 안에서 움직임이 큰 종목부터(같으면 원래 순서 유지, 수집 실패는 맨 뒤)
  const move = (q) => (q && q.ok ? Math.abs(q.changePct ?? 0) : -1);
  const html = ordered.map(({ g, list }) => {
    const shown = state.sort === 'move' ? [...list].sort((a, b) => move(b) - move(a)) : list;
    try { return renderGroup(g, shown, data.closed); }
    catch (e) { console.warn('그룹 렌더 실패:', g.key, e); return ''; }
  }).join('');
  hideTip(); // 카드를 통째로 교체하므로, 가리키던 종목의 툴팁이 화면에 남지 않게 먼저 지운다
  $('#grid').innerHTML = html || '<div class="muted">표시할 종목이 없습니다.</div>';
  if (html) state.loadedOnce = true; // 실제로 카드를 그린 뒤에만 '표시 중' 상태로 본다
  if (window.syncJump) window.syncJump(); // 그룹 수가 바뀌었을 수 있으므로 이동 버튼 상태를 다시 맞춘다

  for (const q of quotes) {
    try {
      const h = state.hist[q.code];
      const cv = document.getElementById('chart-' + cssId(q.code));
      if (cv) {
        const fc = h && h.closes ? forecast(h.closes, FORECAST_DAYS) : null;
        drawChart(cv, h && h.closes, fc, { dates: h && h.dates, currency: q.currency });
        attachHover(cv);
      }
    } catch (e) { console.warn('차트 렌더 실패:', q && q.code, e); }
  }
  for (const q of quotes) { try { renderAnalysis(q, state.analysis[q.code]); } catch (e) { console.warn('분석 렌더 실패:', q && q.code, e); } }
  for (const q of quotes) { try { renderDisc(q, state.disc[q.code]); } catch (e) { console.warn('공시 렌더 실패:', q && q.code, e); } }
  for (const q of quotes) { try { renderMoves(q, state.moves[q.code]); } catch (e) { console.warn('급등락 기록 렌더 실패:', q && q.code, e); } }
  for (const q of quotes) { try { renderNews(q, state.news[q.code]); } catch (e) { console.warn('뉴스 렌더 실패:', q && q.code, e); } }
}

// ---------- 시장(국장·미장) 그룹 ----------
const MARKET_GROUPS = [
  { key: 'KR', label: '국내 증시', hint: '코스피·코스닥' },
  { key: 'US', label: '해외 증시', hint: '미국' },
];
// market 값이 없어도 통화로 시장을 추정한다(카드 표시 로직과 동일 규칙).
function marketOf(q) { return q.market || (q.currency === 'KRW' ? 'KR' : 'US'); }
// 국장·미장을 나눠 렌더 — 종목이 많아져도 한눈에 구분되도록. 예상하지 못한 시장 값이 들어와도 종목이 사라지지 않게 별도 묶음으로.
function orderedGroups(quotes) {
  const groups = {};
  for (const q of quotes) { const m = marketOf(q); (groups[m] = groups[m] || []).push(q); }
  const known = MARKET_GROUPS.map((g) => g.key);
  const extra = Object.keys(groups).filter((k) => !known.includes(k)).map((k) => ({ key: k, label: k, hint: '' }));
  return [...MARKET_GROUPS, ...extra].filter((g) => groups[g.key] && groups[g.key].length) // 빈 묶음은 헤더도 만들지 않음
    .map((g) => ({ g, list: groups[g.key] }));
}

// 그 시장의 마지막 시세 시각 — 오늘이면 '18:17', 아니면 '10/17 05:00'(짧게: 이름표가 한 줄에 들어가게)
function lastTimeOf(list) {
  const times = list.map((q) => q.asOf).filter(Boolean).map((s) => +new Date(s)).filter(Number.isFinite);
  if (!times.length) return '';
  const d = new Date(Math.max(...times));
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// ---------- 시장 비교 · 6개월 신고가 · 지난 급등락 ----------
// 시장 현지 날짜(YYYYMMDD) — 국내는 서울, 그 밖은 뉴욕 기준(봇의 급등락 기록 날짜와 같은 규칙)
function marketYmd(ms, market) {
  const tz = market === 'KR' ? 'Asia/Seoul' : 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms).replace(/-/g, '');
}
// 내 종목 등락률의 단순 평균(보유 비중을 모르므로 종목마다 같은 무게) — 수집 실패·값 없는 종목은 뺀다
function avgPct(list) {
  const v = list.filter((q) => q && q.ok && Number.isFinite(q.changePct)).map((q) => q.changePct);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
// 같은 시장 지수(market.json의 기호) — '한눈에' 시장 머리에 내 종목 평균과 나란히
const BENCH = { KR: [['^KS11', '코스피'], ['^KQ11', '코스닥']], US: [['^GSPC', 'S&P 500'], ['^IXIC', '나스닥']] };
function benchOf(key, indices) {
  return (BENCH[key] || []).map(([sym, name]) => (indices || []).find((i) => i && i.symbol === sym && Number.isFinite(i.changePct)))
    .filter(Boolean).map((i) => ({ name: BENCH[key].find(([sym]) => sym === i.symbol)[1], pct: i.changePct }));
}
// 오늘 가격이 최근 6개월 종가(오늘 봉은 빼고) 중 가장 높으면 'high', 가장 낮으면 'low' — 차트와 같은 과거 시세 기준
function sixMonthMark(q, h) {
  const closes = h && Array.isArray(h.closes) ? h.closes : null;
  if (!q || !q.ok || !(q.price > 0) || !closes) return null;
  const at = +new Date(q.asOf), dates = Array.isArray(h.dates) ? h.dates : [];
  const m = marketOf(q);
  const lastIsToday = dates.length === closes.length && dates.length > 0 && Number.isFinite(at) && Number.isFinite(dates[dates.length - 1])
    && marketYmd(dates[dates.length - 1], m) === marketYmd(at, m);
  const prior = (lastIsToday ? closes.slice(0, -1) : closes).filter((v) => v > 0);
  if (prior.length < 60) return null; // 석 달치도 없으면(새로 상장 등) 판단 안 함
  if (q.price > Math.max(...prior)) return 'high';
  if (q.price < Math.min(...prior)) return 'low';
  return null;
}
// 지난 급등락 — 봇 기록(moves.json)에서 오늘(그 종목 시세의 날짜) 것은 빼고 최근 n건. 오늘 이유는 위 AI 분석·'왜 움직였나'에 있다
function pastMoves(q, list, n = 4) {
  const at = +new Date(q && q.asOf);
  const today = Number.isFinite(at) ? marketYmd(at, marketOf(q)) : '';
  return (Array.isArray(list) ? list : []).filter((x) => x && /^\d{8}$/.test(x.d) && Number.isFinite(x.p) && x.d !== today)
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)).slice(0, n);
}
// 시세만 알려 주는 자동 기사('OO 주가, 10월 22일 장중 …원 …% 하락'·'OO 주가 상승 중')는 '왜 움직였나'의 이유로 쓰지 않는다
// — 뉴스 목록에는 그대로 둔다. scripts/sources.mjs의 PRICE_ONLY와 같게 유지(자체 테스트가 두 곳 결과를 비교)
const PRICE_ONLY = [
  /주가,?\s*\d{1,2}월\s*\d{1,2}일\s*(?:장중|장\s?마감|애프터마켓|프리마켓|시간외|오전|오후)?\s*[\d,.]+원\s*[\d.]+%\s*(?:상승|하락|보합)$/,
  /^\S+(?:\s\S+){0,3}\s주가\s*(?:상승|하락|강세|약세|보합)\s*중$/,
  /^[^\s,…·]+\s(?:장중|장\s?초반|오전|오후)\s*[\d.]+%대?\s*(?:상승|하락|강세|약세|급등|급락)(?:\s*중|세)?$/,
  /^\S+(?:\s\S+){0,3}\s주가\s*[\d,]+원\s*(?:상승|하락|보합)\s*(?:후\s*)?장\s?마감$/,
  /^(?:\[특징주\]\s*)?[^\s,…·]+(?:\s[^\s,…·]+)?,?\s장중\s*[\d.]+%대?\s*(?:상승|하락|강세|약세)(?:하며)?\s*[\d만,.]+원\s*기록/,
  /^\S+(?:\s\S+){0,3}\s거래량\s*[\d.]+%\s*(?:증가|감소)/,
];
const priceOnly = (title) => PRICE_ONLY.some((re) => re.test(String(title ?? '').trim()));
// 이유로 쓸 뉴스 고르기 — scripts/sources.mjs의 pickReasonNews와 같게 유지(자체 테스트가 비교).
// 시세 안내·상품 상장 공지('…ELW 224종 상장')·방향이 반대인 기사('15% 급등' 기사인데 오늘은 하락 — 이유일 수 없음)는 빼고
// ① 그날 나온 같은 방향의 [특징주] → ② 그 밖의 기사 → ③ 여러 종목 나열·'[오늘의 …]' 모음 순. 같은 등급 안에서는 최신순.
const LISTING_RE = /(ELW|ETN|ETF|리츠|스팩)[^…]{0,30}상장|신규\s*상장/;
const UP_RE = /상승|강세|급등|반등|↑|오름|올라|치솟|폭등|상한가|신고가/;
const DOWN_RE = /하락|약세|급락|↓|내림|내려|떨어|폭락|하한가|신저가|주춤|추락/;
const roundupTitle = (t) => ((t.match(/[,，]/g) || []).length >= 3 && /등\s*$/.test(t)) || /^\[오늘의\s?[^\]]*\]/.test(t);
const titleDir = (t) => (UP_RE.test(t) ? 1 : 0) - (DOWN_RE.test(t) ? 1 : 0); // 1 오름 말만 · -1 내림 말만 · 0 둘 다·없음
// 그 종목의 방향 — 한 제목에 여러 종목이면('[특징주] 삼성전자 '상승' SK하이닉스 1%대 '하락'') 종목 이름 바로 뒤 10자 안의
// 오름·내림 말로, 없으면 제목 전체로 판단
function nameDir(t, names) {
  for (const n of names || []) {
    const i = n ? t.indexOf(n) : -1;
    if (i < 0) continue;
    const seg = t.slice(i + n.length, i + n.length + 10);
    const d = (UP_RE.test(seg) ? 1 : 0) - (DOWN_RE.test(seg) ? 1 : 0);
    if (d) return d;
  }
  return titleDir(t);
}
// items: 최신순 뉴스, pct: 그날 등락률, day: 그 시장 현지 날짜(YYYYMMDD), ymd(ms): 같은 기준의 날짜 함수, names: 종목 이름들
function pickReasonNews(items, pct, day, ymd, names = []) {
  const s = Math.sign(Number(pct) || 0);
  const dir = (t) => nameDir(t, names);
  const tier = (it) => (/\[특징주\]/.test(it.title) && s && dir(it.title) === s && Number.isFinite(it.pubMs) && ymd(it.pubMs) === day ? 0
    : roundupTitle(it.title) ? 2 : 1);
  return (Array.isArray(items) ? items : []).filter((it) => it && it.title && !priceOnly(it.title) && !LISTING_RE.test(it.title) && !(s && dir(it.title) === -s))
    .map((it, i) => [tier(it), i, it]).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0]?.[2] || null;
}
// O1 시장 대비 — 종목마다 같은 시장 지수와 비교(국내 상장 시장별 코스피·코스닥, 미국 나스닥 상장은 나스닥 · 그 밖은 S&P 500).
// 상장 시장(q.exch)은 봇이 검색 목록에서 붙인다 — 모르면 비교하지 않는다. 지수가 1% 넘게 움직인 날 같은 방향으로 1%p 안쪽이면 '시장 따라'
const BENCH_NAME = { '^KS11': '코스피', '^KQ11': '코스닥', '^GSPC': 'S&P 500', '^IXIC': '나스닥' };
function benchFor(q, indices) {
  const ex = String(q && q.exch || '');
  const sym = marketOf(q || {}) === 'KR' ? (ex === 'KOSPI' ? '^KS11' : ex === 'KOSDAQ' ? '^KQ11' : null) : (!ex ? null : /NASDAQ/.test(ex) ? '^IXIC' : '^GSPC');
  const i = sym && (indices || []).find((x) => x && x.symbol === sym && Number.isFinite(x.changePct));
  return i ? { sym, name: BENCH_NAME[sym], pct: i.changePct } : null;
}
function vsMarket(q, indices) {
  const b = q && q.ok && Number.isFinite(q.changePct) ? benchFor(q, indices) : null;
  if (!b) return null;
  const diff = Math.round((q.changePct - b.pct) * 100) / 100;
  return { ...b, diff, follows: Math.abs(b.pct) >= 1 && Math.sign(q.changePct) === Math.sign(b.pct) && Math.abs(diff) < 1 };
}

// ---------- 데이터 지연 경고 ----------
// 수집 봇(5분 간격)이 멈추거나 시세 출처가 막혀도 화면은 마지막 값을 그대로 보여준다 — 장중인데 오래 그대로면 알린다.
//  ① 시세가 '장중'인데 마지막 시각이 45분 넘게 지남. 국내는 15:30~16:00 체결이 없어 정상이어도 26분까지 벌어진다(실측).
//  ② 시계로는 정규장(개장 30분 뒤부터)인데 시세가 '장중'이 아님 — 봇이 오늘을 휴장(조기 폐장)으로 확인했으면(closed) 제외.
const STALE_OPEN_MIN = 45;
const REG_SESSION = { KR: ['Asia/Seoul', 9 * 60, 15 * 60 + 30], US: ['America/New_York', 9 * 60 + 30, 16 * 60] };
function marketClock(timeZone, ms) {
  const p = {};
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, weekend: p.weekday === 'Sat' || p.weekday === 'Sun', min: +p.hour * 60 + +p.minute };
}
function fmtAge(ms) {
  const m = Math.floor(ms / 60e3);
  return m < 60 ? `${m}분` : m < 48 * 60 ? `${Math.floor(m / 60)}시간` : `${Math.floor(m / 1440)}일`;
}
// 지연이면 경고 문구, 아니면 '' — valid: 수집 성공 종목, closed: quotes.json의 휴장 확인 기록
function staleOf(market, valid, closed, ms = Date.now()) {
  const last = Math.max(...valid.map((q) => +new Date(q.asOf)).filter(Number.isFinite));
  if (!Number.isFinite(last)) return '';
  const age = ms - last;
  if (valid.some((q) => q.marketStatus === 'OPEN')) return age > STALE_OPEN_MIN * 60e3 ? `${fmtAge(age)}째 갱신 없음` : '';
  const s = REG_SESSION[market];
  if (!s || age <= 30 * 60e3) return '';
  const c = marketClock(s[0], ms);
  const regular = !c.weekend && c.min >= s[1] + 30 && c.min < s[2];
  return regular && closed?.[market] !== c.day ? '개장 후 갱신 없음' : '';
}

// 시장별 묶음: 헤더(종목수·상승/하락 개수·해당 시장 장상태·갱신시각) + 그 시장의 카드 그리드
function renderGroup(g, list, closed) {
  const { valid, failed, up, down, t, stale, status } = groupInfo(g, list, closed);
  const titleId = 'mg-' + cssId(g.key);
  const cards = list.map((q) => {
    try { return renderCard(q, state.hist[q.code], state.inv[q.code]); }
    catch (e) { console.warn('카드 렌더 실패:', q && q.code, e); return errCard(q); }
  }).join('');
  return `<section class="mgroup" aria-labelledby="${titleId}">
    <div class="mgroup-head">
      <h3 class="mgroup-title" id="${titleId}">${esc(g.label)}</h3>
      ${g.hint ? `<span class="mgroup-hint">${esc(g.hint)}</span>` : ''}
      <span class="mgroup-count">${list.length}종목</span>
      ${failed && valid.length ? `<span class="mgroup-fail">${failed}개 수집 실패</span>` : ''}
      ${valid.length ? `<span class="mgroup-updown"><b class="up-c">▲ ${up}</b> <b class="down-c">▼ ${down}</b></span>` : ''}
      <span class="mgroup-status${stale ? ' stale' : ''}"${stale ? ` title="${STALE_TIP}"` : ''}>${status}${t ? ` · ${t}` : ''}</span>
    </div>
    <div class="grid">${cards}</div>
  </section>`;
}

// 시장 묶음 요약 — 그룹 이름표와 '한눈에'가 같은 기준을 쓴다.
// 수집 실패(ok:false) 종목은 집계에서 뺀다 — 넣으면 '전 종목 보합·마감'처럼 잘못 단정된다.
const STALE_TIP = '보통 5분마다 갱신됩니다. 수집 봇(GitHub Actions)이 멈췄거나 시세 출처에 문제가 있을 수 있어요 — 도움말 FAQ 참고';
function groupInfo(g, list, closed) {
  const valid = list.filter((q) => q && q.ok);
  const up = valid.filter((q) => (q.changePct ?? 0) > 0).length;
  const down = valid.filter((q) => (q.changePct ?? 0) < 0).length;
  // 오래된 '장중' 표시는 지금도 장중이라는 보장이 없으므로 지연 경고로 바꿔 보여준다
  const stale = valid.length ? staleOf(g.key, valid, closed) : '';
  // '장중 아님'과 '상태를 알 수 없음'을 구분한다(전부 실패했는데 마감이라고 하지 않도록).
  let status;
  if (!valid.length) status = '<span class="sdot warn"></span>수집 실패';
  else if (stale) status = `<span class="sdot warn"></span>${stale}`;
  else if (valid.some((q) => q.marketStatus === 'OPEN')) status = '<span class="sdot live"></span>장중';
  else if (valid.some((q) => q.marketStatus)) status = '<span class="sdot"></span>마감';
  else status = '';
  return { valid, failed: list.length - valid.length, up, down, t: lastTimeOf(valid), stale, status };
}

// ---------- 내 종목 한눈에 ----------
// 시장별 등락률 색 타일(진할수록 크게 움직임, 오른 종목부터) + ±2% 넘게 움직인 종목의 '왜' 한 줄.
// 이유는 AI 진단 → 오늘 주요 공시 → 최근 뉴스(시세 안내 기사는 건너뜀) 순으로 고른다. 이미 받은 데이터만 쓴다(추가 요청 없음).
// 타일·줄을 누르면 그 종목 카드로 이동한다.
const WHY_MIN = 2;  // % — AI 종합분석 대상 기준과 같게
const WHY_SHOW = 6; // 처음에 보여줄 줄 수(나머지는 '더 보기')
function keyDiscToday(code) {
  const today = kstYmd(Date.now());
  return (state.disc[code]?.items || []).find((x) => x && x.key && x.date === today && x.title) || null;
}
function whyOf(q) {
  const a = state.analysis[q.code];
  if (a && a.headline) return { src: 'AI', label: 'AI 진단', text: a.headline };
  const d = keyDiscToday(q.code);
  if (d) return { src: '공시', label: '오늘 주요 공시', text: `[${d.tag || '공시'}] ${d.title}` };
  const m = marketOf(q), at = +new Date(q.asOf);
  const n = pickReasonNews(state.news[q.code]?.items, q.changePct, Number.isFinite(at) ? marketYmd(at, m) : '', (ms) => marketYmd(ms, m), [q.name]);
  if (n) return { src: '뉴스', label: '최근 뉴스', text: n.title };
  return null;
}
function tileHtml(q) {
  if (!q || !q.ok) {
    return `<button type="button" class="tile err" data-code="${esc(q?.code)}" title="시세를 받지 못함 — 눌러서 이유 보기"><span class="t-nm">${esc(q?.name || q?.code)}</span><span class="t-pct">시세 없음</span></button>`;
  }
  const p = q.changePct ?? 0;
  const ap = Math.abs(p), lv = ap < 0.5 ? 0 : ap < 1.5 ? 1 : ap < 3 ? 2 : ap < 5 ? 3 : 4; // 색 진하기 5단계(0.5·1.5·3·5%) — 3% 이상은 진한 색에 흰 글자
  const disc = keyDiscToday(q.code);
  const x = extOf(q);
  const mk = sixMonthMark(q, state.hist[q.code]);
  const vs = vsMarket(q, state.market?.indices);
  const tip = `${q.name} ${fmtPct(p)}${vs ? ` · ${vs.name} 대비 ${fmtPctP(vs.diff)}${vs.follows ? '(시장 따라)' : ''}` : ''}${x ? ` · ${x.label} ${fmtPct(x.changePct)}` : ''}${mk ? ` · 6개월 ${mk === 'high' ? '신고가' : '신저가'}` : ''}${disc ? ` · 오늘 주요 공시: ${disc.title}` : ''}`;
  return `<button type="button" class="tile ${dirClass(p)} h${lv}" data-code="${esc(q.code)}" title="${esc(tip)}">
    <span class="t-nm">${esc(q.name)}</span><span class="t-pct">${fmtPct(p)}</span>${x ? `<span class="t-ext">${x.short} ${fmtPct(x.changePct)}</span>` : ''}${disc ? '<span class="t-dot" role="img" aria-label="오늘 주요 공시"></span>' : ''}</button>`;
}

// ---------- 미국 시간외(프리·애프터마켓) 가격 ----------
// 정규장 밖에서는 증권 앱이 시간외 가격을 보여줘 대시보드(정규장 종가)와 달라 보인다 — 봇이 붙인 시간외 가격(q.ext)을 함께 보여준다.
// 등락은 정규장 종가 대비, 시각은 마지막 체결이 있었던 5분봉 시각.
function extOf(q) {
  const x = q && q.ok && q.marketStatus !== 'OPEN' ? q.ext : null;
  if (!x || !Number.isFinite(x.price) || !Number.isFinite(x.changePct)) return null;
  const pre = x.session === 'pre';
  return { ...x, label: pre ? '프리마켓' : '애프터마켓', short: pre ? '프리' : '애프터' };
}
function extRow(q) {
  const x = extOf(q);
  if (!x) return '';
  const arrow = x.changePct > 0 ? '▲' : x.changePct < 0 ? '▼' : '–';
  const at = fmtAiTime(x.at);
  return `<div class="ext-row" title="정규장 밖(시간외) 거래 가격 — 등락은 정규장 종가 대비">
      <span class="ext-label">${x.label}</span> <b>${fmtPrice({ price: x.price, currency: q.currency })}</b>
      <span class="${dirClass(x.changePct)}-c">${arrow} ${fmtChange({ change: x.change, currency: q.currency })} (${fmtPct(x.changePct)})</span>${at ? ` <span class="muted">· ${esc(at)}</span>` : ''}</div>`;
}
function renderBoard(groups, closed) {
  const el = $('#board');
  if (!el) return;
  const byPct = (a, b) => (b && b.ok ? b.changePct ?? 0 : -Infinity) - (a && a.ok ? a.changePct ?? 0 : -Infinity) || 0;
  const mkts = groups.map(({ g, list }) => {
    const { valid, up, down, t, stale, status } = groupInfo(g, list, closed);
    const avg = avgPct(valid), bench = benchOf(g.key, state.market?.indices);
    const cmp = avg == null ? '' : `<span class="bm-avg" title="내 종목 등락률의 단순 평균(종목마다 같은 무게) — 같은 시장 지수와 비교">평균 <b class="${dirClass(avg)}-c">${fmtPct(avg)}</b>`
      + `${bench.map((b) => `<span class="bm-idx">${esc(b.name)} <b class="${dirClass(b.pct)}-c">${fmtPct(b.pct)}</b></span>`).join('')}</span>`;
    return `<div class="bm" style="--n:${list.length}">
      <div class="bm-head"><span class="bm-title">${esc(g.label)}</span>
        ${valid.length ? `<span class="mgroup-updown"><b class="up-c">▲ ${up}</b> <b class="down-c">▼ ${down}</b></span>` : ''}${cmp}
        <span class="bm-status${stale ? ' stale' : ''}"${stale ? ` title="${STALE_TIP}"` : ''}>${status}${t ? ` · ${t}` : ''}</span></div>
      <div class="tiles">${[...list].sort(byPct).map(tileHtml).join('')}</div>
    </div>`;
  }).join('');
  // 왜 움직였나 — 시장 순서(국내 → 해외)대로, 그 안에서 많이 움직인 종목부터
  const movers = groups.flatMap(({ list }) => list.filter((q) => q && q.ok && Math.abs(q.changePct ?? 0) >= WHY_MIN)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)));
  const show = isNarrow() ? 4 : WHY_SHOW; // 휴대폰은 처음에 4줄
  const rows = movers.map((q, i) => {
    const w = whyOf(q), p = q.changePct, vs = vsMarket(q, state.market?.indices);
    return `<button type="button" class="why-row${i >= show && !state.whyAll ? ' more' : ''}" data-code="${esc(q.code)}">
      <span class="w-pct ${dirClass(p)}-c">${p > 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(2)}%</span>
      <span class="w-nm">${esc(q.name)}</span>
      <span class="w-txt">${vs && vs.follows ? `<span class="src mkt" title="같은 날 ${esc(vs.name)} ${fmtPct(vs.pct)} — 시장 전체와 비슷하게 움직임(차이 ${fmtPctP(vs.diff)})">시장 따라</span>` : ''}${w ? `<span class="src" title="${esc(w.label)}">${w.src}</span>${esc(w.text)}` : '<span class="muted">아직 이유 정보가 없어요(뉴스·공시·AI 대기)</span>'}</span>
    </button>`;
  }).join('');
  const more = movers.length > show && !state.whyAll ? `<button type="button" class="why-more" data-why="all">${movers.length - show}종목 더 보기<svg class="ic" aria-hidden="true"><use href="#i-chev"/></svg></button>` : '';
  el.innerHTML = `<div class="board-head"><h2 id="boardTitle">오늘 내 종목 한눈에</h2>
      <span class="board-hint">진한 색일수록 크게 움직임 · 누르면 그 종목 카드로</span></div>
    <div class="board-mkts">${mkts}</div>
    <div class="why">
      <div class="why-head">왜 움직였나 <span class="muted">±${WHY_MIN}% 이상 · 많이 움직인 순</span></div>
      ${rows || `<div class="why-none muted">오늘은 ±${WHY_MIN}% 넘게 움직인 종목이 없어요.</div>`}${more}
    </div>`;
  el.hidden = false;
}

// 카드로 이동 + 잠깐 강조(어느 카드인지 바로 보이게)
const scrollMode = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
function goToCard(code) {
  const card = document.getElementById('card-' + cssId(code));
  if (!card) return;
  card.scrollIntoView({ behavior: scrollMode(), block: 'start' });
  card.classList.remove('flash');
  void card.offsetWidth; // 연달아 눌러도 강조 애니메이션이 다시 시작되게
  card.classList.add('flash');
  clearTimeout(card._flashT);
  card._flashT = setTimeout(() => card.classList.remove('flash'), 1800);
}
$('#board')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-why="all"]')) { state.whyAll = true; renderQuotes(); return; }
  const b = e.target.closest('[data-code]');
  if (b) goToCard(b.dataset.code);
});

// ---------- 카드 순서 (내 순서 / 등락 큰 순) — 이 기기에 기억 ----------
const SORT_KEY = 'stockdash.sort';
try { const s = localStorage.getItem(SORT_KEY); if (s === 'mine' || s === 'move') state.sort = s; } catch {}
function syncSortButtons() {
  document.querySelectorAll('.seg [data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));
}
document.querySelectorAll('.seg [data-sort]').forEach((b) => b.addEventListener('click', () => {
  if (state.sort === b.dataset.sort) return;
  state.sort = b.dataset.sort;
  syncSortButtons();
  try { localStorage.setItem(SORT_KEY, state.sort); } catch {}
  renderQuotes();
}));
syncSortButtons();

// ---------- 카드 보기 (자세히 / 간단히) — 이 기기에 기억 ----------
// 종목이 많으면(30개 이상) 카드가 길어 휴대폰에서 스크롤이 매우 길다. '간단히'는 시세·AI 분석·수급만 남긴다
// (차트·예측·기간 수익률·고저·공시·뉴스는 숨김 — 공시·이유는 위 '한눈에'에 있다). 다시 받지 않고 보이기만 바꾼다.
const VIEW_KEY = 'stockdash.view';
try { const v = localStorage.getItem(VIEW_KEY); if (v === 'full' || v === 'compact') state.view = v; } catch {}
function applyView() {
  $('#grid')?.classList.toggle('compact', state.view === 'compact');
  document.querySelectorAll('.seg [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
}
document.querySelectorAll('.seg [data-view]').forEach((b) => b.addEventListener('click', () => {
  if (state.view === b.dataset.view) return;
  state.view = b.dataset.view;
  applyView();
  try { localStorage.setItem(VIEW_KEY, state.view); } catch {}
  if (state.view === 'full') redrawCharts(); // 숨겨진 채 그려진 차트를 실제 크기로
  if (window.syncJump) window.syncJump();
}));
applyView();

// 카드 렌더가 예기치 못한 데이터로 실패했을 때 보여줄 최소 안전 카드.
function errCard(q) {
  const name = esc((q && (q.name || q.code)) || '종목');
  return `<div class="stock"${q && q.code ? ` id="card-${cssId(q.code)}"` : ''}><div class="stock-head"><div class="nm">${name}</div></div>
    <div class="err">표시 중 오류가 발생했습니다.</div></div>`;
}

// 분석에 쓴 입력 — 미국 종목은 수급이 없고, 공시는 분석 당시 입력(sig)에 공시 접수번호가 있을 때만
function basisOf(q, data) {
  if (marketOf(q) === 'US') return '뉴스·추세';
  return String(data?.sig || '').includes('|d:') ? '뉴스·공시·수급·추세' : '뉴스·수급·추세';
}

// ---------- 지난 급등락 (봇이 ±2% 넘게 움직인 날마다 남긴 등락·이유) ----------
const MOVE_SRC = { ai: 'AI', disc: '공시', news: '뉴스' };
// 같은 시장 지수 대비 — 0에 가까우면 시장 전체와 비슷하게 움직인 것
function vsRow(q) {
  const v = vsMarket(q, state.market?.indices);
  if (!v) return '';
  return `<div class="vs-row" title="같은 날 ${esc(v.name)} 등락(${fmtPct(v.pct)})을 뺀 값 — 0에 가까우면 시장 전체와 비슷하게 움직인 것">`
    + `${esc(v.name)} ${fmtPct(v.pct)} 대비 <b class="${dirClass(v.diff)}-c">${fmtPctP(v.diff)}</b>${v.follows ? ' <span class="src mkt">시장 따라</span>' : ''}</div>`;
}
function renderMoves(q, list) {
  const el = document.getElementById('moves-' + cssId(q.code));
  if (!el) return;
  const rows = pastMoves(q, list);
  if (!rows.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = `<div class="news-head"><span>지난 급등락</span><span class="disc-src">±2% 넘게 움직인 날 · 그날의 이유</span></div>`
    + rows.map((x) => `<div class="news-item mv-item"><span class="mv-d">${+x.d.slice(4, 6)}/${+x.d.slice(6, 8)}</span>`
      + `<span class="mv-p ${dirClass(x.p)}-c">${x.p > 0 ? '▲' : '▼'} ${Math.abs(x.p).toFixed(2)}%</span>`
      + `<span class="mv-r">${x.r ? `${MOVE_SRC[x.s] ? `<span class="src">${MOVE_SRC[x.s]}</span>` : ''}${esc(x.r)}` : '<span class="muted">이유 기록 없음</span>'}</span></div>`).join('');
  el.hidden = false;
}

// ---------- 최근 공시(국내 종목, OpenDART 인증키가 있을 때만 데이터가 있음) ----------
// 주가에 영향이 큰 종류(실적·계약·증자 등)는 강조, '위험'(횡령·거래정지 등)은 빨강, 오늘 접수분은 '오늘'
const DART_VIEW = 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=';
const kstYmd = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
function renderDisc(q, data) {
  const el = document.getElementById('disc-' + cssId(q.code));
  if (!el) return;
  const items = (data && Array.isArray(data.items) ? data.items : []).filter((x) => x && /^\d{14}$/.test(String(x.no)) && x.title);
  if (!items.length) { el.hidden = true; el.innerHTML = ''; return; }
  const today = kstYmd(Date.now());
  const rows = items.slice(0, Math.abs(q.changePct ?? 0) >= MOVER_THRESHOLD ? 5 : 3).map((x) => {
    const d = String(x.date || '');
    const when = d === today ? '<b class="disc-today">오늘</b>' : /^\d{8}$/.test(d) ? `${+d.slice(4, 6)}/${+d.slice(6, 8)}` : '';
    const cls = x.tag === '위험' ? 'risk' : x.key ? 'key' : 'neutral';
    return `<div class="news-item"><span class="tag ${cls}">${esc(x.tag || '기타')}</span>
      <span>${extLink(DART_VIEW + x.no, x.title)} <span class="news-time">${when}</span></span></div>`;
  }).join('');
  el.innerHTML = `<div class="news-head"><span>최근 공시</span><span class="disc-src">전자공시(DART)</span></div>${rows}`;
  el.hidden = false;
}

// 급등락 종목 AI 종합분석 — 한 줄 진단은 항상 보이고, 클릭하면 종합분석·핵심요인·관전포인트가 펼쳐진다.
function renderAnalysis(q, data) {
  const el = document.getElementById('analysis-' + cssId(q.code));
  if (!el) return;
  if (!data || !data.headline) { el.innerHTML = ''; return; } // 분석은 변동 큰 종목에만 생성됨
  const dirCls = (q.changePct ?? 0) < 0 ? 'down' : (q.changePct ?? 0) > 0 ? 'up' : 'flat';
  const factors = (data.factors || []).map((f) => `<li>${esc(f)}</li>`).join('');
  const detail = `${data.summary ? `<p class="an-summary">${esc(data.summary)}</p>` : ''}`
    + `${factors ? `<ul class="an-factors">${factors}</ul>` : ''}`
    + `${data.outlook ? `<p class="an-outlook"><b>관전 포인트</b>${esc(data.outlook)}</p>` : ''}`
    + `<p class="an-disc">AI가 ${basisOf(q, data)}를 종합한 추정입니다${fmtAiTime(data.at) ? `(${esc(fmtAiTime(data.at))} 분석)` : ''}. 투자조언이 아닙니다.</p>`;
  const wasOpen = state.openAnalysis.has(q.code); // 새로고침 전에 펼쳐 뒀다면 그대로 유지
  el.innerHTML = `<button class="an-toggle ${dirCls}" type="button" aria-expanded="${wasOpen}">
      <span class="an-badge">AI 종합분석</span>
      <span class="an-head">${esc(data.headline)}</span>
      <span class="an-caret"><svg class="ic" aria-hidden="true"><use href="#i-chev"/></svg></span>
    </button>
    <div class="an-detail"${wasOpen ? '' : ' hidden'}>${detail}</div>`;
  el.classList.toggle('open', wasOpen);
  const btn = el.querySelector('.an-toggle');
  const box = el.querySelector('.an-detail');
  btn.addEventListener('click', () => {
    const open = box.hasAttribute('hidden');
    if (open) { box.removeAttribute('hidden'); state.openAnalysis.add(q.code); }
    else { box.setAttribute('hidden', ''); state.openAnalysis.delete(q.code); }
    btn.setAttribute('aria-expanded', String(open));
    el.classList.toggle('open', open);
  });
}

// 수급 날짜 표시 — 종목 수급은 장 마감 후 저녁에 그날 확정치가 나와 장중엔 전 거래일 값이다.
// 오늘 등락 옆에 날짜 없이 붙으면 '급등했는데 다 팔았다'처럼 보여 헷갈리므로 ' · 오늘' / ' · 10/20 기준'을 붙인다.
const FLOW_TIP = '종목별 투자자 수급은 장 마감 후 저녁(20시 이후)에 그날 확정치가 나와요. 장중에는 전 거래일 값이니 날짜를 확인하세요.';
function flowWhen(d) {
  const s = String(d ?? '');
  if (!/^\d{8}$/.test(s)) return '';
  return s === kstYmd(Date.now()) ? ' · 오늘' : ` · ${+s.slice(4, 6)}/${+s.slice(6, 8)} 기준`;
}

function retSpan(label, v) {
  if (v == null) return `<span class="ret"><i>${label}</i> —</span>`;
  return `<span class="ret"><i>${label}</i> <b class="${dirClass(v)}-c">${fmtPct(v)}</b></span>`;
}

function renderCard(q, hist, inv) {
  const id = cssId(q.code);
  if (!q.ok) {
    // 계속 실패하는 종목(티커 오타·상장폐지·국내/미국 외 종목)은 이유와 고치는 방법을 함께 보여준다
    return `<div class="stock stock-err" id="card-${id}">
      <div class="stock-head"><div class="nm">${esc(q.name)}<span class="code">${esc(q.code)}</span></div><span class="badge flat">시세 없음</span></div>
      <div class="err">시세를 받지 못했어요${q.error ? ` <span class="muted">(${esc(q.error)})</span>` : ''}</div>
      <p class="err-help">국내 6자리 코드·미국 상장 티커만 지원해요. 티커가 틀렸거나 상장폐지·다른 나라 종목이면 계속 실패하니, 종목 편집에서 고치거나 빼 주세요.</p>
      <button type="button" class="btn err-edit" data-open-editor><svg class="ic" aria-hidden="true"><use href="#i-edit"/></svg>종목 편집 열기</button></div>`;
  }
  const c = dirClass(q.changePct);
  const isMover = Math.abs(q.changePct ?? 0) >= MOVER_THRESHOLD;
  const moverCls = isMover ? (q.changePct > 0 ? 'mover-up' : 'mover-down') : '';
  let badge = '';
  if (isMover) badge = q.changePct > 0
    ? `<span class="badge up">급등 ${fmtPct(q.changePct)}</span>`
    : `<span class="badge down">급락 ${fmtPct(q.changePct)}</span>`;
  const mk = sixMonthMark(q, hist);
  if (mk) badge = `<span class="badge mark ${mk}" title="오늘 가격이 최근 6개월 종가 중 가장 ${mk === 'high' ? '높음' : '낮음'}">6개월 ${mk === 'high' ? '신고가' : '신저가'}</span>${badge}`;
  const arrow = q.changePct > 0 ? '▲' : q.changePct < 0 ? '▼' : '–';
  const status = q.marketStatus === 'OPEN' ? '<span class="sdot live"></span>장중' : '<span class="sdot"></span>마감';

  const closes = hist && hist.closes;
  const retRow = closes
    ? `<div class="rets">${retSpan('1주', periodReturn(closes, 5))}${retSpan('1개월', periodReturn(closes, 21))}${retSpan('3개월', periodReturn(closes, 63))}</div>`
    : '';
  const fc = closes ? forecast(closes, FORECAST_DAYS) : null;
  let fcRow = '';
  if (fc) {
    const target = fmtPrice({ price: fc.median[fc.median.length - 1], currency: q.currency });
    fcRow = `<div class="fc"><span class="fc-k">예측</span>약 ${FORECAST_DAYS}거래일 뒤 <b>${target}</b>
      <span class="${dirClass(fc.expReturnPct)}-c">(중앙값 ${fmtPct(fc.expReturnPct)})</span>
      <span class="muted">· 변동범위 ±${fc.endBandPct.toFixed(1)}%</span>
      <span class="fc-note" title="최근 60거래일 추세·변동성 기반 단순 통계 추정. 실제와 다를 수 있으며 투자조언 아님.">참고용</span></div>`;
  }
  // 순매수는 모든 주체를 더하면 0 — 외국인·기관·개인이 모두 같은 방향이면 반대편(기타법인 등)을 함께 보여준다
  const three = inv ? [inv.foreign, inv.institution, inv.individual] : [];
  const sameDir = three.length && three.every((v) => Number.isFinite(v)) && (three.every((v) => v > 0) || three.every((v) => v < 0));
  const etc = sameDir ? -(inv.foreign + inv.institution + inv.individual) : 0;
  const flowOld = inv && /^\d{8}$/.test(String(inv.date ?? '')) && String(inv.date) !== kstYmd(Date.now()); // 오늘 값이 아님
  const flowRow = inv ? `<div class="flow"><span class="flow-label${flowOld ? ' old' : ''}" title="${esc(FLOW_TIP)}">수급${flowWhen(inv.date)}</span>
      <span><i>외국인</i> <b class="${dirClass(inv.foreign)}-c">${fmtShares(inv.foreign)}</b></span>
      <span><i>기관</i> <b class="${dirClass(inv.institution)}-c">${fmtShares(inv.institution)}</b></span>
      <span><i>개인</i> <b class="${dirClass(inv.individual)}-c">${fmtShares(inv.individual)}</b></span>
      ${etc ? `<span title="외국인·기관·개인이 모두 같은 방향일 때의 반대편(기타법인 등). 순매수 합계는 0"><i>기타</i> <b class="${dirClass(etc)}-c">${fmtShares(etc)}</b></span>` : ''}
      ${inv.foreignRatio ? `<span class="muted">외인 ${esc(inv.foreignRatio)}</span>` : ''}</div>` : '';

  // 순서: 시세 → AI 분석(왜 움직였나, 급등락 종목) → 기간 수익률·차트·예측 → 수급·고저 → 지난 급등락 → 공시 → 뉴스
  return `<div class="stock ${moverCls}" id="card-${id}">
    <div class="stock-head">
      <div class="nm">${esc(q.name)}<span class="code">${esc(q.code)}</span></div>
      ${badge ? `<div class="badges">${badge}</div>` : ''}
    </div>
    <div class="price-row">
      <span class="price">${fmtPrice(q)}</span>
      <span class="chg ${c}-c">${arrow} ${fmtChange({ change: q.change, currency: q.currency })} (${fmtPct(q.changePct)})</span>
    </div>
    ${extRow(q)}
    ${vsRow(q)}
    <div class="analysis" id="analysis-${id}"></div>
    ${retRow}
    <div class="chart"><canvas id="chart-${id}"></canvas></div>
    ${fcRow}
    ${flowRow}
    <div class="meta">
      <span>고 <b>${q.high != null ? fmtPrice({ price: q.high, currency: q.currency }) : '—'}</b></span>
      <span>저 <b>${q.low != null ? fmtPrice({ price: q.low, currency: q.currency }) : '—'}</b></span>
      <span>거래량 <b>${fmtVol(q.volume)}</b></span>
      <span>${status}</span>
    </div>
    <div class="news moves" id="moves-${id}" hidden></div>
    ${marketOf(q) === 'KR' ? `<div class="news disc" id="disc-${id}" hidden></div>` : ''}
    <div class="news" id="news-${id}"></div>
  </div>`;
}

function renderNews(q, data) {
  const el = document.getElementById('news-' + cssId(q.code));
  if (!el) return;
  const items = (data && data.items) || [];
  const sum = data && data.summary;
  const isMover = Math.abs(q.changePct ?? 0) >= MOVER_THRESHOLD;
  const head = isMover ? `<span>${q.changePct > 0 ? '급등' : '급락'} 관련 뉴스</span>` : '<span>최근 뉴스</span>';
  const sumHtml = sum ? `<span class="news-sum ${esc(sum.tone)}">${esc(sum.label)} (호재 ${esc(sum.pos)}·악재 ${esc(sum.neg)})</span>` : '';
  if (!items.length) {
    el.innerHTML = `<div class="news-head">${head}${sumHtml}</div><div class="muted" style="font-size:12px">관련 뉴스를 찾지 못했습니다.</div>`;
    return;
  }
  const rows = items.slice(0, isMover ? 5 : 3).map((it) => {
    const s = it.sentiment || { tone: 'neutral', label: '중립', keywords: [] };
    const kw = s.keywords && s.keywords.length ? `<span class="kw"> · ${esc(s.keywords.join(', '))}</span>` : '';
    return `<div class="news-item">
      <span class="tag ${esc(s.tone)}">${esc(s.label)}</span>
      <span>${extLink(it.link, it.title)}
        <span class="news-time">${esc(it.source || '')} ${esc(it.time || '')}</span>${kw}</span></div>`;
  }).join('');
  el.innerHTML = `<div class="news-head">${head}${sumHtml}</div>${rows}`;
}

// ---------- 루프 ----------
// 한 번의 갱신 실패가 자동갱신 루프(setInterval)를 멈추지 않도록 각 호출의 거부를 삼킨다.
// ---------- AI 상태 (화면 하단) ----------
// 파이프라인이 회차마다 기록한 status.json을 사람이 읽을 수 있는 한 줄로 보여준다.
// 파일이 아직 없거나(첫 실행 전) 읽기 실패면 표시하지 않는다.
// [상태 점 색(.sdot), 문구] — live 초록 · '' 회색 · warn 주황 · bad 빨강
const AI_STATE = {
  ok: ['live', 'AI 정상'],
  idle: ['', 'AI 대기 — 아직 새로 분석할 변동 없음'],
  wait: ['', 'AI 순서 대기 — 국내 장 시간 우선 배분'],
  off: ['', 'AI 꺼짐 — 키 미설정'],
  quota: ['warn', 'AI 일시 중지 — 무료 한도 소진(자동 재개)'],
  error: ['warn', 'AI 응답 오류(일시적)'],
  auth: ['bad', 'AI 오류 — 키 확인 필요'],
  'no-model': ['bad', 'AI 오류 — 사용 가능한 모델 없음'],
};
const AI_OUT = { quota: '한도 소진', unavailable: '사용 불가' };
// 다음 AI 분석 가능 시각 — 오늘이면 '22:58', 내일이면 '내일 09:07', 그 뒤면 '10. 20. 09:07'. 이미 지났으면 '곧'
function fmtNextAt(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms <= Date.now() + 60e3) return '곧';
  const d = new Date(ms), today = new Date();
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === today.toDateString()) return hm;
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `내일 ${hm}`;
  return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
async function loadStatus() {
  const el = $('#aiStatus');
  const dEl = $('#dartStatus');
  if (!el) return;
  try {
    const st = await loadData('status.json');
    // 공시 수집이 멈췄으면(키 오류·하루 한도 초과·점검) 이유를 한 줄로 — 정상('ok')이거나 키가 없으면(값 없음) 숨김
    if (dEl) {
      const d = st?.dart;
      dEl.hidden = !(typeof d === 'string' && d && d !== 'ok');
      dEl.innerHTML = dEl.hidden ? '' : `<span class="sdot warn"></span>${esc(`공시 수집 멈춤 — ${d}`)}`;
    }
    const ai = st?.ai;
    if (!ai || !AI_STATE[ai.state]) { el.hidden = true; return; }
    const [dot, baseLabel] = AI_STATE[ai.state];
    const next = ai.state === 'wait' ? fmtNextAt(ai.next) : '';
    const label = next ? `AI 순서 대기 — 다음 분석 ${next === '곧' ? '곧 재개' : `${next}부터`} (국내 장 우선 배분)` : baseLabel;
    const count = Number.isFinite(ai.used) && Number.isFinite(ai.cap) && ai.cap > 0 ? ` · 무료 한도 ${ai.used}/${ai.cap}회` : '';
    el.innerHTML = `<span class="sdot${dot ? ' ' + dot : ''}"></span>${esc(label + count)}`;
    // 자세한 내용은 마우스를 올리면 — 모델별 사용 횟수·제외된 모델·초기화 시각
    const obj = (o) => (o && typeof o === 'object' ? Object.entries(o) : []);
    const per = obj(st.budget?.used).map(([m, n]) => `${m} ${n}회`);
    const outs = obj(st.budget?.out).map(([m, w]) => `${m}(${AI_OUT[w] || w})`);
    el.title = [
      ai.model ? `최근 사용 모델: ${ai.model}` : '',
      per.length ? `모델별 사용: ${per.join(', ')}` : '',
      outs.length ? `오늘 제외: ${outs.join(', ')}` : '',
      count ? '무료 한도는 매일 오후 4시(겨울철 5시)에 초기화되며, 국내 장 시간에 우선 배분됩니다.' : '',
    ].filter(Boolean).join('\n');
    el.hidden = false;
  } catch { el.hidden = true; if (dEl) dEl.hidden = true; }
}

async function tick() {
  await loadManifest(); // 지문 먼저(작음) — 바뀐 파일만 받는다
  loadStatus().catch(() => {});
  await loadMarket().catch((e) => console.warn('시장 갱신 실패:', e)); // 지수 먼저 — 카드·'한눈에'의 시장 대비가 같은 회차 지수를 쓰게
  loadQuotes().catch((e) => console.warn('종목 갱신 실패:', e));
}
function restartTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  // 다른 탭·앱을 보는 동안엔 자동 새로고침을 쉰다(데이터·배터리 절약) — 돌아오면 아래 visibilitychange가 바로 갱신
  if (state.intervalSec > 0 && !document.hidden) state.timer = setInterval(tick, state.intervalSec * 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (state.timer) clearInterval(state.timer); state.timer = null; }
  else { tick(); restartTimer(); }
});

// index.html 구조 변경 등으로 요소가 없어도 스크립트 초기화가 중단되지 않도록 옵셔널 체이닝으로 보호.
$('#refreshBtn')?.addEventListener('click', tick);
$('#interval')?.addEventListener('change', (e) => { state.intervalSec = +e.target.value; restartTimer(); });
// 리사이즈는 드래그 중 초당 수십 번 발생한다. 종목이 늘면 그때마다 차트를 전부 다시 그려 버벅이므로
// 크기 조절이 멈춘 뒤 한 번만 다시 그린다(디바운스).
let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    redrawCharts();
  }, 150);
});
// 보이는 크기에 맞춰 차트를 다시 그린다 — 창 크기 변경, '간단히'에서 '자세히'로 바꿀 때(숨겨진 채 그려진 차트 보정)
function redrawCharts() {
  document.querySelectorAll('.chart canvas').forEach((cv) => {
    try { const c = cv.__c; if (c && cv.clientWidth) drawChart(cv, c.hist, c.fc, { dates: c.dates, currency: c.currency }); }
    catch (e) { console.warn('차트 다시 그리기 실패:', e); }
  });
}
// 시세를 못 받는 종목 카드의 '종목 편집 열기'
$('#grid')?.addEventListener('click', (e) => { if (e.target.closest('[data-open-editor]')) $('#editBtn')?.click(); });
// 최후의 안전망: 어디서든 처리되지 않은 비동기 오류가 나도 콘솔 경고만 남기고 페이지는 동작 유지.
window.addEventListener('unhandledrejection', (e) => console.warn('처리되지 않은 비동기 오류:', e.reason));

// ---------- 상단바 높이 동기화 ----------
// 스티키 그룹 헤더가 상단바 바로 아래에 붙어야 한다. 좁은 창에서 상단바가 줄바꿈되면
// 높이가 변하므로 하드코딩하지 않고 실제 높이를 CSS 변수로 계속 맞춘다.
const _topbar = document.querySelector('.topbar');
let syncTopbar = () => {};
if (_topbar) {
  let _lastTbH = -1;
  syncTopbar = () => {
    const h = _topbar.offsetHeight;
    if (h && h !== _lastTbH) { _lastTbH = h; document.documentElement.style.setProperty('--topbar-h', h + 'px'); }
  };
  syncTopbar();
  // ResizeObserver는 렌더링이 멈춘 상태(백그라운드 탭 등)에서 발화하지 않아 값이 굳을 수 있다.
  // 그래서 관찰자에만 의존하지 않고, 스크롤·갱신 시점(syncJump)에서도 다시 맞춘다.
  if (window.ResizeObserver) new ResizeObserver(syncTopbar).observe(_topbar);
  window.addEventListener('resize', syncTopbar);
}

// ---------- 시장 간 이동 · 맨 위로 ----------
// 목적지가 국내·해외 둘뿐이라 버튼 2개를 고정하면 늘 하나는 '지금 보고 있는 곳'이라 낭비다.
// 그래서 버튼 하나가 '반대 시장'으로 라벨을 바꿔가며 일하고, 남는 자리는 '맨 위로'에 쓴다.
const _jump = $('#jump'), _jumpMkt = $('#jumpMkt'), _jumpTop = $('#jumpTop');
if (_jump && _jumpMkt && _jumpTop) {
  // #grid는 갱신 때 통째로 교체되므로 절대 캐싱하지 않고 그때그때 다시 찾는다.
  const sections = () => [...document.querySelectorAll('#grid .mgroup')];
  const topbarH = () => (_topbar ? _topbar.offsetHeight : 56);
  const smooth = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  const LAND_GAP = 8; // 착지 시 상단바 아래로 띄우는 여백
  // 판정선은 착지 위치보다 넉넉히 아래여야 한다. 그렇지 않으면 방금 이동해 온 그룹이
  // '현재'로 인식되지 않아 버튼이 계속 같은 곳을 가리킨다.
  const currentIdx = (list) => {
    const line = topbarH() + LAND_GAP + 16; let i = -1;
    list.forEach((s, n) => { if (s.getBoundingClientRect().top <= line) i = n; });
    return i;
  };
  const goTo = (el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - topbarH() - LAND_GAP, behavior: smooth() });
  const nextOf = (list) => list[(currentIdx(list) + 1 + list.length) % list.length];

  window.syncJump = function syncJump() {
    syncTopbar(); // 스티키 헤더 위치가 어긋나지 않도록 상단바 높이를 여기서도 확인
    const list = sections();
    // 첫 화면에서는 방해하지 않는다. 창 높이가 0으로 잡히는 환경(숨은 창·일부 내장 브라우저)에서도
    // 맨 위에서 버튼이 뜨지 않도록 최소 기준 300px을 둔다.
    if (window.scrollY < Math.max(window.innerHeight * 0.8, 300)) { _jump.hidden = true; return; }
    _jump.hidden = false;
    if (list.length < 2) { _jumpMkt.hidden = true; return; } // 시장이 하나뿐이면 이동 버튼은 무의미
    _jumpMkt.hidden = false;
    const next = nextOf(list);
    const name = (next.querySelector('.mgroup-title')?.textContent || '다음 시장').trim();
    _jumpMkt.textContent = name + (next.getBoundingClientRect().top > 0 ? ' ↓' : ' ↑');
  };
  _jumpMkt.addEventListener('click', () => { const l = sections(); if (l.length) goTo(nextOf(l)); });
  _jumpTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: smooth() }));
  // requestAnimationFrame은 탭이 백그라운드이거나 렌더링이 멈추면 호출되지 않아 버튼 상태가 굳는다.
  // 시간 기반 스로틀 + 마지막 위치 보정(트레일링)으로 rAF 없이도 항상 갱신되게 한다.
  let _jLast = 0, _jTimer;
  const onScroll = () => { syncJump(); hideTip(); };
  window.addEventListener('scroll', () => {
    clearTimeout(_jTimer);
    const now = Date.now();
    if (now - _jLast > 120) { _jLast = now; onScroll(); }
    else _jTimer = setTimeout(() => { _jLast = Date.now(); onScroll(); }, 120);
  }, { passive: true });
  syncJump();
}

// ---------- 화면 테마(밝게 · 어둡게) ----------
// theme.js가 <head>에서 먼저 정한 테마를 버튼으로 바꾼다. 차트는 캔버스라 테마가 바뀌면 새 색으로 다시 그린다.
const _themeBtn = $('#themeBtn');
function syncThemeBtn() {
  if (!_themeBtn) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const label = dark ? '밝은 화면으로' : '어두운 화면으로';
  _themeBtn.title = label; _themeBtn.setAttribute('aria-label', label);
  _themeBtn.querySelector('use')?.setAttribute('href', dark ? '#i-sun' : '#i-moon');
}
_themeBtn?.addEventListener('click', () => { if (window.stockTheme) window.stockTheme.toggle(); });
document.addEventListener('themechange', () => { syncThemeBtn(); hideTip(); redrawCharts(); });
syncThemeBtn();

tick();
restartTimer();
