// pages/app.js — GitHub Pages 정적 버전. 서버 없이 ./data/*.json 을 읽어 렌더링.
'use strict';

const MOVER_THRESHOLD = 3;
const FORECAST_DAYS = 20; // 예측 지평(거래일)
const DRIFT_DAMP = 0.35;  // 추세 감쇠 계수 — 최근 급등락이 그대로 이어진다고 보지 않도록 보수적으로

const $ = (s) => document.querySelector(s);
const state = { timer: null, intervalSec: 60, hist: {}, news: {} };

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
function fmtCompact(v) { return v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2); }
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
function drawChart(canvas, closes, fc) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300, H = 150;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (!closes || closes.length < 2) {
    ctx.fillStyle = '#6f7d90'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('과거 시세 수집 중…', W / 2, H / 2);
    return;
  }
  const hist = closes, HN = hist.length, FN = fc ? fc.median.length : 0, N = HN + FN;
  let lo = Math.min(...hist), hi = Math.max(...hist);
  if (fc) { lo = Math.min(lo, ...fc.lower); hi = Math.max(hi, ...fc.upper); }
  const padTop = 10, padBot = 18, padL = 2, padR = 2, span = (hi - lo) || 1;
  const x = (i) => padL + (i / (N - 1)) * (W - padL - padR);
  const y = (v) => padTop + (1 - (v - lo) / span) * (H - padTop - padBot);
  const up = hist[HN - 1] >= hist[Math.max(0, HN - 64)];
  const histCol = up ? '#ff5b5b' : '#4aa3ff';

  if (fc) {
    // ±1σ 밴드
    ctx.beginPath();
    ctx.moveTo(x(HN - 1), y(hist[HN - 1]));
    fc.upper.forEach((v, i) => ctx.lineTo(x(HN + i), y(v)));
    for (let i = FN - 1; i >= 0; i--) ctx.lineTo(x(HN + i), y(fc.lower[i]));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,180,84,0.13)'; ctx.fill();
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
    ctx.setLineDash([2, 3]); ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  // 라벨
  ctx.font = '10px sans-serif'; ctx.fillStyle = '#6f7d90';
  ctx.textAlign = 'left'; ctx.fillText('최고 ' + fmtCompact(hi), 2, padTop);
  ctx.fillText('최저 ' + fmtCompact(lo), 2, H - 5);
  if (fc) { ctx.fillStyle = '#ffb454'; ctx.textAlign = 'right'; ctx.fillText('예측 →', W - 2, padTop); }
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
    $('#indices').innerHTML = (m.indices || []).map((i) => {
      const c = dirClass(i.changePct);
      const arrow = i.changePct > 0 ? '▲' : i.changePct < 0 ? '▼' : '–';
      const price = (i.price ?? 0).toLocaleString(i.currency === 'KRW' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 2 });
      const cur = i.currency === 'KRW' ? 'KRW2' : 'USD';
      return `<div class="idx"><div class="nm">${i.name}</div>
        <div class="pv ${c}-c">${price}</div>
        <div class="ch ${c}-c">${arrow} ${fmtChange({ change: i.change, currency: cur })} (${fmtPct(i.changePct)})</div></div>`;
    }).join('') || '<div class="muted">지수 데이터를 불러오지 못했습니다.</div>';
  } catch (e) {
    $('#moodLabel').textContent = '시장 데이터 대기 중'; $('#moodSummary').textContent = '아직 데이터가 생성되지 않았을 수 있어요(첫 갱신 대기).';
  }
}

// ---------- 보유 종목 ----------
async function loadQuotes() {
  let data, news, hist;
  try {
    [data, news, hist] = await Promise.all([
      loadJson('quotes.json'),
      loadJson('news.json').catch(() => ({})),
      loadJson('history.json').catch(() => ({})),
    ]);
  } catch (e) {
    $('#grid').innerHTML = `<div class="muted">아직 데이터가 없습니다. GitHub Actions 첫 실행을 기다려주세요.</div>`;
    return;
  }
  state.news = news || {};
  state.hist = hist || {};
  const quotes = data.quotes || [];
  if (!quotes.length) { $('#grid').innerHTML = '<div class="muted">추적 종목이 없습니다. config/watchlist.json을 편집하세요.</div>'; return; }

  const times = quotes.map((q) => q.asOf).filter(Boolean).map((s) => +new Date(s)).filter(Number.isFinite);
  if (times.length) {
    const t = new Date(Math.max(...times)).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const open = quotes.some((q) => q.marketStatus === 'OPEN');
    $('#updated').textContent = `${t} ${open ? '🟢 장중' : '⚪ 장마감'}`;
  }
  $('#clock').textContent = '확인 ' + new Date().toLocaleTimeString('ko-KR');

  $('#grid').innerHTML = quotes.map((q) => renderCard(q, state.hist[q.code])).join('');
  for (const q of quotes) {
    const h = state.hist[q.code];
    const cv = document.getElementById('chart-' + cssId(q.code));
    if (cv) drawChart(cv, h && h.closes, h && h.closes ? forecast(h.closes, FORECAST_DAYS) : null);
  }
  for (const q of quotes) renderNews(q, state.news[q.code]);
}

function retSpan(label, v) {
  if (v == null) return `<span class="ret"><i>${label}</i> —</span>`;
  return `<span class="ret"><i>${label}</i> <b class="${dirClass(v)}-c">${fmtPct(v)}</b></span>`;
}

function renderCard(q, hist) {
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
  const market = q.market || (q.currency === 'KRW' ? 'KR' : 'US');

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

  return `<div class="stock ${moverCls}">
    <div class="stock-head" style="padding-right:0">
      <div class="nm">${esc(q.name)}<span class="code">${q.code}</span><span class="market-tag">${market}</span></div>
      ${badge}
    </div>
    <div class="price-row">
      <span class="price">${fmtPrice(q)}</span>
      <span class="chg ${c}-c">${arrow} ${fmtChange({ change: q.change, currency: q.currency })} (${fmtPct(q.changePct)})</span>
    </div>
    ${retRow}
    <div class="chart"><canvas id="chart-${id}"></canvas></div>
    ${fcRow}
    <div class="meta">
      <span>고 <b>${q.high != null ? fmtPrice({ price: q.high, currency: q.currency }) : '—'}</b></span>
      <span>저 <b>${q.low != null ? fmtPrice({ price: q.low, currency: q.currency }) : '—'}</b></span>
      <span>거래량 <b>${fmtVol(q.volume)}</b></span>
      <span>${status}</span>
    </div>
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
function tick() { loadMarket(); loadQuotes(); }
function restartTimer() {
  if (state.timer) clearInterval(state.timer);
  if (state.intervalSec > 0) state.timer = setInterval(tick, state.intervalSec * 1000);
}

$('#refreshBtn').addEventListener('click', tick);
$('#interval').addEventListener('change', (e) => { state.intervalSec = +e.target.value; restartTimer(); });
window.addEventListener('resize', () => { for (const code in state.hist) { const h = state.hist[code]; const cv = document.getElementById('chart-' + cssId(code)); if (cv) drawChart(cv, h.closes, h.closes ? forecast(h.closes, FORECAST_DAYS) : null); } });

tick();
restartTimer();
