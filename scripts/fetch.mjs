// pages/scripts/fetch.mjs
// GitHub Actions가 주기적으로 실행 → 시세·뉴스를 받아 docs/data/*.json 으로 저장한다.
// (GitHub Pages는 이 JSON을 정적으로 서빙. 브라우저는 같은 출처라 CORS 문제 없음.)
//
// 예외 처리 원칙:
//  - 일시적 API 실패로 받은 "빈 결과"로 기존의 정상 데이터를 덮어쓰지 않는다(기존 파일 유지).
//  - 한 종류(지수/시세/뉴스)가 실패해도 나머지는 계속 갱신한다.
//  - 어떤 오류가 나도 프로세스는 정상 종료(exit 0)하여 Action을 실패로 만들지 않는다.
//  - 우리 쪽 벽시계 타임스탬프를 저장하지 않는다 → 실제 데이터가 바뀔 때만 커밋되도록(장 마감/주말 무한커밋 방지).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMarket, getQuotes, getNews } from './sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'docs', 'data');
fs.mkdirSync(dataDir, { recursive: true });

function write(name, obj) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(obj));
  console.log(`  ✓ data/${name} 갱신`);
}

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'watchlist.json'), 'utf8'));
    const items = (cfg.items || []).filter((x) => x && x.code).slice(0, 40);
    if (!items.length) throw new Error('watchlist.json에 종목이 없습니다');
    return items;
  } catch (e) {
    console.error('  ✗ config 읽기 실패 — 기존 데이터 유지:', e.message);
    return null;
  }
}

async function run() {
  const items = readConfig();
  if (!items) return;
  console.log(`[fetch] ${items.length}개 종목 갱신 시작…`);

  // 1) 지수 + 분위기
  try {
    const market = await getMarket();
    if (market?.indices?.length) write('market.json', market);
    else console.warn('  ! 지수 데이터 비어 있음 — market.json 유지');
  } catch (e) { console.error('  ✗ 지수 실패 — market.json 유지:', e.message); }

  // 2) 보유 종목 시세
  try {
    const quotes = await getQuotes(items);
    if (quotes.some((q) => q.ok)) write('quotes.json', { quotes });
    else console.warn('  ! 시세 전부 실패 — quotes.json 유지');
  } catch (e) { console.error('  ✗ 시세 실패 — quotes.json 유지:', e.message); }

  // 3) 종목별 뉴스 (순차 수집으로 과호출 방지)
  try {
    const news = {};
    for (const it of items) {
      try { news[it.code] = await getNews(it); }
      catch (e) { console.error(`    뉴스 실패(${it.code}):`, e.message); }
    }
    const anyNews = Object.values(news).some((n) => n && n.items && n.items.length);
    if (anyNews) write('news.json', news);
    else console.warn('  ! 뉴스 전부 비어 있음 — news.json 유지');
  } catch (e) { console.error('  ✗ 뉴스 실패 — news.json 유지:', e.message); }

  console.log('[fetch] 완료');
}

run().catch((e) => {
  console.error('[fetch] 치명적 오류(기존 데이터 유지):', e);
  process.exitCode = 0;
});
