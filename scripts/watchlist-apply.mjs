// pages/scripts/watchlist-apply.mjs — 대시보드 '✏️ 종목 편집' 요청을 config/watchlist.json에 반영
// 워크플로 watchlist.yml이 저장소 주인이 연 이슈(제목 'watchlist:')의 본문을 환경변수 ISSUE_BODY로 넘겨 실행한다.
// 본문은 신뢰하지 않는 입력으로 다룬다 — 크기 제한, ```json 블록만 읽기, 코드 형식 검증(validateWatchlist), 최대 40개.
//
// 요청 형식(본문 속 ```json 블록): { "add": [{ "code": "NVDA", "market": "US", "name": "엔비디아" }], "remove": ["009150"] }
//  · 전체 목록이 아니라 '바꿀 것'만 보낸다 → 그사이 다른 경로로 목록이 바뀌었어도 덮어쓰지 않는다.
// 결과: 바뀌면 watchlist.json을 쓰고, 요약(마크다운)을 RESULT_FILE에, changed=true|false를 GITHUB_OUTPUT에 남긴다.
// 반영할 수 없는 요청이어도 종료 코드는 0 — 이유가 이슈 댓글로 남는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWatchlist, MAX_ITEMS } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 20000;   // 이슈 본문 최대 길이(정상 요청은 수 KB)
const MAX_CHANGES = 60;   // 한 번에 추가+삭제할 수 있는 개수

const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30) : '');

export function parseRequest(body) {
  const s = String(body ?? '');
  if (s.length > MAX_BODY) throw new Error('요청이 너무 깁니다');
  const m = s.match(/```json\s*([\s\S]*?)```/i);
  if (!m) throw new Error('요청 내용(json 블록)을 찾지 못했습니다 — 대시보드의 저장 버튼으로 만든 이슈인지 확인하세요');
  let req;
  try { req = JSON.parse(m[1]); } catch { throw new Error('요청 JSON 형식 오류'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('요청 형식 오류');
  const add = Array.isArray(req.add) ? req.add : [];
  const remove = Array.isArray(req.remove) ? req.remove : [];
  if (!add.length && !remove.length) throw new Error('추가·삭제할 종목이 없습니다');
  if (add.length + remove.length > MAX_CHANGES) throw new Error(`한 번에 ${MAX_CHANGES}개까지만 바꿀 수 있습니다`);
  return {
    add: add.filter((x) => x && typeof x === 'object' && !Array.isArray(x))
      .map((x) => ({ code: String(x.code ?? '').trim(), market: typeof x.market === 'string' ? x.market : '', name: cleanName(x.name) })),
    remove: remove.filter((c) => typeof c === 'string' || typeof c === 'number').map((c) => String(c).trim().toUpperCase()).filter(Boolean),
  };
}

// 현재 목록(items, 검증된 것)에 요청을 적용 — 삭제 먼저, 그다음 추가(형식 오류·중복·40개 초과는 건너뜀)
export function applyRequest(items, req) {
  const removeSet = new Set(req.remove);
  const removed = items.filter((x) => removeSet.has(x.code.toUpperCase()));
  const notFound = req.remove.filter((c) => !items.some((x) => x.code.toUpperCase() === c));
  const next = items.filter((x) => !removeSet.has(x.code.toUpperCase()));
  const added = [], skipped = [];
  for (const a of req.add) {
    const v = validateWatchlist({ items: [a] }).items[0];
    if (!v) { skipped.push({ code: a.code || '(빈 코드)', reason: '코드 형식 오류' }); continue; }
    if (next.some((x) => x.code === v.code)) { skipped.push({ code: v.code, reason: '이미 있음' }); continue; }
    if (next.length >= MAX_ITEMS) { skipped.push({ code: v.code, reason: `최대 ${MAX_ITEMS}개` }); continue; }
    next.push(v);
    added.push(v);
  }
  return { items: next, added, removed, skipped, notFound };
}

// 사람이 깃허브에서 읽고 고치기 쉬운 기존 모양(한 줄에 한 종목) 그대로 쓴다
export function formatWatchlist(items) {
  const rows = items.map((x) => `    { "code": ${JSON.stringify(x.code)}, "market": ${JSON.stringify(x.market)}, "name": ${JSON.stringify(x.name)} }`);
  return `{\n  "items": [\n${rows.join(',\n')}\n  ]\n}\n`;
}

// 이슈 댓글용 요약 — 이름에 섞인 @멘션·코드 블록 기호가 알림·서식을 일으키지 않게 순화
const md = (s) => String(s).replace(/[`*_[\]<>|]/g, '').replace(/@/g, '＠');
const label = (x) => (x.name ? `${md(x.name)}(${md(x.code)})` : md(x.code));
export function summarize(r, warnings = []) {
  const lines = [];
  const changed = r.added.length || r.removed.length;
  lines.push(changed ? `✅ 종목 편집을 반영했습니다 — 총 ${r.items.length}개` : 'ℹ️ 바뀐 내용이 없습니다');
  if (r.added.length) lines.push(`- 추가: ${r.added.map(label).join(', ')}`);
  if (r.removed.length) lines.push(`- 삭제: ${r.removed.map(label).join(', ')}`);
  if (r.skipped.length) lines.push(`- 건너뜀: ${r.skipped.map((s) => `${md(s.code)}(${s.reason})`).join(', ')}`);
  if (r.notFound.length) lines.push(`- 목록에 없어 삭제하지 않음: ${r.notFound.map(md).join(', ')}`);
  if (warnings.length) lines.push(`- 기존 목록 정리(형식 오류 등): ${warnings.map(md).join(' / ')}`);
  if (changed) lines.push('', '시세 갱신을 바로 실행했어요 — 1~2분 뒤 대시보드에 나타납니다.');
  return lines.join('\n');
}

export function run({ root = ROOT, body = process.env.ISSUE_BODY, resultFile = process.env.RESULT_FILE, outputFile = process.env.GITHUB_OUTPUT } = {}) {
  const file = path.join(root, 'config', 'watchlist.json');
  let changed = false, text;
  try {
    const req = parseRequest(body);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`현재 config/watchlist.json을 읽지 못해 반영하지 않았습니다 — 파일 확인 필요 (${e.message})`); }
    const cur = validateWatchlist(cfg);
    if (!Array.isArray(cfg?.items)) throw new Error('현재 config/watchlist.json에 items 배열이 없어 반영하지 않았습니다 — 파일 확인 필요');
    const r = applyRequest(cur.items, req);
    changed = r.added.length > 0 || r.removed.length > 0;
    if (changed) fs.writeFileSync(file, formatWatchlist(r.items));
    text = summarize(r, changed ? cur.warnings : []);
  } catch (e) {
    changed = false;
    text = `⚠️ 반영하지 못했습니다: ${md(e.message)}\n\n대시보드의 ✏️ 종목 편집에서 다시 저장해 주세요.`;
  }
  if (resultFile) fs.writeFileSync(resultFile, text + '\n');
  if (outputFile) fs.appendFileSync(outputFile, `changed=${changed}\n`);
  console.log(text);
  return { changed, text };
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { run(); } catch (e) { console.error('[watchlist-apply] 오류:', e); process.exitCode = 1; }
}
