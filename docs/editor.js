// pages/docs/editor.js — '✏️ 종목 편집': 종목 검색 → 추가·삭제 → 저장
// 정적 사이트(GitHub Pages)라 브라우저가 저장소 파일을 직접 고칠 수 없다. 그래서 '저장'은 깃허브 이슈로
// 변경 요청을 보내고, 봇(.github/workflows/watchlist.yml)이 1~2분 안에 config/watchlist.json에 반영한 뒤
// 시세 갱신까지 실행한다. 이 화면은 반영될 때까지 시세 파일을 지켜보다가 자동으로 새로고침한다.
//  · 바로 저장: 이 기기에 '이슈 쓰기' 권한만 있는 깃허브 토큰을 넣어 두면 버튼 한 번으로 요청
//    (토큰은 이 브라우저 localStorage에만 두고 api.github.com 말고는 보내지 않는다 — index.html CSP로도 제한)
//  · 토큰 없이: 내용이 채워진 깃허브 이슈 작성 창이 열리고, 거기서 'Create'만 누르면 된다(깃허브 로그인 필요)
// 검색 목록(data/stocklist.json)은 봇이 매일 만든다. 목록에 없거나 목록을 못 받았으면 코드·티커로 직접 추가할 수 있다.
// app.js의 $, esc, loadJson, tick을 함께 쓴다(같은 페이지의 일반 스크립트).
'use strict';
(() => {
  const dlg = $('#editor'), openBtn = $('#editBtn');
  if (!dlg || !openBtn) return;
  if (typeof dlg.showModal !== 'function') { openBtn.hidden = true; return; } // 아주 오래된 브라우저 — 버튼을 숨기고 기존 방식(설명) 유지

  const MAX = 40;
  const KR_RE = /^\d{6}$/, US_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/; // scripts/util.mjs의 검증 규칙과 같게
  const TOKEN_KEY = 'stockdash.issueToken';
  // 저장소(owner/repo)는 주소에서 알아낸다: https://<owner>.github.io/<repo>/ — 주소가 다르면 기본 저장소
  const REPO = (() => {
    const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return m && seg && !/\.html?$/i.test(seg) ? `${m[1]}/${seg}` : 'ROK-LJM/RealTime_StockNews';
  })();
  // 로컬 미리보기에서만 가짜 깃허브(serve.mjs --mock-github, ?ghapi=/__gh)로 바꿔 시험할 수 있다. 실제 사이트는 항상 api.github.com.
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const MOCK = LOCAL ? new URLSearchParams(location.search).get('ghapi') : null;
  const API = MOCK && MOCK.startsWith('/') ? MOCK : 'https://api.github.com';
  const NEW_ISSUE = API === MOCK ? `${MOCK}/new-issue` : `https://github.com/${REPO}/issues/new`;
  const ISSUE_LIST = `https://github.com/${REPO}/issues?q=is%3Aissue+watchlist`;

  const q = (id) => dlg.querySelector('#' + id);
  const search = q('edSearch'), results = q('edResults'), list = q('edList'), count = q('edCount'), msgEl = q('edMsg');
  const saveBtn = q('edSave'), resetBtn = q('edReset'), closeBtn = q('edClose');
  const tokenBox = q('edTokenBox'), tokenIn = q('edToken'), tokenSave = q('edTokenSave'), tokenDel = q('edTokenDel'), tokenMsg = q('edTokenMsg');
  const statusEl = $('#editStatus');
  if (q('edRepoName')) q('edRepoName').textContent = REPO.split('/')[1];

  let base = [], baseOk = false;  // 지금 목록(quotes.json 기준) [{code, market, name}]
  const adds = new Map();         // 추가할 종목 code → {code, market, name}
  const removes = new Set();      // 삭제할 종목 code
  let inflight = null;            // 보낸 뒤 반영을 기다리는 요청 { add, remove, timer, deadline }
  let busy = false;
  let dir = null, dirLoading = null, dirFailed = false;
  let lastHits = new Map();

  // ---------- 토큰(이 브라우저에만) ----------
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); return true; } catch { return false; } };
  const ghHeaders = (token) => ({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}` });

  // ---------- 검색 목록 ----------
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s.\-_·,&'()/]/g, '');
  const MK = { KOSPI: '코스피', KOSDAQ: '코스닥' };
  function loadDir() {
    if (dir) return Promise.resolve(dir);
    if (!dirLoading) {
      dirLoading = loadJson('stocklist.json').then((j) => {
        const rows = [];
        for (const r of Array.isArray(j?.kr) ? j.kr : []) {
          if (!Array.isArray(r) || !KR_RE.test(String(r[0]))) continue;
          const name = String(r[1] ?? '').slice(0, 40);
          rows.push({ code: String(r[0]), market: 'KR', name: name || String(r[0]), en: '', sub: MK[r[2]] || '국내', k: [String(r[0]), norm(name), ''] });
        }
        for (const r of Array.isArray(j?.us) ? j.us : []) {
          const code = Array.isArray(r) ? String(r[0] ?? '').toUpperCase() : '';
          if (!US_RE.test(code)) continue;
          const ko = String(r[1] ?? '').slice(0, 40), en = String(r[2] ?? '').slice(0, 60);
          rows.push({ code, market: 'US', name: ko || en || code, en: ko ? en : '', sub: String(r[3] ?? '미국').slice(0, 20), k: [code.toLowerCase(), norm(ko), norm(en)] });
        }
        dir = rows; dirFailed = false;
        return dir;
      }).catch(() => { dirLoading = null; dirFailed = true; return null; }); // 실패하면 다음에 열 때 다시 시도
    }
    return dirLoading;
  }

  // 점수: 코드 일치 0 · 코드 앞부분 1 · 이름 앞부분 2 · 영문명 앞부분 3 · 이름 포함 4 · 영문명 포함 5
  function find(raw) {
    const s = norm(raw);
    if (!s || !dir) return [];
    const hits = [];
    for (const it of dir) {
      const [c, n, e] = it.k;
      let sc = -1;
      if (c === s) sc = 0;
      else if (c.startsWith(s)) sc = 1;
      else if (n.startsWith(s)) sc = 2;
      else if (e && e.startsWith(s)) sc = 3;
      else if (s.length >= 2 && n.includes(s)) sc = 4;
      else if (s.length >= 2 && e && e.includes(s)) sc = 5;
      if (sc >= 0) hits.push([sc, it]);
    }
    hits.sort((a, b) => a[0] - b[0] || (a[1].market === b[1].market ? 0 : a[1].market === 'KR' ? -1 : 1) || a[1].name.length - b[1].name.length);
    return hits.slice(0, 30).map((h) => h[1]);
  }
  // 목록에 없을 때 코드·티커 그대로 추가 — 국내 6자리 숫자, 미국 티커 형식만
  function direct(raw) {
    const t = String(raw ?? '').trim().toUpperCase();
    if (KR_RE.test(t)) return { code: t, market: 'KR', name: '', en: '', sub: '국내' };
    if (US_RE.test(t)) return { code: t, market: 'US', name: '', en: '', sub: '미국' };
    return null;
  }

  // ---------- 상태 ----------
  // 화면에 보일 목록 = 지금 목록 − 삭제(보낸 것·고른 것) + 추가(보낸 것·고른 것)
  function effective() {
    const gone = new Set([...removes, ...(inflight ? inflight.remove : [])]);
    const out = base.filter((b) => !gone.has(b.code)).map((b) => ({ ...b, tag: '' }));
    const have = new Set(out.map((x) => x.code));
    for (const a of inflight ? inflight.add : []) if (!have.has(a.code)) { out.push({ ...a, tag: 'wait' }); have.add(a.code); }
    for (const a of adds.values()) if (!have.has(a.code)) { out.push({ ...a, tag: 'new' }); have.add(a.code); }
    return out;
  }
  const changes = () => adds.size + removes.size;
  const flag = (m) => (m === 'KR' ? '🇰🇷' : '🇺🇸');
  const shortName = (it) => String(it.name || it.en || '').trim().slice(0, 30);

  function msg(text, kind = '') { msgEl.textContent = text; msgEl.className = 'ed-msg' + (kind ? ' ' + kind : ''); }
  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  function add(it) {
    if (!it) return;
    const cur = effective();
    if (cur.some((x) => x.code === it.code)) return;
    if (cur.length >= MAX) { msg(`최대 ${MAX}개까지 추적할 수 있어요. 먼저 다른 종목을 삭제하세요.`, 'err'); return; }
    if (removes.has(it.code)) removes.delete(it.code); // 삭제 예정이던 종목이면 되살리기
    else adds.set(it.code, { code: it.code, market: it.market, name: shortName(it) });
    msg('');
    render();
  }
  function remove(code) {
    if (adds.has(code)) adds.delete(code);
    else if (base.some((b) => b.code === code)) removes.add(code);
    render();
  }

  // ---------- 그리기 ----------
  function renderResults() {
    const raw = search.value;
    lastHits = new Map();
    if (!raw.trim()) {
      results.innerHTML = `<div class="ed-hint">${dir ? `국내·미국 ${dir.length.toLocaleString()}개 종목에서 검색해요.` : dirFailed ? '검색 목록을 불러오지 못했어요 — 6자리 코드나 티커를 입력하면 직접 추가할 수 있어요.' : '검색 목록 불러오는 중…'}</div>`;
      return;
    }
    const cur = new Set(effective().map((x) => x.code));
    const full = effective().length >= MAX;
    let hits = find(raw);
    let note = '';
    if (!hits.length) {
      const d = direct(raw);
      if (d) { hits = [d]; note = `<div class="ed-hint">${dir ? '목록에 없는 코드예요.' : '검색 목록 없이'} 코드 그대로 추가할 수 있어요 — 저장 뒤 시세가 나오는지 확인하세요.</div>`; }
    }
    if (!hits.length) {
      results.innerHTML = `<div class="ed-hint">${dir
        ? '검색 결과가 없어요. 국내는 6자리 코드, 미국은 티커로도 찾을 수 있어요.'
        : '검색 목록을 아직 불러오지 못해 이름으로는 찾을 수 없어요 — 국내는 6자리 코드(예: 005930), 미국은 티커(예: NVDA)로 입력하면 바로 추가할 수 있어요.'}</div>`;
      return;
    }
    results.innerHTML = note + hits.map((it) => {
      lastHits.set(it.code, it);
      const has = cur.has(it.code);
      const act = has ? '추가됨' : full ? '가득 참' : removes.has(it.code) ? '되살리기' : '+ 추가';
      return `<button type="button" class="ed-row" data-code="${esc(it.code)}"${has || full ? ' disabled' : ''}>`
        + `<span class="ed-flag">${flag(it.market)}</span>`
        + `<span class="ed-nm">${it.name ? esc(it.name) : '<span class="ed-en">이름은 반영 후 자동 표시</span>'}${it.en ? ` <span class="ed-en">${esc(it.en)}</span>` : ''}</span>`
        + `<span class="ed-cd">${esc(it.code)}</span><span class="ed-mk">${esc(it.sub)}</span><span class="ed-act">${act}</span></button>`;
    }).join('');
  }

  function renderList() {
    const items = effective();
    count.textContent = `${items.length}/${MAX}`;
    const chip = (x) => `<span class="ed-chip${x.tag ? ' ' + x.tag : ''}" title="${esc(x.code)}">${flag(x.market)} ${esc(x.name || x.code)}`
      + `${x.tag === 'new' ? ' <i>새로</i>' : x.tag === 'wait' ? ' <i>반영 중</i>' : ''}`
      + `${x.tag === 'wait' ? '' : `<button type="button" data-rm="${esc(x.code)}" aria-label="${esc((x.name || x.code) + ' 삭제')}">✕</button>`}</span>`;
    const kr = items.filter((x) => x.market === 'KR'), us = items.filter((x) => x.market !== 'KR');
    let html = '';
    if (kr.length) html += `<div class="ed-group"><div class="ed-gl">🇰🇷 국내 ${kr.length}</div>${kr.map(chip).join('')}</div>`;
    if (us.length) html += `<div class="ed-group"><div class="ed-gl">🇺🇸 해외 ${us.length}</div>${us.map(chip).join('')}</div>`;
    const rm = base.filter((b) => removes.has(b.code));
    if (rm.length) html += `<div class="ed-removed">삭제 예정: ${rm.map((x) => `<span>${esc(x.name || x.code)} <button type="button" data-undo="${esc(x.code)}">되돌리기</button></span>`).join(' ')}</div>`;
    list.innerHTML = html || `<div class="ed-hint">${baseOk ? '종목이 없어요. 위에서 검색해 추가하세요.' : '현재 목록을 불러오는 중…'}</div>`;
    const n = changes();
    saveBtn.disabled = !n || busy || !baseOk;
    saveBtn.textContent = busy ? '저장 중…' : n ? `저장 (${n}건 변경)` : '저장';
    resetBtn.disabled = !n || busy;
  }
  function render() { renderList(); renderResults(); }

  function renderToken() {
    const has = !!getToken();
    tokenMsg.textContent = has ? '✅ 이 기기에 토큰이 저장돼 있어요 — 저장 버튼 한 번으로 반영돼요.' : '토큰 없음 — 저장 때 깃허브 창에서 Create를 눌러 마무리해요.';
    tokenMsg.className = 'ed-msg' + (has ? ' ok' : '');
    tokenDel.disabled = !has;
  }

  // ---------- 지금 목록 ----------
  async function refreshBase() {
    try {
      const d = await loadJson('quotes.json');
      base = (Array.isArray(d?.quotes) ? d.quotes : []).filter((x) => x && x.code).map((x) => {
        const code = String(x.code);
        return { code, market: x.market === 'KR' || x.market === 'US' ? x.market : KR_RE.test(code) ? 'KR' : 'US', name: String(x.name || '') };
      });
      baseOk = true;
      // 이미 반영된 변경은 고른 목록에서 정리
      for (const c of [...adds.keys()]) if (base.some((b) => b.code === c)) adds.delete(c);
      for (const c of [...removes]) if (!base.some((b) => b.code === c)) removes.delete(c);
    } catch {
      if (!baseOk) msg('현재 종목 목록을 불러오지 못했어요. 잠시 후 다시 열어 주세요.', 'err');
    }
  }

  // ---------- 저장 ----------
  const label = (x) => (x.name ? `${x.name}(${x.code})` : x.code);
  function buildIssue(req) {
    const parts = [...req.add.map((a) => `+${label(a)}`), ...req.remove.map((c) => `−${label(base.find((b) => b.code === c) || { code: c })}`)];
    let title = `watchlist: ${parts.join(' ')}`;
    if (title.length > 180) title = title.slice(0, 177) + '…';
    const body = [
      '대시보드 ‘✏️ 종목 편집’에서 보낸 변경 요청입니다. 봇이 자동으로 반영한 뒤 결과를 댓글로 남기고 이 이슈를 닫습니다.',
      '',
      '```json',
      JSON.stringify(req),
      '```',
      '',
    ].join('\n');
    return { title, body };
  }
  function errorText(status) {
    if (status === 401) return '토큰이 맞지 않거나 만료됐어요 — 아래 ⚡에서 새 토큰을 넣어 주세요.';
    if (status === 403) return '토큰 권한이 부족해요 — 저장소 선택(RealTime_StockNews)과 Issues: Read and write 권한을 확인하세요.';
    if (status === 404) return '저장소에 접근하지 못했어요 — 토큰의 Repository access에서 이 저장소를 골랐는지 확인하세요.';
    if (status === 410) return '저장소의 이슈 기능이 꺼져 있어요 — 저장소 Settings → General → Features → Issues를 켜 주세요.';
    return `저장하지 못했어요(오류 ${status}) — 잠시 후 다시 시도하세요.`;
  }

  async function save() {
    const req = { add: [...adds.values()], remove: [...removes] };
    if (!req.add.length && !req.remove.length || busy) return;
    const { title, body } = buildIssue(req);
    const token = getToken();
    if (token) {
      busy = true; render(); msg('저장 요청 보내는 중…');
      try {
        const r = await fetch(`${API}/repos/${REPO}/issues`, {
          method: 'POST', headers: { ...ghHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }),
        });
        if (r.status === 201) {
          sent(req, true);
          msg('✅ 저장 요청 완료 — 1~2분 뒤 반영돼요. 이 창을 닫아도 반영되면 화면이 자동으로 새로고침돼요.', 'ok');
        } else msg(errorText(r.status), 'err');
      } catch { msg('네트워크 오류로 저장하지 못했어요 — 잠시 후 다시 시도하세요.', 'err'); }
      finally { busy = false; render(); }
      return;
    }
    // 토큰 없음 — 내용이 채워진 깃허브 이슈 작성 창을 연다(팝업이 막혀도 누를 수 있게 링크도 함께)
    const url = `${NEW_ISSUE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank', 'noopener');
    sent(req, false);
    msgEl.className = 'ed-msg';
    msgEl.innerHTML = `깃허브 창에서 <b>Create</b>(이슈 만들기)를 누르면 1~2분 뒤 반영돼요. 창이 안 열렸다면 <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">여기를 눌러 여세요</a>.`;
  }

  // 보낸 요청이 시세 파일에 나타날 때까지 지켜본다(15초 간격). 토큰 저장은 6분, 깃허브 창 경유는 15분까지.
  function sent(req, viaToken) {
    if (inflight) clearInterval(inflight.timer);
    adds.clear(); removes.clear();
    inflight = { add: req.add, remove: req.remove, deadline: Date.now() + (viaToken ? 6 : 15) * 60e3, timer: 0 };
    setStatus('⏳ 종목 변경 반영 대기 중…');
    const job = inflight;
    job.timer = setInterval(async () => {
      if (inflight !== job) { clearInterval(job.timer); return; }
      let d;
      try { d = await loadJson('quotes.json'); } catch { return; }
      const qs = Array.isArray(d?.quotes) ? d.quotes : [];
      const codes = new Set(qs.map((x) => String(x.code)));
      const done = job.add.every((a) => codes.has(a.code)) && job.remove.every((c) => !codes.has(c));
      if (done) {
        clearInterval(job.timer); inflight = null;
        const bad = job.add.filter((a) => qs.some((x) => String(x.code) === a.code && !x.ok));
        setStatus(bad.length ? `⚠️ 반영됨 — 시세를 못 찾은 종목: ${bad.map(label).join(', ')} (코드 확인)` : '✅ 종목 변경이 반영됐어요');
        if (dlg.open) msg(statusEl ? statusEl.textContent : '반영 완료', bad.length ? 'err' : 'ok');
        await refreshBase();
        render();
        if (typeof tick === 'function') tick();
        setTimeout(() => { if (!inflight && statusEl && /반영됐어요/.test(statusEl.textContent)) setStatus(''); }, 15000);
      } else if (Date.now() > job.deadline) {
        clearInterval(job.timer); inflight = null;
        setStatus('⏱ 종목 변경이 아직 반영되지 않았어요');
        if (dlg.open) { msgEl.className = 'ed-msg err'; msgEl.innerHTML = `아직 반영되지 않았어요. ${viaToken ? '' : '깃허브 창에서 Create를 눌렀는지, '}<a href="${esc(ISSUE_LIST)}" target="_blank" rel="noopener noreferrer">깃허브 이슈의 봇 댓글</a>을 확인한 뒤 다시 저장해 주세요.`; }
        render();
      }
    }, 15000);
    render();
  }

  // ---------- 이벤트 ----------
  openBtn.addEventListener('click', async () => {
    if (!dlg.open) dlg.showModal();
    search.value = '';
    renderToken();
    render();
    search.focus();
    await refreshBase();
    render();
    await loadDir();
    renderResults();
  });
  closeBtn.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // 바깥(어두운 배경) 누르면 닫기
  let debounce;
  search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(renderResults, 120); });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = results.querySelector('.ed-row:not([disabled])');
    if (first) first.click();
  });
  results.addEventListener('click', (e) => {
    const b = e.target.closest('.ed-row');
    if (!b || b.disabled) return;
    add(lastHits.get(b.dataset.code));
    search.select();
  });
  list.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]'), undo = e.target.closest('[data-undo]');
    if (rm) remove(rm.dataset.rm);
    else if (undo) { removes.delete(undo.dataset.undo); render(); }
  });
  resetBtn.addEventListener('click', () => { adds.clear(); removes.clear(); msg(''); render(); });
  saveBtn.addEventListener('click', save);

  tokenSave.addEventListener('click', async () => {
    const t = tokenIn.value.trim();
    if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(t)) {
      tokenMsg.textContent = '‘github_pat_’로 시작하는 토큰(Fine-grained)을 넣어 주세요. 권한이 넓은 클래식 토큰(ghp_)은 받지 않아요.';
      tokenMsg.className = 'ed-msg err';
      return;
    }
    tokenSave.disabled = true;
    tokenMsg.textContent = '토큰 확인 중…'; tokenMsg.className = 'ed-msg';
    let status = 0;
    try { status = (await fetch(`${API}/repos/${REPO}`, { headers: ghHeaders(t) })).status; } catch {}
    tokenSave.disabled = false;
    if (status === 401) { tokenMsg.textContent = '토큰이 맞지 않거나 만료됐어요 — 다시 복사해 넣어 주세요.'; tokenMsg.className = 'ed-msg err'; return; }
    if (!setToken(t)) { tokenMsg.textContent = '이 브라우저에 저장할 수 없어요(사생활 보호 모드 등).'; tokenMsg.className = 'ed-msg err'; return; }
    tokenIn.value = '';
    renderToken();
    if (status !== 200) { tokenMsg.textContent = '저장했어요. (연결 확인은 못 했어요 — 첫 저장 때 확인돼요)'; tokenMsg.className = 'ed-msg'; }
  });
  tokenDel.addEventListener('click', () => { setToken(''); renderToken(); });
  tokenBox.addEventListener('toggle', () => { if (tokenBox.open) renderToken(); });
})();
