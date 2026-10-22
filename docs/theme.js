// pages/docs/theme.js — 화면 테마(밝게 · 어둡게). 그리기 전에 정해야 깜빡이지 않으므로 <head>에서 가장 먼저 실행한다.
// 기본은 기기 설정(밝은/어두운 모드)을 따르고, 상단바 버튼으로 바꾸면 이 기기에 기억한다.
// 바꾼 값이 기기 설정과 같아지면 기억을 지워 다시 기기 설정을 따른다. 바뀔 때마다 'themechange' 이벤트(캔버스 차트 다시 그리기용).
(function () {
  var KEY = 'stockdash.theme', root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function saved() { try { var t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : null; } catch (e) { return null; } }
  function system() { return mq && mq.matches ? 'dark' : 'light'; }
  function apply(t) { root.setAttribute('data-theme', t); }
  function changed() { try { document.dispatchEvent(new Event('themechange')); } catch (e) { /* 아주 오래된 브라우저 — 차트 색만 다음 갱신 때 바뀜 */ } }
  apply(saved() || system());
  if (mq) {
    var onSystem = function () { if (!saved()) { apply(system()); changed(); } };
    if (mq.addEventListener) mq.addEventListener('change', onSystem); else if (mq.addListener) mq.addListener(onSystem);
  }
  window.stockTheme = {
    get: function () { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; },
    toggle: function () {
      var next = window.stockTheme.get() === 'dark' ? 'light' : 'dark';
      try { if (next === system()) localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch (e) { /* 저장 못 해도 이번 화면에선 바뀜 */ }
      apply(next); changed(); return next;
    },
  };
})();
