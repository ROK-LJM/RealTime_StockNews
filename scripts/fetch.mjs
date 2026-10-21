// pages/scripts/fetch.mjs
// GitHub Actions가 주기적으로 실행 → 시세·뉴스를 받아 docs/data/*.json 으로 저장한다.
// (GitHub Pages는 이 JSON을 정적으로 서빙. 브라우저는 같은 출처라 CORS 문제 없음.)
//
// 예외 처리 원칙:
//  - 일시적 API 실패로 받은 "빈 결과"로 기존의 정상 데이터를 덮어쓰지 않는다(기존 파일 유지).
//  - 한 종류(지수/시세/뉴스)가 실패해도 나머지는 계속 갱신한다.
//  - 어떤 오류가 나도 프로세스는 정상 종료(exit 0)하여 Action을 실패로 만들지 않는다.
//  - 우리 쪽 벽시계 타임스탬프를 저장하지 않는다 → 실제 데이터가 바뀔 때만 커밋되도록(장 마감/주말 무한커밋 방지).
//  - 파일은 원자적으로 쓴다(임시 파일 → 이름 변경) → 중간에 끊겨도 반쯤 쓴 JSON이 남지 않는다.
//
// `node scripts/fetch.mjs`로 실행하면 바로 1회 갱신한다. 다른 모듈(자체 테스트)은 run()을 가져다 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getMarket, getQuotes, getNews, getHistory, getStockInvestors, getIndexFlow, getIndexReason, aiStockAnalysis,
  aiStatus, aiGate, noteAiSkipped, aiModels, setAiBudget, resetState, STOCK_ANALYSIS_THRESHOLD,
} from './sources.mjs';
import { startBudget, toStored, totalUsed, capacity, inSession, isKrSession, nextAllowanceAt, closedCheckDay } from './aibudget.mjs';
import { validateWatchlist, writeJsonAtomic, analysisSig, sigMove } from './util.mjs';
import { dartEnabled, resetDart, dartHalted, ensureCorpTable, getDisclosures } from './dart.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 한 회차에 새로 호출할 AI 종합분석 최대 건수 — 한 번에 몰아 쓰지 않게 하는 상한. 초과분은 이전 분석을
// 유지한 채 다음 회차로 미룬다. 하루 총량은 aibudget.mjs가 장 시간에 맞춰 나눠 준다(무료 한도가 하루 수십 회뿐).
const AI_CALLS_PER_RUN = 4;

// 자주 안 바뀌는 데이터는 매 회차(5분) 받지 않는다 — 비공식 API 과호출(차단 위험)·뉴스 변동에 따른 AI 재분석·커밋을 줄인다.
// 시각 기준(정시부터 N분마다 첫 5분 안에 도는 회차)이라 '언제 받았는지'를 파일에 따로 적지 않아도 된다(불필요한 커밋 방지).
// 그 사이 회차와 실패한 종목은 직전 값을 그대로 쓴다. 새로 추가된 종목은 바로 받는다.
const REFRESH_MIN = { history: 30, investors: 30, news: 15, disclosures: 15 };

// 설정 검증: 고칠 수 있는 항목(앞자리 0 누락·소문자 티커)은 고치고, 틀린 항목은 빼며 이유를 로그로 남긴다.
function readConfig(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'watchlist.json'), 'utf8'));
    const { items, warnings } = validateWatchlist(cfg);
    warnings.forEach((w) => console.warn('  ! watchlist:', w));
    if (!items.length) throw new Error('watchlist.json에 유효한 종목이 없습니다');
    return items;
  } catch (e) {
    console.error('  ✗ config 읽기 실패 — 기존 데이터 유지:', e.message);
    return null;
  }
}

// 1회 갱신. root/dataDir를 바꿔 임시 폴더에서도 돌릴 수 있다(자체 테스트용). 쓴 파일 목록을 돌려준다.
// now: 이번 회차 기준 시각 — AI 예산 배분·분석 시각 기록에 쓴다(테스트는 고정 시각을 넘긴다).
// refreshAll: 과거 시세·수급·뉴스를 간격과 상관없이 모두 새로 받는다(자체 테스트용, 아래 REFRESH_MIN 참고).
export async function run({ root = ROOT, dataDir = path.join(root, 'docs', 'data'), now = Date.now(), refreshAll = false } = {}) {
  resetState(); // 회차마다 캐시·AI 상태를 새로 시작
  fs.mkdirSync(dataDir, { recursive: true });
  const written = [];
  const write = (name, obj) => {
    writeJsonAtomic(path.join(dataDir, name), obj);
    written.push(name);
    console.log(`  ✓ data/${name} 갱신`);
  };
  const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')); } catch { return null; }
  };

  // AI 하루 예산 — 직전 회차까지 쓴 기록(status.json)을 이어받는다. 한도일(미 태평양시 날짜)이 바뀌었으면 새로 시작.
  const prevStatus = readJson('status.json');
  const budget = startBudget(prevStatus?.budget, now);
  setAiBudget(budget);

  const items = readConfig(root);
  if (!items) return { written, items: 0 };
  console.log(`[fetch] ${items.length}개 종목 갱신 시작…`);
  const quotesByCode = {}; // 종목별 등락률을 종합분석 대상 선별에 사용
  const history = {};      // 종합분석에서 추세 입력으로 재사용
  const investors = {};    // 종합분석에서 수급 입력으로 재사용
  const news = {};         // 종합분석에서 뉴스 입력으로 재사용

  // 1) 지수 + 분위기 + 급등락 핵심 이유/수급 브리핑
  const prevBriefs = (readJson('market.json') || {}).briefs || []; // 지수 AI 재사용용(직전 reason)
  try {
    const market = await getMarket();
    if (market?.indices?.length) {
      try {
        const briefs = [];
        for (const [naverSym, ySym, nm] of [['KOSPI', '^KS11', '코스피'], ['KOSDAQ', '^KQ11', '코스닥']]) {
          const idx = market.indices.find((i) => i.symbol === ySym);
          const changePct = idx?.changePct ?? 0;
          const prevReason = prevBriefs.find((b) => b.key === naverSym)?.reason || null;
          // 장 시간이어도 시세가 '마감'이면(휴장일) 장 밖으로 본다 — 등락이 그대로인데 뉴스만 바뀐 재판단 방지
          const open = isKrSession(now) && idx?.marketStatus !== 'CLOSE';
          const [flow, reason] = await Promise.all([getIndexFlow(naverSym), getIndexReason(nm, changePct, prevReason, now, open)]);
          briefs.push({ key: naverSym, name: nm, changePct, price: idx?.price ?? null, flow, reason });
        }
        market.briefs = briefs;
      } catch (e) { console.error('    브리핑 실패:', e.message); }
      write('market.json', market);
    } else console.warn('  ! 지수 데이터 비어 있음 — market.json 유지');
  } catch (e) { console.error('  ✗ 지수 실패 — market.json 유지:', e.message); }

  // 2) 보유 종목 시세
  try {
    const quotes = await getQuotes(items);
    quotes.forEach((q) => { quotesByCode[q.code] = q; });
    if (quotes.some((q) => q.ok)) {
      // 휴장 확인 기록 { KR: 'YYYY-MM-DD', US: … } — 장 시간인데 그 시장 시세가 하나도 '장중'이 아니면 오늘 날짜를 남긴다.
      // 화면은 오늘 기록이 없을 때만 '개장 후 갱신 없음'을 띄운다(수집 중단 경고가 휴장일에 뜨지 않게). 휴장일마다 한 번만 바뀐다.
      const closed = {};
      for (const [m, d] of Object.entries(readJson('quotes.json')?.closed || {})) {
        if ((m === 'KR' || m === 'US') && /^\d{4}-\d{2}-\d{2}$/.test(d)) closed[m] = d;
      }
      for (const m of ['KR', 'US']) {
        const day = closedCheckDay(m, now);
        const list = quotes.filter((q) => q.ok && q.market === m);
        if (day && list.length && !list.some((q) => q.marketStatus === 'OPEN')) closed[m] = day;
      }
      write('quotes.json', Object.keys(closed).length ? { quotes, closed } : { quotes });
    } else console.warn('  ! 시세 전부 실패 — quotes.json 유지');
  } catch (e) { console.error('  ✗ 시세 실패 — quotes.json 유지:', e.message); }

  // 3~5) 과거 시세·수급·뉴스 — 정해진 간격(REFRESH_MIN)에만 새로 받고, 그 사이엔 직전 값 재사용.
  //      받기에 실패한 종목도 직전 값을 지킨다(예전엔 그 종목이 파일에서 빠져 차트·수급이 사라졌다).
  const minute = new Date(now).getUTCMinutes(); // 한국시간과 분은 같다(정시 단위 시차)
  const due = (kind) => refreshAll || minute % REFRESH_MIN[kind] < 5;
  async function collect(kind, label, prevFile, isValid, fetchOne, out) {
    const prev = readJson(prevFile) || {};
    let fresh = 0, kept = 0;
    for (const it of items) {
      const old = isValid(prev[it.code]) ? prev[it.code] : null;
      if (old && !due(kind)) { out[it.code] = old; kept++; continue; }
      try {
        const v = await fetchOne(it);
        if (v && (v.ok !== false || !old)) { out[it.code] = v; fresh++; }
        else if (old) { out[it.code] = old; kept++; }
      } catch (e) {
        console.error(`    ${label} 실패(${it.code}):`, e.message);
        if (old) { out[it.code] = old; kept++; }
      }
    }
    console.log(`  · ${label}: 새로 ${fresh}건 · 직전 값 ${kept}건${due(kind) ? '' : ` (다음 갱신: 매 ${REFRESH_MIN[kind]}분)`}`);
  }
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  // 3) 종목별 과거 시세(일봉 6개월) — 등락 차트 + 예측 입력
  try {
    await collect('history', '과거시세', 'history.json', (v) => isObj(v) && Array.isArray(v.closes) && v.closes.length >= 2, getHistory, history);
    if (Object.keys(history).length) write('history.json', history);
    else console.warn('  ! 과거시세 전부 비어 있음 — history.json 유지');
  } catch (e) { console.error('  ✗ 과거시세 실패 — history.json 유지:', e.message); }

  // 4) 종목별 투자자 순매매(수급) — 한국 종목만, 해외 IP에서 막히면 자동 생략
  try {
    await collect('investors', '수급', 'investors.json', (v) => isObj(v) && 'foreign' in v, getStockInvestors, investors);
    if (Object.keys(investors).length) write('investors.json', investors);
    else console.warn('  ! 수급 데이터 없음(해외 IP 차단 가능) — investors.json 유지');
  } catch (e) { console.error('  ✗ 수급 실패 — investors.json 유지:', e.message); }

  // 5) 종목별 뉴스 (순차 수집으로 과호출 방지) — 받기 실패(ok:false)면 직전 뉴스 유지
  //    미국 종목은 검색 목록(stocklist.json)의 영문 회사명을 함께 넘겨 'Tesla'·'Nvidia'처럼 영문 제목도 관련 기사로 인정한다.
  try {
    const usEn = new Map((readJson('stocklist.json')?.us || []).filter((r) => Array.isArray(r) && r[0]).map((r) => [r[0], r[2] || '']));
    const withEn = (it) => (it.market === 'US' ? { ...it, en: usEn.get(it.code) || '' } : it);
    await collect('news', '뉴스', 'news.json', (v) => isObj(v) && v.ok === true && Array.isArray(v.items), (it) => getNews(withEn(it)), news);
    const anyNews = Object.values(news).some((n) => n && n.items && n.items.length);
    if (anyNews) write('news.json', news);
    else console.warn('  ! 뉴스 전부 비어 있음 — news.json 유지');
  } catch (e) { console.error('  ✗ 뉴스 실패 — news.json 유지:', e.message); }

  // 5-1) 국내 종목 최근 공시(OpenDART) — 무료 인증키(DART_API_KEY)가 있을 때만, 뉴스와 같은 간격으로(dart.mjs 참고).
  //      키가 없으면 건너뛴다(저장소에 둔 빈 파일 {} 그대로 — 화면이 없는 파일을 매분 요청하지 않게). 멈춘 이유는 status.json의 dart에.
  const disclosures = {}; // 종합분석에서 공시 입력으로 재사용
  let dartState = null;
  if (dartEnabled()) try {
    resetDart();
    const kr = items.filter((it) => it.market === 'KR').map((it) => it.code);
    const corp = await ensureCorpTable(readJson('dartcorp.json'), kr, now);
    if (corp.changed) write('dartcorp.json', corp.table);
    if (corp.error) console.error('    공시 고유번호 목록 받기 실패:', corp.error);
    await collect('disclosures', '공시', 'disclosures.json', (v) => isObj(v) && v.ok === true && Array.isArray(v.items),
      (it) => getDisclosures(it, corp.table.map, now), disclosures);
    dartState = dartHalted() || (corp.table.at ? 'ok' : `고유번호 목록 받기 실패 — ${corp.error || '다음 회차에 다시 시도'}`);
    if (dartState !== 'ok') console.warn(`  ! 공시: ${dartState} — 직전 값 유지`);
    write('disclosures.json', disclosures);
  } catch (e) { console.error('  ✗ 공시 실패 — disclosures.json 유지:', e.message); }

  // 6) 급등락 종목 AI 종합분석 (뉴스+수급+추세+시세 종합) — Gemini 키 있을 때만, ±임계치 이상만.
  //    ① 입력 시그니처가 직전과 같으면 재호출 없이 이전 분석 재사용(과호출·장마감 무한커밋 방지).
  //       그 종목 시장이 닫혀 있으면(마감 후·주말) 등락 구간이 그대로인 한 뉴스·수급이 바뀌어도 재사용 —
  //       이미 끝난 움직임을 다시 분석하느라 장중인 시장의 한도를 쓰지 않게.
  //    ② 새로 호출하는 건수는 회차당 AI_CALLS_PER_RUN개로 제한하고 변동이 큰 종목부터 처리한다.
  //       한도에 걸린 종목은 이전 분석을 그대로 유지하고 다음 회차에 갱신되므로 화면에서 사라지지 않는다.
  //    ③ 하루 예산을 장 시간에 맞춰 나눠 쓴다(aibudget.mjs) — 지금 쓸 차례가 아니면 ②와 같이 다음 회차로 미룬다.
  //    ④ 시세를 하나도 못 받은 회차엔 손대지 않는다 — 급등락 대상이 '없음'으로 보여 기존 분석을 {}로 지우던 문제 방지.
  if (!Object.values(quotesByCode).some((q) => q && q.ok)) console.warn('  ! 시세 없음 — analysis.json 유지');
  else try {
    const prev = readJson('analysis.json') || {};
    const analysis = {};
    const movers = items
      .map((it) => ({ it, q: quotesByCode[it.code] }))
      .filter(({ q }) => q && q.ok && Math.abs(q.changePct ?? 0) >= STOCK_ANALYSIS_THRESHOLD)
      .sort((a, b) => Math.abs(b.q.changePct ?? 0) - Math.abs(a.q.changePct ?? 0));
    let calls = 0, deferred = 0, waited = 0;
    for (const { it, q } of movers) {
      const sig = analysisSig(q, news[it.code], investors[it.code], disclosures[it.code]);
      const p = prev[it.code];
      const open = inSession(it.market, now) && q.marketStatus !== 'CLOSE'; // 장 시간이어도 시세가 '마감'이면 휴장일
      const settled = p && !open && sigMove(p.sig) === sigMove(sig);
      if (p && (p.sig === sig || settled)) { analysis[it.code] = p; continue; } // 입력 동일·장 밖 → 재사용
      const gate = aiGate();
      if (calls >= AI_CALLS_PER_RUN || gate !== 'go') { // 회차 상한·시간 배분·AI 꺼짐 → 기존 분석 유지, 다음 회차에 갱신
        if (prev[it.code]) analysis[it.code] = prev[it.code];
        if (gate === 'wait') { noteAiSkipped(); waited++; } else if (gate === 'go') deferred++;
        continue;
      }
      calls++;
      try {
        const a = await aiStockAnalysis({ quote: q, news: news[it.code], flow: investors[it.code], history: history[it.code], disclosures: disclosures[it.code], now });
        if (a) analysis[it.code] = { ...a, sig, at: now };
        else if (prev[it.code]) analysis[it.code] = prev[it.code]; // 일시적 실패 시 기존 분석 유지
      } catch (e) { console.error(`    종합분석 실패(${it.code}):`, e.message); if (prev[it.code]) analysis[it.code] = prev[it.code]; }
    }
    console.log(`  · 종합분석 대상 ${movers.length}건 — 신규 호출 ${calls}건, 다음 회차로 미룸 ${deferred + waited}건${waited ? `(한도 배분 대기 ${waited})` : ''}`);
    write('analysis.json', analysis);
  } catch (e) { console.error('  ✗ 종합분석 실패 — analysis.json 유지:', e.message); }

  // AI 상태 한 줄 요약 — 키 없음/모델 전환/할당량 소진/배분 대기를 Actions 로그에서 바로 알 수 있게
  const st = aiStatus();
  const models = aiModels();
  const used = totalUsed(budget, models);
  const cap = Math.max(capacity(budget, models), used); // 리셋 직전 1시간 몰아쓰기로 예산을 넘겨도 '25/20'처럼 보이지 않게
  if (!st.enabled) console.log('  · AI: 키 없음(GEMINI_API_KEY 미설정) — 헤드라인 폴백');
  else {
    const outs = Object.entries(budget.out).map(([m, w]) => `${m}:${w}`).join(', ');
    console.log(`  · AI: 요청 ${st.calls}회 · 성공 ${st.ok}${st.failures ? ` · 실패 ${st.failures}` : ''}${st.skipped ? ` · 배분 대기 ${st.skipped}` : ''}`
      + `${st.disabled ? ` · 중지(${st.disabled})` : ''} · 오늘(${budget.day} PT) ${used}/${cap}회${outs ? ` · 제외 ${outs}` : ''}`);
  }

  // AI 상태 기록(status.json) — 화면 하단 'AI 상태' 표시 + 다음 회차가 이어받을 하루 예산(budget).
  // 이번 회차에 AI를 부를 일이 없었으면(전부 재사용) 직전 상태를 이어 쓴다. 내용이 같으면 쓰지 않는다(불필요한 커밋 방지).
  const prevState = prevStatus?.ai?.state;
  let state;
  if (!st.enabled) state = 'off';
  else if (st.disabled) state = st.disabled;                    // auth · quota · no-model (이번 회차 중지)
  else if (st.calls > 0) state = st.ok > 0 ? 'ok' : 'error';
  else if (models.length && models.every((m) => budget.out[m])) { // 오늘 쓸 모델이 없음 — 이번 회차는 부르지도 않음
    state = Object.values(budget.out).every((w) => w === 'unavailable') ? 'no-model' : 'quota';
  } else if (st.skipped > 0) state = 'wait';                     // 분석할 게 있지만 시간 배분상 다음으로 미룸
  else state = !prevState || ['quota', 'no-model', 'wait', 'off'].includes(prevState) ? 'idle' : prevState; // 날이 바뀌어 한도가 풀렸거나 대기 해소
  const ai = { state, model: st.model ?? prevStatus?.ai?.model ?? null, used, cap };
  if (state === 'wait') { // 순서 대기면 다음에 AI를 쓸 수 있는 시각도 남긴다(화면: '다음 분석 22:40부터')
    const next = nextAllowanceAt(budget, models, now);
    if (next != null) ai.next = next;
  }
  const status = st.enabled ? { ai, budget: toStored(budget) } : { ai: { state } };
  if (dartState) status.dart = dartState; // 공시 수집 상태(키 있을 때만) — 'ok' 또는 멈춘 이유(화면 하단 표시)
  if (JSON.stringify(status) !== JSON.stringify(prevStatus)) {
    try { write('status.json', status); } catch (e) { console.error('  ✗ AI 상태 기록 실패:', e.message); }
  }
  console.log('[fetch] 완료');
  return { written, items: items.length, ai: st };
}

// 직접 실행(`node scripts/fetch.mjs`)일 때만 바로 돈다. 어떤 오류도 exit 0 — Action을 실패로 만들지 않는다.
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.error('[fetch] 치명적 오류(기존 데이터 유지):', e);
    process.exitCode = 0;
  });
}
