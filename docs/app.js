// pages/app.js — GitHub Pages 정적 버전. 서버 없이 ./data/*.json 을 읽어 렌더링.
'use strict';

const MOVER_THRESHOLD = 3;
const FORECAST_DAYS = 20; // 예측 지평(거래일)
const DRIFT_DAMP = 0.35;  // 추세 감쇠 계수 — 최근 급등락이 그대로 이어진다고 보지 않도록 보수적으로
const CHART_H = 120;      // 차트 높이(px). style.css의 .chart/.chart canvas 높이와 반드시 같아야 한다.

const $ = (s) => document.querySelector(s);
// openAnalysis: 펼쳐 둔 AI 종합분석의 종목코드. 자동 새로고침으로 카드를 다시 그려도 접히지 않게 유지한다.
// loadedOnce: 한 번이라도 시세를 그렸는지. 이후의 일시적 로드 실패로 화면을 비우지 않기 위한 표시.
const state = { timer: null, intervalSec: 60, hist: {}, news: {}, inv: {}, analysis: {}, openAnalysis: new Set(), loadedOnce: false };

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
function cssId(code) { return String(code).replace(/[^a-zA-Z0-9]/g, '_'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function loadJson(name) {
  const r = await fetch(`./data/${name}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(name + ' ' + r.status);
  return r.json();
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

// ---------- 게이지 ----------
function drawGauge(canvas, score, tone) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H - 14, r = 92;
  ctx.lineWidth = 14; ctx.lineCap = 'round';
  ctx.strokeStyle = '#26303f';
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI); ctx.stroke();
  const col = tone === 'fear' ? '#4aa3ff' : tone === 'greed' ? '#ff5b5b' : '#9aa7b8';
  ctx.strokeStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, Math.PI + (score / 100) * Math.PI); ctx.stroke();
  ctx.fillStyle = '#6f7d90'; ctx.font = '10px sans-serif';
  ctx.textAlign = 'left'; ctx.fillText('공포', cx - r, cy + 12);
  ctx.textAlign = 'right'; ctx.fillText('탐욕', cx + r, cy + 12);
}

// ---------- 과거 + 예측 차트 ----------
function drawChart(canvas, closes, fc, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300, H = CHART_H;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (!closes || closes.length < 2) {
    ctx.fillStyle = '#9aa7b8'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
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
  const histCol = up ? '#ff5b5b' : '#4aa3ff';
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
    grad.addColorStop(0, 'rgba(255,180,84,0.24)'); grad.addColorStop(1, 'rgba(255,180,84,0.06)');
    ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = 'rgba(255,180,84,0.5)'; ctx.lineWidth = 1; ctx.stroke();
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
    ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.setLineDash([]);
    // 오늘 구분선
    ctx.beginPath(); ctx.moveTo(x(HN - 1), padTop); ctx.lineTo(x(HN - 1), H - padBot);
    ctx.setLineDash([2, 3]); ctx.strokeStyle = 'rgba(255,255,255,0.34)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  // 라벨 — 반드시 실제 시세의 최고/최저(hHi/hLo). y축 상한(hi/lo)은 예측 밴드가 섞여 있어 쓰면 안 된다.
  ctx.font = '10px sans-serif'; ctx.fillStyle = '#9aa7b8';
  ctx.textAlign = 'left'; ctx.fillText('6개월 최고 ' + fmtCompact(hHi, opts.currency), 2, padTop);
  ctx.fillText('6개월 최저 ' + fmtCompact(hLo, opts.currency), 2, H - 5);
  if (fc) { ctx.fillStyle = '#ffb454'; ctx.textAlign = 'right'; ctx.fillText('예측 →', W - 2, padTop); }

  // 호버 커서(세로선 + 점)
  if (opts.cursor != null && opts.cursor >= 0 && opts.cursor < N) {
    const i = opts.cursor;
    const val = i < HN ? hist[i] : (fc ? fc.median[i - HN] : null);
    if (val != null) {
      ctx.beginPath(); ctx.moveTo(x(i), padTop); ctx.lineTo(x(i), H - padBot);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.stroke();
      ctx.beginPath(); ctx.arc(x(i), y(val), 4, 0, 2 * Math.PI);
      ctx.fillStyle = i < HN ? histCol : '#ffb454'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; ctx.stroke();
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
    html = `<div class="tt-d">🔮 예측 +${j + 1}거래일</div><div class="tt-p">${fmtPrice({ price: m, currency: c.currency })}</div>
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
    const m = await loadJson('market.json');
    const mood = m.mood || {};
    drawGauge($('#moodCanvas'), mood.score ?? 0, mood.tone || 'neutral');
    $('#moodScore').textContent = mood.score ?? '--';
    $('#moodLabel').textContent = mood.label || '—';
    $('#moodSummary').textContent = mood.summary || '';
    const idxHtml = (m.indices || []).map((i) => {
      const c = dirClass(i.changePct);
      const arrow = i.changePct > 0 ? '▲' : i.changePct < 0 ? '▼' : '–';
      const price = (i.price ?? 0).toLocaleString(i.currency === 'KRW' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 2 });
      const cur = i.currency === 'KRW' ? 'KRW2' : 'USD';
      return `<div class="idx"><div class="nm">${i.name}</div>
        <div class="pv ${c}-c">${price}</div>
        <div class="ch ${c}-c">${arrow} ${fmtChange({ change: i.change, currency: cur })} (${fmtPct(i.changePct)})</div></div>`;
    }).join('');
    const fxHtml = (m.forex || []).map((f) => {
      const c = dirClass(f.changePct);
      const arrow = f.changePct > 0 ? '▲' : f.changePct < 0 ? '▼' : '–';
      const price = (f.price ?? 0).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return `<div class="idx fx"><div class="nm">💱 ${f.name}</div>
        <div class="pv ${c}-c">${price}<span class="fx-u">원</span></div>
        <div class="ch ${c}-c">${arrow} ${fmtChange({ change: f.change, currency: 'KRW2' })} (${fmtPct(f.changePct)})</div></div>`;
    }).join('');
    $('#indices').innerHTML = (idxHtml + fxHtml) || '<div class="muted">지수 데이터를 불러오지 못했습니다.</div>';
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
    const icon = pct < 0 ? '📉' : pct > 0 ? '📈' : '📊';
    const ai = b.reason && b.reason.ai;
    let reasonBlock;
    if (ai && ai.items && ai.items.length) {
      const items = ai.items.map((it) => `<div class="ai-item">
        <a href="${it.link}" target="_blank" rel="noopener">${esc(it.title)}</a>
        ${it.why ? `<span class="ai-why">— ${esc(it.why)}</span>` : ''}</div>`).join('');
      reasonBlock = `<div class="brief-reason"><span class="ai-badge">🤖 AI 핵심</span> ${esc(ai.summary)}</div>
        <div class="ai-items">${items}</div>`;
    } else {
      const heads = (b.reason && b.reason.headlines) || [];
      const top = heads[0];
      const reasonHtml = top
        ? `<a href="${top.link}" target="_blank" rel="noopener">${esc(top.title)}</a> <span class="brief-src">${esc(top.source || '')}</span>`
        : '<span class="muted">관련 뉴스를 찾지 못했습니다.</span>';
      const more = heads.slice(1, 3).map((h) => `<a href="${h.link}" target="_blank" rel="noopener">${esc(h.title)}</a>`).join('<span class="dot">·</span>');
      reasonBlock = `<div class="brief-reason">${reasonHtml}</div>${more ? `<div class="brief-more">${more}</div>` : ''}`;
    }
    const f = b.flow;
    const flowHtml = f
      ? `<div class="brief-flow">수급<span class="u">(억원)</span>
          <span><i>외국인</i> <b class="${dirClass(f.foreign)}-c">${fmtFlow(f.foreign)}</b></span>
          <span><i>기관</i> <b class="${dirClass(f.institution)}-c">${fmtFlow(f.institution)}</b></span>
          <span><i>개인</i> <b class="${dirClass(f.personal)}-c">${fmtFlow(f.personal)}</b></span></div>`
      : '<div class="brief-flow muted">수급 데이터 없음</div>';
    return `<div class="brief ${cardCls}">
      <div class="brief-head">
        <span class="brief-name">${b.name}</span>
        <span class="brief-chg ${dirCls}-c">${arrow} ${fmtPct(pct)}</span>
        <span class="brief-tag ${dirCls}">${icon} ${label}</span>
      </div>
      ${reasonBlock}
      ${flowHtml}
    </div>`;
  }).join('');
}

// ---------- 보유 종목 ----------
async function loadQuotes() {
  let data, news, hist, inv, analysis;
  try {
    [data, news, hist, inv, analysis] = await Promise.all([
      loadJson('quotes.json'),
      loadJson('news.json').catch(() => ({})),
      loadJson('history.json').catch(() => ({})),
      loadJson('investors.json').catch(() => ({})),
      loadJson('analysis.json').catch(() => ({})),
    ]);
  } catch (e) {
    // 자동 새로고침 중 일시적 실패(5xx·오프라인 등)로 이미 그려진 화면을 지우지 않는다.
    // 첫 로딩 전이라면 안내를 띄우고, 이미 표시 중이라면 기존 시세를 유지한 채 실패만 알린다.
    console.warn('시세 로드 실패:', e);
    if (state.loadedOnce) $('#clock').textContent = '⚠ 갱신 실패 · 마지막 시세';
    else $('#grid').innerHTML = `<div class="muted">아직 데이터가 없습니다. GitHub Actions 첫 실행을 기다려주세요.</div>`;
    return;
  }
  state.news = news || {};
  state.hist = hist || {};
  state.inv = inv || {};
  state.analysis = analysis || {};
  const quotes = data.quotes || [];
  if (!quotes.length) { $('#grid').innerHTML = '<div class="muted">추적 종목이 없습니다. config/watchlist.json을 편집하세요.</div>'; return; }

  // 갱신 시각·장 상태는 시장마다 다르므로(국내 마감인데 미국은 장중 등) 그룹 헤더에서 각각 보여준다.
  $('#updated').textContent = `총 ${quotes.length}종목`;
  $('#clock').textContent = '확인 ' + new Date().toLocaleTimeString('ko-KR');

  // 국장·미장을 나눠 렌더 — 종목이 많아져도 한눈에 구분되도록.
  const groups = {};
  for (const q of quotes) { const m = marketOf(q); (groups[m] = groups[m] || []).push(q); }
  const known = MARKET_GROUPS.map((g) => g.key);
  // 예상하지 못한 시장 값이 들어와도 종목이 사라지지 않도록 별도 그룹으로 함께 표시한다.
  const extra = Object.keys(groups).filter((k) => !known.includes(k)).map((k) => ({ key: k, label: k, hint: '' }));
  const html = [...MARKET_GROUPS, ...extra].map((g) => {
    const list = groups[g.key];
    if (!list || !list.length) return ''; // 빈 그룹은 헤더도 만들지 않음
    try { return renderGroup(g, list); }
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
  for (const q of quotes) { try { renderNews(q, state.news[q.code]); } catch (e) { console.warn('뉴스 렌더 실패:', q && q.code, e); } }
}

// ---------- 시장(국장·미장) 그룹 ----------
const MARKET_GROUPS = [
  { key: 'KR', label: '🇰🇷 국내 증시', hint: '코스피·코스닥' },
  { key: 'US', label: '🇺🇸 해외 증시', hint: '미국' },
];
// market 값이 없어도 통화로 시장을 추정한다(카드 표시 로직과 동일 규칙).
function marketOf(q) { return q.market || (q.currency === 'KRW' ? 'KR' : 'US'); }

function lastTimeOf(list) {
  const times = list.map((q) => q.asOf).filter(Boolean).map((s) => +new Date(s)).filter(Number.isFinite);
  if (!times.length) return '';
  return new Date(Math.max(...times)).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// 시장별 묶음: 헤더(종목수·상승/하락 개수·해당 시장 장상태·갱신시각) + 그 시장의 카드 그리드
function renderGroup(g, list) {
  // 수집 실패(ok:false) 종목은 집계에서 뺀다 — 넣으면 '전 종목 보합·마감'처럼 잘못 단정된다.
  const valid = list.filter((q) => q && q.ok);
  const failed = list.length - valid.length;
  const up = valid.filter((q) => (q.changePct ?? 0) > 0).length;
  const down = valid.filter((q) => (q.changePct ?? 0) < 0).length;
  const t = lastTimeOf(valid);
  // '장중 아님'과 '상태를 알 수 없음'을 구분한다(전부 실패했는데 마감이라고 하지 않도록).
  let status;
  if (!valid.length) status = '⚠️ 수집 실패';
  else if (valid.some((q) => q.marketStatus === 'OPEN')) status = '🟢 장중';
  else if (valid.some((q) => q.marketStatus)) status = '⚪ 마감';
  else status = '';
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
      <span class="mgroup-status">${status}${t ? ` · ${t}` : ''}</span>
    </div>
    <div class="grid">${cards}</div>
  </section>`;
}

// 카드 렌더가 예기치 못한 데이터로 실패했을 때 보여줄 최소 안전 카드.
function errCard(q) {
  const name = esc((q && (q.name || q.code)) || '종목');
  return `<div class="stock"><div class="stock-head"><div class="nm">${name}</div></div>
    <div class="err">표시 중 오류가 발생했습니다.</div></div>`;
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
    + `${data.outlook ? `<p class="an-outlook">📌 ${esc(data.outlook)}</p>` : ''}`
    + `<p class="an-disc">AI가 뉴스·수급·추세를 종합한 추정입니다. 투자조언이 아닙니다.</p>`;
  const wasOpen = state.openAnalysis.has(q.code); // 새로고침 전에 펼쳐 뒀다면 그대로 유지
  el.innerHTML = `<button class="an-toggle ${dirCls}" type="button" aria-expanded="${wasOpen}">
      <span class="an-badge">🧠 AI 종합분석</span>
      <span class="an-head">${esc(data.headline)}</span>
      <span class="an-caret">▾</span>
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

function retSpan(label, v) {
  if (v == null) return `<span class="ret"><i>${label}</i> —</span>`;
  return `<span class="ret"><i>${label}</i> <b class="${dirClass(v)}-c">${fmtPct(v)}</b></span>`;
}

function renderCard(q, hist, inv) {
  const id = cssId(q.code);
  if (!q.ok) {
    return `<div class="stock">
      <div class="stock-head"><div class="nm">${esc(q.name)}<span class="code">${q.code}</span></div></div>
      <div class="err">데이터 오류: ${esc(q.error || '')}</div></div>`;
  }
  const c = dirClass(q.changePct);
  const isMover = Math.abs(q.changePct ?? 0) >= MOVER_THRESHOLD;
  const moverCls = isMover ? (q.changePct > 0 ? 'mover-up' : 'mover-down') : '';
  let badge = '';
  if (isMover) badge = q.changePct > 0
    ? `<span class="badge up">🔺 급등 ${fmtPct(q.changePct)}</span>`
    : `<span class="badge down">🔻 급락 ${fmtPct(q.changePct)}</span>`;
  const arrow = q.changePct > 0 ? '▲' : q.changePct < 0 ? '▼' : '–';
  const status = q.marketStatus === 'OPEN' ? '🟢 장중' : '⚪ 마감';

  const closes = hist && hist.closes;
  const retRow = closes
    ? `<div class="rets">${retSpan('1주', periodReturn(closes, 5))}${retSpan('1개월', periodReturn(closes, 21))}${retSpan('3개월', periodReturn(closes, 63))}</div>`
    : '';
  const fc = closes ? forecast(closes, FORECAST_DAYS) : null;
  let fcRow = '';
  if (fc) {
    const target = fmtPrice({ price: fc.median[fc.median.length - 1], currency: q.currency });
    fcRow = `<div class="fc">🔮 약 ${FORECAST_DAYS}거래일 예측: <b>${target}</b>
      <span class="${dirClass(fc.expReturnPct)}-c">(중앙값 ${fmtPct(fc.expReturnPct)})</span>
      <span class="muted">· 변동범위 ±${fc.endBandPct.toFixed(1)}%</span>
      <span class="fc-note" title="최근 60거래일 추세·변동성 기반 단순 통계 추정. 실제와 다를 수 있으며 투자조언 아님.">ⓘ 참고용</span></div>`;
  }
  const flowRow = inv ? `<div class="flow"><span class="flow-label">수급</span>
      <span><i>외국인</i> <b class="${dirClass(inv.foreign)}-c">${fmtShares(inv.foreign)}</b></span>
      <span><i>기관</i> <b class="${dirClass(inv.institution)}-c">${fmtShares(inv.institution)}</b></span>
      <span><i>개인</i> <b class="${dirClass(inv.individual)}-c">${fmtShares(inv.individual)}</b></span>
      ${inv.foreignRatio ? `<span class="muted">외인 ${inv.foreignRatio}</span>` : ''}</div>` : '';

  return `<div class="stock ${moverCls}">
    <div class="stock-head">
      <div class="nm">${esc(q.name)}<span class="code">${q.code}</span></div>
      ${badge}
    </div>
    <div class="price-row">
      <span class="price">${fmtPrice(q)}</span>
      <span class="chg ${c}-c">${arrow} ${fmtChange({ change: q.change, currency: q.currency })} (${fmtPct(q.changePct)})</span>
    </div>
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
    <div class="analysis" id="analysis-${id}"></div>
    <div class="news" id="news-${id}"></div>
  </div>`;
}

function renderNews(q, data) {
  const el = document.getElementById('news-' + cssId(q.code));
  if (!el) return;
  const items = (data && data.items) || [];
  const sum = data && data.summary;
  const isMover = Math.abs(q.changePct ?? 0) >= MOVER_THRESHOLD;
  const head = isMover ? `<span>${q.changePct > 0 ? '📈 급등' : '📉 급락'} 관련 뉴스</span>` : `<span>📰 최근 뉴스</span>`;
  const sumHtml = sum ? `<span class="news-sum ${sum.tone}">${sum.label} (호재 ${sum.pos}·악재 ${sum.neg})</span>` : '';
  if (!items.length) {
    el.innerHTML = `<div class="news-head">${head}${sumHtml}</div><div class="muted" style="font-size:12px">관련 뉴스를 찾지 못했습니다.</div>`;
    return;
  }
  const rows = items.slice(0, isMover ? 5 : 3).map((it) => {
    const s = it.sentiment || { tone: 'neutral', label: '중립', keywords: [] };
    const kw = s.keywords && s.keywords.length ? `<span class="kw"> · ${s.keywords.join(', ')}</span>` : '';
    return `<div class="news-item">
      <span class="tag ${s.tone}">${s.label}</span>
      <span><a href="${it.link}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <span class="news-time">${esc(it.source || '')} ${esc(it.time || '')}</span>${kw}</span></div>`;
  }).join('');
  el.innerHTML = `<div class="news-head">${head}${sumHtml}</div>${rows}`;
}

// ---------- 루프 ----------
// 한 번의 갱신 실패가 자동갱신 루프(setInterval)를 멈추지 않도록 각 호출의 거부를 삼킨다.
function tick() {
  loadMarket().catch((e) => console.warn('시장 갱신 실패:', e));
  loadQuotes().catch((e) => console.warn('종목 갱신 실패:', e));
}
function restartTimer() {
  if (state.timer) clearInterval(state.timer);
  if (state.intervalSec > 0) state.timer = setInterval(tick, state.intervalSec * 1000);
}

// index.html 구조 변경 등으로 요소가 없어도 스크립트 초기화가 중단되지 않도록 옵셔널 체이닝으로 보호.
$('#refreshBtn')?.addEventListener('click', tick);
$('#interval')?.addEventListener('change', (e) => { state.intervalSec = +e.target.value; restartTimer(); });
// 리사이즈는 드래그 중 초당 수십 번 발생한다. 종목이 늘면 그때마다 차트를 전부 다시 그려 버벅이므로
// 크기 조절이 멈춘 뒤 한 번만 다시 그린다(디바운스).
let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    document.querySelectorAll('.chart canvas').forEach((cv) => {
      try { const c = cv.__c; if (c) drawChart(cv, c.hist, c.fc, { dates: c.dates, currency: c.currency }); }
      catch (e) { console.warn('리사이즈 차트 재렌더 실패:', e); }
    });
  }, 150);
});
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
    if (window.scrollY < window.innerHeight * 0.8) { _jump.hidden = true; return; } // 첫 화면에서는 방해하지 않는다
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

tick();
restartTimer();
