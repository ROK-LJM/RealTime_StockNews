// pages/docs/calendar.js — 공시 일정 달력. 봇이 3시간마다 만드는 data/calendar.json을 그린다(외부 통신 없음).
// 일정 종류(k): earn 실적 · ir 기업설명회 · meet 주총 · rec 권리 기준일 · div 배당 · cap 자사주·증자·분할 · disc 지난 공시

// ---------- 계산(자체 테스트 대상 — 아래 '화면' 구획 앞까지) ----------
const GROUP_OF = { earn: 'earn', ir: 'ir', meet: 'meet', rec: 'meet', div: 'div', cap: 'cap', disc: 'disc' };
const GROUPS = ['earn', 'ir', 'div', 'meet', 'cap', 'disc'];
const DEFAULT_GROUPS = ['earn', 'ir', 'div', 'meet', 'cap']; // 지난 공시는 수가 많아 기본은 숨김
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const groupOf = (e) => GROUP_OF[e && e.k] || 'disc';
const utc = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const ymdOfUtc = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const addDays = (s, n) => ymdOfUtc(utc(s) + n * 86400e3);
const dowOf = (s) => new Date(utc(s)).getUTCDay();
// 한국 날짜(서머타임 없음)
const kstToday = (ms) => ymdOfUtc(ms + 9 * 3600e3);
// 그 달 칸 — 일요일부터 6주(마지막 주가 통째로 다음 달이면 5주). [{ d, day, inMonth, dow }]
function monthCells(y, m) {
  const first = `${y}${String(m).padStart(2, '0')}01`;
  const start = addDays(first, -dowOf(first));
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    cells.push({ d, day: +d.slice(6, 8), inMonth: +d.slice(4, 6) === m, dow: i % 7 });
  }
  return cells.slice(35).every((c) => !c.inMonth) ? cells.slice(0, 35) : cells;
}
// '오늘' · '내일' · 'D-6' · '어제' · '3일 전'
function ddayLabel(d, today) {
  const n = Math.round((utc(d) - utc(today)) / 86400e3);
  return n === 0 ? '오늘' : n === 1 ? '내일' : n === -1 ? '어제' : n > 0 ? `D-${n}` : `${-n}일 전`;
}
// '10월 29일 (목)' — 올해(today)가 아니면 '2027년 1월 22일 (금)'
const fmtDay = (d, today = '') => `${today && d.slice(0, 4) !== today.slice(0, 4) ? `${d.slice(0, 4)}년 ` : ''}${+d.slice(4, 6)}월 ${+d.slice(6, 8)}일 (${WD[dowOf(d)]})`;
// 거르기 — f: { mkt: 'all'|'KR'|'US', code: ''|종목코드, groups: Set }
function passFilter(e, f) {
  return !!e && (f.mkt === 'all' || e.m === f.mkt) && (!f.code || e.c === f.code) && f.groups.has(groupOf(e));
}
// 달력 칸에 쓰는 짧은 말
function cellWord(e) {
  const t = String(e.t || '');
  switch (e.k) {
    case 'earn': return '실적';
    case 'ir': return 'IR';
    case 'meet': return /기준일/.test(t) ? '기준일' : '주총';
    case 'rec': return '기준일';
    case 'div': return /락/.test(t) ? '배당락' : /지급/.test(t) ? '배당 지급' : '배당 기준일';
    case 'cap': return /자사주/.test(t) ? '자사주' : /소각/.test(t) ? '소각' : /증자/.test(t) ? '증자' : '신주 상장';
    default: { // 지난 공시 — 공시 종류(봇의 tagOf)로
      const tag = String(e.tag || '');
      return tag === '예고' ? '실적 예고' : tag === 'IR' ? 'IR 안내' : tag && tag !== '기타' ? `${tag} 공시` : '공시';
    }
  }
}
// 날짜별로 묶기(받은 순서 유지) → Map(날짜 → 일정들)
function byDate(events) {
  const m = new Map();
  for (const e of events) { if (!m.has(e.d)) m.set(e.d, []); m.get(e.d).push(e); }
  return m;
}
// 원문 주소 — 국내는 전자공시 원문, 미국은 나스닥 실적·배당 페이지
function sourceUrl(e) {
  if (e.no && /^\d{14}$/.test(e.no)) return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${e.no}`;
  if (e.m === 'US' && /^[A-Za-z.\-]{1,10}$/.test(e.c || '')) {
    return `https://www.nasdaq.com/market-activity/stocks/${String(e.c).toLowerCase()}/${e.k === 'div' ? 'dividend-history' : 'earnings'}`;
  }
  return '';
}

// ---------- 화면 ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PREF = 'stockdash.cal';
const isNarrow = () => window.matchMedia('(max-width: 720px)').matches;
const state = { data: null, view: 'month', y: 0, m: 0, sel: '', mkt: 'all', code: '', groups: new Set(DEFAULT_GROUPS), showPast: false, error: '' };

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF) || 'null');
    if (p && (p.view === 'month' || p.view === 'list')) state.view = p.view;
    if (p && ['all', 'KR', 'US'].includes(p.mkt)) state.mkt = p.mkt;
    if (p && Array.isArray(p.groups)) state.groups = new Set(p.groups.filter((g) => GROUPS.includes(g)));
  } catch { /* 저장 못 하는 환경 — 기본값 */ }
}
function savePrefs() {
  try { localStorage.setItem(PREF, JSON.stringify({ view: state.view, mkt: state.mkt, groups: [...state.groups] })); } catch { /* 무시 */ }
}

// 데이터 — 봇이 남긴 파일 지문(manifest.json)이 있으면 '?v=지문'(캐시 가능), 없거나 내용이 다르면 새로 받는다(대시보드와 같은 방식)
async function sha1Hex(buf) {
  const d = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function loadCalendar() {
  const fresh = async () => {
    const r = await fetch(`./data/calendar.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.status === 404) return null; // 봇이 아직 처음 만들기 전
    if (!r.ok) throw new Error(`calendar.json ${r.status}`);
    return r.json();
  };
  let v = null;
  try {
    const r = await fetch(`./data/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
    const m = r.ok ? await r.json() : null;
    v = m && m.files && typeof m.files['calendar.json'] === 'string' && /^[0-9a-f]{8,40}$/.test(m.files['calendar.json']) ? m.files['calendar.json'] : null;
  } catch { v = null; }
  if (!v) return fresh();
  const r = await fetch(`./data/calendar.json?v=${v}`);
  if (!r.ok) return fresh();
  const buf = await r.arrayBuffer();
  if (globalThis.crypto?.subtle && !(await sha1Hex(buf)).startsWith(v)) return fresh();
  return JSON.parse(new TextDecoder().decode(buf));
}

const filters = () => ({ mkt: state.mkt, code: state.code, groups: state.groups });
const visible = () => (state.data?.events || []).filter((e) => passFilter(e, filters()));
const today = () => kstToday(Date.now());

function eventRow(e, { showDate = false } = {}) {
  const g = groupOf(e), url = sourceUrl(e);
  const past = e.d < today();
  return `<li class="ce${past ? ' past' : ''}">
    <span class="ce-k"><i class="kdot g-${g}"></i>${esc(cellWord(e))}</span>
    <div class="ce-main">
      <div class="ce-top"><b class="ce-name">${esc(e.n)}</b><span class="ce-mkt">${e.m === 'US' ? '해외' : '국내'}</span>${showDate ? `<span class="ce-when">${esc(fmtDay(e.d, today()))}</span>` : ''}${e.tm ? `<span class="ce-when">${esc(e.tm)}</span>` : ''}</div>
      <div class="ce-t">${esc(e.t)}${e.s ? `<span class="ce-s"> · ${esc(e.s)}</span>` : ''}</div>
    </div>
    ${url ? `<a class="ce-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${e.no ? '전자공시 원문' : '나스닥'} (새 탭)" aria-label="${esc(e.n)} ${esc(e.t)} 원문 (새 탭)"><svg class="ic" aria-hidden="true"><use href="#i-ext"/></svg></a>` : ''}
  </li>`;
}

function renderGrid() {
  const cells = monthCells(state.y, state.m);
  const map = byDate(visible());
  const td = today();
  const max = isNarrow() ? 4 : 3;
  const head = WD.map((w, i) => `<div class="cal-wd${i === 0 || i === 6 ? ' we' : ''}">${w}</div>`).join('');
  const body = cells.map((c) => {
    const evs = map.get(c.d) || [];
    const cls = ['cal-day', c.inMonth ? '' : 'out', c.d === td ? 'today' : '', c.d < td ? 'past' : '', c.dow === 0 || c.dow === 6 ? 'we' : ''].filter(Boolean).join(' ');
    const lines = evs.slice(0, max).map((e) => `<span class="ev"><i class="kdot g-${groupOf(e)}"></i><span class="evt">${esc(e.n)} ${esc(cellWord(e))}</span></span>`).join('');
    const more = evs.length > max ? `<span class="more">+${evs.length - max}</span>` : '';
    const label = `${+c.d.slice(4, 6)}월 ${c.day}일 ${WD[c.dow]}요일${evs.length ? `, 일정 ${evs.length}건` : ''}`;
    return `<button type="button" class="${cls}" data-d="${c.d}" aria-pressed="${c.d === state.sel}" aria-label="${esc(label)}"><span class="dn">${c.day}</span><span class="evs">${lines}${more}</span></button>`;
  }).join('');
  $('#calMain').innerHTML = `<div class="cal-grid" role="group" aria-label="${state.y}년 ${state.m}월">${head}${body}</div>`;
}

function renderList() {
  const td = today();
  const from = state.showPast ? addDays(td, -30) : td, to = addDays(td, 120);
  const map = byDate(visible().filter((e) => e.d >= from && e.d <= to));
  const days = [...map.keys()];
  const pastBtn = `<button type="button" class="btn agenda-past" data-act="past">${state.showPast ? '지난 일정 숨기기' : '지난 30일도 보기'}</button>`;
  $('#calMain').innerHTML = days.length
    ? `<div class="agenda">${pastBtn}${days.map((d) => `<section class="ag-day${d < td ? ' past' : ''}${d === td ? ' today' : ''}">
        <h2 class="ag-h">${esc(fmtDay(d, td))}<span class="dday">${esc(ddayLabel(d, td))}</span></h2>
        <ul class="ce-list">${map.get(d).map((e) => eventRow(e)).join('')}</ul></section>`).join('')}</div>`
    : `<div class="cal-empty">${pastBtn}<p>앞으로 4달 안에 보이는 일정이 없어요. 위에서 시장·종목·종류를 바꿔 보세요.</p></div>`;
}

function renderSide() {
  const td = today();
  const all = visible();
  const sel = state.sel || td;
  const dayEvs = all.filter((e) => e.d === sel);
  const upcoming = all.filter((e) => e.d > td && e.d <= addDays(td, 14)).slice(0, 12);
  const dayPart = `<div class="side-sec">
      <h2 class="side-h">${esc(fmtDay(sel, td))}<span class="dday">${esc(ddayLabel(sel, td))}</span></h2>
      ${dayEvs.length ? `<ul class="ce-list">${dayEvs.map((e) => eventRow(e)).join('')}</ul>` : '<p class="side-empty">이날은 일정이 없어요.</p>'}
    </div>`;
  const upPart = state.view === 'month' ? `<div class="side-sec">
      <h2 class="side-h">다가오는 일정<span class="side-sub">2주</span></h2>
      ${upcoming.length ? `<ul class="ce-list">${upcoming.map((e) => eventRow(e, { showDate: true })).join('')}</ul>` : '<p class="side-empty">2주 안에 일정이 없어요.</p>'}
    </div>` : '';
  $('#calSide').innerHTML = dayPart + upPart;
}

function renderNote() {
  const d = state.data;
  if (!d) { $('#calNote').textContent = ''; return; }
  const at = new Date(d.at);
  const parts = [`일정은 3시간마다 갱신 · 마지막 ${at.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`];
  if (d.kr === 'off') parts.push('국내 일정은 전자공시 키가 있어야 나와요');
  else if (d.kr && d.kr !== 'ok') parts.push(`국내: ${d.kr}`);
  if (d.us && !['ok', 'none'].includes(d.us)) parts.push(`해외: ${d.us}`);
  parts.push('국내는 회사가 공시한 일정만(실적 발표일은 ‘결산실적공시 예고’를 낸 뒤부터) · 해외 실적 발표일은 나스닥 자료로, ‘예상일’은 회사가 아직 확정하지 않은 날짜');
  $('#calNote').textContent = parts.join(' · ');
}

function renderHead() {
  $('#monthTitle').textContent = `${state.y}년 ${state.m}월`;
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  document.querySelectorAll('[data-mkt]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mkt === state.mkt)));
  document.querySelectorAll('[data-g]').forEach((b) => b.setAttribute('aria-pressed', String(state.groups.has(b.dataset.g))));
  // 달 넘기기는 달력 보기에서만
  for (const id of ['#prevM', '#nextM']) $(id).disabled = state.view !== 'month';
  $('#monthTitle').classList.toggle('dim', state.view !== 'month');
  // 종목 고르기 — 일정이 있는 종목만, 시장 거르기를 따름(국내 먼저 · 이름순)
  const seen = new Map();
  for (const e of state.data?.events || []) if (!seen.has(e.c) && (state.mkt === 'all' || e.m === state.mkt)) seen.set(e.c, e);
  const opts = [...seen.values()].sort((a, b) => (a.m === b.m ? String(a.n).localeCompare(String(b.n), 'ko') : a.m === 'KR' ? -1 : 1));
  if (state.data && state.code && !seen.has(state.code)) state.code = ''; // 주소로 받은 종목(?code=)은 데이터가 온 뒤에 확인
  $('#stockSel').innerHTML = `<option value="">전체 종목</option>${opts.map((e) => `<option value="${esc(e.c)}"${e.c === state.code ? ' selected' : ''}>${esc(e.n)}</option>`).join('')}`;
}

function render() {
  renderHead();
  document.body.classList.toggle('view-list', state.view === 'list');
  if (!state.data) {
    $('#calMain').innerHTML = `<div class="cal-empty"><p>${state.error ? `일정을 불러오지 못했어요(${esc(state.error)}). 잠시 뒤 새로고침해 보세요.`
      : '일정을 준비 중이에요 — 봇이 처음 만들기까지 최대 3시간쯤 걸려요.'}</p></div>`;
    $('#calSide').innerHTML = '';
    renderNote();
    return;
  }
  if (state.view === 'month') renderGrid(); else renderList();
  renderSide();
  renderNote();
}

function setMonth(y, m) {
  if (m < 1) { y--; m = 12; } else if (m > 12) { y++; m = 1; }
  state.y = y; state.m = m;
  const td = today();
  state.sel = +td.slice(0, 4) === y && +td.slice(4, 6) === m ? td : `${y}${String(m).padStart(2, '0')}01`;
}

// 테마 버튼(대시보드와 같은 동작)
function syncThemeBtn() {
  const b = $('#themeBtn');
  if (!b) return;
  const dark = window.stockTheme && window.stockTheme.get() === 'dark';
  const label = dark ? '밝은 화면으로' : '어두운 화면으로';
  b.title = label; b.setAttribute('aria-label', label);
  b.querySelector('use')?.setAttribute('href', dark ? '#i-sun' : '#i-moon');
}

function bind() {
  $('#prevM').addEventListener('click', () => { setMonth(state.y, state.m - 1); render(); });
  $('#nextM').addEventListener('click', () => { setMonth(state.y, state.m + 1); render(); });
  $('#todayBtn').addEventListener('click', () => { const td = today(); setMonth(+td.slice(0, 4), +td.slice(4, 6)); render(); });
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; savePrefs(); render(); }));
  document.querySelectorAll('[data-mkt]').forEach((b) => b.addEventListener('click', () => { state.mkt = b.dataset.mkt; savePrefs(); render(); }));
  document.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.g;
    if (state.groups.has(g)) state.groups.delete(g); else state.groups.add(g);
    savePrefs(); render();
  }));
  $('#stockSel').addEventListener('change', (ev) => { state.code = ev.target.value; render(); });
  $('#calMain').addEventListener('click', (ev) => {
    const day = ev.target.closest('.cal-day');
    if (day) {
      state.sel = day.dataset.d;
      document.querySelectorAll('.cal-day').forEach((x) => x.setAttribute('aria-pressed', String(x === day)));
      renderSide();
      if (isNarrow()) $('#calSide').scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (ev.target.closest('[data-act="past"]')) { state.showPast = !state.showPast; render(); }
  });
  $('#themeBtn')?.addEventListener('click', () => { if (window.stockTheme) window.stockTheme.toggle(); });
  document.addEventListener('themechange', syncThemeBtn);
  // 화면 폭이 바뀌면(휴대폰 회전 등) 칸 표시 개수가 달라진다
  window.matchMedia('(max-width: 720px)').addEventListener?.('change', () => { if (state.data && state.view === 'month') renderGrid(); });
}

async function init() {
  loadPrefs();
  const q = new URLSearchParams(location.search);
  const td = today();
  const want = /^\d{8}$/.test(q.get('d') || '') ? q.get('d') : td;
  setMonth(+want.slice(0, 4), +want.slice(4, 6));
  state.sel = want;
  if (/^[0-9A-Za-z.\-]{1,12}$/.test(q.get('code') || '')) state.code = q.get('code');
  syncThemeBtn();
  bind();
  render();
  try { state.data = await loadCalendar(); }
  catch (e) { state.error = e.message || '오류'; }
  render();
}
init();
