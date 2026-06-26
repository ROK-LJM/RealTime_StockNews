// pages/app.js — GitHub Pages 정적 버전. 서버 없이 ./data/*.json 을 읽어 렌더링.
'use strict';

const MOVER_THRESHOLD = 3;
const MAX_SPARK = 120;

const $ = (s) => document.querySelector(s);
const state = { timer: null, intervalSec: 60, history: new Map(), news: {} };

// ---------- 포맷 ----------
function fmtPrice(q) {
  if (q.price == null) return '—';
  if (q.currency === 'KRW') return q.price.toLocaleString('ko-KR');
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
function cssId(code) { return String(code).replace(/[^a-zA-Z0-9]/g, '_'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function loadJson(name) {
  const r = await fetch(`./data/${name}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(name + ' ' + r.status);
  return r.json();
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

// ---------- 스파크라인 ----------
function drawSpark(canvas, values, pct) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 280, H = 40;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (!values || values.length < 2) {
    ctx.fillStyle = '#6f7d90'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('가격 흐름 수집 중…', W / 2, H / 2 + 4);
    return;
  }
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const col = pct > 0 ? '#ff5b5b' : pct < 0 ? '#4aa3ff' : '#9aa7b8';
  const x = (i) => (i / (values.length - 1)) * (W - 4) + 2;
  const y = (v) => H - 4 - ((v - min) / span) * (H - 10);
  ctx.beginPath(); ctx.moveTo(x(0), y(values[0]));
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(values.length - 1), H); ctx.lineTo(x(0), H); ctx.closePath();
  ctx.fillStyle = col + '22'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(x(0), y(values[0]));
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
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
  let data, news;
  try { [data, news] = await Promise.all([loadJson('quotes.json'), loadJson('news.json').catch(() => ({}))]); }
  catch (e) { $('#grid').innerHTML = `<div class="muted">아직 데이터가 없습니다. GitHub Actions 첫 실행을 기다려주세요.</div>`; return; }
  state.news = news || {};
  const quotes = data.quotes || [];
  if (!quotes.length) { $('#grid').innerHTML = '<div class="muted">추적 종목이 없습니다. config/watchlist.json을 편집하세요.</div>'; return; }

  // "시세 기준" = 가장 최신 종목의 시장 데이터 시각 + 장중/장마감 (장 마감 후엔 마감 시각에서 멈추는 게 정상)
  const times = quotes.map((q) => q.asOf).filter(Boolean).map((s) => +new Date(s)).filter(Number.isFinite);
  if (times.length) {
    const t = new Date(Math.max(...times)).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const open = quotes.some((q) => q.marketStatus === 'OPEN');
    $('#updated').textContent = `${t} ${open ? '🟢 장중' : '⚪ 장마감'}`;
  }
  // 헤더 시계 = 페이지가 실제로 데이터를 마지막으로 받아온 시각(살아있음 표시)
  $('#clock').textContent = '확인 ' + new Date().toLocaleTimeString('ko-KR');

  for (const q of quotes) {
    if (!q.ok || q.price == null) continue;
    const arr = state.history.get(q.code) || [];
    if (arr.length === 0 || arr[arr.length - 1] !== q.price) arr.push(q.price);
    if (arr.length > MAX_SPARK) arr.shift();
    state.history.set(q.code, arr);
  }

  $('#grid').innerHTML = quotes.map(renderCard).join('');
  for (const q of quotes) {
    const cv = document.getElementById('spark-' + cssId(q.code));
    if (cv) drawSpark(cv, state.history.get(q.code), q.changePct ?? 0);
  }
  for (const q of quotes) renderNews(q, state.news[q.code]);
}

function renderCard(q) {
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
  return `<div class="stock ${moverCls}">
    <div class="stock-head" style="padding-right:0">
      <div class="nm">${esc(q.name)}<span class="code">${q.code}</span><span class="market-tag">${market}</span></div>
      ${badge}
    </div>
    <div class="price-row">
      <span class="price">${fmtPrice(q)}</span>
      <span class="chg ${c}-c">${arrow} ${fmtChange({ change: q.change, currency: q.currency })} (${fmtPct(q.changePct)})</span>
    </div>
    <div class="spark"><canvas id="spark-${id}"></canvas></div>
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

tick();
restartTimer();