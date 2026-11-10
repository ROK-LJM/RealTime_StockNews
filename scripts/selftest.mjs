// pages/scripts/selftest.mjs — 오프라인 자체 테스트 (외부 접속 없음)
// 실행: node scripts/selftest.mjs   (pages 폴더에서)
//
// · 네트워크는 가짜 fetch로 대체한다. 등록되지 않은 주소로 나가려 하면 차단하고 테스트를 실패시킨다.
// · 데이터는 OS 임시 폴더에만 쓰고 지운다 — 실제 docs/data, 외부 API, 저장소를 건드리지 않는다.
// · API 키 자리에는 가짜 값만 넣는다(가짜 fetch만 받으므로 어디에도 전송되지 않음).
// · AI 예산은 시각에 따라 달라지므로 파이프라인은 고정 시각(now)으로 돌린다.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------- 가짜 네트워크 ----------
const NET = { routes: [], calls: [], bodies: [], blocked: [] };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  NET.calls.push(u);
  NET.bodies.push(String(opts?.body ?? ''));
  for (const r of NET.routes) { const m = u.match(r.re); if (m) return r.fn(m, u); }
  NET.blocked.push(u);
  throw new Error(`[selftest] 등록되지 않은 외부 호출 차단: ${u}`);
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const text = (s, status = 200) => new Response(s, { status });
const isGemini = (u) => u.includes('generativelanguage');
const geminiCalls = (model) => NET.calls.filter((u) => isGemini(u) && (!model || u.includes(`/models/${model}:`))).length;
// 지수 브리핑용 AI 요청(프롬프트에 '뉴스 목록'이 들어감) 수
const briefCalls = () => NET.calls.filter((u, i) => isGemini(u) && NET.bodies[i].includes('뉴스 목록')).length;

// ---------- 고정 시각 (한도일 = 미 태평양시 날짜, 2026-10-14 PT는 KST 10/14 16:00 ~ 10/15 16:00) ----------
const T = (s) => Date.parse(s);
const MIN = 60 * 1000;
const NOW_KR = T('2026-10-15T03:00:00Z');   // 목 12:00 KST — 국내 장중, 하루 예산의 약 56%가 풀린 시점
const NOW_EVE = T('2026-10-14T08:00:00Z');  // 수 17:00 KST — 한도 리셋 직후, 아직 장 시간 전(배분 0)
const NEXT_DAY = NOW_KR + 1440 * MIN;       // 다음 한도일 같은 시각
const QDAY = '2026-10-14';

// ---------- 픽스처(실제 응답 형태를 본뜬 최소 데이터) ----------
const DAY = 86400;
// pct를 주면 그만큼 등락한 것으로(전일 종가 조정), 없으면 +0.1% 안팎
function yahooChart(sym, pct) {
  const isKR = /\.K[SQ]$/.test(sym);
  const base = sym === '^VIX' ? 18 : sym === 'KRW=X' ? 1390 : sym === 'JPYKRW=X' ? 9.3 : isKR ? 70000 : 200;
  const now = Math.floor(Date.now() / 1000);
  const ts = Array.from({ length: 130 }, (_, i) => now - (130 - i) * DAY);
  const closes = ts.map((_, i) => +(base * (1 + 0.001 * i)).toFixed(2));
  const prevClose = pct == null ? closes.at(-2) : +(closes.at(-1) / (1 + pct / 100)).toFixed(4);
  return { chart: { result: [{
    meta: {
      regularMarketPrice: closes.at(-1), chartPreviousClose: prevClose, currency: isKR ? 'KRW' : 'USD', shortName: sym,
      regularMarketDayHigh: base * 1.2, regularMarketDayLow: base * 0.9, regularMarketOpen: base, regularMarketVolume: 1000,
      regularMarketTime: now, currentTradingPeriod: { regular: { start: now - 3600, end: now + 3600 } }, instrumentType: 'EQUITY',
    },
    timestamp: ts, indicators: { quote: [{ close: closes }] },
  }] } };
}
const naverStock = (code, pct, status = 'OPEN', at = null, extra = {}) => ({ datas: [{
  stockName: `종목${code}`, closePrice: '70,000', compareToPreviousClosePrice: String(Math.round(Math.abs(70000 * pct / 100))),
  fluctuationsRatio: String(Math.abs(pct)), compareToPreviousPrice: { name: pct > 0 ? 'RISING' : pct < 0 ? 'FALLING' : 'EVEN' },
  openPrice: '69,000', highPrice: '71,000', lowPrice: '68,000', accumulatedTradingVolume: '1,234,567',
  marketStatus: status, localTradedAt: (at == null ? new Date() : new Date(at)).toISOString(), ...extra,
}] });
const naverIndex = (pct, status = 'OPEN') => ({ datas: [{ closePriceRaw: '2,600.00', compareToPreviousClosePriceRaw: (2600 * pct / 100).toFixed(1), fluctuationsRatioRaw: pct.toFixed(2), marketStatus: status }] });
const trendStock = [{ bizdate: '20261015', foreignerPureBuyQuant: '-1,000', organPureBuyQuant: '500', individualPureBuyQuant: '500', foreignerHoldRatio: '50.00%' }];
const trendIndex = { bizdate: '20261015', personalValue: '+1,000', foreignValue: '-800', institutionalValue: '-200' };
// tag를 바꾸면 헤드라인이 달라진다(= 분석 입력이 바뀐 상황)
// 실제 뉴스처럼 제목에 검색한 종목 이름이 들어간다(관련도 필터 통과) — name은 검색어에서 '주가'·'stock' 앞부분
const queryName = (u) => String(new URL(u).searchParams.get('q') || '').replace(/\s+when:\S+/, '').replace(/\s+(주가|stock)$/, '').trim();
// 가짜 기사 시각은 한 번 실행하는 동안 고정 — 넓혀 찾는 두 번째 검색(37차)과 시각이 1초 갈리면 같은 소식 중 남는 제목이 달라져 테스트가 흔들렸다
const RSS_PUB = new Date(Date.now() - 3600e3).toUTCString();
function rss(tag = '', name = '') {
  const pub = RSS_PUB; // 최근 2일 필터 통과
  const items = [1, 2, 3].map((i) => `<item><title>${tag ? `${tag} ` : ''}${name ? `${name} ` : ''}테스트 뉴스 ${i} 급등 - 테스트일보</title><link>https://news.example.com/a${i}</link><pubDate>${pub}</pubDate><source url="https://news.example.com">테스트일보</source></item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}
// 지수 브리핑(summary·items)과 종목 분석(headline·factors) 양쪽 형식을 모두 만족하는 응답
const geminiOk = { candidates: [{ content: { parts: [{ text: JSON.stringify({
  summary: '테스트 요약', items: [{ index: 1, why: '핵심 재료' }], headline: '테스트 진단', factors: ['요인1', '요인2'], outlook: '관전 포인트',
}) }] } }] };
// 실제 무료 한도 초과 응답 형태 — 일일 한도는 quotaId에 PerDay, 분당 한도는 PerMinute가 들어간다
const quota429 = (per) => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.',
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: `GenerateRequestsPer${per}PerProjectPerModel-FreeTier` }] }] } }, 429);

// ---------- 공시(OpenDART) 픽스처 ----------
// ZIP(실제 고유번호 파일 형식) — files: [[이름, 내용]]. descriptor: 로컬 헤더에 크기를 비우고 뒤에 데이터 설명자를 붙이는 형식
function makeZip(files, { method = 8, descriptor = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const flag = descriptor ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flag, 6); lh.writeUInt16LE(method, 8);
    if (!descriptor) { lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); }
    lh.writeUInt16LE(nm.length, 26);
    const dd = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) { dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(data.length, 8); dd.writeUInt32LE(raw.length, 12); }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flag, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, nm, data, dd); central.push(ch, nm);
    offset += lh.length + nm.length + data.length + dd.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
// 고유번호 XML — 테스트 종목 + 가짜 상장사 1,100개 + 비상장사(종목코드 빈칸)
function corpXml(extra = {}) {
  const rows = { '005930': '00126380', '000660': '00164779', ...extra };
  for (let i = 0; i < 1100; i++) rows[String(100000 + i)] ??= String(90000000 + i);
  const list = Object.entries(rows).map(([s, c]) =>
    `  <list>\n    <corp_code>${c}</corp_code>\n    <corp_name>회사${s}</corp_name>\n    <corp_eng_name>Co ${s}</corp_eng_name>\n    <stock_code>${s}</stock_code>\n    <modify_date>20260101</modify_date>\n  </list>`);
  list.push('  <list>\n    <corp_code>00999999</corp_code>\n    <corp_name>비상장</corp_name>\n    <corp_eng_name>X</corp_eng_name>\n    <stock_code> </stock_code>\n    <modify_date>20260101</modify_date>\n  </list>');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n${list.join('\n')}\n</result>\n`;
}
// 공시 목록 — 고유번호별 [접수번호, 제목, 비고(rm)]. 응답 순서는 일부러 섞어 둔다(정렬 확인)
const DART_ROWS = {
  '00126380': [
    ['20261014000500', '임원ㆍ주요주주특정증권등소유상황보고서'],
    ['20261015000321', '단일판매ㆍ공급계약체결'],
    ['20261015000100', '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)', '연'],
    ['20261014000400', '자기주식취득결정', '철'],
    ['20261013000200', '현금ㆍ현물배당결정'],
    ['20261010000050', '기업설명회(IR)개최(안내공시)'],
    ['20261002000010', '분기보고서 (2026.09)'],
  ],
  '00164779': [['20261012000777', '주식등의대량보유상황보고서(일반)']],
};
const dartList = (corp, rows) => ({ status: '000', message: '정상', page_no: 1, page_count: 10, total_count: rows.length, total_page: 1,
  list: rows.map(([no, nm, rm = '']) => ({ corp_cls: 'Y', corp_name: '회사', corp_code: corp, stock_code: '', report_nm: nm, rcept_no: no, flr_nm: '회사', rcept_dt: no.slice(0, 8), rm })) });
// 공시 원본(document.xml ZIP 속 본문) 표본 — 실제 원본의 꼴(2026-10-23 봇 진단 diag로 확인)을 본뜸, 줄 구성은 DART 뷰어에서 읽은 실제 공시:
//   거래소 공시 = XForms HTML(소문자 태그, 태그마다 CRLF 줄바꿈·들여쓰기, <style> 블록, 값은 span.xforms_input) → docXml·docRow
//   주요사항보고서 = DART XML(dart4 — 대문자 TR·TD·TE·TU, LF 줄바꿈, 날짜는 'YYYY년 MM월 DD일') → dartXml·dartRow
const xfCell = (c) => `       <td width="120"> <span ${/^(?:\d{4}-\d{2}-\d{2}|\d{1,2} ?: ?\d{2})$/.test(c) ? 'class="xforms_input" ' : ''}style="width:120px;font-size:10pt;">${c}</span> </td> \r\n`;
const docRow = (...cells) => `      <tr> \r\n${cells.map(xfCell).join('')}      </tr> \r\n`;
const docXml = (title, rows) => `<html>\r\n <head>\r\n  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">\r\n  <style type="text/css">\r\n.xforms * { font-family: 돋움체;}\r\n.xforms td {\r\npadding-left:0px;\r\nline-height:22px;\r\n}\r\n</style>\r\n`
  + `  <title>${title}</title>\r\n </head>\r\n <body> \r\n  <div class="xforms"> \r\n   <div> \r\n    <div class="xforms_title"> \r\n     <div> \r\n      <span style="width:600px;font-weight:bold;text-align:center;">${title}</span> \r\n     </div> \r\n    </div> \r\n`
  + `    <table border="1" bordercolordark="white" bordercolorlight="#666666" cellpadding="1" cellspacing="0" id="XFormD5_Form0_Table13"> \r\n     <tbody> \r\n${rows.join('')}     </tbody> \r\n    </table> \r\n   </div> \r\n  </div> \r\n </body>\r\n</html>\r\n`;
const dartRow = (...cells) => `<TR ACOPY="Y" ADELETE="Y">\n${cells.map((c) => (/^20\d{2}년 \d{2}월 \d{2}일$/.test(c) ? `<TE><TU AUNIT="DATE" AUNITVALUE="${c.replace(/\D/g, '')}">${c}</TU></TE>` : `<TD>${c}</TD>`)).join('\n')}\n</TR>\n`;
const dartXml = (title, rows) => `<?xml version="1.0" encoding="utf-8"?>\n<DOCUMENT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="dart4.xsd">\n<DOCUMENT-NAME ACODE="11300">${title}</DOCUMENT-NAME>\n`
  + `<BODY ATOCID="2">\n<LIBRARY>\n<SECTION-1 ACLASS="MANDATORY">\n<TITLE ATOC="Y">${title}</TITLE>\n<TABLE ACLASS="NORMAL" WIDTH="600" BORDER="1">\n<TBODY>\n${rows.join('\n')}</TBODY>\n</TABLE>\n</SECTION-1>\n</LIBRARY>\n</BODY>\n</DOCUMENT>\n`;
const DOCS = {
  earnNotice: ['결산실적공시예고(안내공시)', docXml('결산실적공시 예고', [
    docRow('1. 회사명', '두산에너빌리티(주) (Doosan Enerbility Co., Ltd.)'), docRow('2. 결산대상기간', '시작일', '2026-01-01'), docRow('종료일', '2026-09-30'),
    docRow('3. 결산실적 공시예정일', '2026-10-29'),
    docRow('4. 기타 투자판단과 관련한 중요사항', '- 상기 공시예정일에 공시하는 실적은 확정치가 아닌 잠정치이며 외부감사인의 감사결과에 따라 변동될 수 있습니다.')])],
  ir: ['기업설명회(IR)개최(안내공시)', docXml('기업설명회(IR) 개최(안내공시)', [
    docRow('1. 일시 및 장소', '일시', '2026-10-29', '15:45'), docRow('장소', '-'), docRow('2. 참가 대상자', '증권사 애널리스트'),
    docRow('3. 개최목적', '2026년 3분기 경영실적 발표'), docRow('4. 개최방법', '컨퍼런스 콜'), docRow('7. 결정일자', '2026-10-22'),
    docRow('8. IR 자료', '게재일시', '2026-10-30')])],
  record: ['주주명부폐쇄기간또는기준일설정', docXml('주주명부폐쇄기간 또는 기준일 설정', [
    docRow('1. 기준일', '2026-10-29'), docRow('2. 명의개서정지기간', '시작일', '-'), docRow('종료일', '-'), docRow('3. 설정사유', '임시주주총회 개최를 위한 권리주주 확정')])],
  retire: ['주식소각결정', docXml('주식 소각 결정', [
    docRow('1. 소각할 주식의 종류와 수', '보통주식 (주)', '14,465,408'), docRow('5. 소각을 위한 자기주식 취득 예정기간', '시작일', '2026-10-23'), docRow('종료일', '2027-01-22'),
    docRow('7. 소각 예정일', '-'), docRow('9. 이사회결의일(결정일)', '2026-10-22'),
    docRow('11. 기타 투자판단과 관련한 중요사항', '- 상기 1. 소각할 주식의 종류와 수는 이사회 결의일 전일 종가(2026년 10월 21일 기준: 47,700원)을 기준으로 산정하였습니다.')])],
  meetFix: ['[기재정정]주주총회소집결의', docXml('주주총회소집결의', [
    docRow('정정일자', '2026-10-23'), docRow('2. 정정관련 공시서류제출일', '2026-10-22'), docRow('정정항목', '정정전', '정정후'), docRow('2. 일시', '2026-12-04', '10 : 00'),
    docRow('1. 구분', '임시주주총회'), docRow('2. 일시', '2026-12-11', '09 : 00'), docRow('3. 장소', '서울특별시 영등포구 국제금융로2길 28 본사 5층 강당'),
    docRow('4. 의결권행사기준일', '2026-11-06'), docRow('5. 이사회결의일(결정일)', '2026-10-22')])],
  dividend: ['현금ㆍ현물배당결정', docXml('현금ㆍ현물배당결정', [
    docRow('1. 배당구분', '분기배당'), docRow('3. 1주당 배당금(원)', '보통주식', '370'), docRow('종류주식', '370'), docRow('5. 배당금총액(원)', '2,452,947,961,500'),
    docRow('6. 배당기준일', '2026-09-30'), docRow('7. 배당금지급 예정일자', '2026-11-20'), docRow('10. 이사회결의일(결정일)', '2026-10-30')])],
  // 해외 IR(여러 날) — 날짜가 '일시' 줄이 아니라 머리 줄 아래 값 줄에, 목적·방법은 '실시목적·실시방법'(실제 파두 2026-10-08 공시)
  irMulti: ['기업설명회(IR)개최', docXml('기업설명회(IR) 개최', [
    docRow('1. 일시', '행사일', '시간(현지시간)'), docRow('시작일', '종료일', '시작시간', '종료시간'), docRow('2026-10-12', '2026-10-16', '09:00', '18:00'),
    docRow('2. 장소', '미주'), docRow('3. 대상자', '해외 기관투자자'), docRow('4. 실시목적', '당사 경영현황에 대한 투자자 이해증진'),
    docRow('5. 실시방법', 'NDR (Non-Deal Roadshow)'), docRow('8. 개최확정일', '2026-10-08'), docRow('10. IR 자료게재', '게재일시', '2026-10-08')])],
  buyback: ['주요사항보고서(자기주식취득결정)', dartXml('주요사항보고서(자기주식 취득 결정)', [
    dartRow('금융위원회 / 한국거래소 귀중', ' 2026 년    10 월    22 일'),
    dartRow('1. 취득예정주식(주)', '보통주식', '14,465,408'), dartRow('기타주식', '-'),
    dartRow('3. 취득예상기간', '시작일', '2026년 10월 23일'), dartRow('종료일', '2027년 01월 22일'),
    dartRow('4. 보유예상기간', '시작일', '-'), dartRow('종료일', '-'), dartRow('7. 취득결정일', '2026년 10월 22일')])],
};
// 원본 ZIP에 함께 든 첨부(감사보고서 등 '{접수번호}_00760.xml') — 본문이 아니므로 여기 날짜를 쓰면 안 된다(ZIP에서 앞에 있고 더 크다)
const ATTACH_DOC = docXml('첨부', [docRow('1. 일시', '2026-12-31', '10:00'), docRow('3. 결산실적 공시예정일', '2026-12-30'),
  docRow('6. 배당기준일', '2026-12-28'), docRow('7. 배당금지급 예정일자', '2026-12-27'), docRow('비고', '첨부 서류 '.repeat(40))]);
// 나스닥 응답(실제 형태, 2026-10-23 AAPL) — 실적 발표일 · 배당
const NASDAQ_EARN = { data: { reportText: "Apple Inc. Common Stock is expected* to report earnings on  11/02/2026 after market close.  The report will be for the fiscal Quarter ending Sep 2026.", heading: 'AAPL Earnings Date', announcement: 'Earnings announcement* for AAPL: Nov 02, 2026' }, message: null, status: { rCode: 200 } };
const NASDAQ_DIV = { data: { exDividendDate: '08/10/2026', dividends: { rows: [
  { exOrEffDate: '08/10/2026', type: 'Cash', amount: '$0.27', declarationDate: '07/30/2026', recordDate: '08/10/2026', paymentDate: '08/13/2026', currency: 'USD' },
  { exOrEffDate: '05/11/2026', type: 'Cash', amount: '$0.27', declarationDate: '04/30/2026', recordDate: '05/11/2026', paymentDate: '05/14/2026', currency: 'USD' },
  { exOrEffDate: 'N/A', type: 'Cash', amount: 'N/A', declarationDate: 'N/A', recordDate: 'N/A', paymentDate: 'N/A', currency: 'USD' }] } }, message: null, status: { rCode: 200 } };
const DART_KEY = 'selftest-dart-dummy-key-000000000000000000';
async function withDartKey(fn) {
  process.env.DART_API_KEY = DART_KEY;
  try { return await fn(); } finally { delete process.env.DART_API_KEY; }
}

function routes({ krPct = { '005930': 4.2, '000660': 0.3 }, krAt = null, krExtra = {}, usPct = {}, idxPct = -1.2, krStatus = 'OPEN', idxStatus = 'OPEN', newsTag = '', news = (m, u) => text(rss(newsTag, queryName(u))),
  yahoo = (m, u) => { // 시간외(5분봉) 요청엔 기본적으로 체결 없음 — 시간외 전용 테스트만 봉을 준다
    const sym = decodeURIComponent(m[1]);
    return json(/interval=5m/.test(u) ? { chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }] } } : yahooChart(sym, usPct[sym]));
  }, gemini = () => json(geminiOk),
  corpZip = () => new Response(makeZip([['CORPCODE.xml', corpXml()]])), dartRows = DART_ROWS,
  dartList: listFn = (corp) => json(dartList(corp, dartRows[corp] || [])), dartDocs = {},
  nasdaq = (kind, sym) => (sym !== 'AAPL' ? text('not found', 404) : json(kind === 'earn' ? NASDAQ_EARN : NASDAQ_DIV)) } = {}) {
  return [
    { re: /opendart\.fss\.or\.kr\/api\/document\.xml\?/, fn: (m, u) => { const no = new URL(u).searchParams.get('rcept_no'), d = dartDocs[no];
      return d ? new Response(makeZip([[`${no}_00760.xml`, ATTACH_DOC], [`${no}.xml`, d]])) : json({ status: '014', message: '파일이 존재하지 않습니다' }); } },
    { re: /api\.nasdaq\.com\/api\/(?:analyst\/([^/]+)\/earnings-date|quote\/([^/]+)\/dividends)/, fn: (m) => nasdaq(m[1] ? 'earn' : 'div', decodeURIComponent(m[1] || m[2])) },
    { re: /opendart\.fss\.or\.kr\/api\/corpCode\.xml\?/, fn: (m, u) => corpZip(u) },
    { re: /opendart\.fss\.or\.kr\/api\/list\.json\?/, fn: (m, u) => listFn(new URL(u).searchParams.get('corp_code'), u) },
    { re: /polling\.finance\.naver\.com\/api\/realtime\/domestic\/stock\/(\d{6})/, fn: (m) => json(naverStock(m[1], krPct[m[1]] ?? 0.5, krStatus, krAt, krExtra[m[1]])) },
    { re: /polling\.finance\.naver\.com\/api\/realtime\/domestic\/index\/(KOSPI|KOSDAQ)/, fn: () => json(naverIndex(idxPct, idxStatus)) },
    { re: /m\.stock\.naver\.com\/api\/stock\/(\d{6})\/trend/, fn: () => json(trendStock) },
    { re: /m\.stock\.naver\.com\/api\/index\/(KOSPI|KOSDAQ)\/trend/, fn: () => json(trendIndex) },
    { re: /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/([^?]+)/, fn: yahoo },
    { re: /news\.google\.com\/rss\/search/, fn: news },
    { re: /generativelanguage\.googleapis\.com\/v1beta\/models\/([^:]+):generateContent/, fn: (m) => gemini(decodeURIComponent(m[1])) },
  ];
}
// AI를 부를 일이 전혀 없는 회차 — 헤드라인 0건(지수 AI 없음) + 급등락 종목 없음
const CALM = { krPct: { '005930': 0.4, '000660': 0.3 }, news: () => text('<?xml version="1.0"?><rss><channel></channel></rss>') };

// ---------- 임시 작업공간 ----------
const FILES = ['analysis.json', 'history.json', 'investors.json', 'market.json', 'news.json', 'quotes.json', 'status.json'];
const ITEMS = [{ code: '005930', market: 'KR', name: '삼성전자' }, { code: '000660', market: 'KR', name: 'SK하이닉스' }, { code: 'AAPL', market: 'US', name: '애플' }];
// 시드용 AI 상태 — NOW_KR과 같은 한도일, 파이프라인이 쓰는 것과 같은 형식(같은 내용이면 다시 쓰지 않는지 확인용)
const statusSeed = (used = { 'model-primary': 1 }, state = 'ok') => ({
  ai: { state, model: 'model-primary', used: Object.values(used).reduce((a, n) => a + n, 0), cap: 40 },
  budget: { day: QDAY, used, out: {} },
});
const workspaces = [];
function workspace(items = ITEMS, seed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-selftest-'));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'watchlist.json'), typeof items === 'string' ? items : JSON.stringify({ items }));
  if (seed) for (const f of FILES) fs.writeFileSync(file(root, f), JSON.stringify(f === 'status.json' ? statusSeed() : { seed: f }));
  return root;
}
const file = (root, f) => path.join(root, 'docs', 'data', f);
const read = (root, f) => JSON.parse(fs.readFileSync(file(root, f), 'utf8'));
const raw = (root, f) => fs.readFileSync(file(root, f), 'utf8');
const writeData = (root, f, obj) => fs.writeFileSync(file(root, f), JSON.stringify(obj));

// 파이프라인 로그는 모아 두고(실패 시 원인 확인용) 화면에는 결과만 보여준다
async function quiet(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(' '));
  try { return { value: await fn(), lines }; } finally { Object.assign(console, orig); }
}
// 기본은 과거 시세·수급·뉴스를 매번 새로 받는다(refreshAll) — 간격 재사용 자체는 전용 테스트에서 검증
async function pipeline(root, routeOpts, now = NOW_KR, { refreshAll = true, calendar = false } = {}) {
  NET.routes = routes(routeOpts); NET.calls = []; NET.bodies = []; NET.blocked = [];
  return quiet(() => run({ root, now, refreshAll, calendar }));
}

// ---------- 테스트 러너 ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (e) { results.push({ ok: false, name, err: e }); }
}

// 가짜 키·모델명 — 가짜 fetch만 받는다
process.env.GEMINI_API_KEY = 'selftest-dummy-key';
process.env.GEMINI_MODEL = 'model-primary';
process.env.GEMINI_FALLBACK_MODELS = 'model-fallback';
delete process.env.AI_DAILY_BUDGET; // 모델당 기본 예산(20회) 기준으로 검증
delete process.env.DART_API_KEY;    // 공시는 기본 꺼짐 — 키가 필요한 테스트만 가짜 키로 켠다(withDartKey)
const util = await import('./util.mjs');
const bud = await import('./aibudget.mjs');
const src = await import('./sources.mjs');
const { run } = await import('./fetch.mjs');
const stocklist = await import('./stocklist.mjs');
const wl = await import('./watchlist-apply.mjs');
const dartm = await import('./dart.mjs');
const burst = await import('./burst.mjs');
src.retryTiming.baseMs = 1; // 재시도 대기를 실제로 기다리지 않음

console.log('[selftest] 오프라인 자체 테스트 — 외부 접속 없음\n');

// ===== 단위 =====
await test('설정 검증: AI 끔 표시(ai: false)만 남김 — true·글자 등은 버림(기본 켜짐)', () => {
  const r = util.validateWatchlist({ items: [{ code: '005930', ai: false }, { code: 'AAPL', ai: 'false' }, { code: 'MSFT', ai: true }, { code: '000660' }] });
  assert.deepEqual(r.items.map((x) => x.ai), [false, undefined, undefined, undefined]);
  assert.equal(r.warnings.length, 0);
});
await test('설정 검증: 숫자로 적은 국내 코드의 앞자리 0 보정', () => {
  const r = util.validateWatchlist({ items: [{ code: 5930, market: 'KR', name: '삼성' }] });
  assert.equal(r.items[0].code, '005930');
  assert.ok(r.warnings.some((w) => w.includes('보정')));
});
await test('설정 검증: 티커 대문자·시장 추정·중복·형식 오류 제외', () => {
  const r = util.validateWatchlist({ items: [{ code: 'aapl' }, { code: 'AAPL', market: 'US' }, { code: '005930' }, { code: 'ABC123', market: 'KR' }, { code: '<script>', market: 'US' }, {}] });
  assert.deepEqual(r.items.map((x) => [x.code, x.market]), [['AAPL', 'US'], ['005930', 'KR']]);
  assert.equal(r.warnings.length, 4);
});
await test('설정 검증: 국내 6자리 코드를 US로 잘못 적으면 KR로 보정', () => {
  const r = util.validateWatchlist({ items: [{ code: '222800', market: 'US', name: '심텍' }] });
  assert.deepEqual(r.items[0], { code: '222800', market: 'KR', name: '심텍' });
  assert.ok(r.warnings[0].includes('KR로 보정'));
});
await test('설정 검증: 60개 초과분 제외 · items 누락', () => {
  const r = util.validateWatchlist({ items: Array.from({ length: 65 }, (_, i) => ({ code: String(100000 + i) })) });
  assert.equal(r.items.length, 60);
  assert.ok(r.warnings.some((w) => w.includes('최대 60')));
  assert.equal(util.validateWatchlist({}).items.length, 0);
  assert.equal(util.validateWatchlist(null).warnings[0], 'items 배열이 없습니다');
});
await test('원자적 쓰기: 내용 일치 · 임시 파일 안 남음', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-atomic-'));
  workspaces.push(dir);
  const f = path.join(dir, 'a.json');
  util.writeJsonAtomic(f, { x: 1 });
  util.writeJsonAtomic(f, { x: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { x: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
});
await test('동시 실행 제한: 최대 동시 수 준수 · 결과 순서 유지', async () => {
  let active = 0, peak = 0;
  const out = await util.mapLimit([...Array(12).keys()], 5, async (x) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--; return x * 2;
  });
  assert.equal(peak, 5);
  assert.deepEqual(out, [...Array(12).keys()].map((x) => x * 2));
});
await test('분석 시그니처: 1% 구간 안의 변동은 같음 · 구간·뉴스 변화는 다름', () => {
  const n = { items: [{ title: 'A' }] };
  assert.equal(util.analysisSig({ changePct: 2.2 }, n, null), util.analysisSig({ changePct: 2.4 }, n, null));
  assert.notEqual(util.analysisSig({ changePct: 2.4 }, n, null), util.analysisSig({ changePct: 2.6 }, n, null));
  assert.notEqual(util.analysisSig({ changePct: 2.2 }, n, null), util.analysisSig({ changePct: 2.2 }, { items: [{ title: 'B' }] }, null));
});
await test('감성 태깅: 한글 부분일치 · 영문 단어경계(mission≠miss)', () => {
  assert.equal(src.tagSentiment('삼성전자 급등, 사상최대 실적').tone, 'pos');
  assert.equal(src.tagSentiment('실적 쇼크로 급락').tone, 'neg');
  assert.equal(src.tagSentiment('NASA mission update').tone, 'neutral');
});

// ===== AI 예산(aibudget) 단위 =====
await test('한도일: 미 태평양시 자정 리셋(서머타임 07:00Z · 겨울 08:00Z) · 전환일 25/23시간', () => {
  assert.equal(bud.quotaDay(T('2026-10-15T06:59:00Z')), '2026-10-14');
  assert.equal(bud.quotaDay(T('2026-10-15T07:00:00Z')), '2026-10-15');
  assert.equal(bud.quotaDay(T('2026-12-15T07:59:00Z')), '2026-12-14');
  assert.equal(bud.quotaDay(T('2026-12-15T08:00:00Z')), '2026-12-15');
  for (const at of [NOW_KR, T('2026-10-15T03:17:30Z')]) { // 정각이 아닌 시각도 경계는 정확히 리셋 시각
    const r = bud.quotaDayRange(at);
    assert.deepEqual([r.start, r.end], [T('2026-10-14T07:00:00Z'), T('2026-10-15T07:00:00Z')]);
  }
  const fall = bud.quotaDayRange(T('2026-11-01T12:00:00Z'));
  assert.equal((fall.end - fall.start) / 3600e3, 25);
  const spring = bud.quotaDayRange(T('2026-03-08T12:00:00Z'));
  assert.equal((spring.end - spring.start) / 3600e3, 23);
});
await test('장 시간대·시그니처 등락 구간: 시장별 개장 판정 · 구간만 비교', () => {
  assert.equal(bud.inSession('KR', NOW_KR), true);
  assert.equal(bud.inSession('US', NOW_KR), false);
  assert.equal(bud.inSession('US', T('2026-10-14T15:00:00Z')), true);   // 수 11:00 EDT
  assert.equal(bud.inSession('KR', T('2026-10-14T15:00:00Z')), false);  // 목 00:00 KST
  assert.equal(util.sigMove('4|x|뉴스A'), '4');
  assert.equal(util.sigMove(null), '');
});
await test('장 시간 가중치: 국내장 3 · 미국장 1 · 장외·주말 0 (경계 포함)', () => {
  assert.equal(bud.marketWeight(T('2026-10-15T00:00:00Z')), 3);  // 목 09:00 KST 개장
  assert.equal(bud.marketWeight(T('2026-10-14T23:59:00Z')), 0);  // 08:59 KST
  assert.equal(bud.marketWeight(T('2026-10-15T06:59:00Z')), 3);  // 15:59 KST
  assert.equal(bud.marketWeight(T('2026-10-15T07:00:00Z')), 0);  // 16:00 KST
  assert.equal(bud.marketWeight(T('2026-10-14T13:30:00Z')), 1);  // 수 09:30 EDT 개장
  assert.equal(bud.marketWeight(T('2026-10-14T13:29:00Z')), 0);
  assert.equal(bud.marketWeight(T('2026-10-17T03:00:00Z')), 0);  // 토 12:00 KST
});
await test('예산 배분: 장 시간 비례로 풀림 · 덜 쓴 만큼 이월 · 리셋 1시간 전·주말', () => {
  const models = ['a', 'b'];
  const at = (ms, used = {}) => ({ ...bud.startBudget(null, ms), used });
  assert.equal(bud.allowance(at(NOW_EVE), models), 0, '장 시간 전에는 0');
  assert.equal(bud.allowance(at(NOW_KR), models), 22, '40 × 0.5636');
  assert.equal(bud.allowance(at(NOW_KR, { a: 12, b: 10 }), models), 0);
  assert.equal(bud.allowance(at(NOW_KR, { a: 6, b: 4 }), models), 12, '덜 쓴 만큼 이월');
  assert.equal(bud.allowance(at(T('2026-10-15T06:30:00Z'), { a: 25, b: 20 }), models), Infinity, '리셋 1시간 전');
  assert.equal(bud.allowance(at(T('2026-10-18T03:00:00Z')), models), 0, '일요일 낮(장 없음)');
  assert.equal(bud.allowance(at(T('2026-10-18T06:30:00Z')), models), Infinity, '일요일도 리셋 직전엔 남은 한도 사용');
});
await test('모델 배분: 덜 쓴 모델부터 · 빠진 모델은 쓴 만큼만 예산 · 전부 빠지면 0', () => {
  const models = ['a', 'b'];
  assert.equal(bud.pickModel({ used: { a: 2, b: 1 }, out: {} }, models), 'b');
  assert.equal(bud.pickModel({ used: { a: 1, b: 1 }, out: {} }, models), 'a', '같으면 주 모델');
  assert.equal(bud.pickModel({ used: { a: 0, b: 5 }, out: { a: 'quota' } }, models), 'b');
  assert.equal(bud.pickModel({ used: {}, out: { a: 'quota', b: 'unavailable' } }, models), null);
  const b = { ...bud.startBudget(null, NOW_KR), used: { a: 15, old: 9 }, out: { a: 'quota' } };
  assert.equal(bud.capacity(b, models), 35);
  assert.equal(bud.totalUsed(b, models), 15, '설정에서 뺀 모델(old)은 세지 않음');
  assert.equal(bud.allowance({ ...b, out: { a: 'quota', b: 'quota' } }, models), 0);
});
await test('예산 기록: 한도일이 바뀌면 새로 시작 · 손상된 항목은 버림', () => {
  const b = bud.startBudget({ day: QDAY, used: { a: 3, b: 'x', c: -1, d: 1.5 }, out: { a: 'quota', b: '', c: 5 } }, NOW_KR);
  assert.deepEqual([b.used, b.out, b.rolled], [{ a: 3 }, { a: 'quota' }, false]);
  const next = bud.startBudget({ day: QDAY, used: { a: 3 }, out: { a: 'quota' } }, NEXT_DAY);
  assert.deepEqual([next.day, next.used, next.out, next.rolled], ['2026-10-15', {}, {}, true]);
  for (const bad of [null, 'x', [], { day: QDAY, used: [1], out: 'q' }]) {
    const z = bud.startBudget(bad, NOW_KR);
    assert.deepEqual([z.used, z.out], [{}, {}]);
  }
  assert.deepEqual(bud.toStored(b), { day: QDAY, used: { a: 3 }, out: { a: 'quota' } });
});

// ===== 파이프라인(가짜 네트워크) =====
await test('정상: 9개 파일 생성(파일 지문·급등락 기록 포함) · 급등락만 AI 분석 · 두 모델 고루 사용 · 분석 시각 기록 · 외부 차단 0건', async () => {
  const root = workspace();
  const { value } = await pipeline(root);
  assert.deepEqual([...value.written].sort(), [...FILES, 'manifest.json', 'moves.json'].sort());
  const q = read(root, 'quotes.json').quotes;
  assert.equal(q.length, 3);
  assert.ok(q.every((x) => x.ok));
  const a = read(root, 'analysis.json');
  assert.ok(a['005930']?.headline, '+4.2% 종목은 분석');
  assert.equal(a['000660'], undefined, '+0.3% 종목은 분석 안 함');
  assert.equal(a['005930'].at, NOW_KR);
  const m = read(root, 'market.json');
  assert.equal(m.briefs.length, 2);
  // 호출 순서: 코스피 브리핑 → 코스닥 브리핑 → 종목 분석. 덜 쓴 모델부터 → 주·대체·주
  assert.deepEqual([m.briefs[0].reason.ai.model, m.briefs[1].reason.ai.model, a['005930'].model], ['model-primary', 'model-fallback', 'model-primary']);
  assert.equal(m.briefs[0].reason.aiAt, NOW_KR);
  assert.deepEqual(read(root, 'status.json'), {
    ai: { state: 'ok', model: 'model-primary', used: 3, cap: 40 },
    budget: { day: QDAY, used: { 'model-primary': 2, 'model-fallback': 1 }, out: {} },
  });
  assert.ok(read(root, 'history.json').AAPL.closes.length > 100);
  assert.equal(read(root, 'investors.json').AAPL, undefined, '해외 종목 수급 없음');
  assert.equal(NET.blocked.length, 0, `차단된 호출: ${NET.blocked.join(', ')}`);
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs', 'data')).filter((f) => f.endsWith('.tmp')), []);
});
await test('시그니처 재사용: 입력이 같으면 두 번째 회차 AI 호출 0회 · 상태 파일 그대로', async () => {
  const root = workspace();
  await pipeline(root);
  assert.ok(geminiCalls() > 0);
  const before = raw(root, 'analysis.json');
  const statusBefore = raw(root, 'status.json');
  const { value } = await pipeline(root, {}, NOW_KR + 5 * MIN);
  assert.equal(geminiCalls(), 0);
  assert.equal(raw(root, 'analysis.json'), before);
  assert.equal(raw(root, 'status.json'), statusBefore, 'AI 호출이 없던 회차는 상태 파일을 건드리지 않음');
  assert.ok(!value.written.includes('status.json'));
});
await test('전부 실패: 기존 데이터 파일 모두 그대로 · 예외 없이 종료', async () => {
  const root = workspace(ITEMS, true);
  const seeds = Object.fromEntries(FILES.map((f) => [f, raw(root, f)]));
  NET.routes = [{ re: /./, fn: () => { throw new TypeError('fetch failed'); } }];
  NET.calls = []; NET.bodies = []; NET.blocked = [];
  const { value } = await quiet(() => run({ root, now: NOW_KR, calendar: false }));
  assert.deepEqual(value.written, []);
  for (const f of FILES) assert.equal(raw(root, f), seeds[f], `${f} 보존`);
});
await test('부분 실패: 야후 장애 → 국내 시세는 갱신, 과거시세 파일은 보존', async () => {
  const root = workspace(ITEMS, true);
  const histSeed = raw(root, 'history.json');
  await pipeline(root, { yahoo: () => text('upstream error', 500) });
  const q = read(root, 'quotes.json').quotes;
  assert.ok(q.find((x) => x.code === '005930').ok);
  assert.equal(q.find((x) => x.code === 'AAPL').ok, false);
  assert.equal(raw(root, 'history.json'), histSeed, '과거시세는 기존 유지');
  assert.equal(read(root, 'market.json').indices.length, 2, '국내 지수만');
});
await test('AI 모델 사용 불가(404): 대체 모델로 분석 · 그날은 다시 시도 안 함 · 다음 한도일에 재확인', async () => {
  const root = workspace();
  const gemini = (model) => (model === 'model-primary'
    ? json({ error: { code: 404, message: 'models/model-primary is not found' } }, 404)
    : json(geminiOk));
  const { lines } = await pipeline(root, { gemini });
  assert.equal(read(root, 'analysis.json')['005930'].model, 'model-fallback');
  assert.equal(geminiCalls('model-primary'), 1);
  assert.ok(lines.some((l) => l.includes('모델 사용 불가(model-primary)')));
  assert.deepEqual(read(root, 'status.json'), {
    ai: { state: 'ok', model: 'model-fallback', used: 3, cap: 20 },
    budget: { day: QDAY, used: { 'model-fallback': 3 }, out: { 'model-primary': 'unavailable' } },
  });
  await pipeline(root, { gemini, newsTag: 'b' }, NOW_KR + 10 * MIN); // 같은 날, 입력 바뀜 → 새 분석 필요
  assert.ok(geminiCalls('model-fallback') > 0);
  assert.equal(geminiCalls('model-primary'), 0, '같은 한도일엔 주 모델을 다시 부르지 않음');
  await pipeline(root, { gemini, newsTag: 'c' }, NEXT_DAY);
  assert.equal(geminiCalls('model-primary'), 1, '다음 한도일엔 한 번 다시 확인');
});
await test('AI 키 오류(403): 첫 호출 뒤 회차 내 AI 중지', async () => {
  const root = workspace();
  const { value } = await pipeline(root, { gemini: () => json({ error: { code: 403 } }, 403) });
  assert.equal(geminiCalls(), 1);
  assert.equal(value.ai.disabled, 'auth');
  assert.equal(read(root, 'status.json').ai.state, 'auth');
  assert.ok(read(root, 'quotes.json').quotes.every((x) => x.ok), 'AI 장애가 시세 갱신을 막지 않음');
});
await test('AI 분당 한도(429): 모델마다 재시도 2회 후 회차 내 중지 · 하루 제외는 안 함', async () => {
  const root = workspace();
  const { value } = await pipeline(root, { gemini: () => quota429('Minute') });
  assert.deepEqual([geminiCalls('model-primary'), geminiCalls('model-fallback')], [3, 3]);
  assert.equal(value.ai.disabled, 'quota');
  const s = read(root, 'status.json');
  assert.equal(s.ai.state, 'quota');
  assert.deepEqual(s.budget.out, {}, '분당 한도는 기록하지 않음');
  await pipeline(root, {}, NOW_KR + 5 * MIN);
  assert.ok(geminiCalls('model-primary') > 0, '다음 회차엔 바로 다시 사용');
  assert.equal(read(root, 'status.json').ai.state, 'ok');
});
await test('AI 일일 한도(429 PerDay): 재시도 없이 대체 모델로 · 그날은 다시 시도 안 함', async () => {
  const root = workspace();
  const gemini = (model) => (model === 'model-primary' ? quota429('Day') : json(geminiOk));
  await pipeline(root, { gemini });
  assert.equal(geminiCalls('model-primary'), 1, '일일 한도는 재시도하지 않음');
  assert.equal(read(root, 'analysis.json')['005930'].model, 'model-fallback');
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.budget.out, s.ai.cap], ['ok', { 'model-primary': 'quota' }, 20], '빠진 모델은 쓴 만큼(0)만 예산에 남음');
  await pipeline(root, { gemini, newsTag: 'b' }, NOW_KR + 10 * MIN);
  assert.equal(geminiCalls('model-primary'), 0);
});
await test('AI 무료 한도 0인 모델(429 limit: 0): 재시도 없이 그날 사용 불가로 제외 · 다른 모델로 분석', async () => {
  const root = workspace();
  const zero = json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
    message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: model-fallback',
    details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }] } }, 429);
  await pipeline(root, { gemini: (model) => (model === 'model-fallback' ? zero : json(geminiOk)) });
  assert.equal(geminiCalls('model-fallback'), 1, '분당 한도로 오인해 재시도하지 않음');
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.budget.out], ['ok', { 'model-fallback': 'unavailable' }]);
  assert.equal(read(root, 'analysis.json')['005930'].model, 'model-primary');
  await pipeline(root, { newsTag: 'b', gemini: (model) => (model === 'model-fallback' ? zero : json(geminiOk)) }, NOW_KR + 10 * MIN);
  assert.equal(geminiCalls('model-fallback'), 0, '같은 한도일엔 다시 부르지 않음');
});
await test('기본 AI 모델: 무료 Flash-Lite 3종(주 2.5 · 대체 3.5 · 3.1) — 환경변수로 바꿀 수 있음', () => {
  const saved = { m: process.env.GEMINI_MODEL, f: process.env.GEMINI_FALLBACK_MODELS };
  try {
    delete process.env.GEMINI_MODEL; delete process.env.GEMINI_FALLBACK_MODELS;
    src.resetState();
    assert.deepEqual(src.aiModels(), ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    process.env.GEMINI_FALLBACK_MODELS = ' gemini-3.5-flash-lite , ,gemini-2.5-flash-lite ';
    src.resetState();
    assert.deepEqual(src.aiModels(), ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'], '공백·빈 항목·중복 정리');
  } finally {
    process.env.GEMINI_MODEL = saved.m; process.env.GEMINI_FALLBACK_MODELS = saved.f;
    src.resetState();
  }
});
await test('모든 모델 일일 한도 소진: 호출 없이 한도 소진 상태 유지 → 다음 한도일에 자동 재개', async () => {
  const root = workspace();
  await pipeline(root, { gemini: () => quota429('Day') });
  assert.deepEqual([geminiCalls('model-primary'), geminiCalls('model-fallback')], [1, 1]);
  assert.equal(read(root, 'status.json').ai.state, 'quota');
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 10 * MIN);
  assert.equal(geminiCalls(), 0, '같은 한도일엔 부르지 않음');
  assert.equal(read(root, 'status.json').ai.state, 'quota');
  await pipeline(root, { newsTag: 'b' }, NEXT_DAY);
  assert.ok(geminiCalls() > 0);
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.budget.day, s.budget.out], ['ok', '2026-10-15', {}]);
});
await test('지수 브리핑: 이전 AI 실패(null)는 재사용하지 않고 한도 회복 후 다시 생성', async () => {
  const root = workspace();
  await pipeline(root, { gemini: () => quota429('Day') });   // 한도 소진 → 브리핑 AI 실패
  assert.equal(read(root, 'market.json').briefs[0].reason.ai, null);
  await pipeline(root, {}, NEXT_DAY);                           // 한도 회복, 입력은 그대로
  assert.ok(read(root, 'market.json').briefs[0].reason.ai, '실패했던 브리핑 AI를 다시 생성해야 함');
});
await test('지수 브리핑: 90분 안엔 헤드라인이 바뀌어도 재사용 · 지나면 갱신 · 방향 바뀌면 즉시 · 실패 시 이전 판단 유지', async () => {
  const root = workspace();
  const brief = () => read(root, 'market.json').briefs[0].reason;
  await pipeline(root, { newsTag: 'a' });
  assert.equal(briefCalls(), 2);
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 30 * MIN);
  assert.equal(briefCalls(), 0, '30분 뒤: 헤드라인만 바뀜 → 재사용');
  assert.ok(brief().headlines[0].title.startsWith('b '), '헤드라인은 최신으로');
  assert.equal(brief().aiAt, NOW_KR);
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 100 * MIN);
  assert.equal(briefCalls(), 2, '90분이 지나면 갱신 — 직전 회차와 입력이 같아도 판단 당시(a)와 다르면');
  assert.equal(brief().aiAt, NOW_KR + 100 * MIN);
  await pipeline(root, { newsTag: 'b', idxPct: 1.5 }, NOW_KR + 110 * MIN);
  assert.equal(briefCalls(), 2, '급락→급등으로 방향이 바뀌면 바로 갱신');
  assert.equal(brief().dir, 'up');
  const kept = brief().ai;
  await pipeline(root, { newsTag: 'd', idxPct: 1.5, gemini: () => json({ error: { code: 500 } }, 500) }, NOW_KR + 210 * MIN);
  assert.ok(briefCalls() > 0, '갱신 시도');
  assert.deepEqual(brief().ai, kept, '실패하면 이전 판단 유지');
  assert.equal(brief().aiAt, NOW_KR + 110 * MIN);
  await pipeline(root, { newsTag: 'd', idxPct: 1.5 }, NOW_KR + 215 * MIN);
  assert.equal(briefCalls(), 2, '실패했던 갱신은 입력이 그대로여도 다음 회차에 다시 시도');
  assert.equal(brief().aiAt, NOW_KR + 215 * MIN);
  await pipeline(root, { newsTag: 'd', idxPct: -0.5, gemini: () => json({ error: { code: 500 } }, 500) }, NOW_KR + 220 * MIN);
  assert.equal(brief().ai, null, '방향이 바뀌었는데 실패하면 이전(다른 방향) 판단은 버림');
});
await test('장 밖 재사용: 마감한 시장의 지수·종목은 뉴스만 바뀌면 다시 분석 안 함 · 한도는 장중인 시장에', async () => {
  const root = workspace();
  const US_OPEN = T('2026-10-15T15:00:00Z');   // 금 00:00 KST · 목 11:00 EDT — 국내 마감 후, 미국 장중(새 한도일)
  const KR_NEXT = T('2026-10-16T01:00:00Z');   // 금 10:00 KST — 국내 장중, 미국 마감 후
  await pipeline(root, { newsTag: 'a' });                                        // 국내 장중: 브리핑 2 + 005930
  const kr = read(root, 'analysis.json')['005930'];
  const kospi = read(root, 'market.json').briefs[0].reason;
  await pipeline(root, { newsTag: 'b', usPct: { AAPL: 3 } }, US_OPEN);
  assert.equal(briefCalls(), 0, '국내 마감 후: 지수 브리핑 재사용');
  assert.equal(geminiCalls(), 1, '한도는 미국 장중 종목(AAPL)에만');
  let a = read(root, 'analysis.json');
  assert.deepEqual(a['005930'], kr, '국내 종목 분석 그대로');
  assert.equal(a.AAPL.at, US_OPEN);
  assert.deepEqual(read(root, 'market.json').briefs[0].reason.ai, kospi.ai);
  await pipeline(root, { newsTag: 'c', usPct: { AAPL: 3 } }, KR_NEXT);
  a = read(root, 'analysis.json');
  assert.equal(a.AAPL.at, US_OPEN, '미국 마감 후: AAPL 분석 그대로');
  assert.equal(a['005930'].at, KR_NEXT, '국내 장중: 새 뉴스로 다시 분석');
  assert.equal(briefCalls(), 2);
  await pipeline(root, { newsTag: 'd', usPct: { AAPL: -3 } }, KR_NEXT + 5 * MIN);
  assert.ok(read(root, 'analysis.json').AAPL.at > US_OPEN, '장 밖이어도 등락 구간이 바뀌면 다시 분석');
});
await test('장 밖 재사용: 지수도 판단 당시와 등락 구간이 달라졌으면(마감 직전 급변) 마감 후 갱신', async () => {
  const root = workspace();
  await pipeline(root, { idxPct: -1.2 });                                        // 장중 -1.2%에 판단
  await pipeline(root, { idxPct: -2.6 }, T('2026-10-15T15:00:00Z'));             // 마감 후 확인해 보니 -2.6%
  assert.equal(briefCalls(), 2);
  assert.equal(read(root, 'market.json').briefs[0].reason.aiSig.split('|')[0], '-3');
});
await test('시간 배분: 리셋 직후(장 시간 전)엔 순서 대기 → 국내 장중에 분석', async () => {
  const root = workspace();
  const { lines } = await pipeline(root, {}, NOW_EVE);
  assert.equal(geminiCalls(), 0);
  assert.equal(read(root, 'status.json').ai.state, 'wait');
  assert.equal(read(root, 'status.json').ai.next, T('2026-10-14T14:12:00Z'), '다음 분석 가능 시각 기록(23:12 KST)');
  assert.ok(lines.some((l) => l.includes('한도 배분 대기 1')), '종목 분석도 배분 대기로 미룸');
  assert.equal(read(root, 'analysis.json')['005930'], undefined);
  assert.equal(read(root, 'market.json').briefs[0].reason.ai, null);
  await pipeline(root, {}, NOW_KR);
  assert.ok(geminiCalls() > 0);
  assert.equal(read(root, 'status.json').ai.state, 'ok');
  assert.ok(read(root, 'analysis.json')['005930']?.headline);
});
await test('시간 배분: 몫을 다 쓰면 대기, 리셋 1시간 전엔 남은 한도 사용', async () => {
  const root = workspace();
  writeData(root, 'status.json', statusSeed({ 'model-primary': 20, 'model-fallback': 19 }));
  await pipeline(root, {}, T('2026-10-15T05:00:00Z'));   // 14:00 KST — 몫 31회 < 사용 39회
  assert.equal(geminiCalls(), 0);
  assert.equal(read(root, 'status.json').ai.state, 'wait');
  await pipeline(root, {}, T('2026-10-15T06:30:00Z'));   // 15:30 KST — 리셋 30분 전
  assert.equal(geminiCalls(), 3);
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.ai.used, s.ai.cap], ['ok', 42, 42]);
});
await test('AI 상태: 호출할 일 없는 첫 회차는 대기(idle) 기록, 이후 호출 있으면 정상', async () => {
  const root = workspace();
  await pipeline(root, CALM);
  assert.equal(geminiCalls(), 0);
  assert.deepEqual(read(root, 'status.json').ai, { state: 'idle', model: null, used: 0, cap: 40 });
  await pipeline(root);                       // 이번엔 급등 종목·헤드라인 있음 → 실제 호출 → 정상
  assert.equal(read(root, 'status.json').ai.state, 'ok');
});
await test('AI 상태: 한도 소진 표시는 그 한도일 동안 유지 · 다음 한도일엔 분석할 게 없어도 풀림', async () => {
  const root = workspace();
  writeData(root, 'status.json', { ai: { state: 'quota', model: 'model-primary', used: 20, cap: 20 },
    budget: { day: QDAY, used: { 'model-primary': 20 }, out: { 'model-primary': 'quota', 'model-fallback': 'quota' } } });
  await pipeline(root, CALM, NOW_KR + 5 * MIN);
  assert.equal(read(root, 'status.json').ai.state, 'quota');
  await pipeline(root, CALM, NEXT_DAY);
  assert.equal(geminiCalls(), 0);
  const s = read(root, 'status.json');
  assert.deepEqual([s.ai.state, s.budget.day, s.budget.out], ['idle', '2026-10-15', {}]);
});
await test('AI 키 없음: 호출 0회 · 나머지는 정상 갱신', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const root = workspace();
    const { value, lines } = await pipeline(root);
    assert.equal(geminiCalls(), 0);
    assert.equal(value.ai.enabled, false);
    assert.ok(value.written.includes('quotes.json'));
    assert.ok(lines.some((l) => l.includes('키 없음')));
    assert.deepEqual(read(root, 'status.json'), { ai: { state: 'off' } });
  } finally { process.env.GEMINI_API_KEY = saved; }
});
await test('잘못된 설정: 유효 종목 0개·깨진 JSON → 아무것도 쓰지 않음', async () => {
  for (const cfg of [JSON.stringify({ items: [{ code: 'ABC', market: 'KR' }] }), '{ 깨진 json']) {
    const root = workspace(cfg, true);
    const seeds = Object.fromEntries(FILES.map((f) => [f, raw(root, f)]));
    const { value } = await pipeline(root);
    assert.deepEqual(value.written, []);
    for (const f of FILES) assert.equal(raw(root, f), seeds[f]);
    assert.equal(NET.calls.length, 0, '설정이 틀리면 외부 호출도 안 함');
  }
});

// ===== 외부 호출 줄이기 · 휴장일 · 해외 종목 문구 · 다음 분석 시각 =====
const callsTo = (re) => NET.calls.filter((u) => re.test(decodeURIComponent(u))).length;
const HIST_RE = /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/.*range=6mo/;
const STOCK_NEWS_RE = /news\.google\.com\/rss\/search\?q=.*(주가|stock)/;
const STOCK_TREND_RE = /m\.stock\.naver\.com\/api\/stock\/\d{6}\/trend/;
await test('외부 호출 줄이기: 과거시세·수급 30분, 뉴스 15분마다만 새로 받고 그 사이엔 직전 값 · 새 종목은 바로', async () => {
  const root = workspace();
  const opt = { refreshAll: false };
  await pipeline(root, { newsTag: 'a' }, NOW_KR, opt);                       // 12:00 — 모두 갱신 시각
  assert.deepEqual([callsTo(HIST_RE), callsTo(STOCK_NEWS_RE), callsTo(STOCK_TREND_RE)], [3, 3, 2]);
  const hist0 = raw(root, 'history.json');
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 6 * MIN, opt);             // 12:06 — 어느 것도 갱신 시각 아님
  assert.deepEqual([callsTo(HIST_RE), callsTo(STOCK_NEWS_RE), callsTo(STOCK_TREND_RE)], [0, 0, 0], '직전 값 재사용');
  assert.ok(read(root, 'news.json')['005930'].items[0].title.startsWith('a '), '뉴스는 직전 것 그대로');
  assert.equal(raw(root, 'history.json'), hist0);
  assert.equal(geminiCalls(), 0, '뉴스가 그대로라 AI 재분석도 없음');
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 15 * MIN, opt);            // 12:15 — 뉴스만 갱신 시각
  assert.deepEqual([callsTo(HIST_RE), callsTo(STOCK_NEWS_RE), callsTo(STOCK_TREND_RE)], [0, 3, 0]);
  assert.ok(read(root, 'news.json')['005930'].items[0].title.startsWith('b '));
  fs.writeFileSync(path.join(root, 'config', 'watchlist.json'), JSON.stringify({ items: [...ITEMS, { code: '035420', market: 'KR', name: 'NAVER' }] }));
  await pipeline(root, { newsTag: 'b' }, NOW_KR + 21 * MIN, opt);            // 12:21 — 새 종목만 바로
  assert.deepEqual([callsTo(HIST_RE), callsTo(STOCK_NEWS_RE), callsTo(STOCK_TREND_RE)], [1, 1, 1], '추가된 종목만 받음');
  assert.ok(read(root, 'history.json')['035420'] && read(root, 'news.json')['035420'] && read(root, 'investors.json')['035420']);
});
await test('받기에 실패한 종목은 직전 과거시세·뉴스를 유지(파일에서 빠지지 않음)', async () => {
  const root = workspace();
  await pipeline(root);
  const before = read(root, 'history.json').AAPL;
  const yahoo = (m, u) => (/range=6mo/.test(u) && /AAPL/.test(u) ? text('error', 500) : json(yahooChart(decodeURIComponent(m[1]))));
  // 삼성전자 뉴스만 실패(나머지는 성공 → 파일은 새로 써짐) — 실패한 종목은 직전 뉴스를 지켜야 한다
  const news = (m, u) => (decodeURIComponent(u).includes('삼성전자') ? text('error', 500) : text(rss('new', queryName(u))));
  await pipeline(root, { yahoo, news }, NOW_KR + 30 * MIN);
  assert.deepEqual(read(root, 'history.json').AAPL, before, 'AAPL 과거시세 유지');
  const all = read(root, 'news.json');
  assert.ok(all['005930'].ok && all['005930'].items.length && !all['005930'].items[0].title.startsWith('new '), '실패한 종목 → 직전 뉴스 유지');
  assert.ok(all['000660'].items[0].title.startsWith('new '), '성공한 종목은 새 뉴스');
});
await test('휴장일: 장 시간이어도 시세가 마감이면 뉴스만 바뀐 종목·지수는 다시 분석하지 않음', async () => {
  const root = workspace();
  await pipeline(root, { newsTag: 'a' });                                                       // 평일 장중 분석
  await pipeline(root, { newsTag: 'b', krStatus: 'CLOSE', idxStatus: 'CLOSE' }, NOW_KR + 100 * MIN);
  assert.equal(geminiCalls(), 0, '휴장 — 등락 그대로, 뉴스만 바뀜 → 재분석·재판단 없음');
  await pipeline(root, { newsTag: 'c' }, NOW_KR + 200 * MIN);                                    // 장이 열려 있으면 다시
  assert.ok(briefCalls() > 0 && geminiCalls() > briefCalls(), '지수 브리핑·종목 분석 모두 갱신');
});
await test('AI를 꺼 둔 종목(ai: false): 급등락이어도 종합분석 안 함(한도 안 씀) · 직전 분석 버림 · 시세에 ai: false · 급등락 기록은 뉴스·공시 이유', async () => {
  const root = workspace([{ code: '005930', market: 'KR', name: '삼성전자', ai: false }, { code: '000660', market: 'KR', name: 'SK하이닉스' }, { code: 'AAPL', market: 'US', name: '애플' }]);
  writeData(root, 'analysis.json', { '005930': { headline: '예전 분석', summary: '', factors: [], outlook: '', sig: 'x', at: NOW_KR - 3600e3 } });
  await pipeline(root, { usPct: { AAPL: 3 } }); // 삼성전자 +4.2% · 애플 +3% 급등
  const bodies = NET.bodies.filter((b, i) => isGemini(NET.calls[i]));
  assert.ok(!bodies.some((b) => b.includes("'삼성전자'")), 'AI를 꺼 둔 종목은 요청하지 않음');
  assert.ok(bodies.some((b) => b.includes("'애플'")), '켜 둔 종목은 그대로');
  const an = read(root, 'analysis.json');
  assert.ok(!an['005930'] && an.AAPL, '직전 분석도 버림');
  const qs = read(root, 'quotes.json').quotes;
  assert.equal(qs.find((q) => q.code === '005930').ai, false);
  assert.ok(!('ai' in qs.find((q) => q.code === 'AAPL')), '켜 둔 종목엔 표시 없음');
  assert.notEqual(read(root, 'moves.json')['005930'][0].s, 'ai', '급등락 기록 이유는 뉴스·공시');
});
await test('해외 종목 AI 분석: 미국 증시 관점 · 달러 소수 둘째 자리 · 수급 줄 없음(국내는 그대로)', async () => {
  const root = workspace();
  await pipeline(root, { usPct: { AAPL: 3 } });
  const bodyOf = (name) => NET.bodies.find((b, i) => isGemini(NET.calls[i]) && b.includes(`'${name}'`));
  const us = bodyOf('애플'), kr = bodyOf('삼성전자');
  assert.ok(us && kr, '두 종목 모두 분석 요청');
  assert.ok(us.includes('미국 증시 애널리스트') && !us.includes('수급(순매수)') && /현재가 \$\d+\.\d{2}/.test(us), us.slice(0, 200));
  assert.ok(kr.includes('한국 증시 애널리스트') && kr.includes('수급(순매수)') && /현재가 [\d,]+원/.test(kr));
});
await test('일정 → AI 분석: 가까운 일정(그 시장 날짜로 그제~7일 뒤)을 오늘·어제·내일로 · 지난 공시·이미 낸 실적 공시·기간 밖·다른 종목은 뺌 · 시그니처는 그대로', async () => {
  const bodyOf = (name) => NET.bodies.find((b, i) => isGemini(NET.calls[i]) && b.includes(`'${name}'`)) || '';
  const K = (d, k, t, x = {}) => ({ d, c: '005930', n: '삼성전자', m: 'KR', k, t, ...x });
  const A = (d, k, t, x = {}) => ({ d, c: 'AAPL', n: '애플', m: 'US', k, t, ...x });
  // NOW_KR = 10/15(목) 12:00 서울 = 10/14(수) 23:00 뉴욕
  const events = [K('20261012', 'div', '배당 기준일'), A('20261012', 'div', '배당락', { s: '주당 $0.27' }), K('20261013', 'ir', '기업설명회(IR)', { tm: '10:00' }),
    A('20261014', 'earn', '실적 발표', { s: '미국 장 마감 뒤' }), K('20261015', 'earn', '실적 공시'), K('20261015', 'disc', '단일판매ㆍ공급계약체결', { tag: '계약' }),
    K('20261016', 'earn', '3분기 실적 발표 예정', { s: '결산실적 공시 예정일' }), { d: '20261016', c: '000660', n: 'SK하이닉스', m: 'KR', k: 'ir', t: '기업설명회(IR)' },
    K('20261022', 'meet', '임시주주총회', { tm: '09:00' }), K('20261023', 'cap', '자사주 매입 끝')];
  const root = workspace();
  writeData(root, 'calendar.json', { v: 1, pv: 4, at: NOW_KR, codes: [], kr: 'ok', us: 'ok', events, docs: {}, diag: [] });
  await pipeline(root, { usPct: { AAPL: 3 } });
  const kr = bodyOf('삼성전자'), us = bodyOf('애플');
  assert.ok(kr.includes('가까운 일정(전자공시 기준 — 오늘 움직임과 이어질 때만 원인으로)'), kr.slice(0, 900));
  for (const line of ['- 10/13 10:00 기업설명회(IR)', '- 내일 3분기 실적 발표 예정 — 결산실적 공시 예정일', '- 10/22 09:00 임시주주총회']) assert.ok(kr.includes(line), line);
  for (const line of ['배당 기준일', '- 오늘 실적 공시', '단일판매', '자사주 매입 끝', '- 내일 기업설명회(IR)']) assert.ok(!kr.includes(line), `뺄 일정: ${line}`);
  assert.ok(us.includes('가까운 일정(나스닥 기준') && us.includes('- 오늘 실적 발표 — 미국 장 마감 뒤') && us.includes('- 10/12 배당락 — 주당 $0.27'),
    '미국은 뉴욕 날짜로(서울로는 이미 10/15) — ' + us.slice(0, 900));
  const plain = workspace();
  await pipeline(plain, { usPct: { AAPL: 3 } });
  assert.ok(!bodyOf('삼성전자').includes('가까운 일정'), '달력이 없으면 일정 줄 없음');
  assert.equal(read(root, 'analysis.json')['005930'].sig, read(plain, 'analysis.json')['005930'].sig, '시그니처는 일정과 무관');
});
await test('미국 시간외: 시간대(프리 04:00~09:30·애프터 16:00~20:00 ET, 평일·서머타임) · 5분봉 마지막 체결 판정', () => {
  const w = (s) => bud.usExtWindow(T(s));
  assert.deepEqual(['2026-10-15T07:59:00Z', '2026-10-15T08:00:00Z', '2026-10-15T13:29:00Z', '2026-10-15T13:30:00Z', '2026-10-15T19:59:00Z',
    '2026-10-15T20:00:00Z', '2026-10-15T23:59:00Z', '2026-10-16T00:00:00Z', '2026-10-17T22:00:00Z', '2026-12-15T09:00:00Z', '2026-12-15T21:30:00Z'].map(w),
    [null, 'pre', 'pre', null, null, 'post', 'post', null, null, 'pre', 'post'], 'EDT 경계 · 토요일 · 겨울(EST)');
  const S = (s) => T(s) / 1000;
  const chart = (bars, reg = { start: S('2026-10-15T13:30:00Z'), end: S('2026-10-15T20:00:00Z') }) => ({ chart: { result: [{
    meta: { currentTradingPeriod: { regular: reg } }, timestamp: bars.map((b) => S(b[0])), indicators: { quote: [{ close: bars.map((b) => b[1]) }] } }] } });
  assert.deepEqual(src.extFromChart(chart([['2026-10-15T19:55:00Z', 200], ['2026-10-15T21:55:00Z', 206.5], ['2026-10-15T22:00:00Z', null]])),
    { session: 'post', price: 206.5, at: T('2026-10-15T21:55:00Z') }, '빈 봉은 건너뛰고 마지막 체결');
  assert.deepEqual(src.extFromChart(chart([['2026-10-15T11:00:00Z', 199]])), { session: 'pre', price: 199, at: T('2026-10-15T11:00:00Z') });
  assert.equal(src.extFromChart(chart([['2026-10-15T11:00:00Z', 199], ['2026-10-15T15:00:00Z', 201]])), null, '마지막 체결이 정규장 → 시간외 아님');
  assert.equal(src.extFromChart({ chart: { result: [{ meta: {} }] } }), null);
});
await test('미국 시간외(파이프라인): 애프터마켓에 받아 정규장 종가 대비로 · 시간대 밖엔 직전 값 · 새 정규장 뒤엔 버림 · 장중엔 없음', async () => {
  const S = (s) => T(s) / 1000;
  const REG_CLOSE = '2026-10-15T20:00:00Z';
  // 정규장 밖(마감) 시세 — normalize가 실제 현재 시각으로 장 상태를 정하므로 정규장 구간을 과거로, 마지막 정규장 체결은 고정 시각
  const closedQuote = (sym, lastRegular) => {
    const j = yahooChart(sym); const now = Math.floor(Date.now() / 1000);
    Object.assign(j.chart.result[0].meta, { regularMarketTime: S(lastRegular), currentTradingPeriod: { regular: { start: now - 7200, end: now - 3600 } } });
    return j;
  };
  const extChart = { chart: { result: [{ meta: { currentTradingPeriod: { regular: { start: S('2026-10-15T13:30:00Z'), end: S(REG_CLOSE) } } },
    timestamp: [S('2026-10-15T19:55:00Z'), S('2026-10-15T21:55:00Z')], indicators: { quote: [{ close: [225, 230] }] } }] } };
  const yahoo = (lastRegular) => (m, u) => {
    const sym = decodeURIComponent(m[1]);
    if (/interval=5m/.test(u)) return json(extChart);
    return json(sym === 'AAPL' ? closedQuote(sym, lastRegular) : yahooChart(sym));
  };
  const root = workspace();
  await pipeline(root, { yahoo: yahoo(REG_CLOSE) }, T('2026-10-15T22:00:00Z'));          // 목 18:00 ET — 애프터마켓
  const q1 = read(root, 'quotes.json').quotes.find((x) => x.code === 'AAPL');
  assert.equal(q1.marketStatus, 'CLOSE');
  assert.deepEqual(q1.ext, { session: 'post', price: 230, change: Math.round((230 - q1.price) * 10000) / 10000,
    changePct: Math.round(((230 - q1.price) / q1.price) * 10000) / 100, at: T('2026-10-15T21:55:00Z') });
  assert.equal(callsTo(/interval=5m/), 1, '미국 마감 종목만 시간외 요청(국내 제외)');
  await pipeline(root, { yahoo: yahoo(REG_CLOSE) }, T('2026-10-16T01:30:00Z'));          // 21:30 ET — 시간외 끝
  assert.equal(callsTo(/interval=5m/), 0, '시간대 밖엔 요청 안 함');
  assert.deepEqual(read(root, 'quotes.json').quotes.find((x) => x.code === 'AAPL').ext, q1.ext, '직전 값 유지');
  await pipeline(root, { yahoo: yahoo('2026-10-15T22:30:00Z') }, T('2026-10-16T02:00:00Z')); // 그 뒤에 정규장 체결이 생긴 상황
  assert.ok(!('ext' in read(root, 'quotes.json').quotes.find((x) => x.code === 'AAPL')), '새 정규장 체결보다 오래된 시간외는 버림');
  const fresh = workspace();                                                              // 배포 직후처럼 직전 값이 없으면
  await pipeline(fresh, { yahoo: yahoo(REG_CLOSE) }, T('2026-10-16T01:30:00Z'));         // 애프터마켓 끝난 밤에도 한 번 받음
  assert.equal(callsTo(/interval=5m/), 1);
  assert.equal(read(fresh, 'quotes.json').quotes.find((x) => x.code === 'AAPL').ext?.price, 230, '그날 마지막 시간외 가격');
  await pipeline(fresh, { yahoo: yahoo(REG_CLOSE) }, T('2026-10-16T01:35:00Z'));
  assert.equal(callsTo(/interval=5m/), 0, '채운 뒤엔 다시 받지 않음');
  assert.equal(bud.usAfterPostSameDay(T('2026-10-16T04:30:00Z')), false, '자정 지나면(새 날) 아님');
  const open = workspace();
  await pipeline(open, {}, T('2026-10-15T22:00:00Z'));                                   // 시세가 장중(OPEN)이면
  assert.equal(callsTo(/interval=5m/), 0);
  assert.ok(!('ext' in read(open, 'quotes.json').quotes.find((x) => x.code === 'AAPL')), '장중엔 시간외 없음');
});
await test('과거 시세: 최근 봉이 빠진 응답(야후 매일 밤 UTC 자정 무렵)은 직전 봉으로 보완 · 4일 넘게 모자라면 직전 것 유지 · 새 봉이 오면 새 값', async () => {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const series = (endDay, base) => { // endDay까지 평일 130개 일봉, 종가 = base + 순번
    const ts = []; let t = Date.parse(`${endDay}T13:30:00Z`);
    while (ts.length < 130) { const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) ts.unshift(t / 1000); t -= 86400e3; }
    return { chart: { result: [{ meta: { regularMarketPrice: base }, timestamp: ts, indicators: { quote: [{ close: ts.map((_, i) => base + i) }] } }] } };
  };
  const yahoo = (endDay, base) => (m, u) => {
    const sym = decodeURIComponent(m[1]);
    if (/range=6mo/.test(u)) return json(series(endDay, base));
    if (/interval=5m/.test(u)) return json({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }] } });
    return json(yahooChart(sym));
  };
  const root = workspace();
  const tail = () => { const h = read(root, 'history.json').AAPL; return { n: h.closes.length, last: day(h.dates.at(-1)), lastClose: h.closes.at(-1), prevClose: h.closes.at(-2) }; };
  await pipeline(root, { yahoo: yahoo('2026-10-21', 100) });
  assert.deepEqual(tail(), { n: 130, last: '2026-10-21', lastClose: 229, prevClose: 228 });
  await pipeline(root, { yahoo: yahoo('2026-10-20', 200) }, NOW_KR + 5 * MIN);   // 마지막 날(10/21) 봉이 빠진 응답
  assert.deepEqual(tail(), { n: 131, last: '2026-10-21', lastClose: 229, prevClose: 329 }, '10/21 봉은 직전 값, 겹치는 10/20은 새 값');
  await pipeline(root, { yahoo: yahoo('2026-10-15', 300) }, NOW_KR + 10 * MIN);  // 4거래일 넘게 모자란 응답 → 깨진 것으로 보고 직전 것
  assert.deepEqual(tail(), { n: 131, last: '2026-10-21', lastClose: 229, prevClose: 329 });
  await pipeline(root, { yahoo: yahoo('2026-10-22', 400) }, NOW_KR + 15 * MIN);  // 새 날 봉이 들어오면 새 값 그대로
  assert.deepEqual(tail(), { n: 130, last: '2026-10-22', lastClose: 529, prevClose: 528 });
});
const sha10 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
await test('파일 지문(manifest.json): 화면이 받는 파일마다 sha1 앞 10자리 · 실제 내용과 일치 · 없는 파일은 빠짐 · 바뀐 파일만 바뀜 · 쓴 게 없으면 안 씀', async () => {
  const root = workspace();
  const { value } = await pipeline(root);
  assert.ok(value.written.includes('manifest.json'));
  const man = read(root, 'manifest.json');
  const names = ['analysis.json', 'history.json', 'investors.json', 'market.json', 'moves.json', 'news.json', 'quotes.json', 'status.json'];
  assert.deepEqual(Object.keys(man.files).sort(), names, '공시 키가 없으면 disclosures.json이 없어 빠짐(화면은 그 파일만 예전처럼)');
  for (const f of names) assert.equal(man.files[f], sha10(fs.readFileSync(file(root, f))), `${f} 지문`);
  // 다음 회차(간격 밖) — 시세는 바뀌고 과거 시세·뉴스·수급은 직전 값 그대로라 지문도 그대로
  await pipeline(root, { krPct: { '005930': 4.6, '000660': 0.3 } }, NOW_KR + 5 * MIN, { refreshAll: false });
  const man2 = read(root, 'manifest.json');
  assert.notEqual(man2.files['quotes.json'], man.files['quotes.json']);
  for (const f of ['history.json', 'news.json', 'investors.json']) assert.equal(man2.files[f], man.files[f], `${f} 그대로`);
  for (const f of Object.keys(man2.files)) assert.equal(man2.files[f], sha10(fs.readFileSync(file(root, f))), `${f} 지문(2회차)`);
  // 아무것도 못 받은 회차 — 직전 값을 그대로 다시 쓴 파일뿐이라 지문이 같고, 지문 파일도 다시 쓰지 않음
  // (쓴 파일이 하나도 없으면 아예 계산하지 않는 것은 '전부 실패' 테스트가 확인)
  const before = raw(root, 'manifest.json');
  NET.routes = [{ re: /./, fn: () => { throw new TypeError('fetch failed'); } }];
  const { value: v3 } = await quiet(() => run({ root, now: NOW_KR + 10 * MIN, calendar: false }));
  assert.ok(!v3.written.includes('manifest.json'), '같은 내용이면 지문 파일을 다시 쓰지 않음');
  assert.equal(raw(root, 'manifest.json'), before);
});
await test('급등락 기록(moves.json): ±2% 넘은 날의 등락·이유(AI > 공시 > 뉴스) · 시장 현지 날짜 · 2% 아래로 돌아오면 지움 · 더 나은 이유 유지 · 120일·20건·목록에서 빠진 종목 정리', async () => {
  const root = workspace();
  await pipeline(root, { krAt: NOW_KR });
  const mv = () => read(root, 'moves.json');
  assert.deepEqual(mv()['005930'], [{ d: '20261015', p: 4.2, r: '테스트 진단', s: 'ai' }], '+4.2% — 그날 AI 진단');
  assert.equal(mv()['000660'], undefined, '+0.3%는 기록 안 함');
  await pipeline(root, { krAt: NOW_KR + 5 * MIN, krPct: { '005930': 1.5, '000660': 0.3 } }, NOW_KR + 5 * MIN);
  assert.equal(mv()['005930'], undefined, '장중에 2% 아래로 돌아오면 그날 기록을 지움');
  // 이미 AI 이유가 있으면 AI가 실패해 뉴스밖에 없어도 그 이유를 지키고 등락만 고친다
  writeData(root, 'moves.json', { '005930': [{ d: '20261015', p: 3, r: '이전 AI 진단', s: 'ai' }] });
  fs.rmSync(file(root, 'analysis.json'));
  const fail = { gemini: () => text('upstream error', 500) };
  await pipeline(root, { ...fail, krAt: NOW_KR + 10 * MIN, krPct: { '005930': 3.3, '000660': 0.3 } }, NOW_KR + 10 * MIN);
  assert.deepEqual(mv()['005930'], [{ d: '20261015', p: 3.3, r: '이전 AI 진단', s: 'ai' }]);
  // 그날 AI 진단이 없으면(이틀 전 분석만 남아 있으면 쓰지 않음) 뉴스 제목(최근 것) — 길면 140자로 줄임
  const r2 = workspace();
  writeData(r2, 'analysis.json', { '005930': { headline: '이틀 전 진단', summary: 's', factors: [], outlook: 'o', sig: 'old', at: NOW_KR - 2 * 1440 * MIN } });
  await pipeline(r2, { ...fail, krAt: NOW_KR, newsTag: '가'.repeat(200) });
  const e2 = read(r2, 'moves.json')['005930'][0];
  assert.equal(e2.s, 'news');
  assert.ok(e2.r.length === 140 && e2.r.endsWith('…') && e2.r.startsWith('가가'), '긴 제목은 줄임');
  // 주요 공시가 있으면 뉴스보다 공시(최근 3일 안)
  await withDartKey(async () => {
    const r3 = workspace();
    await pipeline(r3, { ...fail, krAt: NOW_KR });
    const key = read(r3, 'disclosures.json')['005930'].items.find((x) => x.key);
    assert.deepEqual(read(r3, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: `[${key.tag}] ${key.title}`, s: 'disc' });
    // 열흘 전 주요 공시는 그날 이유로 보지 않음 → 뉴스
    const r3b = workspace();
    await pipeline(r3b, { ...fail, krAt: NOW_KR, dartRows: { '00126380': [['20261005000100', '단일판매ㆍ공급계약체결']] } });
    assert.ok(read(r3b, 'disclosures.json')['005930'].items[0].key, '공시 자체는 주요 공시');
    assert.equal(read(r3b, 'moves.json')['005930'][0].s, 'news');
  });
  // 뉴스도 전날부터 나온 것만 — 움직인 날보다 이틀 넘게 앞선 기사뿐이면 이유 없음
  const r3c = workspace();
  await pipeline(r3c, { ...fail, krAt: Date.now() + 3 * 1440 * MIN });
  assert.deepEqual(['r', 's'].map((k) => read(r3c, 'moves.json')['005930'][0][k]), ['', '']);
  // 미국 종목은 뉴욕 날짜 — 뉴욕 10/15 16:00(한국 10/16 05:00) 시세면 '20261015'
  const usAt = T('2026-10-15T20:00:00Z');
  const yahoo = (m, u) => {
    const sym = decodeURIComponent(m[1]);
    if (/interval=5m/.test(u)) return json({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }] } });
    const j = yahooChart(sym, sym === 'AAPL' ? -3.1 : undefined);
    if (sym === 'AAPL') j.chart.result[0].meta.regularMarketTime = usAt / 1000;
    return json(j);
  };
  const r4 = workspace();
  await pipeline(r4, { yahoo }, T('2026-10-15T21:00:00Z'));
  const us = read(r4, 'moves.json').AAPL[0];
  assert.deepEqual([us.d, us.p], ['20261015', -3.1]);
  // 정리 — 120일 넘은 기록·종목당 20건 초과·추적 목록에 없는 종목
  const r5 = workspace();
  const many = Array.from({ length: 14 }, (_, i) => ({ d: `202610${String(i + 1).padStart(2, '0')}`, p: -2.5, r: `기록${i}`, s: 'news' })); // 10/01~10/14
  const old = Array.from({ length: 12 }, (_, i) => ({ d: `202609${String(i + 10).padStart(2, '0')}`, p: 3, r: `9월${i}`, s: 'news' }));
  writeData(r5, 'moves.json', { '005930': [{ d: '20260607', p: 5, r: '오래됨', s: 'ai' }], '000660': [...many, ...old], ZZZZ: [{ d: '20261014', p: 3, r: 'x', s: 'ai' }] });
  await pipeline(r5, { krAt: NOW_KR });
  const m5 = read(r5, 'moves.json');
  assert.deepEqual(m5['005930'].map((x) => x.d), ['20261015'], '120일 넘은 기록은 지우고 오늘 것만');
  assert.equal(m5['000660'].length, 20, '종목당 20건');
  assert.equal(m5['000660'][0].d, '20261014', '최신순');
  assert.equal(m5.ZZZZ, undefined, '추적 목록에서 빠진 종목은 지움');
});
await test('뉴스 관련도: 우선주는 보통주 이름 · 영문 핵심 이름 · 별칭 · 미국 티커(대문자 단어) · 무관 기사·도박 스팸 제외', () => {
  assert.deepEqual([src.krBaseName('LG전자우', '066575'), src.krBaseName('현대차2우B', '005387'), src.krBaseName('삼성전자', '005930')], ['LG전자', '현대차', '삼성전자']);
  assert.deepEqual(['Tesla, Inc.', 'Amazon.com, Inc.', 'Super Micro Computer, Inc.', 'Taiwan Semiconductor Manufacturing Company Ltd.', 'Space Exploration Technologies Corp. Class A', 'NVIDIA Corporation']
    .map(src.enCoreName), ['Tesla', 'Amazon', 'Super Micro Computer', 'Taiwan Semiconductor Manufacturing', 'Space Exploration Technologies', 'NVIDIA']);
  const ok = (title, item) => src.isRelevantNews(title, item);
  const kr = (code, name) => ({ code, name, market: 'KR' });
  const us = (code, name, en) => ({ code, name, market: 'US', en });
  assert.equal(ok('여러 기능이 함께 나올 때 읽는 토토미 쌀국수 작동 순서', kr('066575', 'LG전자우')), false, '무관 기사');
  assert.equal(ok('LG전자, 3분기 영업이익 시장 기대 웃돌아', kr('066575', 'LG전자우')), true, '우선주는 보통주 이름으로');
  assert.equal(ok('LS일렉트릭, 사상 최대 실적…100분기 연속 흑자', kr('010120', 'LS ELECTRIC')), true, '별칭');
  assert.equal(ok('대한전선 | 미국 송전망 투자는 이제 시작', kr('010120', 'LS ELECTRIC')), false, '다른 회사 기사');
  assert.equal(ok('한국투자증권, ELW 224종목 신규 상장', kr('000720', '현대건설')), false, '상장 공지');
  assert.equal(ok('현대중공업 주가 2,000원 상승 후 장마감', kr('329180', 'HD현대중공업')), true);
  assert.equal(ok("Did Tesla's Fall Catch You Out?", us('TSLA', '테슬라', 'Tesla, Inc.')), true, '영문 이름');
  assert.equal(ok('Micron stock forecast: AI demand, China competition', us('TSLA', '테슬라', 'Tesla, Inc.')), false);
  assert.equal(ok('Why PLUG stock jumped today', us('PLUG', '플러그파워', 'Plug Power, Inc.')), true, '티커');
  assert.equal(ok('Best plug-in hybrids of 2026', us('PLUG', '플러그파워', 'Plug Power, Inc.')), false, '소문자 일반 단어는 티커 아님');
  assert.equal(ok('Supermicro spikes after raising guidance', us('SMCI', '슈퍼 마이크로 컴퓨터', 'Super Micro Computer, Inc.')), true);
  assert.equal(ok('Advanced Micro rallies on new AI chip', us('AMD', 'AMD', 'Advanced Micro Devices, Inc.')), true, '별칭 없는 세 단어 이름 → 앞 두 단어');
  assert.equal(ok('삼전닉스 반등에도 갈 길 먼 주가', kr('000660', 'SK하이닉스')), true, '줄임말 별칭');
  assert.equal(ok('Musk Vows to Give Each U.S. Child a SpaceX Share', us('SPCX', '스페이스X', 'Space Exploration Technologies Corp. Class A')), true);
  assert.equal(ok('엔비디아 주가 반등', us('NVDA', '엔비디아', '')), true, '한글 이름(목록 없을 때)');
  assert.ok(src.SPAM_RE.test('규칙이 적용되는 순서가 궁금한 a1 카지노') && src.SPAM_RE.test('먹튀 없는 토토사이트 추천'));
  assert.ok(!src.SPAM_RE.test('개미들, 엔비디아에 베팅') && !src.SPAM_RE.test('삼성전자, 새 메모리 슬롯 규격 공개'), '금융 기사의 베팅·슬롯은 스팸 아님');
});
await test('뉴스 관련도: 종목 이름 바로 뒤에 다른 회사 이름(현대차증권·현대건설기계)이 이어지면 그 회사 기사 · 그룹·제대로 된 언급은 관련', () => {
  const car = { code: '005380', market: 'KR', name: '현대차' }, eng = { code: '000720', market: 'KR', name: '현대건설' };
  assert.equal(src.isRelevantNews('현대차증권, LS일렉트릭 내년 이익 전망 상향...“미국 빅테크 수주·매출 증가”', car), false);
  assert.equal(src.isRelevantNews('현대차증권 "현대차 목표가 상향…하이브리드 판매 호조"', car), true, '같은 제목에 현대차 언급이 따로 있으면 관련');
  assert.equal(src.isRelevantNews('현대차그룹, AI 인프라 확충…2029년 새만금서 GPU 1만장 운영 추진', car), true, '그룹 기사는 관련');
  assert.equal(src.isRelevantNews('현대차, 증권가 목표가 상향 잇따라', car), true, '쉼표 뒤 증권가는 다른 말');
  assert.equal(src.isRelevantNews('현대자동차 美 관세 합의 수혜', car), true, '별칭');
  assert.equal(src.isRelevantNews('삼성바이오, 美 공장이 파업 상쇄...수주 회복 기대-현대차證', car), false, '증권사 이름을 한자로 줄여 써도');
  assert.equal(src.isRelevantNews('현대건설기계 장중 3%대 상승', eng), false);
  assert.equal(src.isRelevantNews('로이터 “삼성물산·현대건설, 차세대 SMR 건설 파트너로 부상”', eng), true);
  assert.equal(src.isRelevantNews('Hyundai Motor shares rise', { code: 'HYMTF', market: 'US', name: 'Hyundai', en: 'Hyundai Motor' }), true, '미국 종목은 그대로');
});
await test('뉴스 관련도(파이프라인): 무관 기사·스팸은 빼고 관련 기사만 저장 · 우선주는 보통주로 검색 · 미국은 검색 목록 영문명으로', async () => {
  const root = workspace([...ITEMS, { code: '066575', market: 'KR', name: 'LG전자우' }]);
  writeData(root, 'stocklist.json', { v: 2, kr: [], us: [['AAPL', '애플', 'Apple Inc.', 'NASDAQ', 1]], meta: {} });
  const pub = new Date(Date.now() - 3600e3).toUTCString();
  const item = (t) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/${encodeURIComponent(t)}</link><pubDate>${pub}</pubDate></item>`;
  const news = (m, u) => {
    const name = queryName(u).split(' ')[0];
    const titles = /stock/.test(new URL(u).searchParams.get('q'))
      ? ['Apple stock jumps on iPhone demand', 'Micron stock forecast: AI demand', 'Best plug-in hybrids of 2026']
      : [`${name} 실적 기대에 급등`, '여러 기능이 함께 나올 때 읽는 토토미 쌀국수 작동 순서', `${name} 주가 카지노 바카라 안내`, '한국투자증권, ELW 224종목 신규 상장'];
    return text(`<?xml version="1.0"?><rss><channel>${titles.map(item).join('')}</channel></rss>`);
  };
  await pipeline(root, { news });
  const d = read(root, 'news.json');
  assert.deepEqual(d['005930'].items.map((x) => x.title), ['삼성전자 실적 기대에 급등']);
  assert.deepEqual(d['066575'].items.map((x) => x.title), ['LG전자 실적 기대에 급등'], '우선주 → 보통주 기사');
  assert.deepEqual(d.AAPL.items.map((x) => x.title), ['Apple stock jumps on iPhone demand'], '영문 이름으로 관련 판단');
  const qs = NET.calls.filter((u) => /news\.google\.com/.test(u)).map((u) => new URL(u).searchParams.get('q'));
  assert.ok(qs.some((q) => q.startsWith('LG전자 주가')) && !qs.some((q) => q.startsWith('LG전자우')), qs.join(' / '));
  assert.equal(d['005930'].summary.total, 1, '호재·악재 집계도 관련 기사만');
});
await test('뉴스 목록(18차): 같은 기사(제목 꼬리만 다름)는 최신 하나만 · 시세 안내 기사는 뒤로 · 날짜만 다른 시세 안내·매체만 다른 다른 제목은 다른 기사', async () => {
  // 실제 제목(2026-10-22 news.json)
  assert.equal(src.sameStory('HD현대중공업, 세계 최대 암모니아 추진선 건조…11월 초 인도', 'HD현대중공업, 세계 최대 암모니아 추진선 건조'), true);
  assert.equal(src.sameStory('HD현대중공업, 세계 최대 암모니아 추진선 건조…11월 초 인도', 'HD현대중공업, 세계 최대 암모니아 추진선 건조…11월 초 인도'), true);
  assert.equal(src.sameStory("LG전자, AI 시스템 에어컨 '멀티 브이 7' 첫 공개", 'LG전자, 듀얼 AI 탑재한 시스템 에어컨 ‘멀티 브이 7’ 공개'), false, '표현이 다르면 다른 기사로(잘못 합치지 않게 보수적으로)');
  assert.equal(src.sameStory('심텍 주가, 10월 22일 장중 128,300원 1.83% 상승', '심텍 주가, 10월 21일 장중 125,100원 0.89% 상승'), false);
  assert.equal(src.sameStory('삼성전자 주가 상승 중', '삼성전자 주가 하락 중'), false);
  assert.equal(src.sameStory('[특징주] 삼성E&A, 자사주 소각', '삼성E&A, 자사주 소각'), true, '머리 꼬리표는 빼고 비교');
  assert.equal(src.sameStory('AB', 'AB'), true);
  assert.equal(src.sameStory('AB', 'CD'), false);
  // 19차: 종목 이름·별칭을 빼고 보면 표현만 다른 같은 소식도 잡힌다(한글 70%) — 실제 제목(2026-10-22)
  const hd = src.newsKeys({ code: '329180', market: 'KR', name: 'HD현대중공업' });
  assert.equal(src.sameStory("HD현대중공업, 세계 최대 암모니아 추진선 건조…'테라 클로브호' 오는 11월 인도", 'HD현대중공업, 세계 최대 암모니아 추진선 건조…11월 초 인도', hd), true);
  assert.equal(src.sameStory('HD현대중공업, 세계 최대 암모니아 추진선 건조…11월 초 인도', 'HD현대중공업, 세계 최대 암모니아 추진선 건조…"탈탄소 선도"', hd), true);
  const lg = src.newsKeys({ code: '066570', market: 'KR', name: 'LG전자' });
  assert.equal(src.sameStory("LG전자, AI 시스템 에어컨 '멀티 브이 7' 첫 공개", 'LG전자, 듀얼 AI 탑재한 시스템 에어컨 ‘멀티 브이 7’ 공개', lg), true, '이름을 빼면 같은 소식');
  const skt = src.newsKeys({ code: '017670', market: 'KR', name: 'SK텔레콤' });
  assert.equal(src.sameStory('[기업 생생소식] SK텔레콤·금감원, 금융의 날 앞두고 보이스피싱 피해 예방 나서 外', 'SK텔레콤, 금감원과 보이스피싱 피해예방 활동 나서', skt), true);
  const sem = src.newsKeys({ code: '009150', market: 'KR', name: '삼성전기' });
  assert.equal(src.sameStory("[특징주] 삼성전기, 엔비디아와 파트너십 구축 소식에도 '하락'", '[특징주] 삼성전기, 엔비디아와 전략적 파트너십에 강세…장중 123만원대', sem), false, '같은 재료라도 다른 날·다른 방향 기사');
  const sbl = src.newsKeys({ code: '207940', market: 'KR', name: '삼성바이오로직스' });
  assert.equal(src.sameStory('삼성바이오로직스, 美 공장 증설', '삼성바이오로직스, 4공장 가동', sbl), false, '긴 종목 이름이 겹치는 것만으로 같은 기사가 되지 않게 이름은 빼고 비교');
  const sec = src.newsKeys({ code: '005930', market: 'KR', name: '삼성전자' });
  assert.equal(src.sameStory('삼성전자, 3분기 실적 발표 앞두고 외국인 순매수에 2% 상승', '삼성전자, 3분기 실적 발표 앞두고 외국인 순매도에 2% 하락', sec), false, '방향이 반대면 글자가 비슷해도 다른 기사');
  assert.equal(src.sameStory('삼성전자 주가 상승 중', '삼성전자 주가 하락 중', sec), false);
  const nv = src.newsKeys({ code: 'NVDA', market: 'US', name: '엔비디아', en: 'NVIDIA Corporation' });
  assert.equal(src.sameStory('Why Nvidia stock is rising today', 'Why Nvidia stock is falling today', nv), false, '영문은 90% — 흔한 낱말이 많아 반대 뜻도 0.84');
  const tsm = src.newsKeys({ code: 'TSM', market: 'US', name: 'TSMC', en: 'Taiwan Semiconductor Manufacturing Company Limited' });
  assert.equal(src.sameStory('Needham raises target for TSMC stock from USD 530 to USD 560', 'Barclays raises target for TSM stock from USD 665.00 to USD 670.00', tsm), false, '다른 증권사 기사');
  const root = workspace();
  const news = (m, u) => {
    const name = queryName(u).split(' ')[0], now = Date.now();
    const item = (t, min) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/${min}</link><pubDate>${new Date(now - min * 60e3).toUTCString()}</pubDate></item>`;
    return text(`<?xml version="1.0"?><rss><channel>${[
      item(`${name} 주가, 10월 15일 장중 70,000원 4.20% 상승`, 10),
      item(`${name}, 세계 최대 암모니아 추진선 건조…11월 초 인도`, 20),
      item(`${name}, 세계 최대 암모니아 추진선 건조`, 30),
      item(`${name}, 세계 최대급 암모니아 추진선 ‘테라 클로브’ 공개`, 35), // 이름을 빼야 같은 소식(이름째로는 0.81)
      item(`${name}, 세계 최대 암모니아 추진선 건조…11월 초 인도`, 40),
      item(`${name}, 대규모 수주 소식에 급등`, 50),
    ].join('')}</channel></rss>`);
  };
  await pipeline(root, { news });
  const d = read(root, 'news.json')['005930'];
  assert.deepEqual(d.items.map((x) => x.title), ['삼성전자, 세계 최대 암모니아 추진선 건조…11월 초 인도', '삼성전자, 대규모 수주 소식에 급등', '삼성전자 주가, 10월 15일 장중 70,000원 4.20% 상승'],
    '같은 소식 4건(표현만 다른 것 포함 — 종목 이름을 빼고 비교) → 최신 1건, 가장 최근이어도 시세 안내는 맨 뒤');
  assert.equal(d.items.at(-1).sentiment.label, '시세');
});
await test('수급 날짜: AI 입력에 오늘 값인지 전 거래일 확정치인지 밝힘(장중엔 전날 값 — 오늘 원인으로 오해 방지)', async () => {
  const bodyOf = () => NET.bodies.find((b, i) => isGemini(NET.calls[i]) && b.includes("'삼성전자'")) || '';
  await pipeline(workspace());                // 10/15 장중, 수급 날짜 20261015 → 오늘
  assert.ok(bodyOf().includes('외국인지분 50.00% (오늘)'), bodyOf().slice(0, 400));
  await pipeline(workspace(), {}, NEXT_DAY);  // 10/16 장중인데 수급은 아직 10/15 값
  assert.ok(bodyOf().includes('(10/15 확정치 — 오늘 장중 수급 아님)'), bodyOf().slice(0, 400));
});
await test('휴장 확인 시간대: 개장 10분 뒤~마감 10분 전 · 시장 날짜 · 주말 제외 · 서머타임', () => {
  const d = (m, s) => bud.closedCheckDay(m, T(s));
  assert.equal(d('KR', '2026-10-15T00:09:00Z'), null, '09:09 KST');
  assert.equal(d('KR', '2026-10-15T00:10:00Z'), '2026-10-15', '09:10 KST');
  assert.equal(d('KR', '2026-10-15T06:19:00Z'), '2026-10-15', '15:19 KST');
  assert.equal(d('KR', '2026-10-15T06:20:00Z'), null, '15:20 KST');
  assert.equal(d('KR', '2026-10-17T03:00:00Z'), null, '토요일');
  assert.equal(d('US', '2026-10-15T13:39:00Z'), null, '09:39 EDT');
  assert.equal(d('US', '2026-10-15T13:40:00Z'), '2026-10-15', '09:40 EDT');
  assert.equal(d('US', '2026-10-15T19:49:00Z'), '2026-10-15', '15:49 EDT');
  assert.equal(d('US', '2026-10-15T19:50:00Z'), null, '15:50 EDT');
  assert.equal(d('US', '2026-12-15T14:39:00Z'), null, '09:39 EST(겨울)');
  assert.equal(d('US', '2026-12-15T14:40:00Z'), '2026-12-15', '09:40 EST(겨울)');
  assert.equal(d('KR', '2026-10-15T15:00:00Z'), null, '미국 장중 = 국내 자정');
});
await test('휴장 기록: 장 시간에 시세가 마감이면 그 시장 날짜를 남김 · 평소엔 없음 · 이어받기 · 이상한 값 버림', async () => {
  const root = workspace();
  await pipeline(root, { krStatus: 'CLOSE' });                                          // 목 12:00 KST, 국내 휴장
  assert.deepEqual(read(root, 'quotes.json').closed, { KR: '2026-10-15' }, '국내만 기록(미국은 확인 시간 아님)');
  await pipeline(root, {}, NOW_KR + 5 * MIN);                                           // 같은 날 장중이 돼도 그날 기록은 유지
  assert.deepEqual(read(root, 'quotes.json').closed, { KR: '2026-10-15' });
  const yahoo = (m) => {                                                                // 미국 휴장 — 정규장 시간이 이미 지난 응답
    const j = yahooChart(decodeURIComponent(m[1])); const s = Math.floor(Date.now() / 1000);
    j.chart.result[0].meta.currentTradingPeriod.regular = { start: s - 7200, end: s - 3600 };
    return json(j);
  };
  await pipeline(root, { yahoo }, T('2026-10-15T15:00:00Z'));                           // 목 11:00 ET
  assert.deepEqual(read(root, 'quotes.json').closed, { KR: '2026-10-15', US: '2026-10-15' });
  writeData(root, 'quotes.json', { quotes: [], closed: { KR: '15일', XX: '2026-10-01', US: '2026-10-01' } });
  await pipeline(root, {}, NOW_KR + 1440 * MIN);
  assert.deepEqual(read(root, 'quotes.json').closed, { US: '2026-10-01' }, '형식이 맞는 시장 기록만 이어받음');
  const plain = workspace();
  await pipeline(plain);
  assert.ok(!('closed' in read(plain, 'quotes.json')), '평소(장중)엔 필드 자체가 없음 — 파일 모양 그대로');
});
await test('화면 지연 경고(app.js): 장중 45분 · 개장 30분 뒤 · 휴장 기록 · 주말 · 장 밖 · 경과 표기', async () => {
  // 브라우저 코드에서 '데이터 지연 경고' 블록만 떼어 빈 환경에서 실행한다(DOM 없이 판정 로직만 검사)
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('// ---------- 데이터 지연 경고'), appJs.indexOf('// 시장별 묶음'));
  assert.ok(block.length > 200 && block.includes('function staleOf'), '블록 추출');
  const { staleOf } = vm.runInNewContext(`${block}; ({ staleOf })`, {});
  const KR_NOON = T('2026-10-15T03:00:00Z'), US_11 = T('2026-10-15T15:00:00Z');
  const q = (status, ageMin, at) => [{ marketStatus: status, asOf: new Date(at - ageMin * MIN).toISOString(), ok: true }];
  const s = (m, list, closed, at) => staleOf(m, list, closed, at);
  assert.equal(s('KR', q('OPEN', 10, KR_NOON), null, KR_NOON), '', '장중 10분 전 시세');
  assert.equal(s('KR', q('OPEN', 45, KR_NOON), null, KR_NOON), '', '45분까지는 정상(15:30~16:00 무체결 26분 + 여유)');
  assert.equal(s('KR', q('OPEN', 46, KR_NOON), null, KR_NOON), '46분째 갱신 없음');
  assert.equal(s('KR', q('OPEN', 180, KR_NOON), null, KR_NOON), '3시간째 갱신 없음');
  assert.equal(s('KR', q('OPEN', 30 * 60, KR_NOON), null, KR_NOON), '30시간째 갱신 없음', '이틀 미만은 시간');
  assert.equal(s('US', q('OPEN', 3 * 1440, KR_NOON), null, KR_NOON), '3일째 갱신 없음', '장중 표시가 굳은 채면 장 밖이어도 경고');
  const yClose = q('CLOSE', 16 * 60, KR_NOON); // 어제 20:00 마감 시세
  assert.equal(s('KR', yClose, null, KR_NOON), '개장 후 갱신 없음');
  assert.equal(s('KR', yClose, { KR: '2026-10-15' }, KR_NOON), '', '봇이 오늘 휴장 확인');
  assert.equal(s('KR', yClose, { KR: '2026-10-14', US: '2026-10-15' }, KR_NOON), '개장 후 갱신 없음', '다른 날·다른 시장 기록은 무관');
  const at = (hhmm) => T(`2026-10-15T${hhmm}:00+09:00`);
  assert.equal(s('KR', q('CLOSE', 600, at('09:29')), null, at('09:29')), '', '개장 30분 전까지는 첫 수집 대기');
  assert.equal(s('KR', q('CLOSE', 600, at('09:30')), null, at('09:30')), '개장 후 갱신 없음');
  assert.equal(s('KR', q('CLOSE', 600, at('15:29')), null, at('15:29')), '개장 후 갱신 없음');
  assert.equal(s('KR', q('CLOSE', 600, at('15:30')), null, at('15:30')), '', '정규장 마감 후');
  assert.equal(s('KR', q('PREOPEN', 46, at('09:45')), null, at('09:45')), '개장 후 갱신 없음', '장 전 상태에서 멈춤');
  assert.equal(s('KR', q('PREOPEN', 5, at('09:45')), null, at('09:45')), '', '상태가 이상해도 방금 받은 시세면 경고 안 함');
  assert.equal(s('KR', q('CLOSE', 600, T('2026-10-17T03:00:00Z')), null, T('2026-10-17T03:00:00Z')), '', '토요일');
  assert.equal(s('KR', q('CLOSE', 600, US_11), null, US_11), '', '국내 자정');
  assert.equal(s('US', q('CLOSE', 19 * 60, US_11), null, US_11), '개장 후 갱신 없음', '미국 장중인데 어제 마감 시세');
  assert.equal(s('US', q('CLOSE', 19 * 60, US_11), { US: '2026-10-15' }, US_11), '', '미국 휴장 확인');
  const et = (hhmm) => T(`2026-10-15T${hhmm}:00-04:00`);
  assert.equal(s('US', q('CLOSE', 600, et('09:59')), null, et('09:59')), '');
  assert.equal(s('US', q('CLOSE', 600, et('10:00')), null, et('10:00')), '개장 후 갱신 없음');
  assert.equal(s('KR', [{ marketStatus: 'OPEN', asOf: 'x', ok: true }], null, KR_NOON), '', '시각을 알 수 없으면 판단 안 함');
  assert.equal(s('KR', [], null, KR_NOON), '');
  const mixed = [...q('OPEN', 50, KR_NOON), ...q('CLOSE', 5, KR_NOON)];
  assert.equal(s('KR', mixed, null, KR_NOON), '', '가장 최근 시세 기준');
});
await test('개장 직후 집중 갱신 계획(burst.mjs): 평일 08:54~09:10만 · 첫 눈금 09:00:10까지 기다림 · 매분 10초 · 끝 눈금 09:10:10 · 주말·휴장(국내 시세가 개장 전·장중 아님·오늘 휴장 기록)·국내 시세 없음이면 끝 · 워크플로가 되풀이 실행', async () => {
  const at = (hms, d = '2026-11-05') => T(`${d}T${hms}+09:00`);
  const q = (status = 'PREOPEN', extra = {}) => ({ quotes: [{ code: '005930', market: 'KR', ok: true, marketStatus: status }, { code: 'AAPL', market: 'US', ok: true, marketStatus: 'CLOSE' }], ...extra });
  const plan = burst.burstPlan;
  assert.deepEqual(plan(at('08:55:30'), q()), { at: at('09:00:10') }, '08:55 회차는 첫 눈금까지 기다림');
  assert.deepEqual(plan(at('08:53:59'), q()), { stop: '창 밖' }, '08:54 전');
  assert.deepEqual(plan(at('08:54:00'), q()), { at: at('09:00:10') });
  assert.deepEqual(plan(at('09:00:10'), q('OPEN')), { at: at('09:00:10') }, '눈금 그 시각이면 바로');
  assert.deepEqual(plan(at('09:00:25'), q('OPEN')), { at: at('09:01:10') }, '다음 눈금');
  assert.deepEqual(plan(at('09:10:05'), q('OPEN')), { at: at('09:10:10') }, '끝 눈금');
  assert.deepEqual(plan(at('09:10:20'), q('OPEN')), { stop: '창 끝' });
  assert.deepEqual(plan(at('09:11:00'), q('OPEN')), { stop: '창 밖' });
  assert.deepEqual(plan(at('08:56:00', '2026-11-07'), q()), { stop: '주말' }, '토요일');
  assert.deepEqual(plan(at('08:56:00'), q('CLOSE')), { stop: '휴장' }, '휴장일 — 국내 시세가 마감');
  assert.deepEqual(plan(at('09:03:00'), q('OPEN', { closed: { KR: '2026-11-05' } })), { stop: '휴장' }, '오늘 휴장 기록');
  assert.deepEqual(plan(at('09:03:00'), q('OPEN', { closed: { KR: '2026-11-04', US: '2026-11-05' } })), { at: at('09:03:10') }, '다른 날·다른 시장 기록은 무관 — 다음 눈금은 10초 뒤');
  assert.deepEqual(plan(at('09:03:00'), { quotes: [{ code: 'AAPL', market: 'US', ok: true, marketStatus: 'OPEN' }] }), { stop: '국내 시세 없음' });
  assert.deepEqual(plan(at('09:03:00'), null), { stop: '국내 시세 없음' }, '파일 없음');
  // 워크플로 — 마지막 단계가 0으로 끝나는 동안 되풀이(커밋·푸시), 회차 시간 제한은 08:55 회차의 집중 갱신(~09:10)보다 길게
  const yml = fs.readFileSync(new URL('../.github/workflows/update.yml', import.meta.url), 'utf8');
  assert.match(yml, /node scripts\/burst\.mjs \|\| break/, '되풀이 실행');
  assert.ok(+(yml.match(/^ {4}timeout-minutes: (\d+)/m) || [])[1] >= 20, '회차 시간 제한');
});
await test('개장 직후 집중 갱신(burst.mjs): 국내 시세·코스피·코스닥만 새 값 · 해외·휴장 기록·상장 시장·AI 끔·내 별칭은 그대로 · 받기 실패한 종목·지수는 직전 값(야후 지연 값으로 대신 안 함) · 지수 브리핑·분위기도 같은 값 · 파일 지문 다시 계산', async () => {
  const root = workspace();
  const pre = (code, name, extra = {}) => ({ code, market: 'KR', name, currency: 'KRW', price: 70000, prevClose: 70000, change: 0, changePct: 0, open: null, high: null, low: null,
    volume: null, marketStatus: 'PREOPEN', asOf: '2026-11-05T08:55:23+09:00', ok: true, exch: 'KOSPI', ...extra });
  const aapl = { code: 'AAPL', market: 'US', name: '애플', currency: 'USD', price: 200, changePct: 1.2, marketStatus: 'CLOSE', asOf: '2026-11-04T16:00:00-05:00', ok: true, exch: 'NASDAQ',
    ext: { session: 'post', price: 201, change: 1, changePct: 0.5, at: 1 } };
  const q0 = { quotes: [pre('005930', '삼성전자', { ai: false }), pre('000660', 'SK하이닉스'), aapl], closed: { US: '2026-11-04' } };
  writeData(root, 'quotes.json', q0);
  const idx = (name, symbol, currency, price, changePct, marketStatus) => ({ name, symbol, currency, price, change: 0, changePct, marketStatus });
  const m0 = { indices: [idx('코스피', '^KS11', 'KRW', 2650, 0, 'PREOPEN'), idx('코스닥', '^KQ11', 'KRW', 700, 0, 'PREOPEN'), idx('S&P 500', '^GSPC', 'USD', 7000, 1, 'CLOSE'), idx('VIX', '^VIX', 'USD', 17, 2, 'CLOSE')],
    vix: idx('VIX', '^VIX', 'USD', 17, 2, 'CLOSE'), mood: { score: 50, label: '중립', tone: 'neutral', summary: '어제' }, forex: [{ name: '원/달러', symbol: 'KRW=X', price: 1340 }],
    briefs: [{ key: 'KOSPI', name: '코스피', changePct: 0, price: 2650, flow: { f: 1 }, reason: { dir: 'flat' } }, { key: 'KOSDAQ', name: '코스닥', changePct: 0, price: 700, flow: null, reason: null }] };
  writeData(root, 'market.json', m0);
  writeData(root, 'news.json', { keep: 1 });
  // SK하이닉스·코스닥 실시간은 실패 — 야후로 대신하면 안 된다(야후 주소도 열어 두고 부르지 않는지 본다)
  NET.routes = [{ re: /domestic\/stock\/000660/, fn: () => text('upstream error', 500) }, { re: /domestic\/index\/KOSDAQ/, fn: () => text('upstream error', 500) },
    ...routes({ krPct: { '005930': -2.5 }, idxPct: -1.8, krAt: T('2026-11-05T09:00:11+09:00') })];
  NET.calls = []; NET.bodies = []; NET.blocked = [];
  let now = T('2026-11-05T08:59:50+09:00');
  const slept = [];
  const r = await burst.burstOnce({ root, clock: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
  assert.equal(r, 'written');
  assert.deepEqual(slept, [20000], '첫 눈금(09:00:10)까지 기다림');
  assert.equal(callsTo(/yahoo/), 0, '야후 지연 값으로 대신하지 않음');
  const q1 = read(root, 'quotes.json');
  const s = q1.quotes.find((x) => x.code === '005930');
  assert.equal(s.changePct, -2.5); assert.equal(s.marketStatus, 'OPEN'); assert.equal(s.name, '삼성전자', '내 별칭');
  assert.equal(s.exch, 'KOSPI', '상장 시장'); assert.equal(s.ai, false, 'AI 끔 표시');
  assert.deepEqual(q1.quotes.find((x) => x.code === '000660'), q0.quotes[1], '받기 실패한 종목은 직전 값');
  assert.deepEqual(q1.quotes.find((x) => x.code === 'AAPL'), aapl, '해외 종목 그대로');
  assert.deepEqual(q1.quotes.map((x) => x.code), ['005930', '000660', 'AAPL'], '순서 그대로');
  assert.deepEqual(q1.closed, { US: '2026-11-04' }, '휴장 기록 그대로');
  const m1 = read(root, 'market.json');
  const kospi = m1.indices.find((i) => i.symbol === '^KS11');
  assert.equal(kospi.changePct, -1.8); assert.equal(kospi.marketStatus, 'OPEN'); assert.equal(kospi.price, 2600);
  assert.deepEqual(m1.indices.find((i) => i.symbol === '^KQ11'), m0.indices[1], '코스닥 실패 — 직전 값');
  assert.deepEqual(m1.indices.slice(2), m0.indices.slice(2), '미국 지수·VIX 그대로');
  assert.deepEqual(m1.briefs[0], { ...m0.briefs[0], changePct: -1.8, price: 2600 }, '브리핑은 등락·지수만');
  assert.deepEqual(m1.briefs[1], m0.briefs[1]);
  assert.deepEqual(m1.mood, src.computeMood(m1.indices.filter((i) => i.symbol !== '^VIX'), 17), '분위기 다시 계산');
  assert.notDeepEqual(m1.mood, m0.mood);
  assert.deepEqual(m1.forex, m0.forex); assert.deepEqual(m1.vix, m0.vix);
  const man = read(root, 'manifest.json').files;
  for (const f of ['quotes.json', 'market.json', 'news.json']) assert.equal(man[f], sha10(fs.readFileSync(file(root, f))), `${f} 지문`);
  // 아직 첫 체결 전(수능일·새해 첫날처럼 늦게 여는 날, 9시 몇 초 안)이면 쓰지 않고 다음 눈금에 다시 — 종료 코드도 '계속'
  const before0 = raw(root, 'quotes.json');
  NET.routes = routes({ krStatus: 'PREOPEN', krPct: { '005930': 0, '000660': 0 } });
  now = T('2026-11-05T09:01:10+09:00');
  assert.equal(await burst.burstOnce({ root, clock: () => now, sleep: async () => {} }), '개장 전');
  assert.equal(raw(root, 'quotes.json'), before0, '쓰지 않음');
  assert.deepEqual(['written', '개장 전', '창 끝', '휴장', '시세 받기 실패'].map(burst.exitCodeOf), [0, 0, 3, 3, 3], '새 값·첫 체결 전은 계속, 그 밖은 끝');
  // 국내 시세가 모두 실패하면 아무것도 쓰지 않고 끝
  const before = raw(root, 'quotes.json');
  NET.routes = [{ re: /domestic\/(?:stock|index)\//, fn: () => text('upstream error', 500) }, ...routes()];
  now = T('2026-11-05T09:01:10+09:00');
  assert.equal(await burst.burstOnce({ root, clock: () => now, sleep: async () => {} }), '시세 받기 실패');
  assert.equal(raw(root, 'quotes.json'), before);
});
await test('매매 정지·첫 체결 전 시세(sources.mjs·burst.mjs): 정지면 halt — 시장 전체(서킷브레이커) market · 그 종목만 stock · 정지 시각 · 평소엔 칸 없음 · 오늘 거래량 없으면 null · 집중 갱신 합치기는 새 값 그대로(정지가 풀리면 빠짐)', async () => {
  const HALT = { code: '2', text: '정지.Halted', name: 'HALTED' };
  NET.routes = routes({ krPct: { '005930': -9.98, '000660': -11.71, '035720': 0 }, krExtra: {
    '005930': { tradeStopType: HALT, tradableStatusCode: 'marketOperationHalt', tradableStatusUpdatedAt: '2026-11-06T09:04:12.035+09:00' },
    '000660': { tradeStopType: HALT, tradableStatusCode: 'tradingHalt' },
    '096770': { tradeStopType: HALT, tradableStatusCode: 'marketOperationHalt', tradableStatusUpdatedAt: '2026-11-06T09:04:05+09:00' },
    '035720': { accumulatedTradingVolume: undefined, tradeStopType: { code: '1', text: '운영.Trading', name: 'TRADING' }, tradableStatusCode: 'ok' },
  } });
  const [a, b, c, d] = await src.getKrQuotesLive([{ code: '005930' }, { code: '000660' }, { code: '035720' }, { code: '051910' }]);
  assert.equal(a.halt, 'market', '시장 전체 정지'); assert.equal(a.haltAt, '2026-11-06T09:04:12.035+09:00');
  assert.equal(a.changePct, -9.98, '값은 멈추기 직전 가격 그대로');
  assert.equal(b.halt, 'stock', '그 종목만 정지'); assert.equal(b.haltAt, null);
  assert.ok(!('halt' in c) && !('haltAt' in c), '운영 중이면 칸 없음'); assert.equal(c.volume, null, '오늘 거래량 없음');
  assert.ok(!('halt' in d)); assert.equal(d.volume, 1234567);
  const g = await src.getQuote({ code: '096770' }); // 앞 시험의 시세 캐시(8초)에 걸리지 않는 종목
  assert.equal(g.halt, 'market', '정규 회차 시세도 같음'); assert.equal(g.haltAt, '2026-11-06T09:04:05+09:00');
  // 집중 갱신 합치기 — 새 값 그대로(상장 시장·AI 끔은 이어 붙임), 정지가 풀린 새 값엔 halt가 없다
  const { halt, haltAt, ...a2 } = a;
  const prev = { quotes: [{ code: '005930', market: 'KR', ok: true, halt: 'market', haltAt, exch: 'KOSPI', ai: false }, { code: '000660', market: 'KR', ok: true, exch: 'KOSPI' }] };
  const { file } = burst.mergeKrQuotes(prev, [a2, b]);
  assert.ok(!('halt' in file.quotes[0]) && !('haltAt' in file.quotes[0]), '풀리면 빠짐');
  assert.equal(file.quotes[0].exch, 'KOSPI'); assert.equal(file.quotes[0].ai, false);
  assert.equal(file.quotes[1].halt, 'stock');
});
await test('시장 조치(sources.mjs): 사이드카 속보 제목 — 방향·시장(사이드카 바로 앞 · 둘을 함께 쓰면 둘 다 · 해제·방향·시장 없으면 아님) · 같은 시장·방향 기사가 3분 안에 3건 이상 몰린 첫 묶음의 두 번째 기사 시각(그날 09:00~15:40 기사만) · 기록 합치기(그날 것만·가장 이른 시각·시각순·판이 바뀌면 사이드카만 다시)', async () => {
  const s = (t) => JSON.parse(JSON.stringify(src.sidecarOf(t))).map((e) => `${e.mk}:${e.dir}`);
  // 실제 제목(2026-10~11월 구글 뉴스)
  assert.deepEqual(s('[속보] 코스피 4%대 급락…매도 사이드카 발동 - 연합뉴스'), ['KOSPI:sell']);
  assert.deepEqual(s("[속보] 코스피 이어 코스닥도 '매도 사이드카' - 메트로신문"), ['KOSDAQ:sell'], '사이드카 바로 앞 시장');
  assert.deepEqual(s('[속보]코스피·코스닥 동반 매도 사이드카 발동 - 동행미디어 시대'), ['KOSPI:sell', 'KOSDAQ:sell'], '둘 다');
  assert.deepEqual(s('삼성전자 7%·SK하이닉스 9% 급락…코스피·코스닥 잇따라 매도 사이드카 - JTBC'), ['KOSPI:sell', 'KOSDAQ:sell']);
  assert.deepEqual(s('‘널뛰기’ 코스닥 5% 급등…어제는 매도, 오늘은 매수 사이드카 - 한겨레'), ['KOSDAQ:buy'], '사이드카 바로 앞 방향');
  assert.deepEqual(s("코스피, 4% 이상 급등에 두달 만의 '매수' 사이드카…외국인 순매수세 - 연합뉴스"), ['KOSPI:buy'], '따옴표 안 방향');
  assert.deepEqual(s('[속보] 코스피, 서킷 해제 후 매도 사이드카 발동 - 뉴스1'), ['KOSPI:sell'], '서킷 해제는 상관없음');
  assert.deepEqual(s('코스피 5000선 붕괴·서킷브레이커…코스닥도 매도 사이드카[개장시황] - 뉴스1'), ['KOSDAQ:sell']);
  assert.deepEqual(s('SK하이닉스·삼성전자 2.7조 투매에 사이드카 발동! 폭락장 속 연기금·외국인이 동시에 매수'), [], '방향 없음');
  assert.deepEqual(s('코스피 매도 사이드카 해제…낙폭 축소'), [], '해제');
  assert.deepEqual(s('반도체주 매도 사이드카?'), [], '시장 이름 없음');
  // 시각 — 같은 시장·방향 기사가 3분 안에 3건 이상 몰린 첫 묶음의 두 번째 기사 시각(잘못 찍힌 기사 한두 건에 끌려가지 않게), 그날 09:00~15:40 기사만
  const at = (hm, d = '2026-11-06') => T(`${d}T${hm}:00+09:00`);
  const iso = (ms) => new Date(ms).toISOString();
  const items = [
    { title: '[속보] 코스피 이어 코스닥도 매도 사이드카 - 메트로신문', pubMs: at('09:01') }, // 혼자 일찍
    { title: '[속보] 코스닥, 매도 사이드카 발동 - 서울파이낸스', pubMs: at('09:07') },
    { title: '[속보] 코스닥 6%대 급락에 매도 사이드카 발동 - 이투데이', pubMs: at('09:08') },
    { title: '[스팟] 코스닥 매도 사이드카 발동 - 머니투데이', pubMs: at('09:09') },
    { title: "[속보] 코스피, 서킷 해제 후 '매도 사이드카' 발동 - 메트로신문", pubMs: at('09:13') }, // 잘못 찍힌 두 건이 1분 간격(실측 11/06)
    { title: "[속보]코스피, 개장하자마자 '서킷브레이커'에 '매도 사이드카'… 5,000선 붕괴 - KBC광주방송", pubMs: at('09:14') },
    { title: "코스피, 서킷브레이커 끝나자 '매도 사이드카' - 메트로신문", pubMs: at('09:34') }, // 한 곳만 일찍(실측)
    { title: '[속보] 코스피, 서킷 해제 후 매도 사이드카 발동 - 뉴스1', pubMs: at('09:36') },
    { title: '[속보] 코스피, 서킷브레이커 이어 매도 사이드카 발동 - 한국경제', pubMs: at('09:37') },
    { title: '[속보] 코스피 매도 사이드카 발동 - 장전일보', pubMs: at('08:40') }, // 장 전(잘못 찍힘)
    { title: '[속보] 코스피 매도 사이드카 발동 - 장전신문', pubMs: at('08:41') },
    { title: '[속보] 코스피 매도 사이드카 발동 - 장전방송', pubMs: at('08:42') },
    { title: '[속보] 코스피 4%대 급락…매도 사이드카 발동 - 연합뉴스', pubMs: at('10:17', '2026-11-05') }, // 어제
    { title: '[속보] 코스피 4%대 급락…매도 사이드카 발동 - YTN', pubMs: at('10:18', '2026-11-05') },
    { title: '[속보] 코스피 4%대 급락…매도 사이드카 발동 - 한국경제', pubMs: at('10:18', '2026-11-05') },
    { title: '코스피 매수 사이드카 기대감 - 한 곳', pubMs: at('11:00') }, // 한 건뿐
    { title: '날짜 없음 코스닥 매수 사이드카', pubMs: null },
  ];
  const ev = JSON.parse(JSON.stringify(src.sidecarEvents(items, at('09:40')))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  assert.deepEqual(ev.map((e) => `${e.kind}:${e.mk}:${e.dir}@${e.at}`), [`sidecar:KOSDAQ:sell@${iso(at('09:08'))}`, `sidecar:KOSPI:sell@${iso(at('09:36'))}`], '3건 묶음의 두 번째 기사 시각 — 잘못 찍힌 두 건(09:13·09:14)·일찍 찍은 한 곳(09:34)에 끌려가지 않음');
  assert.equal(src.sidecarEvents([], at('09:40')).length, 0);
  // 기록 합치기 — 그날 것만 · 같은 조치는 가장 이른 시각 · 시각순
  const cb = { kind: 'cb', mk: 'KOSPI', at: '2026-11-06T09:04:03+09:00' };
  let m = src.mergeMeasures(null, [cb], at('09:10'));
  assert.equal(m.day, '2026-11-06'); assert.equal(m.v, src.MEASURES_V); assert.deepEqual(m.items, [cb]);
  m = src.mergeMeasures(m, [{ ...cb, at: '2026-11-06T09:04:12+09:00' }, ...[...ev].reverse()], at('09:40'));
  assert.deepEqual(m.items.map((x) => `${x.kind}:${x.mk}:${x.dir || ''}`), ['cb:KOSPI:', 'sidecar:KOSDAQ:sell', 'sidecar:KOSPI:sell'], '시각순');
  assert.equal(m.items[0].at, cb.at, '같은 조치는 가장 이른 시각');
  assert.deepEqual(src.mergeMeasures(m, [], at('15:00')), m, '그날 내내 유지');
  assert.equal(src.mergeMeasures(m, [], at('09:10', '2026-11-09')), null, '날이 바뀌면 새로');
  assert.equal(src.mergeMeasures(null, [{ kind: 'sidecar', mk: 'KOSPI', at: cb.at }], at('09:10')), null, '방향 없는 사이드카는 버림');
  const old = { day: '2026-11-06', items: [cb, { kind: 'sidecar', mk: 'KOSPI', dir: 'sell', at: '2026-11-06T09:13:00+09:00' }] }; // 판 없음(예전 규칙)
  assert.deepEqual(src.mergeMeasures(old, [], at('11:20')).items, [cb], '판이 다르면 사이드카 기록은 버리고 다시(서킷브레이커는 유지)');
  assert.deepEqual(src.mergeMeasures({ ...old, v: src.MEASURES_V }, [], at('11:20')).items.length, 2, '같은 판이면 유지');
  assert.equal(src.mergeMeasures(null, [{ ...cb, mk: 'NASDAQ' }], at('09:10')), null, '모르는 시장은 버림');
  assert.equal(src.mergeMeasures(null, [{ ...cb, at: '2026-11-05T10:00:00+09:00' }], at('09:10')), null, '다른 날 시각은 버림');
  // 구글 뉴스 받기 — 제목·발행 시각, 발행 시각 없는 기사는 뺌
  NET.routes = [{ re: /news\.google\.com\/rss\/search\?q=%EC%82%AC%EC%9D%B4%EB%93%9C%EC%B9%B4/, fn: () => text('<?xml version="1.0"?><rss><channel><item><title><![CDATA[[속보] 코스닥, 매도 사이드카 발동 - 서울파이낸스]]></title><pubDate>Fri, 06 Nov 2026 00:07:00 GMT</pubDate></item><item><title>날짜 없는 기사</title></item></channel></rss>') }];
  assert.deepEqual(await src.getSidecarNews(), [{ title: '[속보] 코스닥, 매도 사이드카 발동 - 서울파이낸스', pubMs: Date.parse('2026-11-06T00:07:00Z') }]);
});
await test('시장 조치 기록(fetch.mjs → quotes.json measures): 시장 전체 정지 종목 → 서킷브레이커(상장 시장·가장 이른 정지 시각) · 사이드카 뉴스는 국내 장 시간에만 받고 그 시장 지수가 같은 방향으로 2% 넘게 움직였을 때만 · 정지가 풀려도 그날 내내 유지 · 다음 날 새로', async () => {
  const root = workspace();
  writeData(root, 'stocklist.json', { v: 2, kr: [['005930', '삼성전자', 'KOSPI', 1], ['000660', 'SK하이닉스', 'KOSPI', 2]], us: [['AAPL', '애플', 'Apple Inc.', 'NASDAQ', 1]], meta: {} });
  const HALT = { tradeStopType: { code: '2', text: '정지.Halted', name: 'HALTED' }, tradableStatusCode: 'marketOperationHalt' };
  const at = (hm, d = '2026-11-06') => T(`${d}T${hm}:00+09:00`);
  const hm = (s) => new Date(Date.parse(s) + 9 * 3600e3).toISOString().slice(11, 16);
  const news = (list) => (mm, u) => (/사이드카/.test(queryName(u))
    ? text(`<?xml version="1.0"?><rss><channel>${list.map(([t, h, d]) => `<item><title>${t}</title><pubDate>${new Date(at(h, d)).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`)
    : text(rss('', queryName(u))));
  const SC = /news\.google\.com\/rss\/search\?q=사이드카/; // callsTo는 풀어 쓴 주소로 센다
  // 09:10 — 코스피 종목 정지(서킷브레이커 09:04) · 코스닥 매도 사이드카 기사 2건 · 지수와 반대인 코스피 매수 사이드카 기사 2건
  await pipeline(root, { idxPct: -8.5, krExtra: { '005930': { ...HALT, tradableStatusUpdatedAt: '2026-11-06T09:04:12+09:00' }, '000660': { ...HALT, tradableStatusUpdatedAt: '2026-11-06T09:04:03+09:00' } },
    news: news([['[속보] 코스닥, 매도 사이드카 발동 - 서울파이낸스', '09:07'], ['[속보] 코스닥 6%대 급락에 매도 사이드카 발동 - 이투데이', '09:08'], ['[스팟] 코스닥 매도 사이드카 발동 - 머니투데이', '09:09'],
      ['코스피 매수 사이드카 발동 - 가짜일보', '09:08'], ['[속보] 코스피 매수 사이드카 - 가짜신문', '09:09'], ['코스피 매수 사이드카 - 가짜방송', '09:09']]) }, at('09:10'));
  assert.equal(callsTo(SC), 1, '장 시간엔 사이드카 뉴스를 받음');
  let m = read(root, 'quotes.json').measures;
  assert.equal(m.day, '2026-11-06');
  assert.deepEqual(m.items.map((x) => `${x.kind}:${x.mk}:${x.dir || ''}@${hm(x.at)}`), ['cb:KOSPI:@09:04', 'sidecar:KOSDAQ:sell@09:08'], '지수와 반대 방향 사이드카(매수)는 버림 · 사이드카는 두 번째 기사 시각');
  assert.equal(m.items[0].at, new Date(at('09:04') + 3000).toISOString(), '서킷브레이커는 가장 이른 정지 시각');
  // 09:40 — 정지 풀림 · 코스피 매도 사이드카 기사 2건 · 코스닥 사이드카 기사는 더 늦은 시각
  await pipeline(root, { idxPct: -5.9, news: news([['[속보] 코스피, 서킷 해제 후 매도 사이드카 발동 - 뉴스1', '09:36'], ['[속보] 코스피, 서킷브레이커 이어 매도 사이드카 발동 - 한국경제', '09:37'], ['[속보]코스피, 서킷 이어 매도 사이드카 발동 - 뉴시스', '09:37'],
    ['코스닥 매도 사이드카 발동 이후 낙폭 확대 - 가', '09:20'], ['코스닥 매도 사이드카 발동… - 나', '09:21'], ['코스닥 매도 사이드카 여파 - 다', '09:22']]) }, at('09:40'));
  m = read(root, 'quotes.json').measures;
  assert.deepEqual(m.items.map((x) => `${x.kind}:${x.mk}:${x.dir || ''}@${hm(x.at)}`), ['cb:KOSPI:@09:04', 'sidecar:KOSDAQ:sell@09:08', 'sidecar:KOSPI:sell@09:37'], '정지가 풀려도 서킷브레이커 유지 · 같은 조치는 가장 이른 시각');
  // 16:30 — 장 시간 밖엔 사이드카 뉴스를 받지 않고 그날 기록 유지
  await pipeline(root, { idxPct: -5.9, news: news([['[속보] 코스피 매수 사이드카 발동 - 가', '15:10'], ['[속보] 코스피 매수 사이드카 발동 - 나', '15:11']]) }, at('16:30'));
  assert.equal(callsTo(SC), 0, '장 시간 밖엔 받지 않음');
  assert.equal(read(root, 'quotes.json').measures.items.length, 3, '그날 기록 유지');
  // 다음 날 — 지수가 2% 안쪽이면 같은 방향 기사라도 믿지 않음, 조치가 없으면 칸 없음
  await pipeline(root, { idxPct: -1.0, news: news([['[속보] 코스피 매도 사이드카 발동 - 가', '09:20', '2026-11-09'], ['[속보] 코스피 매도 사이드카 발동 - 나', '09:21', '2026-11-09'], ['[속보] 코스피 매도 사이드카 발동 - 다', '09:21', '2026-11-09']]) }, at('09:30', '2026-11-09'));
  assert.equal(read(root, 'quotes.json').measures, undefined, '다음 날 새로 · 지수 2% 안쪽이면 사이드카 기사를 믿지 않음');
});
await test('화면 오늘 시장 조치(app.js): 그날 기록만 · 서킷브레이커 주황·매도 사이드카 파랑·매수 사이드카 빨강 · 시각순 · 지금 그 시장 전체가 멈춰 있으면 그 서킷브레이커는 안내 줄이 대신', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const a = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const b = appJs.slice(appJs.indexOf('// ---------- 데이터 지연 경고'), appJs.indexOf('// ---------- 내 종목 한눈에'));
  const f = vm.runInNewContext(`${a}${b}; ({ measuresOf })`, { lastTimeOf: () => '' });
  const m = { day: '2026-11-06', items: [{ kind: 'sidecar', mk: 'KOSPI', dir: 'buy', at: '2026-11-06T05:10:00.000Z' }, { kind: 'cb', mk: 'KOSPI', at: '2026-11-06T00:04:03.000Z' }, { kind: 'sidecar', mk: 'KOSDAQ', dir: 'sell', at: '2026-11-06T00:07:00.000Z' }] };
  const now = T('2026-11-06T15:00:00+09:00');
  const r = JSON.parse(JSON.stringify(f.measuresOf(m, [], now)));
  assert.deepEqual(r.map((x) => `${x.cls}|${x.text}`), ['cb|코스피 서킷브레이커 09:04', 'sell|코스닥 매도 사이드카 09:07', 'buy|코스피 매수 사이드카 14:10'], '시각순·색 구분');
  assert.match(r[0].tip, /8%.*20분.*거래소 정지 시각/);
  assert.match(r[1].tip, /코스닥150 선물.*6%.*떨어져.*프로그램 매도.*5분.*종목 거래는 계속.*뉴스 속보/);
  assert.match(r[2].tip, /코스피200 선물.*5%.*올라.*프로그램 매수/);
  const halted = [{ ok: true, market: 'KR', exch: 'KOSPI', marketStatus: 'OPEN', halt: 'market' }];
  assert.deepEqual(JSON.parse(JSON.stringify(f.measuresOf(m, halted, now))).map((x) => x.cls), ['sell', 'buy'], '정지 중인 시장의 서킷브레이커는 안내 줄이 대신');
  assert.equal(f.measuresOf(m, [], T('2026-11-09T09:30:00+09:00')).length, 0, '다른 날 기록은 안 보임');
  assert.equal(f.measuresOf(null, [], now).length, 0);
  assert.equal(f.measuresOf({ day: '2026-11-06', items: [{ kind: 'sidecar', mk: 'KOSPI', at: '2026-11-06T00:07:00Z' }, { kind: 'cb', mk: 'NASDAQ', at: '2026-11-06T00:07:00Z' }, { kind: 'cb', mk: 'KOSDAQ', at: 'x' }] }, [], now).length, 0, '방향 없는 사이드카·모르는 시장·시각 없음은 뺌');
});
await test('화면 첫 체결 전·매매 정지·예상 지수(app.js): 장중인데 오늘 거래량 없는 국내 종목은 체결 전(평균·시장 대비에서 빼고 칸 맨 뒤) · 시장 전체 정지면 안내 한 줄 · 개장 전 예상 지수는 표시하고 비교 안 함 · 안내는 하나만', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const a = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const b = appJs.slice(appJs.indexOf('// ---------- 데이터 지연 경고'), appJs.indexOf('// ---------- 내 종목 한눈에'));
  const f = vm.runInNewContext(`${a}${b}; ({ pendingOf, haltOf, tileRank, avgPct, expIdx, benchOf, vsMarket, hmKst, haltNote, pendingNote, boardNote })`, { lastTimeOf: () => '' });
  const kr = (x) => ({ ok: true, market: 'KR', exch: 'KOSPI', marketStatus: 'OPEN', volume: 1000, changePct: -6, ...x });
  const pend = kr({ volume: null, changePct: 0 });
  assert.equal(f.pendingOf(pend), true);
  assert.equal(f.pendingOf(kr({ volume: 0, changePct: 0 })), true, '거래량 0도');
  assert.equal(f.pendingOf(kr({})), false, '체결 있음');
  assert.equal(f.pendingOf(kr({ volume: null, marketStatus: 'PREOPEN' })), false, '개장 전은 따로(이름표·안내)');
  assert.equal(f.pendingOf(kr({ volume: null, halt: 'stock' })), false, '정지 종목은 정지로');
  assert.equal(f.pendingOf({ ...pend, market: 'US' }), false, '해외는 해당 없음');
  assert.equal(f.pendingOf({ ...pend, ok: false }), false);
  assert.equal(f.haltOf(kr({ halt: 'market' })), 'market');
  assert.equal(f.haltOf(kr({ halt: 'market', marketStatus: 'CLOSE' })), '', '장이 끝나면 정지 표시 안 함');
  assert.equal(f.haltOf(kr({})), '');
  assert.equal(f.avgPct([kr({ changePct: -6 }), kr({ changePct: -4 }), pend]), -5, '첫 체결 전은 평균에서 뺌');
  const order = [pend, kr({ changePct: 1 }), { ok: false, code: 'X' }, kr({ changePct: -7 })].sort((x, y) => f.tileRank(y) - f.tileRank(x) || 0);
  assert.deepEqual(order.map((q) => (q.ok ? (f.pendingOf(q) ? '전' : q.changePct) : '실패')), [1, -7, '전', '실패'], '체결된 종목 → 체결 전 → 실패');
  // 예상 지수 — 개장 전인데 0%가 아니면 예상
  const ks = (x) => ({ symbol: '^KS11', name: '코스피', currency: 'KRW', changePct: -9.68, marketStatus: 'PREOPEN', ...x });
  assert.equal(f.expIdx(ks({})), true);
  assert.equal(f.expIdx(ks({ changePct: 0 })), false, '어제 종가 그대로면 예상 아님');
  assert.equal(f.expIdx(ks({ marketStatus: 'OPEN' })), false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.benchOf('KR', [ks({})]))), [{ name: '코스피', pct: -9.68, exp: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.benchOf('KR', [ks({ marketStatus: 'OPEN' })]))), [{ name: '코스피', pct: -9.68 }]);
  assert.equal(f.vsMarket(kr({ changePct: -6.5 }), [ks({})]), null, '예상 지수와 비교 안 함');
  assert.equal(f.vsMarket(kr({ changePct: -6.5 }), [ks({ marketStatus: 'OPEN', changePct: -6 })]).follows, true);
  assert.equal(f.vsMarket(pend, [ks({ marketStatus: 'OPEN', changePct: -6 })]), null, '첫 체결 전은 비교 안 함');
  // 시장 전체 매매 정지 안내 — 가장 이른 정지 시각, 시장 이름
  assert.equal(f.hmKst('2026-11-06T09:04:12.035+09:00'), '09:04');
  assert.equal(f.hmKst('2026-11-06T00:30:00Z'), '09:30', '한국시간으로');
  assert.equal(f.hmKst(null), '');
  const halted = [kr({ halt: 'market', haltAt: '2026-11-06T09:05:40+09:00' }), kr({ halt: 'market', haltAt: '2026-11-06T09:04:03+09:00' }), kr({ exch: 'KOSDAQ' })];
  assert.equal(f.haltNote('KR', halted), '코스피 시장 전체 매매가 09:04부터 멈춰 있어요(서킷브레이커 같은 시장 조치) — ‘매매 정지’ 칸은 멈추기 직전 가격이에요.');
  assert.match(f.haltNote('KR', [...halted, kr({ exch: 'KOSDAQ', halt: 'market' })]), /^코스피·코스닥 시장/);
  assert.match(f.haltNote('KR', [kr({ halt: 'market', exch: undefined, haltAt: null })]), /^시장 전체 매매가 멈춰/, '시장·시각을 모르면 빼고');
  assert.equal(f.haltNote('KR', [kr({ halt: 'stock' })]), '', '한 종목 정지는 칸에만');
  assert.equal(f.haltNote('US', halted), '');
  assert.equal(f.haltNote('KR', [kr({ halt: 'market', marketStatus: 'CLOSE' })]), '', '장이 끝나면 없음');
  // 첫 체결 전 안내 — 평일 9시~9시 30분만
  const at = (hm, d = '2026-11-06') => T(`${d}T${hm}:00+09:00`);
  assert.match(f.pendingNote('KR', [pend, pend, kr({})], at('09:00')), /^2종목은 아직 첫 체결 전이에요 — .*2분 미뤄요/);
  assert.match(f.pendingNote('KR', [pend], at('09:29')), /^1종목/);
  assert.equal(f.pendingNote('KR', [pend], at('09:30')), '', '9시 30분부터는 칸에만');
  assert.equal(f.pendingNote('KR', [pend], at('08:59')), '');
  assert.equal(f.pendingNote('KR', [kr({})], at('09:01')), '', '모두 체결');
  assert.equal(f.pendingNote('US', [pend], at('09:01')), '');
  assert.equal(f.pendingNote('KR', [pend], at('09:01', '2026-11-07')), '', '토요일');
  // 안내는 하나만 — 개장 전 → 시장 전체 정지 → 첫 체결 전
  const preo = [{ ok: true, market: 'KR', marketStatus: 'PREOPEN', changePct: 0 }];
  assert.match(f.boardNote('KR', preo, at('08:50')), /9시 개장 전/);
  assert.match(f.boardNote('KR', [...halted, pend], at('09:05')), /매매가 09:04부터/);
  assert.match(f.boardNote('KR', [pend, kr({})], at('09:01')), /첫 체결 전/);
  assert.equal(f.boardNote('KR', [kr({})], at('09:01')), '');
});
await test('화면 개장 직후·개장 전(app.js): 평일 08:59~09:12엔 20초마다 확인(설정이 더 짧거나 수동이면 그대로) · 국내 시세가 모두 개장 전이면 안내 한 줄 · 이름표 "개장 전"', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('// ---------- 데이터 지연 경고'), appJs.indexOf('// ---------- 내 종목 한눈에'));
  const f = vm.runInNewContext(`${block}; ({ pollSec, preOpenNote, groupInfo })`, { lastTimeOf: () => '' });
  const at = (hm, d = '2026-11-05') => T(`${d}T${hm}:00+09:00`);
  assert.equal(f.pollSec(60, at('08:58')), 60, '창 전');
  assert.equal(f.pollSec(60, at('08:59')), 20, '창 시작');
  assert.equal(f.pollSec(300, at('09:05')), 20, '5분 설정도 이때만 20초');
  assert.equal(f.pollSec(30, at('09:05')), 20);
  assert.equal(f.pollSec(0, at('09:05')), 0, '수동은 그대로');
  assert.equal(f.pollSec(0, at('08:00')), 0);
  assert.equal(f.pollSec(60, at('09:11')), 20);
  assert.equal(f.pollSec(60, at('09:12')), 60, '창 끝');
  assert.equal(f.pollSec(60, at('09:05', '2026-11-07')), 60, '토요일');
  const now = new Date().toISOString();
  const pre = [{ ok: true, marketStatus: 'PREOPEN', changePct: 0, asOf: now }, { ok: true, marketStatus: 'PREOPEN', changePct: 0, asOf: now }];
  assert.match(f.preOpenNote('KR', pre), /개장 전.*1분/);
  assert.equal(f.preOpenNote('KR', [...pre, { ok: true, marketStatus: 'OPEN', asOf: now }]), '', '하나라도 장중이면 없음');
  assert.equal(f.preOpenNote('US', pre), '', '해외 묶음은 해당 없음');
  assert.equal(f.preOpenNote('KR', []), '');
  const st = (list) => f.groupInfo({ key: 'KR' }, list, null).status;
  assert.match(st(pre), /개장 전/);
  assert.match(st([{ ok: true, marketStatus: 'OPEN', asOf: now }]), /장중/);
  assert.match(st([{ ok: true, marketStatus: 'CLOSE', asOf: now }]), /마감/);
});
await test('바뀐 파일만 받기(app.js): 지문이 같으면 다시 안 받음 · 바뀌면 그 파일만 · 내용이 지문과 다르면 예전처럼 새로 받기 · 지문 파일이 없으면 예전 방식', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('async function loadJson('), appJs.indexOf('// ---------- 통계 / 예측'));
  assert.ok(block.includes('function loadData') && block.includes('function loadManifest'), '블록 추출');
  const files = { 'a.json': '{"n":1}', 'b.json': '{"n":2}' };
  let manifest = { files: { 'a.json': sha10(files['a.json']), 'b.json': sha10(files['b.json']) } };
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const name = url.split('?')[0].replace('./data/', '');
    if (name === 'manifest.json') return manifest ? new Response(JSON.stringify(manifest)) : new Response('없음', { status: 404 });
    return files[name] != null ? new Response(files[name]) : new Response('없음', { status: 404 });
  };
  const vmApi = vm.runInNewContext(`${block}; ({ loadManifest, loadData })`, { fetch: fakeFetch, crypto: globalThis.crypto, TextDecoder });
  // 다른 실행 환경에서 만든 객체는 그대로 비교하면 프로토타입이 달라 같지 않다고 나온다 — 이쪽 객체로 바꿔 비교
  const api = { loadManifest: () => vmApi.loadManifest(), loadData: async (n) => JSON.parse(JSON.stringify(await vmApi.loadData(n))) };
  const count = (re) => calls.filter((u) => re.test(u)).length;
  await api.loadManifest();
  assert.deepEqual(await api.loadData('a.json'), { n: 1 });
  assert.deepEqual(await api.loadData('a.json'), { n: 1 });
  assert.equal(count(/^\.\/data\/a\.json\?v=/), 1, '지문이 같으면 다시 안 받음');
  assert.ok(calls.includes(`./data/a.json?v=${manifest.files['a.json']}`), '주소에 지문');
  await api.loadData('b.json');
  files['a.json'] = '{"n":3}'; manifest = { files: { ...manifest.files, 'a.json': sha10(files['a.json']) } };
  await api.loadManifest();
  assert.deepEqual(await api.loadData('a.json'), { n: 3 }, '바뀐 파일은 새로');
  await api.loadData('b.json');
  assert.equal(count(/^\.\/data\/b\.json/), 1, '안 바뀐 파일은 그대로');
  // 지문과 내용이 다르면(배포 중 엇갈림) 예전처럼 새로 받고, 그 지문 주소는 다시 쓰지 않음
  manifest = { files: { ...manifest.files, 'a.json': '0123456789' } };
  await api.loadManifest();
  assert.deepEqual(await api.loadData('a.json'), { n: 3 });
  assert.deepEqual(await api.loadData('a.json'), { n: 3 });
  assert.equal(count(/a\.json\?v=0123456789/), 1, '틀린 지문 주소는 한 번만');
  assert.equal(count(/^\.\/data\/a\.json\?t=/), 2, '대신 매번 새로(예전 방식)');
  // 지문 파일이 없거나 그 파일 지문이 없으면 예전 방식
  manifest = null;
  await api.loadManifest();
  await api.loadData('b.json');
  assert.equal(count(/^\.\/data\/b\.json\?t=/), 1);
  manifest = { files: { 'a.json': sha10(files['a.json']) } };
  await api.loadManifest();
  await api.loadData('b.json');
  assert.equal(count(/^\.\/data\/b\.json\?t=/), 2);
});
await test('시장 비교·6개월 신고가·지난 급등락(app.js): 단순 평균 · 같은 시장 지수 · 오늘 봉 제외 · 시장 현지 날짜', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  assert.ok(block.includes('function sixMonthMark') && block.includes('function pastMoves'), '블록 추출');
  const f = vm.runInNewContext(`${block}; ({ marketYmd, avgPct, benchOf, sixMonthMark, pastMoves })`, {});
  const usClose = T('2026-10-15T20:00:00Z'); // 뉴욕 10/15 16:00 = 한국 10/16 05:00
  assert.deepEqual([f.marketYmd(usClose, 'US'), f.marketYmd(usClose, 'KR')], ['20261015', '20261016']);
  assert.equal(f.avgPct([{ ok: true, changePct: 2 }, { ok: true, changePct: -1 }, { ok: false, changePct: 9 }, { ok: true }]), 0.5);
  assert.equal(f.avgPct([]), null);
  const idx = [{ symbol: '^KS11', changePct: -0.8 }, { symbol: '^KQ11', changePct: 1.2 }, { symbol: '^GSPC', changePct: 0.5 }, { symbol: '^IXIC' }];
  assert.deepEqual(JSON.parse(JSON.stringify(f.benchOf('KR', idx))), [{ name: '코스피', pct: -0.8 }, { name: '코스닥', pct: 1.2 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.benchOf('US', idx))), [{ name: 'S&P 500', pct: 0.5 }], '값 없는 지수는 뺌');
  assert.deepEqual(JSON.parse(JSON.stringify(f.benchOf('XX', idx))), []);
  // 국내 일봉 100개(00:00Z = 한국 09:00), 종가 100~199 — 마지막 봉이 오늘이면 빼고 비교
  const dates = Array.from({ length: 100 }, (_, i) => T('2026-06-01T00:00:00Z') + i * 86400e3);
  const h = { dates, closes: dates.map((_, i) => 100 + i) };
  const today = new Date(dates.at(-1) + 5 * 3600e3).toISOString(); // 마지막 봉과 같은 한국 날짜
  const next = new Date(dates.at(-1) + 30 * 3600e3).toISOString();
  const q = (price, asOf, extra = {}) => ({ ok: true, market: 'KR', price, asOf, ...extra });
  assert.equal(f.sixMonthMark(q(198.5, today), h), 'high', '오늘 봉(199)은 빼고 198과 비교');
  assert.equal(f.sixMonthMark(q(198.5, next), h), null, '마지막 봉이 오늘이 아니면 그 봉(199)까지 비교');
  assert.equal(f.sixMonthMark(q(199.5, next), h), 'high');
  assert.equal(f.sixMonthMark(q(99, today), h), 'low');
  assert.equal(f.sixMonthMark(q(150, today), h), null);
  assert.equal(f.sixMonthMark(q(250, today), { dates: dates.slice(-50), closes: h.closes.slice(-50) }), null, '석 달치도 없으면 판단 안 함');
  assert.equal(f.sixMonthMark(q(250, today, { ok: false }), h), null);
  const list = [{ d: '20261010', p: 3 }, { d: '20261015', p: -4 }, { d: '20261014', p: 2.5 }, { d: 'bad', p: 9 }, { d: '20261001', p: -2 }, { d: '20260920', p: 5 }, { d: '20260901', p: 2 }];
  const pm = [...f.pastMoves({ market: 'US', asOf: new Date(usClose).toISOString() }, list).map((x) => x.d)]; // 다른 실행 환경의 배열 → 이쪽 배열로
  assert.deepEqual(pm, ['20261014', '20261010', '20261001', '20260920'], '오늘(뉴욕 10/15) 것·형식 오류 빼고 최신 4건');
  assert.deepEqual([...f.pastMoves({ market: 'US', asOf: 'x' }, null)], []);
});
// 실제 제목(2026-10-22 news.json) — 시세만 알려 주는 자동 기사 / 이유가 들어 있는 기사
const PRICE_ONLY_YES = ['SK하이닉스 주가, 10월 22일 장중 1,281,000원 1.00% 하락', '삼성전자우 주가, 10월 22일 장중 172,900원 0.41% 상승',
  'SK텔레콤 주가, 10월 21일 애프터마켓 77,300원 0.00% 보합', 'LG에너지솔루션 주가, 10월 21일 411,500원 0.60% 하락', '현대중공업 주가 하락 중',
  '슈퍼 마이크로 컴퓨터 주가 상승 중', 'HD건설기계 장중 3%대 상승', '현대중공업 주가 2,000원 상승 후 장마감', '한화솔루션 주가 50원 하락 후 장마감',
  '[특징주] 한화솔루션 장중 2%대 강세 3만1450원 기록 : 기업주식정보', 'SK텔레콤 거래량 13.6% 감소…20일 65만2578주',
  '[특징주] 한미반도체, 장중 1%대 상승하며 20만2000원 기록 : 기업주식정보', '두산에너빌리티 장중 1.57% 하락해 6만2500원', 'LG전자, 22일 장중 2%대 하락',
  '4일 한화오션 52,400원 2.60% 내려 하락률 동일업종 평균보다 1.08%p 커', '[특징주] 삼성SDI, 장중 5%대 약세 보이며 51만3000원선 기록 : 기업주식정보',
  '한화솔루션 거래량 1342만주…2만7050원서 3.39% 약세', '[특징주] LG에너지솔루션 장중 2%대 하락세 : 기업주식정보',
  'NVDA|NVIDIA Corp|Price:200.130|Chg%:-6.560',
  '[특징주] 대덕전자, 장중 16%대 급락세… 8만3100원 기록 : 기업주식정보', '[특징주] 심텍, 장중 15%대 급락하며 10만3500원선 기록 : 기업주식정보',
  '[특징주] 삼성전기 장중 11%대 급락 98만원선 거래 : 기업주식정보', 'LS ELECTRIC 주가, 11월 5일 장중 11.94% 하락 동일업종 동반 약세',
  '[마감분석] 대덕전자 19.80% 급락 마감 7만9800원 기록 : 기업주식정보'];
const PRICE_ONLY_NO = ['영업이익 추정치 웃돈 파두…주가는 장중 6.75% 하락', '삼성전기 주가 3.08% 상승…엔비디아 기판 생산능력 확대에 공급 수혜 기대',
  '호실적에 자사주 소각까지…삼성E&A 15% 상승세 [특징주]', '[장중수급포착] 대덕전자, 기관 8일 연속 순매수행진... 주가 +4.24%',
  '[개장시황] 삼성전기 5.05% 급등…코스피 차익매물에 하락 출발', 'Why Super Micro Computer Stock Popped Today', '수주 기대감에 장중 3%대 상승',
  '대덕전자, 장중 2.51% 하락…iM증권은 이익 전망 상향', '9개국 이상 거점 둔 한화에어로스페이스…주가 89만9000원으로 상승', '[특징주] SK텔레콤, 뚜렷한 공시 없이 장중 소폭 하락세 : 기업주식정보', '두산에너빌리티 장중 1.57% 하락해 6만2500원…원전 수주 지연 영향',
  "[특징주] 현대차·기아, 트럼프 자동차 정책 후퇴 기대.. '강세'", 'LG전자 5.99% 하락…AI 데이터센터 냉각 수주 전환 주목', '4일 한화오션 수주 2조…주가 2.60% 올라',
  '[특징주] 씨에스윈드, 미국 베스타스와 797억원 공급계약', '효성중공업 177만원까지 밀려…전력기기 호황에도 13.62%↓', "[특징주] 美관세 완화 기대?…현대차·기아, 3%·5%대 각각 상승(종합)", '[마감분석] 반도체 수요 둔화 우려…대덕전자 급락'];
await test('시세 안내 기사: 날짜·가격만 있는 자동 기사·"주가 상승 중"·"장중 3%대 상승"은 이유에서 제외 · 이유가 붙은 제목은 유지 · 봇과 화면 판정이 같음', async () => {
  for (const t of PRICE_ONLY_YES) assert.equal(src.priceOnly(t), true, t);
  for (const t of PRICE_ONLY_NO) assert.equal(src.priceOnly(t), false, t);
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ priceOnly, pickReasonNews })`, {});
  for (const t of [...PRICE_ONLY_YES, ...PRICE_ONLY_NO, '', '삼성전자 주가 하락 출발']) assert.equal(f.priceOnly(t), src.priceOnly(t), `화면·봇 같은 판정: ${t}`);
  const items = [{ title: PRICE_ONLY_YES[0] }, { title: '' }, { title: PRICE_ONLY_YES[4] }, { title: PRICE_ONLY_NO[0] }, { title: PRICE_ONLY_NO[1] }];
  const none = () => '';
  assert.equal(f.pickReasonNews(items, -2.5, '', none).title, PRICE_ONLY_NO[0], '시세 안내 기사를 건너뛴 가장 최근 기사(방향이 반대인 기사는 제외)');
  assert.equal(f.pickReasonNews([{ title: PRICE_ONLY_YES[1] }], -2.5, '', none), null);
  assert.equal(f.pickReasonNews(null, -2.5, '', none), null);
});
await test('급등락 기록(24차): 우선주는 기사 속 보통주 이름으로 방향을 봐 같은 방향 기사를 이유로', async () => {
  const items = [{ code: '005935', market: 'KR', name: '삼성전자우' }, { code: 'AAPL', market: 'US', name: '애플' }];
  const root = workspace(items);
  const news = (m, u) => {
    const name = queryName(u), now = Date.now();
    const item = (t, ago) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/${ago}</link><pubDate>${new Date(now - ago).toUTCString()}</pubDate><source url="https://news.example.com">테스트일보</source></item>`;
    return text(`<?xml version="1.0"?><rss><channel>${item(`${name} 반도체 업황 점검`, 600e3)}${item(`[특징주] ${name} 하락, SK하이닉스 상승`, 3600e3)}</channel></rss>`);
  };
  await pipeline(root, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news, krPct: { '005935': -3.1 } });
  assert.deepEqual(read(root, 'moves.json')['005935'][0], { d: '20261015', p: -3.1, r: '[특징주] 삼성전자 하락, SK하이닉스 상승', s: 'news' });
});
await test('급등락 기록(23차): 정정·자회사 공시는 맞는 뉴스가 없을 때만 이유 · 예전에 남긴 그런 공시 이유는 맞는 뉴스가 생기면 바꿈', async () => {
  await withDartKey(async () => {
    const rows = { ...DART_ROWS, '00126380': [['20261015000999', '[기재정정]타법인주식및출자증권취득결정']] };
    const item = (t) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/1</link><pubDate>${new Date(Date.now() - 600e3).toUTCString()}</pubDate><source url="https://news.example.com">테스트일보</source></item>`;
    const noNews = () => text('<?xml version="1.0"?><rss><channel></channel></rss>');
    const withNews = (m, u) => text(`<?xml version="1.0"?><rss><channel>${item(`${queryName(u)}, 대규모 수주 소식에 급등`)}</channel></rss>`);
    const root = workspace();
    await pipeline(root, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news: noNews, dartRows: rows });
    assert.deepEqual(read(root, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '[M&A] [기재정정]타법인주식및출자증권취득결정', s: 'disc' }, '맞는 뉴스가 없으면 정정 공시');
    await pipeline(root, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news: withNews, dartRows: rows }, NOW_KR + 5 * MIN);
    assert.deepEqual(read(root, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '삼성전자, 대규모 수주 소식에 급등', s: 'news' }, '맞는 뉴스가 생기면 정정 공시 이유를 바꿈');
  });
});
await test('급등락 기록: 이유로 쓸 뉴스는 시세 안내 기사를 건너뛴 가장 최근 기사', async () => {
  const root = workspace();
  const news = (m, u) => {
    const name = queryName(u), now = Date.now();
    const item = (t, ago) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/${ago}</link><pubDate>${new Date(now - ago).toUTCString()}</pubDate><source url="https://news.example.com">테스트일보</source></item>`;
    return text(`<?xml version="1.0"?><rss><channel>${item(`${name} 주가, 10월 15일 장중 70,000원 4.20% 상승`, 600e3)}${item(`${name} 주가 상승 중`, 900e3)}${item(`${name}, 대규모 수주 소식에 급등`, 3600e3)}</channel></rss>`);
  };
  await pipeline(root, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news });
  assert.deepEqual(read(root, 'news.json')['005930'].items.map((x) => x.title), ['삼성전자, 대규모 수주 소식에 급등', '삼성전자 주가, 10월 15일 장중 70,000원 4.20% 상승', '삼성전자 주가 상승 중'], '뉴스 목록엔 모두 남고 시세 안내는 끝으로(18차)');
  assert.deepEqual(read(root, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '삼성전자, 대규모 수주 소식에 급등', s: 'news' });
  // 예전 기록에 시세 안내 기사가 이유로 남아 있고 지금도 그런 기사뿐이면 그 이유를 지키지 않고 비운다
  const r2 = workspace();
  writeData(r2, 'moves.json', { '005930': [{ d: '20261015', p: 4, r: '삼성전자 주가, 10월 15일 장중 70,000원 4.00% 상승', s: 'news' }] });
  const onlyPrice = (m, u) => { const name = queryName(u); return text(`<?xml version="1.0"?><rss><channel><item><title>${name} 주가 상승 중 - 테스트일보</title><link>https://news.example.com/p</link><pubDate>${new Date(Date.now() - 600e3).toUTCString()}</pubDate><source url="https://news.example.com">테스트일보</source></item></channel></rss>`); };
  await pipeline(r2, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news: onlyPrice });
  assert.deepEqual(read(r2, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '', s: '' });
  // 18차: 예전 뉴스 이유가 오늘 움직임과 반대 성격(오른 날의 악재 기사)이면 지키지 않고, 같은 성격이면 지킨다
  const r3 = workspace();
  writeData(r3, 'moves.json', { '005930': [{ d: '20261015', p: 4, r: '삼성전자, 실적 부진 우려 커져', s: 'news' }] });
  await pipeline(r3, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news: onlyPrice });
  assert.deepEqual(read(r3, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '', s: '' });
  const r4 = workspace();
  writeData(r4, 'moves.json', { '005930': [{ d: '20261015', p: 4, r: '삼성전자, 대규모 수주 계약', s: 'news' }] });
  await pipeline(r4, { gemini: () => text('upstream error', 500), krAt: NOW_KR, news: onlyPrice });
  assert.deepEqual(read(r4, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '삼성전자, 대규모 수주 계약', s: 'news' });
});
await test('이유 고르기: 상품 상장 공지·방향이 반대인 기사 제외 · 그날 같은 방향 [특징주] 먼저 · 나열 기사는 뒤로 · 같은 등급은 최신순 · 봇과 화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ pickReasonNews })`, {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const at = (h) => T(`2026-10-22T${String(h).padStart(2, '0')}:00:00+09:00`), yday = T('2026-10-21T15:00:00+09:00');
  const items = [
    { title: '“삼성전자·SK하이닉스 등락에 투자”…한국투자증권, ELW 224종 상장', pubMs: at(14) },
    { title: '[오늘의 특징주] 엠에스바이오 136% 폭등...SKAI·에이전트AI 상한가, 비나텍·삼성E&A도 급등', pubMs: at(13) },
    { title: '코스피 20% 빠질 때 15% 급등… ESS 동력 삼아 날아오른 LG엔솔', pubMs: at(12) },
    { title: '[특징주] 삼성E&A, 어닝 서프라이즈에 6900억 자사주 소각 얹자 14%↑', pubMs: at(11) },
    { title: 'LG엔솔 악몽이… 개미 울린 ‘중복상장’ 잔혹사', pubMs: at(10) },
    { title: '[특징주] 어제 오른 이유…자사주 소각에 급등', pubMs: yday },
  ];
  const pick = (list, pct, names = []) => {
    const a = src.pickReasonNews(list, pct, '20261022', kst, names), b = f.pickReasonNews(list, pct, '20261022', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택');
    return a ? a.title : null;
  };
  assert.equal(pick(items, 16.1), items[3].title, '오른 날: 그날 같은 방향 [특징주]');
  assert.equal(pick(items.filter((x, i) => i !== 3), 16.1), items[2].title, '[특징주]가 없으면 방향이 어긋나지 않는 가장 최근 기사(상장 공지·나열 기사 제외)');
  assert.equal(pick(items, -3.65), items[4].title, "내린 날: '급등' 기사·오른 [특징주]는 빼고 나열 기사는 뒤로");
  assert.equal(pick([items[2], items[3]], -3.65), null, '방향이 반대인 기사뿐이면 이유 없음');
  assert.equal(pick([items[1], items[0]], 2.5), items[1].title, '나열 기사밖에 없으면 그것이라도');
  assert.equal(pick([{ title: '[오늘의 증권가 콜] LS ELECTRIC, 유니드, 삼성바이오, LIG디펜스, 테스, 한화솔루션 등', pubMs: at(9) }, items[5]], 2.5), items[5].title, '쉼표로 여러 종목 나열 + 등 = 나열 기사');
  assert.equal(pick([items[0], { title: 'SK하이닉스 주가 하락 중' }], -3), null, '상장 공지·시세 안내뿐이면 없음');
  assert.equal(pick(items, 0), items[2].title, '보합이면 방향 판단 없이 최신순(상장 공지·나열 기사 제외)');
  // 한 제목에 두 종목 — 그 종목 이름 바로 뒤의 말로 방향을 본다
  const mixed = [{ title: "[특징주] 삼성전자 '상승' SK하이닉스 1%대 '하락'.. 차익실현 매물 출회", pubMs: at(14) }, { title: '삼성전자, HBM 공급 협상 지연 우려', pubMs: at(12) }];
  assert.equal(pick(mixed, -2.9, ['삼성전자']), mixed[1].title, "삼성전자는 이름 뒤 '상승' — 오늘 하락과 반대라 제외");
  assert.equal(pick(mixed, -3.25, ['SK하이닉스']), mixed[0].title, "SK하이닉스는 이름 뒤 '하락' — 같은 방향 [특징주]");
  assert.equal(pick([{ title: '[특징주] 반도체 대형주 약세 전환…삼성전자, 외국인 매도 확대', pubMs: at(13) }, mixed[1]], -2.9, ['삼성전자']),
    '[특징주] 반도체 대형주 약세 전환…삼성전자, 외국인 매도 확대', '이름 바로 뒤에 방향 말이 없으면 제목 전체(약세)로');
});
await test('이유 고르기(24차): "…2.80% 조정"·"조정세"는 내림 말("목표가 상향 조정"은 아님) · 우선주는 기사 속 보통주 이름으로 방향(화면 "왜 움직였나") · 봇과 화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const why = appJs.slice(appJs.indexOf('function keyDiscToday('), appJs.indexOf('function tileHtml('));
  const ctx = { state: { analysis: {}, news: {}, disc: {} }, kstYmd: (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '') };
  const f = vm.runInNewContext(`${block}\n${why}; ({ pickReasonNews, whyOf })`, ctx);
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const it = (title, tone = 'neutral', h = 14) => ({ title, pubMs: T(`2026-11-05T${h}:00:00+09:00`), sentiment: { tone } });
  const pick = (list, pct, names = []) => {
    const a = src.pickReasonNews(list, pct, '20261105', kst, names), b = f.pickReasonNews(list, pct, '20261105', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택');
    return a ? a.title : null;
  };
  // 실제 제목(11/05) — LG전자우 -2.71%: '성장 기대' 호재 태그여도 '2.80% 조정'은 내린 기사
  const adj = it('LG전자 14만2200원…전장·냉각 성장 기대 속 2.80% 조정', 'pos');
  assert.equal(pick([adj, it('LG전자 주가, 11월 5일 142,800원 2.39% 하락')], -2.71, ['LG전자우', 'LG전자']), adj.title, "'…% 조정'은 내림 말");
  assert.equal(pick([it('반도체주 조정세 이어져')], -2), '반도체주 조정세 이어져');
  assert.equal(pick([it('삼성전자 목표가 상향 조정', 'pos')], -2), null, "'목표가 상향 조정'은 내림 말 아님 — 내린 날 호재 기사는 이유 아님");
  // 우선주 — 이름 바로 뒤 말로 방향(보통주 이름으로)
  const q = { code: '005935', name: '삼성전자우', market: 'KR', ok: true, changePct: -3.1, asOf: new Date().toISOString() };
  ctx.state.news['005935'] = { items: [it('반도체 업황 점검', 'neutral', 15), it('[특징주] 삼성전자 하락, SK하이닉스 상승', 'neutral', 13)] };
  assert.equal(f.whyOf(q).text, '[특징주] 삼성전자 하락, SK하이닉스 상승', '보통주 이름 뒤 내림 말 → 같은 방향 기사가 먼저');
});
await test('이유 고르기(23차): 물음표로 끝나는 제목은 맨 뒤 · 제목 꼬리(" : 경제")는 떼고 판단 · 시장 따라 종목은 같은 방향 기사가 아니면 시장 흐름 · 봇과 화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ pickReasonNews, preferMarket })`, {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const it = (title, tone = 'neutral') => ({ title, pubMs: T('2026-11-05T14:00:00+09:00'), sentiment: { tone } });
  const pick = (list, pct, names = []) => {
    const a = src.pickReasonNews(list, pct, '20261105', kst, names), b = f.pickReasonNews(list, pct, '20261105', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택');
    return a ? a.title : null;
  };
  // 실제 제목(11/05) — 물음표 제목은 원인을 말하지 않는다
  const other = it('반도체 업황 둔화 우려 확산');
  for (const t of ['SK하이닉스 주가가 오늘 급락한 이유는?', 'NVIDIA (NASDAQ:NVDA) Stock Falls 3.2% - Time to Sell?', '삼성전자, 하락 이어갈까', '반도체주 하락 멈출까? : 경제']) {
    assert.equal(pick([it(t), other], -3), other.title, t);
  }
  assert.equal(pick([it('SK하이닉스 주가가 오늘 급락한 이유는?')], -9.46), 'SK하이닉스 주가가 오늘 급락한 이유는?', '그것뿐이면 그것');
  // 번호 붙은 연재·기획 기사(25차)
  for (const t of ['[한화에어로 해부⑤] 美 법인에 9964억 보증… 부담은 나눠도 책임은 연대', '[전자 3형제 경쟁 공식①] 삼성전자 우상향·LG전자 상고하저']) assert.equal(pick([it(t), other], -3), other.title, t);
  assert.equal(pick([it('[단독] 한화에어로, 美 법인 보증 확대'), other], -3), '[단독] 한화에어로, 美 법인 보증 확대', '번호 없는 꼭지([단독])는 그대로');
  // 종목 추천·리포트·전망 칼럼 꼭지(26차) — 앞이든 끝이든. 실제 11/05 한화솔루션 -5%: 칼럼보다 '목표주가 하향' 기사
  const col = it('단기 부진일뿐 방향성은 여전....“한화솔루션 4만원” [오늘, 이 종목]', 'neg'), cut = it('한화솔루션 주가 3.21% 하락…목표주가 3만3,000원 하향, 2027년 실적 반등 가능성은', 'neg');
  assert.equal(pick([col, cut], -5, ['한화솔루션']), cut.title, '칼럼 꼭지는 맨 뒤');
  assert.equal(pick([col], -5, ['한화솔루션']), col.title, '그것뿐이면 그것');
  for (const t of ['[버핏 리포트] 한화솔루션, 4Q 영업익 640억 전망...美 태양광 판가 개선은 내년부터 - iM', '‘반도체 급락’에 고수는 삼성전자 팔고 삼성전기·한국콜마 담았다 [주식 초고수는 지금]',
    '[ls일렉트릭 주가전망] 세력 원가 구간 터질 수밖에 없는 이유', '[클릭 e종목]삼성전기, 기판 업황 둔화 반영해 눈높이 낮춰']) assert.equal(pick([it(t), other], -3), other.title, t);
  for (const t of ["삼성전자, 3개월 만에 장중 '20만전자' 붕괴…8% 급락[핫종목]", '효성중공업 10%대 급락…전력기기주 일제히 약세 [종목NOW]']) assert.equal(pick([it(t), other], -3), t, `사실을 전하는 꼭지는 그대로: ${t}`);
  // 시장 따라 — 같은 방향 기사만 종목 이유로, 방향 모를 기사·나열 기사는 시장 흐름
  const q = { name: '현대건설', changePct: -5.02 }, vs = { follows: true };
  const news = (title, tone) => ({ src: '뉴스', text: title, item: it(title, tone) });
  assert.equal(f.preferMarket(q, news('현대건설, AI·빅데이터 기반 품질관리 시스템 고도화'), vs), true, '방향 모를 기사 → 시장 흐름');
  assert.equal(f.preferMarket(q, news('현대건설, 해외 수주 지연에 하락'), vs), false, '같은 방향 기사는 종목 이유');
  assert.equal(f.preferMarket(q, news('현대건설, 원전 수주 기대에 급락 마감?'), vs), true, '물음표 제목 → 시장 흐름');
  assert.equal(f.preferMarket(q, news('현대건설, 해외 수주 지연에 하락'), { follows: false }), false, '시장 따라가 아니면 그대로');
  assert.equal(f.preferMarket(q, { src: 'AI', text: 'x' }, vs), false, 'AI 진단은 그대로');
  assert.equal(f.preferMarket(q, { src: '뉴스', text: '현대건설 하락' }, vs), true, '기사 정보가 없으면 시장 흐름');
});
await test('이유(23차): 정정·자회사 공시는 맞는 뉴스가 없을 때만 — 화면 "왜 움직였나"(그날 다른 주요 공시가 있으면 그것 먼저)', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const why = appJs.slice(appJs.indexOf('function keyDiscToday('), appJs.indexOf('function tileHtml('));
  const kstYmd = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const today = kstYmd(Date.now());
  const ctx = { state: { analysis: {}, news: {}, disc: {} }, kstYmd };
  const f = vm.runInNewContext(`${block}\n${why}; ({ whyOf })`, ctx);
  const q = { code: 'A', name: '가나', market: 'KR', ok: true, changePct: -15.3, asOf: new Date().toISOString() };
  const minor = { key: true, date: today, tag: 'M&A', title: '[기재정정]타법인주식및출자증권취득결정' };
  const sub = { key: true, date: today, tag: 'M&A', title: '영업양도결정(종속회사의주요경영사항)' };
  const real = { key: true, date: today, tag: '실적', title: '연결재무제표기준영업(잠정)실적(공정공시)' }; // 방향을 모르는 공시(30차 — 내린 날의 공급계약 체결은 이유 아님)
  ctx.state.disc.A = { items: [minor] };
  ctx.state.news.A = { items: [{ title: '가나, 반도체주 폭락에 급락', pubMs: Date.now() - 600e3 }] };
  assert.deepEqual([f.whyOf(q).src, f.whyOf(q).text], ['뉴스', '가나, 반도체주 폭락에 급락'], '정정 공시보다 맞는 뉴스');
  ctx.state.disc.A = { items: [sub] };
  assert.equal(f.whyOf(q).src, '뉴스', '자회사 공시보다 맞는 뉴스');
  ctx.state.news.A = { items: [] };
  assert.equal(f.whyOf(q).text, '[M&A] 영업양도결정(종속회사의주요경영사항)', '맞는 뉴스가 없으면 그 공시');
  ctx.state.disc.A = { items: [minor, real] };
  ctx.state.news.A = { items: [{ title: '가나, 반도체주 폭락에 급락', pubMs: Date.now() - 600e3 }] };
  assert.equal(f.whyOf(q).text, '[실적] 연결재무제표기준영업(잠정)실적(공정공시)', '그날 다른 주요 공시가 있으면 그 공시가 먼저');
});
await test('뉴스 시각(30차): 봇이 적는 글자는 서버 시간대(깃허브 UTC)여도 한국 시각 · 화면은 발행 시각으로(오늘 HH:MM · 그 밖 M/D HH:MM) · 발행 시각을 모르면 봇 글자', async () => {
  const zone = process.env.TZ, sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = 'UTC'; // 깃허브 서버와 같은 시간대 — 예전엔 여기서 9시간 이른 글자가 찍혔다(11/06 13:46 기사 → '오전 04:46')
  try {
    const root = workspace();
    await pipeline(root, { krAt: NOW_KR });
    const it = read(root, 'news.json')['005930'].items[0];
    const kst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(it.pubMs);
    assert.equal(it.time, kst, '한국 시각 글자');
  } finally { process.env.TZ = zone ?? sys; } // TZ를 지우기만 하면 시간대가 돌아오지 않아 원래 값으로 되돌린다
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const top = appJs.slice(appJs.indexOf('function newsTime('), appJs.indexOf('\n', appJs.indexOf('function extLink(')));
  const rn = appJs.slice(appJs.indexOf('function renderNews('), appJs.indexOf('// ---------- 루프'));
  const el = { innerHTML: '' };
  const f = vm.runInNewContext(top + '\n' + rn + '; ({ newsTime, renderNews })', { document: { getElementById: () => el }, location: { href: 'https://rok-ljm.github.io/' }, MOVER_THRESHOLD: 3, URL });
  const hm = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const now = Date.now();
  assert.equal(f.newsTime({ pubMs: now, time: '11. 06. 오전 04:46' }), hm(now), '오늘이면 시각만(봇 글자는 안 씀)');
  const old = now - 3 * 86400e3, d = new Date(old);
  assert.equal(f.newsTime({ pubMs: old }), (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm(old), '그 밖은 월/일 시각');
  assert.equal(f.newsTime({ time: '10. 21. 오후 03:00' }), '10. 21. 오후 03:00', '발행 시각이 없으면 봇 글자(예전 데이터)');
  assert.equal(f.newsTime({ pubMs: null }), '', '둘 다 없으면 빈칸');
  f.renderNews({ code: '005930', changePct: 1 }, { items: [{ title: '기사', source: '연합', time: '11. 06. 오전 04:46', pubMs: now, link: 'https://news.example.com/1' }] });
  assert.ok(el.innerHTML.includes('연합 ' + hm(now)) && !el.innerHTML.includes('오전 04:46'), '카드 뉴스 줄은 발행 시각으로 — ' + el.innerHTML);
});
await test('AI 입력(30차): 종목 분석에 시장 흐름(같은 시장 지수·그날 시장 조치·시장 대비)·거래일·기사 날짜 · 분석에 mkt(화면 근거 "시장·") · 상장 시장을 모르거나 개장 전 지수면 시장 줄 없음 · 지수 핵심 이유에도 기사 날짜', async () => {
  const textOf = (b) => { try { return JSON.parse(b).contents[0].parts[0].text; } catch { return ''; } };
  const bodyOf = (name) => textOf(NET.bodies.find((b, i) => isGemini(NET.calls[i]) && b.includes("'" + name + "'")) || '');
  const briefOf = () => textOf(NET.bodies.find((b, i) => isGemini(NET.calls[i]) && b.includes('뉴스 목록:')) || '');
  const kstMd = (ms) => { const d = new Date(ms + 9 * 3600e3); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
  const list = { v: 2, kr: [['005930', '삼성전자', 'KOSPI', 1], ['000660', 'SK하이닉스', 'KOSPI', 2]], us: [['AAPL', '애플', 'Apple Inc.', 'NASDAQ', 1]], meta: {} };
  const root = workspace();
  writeData(root, 'stocklist.json', list);
  // 그날 09:05 서킷브레이커(직전 회차 기록)
  writeData(root, 'quotes.json', { quotes: [], measures: { day: '2026-10-15', v: src.MEASURES_V, items: [{ kind: 'cb', mk: 'KOSPI', at: '2026-10-15T00:05:00.000Z' }] } });
  await pipeline(root, { krAt: NOW_KR, usPct: { AAPL: 3 } });
  const kr = bodyOf('삼성전자'), us = bodyOf('애플');
  assert.ok(kr.includes('오늘 등락(10/15 거래일): 4.20%'), kr.slice(0, 700));
  assert.ok(kr.includes('\n시장: 코스피 -1.20% (오늘 서킷브레이커 09:05) — 이 종목은 시장 대비 +5.40%p\n'), kr.slice(0, 700));
  assert.ok(kr.includes('시장 전체가 크게 움직인 날이다') && kr.includes('시장·뉴스·수급·추세를 서로 연결'), kr.slice(0, 1600));
  assert.ok(kr.includes('\n1. [' + kstMd(Date.now() - 3600e3) + '] '), '기사 앞에 한국 날짜 — ' + kr.slice(0, 900));
  assert.ok(/\n시장: 나스닥 [+-]\d+\.\d{2}% — 이 종목은 시장 대비 [+-]\d+\.\d{2}%p\n/.test(us) && !us.includes('서킷브레이커'), us.slice(0, 700));
  assert.equal(read(root, 'analysis.json')['005930'].mkt, '코스피');
  assert.equal(read(root, 'analysis.json').AAPL.mkt, '나스닥');
  const brief = briefOf();
  assert.ok(brief.includes('오늘(10/15) 코스피이(가)') && brief.includes('\n1. [' + kstMd(Date.now() - 3600e3) + '] ') && brief.includes('제목 앞 [월/일]은 기사 날짜다'), brief.slice(0, 500));
  // 상장 시장을 모르면(검색 목록 없음) 시장 줄·mkt 없음
  const plain = workspace();
  await pipeline(plain, { krAt: NOW_KR });
  assert.ok(bodyOf('삼성전자') && !bodyOf('삼성전자').includes('\n시장: ') && !('mkt' in read(plain, 'analysis.json')['005930']), '상장 시장 모름 → 시장 줄 없음');
  // 개장 전(예상 지수)과는 비교하지 않음
  const pre = workspace();
  writeData(pre, 'stocklist.json', list);
  await pipeline(pre, { krAt: NOW_KR, idxStatus: 'PREOPEN' });
  assert.ok(bodyOf('삼성전자') && !bodyOf('삼성전자').includes('\n시장: '), '예상 지수와는 비교하지 않음');
  // 지수가 1% 안쪽이면 시장 줄만(나눠 보라는 말 없음)
  const calm = workspace();
  writeData(calm, 'stocklist.json', list);
  await pipeline(calm, { krAt: NOW_KR, idxPct: 0.4 });
  assert.ok(bodyOf('삼성전자').includes('\n시장: 코스피 +0.40% — 이 종목은 시장 대비 +3.80%p\n') && !bodyOf('삼성전자').includes('시장 전체가 크게 움직인 날이다'), bodyOf('삼성전자').slice(0, 700));
  // 화면 면책 문구의 근거 — mkt가 있으면 앞에 '시장'
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const mo = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('\n', appJs.indexOf('function marketOf(')));
  const g = vm.runInNewContext(mo + '\n' + appJs.slice(appJs.indexOf('function basisOf('), appJs.indexOf('// ---------- 지난 급등락')) + '; ({ basisOf })', {});
  const krQ = { market: 'KR' }, usQ = { market: 'US' };
  assert.deepEqual([g.basisOf(krQ, { mkt: '코스피', sig: 'x|d:1' }), g.basisOf(krQ, { sig: 'x' }), g.basisOf(usQ, { mkt: '나스닥' }), g.basisOf(usQ, {})],
    ['시장·뉴스·공시·수급·추세', '뉴스·수급·추세', '시장·뉴스·추세', '뉴스·추세']);
});
await test('이유(30차): 오늘 움직임과 방향이 반대인 공시(내린 날의 공급계약 체결·자기주식 취득, 오른 날의 유상증자)는 "왜 움직였나" 이유에서 뺌 · 칸의 오늘 주요 공시 점은 그대로 · 공시 방향 규칙 봇·화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const why = appJs.slice(appJs.indexOf('function keyDiscToday('), appJs.indexOf('function tileHtml('));
  const kstYmd = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const today = kstYmd(Date.now());
  const ctx = { state: { analysis: {}, news: {}, disc: {} }, kstYmd };
  const f = vm.runInNewContext(block + '\n' + why + '; ({ whyOf, keyDiscToday, discDir })', ctx);
  // 공시 방향 — 실제 전자공시 제목
  const dirs = [['단일판매ㆍ공급계약체결', 1], ['[기재정정]단일판매ㆍ공급계약체결', 1], ['단일판매ㆍ공급계약해지', -1], ['주요사항보고서(자기주식취득결정)', 1], ['자기주식취득결과보고서', 1],
    ['주식소각결정', 1], ['무상증자결정', 1], ['현금ㆍ현물배당결정', 1], ['유상증자결정', -1], ['유무상증자결정', 0], ['전환사채권발행결정', -1], ['신주인수권부사채권발행결정', -1],
    ['자기주식처분결정', -1], ['자기주식취득신탁계약해지결정', -1], ['불성실공시법인지정', -1], ['횡령ㆍ배임혐의발생', -1],
    ['연결재무제표기준영업(잠정)실적(공정공시)', 0], ['현금ㆍ현물배당을위한주주명부폐쇄(기준일)결정', 0], ['타법인주식및출자증권취득결정', 0], ['풍문또는보도에대한해명(미확정)', 0], ['기업설명회(IR)개최(안내공시)', 0]];
  for (const [t, d] of dirs) { assert.equal(dartm.discDir(t), d, '봇: ' + t); assert.equal(f.discDir(t), d, '화면: ' + t); }
  const q = (pct) => ({ code: 'A', name: '가나', market: 'KR', ok: true, changePct: pct, asOf: new Date().toISOString() });
  const contract = { key: true, date: today, tag: '계약', title: '단일판매ㆍ공급계약체결' };
  const rights = { key: true, date: today, tag: '증자·사채', title: '유상증자결정' };
  // 실제 11/06 파두 -10.27%: 이유로 '[계약] 단일판매ㆍ공급계약체결'이 붙었다
  ctx.state.disc.A = { items: [contract] };
  ctx.state.news.A = { items: [{ title: '가나, 반도체주 폭락에 급락', pubMs: Date.now() - 600e3 }] };
  assert.deepEqual([f.whyOf(q(-10.27)).src, f.whyOf(q(-10.27)).text], ['뉴스', '가나, 반도체주 폭락에 급락'], '내린 날의 공급계약 체결은 이유 아님 → 뉴스');
  ctx.state.news.A = { items: [] };
  assert.equal(f.whyOf(q(-10.27)), null, '맞는 뉴스도 없으면 이유 없음(끝에라도 쓰지 않음)');
  assert.equal(f.keyDiscToday('A')?.title, '단일판매ㆍ공급계약체결', "칸의 '오늘 주요 공시' 점은 방향과 무관");
  assert.equal(f.whyOf(q(6)).text, '[계약] 단일판매ㆍ공급계약체결', '오른 날엔 그 공시가 이유');
  ctx.state.disc.A = { items: [contract, rights] };
  assert.equal(f.whyOf(q(-8)).text, '[증자·사채] 유상증자결정', '같은 날 방향이 맞는 공시가 있으면 그것');
  assert.equal(f.whyOf(q(8)).text, '[계약] 단일판매ㆍ공급계약체결', '오른 날엔 유상증자를 건너뜀');
  // 뉴스 이유가 그 종목 거래일 기사가 아니면 기사 날짜(실제 11/06 파두 -9.86%에 11/05 '파두 4.90% 하락…' 기사)
  ctx.state.disc.A = { items: [] };
  const y = Date.now() - 86400e3 - 600e3, kd = new Date(y + 9 * 3600e3);
  ctx.state.news.A = { items: [{ title: '가나 4.90% 하락…신규 수주 이행 점검', pubMs: y }] };
  assert.deepEqual([f.whyOf(q(-9.86)).text, f.whyOf(q(-9.86)).day], ['가나 4.90% 하락…신규 수주 이행 점검', (kd.getUTCMonth() + 1) + '/' + kd.getUTCDate()], '거래일 전 기사엔 날짜');
  ctx.state.news.A = { items: [{ title: '가나, 반도체주 폭락에 급락', pubMs: Date.now() - 60e3 }] };
  assert.equal(f.whyOf(q(-9.86)).day, undefined, '그날 기사엔 날짜 없음');
});
await test('급등락 기록(30차): 그날 움직임과 방향이 반대인 공시는 이유가 아님(내린 날의 공급계약 체결 → 뉴스) · 방향이 맞는 공시는 그대로 · 예전에 남긴 반대 방향 공시 이유는 바꿈', async () => {
  await withDartKey(async () => {
    const item = (t) => '<item><title>' + t + ' - 테스트일보</title><link>https://news.example.com/1</link><pubDate>' + new Date(Date.now() - 600e3).toUTCString() + '</pubDate><source url="https://news.example.com">테스트일보</source></item>';
    const downNews = (m, u) => text('<?xml version="1.0"?><rss><channel>' + item(queryName(u) + ', 반도체 업황 우려에 급락') + '</channel></rss>');
    const base = { gemini: () => text('upstream error', 500), krAt: NOW_KR, krPct: { '005930': -4.2, '000660': 0.3 }, news: downNews };
    const contract = { ...DART_ROWS, '00126380': [['20261015000321', '단일판매ㆍ공급계약체결']] };
    const root = workspace();
    await pipeline(root, { ...base, dartRows: contract });
    assert.deepEqual(read(root, 'moves.json')['005930'][0], { d: '20261015', p: -4.2, r: '삼성전자, 반도체 업황 우려에 급락', s: 'news' }, '내린 날의 공급계약 체결 대신 뉴스');
    const r2 = workspace();
    await pipeline(r2, { ...base, dartRows: { ...DART_ROWS, '00126380': [['20261015000400', '유상증자결정'], ['20261015000321', '단일판매ㆍ공급계약체결']] } });
    assert.deepEqual(read(r2, 'moves.json')['005930'][0], { d: '20261015', p: -4.2, r: '[증자·사채] 유상증자결정', s: 'disc' }, '방향이 맞는 공시는 뉴스보다 먼저');
    const r3 = workspace();
    writeData(r3, 'moves.json', { '005930': [{ d: '20261015', p: -3, r: '[계약] 단일판매ㆍ공급계약체결', s: 'disc' }] });
    await pipeline(r3, { ...base, dartRows: contract });
    assert.deepEqual(read(r3, 'moves.json')['005930'][0], { d: '20261015', p: -4.2, r: '삼성전자, 반도체 업황 우려에 급락', s: 'news' }, '예전 규칙으로 남긴 반대 방향 공시 이유 → 뉴스로');
  });
});
await test('이유 고르기(21차): 주가 전망·기술적 분석 글(지지선·저항선·과매도·RSI·기술적 분석·횡보·…할 수 있을까?·…지속될까?)은 맨 뒤 — 그것뿐이면 그것 · 봇과 화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ pickReasonNews })`, {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const at = (h) => T(`2026-10-23T${String(h).padStart(2, '0')}:00:00+09:00`);
  const it = (title, h, tone = 'neutral') => ({ title, pubMs: at(h), sentiment: { label: { pos: '호재', neg: '악재', neutral: '중립' }[tone], tone } });
  const pick = (list, pct, names = []) => {
    const a = src.pickReasonNews(list, pct, '20261023', kst, names), b = f.pickReasonNews(list, pct, '20261023', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택');
    return a ? a.title : null;
  };
  // 실제 제목(2026-10-23, 자동 생성 해설 사이트) — LG에너지솔루션 -2.05%
  const spec = it('과매도 신호가 나타나는 가운데 LG에너지솔루션 주가는 ₩370,322 지지선을 지킬 수 있을까?', 15, 'neg');
  const real = it('LG에너지솔루션, 북미 ESS 수주 지연 우려', 9);
  assert.equal(pick([spec, real], -2.05, ['LG에너지솔루션']), real.title, '더 최근의 같은 방향 전망 글보다 원인 기사');
  assert.equal(pick([spec], -2.05, ['LG에너지솔루션']), spec.title, '그것뿐이면 그것');
  // 실제 제목(10/16~10/23) — 오른 날, 같은 방향 말이 있어도 맨 뒤
  for (const t of ['과매도 RSI가 반전 가능성을 시사하면서 한화에어로스페이스 주가 상승', '삼성전자 주식 기술적 분석: 매수세 우위로 상승했지만 저항선에 근접',
    '두산에너빌리티, 경상남도와 제조 역량 확대: 034020의 상승세는 지속될까?', '레벨 4 자율주행 트럭 테스트가 미래 혁신을 부각시키는 가운데 현대차 주가 횡보',
    '삼성전자, 강세 이어갈까?']) {
    const other = it('반도체 업황 회복 기대감 확산', 9);
    assert.equal(pick([it(t, 15), other], 2.5), other.title, t);
  }
  assert.equal(pick([it('삼성전자, HBM4 엔비디아 공급 확정…주가 강세', 15), it('반도체 업황 회복 기대감 확산', 9)], 2.5), '삼성전자, HBM4 엔비디아 공급 확정…주가 강세', '보통 기사는 그대로');
});
await test('이유 고르기(18차): 방향 말이 없으면 호재·악재 태그로 — 내린 날 호재 기사 제외 · "~에도"는 태그로 짐작 안 함 · 같은 방향 기사 먼저 · 리포트 요약은 맨 뒤(내린 날엔 나쁜 말 없으면 제외) · 봇과 화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ pickReasonNews })`, {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const at = (h) => T(`2026-10-22T${String(h).padStart(2, '0')}:00:00+09:00`);
  const it = (title, h, tone = 'neutral') => ({ title, pubMs: at(h), sentiment: { label: { pos: '호재', neg: '악재', neutral: '중립' }[tone], tone } });
  const pick = (list, pct, names = []) => {
    const a = src.pickReasonNews(list, pct, '20261022', kst, names), b = f.pickReasonNews(list, pct, '20261022', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택');
    return a ? a.title : null;
  };
  // 실제 제목(2026-10-22) — LG전자우 -3.62%
  const good = it('LG전자, 스마트팩토리 사업 공공 인프라로 확대…2년 만에 수주 1조 돌파', 14, 'pos');
  const plain = it("LG전자, 수자원공사와 맞손…시화조력발전소에 'AI' 심는다", 12);
  assert.equal(pick([good, plain], -3.62, ['LG전자']), plain.title, '내린 날: 방향 말 없는 호재 기사는 이유 아님');
  assert.equal(pick([good], -3.62, ['LG전자']), null, '그것뿐이면 이유 없음');
  assert.equal(pick([plain, good], 3.62, ['LG전자']), good.title, '오른 날: 같은 방향(호재) 기사를 더 최근의 중립 기사보다 먼저');
  // 현대차 -3.55% — 더 최근의 중립 기사보다 '추락' 기사
  const ai = it('현대차그룹, AI 인프라 확충…2029년 새만금서 GPU 1만장 운영 추진', 14);
  const fall = it('78만원 갔던 현대차, 28만원까지 추락…피지컬 AI ETF도 최대 59%↓', 9);
  assert.equal(pick([ai, fall], -3.55, ['현대차']), fall.title, '같은 방향 기사 먼저');
  // '~에도'가 있으면 호재 태그로 방향을 짐작하지 않는다
  const despite = it('SK하이닉스, 사상 최대 실적에도 차익실현 매물', 13, 'pos');
  assert.equal(pick([despite], -3.2, ['SK하이닉스']), despite.title, "'실적에도' — 호재 태그여도 내린 날 이유로 남김");
  // 리포트 요약 — 심텍 -5.32%
  const rep = it("[리포트 브리핑]심텍, '순항 중인 성과 속 제한적인 외부 영향' 목표가 180,000원 - 교보증권", 14);
  const pcb = it('AI 시대 핵심 부품 PCB… 대덕전자·심텍·이수페타시스 노려라', 10);
  assert.equal(pick([rep], -5.32, ['심텍']), null, '내린 날: 나쁜 말 없는 리포트 요약은 이유 아님');
  assert.equal(pick([rep, pcb], -5.32, ['심텍']), pcb.title);
  assert.equal(pick([rep, pcb], 5.32, ['심텍']), pcb.title, '오른 날에도 리포트 요약은 맨 뒤');
  const rep2 = it('심텍, 기판 수요 견조…목표가 180,000원 유지-교보', 14);
  assert.equal(pick([rep2, pcb], 5.32, ['심텍']), pcb.title, "대괄호 꼭지 없는 리포트 요약('목표가 N원')도 맨 뒤");
  assert.equal(pick([rep], 5.32, ['심텍']), rep.title, '오른 날 리포트 요약밖에 없으면 그것');
  const cut = it("[리포트 브리핑]심텍, '수요 둔화' 목표가 150,000원으로 하향 - 교보증권", 13, 'neg');
  assert.equal(pick([cut], -5.32, ['심텍']), cut.title, '나쁜 말(하향) 리포트는 내린 날 이유로');
  // 제목의 오름·내림 말이 태그보다 먼저 — 호재 태그인 '…소식에도 하락' [특징주]는 내린 날 맨 앞
  const feat = it("[특징주] 삼성전기, 엔비디아와 파트너십 구축 소식에도 '하락'", 11, 'pos');
  assert.equal(pick([plain, feat], -2.83, ['삼성전기']), feat.title);
});
await test('시장 대비(app.js): 국내 코스피·코스닥 · 미국 나스닥 상장은 나스닥 · 그 밖은 S&P 500 · 시장 따라(같은 방향·1%p 안쪽·지수 1% 이상) · 모르면 비교 안 함', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ vsMarket })`, {});
  const idx = [{ symbol: '^KS11', changePct: -1.97 }, { symbol: '^KQ11', changePct: -1.85 }, { symbol: '^GSPC', changePct: 0.58 }, { symbol: '^IXIC', changePct: 1.05 }];
  const v = (q) => { const r = f.vsMarket({ ok: true, ...q }, idx); return r ? JSON.parse(JSON.stringify(r)) : null; };
  assert.deepEqual(v({ market: 'KR', exch: 'KOSPI', changePct: -2.5 }), { sym: '^KS11', name: '코스피', pct: -1.97, diff: -0.53, follows: true, within: true });
  assert.deepEqual(v({ market: 'KR', exch: 'KOSDAQ', changePct: 3 }), { sym: '^KQ11', name: '코스닥', pct: -1.85, diff: 4.85, follows: false, within: false });
  assert.deepEqual(v({ market: 'US', exch: 'NASDAQ', changePct: 2.54 }), { sym: '^IXIC', name: '나스닥', pct: 1.05, diff: 1.49, follows: false, within: false }, '1%p 넘게 차이');
  assert.equal(v({ market: 'US', exch: 'NYSE', changePct: 0.9 }).follows, false, '지수가 1% 안 움직인 날은 시장 따라 아님');
  assert.equal(v({ market: 'US', exch: 'NYSE', changePct: 0.9 }).name, 'S&P 500');
  assert.equal(v({ market: 'US', exch: 'NASDAQ ETF', changePct: 1 }).name, '나스닥');
  assert.equal(v({ market: 'KR', exch: 'KOSPI', changePct: 2.5 }).follows, false, '반대 방향');
  assert.equal(v({ market: 'KR', changePct: -2.5 }), null, '상장 시장을 모르면 비교 안 함');
  assert.equal(f.vsMarket({ ok: false, market: 'KR', exch: 'KOSPI', changePct: -2 }, idx), null);
  assert.equal(f.vsMarket({ ok: true, market: 'KR', exch: 'KOSPI', changePct: -2 }, [{ symbol: '^KQ11', changePct: -1 }]), null, '그 지수가 없으면 비교 안 함');
});
await test('이유(31차): 시장보다 덜 움직인 종목도 방향 모를 기사뿐이면 시장 흐름("왜 움직였나" 이유 칸 whyCell) · 시장 따라 표시는 1%p 안쪽만 · 사회공헌 기사는 이유에서 뺌(봇·화면 같음) · 영어 활용형 방향 낱말', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const fmt = appJs.slice(appJs.indexOf('function fmtPct('), appJs.indexOf('function dirClass('));
  const escFn = appJs.slice(appJs.indexOf('function esc('), appJs.indexOf('\n', appJs.indexOf('function esc(')));
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const why = appJs.slice(appJs.indexOf('function keyDiscToday('), appJs.indexOf('function tileHtml('));
  const kstYmd = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const ctx = { state: { analysis: {}, news: {}, disc: {} }, kstYmd };
  const f = vm.runInNewContext(fmt + '\n' + escFn + '\n' + block + '\n' + why + '; ({ whyCell, vsMarket, pickReasonNews })', ctx);
  const idx = [{ symbol: '^KS11', changePct: -6.19 }];
  const q = (pct) => ({ code: 'B', name: 'HD건설기계', market: 'KR', exch: 'KOSPI', ok: true, changePct: pct, asOf: new Date().toISOString() });
  const cell = (pct) => f.whyCell(q(pct), f.vsMarket(q(pct), idx));
  const news = (title, pubMs = Date.now() - 600e3) => { ctx.state.news.B = { items: title ? [{ title, pubMs }] : [] }; };
  // 실제 11/06 HD건설기계 -3.98%(코스피 -6.19%) — '김장 김치 2500박스 이웃에 전달'이 이유로 붙었다
  news('HD건설기계·HD현대사이트솔루션, 김장 김치 2500박스 이웃에 전달');
  assert.ok(cell(-3.98).includes('코스피 -6.19% 흐름 — 종목만의 이유 기사 없음') && !cell(-3.98).includes('시장 따라'), cell(-3.98));
  news('HD건설기계, 굴착기 신모델 공개');
  assert.ok(cell(-3.98).includes('흐름 — 종목만의 이유 기사 없음'), '시장보다 덜 움직였는데 방향 모를 기사 → 시장 흐름');
  assert.ok(cell(-7.5).includes('굴착기 신모델 공개'), '시장보다 1%p 넘게 더 움직였으면 그대로');
  news('HD건설기계, 수요 둔화 우려에 하락');
  assert.ok(cell(-3.98).includes('HD건설기계, 수요 둔화 우려에 하락'), '같은 방향 기사는 그대로');
  news('');
  assert.ok(cell(-3.98).includes('흐름 — 종목만의 이유 기사 없음'), '이유가 없어도 시장보다 덜 움직였으면 시장 흐름');
  assert.ok(cell(-7.5).includes('아직 이유 정보가 없어요'), '더 움직였는데 이유 없음');
  assert.ok(cell(-6.5).startsWith('<span class="src mkt"') && cell(-6.5).includes('시장 따라'), "1%p 안쪽이면 '시장 따라' 표시");
  // 지난 기사 날짜(30차)는 이유 칸에
  const y = Date.now() - 86400e3 - 600e3, kd = new Date(y + 9 * 3600e3);
  news('HD건설기계, 수요 둔화 우려에 하락', y);
  assert.ok(cell(-7.5).includes('<span class="muted">' + (kd.getUTCMonth() + 1) + '/' + kd.getUTCDate() + '</span> HD건설기계, 수요 둔화 우려에 하락'), cell(-7.5));
  // within — 지수 1% 넘게·같은 방향·지수보다 1%p 넘게 더 움직이지 않음
  const w = (pct, ip = -6.19) => f.vsMarket(q(pct), [{ symbol: '^KS11', changePct: ip }]).within;
  assert.deepEqual([w(-3.98), w(-7.0), w(-7.5), w(2.5), w(-2.5, -0.8)], [true, true, false, false, false]);
  // 사회공헌 기사 — 봇·화면 같게 이유에서 뺌
  const it = (title) => ({ title, pubMs: T('2026-11-06T14:00:00+09:00'), sentiment: { tone: 'neutral' } });
  for (const t of ['HD건설기계·HD현대사이트솔루션, 김장 김치 2500박스 이웃에 전달', '삼성전자, 연말 이웃사랑 성금 500억 기탁', 'SK하이닉스 임직원 봉사활동', 'LG전자, 메이저리그 후원 계약']) {
    const list = [it(t), it('반도체 업황 점검')];
    assert.equal(src.pickReasonNews(list, -3, '20261106', kstYmd, []).title, '반도체 업황 점검', '봇: ' + t);
    assert.equal(f.pickReasonNews(list, -3, '20261106', kstYmd, []).title, '반도체 업황 점검', '화면: ' + t);
    assert.equal(src.pickReasonNews([it(t)], -3, '20261106', kstYmd, []), null, '그것뿐이어도 이유 아님(봇): ' + t);
    assert.equal(f.pickReasonNews([it(t)], -3, '20261106', kstYmd, []), null, '그것뿐이어도 이유 아님(화면): ' + t);
  }
  // 영어 활용형 — 실제 11/05~06 미국 종목 기사(예전엔 중립)
  const tone = (t) => src.tagSentiment(t).tone;
  for (const t of ['Super Micro Computer (SMCI) Stock Sinks After Q1 Results Expose Cash Strain', 'NVDA: Nvidia Stock Slides Below $200 After 9% Rout',
    "Why Shares of Elon Musk's Tesla, SpaceX Are Sliding After the Midterm Elections", 'Amazon.com stock slips as AI spending keeps cash flow in focus',
    'Stock Market Today: Amazon Shares Slide as Technology Selloff Erases Earlier Gains', 'IREN stock plunges 18% as Microsoft raises concerns', 'Microsoft misses estimates']) assert.equal(tone(t), 'neg', t);
  for (const t of ['Tesla stock jumps after deliveries', 'Nvidia shares surged 5% on AI demand', 'Apple stock climbs to record', 'Palantir soars after earnings']) assert.equal(tone(t), 'pos', t);
  for (const t of ['New shipping route opens in Asia', 'Space mission launches', 'Apple unveils new iPad']) assert.equal(tone(t), 'neutral', '낱말 경계: ' + t);
});
await test('급등락 기록(32차): 시장보다 덜 움직인 날은 방향 모를 기사 대신 시장 흐름 이유 · 같은 방향 기사는 그대로 · 시장보다 더 움직였으면 기사 · 예전 약한 기사·시장 흐름 이유 다시 보기 · 화면 지난 급등락은 흐린 글자 · 시세 안내 "…상승 기록" · 영어 전망 글 맨 뒤(봇·화면 같음)', async () => {
  const list = { v: 2, kr: [['005930', '삼성전자', 'KOSPI', 1], ['000660', 'SK하이닉스', 'KOSPI', 2]], us: [['AAPL', '애플', 'Apple Inc.', 'NASDAQ', 1]], meta: {} };
  const item = (t) => '<item><title>' + t + ' - 테스트일보</title><link>https://news.example.com/1</link><pubDate>' + new Date(Date.now() - 600e3).toUTCString() + '</pubDate><source url="https://news.example.com">테스트일보</source></item>';
  const newsOf = (tail) => (m, u) => text('<?xml version="1.0"?><rss><channel>' + (tail ? item(queryName(u) + tail) : '') + '</channel></rss>');
  const base = { gemini: () => text('upstream error', 500), krAt: NOW_KR, idxPct: -6 };
  const mv = (root) => read(root, 'moves.json')['005930'][0];
  const MK = '코스피 -6.00% 흐름 — 종목만의 이유 기사 없음';
  const ws = () => { const r = workspace(); writeData(r, 'stocklist.json', list); return r; };
  const r1 = ws();
  await pipeline(r1, { ...base, krPct: { '005930': -4, '000660': 0.3 }, news: newsOf(', 정기 임원 인사 발표') });
  assert.deepEqual(mv(r1), { d: '20261015', p: -4, r: MK, s: 'mkt' }, '시장보다 덜 움직였는데 방향 모를 기사 → 시장 흐름');
  const r2 = ws();
  await pipeline(r2, { ...base, krPct: { '005930': -4, '000660': 0.3 }, news: newsOf(', 반도체 우려에 하락') });
  assert.deepEqual([mv(r2).s, mv(r2).r], ['news', '삼성전자, 반도체 우려에 하락'], '같은 방향 기사는 그대로');
  const r3 = ws();
  await pipeline(r3, { ...base, krPct: { '005930': -8, '000660': 0.3 }, news: newsOf(', 정기 임원 인사 발표') });
  assert.deepEqual([mv(r3).s, mv(r3).r], ['news', '삼성전자, 정기 임원 인사 발표'], '시장보다 1%p 넘게 더 움직였으면 기사');
  const r4 = ws();
  await pipeline(r4, { ...base, krPct: { '005930': -4, '000660': 0.3 }, news: newsOf('') });
  assert.equal(mv(r4).s, 'mkt', '기사가 없어도 시장보다 덜 움직였으면 시장 흐름');
  const r5 = workspace();
  await pipeline(r5, { ...base, krPct: { '005930': -4, '000660': 0.3 }, news: newsOf('') });
  assert.deepEqual([mv(r5).r, mv(r5).s], ['', ''], '상장 시장을 모르면 시장 흐름 이유 없음');
  const r6 = ws();
  writeData(r6, 'moves.json', { '005930': [{ d: '20261015', p: -3, r: '삼성전자, 정기 임원 인사 발표', s: 'news' }] });
  await pipeline(r6, { ...base, krPct: { '005930': -4, '000660': 0.3 }, news: newsOf('') });
  assert.equal(mv(r6).s, 'mkt', '예전 약한 기사 이유 → 시장 흐름');
  const r7 = ws();
  writeData(r7, 'moves.json', { '005930': [{ d: '20261015', p: -4, r: MK, s: 'mkt' }] });
  await pipeline(r7, { ...base, krPct: { '005930': -8, '000660': 0.3 }, news: newsOf('') });
  assert.deepEqual([mv(r7).r, mv(r7).s], ['', ''], '시장보다 더 움직이게 되면 예전 시장 흐름 이유를 버림');
  // 화면 '지난 급등락' — 시장 흐름 이유는 흐린 글자(출처 표시 없음)
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const line = (k) => appJs.slice(appJs.indexOf(k), appJs.indexOf('\n', appJs.indexOf(k)));
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const rm = appJs.slice(appJs.indexOf('function renderMoves('), appJs.indexOf('// ---------- 최근 공시'));
  const el = { innerHTML: '', hidden: true };
  const g = vm.runInNewContext([line('function dirClass('), line('function cssId('), line('function esc('), line('const MOVE_SRC'), block, rm].join('\n') + '; ({ renderMoves, priceOnly, pickReasonNews })', { document: { getElementById: () => el } });
  g.renderMoves({ code: 'A', market: 'KR', ok: true, asOf: new Date().toISOString() }, [{ d: '20261015', p: -4, r: MK, s: 'mkt' }, { d: '20261014', p: 3, r: '수주 공시', s: 'disc' }]);
  assert.ok(el.innerHTML.includes('<span class="mv-r"><span class="muted">' + MK + '</span></span>') && el.innerHTML.includes('<span class="src">공시</span>수주 공시'), el.innerHTML);
  // 시세 안내 — 끝에 '기록'·'마감'이 붙어도(실제 11/05 OCI홀딩스 급등락 기록 이유)
  for (const t of ['OCI홀딩스 주가, 11월 5일 204,000원 2.00% 상승 기록', 'LG전자 주가, 11월 5일 142,800원 2.39% 하락 마감']) { assert.equal(src.priceOnly(t), true, '봇: ' + t); assert.equal(g.priceOnly(t), true, '화면: ' + t); }
  for (const t of ['삼성SDI 50만8000원으로 6.79%↓…ESS 성장과 조정 압력 교차', 'OCI홀딩스 주가, 11월 5일 204,000원 2.00% 상승 기록 경신에 신고가']) { assert.equal(src.priceOnly(t), false, '봇: ' + t); assert.equal(g.priceOnly(t), false, '화면: ' + t); }
  // 영어 전망 글 — 맨 뒤(실제 11/05 아마존닷컴 급등락 기록 이유 'Amazon.com, Inc. (AMZN) Stock Forecasts')
  const it = (title) => ({ title, pubMs: T('2026-11-05T21:00:00Z'), sentiment: { tone: 'neutral' } });
  const ny = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms).replace(/-/g, '');
  for (const [l, pct, want] of [[[it('Amazon.com, Inc. (AMZN) Stock Forecasts'), it('Amazon expands same-day delivery')], -2.19, 'Amazon expands same-day delivery'],
    [[it('Tesla Stock Price Prediction 2026'), it('Tesla opens new plant')], 3, 'Tesla opens new plant']]) {
    assert.equal(src.pickReasonNews(l, pct, '20261105', ny, []).title, want, '봇');
    assert.equal(g.pickReasonNews(l, pct, '20261105', ny, []).title, want, '화면');
  }
});
await test('급등락 기록(33차): 지난날 기록의 이유도 지금 규칙으로 — 시세 안내·사회공헌·방향이 반대인 뉴스·방향이 반대인 공시는 비움 · 맞는 이유·AI·시장 흐름은 그대로', async () => {
  const root = workspace();
  writeData(root, 'moves.json', { '005930': [
    { d: '20261014', p: 3.25, r: '삼성전자 주가, 10월 14일 204,000원 2.00% 상승 기록', s: 'news' },
    { d: '20261013', p: -3, r: '삼성전자, 김장 김치 2500박스 이웃에 전달', s: 'news' },
    { d: '20261012', p: -4, r: '[계약] 단일판매ㆍ공급계약체결', s: 'disc' },
    { d: '20261011', p: 4, r: '삼성전자, 반도체 우려에 급락', s: 'news' },
    { d: '20261010', p: -2.5, r: '삼성전자, 반도체 우려에 하락', s: 'news' },
    { d: '20261009', p: -5, r: '[증자·사채] 유상증자결정', s: 'disc' },
    { d: '20261008', p: 6, r: '예전 AI 진단', s: 'ai' },
    { d: '20261007', p: -3, r: '코스피 -4.00% 흐름 — 종목만의 이유 기사 없음', s: 'mkt' },
  ] });
  await pipeline(root, { krAt: NOW_KR });
  const byDay = Object.fromEntries(read(root, 'moves.json')['005930'].map((x) => [x.d, [x.r, x.s]]));
  assert.deepEqual(byDay['20261014'], ['', ''], '시세 안내');
  assert.deepEqual(byDay['20261013'], ['', ''], '사회공헌');
  assert.deepEqual(byDay['20261012'], ['', ''], '내린 날의 공급계약 체결');
  assert.deepEqual(byDay['20261011'], ['', ''], '오른 날의 급락 기사');
  assert.deepEqual(byDay['20261010'], ['삼성전자, 반도체 우려에 하락', 'news'], '맞는 뉴스는 그대로');
  assert.deepEqual(byDay['20261009'], ['[증자·사채] 유상증자결정', 'disc'], '방향이 맞는 공시는 그대로');
  assert.deepEqual(byDay['20261008'], ['예전 AI 진단', 'ai']);
  assert.deepEqual(byDay['20261007'], ['코스피 -4.00% 흐름 — 종목만의 이유 기사 없음', 'mkt']);
  // 다시 돌려도 같은 결과(이미 비운 기록은 그대로)
  const first = raw(root, 'moves.json');
  await pipeline(root, { krAt: NOW_KR + 5 * MIN }, NOW_KR + 5 * MIN);
  assert.deepEqual(JSON.parse(raw(root, 'moves.json'))['005930'].filter((x) => x.d < '20261015'), JSON.parse(first)['005930'].filter((x) => x.d < '20261015'));
  // 오늘 기록이 없는 날(2% 아래)에도 지난 이유를 비우면 파일을 다시 쓴다 — 제자리 고치면 직전 파일과 같아 보여 안 써진다
  const r2 = workspace();
  writeData(r2, 'moves.json', { '005930': [{ d: '20261014', p: 3.25, r: '삼성전자 주가, 10월 14일 204,000원 2.00% 상승 기록', s: 'news' }] });
  await pipeline(r2, { krAt: NOW_KR, krPct: { '005930': 0.4, '000660': 0.3 } });
  assert.deepEqual(read(r2, 'moves.json')['005930'], [{ d: '20261014', p: 3.25, r: '', s: '' }], '오늘 기록 없이 지난 이유만 비워도 씀');
  // 장중에 방향이 뒤집히면(-3%에 남긴 유상증자 이유 → 지금 +4.2%) 그날 공시 이유는 지킬 이유가 아니다 — 지금 등락으로 다시 본다(30차)
  const r3 = workspace();
  writeData(r3, 'moves.json', { '005930': [{ d: '20261015', p: -3, r: '[증자·사채] 유상증자결정', s: 'disc' }] });
  await pipeline(r3, { krAt: NOW_KR, gemini: () => text('upstream error', 500), news: () => text('<?xml version="1.0"?><rss><channel></channel></rss>') });
  assert.deepEqual(read(r3, 'moves.json')['005930'][0], { d: '20261015', p: 4.2, r: '', s: '' }, '방향이 뒤집힌 날의 공시 이유는 버림');
});
await test('국내 정규장 뒤(34차): 지수가 마감이면 상태 마감 · 시간외 체결 전 값에 closeFix · 뒤 회차는 정규장 종가를 지키고 시간외 가격은 ext · 놓쳤으면 야후 일봉 종가 · 지수가 장중(수능일)·개장 전이면 그대로 · 화면 "시간외"', async () => {
  const at = (hm) => T('2026-10-15T' + hm + ':00+09:00');
  const kr = (root) => read(root, 'quotes.json').quotes.find((q) => q.code === '005930');
  const close = { market: 'KR', code: '005930', name: '삼성전자', ok: true, currency: 'KRW', price: 70000, prevClose: 67178, change: 2822, changePct: 4.2, open: 69000, high: 71000, low: 68000, volume: 1234567, marketStatus: 'CLOSE', asOf: '2026-10-15T15:30:00+09:00', closeFix: 1 };
  // ① 종가 뒤 첫 회차(15:30 시각, 시간외 체결 전) — 상태 마감 · closeFix
  const r1 = workspace();
  await pipeline(r1, { idxStatus: 'CLOSE', krAt: at('15:30') });
  assert.deepEqual([kr(r1).marketStatus, kr(r1).closeFix, 'ext' in kr(r1)], ['CLOSE', 1, false]);
  // ② 시간외 체결(17:00 · 71,000원) — 정규장 종가를 지키고 시간외 가격은 ext
  const r2 = workspace();
  writeData(r2, 'quotes.json', { quotes: [close] });
  await pipeline(r2, { idxStatus: 'CLOSE', krAt: at('17:00'), krExtra: { '005930': { closePrice: '71,000' } } });
  const q2 = kr(r2);
  assert.deepEqual([q2.price, q2.changePct, q2.prevClose, q2.volume, q2.asOf, q2.marketStatus, q2.closeFix], [70000, 4.2, 67178, 1234567, close.asOf, 'CLOSE', 1]);
  assert.deepEqual(q2.ext, { session: 'post', price: 71000, change: 1000, changePct: 1.43, at: at('17:00') });
  assert.equal(read(r2, 'moves.json')['005930'][0].p, 4.2, '급등락 기록도 정규장 등락');
  // ③ 종가 회차를 놓쳤으면(배포 직후) 야후 일봉의 그날 종가
  const r3 = workspace();
  writeData(r3, 'quotes.json', { quotes: [{ ...close, closeFix: undefined, price: 70800, asOf: '2026-10-15T17:55:00+09:00' }] });
  writeData(r3, 'history.json', { '005930': { dates: [T('2026-10-14T00:00:00Z'), T('2026-10-15T00:00:00Z')], closes: [67000, 69000] } });
  await pipeline(r3, { idxStatus: 'CLOSE', krAt: at('18:00'), krExtra: { '005930': { closePrice: '71,000' } } });
  const q3 = kr(r3), prev = 71000 - Math.round(70000 * 4.2 / 100);
  assert.deepEqual([q3.price, q3.changePct, q3.asOf, 'closeFix' in q3], [69000, Math.round(((69000 - prev) / prev) * 10000) / 100, '2026-10-15T15:30:00+09:00', false]);
  assert.deepEqual([q3.ext.price, q3.ext.change], [71000, 2000]);
  // ④ 지수가 아직 장중(수능일처럼 늦게 닫는 날 15:35) · 개장 전 시세는 그대로
  const r4 = workspace();
  writeData(r4, 'quotes.json', { quotes: [close] });
  await pipeline(r4, { idxStatus: 'OPEN', krAt: at('15:35'), krExtra: { '005930': { closePrice: '71,000' } } });
  assert.deepEqual([kr(r4).price, kr(r4).marketStatus, 'closeFix' in kr(r4)], [71000, 'OPEN', false]);
  const r5 = workspace();
  await pipeline(r5, { idxStatus: 'CLOSE', krStatus: 'PREOPEN', krAt: at('08:30') });
  assert.deepEqual([kr(r5).marketStatus, 'closeFix' in kr(r5)], ['PREOPEN', false]);
  // 화면 — 국내 ext는 '시간외'(미국은 애프터마켓·프리마켓 그대로)
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const mo = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('\n', appJs.indexOf('function marketOf(')));
  const g = vm.runInNewContext(mo + '\n' + appJs.slice(appJs.indexOf('function extOf('), appJs.indexOf('function extRow(')) + '; ({ extOf })', {});
  const ext = { session: 'post', price: 71000, change: 1000, changePct: 1.43, at: 1 };
  assert.deepEqual([g.extOf({ ok: true, market: 'KR', marketStatus: 'CLOSE', ext }).label, g.extOf({ ok: true, market: 'KR', marketStatus: 'CLOSE', ext }).short], ['시간외', '시간외']);
  assert.deepEqual([g.extOf({ ok: true, market: 'US', marketStatus: 'CLOSE', ext }).label, g.extOf({ ok: true, market: 'US', marketStatus: 'CLOSE', ext: { ...ext, session: 'pre' } }).short], ['애프터마켓', '프리']);
  assert.equal(g.extOf({ ok: true, market: 'KR', marketStatus: 'OPEN', ext }), null, '장중엔 안 보임');
});
await test('개장 전 예상 지수(35차): 08:55 전 값은 어제 종가·0%로 · 08:55부터 예상 · 분위기엔 안 넣음 · 지수 핵심 이유는 지난 장 판단 그대로(AI 안 부름) · 화면 지난 장 핵심', async () => {
  // 순수 함수 — 08:50 동시호가 시작 직후
  const at = (hm) => T('2026-11-09T' + hm + ':00+09:00');
  const pre = { name: '코스피', symbol: '^KS11', currency: 'KRW', price: 3968.4, change: -1110.4, changePct: -21.86, marketStatus: 'PREOPEN' };
  const us = { name: '나스닥', symbol: '^IXIC', currency: 'USD', price: 100, change: 1, changePct: 1.09, marketStatus: 'CLOSE' };
  assert.deepEqual(src.calmExpected([pre, us], at('08:50')), [{ ...pre, price: 5078.8, change: 0, changePct: 0 }, us], '08:55 전 → 어제 종가·0%(미국은 그대로)');
  assert.deepEqual(src.calmExpected([pre, us], at('08:55')), [pre, us], '08:55부터는 예상 그대로');
  assert.deepEqual(src.calmExpected([{ ...pre, marketStatus: 'OPEN' }], at('08:50')), [{ ...pre, marketStatus: 'OPEN' }], '장중 값은 안 건드림');
  // 분위기 — 개장 전 예상 지수는 0%로(실제 11/09 08:50: 43 → 13)
  const m0 = src.computeMood([{ ...pre, changePct: 0 }, us], 25.6);
  assert.deepEqual(src.computeMood([pre, us], 25.6), m0, '예상 지수는 분위기에 안 들어감');
  assert.ok(m0.summary.startsWith('나스닥 강세(1.09%)'), m0.summary);
  assert.notDeepEqual(src.computeMood([{ ...pre, marketStatus: 'OPEN' }, us], 25.6), m0, '장중이면 들어감');
  // 지수 핵심 이유 — 개장 전엔 지난 장 판단 그대로, AI·뉴스 안 부름
  const prevReason = { dir: 'down', query: '코스피 급락 이유', headlines: [{ title: '지난 장 기사' }], ai: { summary: '지난 장 AI 판단', items: [{ title: 't', why: 'w' }], model: 'm' }, aiAt: NOW_KR - 900 * MIN, aiSig: '-2|x' };
  const seed = { indices: [], briefs: [{ key: 'KOSPI', name: '코스피', changePct: -2, reason: prevReason }, { key: 'KOSDAQ', name: '코스닥', changePct: -2, reason: prevReason }] };
  const r1 = workspace();
  writeData(r1, 'market.json', seed);
  await pipeline(r1, { idxStatus: 'PREOPEN', idxPct: -21.86, krStatus: 'PREOPEN', krPct: { '005930': 0, '000660': 0 }, krAt: at('08:50') }, at('08:50'));
  const m1 = read(r1, 'market.json');
  assert.deepEqual(m1.briefs[0].reason, prevReason, '지난 장 판단 그대로');
  assert.equal(briefCalls(), 0, '예상 지수로 AI 안 부름');
  assert.equal(NET.calls.filter((u) => /news\.google\.com/.test(decodeURIComponent(u)) && /급락 이유|급등 이유|증시 마감/.test(decodeURIComponent(u))).length, 0, '지수 이유 뉴스도 안 받음');
  assert.deepEqual([m1.indices.find((i) => i.symbol === '^KS11').changePct, m1.briefs[0].changePct], [0, 0], '08:55 전 예상 지수는 0%');
  const r2 = workspace();
  writeData(r2, 'market.json', seed);
  await pipeline(r2, { idxStatus: 'PREOPEN', idxPct: -8.21, krStatus: 'PREOPEN', krPct: { '005930': 0, '000660': 0 }, krAt: at('08:55') }, at('08:55'));
  const m2 = read(r2, 'market.json');
  assert.deepEqual([m2.indices.find((i) => i.symbol === '^KS11').changePct, m2.briefs[0].changePct, m2.briefs[0].reason.ai.summary], [-8.21, -8.21, '지난 장 AI 판단'], '08:55부터 예상 표시 · 이유는 그대로');
  // 장이 열리면 그 등락으로 다시 찾는다(방향이 바뀌면 지난 판단 버림)
  const r3 = workspace();
  writeData(r3, 'market.json', seed);
  await pipeline(r3, { idxStatus: 'OPEN', idxPct: 1.5, krAt: at('09:05') }, at('09:05'));
  assert.deepEqual([read(r3, 'market.json').briefs[0].reason.dir, read(r3, 'market.json').briefs[0].reason.query], ['up', '코스피 급등 이유']);
  // 화면 머리
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(block + '; ({ briefLook })', {});
  const look = (p, st, c = p) => JSON.parse(JSON.stringify(f.briefLook(p, st ? { marketStatus: st, changePct: c } : undefined)));
  assert.deepEqual(look(-8.21, 'PREOPEN'), { est: true, dirCls: 'flat', cardCls: '', arrow: '▼', label: '지난 장 핵심' }, '예상 지수');
  assert.deepEqual(look(0, 'PREOPEN'), { est: false, dirCls: 'flat', cardCls: '', arrow: '–', label: '지난 장 핵심' }, '개장 전 0%');
  assert.deepEqual(look(-2, 'OPEN'), { est: false, dirCls: 'down', cardCls: 'brief-down', arrow: '▼', label: '급락 핵심 이유' });
  assert.deepEqual(look(2, 'CLOSE'), { est: false, dirCls: 'up', cardCls: 'brief-up', arrow: '▲', label: '급등 핵심 이유' });
  assert.deepEqual(look(0.4, 'OPEN'), { est: false, dirCls: 'up', cardCls: 'brief-up', arrow: '▲', label: '오늘의 핵심' });
  assert.deepEqual(look(0, null), { est: false, dirCls: 'flat', cardCls: '', arrow: '–', label: '오늘의 핵심' });
});
await test('방향 낱말(36차): 휘청·무너·붕괴·밀려·껑충·뛰었 · 환율 강세·약세는 종목 방향 아님 · 여러 종목 제목은 이름이 든 절로 · [마감분석] "…% 내린 …원 마감"은 시세 · 봇·화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(block + '; ({ pickReasonNews, priceOnly })', {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const it = (title) => ({ title, pubMs: T('2026-11-10T09:30:00+09:00'), sentiment: src.tagSentiment(title) });
  const pick = (title, pct, names) => {
    const a = src.pickReasonNews([it(title)], pct, '20261110', kst, names), b = f.pickReasonNews([it(title)], pct, '20261110', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택: ' + title);
    return !!a;
  };
  // 실제 11/10 '왜 움직였나'에 붙었던 제목 — 오른 날의 이유가 아니다
  const opt = '[코스피 지수선물 옵션] 삼성SDI·효성중공업·삼양식품 휘청...한진칼·한미약품은 상승';
  assert.equal(pick(opt, 11.17, ['효성중공업']), false, '이름 바로 뒤 휘청');
  assert.equal(pick(opt, 7.35, ['삼성SDI']), false, '10자를 넘어도 같은 절의 휘청');
  assert.equal(pick(opt, 3, ['한미약품']), true, '다른 절의 상승은 그 종목 것');
  assert.equal(pick('19만 원 무너진 삼성전자…증권가 저가 매수론', 5.32, ['삼성전자']), false, '무너진');
  assert.equal(pick('한화證 “현대차, 원화 강세·원자재 부담…목표가 49만원으로 하향”', 3.13, ['현대차']), false, '원화 강세는 종목 강세 아님 — 목표가 하향');
  // 내림·오름 낱말
  for (const t of ['삼성전기, 80만원선까지 밀려', '코스피 5000선 붕괴에 가나 곤두박질', '가나 3% 내린 5만원', '가나 주가 주저앉아', '가나 5% 빠졌다']) { assert.equal(pick(t, 4, ['가나', '삼성전기']), false, '오른 날 제외: ' + t); assert.equal(pick(t, -4, ['가나', '삼성전기']), true, '내린 날 이유: ' + t); }
  for (const t of ['[속보] 두산에너빌리티 주가 장초반 9%대 껑충…VI 발동', '가나 하루 만에 30% 뛰었다', '가나 3% 오른 5만원', '가나 불기둥']) { assert.equal(pick(t, -4, ['가나', '두산에너빌리티']), false, '내린 날 제외: ' + t); assert.equal(pick(t, 4, ['가나', '두산에너빌리티']), true, '오른 날 이유: ' + t); }
  // 낱말 경계 — 뜻이 다른 말
  assert.equal(pick('가나 주문 밀려들어 공장 풀가동', 4, ['가나']), true, '밀려들어는 내림 아님');
  assert.equal(pick('가나 오른쪽 날개 신규 생산', -4, ['가나']), true, '오른쪽은 오름 아님');
  // 환율 말만 빼고 — 종목 강세는 그대로
  assert.deepEqual(['달러 강세 지속', '원화 약세 전망', '반도체주 강세', '가나 휘청', '가나 껑충'].map((t) => src.tagSentiment(t).tone), ['neutral', 'neutral', 'pos', 'neg', 'pos']);
  // 시세 안내
  for (const t of ['[마감분석] 두산에너빌리티 3.02% 내린 4만3350원 마감 : 기업주식정보', '[마감분석] 대덕전자 19.80% 급락 마감 7만9800원 기록']) { assert.equal(src.priceOnly(t), true, '봇: ' + t); assert.equal(f.priceOnly(t), true, '화면: ' + t); }
});
await test('뉴스 검색어(37차): 미국은 영문 이름·영문 별칭과 티커(영문 이름을 모르면 예전 검색어) · 3건이 안 되면 넓혀서 한 번 더(국내 이름·별칭, 미국 예전 검색어) · 합쳐서 고름 · 두 번째가 실패해도 첫 결과 유지', async () => {
  const qs = () => NET.calls.filter((u) => /news\.google\.com/.test(u)).map((u) => new URL(u).searchParams.get('q').replace(/\s+when:\S+/, ''));
  const items = [{ code: '005930', market: 'KR', name: '삼성전자' }, { code: '010120', market: 'KR', name: 'LS ELECTRIC' }, { code: 'PLUG', market: 'US', name: '플러그파워' }, { code: 'SPCX', market: 'US', name: '스페이스X' }, { code: 'AAPL', market: 'US', name: '애플' }];
  const list = { v: 2, kr: [], us: [['PLUG', '플러그 파워', 'Plug Power, Inc.', 'NASDAQ', 2], ['SPCX', '스페이스X', 'Space Exploration Technologies Corp. Class A', 'NASDAQ', 7]], meta: {} };
  const xml = (titles) => '<?xml version="1.0"?><rss><channel>' + titles.map((t, i) => '<item><title>' + t + ' - 일보' + '</title><link>https://news.example.com/' + encodeURIComponent(t) + i + '</link><pubDate>' + new Date(Date.now() - (i + 1) * 600e3).toUTCString() + '</pubDate><source url="https://news.example.com">일보</source></item>').join('') + '</channel></rss>';
  const many = (m, u) => { const q = new URL(u).searchParams.get('q'); const n = /삼성전자|LS/.test(q) ? (/LS/.test(q) ? 'LS ELECTRIC' : '삼성전자') : /Plug/.test(q) ? 'Plug Power' : /SpaceX/.test(q) ? 'SpaceX' : /AAPL/.test(q) ? 'AAPL' : '기타'; return text(xml([n + ' 수주 소식', n + ' 신공장 착공', n + ' 임원 인사'])); };
  const r1 = workspace(items);
  writeData(r1, 'stocklist.json', list);
  await pipeline(r1, { news: many, krPct: {}, usPct: {} });
  const q1 = qs();
  assert.ok(q1.includes('Plug Power PLUG stock') && q1.includes('SpaceX SPCX stock'), '영문 이름·영문 별칭 — ' + q1.join(' / '));
  assert.ok(q1.includes('애플 AAPL stock'), '영문 이름을 모르면 예전 검색어');
  assert.ok(q1.includes('삼성전자 주가') && q1.includes('LS ELECTRIC 주가'));
  assert.ok(!q1.some((q) => q.includes('플러그파워 PLUG')) && !q1.some((q) => / OR /.test(q)), '3건이면 넓혀 찾지 않음 — ' + q1.join(' / '));
  // 적으면 넓혀서 — 첫 검색 1건 + 두 번째 다른 기사 = 합침
  const thin = (m, u) => {
    const q = new URL(u).searchParams.get('q').replace(/\s+when:\S+/, '');
    if (q === 'LS ELECTRIC 주가') return text(xml(['LS ELECTRIC 주가 급등 배경']));
    if (q === 'LS ELECTRIC OR LS일렉트릭') return text(xml(['LS일렉트릭, 북미 변압기 수주', 'LS ELECTRIC 주가 급등 배경']));
    if (q === 'Plug Power PLUG stock') return text(xml([]));
    if (q === '플러그파워 PLUG stock') return text(xml(['Why PLUG stock jumped today']));
    if (q === 'SpaceX SPCX stock') return text(xml(['SpaceX wins contract']));
    if (q === '스페이스X SPCX stock') return text('error', 500);
    return text(xml([]));
  };
  const r2 = workspace(items);
  writeData(r2, 'stocklist.json', list);
  await pipeline(r2, { news: thin, krPct: {}, usPct: {} });
  const n2 = read(r2, 'news.json'), q2 = qs();
  assert.ok(q2.includes('LS ELECTRIC OR LS일렉트릭') && q2.includes('플러그파워 PLUG stock'), '넓혀서 한 번 더 — ' + q2.join(' / '));
  assert.deepEqual(n2['010120'].items.map((x) => x.title).sort(), ['LS ELECTRIC 주가 급등 배경', 'LS일렉트릭, 북미 변압기 수주'].sort(), '합치고 같은 기사는 하나');
  assert.deepEqual(n2.PLUG.items.map((x) => x.title), ['Why PLUG stock jumped today'], '영문 검색이 0건이어도 예전 검색어로');
  assert.deepEqual([n2.SPCX.ok, n2.SPCX.items.map((x) => x.title)], [true, ['SpaceX wins contract']], '두 번째가 실패해도 첫 결과 유지');
});
await test('방향 낱말(38차): 증발·반토막·들썩 · 낮춰·물린·눈물 / 쾌재·높여·수혜 · "무슨 일이"·"…할까…"는 원인을 말하지 않아 맨 뒤 · 봇·화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(block + '; ({ pickReasonNews })', {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const it = (title) => ({ title, pubMs: T('2026-11-10T09:30:00+09:00'), sentiment: src.tagSentiment(title) });
  const pick = (titles, pct, names) => {
    const list = titles.map(it), a = src.pickReasonNews(list, pct, '20261110', kst, names), b = f.pickReasonNews(list, pct, '20261110', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택: ' + titles.join(' / '));
    return a ? a.title : null;
  };
  // 실제 11/10 삼성SDI +6.14%에 붙은 제목 — 내림 말(증발) + 원인을 말하지 않는 꼭지(무슨 일이)
  const sdi = '사흘 만에 시총 10조 증발…삼성SDI에 무슨 일이 [이런국장 저런주식]';
  assert.equal(pick([sdi], 6.14, ['삼성SDI']), null, '오른 날 증발 기사는 이유 아님');
  assert.equal(pick([sdi, '삼성SDI 업황 점검'], -6, ['삼성SDI']), '삼성SDI 업황 점검', "내린 날이어도 '무슨 일이'는 맨 뒤");
  assert.equal(pick([sdi], -6, ['삼성SDI']), sdi, '그것뿐이면 그것');
  for (const [t, up] of [["하반기 '반토막' 145종목 … 가나도 못 피했다", false], ['신재생에너지 관련주 들썩…가나 주목', true], ['메리츠증권 가나 목표가 14만원서 12만원으로 낮춰', false],
    ['반도체 특수에 가나 쾌재', true], ['가나 목표가 높여', true], ['가나 250층 물린 개미의 눈물', false]]) {
    assert.equal(pick([t], up ? -3 : 3, ['가나']), null, '반대 방향 제외: ' + t);
    assert.equal(pick([t], up ? 3 : -3, ['가나']), t, '같은 방향 이유: ' + t);
  }
  assert.equal(pick(['가나, 월요일 주가 반전할까…미 해군 고위급 방한', '가나 업황 점검'], 3, ['가나']), '가나 업황 점검', "'…할까…'도 맨 뒤");
  // 호재·악재 낱말이 맞서면(악재 1·호재 1 = 중립) 방향 낱말이 정한다
  assert.equal(pick(['가나 시총 10조 증발…신제품 기대'], 3, ['가나']), null, '증발 — 호재 낱말이 있어도 내림');
  assert.equal(pick(['가나 주가 반토막…수주 기대'], 3, ['가나']), null, '반토막 — 호재 낱말이 있어도 내림');
  assert.equal(pick(['가나 관련주 들썩…규제 우려'], -3, ['가나']), null, '들썩 — 악재 낱말이 있어도 오름');
  assert.deepEqual(['시총 10조 증발', '관련주 들썩', '목표가 낮춰', '수혜 기대'].map((t) => src.tagSentiment(t).tone), ['neg', 'pos', 'neg', 'pos']);
});
await test('이유(39차): 채용(공채)·사내 행사 기사도 이유 후보에서 뺌 — 사업 기사(채용 플랫폼 진출 등)는 그대로 · 봇·화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(block + '; ({ pickReasonNews })', {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const it = (title) => ({ title, pubMs: T('2026-11-10T09:30:00+09:00'), sentiment: { tone: 'neutral' } });
  const pick = (titles, pct) => {
    const list = titles.map(it), a = src.pickReasonNews(list, pct, '20261110', kst, []), b = f.pickReasonNews(list, pct, '20261110', kst, []);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택: ' + titles.join(' / '));
    return a ? a.title : null;
  };
  // 실제 11/10 뉴스 목록 제목
  for (const t of ['안랩, 하반기 공채…전 직군 두 자릿수 모집', '안랩·클라우드메이트 하반기 공채…29일까지 접수', "HD현대중공업, '난타' 공연 관람...내·외국인 근로자 화합 목적",
    'K리그-HD현대일렉트릭, 베트남 껀터서 축구 교실', '한화오션 현직자가 알려주는 실속 직업훈련 ‘주목’', '가나, 신입사원 채용 공고', '가나 인턴 모집']) {
    assert.equal(pick([t, '가나 업황 점검'], 3), '가나 업황 점검', '이유 아님: ' + t);
    assert.equal(pick([t], 3), null, '그것뿐이어도 이유 아님: ' + t);
  }
  for (const t of ['가나, AI 채용 플랫폼 사업 진출', '가나 신공장 착공']) assert.equal(pick([t], 3), t, '사업 기사는 그대로: ' + t);
});
await test('AI 종합분석 순서(40차): 시장과 비슷하게 움직인 종목(시장 따라)은 맨 뒤 — 그 종목만의 이유가 있는 종목 먼저(무료 한도) · 상장 시장을 모르면 등락 순', async () => {
  const geminiNames = () => NET.bodies.filter((b, i) => isGemini(NET.calls[i]) && !b.includes('뉴스 목록')).map((b) => (b.match(/'(삼성전자|SK하이닉스|애플)'/) || [])[1]).filter(Boolean);
  const list = { v: 2, kr: [['005930', '삼성전자', 'KOSPI', 1], ['000660', 'SK하이닉스', 'KOSPI', 2]], us: [], meta: {} };
  // 코스피 +5.5% · 삼성전자 +6%(시장 따라 — 차이 0.5%p) · SK하이닉스 +3%(차이 -2.5%p — 그 종목만의 움직임)
  const r1 = workspace();
  writeData(r1, 'stocklist.json', list);
  await pipeline(r1, { idxPct: 5.5, krPct: { '005930': 6, '000660': 3 }, krAt: NOW_KR });
  assert.deepEqual(geminiNames().slice(0, 2), ['SK하이닉스', '삼성전자'], '시장 따라는 맨 뒤');
  // 상장 시장을 모르면(검색 목록 없음) 많이 움직인 순서 그대로
  const r2 = workspace();
  await pipeline(r2, { idxPct: 5.5, krPct: { '005930': 6, '000660': 3 }, krAt: NOW_KR });
  assert.deepEqual(geminiNames().slice(0, 2), ['삼성전자', 'SK하이닉스'], '시장을 모르면 등락 순');
});
await test('이유·뉴스(41차): 시세 안내 "…원 10,000원 6.22% 상승" · 유튜브 낚시 제목은 스팸 · "주가 전망."·"…봤더니"는 맨 뒤 · "·"로 4종목 넘게 나열은 나열 기사 · 산학협력·인재 양성은 이유 아님 · 봇·화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(block + '; ({ pickReasonNews, priceOnly })', {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const it = (title) => ({ title, pubMs: T('2026-11-10T09:30:00+09:00'), sentiment: { tone: 'neutral' } });
  const pick = (titles, pct, names = []) => {
    const list = titles.map(it), a = src.pickReasonNews(list, pct, '20261110', kst, names), b = f.pickReasonNews(list, pct, '20261110', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택: ' + titles.join(' / '));
    return a ? a.title : null;
  };
  // 실제 11/10 '왜 움직였나'에 붙었던 제목
  const price = '한미반도체 주가, 11월 10일 장중 170,700원 10,000원 6.22% 상승';
  assert.equal(src.priceOnly(price), true); assert.equal(f.priceOnly(price), true);
  assert.equal(src.priceOnly('한미반도체 주가, 11월 10일 장중 170,700원 6.22% 상승'), true, '예전 꼴도 그대로');
  const yt = 'SK텔레콤 주가 전망. 오늘 심상치 않았죠? 가장 중요한 시기입니다. 반드시 체크해보세요. #k인베스터랩 #sk텔레콤 #sk텔레콤주가전망';
  for (const t of [yt, '[SK텔레콤 주가전망] *오후 속보* 이 영상 주가 예측 모든걸 담았습니다, 틀리면 채널 지웁니다', '[LG에너지솔루션 주가전망] *새벽 속보* 와..이번주 실적발표'])
    assert.equal(src.SPAM_RE.test(t), true, '유튜브 낚시: ' + t);
  for (const t of ['SK텔레콤, 구독 서비스 출시', '삼성전자 #갤럭시 신제품 공개', '[속보] 두산에너빌리티 주가 장초반 9%대 껑충']) assert.equal(src.SPAM_RE.test(t), false, '보통 기사: ' + t);
  assert.equal(pick(['SK텔레콤 주가 전망, 반등 이어질까', 'SK텔레콤 업황 점검'], 3), 'SK텔레콤 업황 점검', '주가 전망 글은 맨 뒤');
  assert.equal(pick(['"주당 2,500원 나옵니다.." 현대차 11월 배당, 60대 100주 계산해봤더니', '현대차 업황 점검'], 2, ['현대차']), '현대차 업황 점검', '…봤더니 해설은 맨 뒤');
  assert.equal(pick(['[N2 증시 풍향계] 삼성전자·SK하이닉스·한진칼·대한항공·NHN ‘강세’', 'SK하이닉스 신공장 착공'], 6, ['SK하이닉스']), 'SK하이닉스 신공장 착공', '나열 기사는 맨 뒤');
  assert.equal(pick(["[특징주] 삼성전자·SK하이닉스, 美 기술주 급반등.. 동반 '강세'", '삼성전자 신공장 착공'], 5, ['삼성전자']), "[특징주] 삼성전자·SK하이닉스, 美 기술주 급반등.. 동반 '강세'", '두 종목은 나열 아님');
  assert.equal(pick(['재능대·유진로봇, 로봇·AI 실무인재 양성 산학협력 협약'], 7, ['유진로봇']), null, '산학협력·인재 양성은 이유 아님');
});
await test('이유(42차): "미미" 평가는 악재 · "‘이것’을 봐라" 낚시 해설·[CEO 탐구생활]·[증시 풍향계] 기획 꼭지는 맨 뒤 · 봇·화면 같음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(block + '; ({ pickReasonNews })', {});
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const it = (title) => ({ title, pubMs: T('2026-11-10T09:30:00+09:00'), sentiment: src.tagSentiment(title) });
  const pick = (titles, pct, names = []) => {
    const list = titles.map(it), a = src.pickReasonNews(list, pct, '20261110', kst, names), b = f.pickReasonNews(list, pct, '20261110', kst, names);
    assert.equal(b ? b.title : null, a ? a.title : null, '봇·화면 같은 선택: ' + titles.join(' / '));
    return a ? a.title : null;
  };
  // 실제 11/10 제목
  assert.equal(src.tagSentiment("한화오션 미국 해군 중형상륙함 수주는 '미미' 평가").tone, 'neutral', '수주(호재)와 미미(악재)가 맞섬');
  for (const t of ['삼전닉스 올해 200조 주주환원에…“주가, 자사주 매입 아닌 ‘이것’을 봐라”', '곽동신 한미반도체 회장, HBM 장비 혁신 주도⋯3년 연속 매출 신기록 가시권 [CEO 탐구생활]', '[N2 증시 풍향계] 가나 ‘강세’'])
    assert.equal(pick([t, '가나 업황 점검'], 6, ['가나']), '가나 업황 점검', '맨 뒤: ' + t);
  assert.equal(pick(['[특징주] 가나 신공장 착공에 강세', '가나 업황 점검'], 6, ['가나']), '[특징주] 가나 신공장 착공에 강세', '사실을 전하는 꼭지는 그대로');
});
await test('뉴스 기간·지금 가격 끝값(43차): 뉴스는 마지막 거래일 기준(같은 날 2일 · 하루 지날 때마다 +1 · 최대 5일) · 기간 수익률·예측·차트는 그날 봉 대신 지금 가격(개장 전·첫 체결 전은 그대로)', async () => {
  const days = () => NET.calls.filter((u) => /news\.google\.com/.test(u)).map((u) => new URL(u).searchParams.get('q')).filter((q) => /삼성전자 주가/.test(q)).map((q) => (q.match(/when:(\d)d/) || [])[1]);
  const r1 = workspace();
  await pipeline(r1, { krAt: NOW_KR });
  assert.deepEqual([...new Set(days())], ['2'], '같은 날이면 2일');
  const r2 = workspace();
  await pipeline(r2, { krAt: NOW_KR, krStatus: 'CLOSE' }, NOW_KR + 3 * 1440 * MIN); // 목요일 시세를 일요일에
  assert.deepEqual([...new Set(days())], ['5'], '사흘 지나면 5일');
  const r3 = workspace();
  await pipeline(r3, { krAt: NOW_KR, krStatus: 'CLOSE' }, NOW_KR + 1440 * MIN);
  assert.deepEqual([...new Set(days())], ['3'], '하루 지나면 3일');
  const r4 = workspace();
  await pipeline(r4, { krAt: NOW_KR, krStatus: 'CLOSE' }, NOW_KR + 6 * 1440 * MIN);
  assert.deepEqual([...new Set(days())], ['5'], '엿새가 지나도 5일(상한)');
  // 화면 — 그날 봉은 지금 가격으로, 없으면 덧붙임
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(block + '; ({ liveSeries })', {});
  const d = (s) => T(s + 'T00:00:00Z'); // 야후 일봉 시각(한국 09:00)
  const h = { closes: [100, 101, 102], dates: [d('2026-11-06'), d('2026-11-09'), d('2026-11-10')] };
  const q = (x) => ({ ok: true, market: 'KR', price: 110, volume: 100, marketStatus: 'OPEN', asOf: '2026-11-10T10:30:00+09:00', ...x });
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(f.liveSeries(q(), h)), { closes: [100, 101, 110], dates: [h.dates[0], h.dates[1], T('2026-11-10T10:30:00+09:00')] }, '그날 봉 → 지금 가격');
  assert.deepEqual(plain(f.liveSeries(q(), { closes: [100, 101], dates: [h.dates[0], h.dates[1]] })).closes, [100, 101, 110], '그날 봉이 아직 없으면 덧붙임');
  assert.deepEqual(plain(f.liveSeries(q({ marketStatus: 'PREOPEN', asOf: '2026-11-11T08:30:00+09:00' }), h)).closes, [100, 101, 102], '개장 전은 그대로');
  assert.deepEqual(plain(f.liveSeries(q({ volume: null }), h)).closes, [100, 101, 102], '첫 체결 전은 그대로');
  assert.deepEqual(plain(f.liveSeries(q({ asOf: '2026-11-09T15:30:00+09:00' }), h)).closes, [100, 101, 102], '일봉이 더 새로우면 그대로');
  assert.deepEqual(plain(f.liveSeries(q({ ok: false }), h)).closes, [100, 101, 102], '시세 실패면 그대로');
  assert.equal(f.liveSeries(q(), null), null);
});
await test('AI 입력 과거 흐름(44차): 1주·1개월·3개월·고점 대비도 지금 가격 끝값(그날 봉 대신 · 없으면 덧붙임 · 개장 전·첫 체결 전은 그대로) · 실제 요청 본문도', async () => {
  const d = (s) => T(s + 'T00:00:00Z');
  const dates = Array.from({ length: 70 }, (_, i) => d('2026-08-01') + i * 86400e3);
  const closes = dates.map(() => 100);
  const lastDay = new Date(dates[69] + 9 * 3600e3).toISOString().slice(0, 10);
  const q = (x) => ({ ok: true, market: 'KR', price: 110, volume: 1, marketStatus: 'OPEN', asOf: lastDay + 'T10:30:00+09:00', ...x });
  const st = src.historyStats({ closes, dates }, q());
  assert.deepEqual([Math.round(st.w1), Math.round(st.m1), Math.round(st.m3), Math.round(st.fromHigh)], [10, 10, 10, 0], '그날 봉 → 지금 가격 110');
  assert.equal(src.liveCloses({ closes, dates }, q()).length, 70, '바꿈(길이 그대로)');
  const next = new Date(dates[69] + 86400e3 + 9 * 3600e3).toISOString().slice(0, 10);
  assert.equal(src.liveCloses({ closes, dates }, q({ asOf: next + 'T10:30:00+09:00' })).length, 71, '그날 봉이 없으면 덧붙임');
  assert.equal(src.liveCloses({ closes, dates }, q({ marketStatus: 'PREOPEN' })).at(-1), 100, '개장 전은 그대로');
  assert.equal(src.liveCloses({ closes, dates }, q({ volume: null })).at(-1), 100, '첫 체결 전은 그대로');
  assert.equal(Math.round(src.historyStats({ closes, dates }).w1), 0, '시세를 안 넘기면 예전처럼 일봉만');
  // 실제 AI 요청 본문 — 과거 흐름 줄이 지금 가격 기준
  NET.routes = routes(); NET.calls = []; NET.bodies = []; NET.blocked = [];
  await src.aiStockAnalysis({ quote: { ...q(), code: '005930', name: '가나', changePct: 10, high: 111, low: 100 }, news: { items: [] }, flow: null, history: { closes, dates }, disclosures: null, schedule: [], now: T(lastDay + 'T10:31:00+09:00') });
  const body = NET.bodies.find((b, i) => isGemini(NET.calls[i])) || '';
  assert.ok(body.includes('과거 흐름: 1주 +10.0% · 1개월 +10.0% · 3개월 +10.0% · 6개월 고점대비 +0.0%'), body.slice(0, 700));
});
await test('AI 분석 대기 안내(app.js): 상태별 [지금 상태, 이유] · 순서 대기면 다음 분석 시각 · 키가 없거나 상태를 모르면 안내 안 함', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ aiWaitText })`, {});
  const t = (ai, next) => { const w = f.aiWaitText(ai, next); return w && w.join(' | '); };
  assert.equal(t({ state: 'wait' }, '12:10부터'), '대기 중 — 다음 분석 12:10부터 | 무료 한도를 장 시간에 나눠 쓰는 중');
  assert.equal(t({ state: 'wait' }), '대기 중 — 순서 기다리는 중 | 무료 한도를 장 시간에 나눠 쓰는 중');
  assert.match(t({ state: 'quota' }), /무료 한도를 다 씀/);
  assert.match(t({ state: 'auth' }), /설정 확인/);
  assert.match(t({ state: 'no-model' }), /설정 확인/);
  assert.match(t({ state: 'error' }), /응답 오류/);
  assert.match(t({ state: 'ok' }), /곧 분석/);
  assert.match(t({ state: 'idle' }), /곧 분석/);
  assert.equal(t({ state: 'off' }), null, 'AI 키가 없으면 안내 안 함');
  assert.equal(t(null), null, '상태를 모르면 안내 안 함');
});
await test('다음 일정(app.js): 2주 안 가장 가까운 날 · 그날 두 개까지(시각·미국 장 전후) · 지난 공시·이미 낸 실적 공시·지난 날 빼고 · 나머지 수 · 없으면 없음', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const f = vm.runInNewContext(`${block}; ({ nextSchedule })`, {});
  const E = (d, k, t, x = {}) => ({ d, c: '005930', m: 'KR', k, t, ...x }); // 달력 데이터처럼 날짜·종류 순
  const ev = [E('20261014', 'ir', '기업설명회(IR)'), E('20261015', 'earn', '실적 공시'), E('20261015', 'disc', '단일판매ㆍ공급계약체결'),
    { d: '20261016', c: '000660', m: 'KR', k: 'ir', t: '기업설명회(IR)' },
    E('20261020', 'earn', '3분기 실적 발표 예정'), E('20261020', 'ir', '기업설명회(IR)', { tm: '15:45' }), E('20261020', 'meet', '주총 기준일'),
    E('20261027', 'div', '배당 기준일'), E('20261030', 'cap', '자사주 매입 끝'),
    { d: '20261102', c: 'AAPL', m: 'US', k: 'earn', t: '실적 발표(예상일)', s: '미국 장 마감 뒤', est: true }];
  const n = (...a) => JSON.parse(JSON.stringify(f.nextSchedule(...a)));
  assert.deepEqual(n(ev, '005930', '20261015'), { d: '20261020', dd: 5, items: ['3분기 실적 발표 예정', '기업설명회(IR) 15:45'], more: 2 },
    '어제 일정·이미 낸 실적 공시·지난 공시·다른 종목은 빼고 그날 셋 중 둘 + 나머지(그날 1·10/27 1) — 10/30은 2주 밖');
  assert.deepEqual(n(ev, '005930', '20261020'), { d: '20261020', dd: 0, items: ['3분기 실적 발표 예정', '기업설명회(IR) 15:45'], more: 3 }, '오늘 일정');
  assert.deepEqual(n(ev, 'AAPL', '20261030'), { d: '20261102', dd: 3, items: ['실적 발표(예상일) · 미국 장 마감 뒤'], more: 0 }, '미국 실적은 장 전·후');
  assert.equal(f.nextSchedule(ev, '005930', '20261031'), null, '2주 안에 없음');
  assert.equal(f.nextSchedule(null, '005930', '20261015'), null);
  assert.equal(f.nextSchedule(ev, '005930', ''), null);
});
await test('지난 AI 분석(app.js): 지금 시세의 거래일에 만든 분석만 "왜 움직였나" 이유로 · 전날 분석이면 오늘 뉴스 · 미국은 뉴욕 날짜 · 시각 모르면 그대로', async () => {
  const vm = await import('node:vm');
  const appJs = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
  const block = appJs.slice(appJs.indexOf('function marketOf('), appJs.indexOf('// ---------- 데이터 지연 경고'));
  const why = appJs.slice(appJs.indexOf('function whyOf('), appJs.indexOf('function tileHtml('));
  const ctx = { state: { analysis: {}, news: {} }, keyDiscToday: () => null };
  const f = vm.runInNewContext(`${block}\n${why}; ({ aiFresh, whyOf })`, ctx);
  const at = (iso) => Date.parse(iso);
  const q = { code: 'A', name: '가나', market: 'KR', ok: true, changePct: -3.1, asOf: '2026-10-23T09:05:00+09:00' };
  assert.equal(f.aiFresh(q, { headline: 'x', at: at('2026-10-23T09:01:00+09:00') }), true, '같은 거래일');
  assert.equal(f.aiFresh(q, { headline: 'x', at: at('2026-10-22T15:20:00+09:00') }), false, '전 거래일');
  assert.equal(f.aiFresh({ ...q, asOf: '2026-10-22T15:30:00+09:00' }, { headline: 'x', at: at('2026-10-22T15:20:00+09:00') }), true, '장 열리기 전(시세가 아직 어제) — 어제 분석이 최신');
  assert.equal(f.aiFresh(q, { headline: 'x' }), true, '분석 시각 모름 → 그대로');
  assert.equal(f.aiFresh({ ...q, asOf: undefined }, { headline: 'x', at: at('2026-10-20T10:00:00+09:00') }), true, '시세 시각 모름 → 그대로');
  const u = { code: 'U', name: '유', market: 'US', ok: true, changePct: 5, asOf: '2026-10-22T20:00:00.000Z' };
  assert.equal(f.aiFresh(u, { headline: 'x', at: at('2026-10-22T14:00:00Z') }), true, '미국은 뉴욕 날짜 — 한국 날짜론 다음 날이어도 같은 거래일');
  assert.equal(f.aiFresh(u, { headline: 'x', at: at('2026-10-21T19:45:00Z') }), false, '미국 전 거래일');
  ctx.state.analysis.A = { headline: '어제 이유', at: at('2026-10-22T15:20:00+09:00') };
  ctx.state.news.A = { items: [{ title: '가나, 실적 부진에 급락', pubMs: at('2026-10-23T09:00:00+09:00') }] };
  assert.equal(f.whyOf(q).src, '뉴스', '전날 분석은 건너뛰고 오늘 뉴스');
  ctx.state.analysis.A = { headline: '오늘 이유', at: at('2026-10-23T09:03:00+09:00') };
  assert.equal(f.whyOf(q).text, '오늘 이유');
  assert.equal(f.whyOf({ ...q, ai: false }).src, '뉴스', 'AI를 꺼 둔 종목은 AI 진단을 쓰지 않음(남아 있어도)');
});
await test('상장 시장(quotes.json exch): 검색 목록의 국내 KOSPI·KOSDAQ · 미국 거래소 · 목록에 없으면 없음 · 시세 안내 기사는 "시세" 표시·호재/악재 집계 제외', async () => {
  const root = workspace();
  writeData(root, 'stocklist.json', { v: 2, kr: [['005930', '삼성전자', 'KOSPI', 1]], us: [['AAPL', '애플', 'Apple Inc.', 'NASDAQ', 1]], meta: {} });
  const news = (m, u) => {
    const name = queryName(u), now = Date.now();
    const item = (t, ago) => `<item><title>${t} - 테스트일보</title><link>https://news.example.com/${ago}</link><pubDate>${new Date(now - ago).toUTCString()}</pubDate><source url="https://news.example.com">테스트일보</source></item>`;
    return text(`<?xml version="1.0"?><rss><channel>${item(`${name} 주가 상승 중`, 600e3)}${item(`${name}, 대규모 수주 소식`, 900e3)}</channel></rss>`);
  };
  await pipeline(root, { news });
  const q = Object.fromEntries(read(root, 'quotes.json').quotes.map((x) => [x.code, x]));
  assert.deepEqual([q['005930'].exch, q.AAPL.exch, q['000660'].exch], ['KOSPI', 'NASDAQ', undefined]);
  const n = read(root, 'news.json')['005930'];
  assert.deepEqual([n.items[1].sentiment.label, n.items[1].sentiment.tone], ['시세', 'neutral'], "'상승'이 들어 있어도 시세 안내 기사는 호재가 아님(목록 끝으로)");
  assert.equal(n.items[0].sentiment.label, '호재');
  assert.deepEqual([n.summary.pos, n.summary.neg, n.summary.label], [1, 0, '호재 우세']);
});
await test('공시 일정(본문): 실적 발표 예정일·IR 일시·기준일(사유로 주총·배당)·배당 기준일·지급일·주총(정정 공시는 고친 본문)·자사주 매입 기간 · 설명 문장·게재일시·정정일자는 날짜로 안 씀', async () => {
  const cal = await import('./calendar.mjs');
  const ev = (k) => JSON.parse(JSON.stringify(cal.parseDocEvents(...DOCS[k])));
  assert.deepEqual(ev('earnNotice'), [{ d: '20261029', k: 'earn', t: '3분기 실적 발표 예정', s: '결산실적 공시 예정일' }], "'상기 공시예정일에…' 설명 칸이 아니라 항목 칸");
  assert.deepEqual(ev('ir'), [{ d: '20261029', tm: '15:45', k: 'ir', t: '기업설명회(IR)', s: '2026년 3분기 경영실적 발표 · 컨퍼런스 콜' }], "'게재일시 10/30'은 IR 날짜가 아님");
  assert.deepEqual(ev('record'), [{ d: '20261029', k: 'meet', t: '주총 기준일', s: '임시주주총회 개최를 위한 권리주주 확정' }]);
  assert.deepEqual(ev('retire'), [{ d: '20261023', k: 'cap', t: '자사주 매입 시작', s: '2026.10.23 ~ 2027.01.22' }, { d: '20270122', k: 'cap', t: '자사주 매입 끝', s: '2026.10.23 ~ 2027.01.22' }], "소각 예정일 '-'은 일정 없음");
  assert.deepEqual(ev('meetFix'), [{ d: '20261211', tm: '09:00', k: 'meet', t: '임시주주총회', s: '서울특별시 영등포구 국제금융로2길 28 본사 5층 강당' },
    { d: '20261106', k: 'meet', t: '주총 기준일', s: '임시주주총회 의결권 기준' }], "'정정일자'·'제출일'·정정 전 일시(12/04)는 주총 날짜가 아님, '09 : 00' 시각");
  assert.deepEqual(ev('dividend'), [{ d: '20260930', k: 'div', t: '배당 기준일', s: '주당 370원' }, { d: '20261120', k: 'div', t: '배당 지급', s: '주당 370원' }]);
  assert.deepEqual(ev('buyback'), [{ d: '20261023', k: 'cap', t: '자사주 매입 시작', s: '2026.10.23 ~ 2027.01.22' }, { d: '20270122', k: 'cap', t: '자사주 매입 끝', s: '2026.10.23 ~ 2027.01.22' }],
    "주요사항보고서(dart4 XML) — '보유예상기간'의 시작·종료 '-'는 매입 기간이 아님");
  assert.deepEqual(ev('irMulti'), [{ d: '20261012', tm: '09:00', k: 'ir', t: '기업설명회(IR)', s: '2026.10.12 ~ 2026.10.16 · 당사 경영현황에 대한 투자자 이해증진 · NDR (Non-Deal Roadshow)' }],
    '날짜가 머리 줄 아래 값 줄에 있는 꼴 · 여러 날 IR은 기간');
  assert.deepEqual(cal.parseDocEvents('주식소각결정', docXml('소각', [docRow('7. 소각 예정일', '-'), docRow('비고', '2026-12-31 이후 결정')])), [], "값이 '-'면 아래 줄 날짜를 끌어오지 않음");
  // 실제 원본은 태그마다 줄을 바꿔 쓴다 — 원본 줄바꿈은 표의 줄이 아니고, <style>의 CSS는 칸이 아님
  assert.deepEqual(cal.docRows(DOCS.ir[1]).find((r) => r[0] === '1. 일시 및 장소'), ['1. 일시 및 장소', '일시', '2026-10-29', '15:45'], '태그마다 줄바꿈해도 표의 한 줄');
  assert.ok(!cal.docRows(DOCS.ir[1]).flat().some((c) => /font-family|line-height/.test(c)), '꾸밈(style) 글은 칸이 아님');
  assert.equal(cal.dateIn('2026년 3월 20일 (금)'), '20260320');
  assert.equal(cal.dateIn('2026년 3분기'), null);
  assert.equal(cal.timeIn('오후 3시 30분'), '15:30');
  assert.equal(cal.timeIn('오전 10시'), '10:00');
  assert.deepEqual(JSON.parse(JSON.stringify(cal.parseDocEvents('기업설명회(IR)개최(안내공시)', docXml('IR', [docRow('1. 일시', '2026년 11월 5일 오후 4시')])))),
    [{ d: '20261105', tm: '16:00', k: 'ir', t: '기업설명회(IR)' }], '한글 날짜·시각');
  assert.deepEqual(cal.parseDocEvents('단일판매ㆍ공급계약체결', DOCS.ir[1]), [], '일정이 없는 공시');
  // 제3자 배정 유상증자 — 핵심 날짜는 납입일(정정 신고서는 앞 표의 정정 전 날짜가 아니라 고친 본문의 날짜)
  assert.deepEqual(JSON.parse(JSON.stringify(cal.parseDocEvents('[기재정정]주요사항보고서(유상증자결정)', dartXml('주요사항보고서(유상증자결정)', [
    dartRow('항 목', '정정사유', '정 정 전', '정 정 후'), dartRow('9. 납입일', '발행조건 변경', '2026년 09월 16일', '2026년 11월 13일'),
    dartRow('1. 신주의 종류와 수', '기타주식 (주)', '1,150,000'), dartRow('8. 배정방법', '제3자배정증자'), dartRow('9. 납입일', '2026년 11월 13일'),
    dartRow('10. 신주의 배당기산일', '2026년 01월 01일'), dartRow('12. 신주의 상장 예정일', '-')])))),
    [{ d: '20261113', k: 'cap', t: '유상증자 납입' }], '납입일(고친 본문) · 상장 예정일 \'-\'은 일정 없음');
  // 원본 형식이 달라도 — CDATA 속 HTML(닫는 칸 태그 없음) · 글자로 이스케이프된 표 · 닫는 줄 태그 없음 · 값이 속성에만 있는 칸 · 칸 안 줄바꿈 · 붙여 쓴 날짜
  const pd = (t, x) => JSON.parse(JSON.stringify(cal.parseDocEvents(t, x)));
  const IR_T = '기업설명회(IR)개최(안내공시)';
  assert.deepEqual(pd(IR_T, '<DOCUMENT><BODY><![CDATA[<table><tr><td>1. 일시<td>2026-11-05<td>16:00</tr></table>]]></BODY></DOCUMENT>'),
    [{ d: '20261105', tm: '16:00', k: 'ir', t: '기업설명회(IR)' }], 'CDATA 속 HTML');
  assert.deepEqual(pd(IR_T, '<BODY>&lt;TABLE&gt;&lt;TR&gt;&lt;TD&gt;1. 일시&lt;/TD&gt;&lt;TD&gt;2026-11-05 16:00&lt;/TD&gt;&lt;/TR&gt;&lt;/TABLE&gt;</BODY>'),
    [{ d: '20261105', tm: '16:00', k: 'ir', t: '기업설명회(IR)' }], '이스케이프된 표');
  assert.deepEqual(pd(IR_T, '<table><tr><td>1. 일시<td>미정<tr><td>7. 결정일자<td>2026-10-22</table>'), [], '닫는 줄 태그가 없어도 다음 줄 날짜를 끌어오지 않음');
  assert.deepEqual(pd('주주명부폐쇄기간또는기준일설정', docXml('기준일', ['<TR><TD>1. 기준일</TD><TU AUNIT="DATE" AUNITVALUE="20261029"/></TR>'])),
    [{ d: '20261029', k: 'rec', t: '권리 기준일' }], '값이 속성에만 있는 칸');
  assert.deepEqual(pd('결산실적공시예고(안내공시)', docXml('예고', ['<TR><TD>3. 결산실적 공시&cr;예정일</TD><TD>2026-10-29</TD></TR>'])).map((e) => e.d), ['20261029'], '칸 안 줄바꿈');
  assert.deepEqual(pd(IR_T, docXml('IR', [docRow('1. 일시', '20261105 16:00')])).map((e) => [e.d, e.tm]), [['20261105', '16:00']], '붙여 쓴 날짜 뒤 시각');
  assert.equal(cal.dateIn('20261022800612'), null, '접수번호는 날짜가 아님');
  // 진단 고르기 — 공시 종류가 다른 것부터 최근 순으로 4건
  const dl = [['20261001000001', '기업설명회(IR)개최'], ['20261003000003', '기업설명회(IR)개최'], ['20261002000002', '결산실적공시예고'], ['20261004000004', '기업설명회(IR)개최'],
    ['20261001000005', '주주총회소집결의'], ['20261005000006', '기업설명회(IR)개최']].map(([no, t]) => ({ no, t }));
  assert.deepEqual(cal.pickDiag(dl).map((d) => d.no), ['20261005000006', '20261002000002', '20261001000005', '20261004000004'], '종류가 다른 것부터 최근 순');
  // 미국 — 나스닥
  assert.deepEqual(cal.parseNasdaqEarnings(NASDAQ_EARN), { d: '20261102', when: 'amc', est: true });
  assert.deepEqual(cal.parseNasdaqEarnings({ data: { announcement: 'Earnings announcement for MSFT: Jan 28, 2027', reportText: 'scheduled before market open' } }), { d: '20270128', when: 'bmo', est: false });
  assert.equal(cal.parseNasdaqEarnings({ data: null }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(cal.parseNasdaqDividends(NASDAQ_DIV))).slice(0, 2), [{ d: '20260810', k: 'div', t: '배당락', s: '주당 $0.27' }, { d: '20260813', k: 'div', t: '배당 지급', s: '주당 $0.27' }]);
  assert.equal(cal.parseNasdaqDividends(NASDAQ_DIV).length, 4, "'N/A' 줄은 뺌");
  // 다시 만들 때
  const items = [{ code: '005930' }, { code: 'AAPL' }];
  assert.equal(cal.calendarDue(null, items, NOW_KR), true);
  const pv = cal.PARSER_V;
  assert.equal(cal.calendarDue({ at: NOW_KR - 2 * 3600e3, codes: ['005930', 'AAPL'], pv }, items, NOW_KR), false, '3시간 안');
  assert.equal(cal.calendarDue({ at: NOW_KR - 3 * 3600e3, codes: ['005930', 'AAPL'], pv }, items, NOW_KR), true, '3시간 지남');
  assert.equal(cal.calendarDue({ at: NOW_KR - 600e3, codes: ['005930'], pv }, items, NOW_KR), true, '종목이 바뀌면 바로');
  assert.equal(cal.calendarDue({ at: NOW_KR - 600e3, codes: ['005930', 'AAPL'], pv: pv - 1 }, items, NOW_KR), true, '본문 읽는 방식이 바뀌면 바로');
  assert.equal(cal.calendarDue({ at: NOW_KR - 600e3, codes: ['005930', 'AAPL'] }, items, NOW_KR), true, '판이 없는 옛 파일도 바로');
});
await test('공시 일정(파이프라인): 국내 지난 공시·공시에 적힌 일정 + 미국 실적·배당 → calendar.json · 본문은 한 번만 · 3시간 안엔 다시 안 받음 · 실패하면 직전 일정 · 키 없으면 미국만', async () => {
  const cal = await import('./calendar.mjs');
  await withDartKey(async () => {
    const rows = { ...DART_ROWS, '00126380': [...DART_ROWS['00126380'], ['20261011000300', '결산실적공시예고(안내공시)'],
      ['20261008000111', '결산실적공시예고(안내공시)'], ['20261009000222', '기업설명회(IR)개최(안내공시)'],
      ['20261012000778', '유상증자결정(종속회사의주요경영사항)'], ['20261007000888', '기업설명회(IR)개최(안내공시)'],
      ['20261001000999', '현금ㆍ현물배당결정'], ['20261015000998', '현금ㆍ현물배당결정']] };
    const notice1015 = DOCS.earnNotice[1].replace('2026-10-29', '2026-10-15'); // 실적을 실제로 낸 날(10/15)을 예고한 공시
    const dartDocs = { '20261013000200': DOCS.dividend[1], '20261010000050': DOCS.ir[1], '20261011000300': DOCS.earnNotice[1],
      '20261008000111': notice1015, '20261009000222': DOCS.ir[1],
      '20261012000778': docXml('유상증자', [docRow('9. 신주의 상장 예정일', '2026-12-01')]), // 자회사 일정 — 받지 않아야 함
      '20261007000888': docXml('IR', [docRow('1. 일시', '미정'), docRow('3. 개최목적', '기업 설명')]) }; // 날짜가 없는 본문 → 진단
    const root = workspace();
    await pipeline(root, { dartRows: rows, dartDocs }, NOW_KR, { calendar: true });
    const c = read(root, 'calendar.json');
    assert.equal(c.v, 1); assert.equal(c.at, NOW_KR); assert.deepEqual(c.codes, ['000660', '005930', 'AAPL']);
    assert.equal(c.kr, 'ok'); assert.equal(c.us, 'ok');
    const find = (q) => c.events.filter((e) => Object.entries(q).every(([k, v]) => e[k] === v));
    assert.equal(find({ d: '20261029', c: '005930', k: 'ir', tm: '15:45', n: '삼성전자', m: 'KR', no: '20261010000050' }).length, 1, 'IR 일시');
    assert.equal(find({ d: '20261029', c: '005930', k: 'earn', t: '3분기 실적 발표 예정' }).length, 1);
    assert.equal(find({ d: '20260930', c: '005930', k: 'div', t: '배당 기준일', s: '주당 370원' }).length, 1);
    assert.equal(find({ d: '20261120', c: '005930', k: 'div', t: '배당 지급' }).length, 1);
    assert.equal(find({ d: '20261015', c: '005930', k: 'earn', t: '실적 공시' }).length, 1, '잠정실적 공시 = 그날 발표');
    assert.equal(find({ d: '20261015', c: '005930', k: 'earn', t: '3분기 실적 발표 예정' }).length, 0, '실적을 낸 날의 발표 예정은 뺌');
    assert.equal(find({ d: '20261029', c: '005930', k: 'ir' }).length, 1, '같은 IR을 두 번 공시해도 한 번');
    assert.equal(find({ d: '20261015', c: '005930', k: 'disc', t: '단일판매ㆍ공급계약체결', tag: '계약' }).length, 1, '지난 공시는 공시한 날');
    assert.equal(find({ no: '20261014000400' }).length, 0, '철회된 공시 제외');
    assert.equal(find({ d: '20261102', c: 'AAPL', k: 'earn', t: '실적 발표(예상일)', s: '미국 장 마감 뒤', est: true, m: 'US' }).length, 1);
    assert.equal(find({ d: '20260810', c: 'AAPL', k: 'div', t: '배당락', s: '주당 $0.27' }).length, 1);
    assert.equal(find({ c: 'AAPL', d: '20260511' }).length, 0, '90일보다 오래된 배당락은 뺌');
    assert.deepEqual(c.events.map((e) => e.d), [...c.events.map((e) => e.d)].sort(), '날짜순');
    assert.deepEqual(Object.keys(c.docs).sort(), ['20261001000999', '20261007000888', '20261008000111', '20261009000222', '20261010000050', '20261011000300', '20261013000200'],
      '일정이 적힌 공시만 본문을 받아 기억 — 원문 없음(014)은 이틀 지난 것만 빈 결과로 기억, 자회사 공시는 받지 않음');
    assert.equal(NET.calls.filter((u) => /document\.xml/.test(u)).length, 8);
    assert.ok(!NET.calls.some((u) => /document\.xml/.test(u) && /rcept_no=20261012000778/.test(u)), '자회사 공시는 본문을 받지 않음');
    assert.equal(find({ no: '20261012000778', k: 'disc' }).length, 1, '자회사 공시도 공시한 날에는 둠');
    assert.equal(find({ no: '20261012000778', k: 'cap' }).length, 0);
    assert.deepEqual(c.docs['20261001000999'], [], '원문 없음 — 이틀 지난 공시는 다시 받지 않게 빈 결과로');
    assert.equal(c.pv, cal.PARSER_V, '본문 읽는 방식의 판');
    // 진단 — 일정을 못 찾은 본문의 생김새(받은 파일·고른 파일·인코딩·태그·앞부분 줄)
    assert.equal(c.diag.length, 1, '일정을 못 찾은 본문만 진단');
    const dg = c.diag[0];
    assert.deepEqual([dg.no, dg.pick, dg.enc, dg.files.map((f) => f[0])], ['20261007000888', '20261007000888.xml', 'utf8', ['20261007000888_00760.xml', '20261007000888.xml']]);
    assert.ok(dg.rows.includes('1. 일시 | 미정') && /TABLE 1/.test(dg.tags) && /^<body>/i.test(dg.head) && dg.bad === 0, JSON.stringify(dg));
    assert.ok(NET.calls.filter((u) => /list\.json/.test(u) && /pblntf_ty=I/.test(u)).length >= 1, '유형별 목록');
    assert.ok(NET.calls.filter((u) => /pblntf_ty/.test(u)).every((u) => /last_reprt_at=Y/.test(u)), '정정 전 공시는 빼고 최종 보고서만');
    assert.match(read(root, 'manifest.json').files['calendar.json'], /^[0-9a-f]{10}$/, '파일 지문에 포함');
    assert.equal(NET.blocked.length, 0, `차단된 호출: ${NET.blocked.join(', ')}`);
    assert.ok(!JSON.stringify(c).includes(DART_KEY), '키가 파일에 없음');
    // 3시간 안 — 다시 받지 않음 · 3시간 뒤 — 목록은 다시, 본문은 기억한 것 그대로
    await pipeline(root, { dartRows: rows, dartDocs }, NOW_KR + 2 * 3600e3, { calendar: true });
    assert.equal(NET.calls.filter((u) => /pblntf_ty|document\.xml|api\.nasdaq/.test(u)).length, 0);
    assert.equal(read(root, 'calendar.json').at, NOW_KR);
    await pipeline(root, { dartRows: rows, dartDocs }, NOW_KR + 3 * 3600e3, { calendar: true });
    assert.deepEqual(NET.calls.filter((u) => /document\.xml/.test(u)).map((u) => new URL(u).searchParams.get('rcept_no')), ['20261015000998'],
      '본문 다시 안 받음 — 원문이 아직 없던 막 올라온 공시만 다시');
    assert.equal(read(root, 'calendar.json').diag.length, 1, '진단은 다음 회차에도 유지');
    assert.equal(NET.calls.filter((u) => /api\.nasdaq/.test(u)).length, 2);
    assert.equal(read(root, 'calendar.json').events.filter((e) => e.k === 'ir').length, 1, '기억한 본문으로 일정 유지');
    // 나스닥 실패 — 직전 미국 일정 유지
    await pipeline(root, { dartRows: rows, dartDocs, nasdaq: () => text('busy', 503) }, NOW_KR + 6 * 3600e3, { calendar: true });
    const c4 = read(root, 'calendar.json');
    assert.equal(c4.us, '받기 실패 — 직전 일정 유지');
    assert.equal(c4.events.filter((e) => e.c === 'AAPL' && e.k === 'earn' && e.d === '20261102').length, 1);
    // 읽는 방식이 바뀌면(pv) 3시간을 기다리지 않고 바로, 기억한 본문 결과를 버리고 다시 받는다 — 옛 판에서 일정이 모두 0건이던 기억(20차 배포 직후 실제 상태)
    writeData(root, 'calendar.json', { ...c4, pv: 1, docs: Object.fromEntries(Object.keys(c4.docs).map((k) => [k, []])), diag: undefined });
    await pipeline(root, { dartRows: rows, dartDocs }, NOW_KR + 7 * 3600e3, { calendar: true });
    const c5 = read(root, 'calendar.json');
    assert.equal(c5.pv, cal.PARSER_V);
    assert.equal(NET.calls.filter((u) => /document\.xml/.test(u)).length, 8, '기억한 본문을 모두 다시 받음');
    assert.equal(c5.events.filter((e) => e.k === 'ir' && e.d === '20261029').length, 1, '다시 받은 본문으로 IR 일정 복구');
  });
  // 공시 키가 없으면 미국만
  const r2 = workspace();
  await pipeline(r2, {}, NOW_KR, { calendar: true });
  const c2 = read(r2, 'calendar.json');
  assert.equal(c2.kr, 'off');
  assert.ok(c2.events.length > 0 && c2.events.every((e) => e.m === 'US'));
  assert.equal(NET.calls.filter((u) => /opendart/.test(u)).length, 0);
});
await test('공시 일정 화면(calendar.js): 달 칸(일요일 시작·5~6주) · D-day · 올해가 아니면 연도 · 시장·종목·종류 거르기 · 칸 문구 · 원문 주소', async () => {
  const vm = await import('node:vm');
  const js = fs.readFileSync(new URL('../docs/calendar.js', import.meta.url), 'utf8');
  const block = js.slice(js.indexOf('// ---------- 계산'), js.indexOf('// ---------- 화면'));
  const f = vm.runInNewContext(`${block}; ({ monthCells, ddayLabel, fmtDay, passFilter, cellWord, sourceUrl, kstToday, groupOf, byDate })`, {});
  const oct = f.monthCells(2026, 10);
  assert.equal(oct.length, 35, '10월 2026은 5주');
  assert.equal(oct[0].d, '20260927', '첫 칸 = 10/1(목) 앞 일요일');
  assert.equal(oct.find((c) => c.d === '20261001').dow, 4);
  assert.equal(oct.filter((c) => c.inMonth).length, 31);
  assert.equal(f.monthCells(2026, 8).length, 42, '8월 2026(토요일 1일)은 6주');
  assert.equal(f.monthCells(2027, 2)[0].d, '20270131', '해 넘김');
  assert.equal(f.ddayLabel('20261023', '20261023'), '오늘');
  assert.equal(f.ddayLabel('20261024', '20261023'), '내일');
  assert.equal(f.ddayLabel('20261029', '20261023'), 'D-6');
  assert.equal(f.ddayLabel('20261020', '20261023'), '3일 전');
  assert.equal(f.ddayLabel('20270122', '20261023'), 'D-91', '해 넘어서도 날 수');
  assert.equal(f.fmtDay('20261029', '20261023'), '10월 29일 (목)');
  assert.equal(f.fmtDay('20270122', '20261023'), '2027년 1월 22일 (금)', '올해가 아니면 연도');
  assert.equal(f.kstToday(Date.parse('2026-10-22T15:30:00Z')), '20261023', '한국 날짜(자정 넘음)');
  const ev = [{ d: '20261029', c: '034020', m: 'KR', k: 'earn', t: '3분기 실적 발표 예정' }, { d: '20261029', c: '034020', m: 'KR', k: 'ir', t: '기업설명회(IR)' },
    { d: '20261029', c: '329180', m: 'KR', k: 'meet', t: '주총 기준일' }, { d: '20261102', c: 'AAPL', m: 'US', k: 'earn', t: '실적 발표(예상일)' },
    { d: '20261015', c: '005930', m: 'KR', k: 'disc', t: '단일판매ㆍ공급계약체결', tag: '계약', no: '20261015000321' }, { d: '20261106', c: '329180', m: 'KR', k: 'rec', t: '권리 기준일' }];
  const flt = (mkt, code, groups) => ev.filter((e) => f.passFilter(e, { mkt, code, groups: new Set(groups) })).map((e) => `${e.c}:${e.k}`);
  assert.deepEqual(flt('all', '', ['earn', 'ir', 'div', 'meet', 'cap']), ['034020:earn', '034020:ir', '329180:meet', 'AAPL:earn', '329180:rec'], '기본은 지난 공시 숨김 · 권리 기준일은 주총·기준일 묶음');
  assert.deepEqual(flt('US', '', ['earn', 'ir', 'div', 'meet', 'cap', 'disc']), ['AAPL:earn']);
  assert.deepEqual(flt('all', '329180', ['meet']), ['329180:meet', '329180:rec']);
  assert.deepEqual(flt('KR', '', ['disc']), ['005930:disc']);
  assert.deepEqual(ev.map(f.cellWord), ['실적', 'IR', '기준일', '실적', '계약 공시', '기준일']);
  assert.equal(f.cellWord({ k: 'disc', tag: '예고' }), '실적 예고');
  assert.equal(f.cellWord({ k: 'disc', tag: '기타' }), '공시');
  assert.equal(f.cellWord({ k: 'div', t: '배당락' }), '배당락');
  assert.equal(f.cellWord({ k: 'div', t: '배당 지급' }), '배당 지급');
  assert.equal(f.cellWord({ k: 'cap', t: '자사주 매입 시작' }), '자사주');
  assert.equal(f.cellWord({ k: 'cap', t: '무상증자 신주 상장' }), '증자');
  assert.equal(f.sourceUrl(ev[4]), 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261015000321');
  assert.equal(f.sourceUrl(ev[3]), 'https://www.nasdaq.com/market-activity/stocks/aapl/earnings');
  assert.equal(f.sourceUrl({ m: 'US', c: 'AAPL', k: 'div' }), 'https://www.nasdaq.com/market-activity/stocks/aapl/dividend-history');
  assert.equal(f.sourceUrl({ m: 'US', c: 'javascript:alert(1)', k: 'earn' }), '', '이상한 코드는 주소를 만들지 않음');
  assert.deepEqual([...f.byDate(ev).keys()], ['20261029', '20261102', '20261015', '20261106']);
});
await test('공시 도구: ZIP(압축·무압축·데이터 설명자) 속 XML · 본문 파일 고르기 · 글자는 바이트로 판단 · 상장사만 표로 · 우선주는 보통주 회사 · 종류 판정 · 한국 날짜', () => {
  const xml = corpXml();
  for (const opt of [{}, { method: 0 }, { descriptor: true }]) {
    assert.equal(dartm.unzipXml(makeZip([['안내.txt', '설명'], ['CORPCODE.xml', xml]], opt)), xml, JSON.stringify(opt));
  }
  assert.throws(() => dartm.unzipXml(Buffer.from('<result><status>010</status></result>')), /ZIP 형식이 아님/);
  assert.throws(() => dartm.unzipXml(makeZip([['a.txt', 'x']])), /XML 없음/);
  // 글자는 바이트로 판단 — XML 선언이 없거나 실제와 달라도('공시' EUC-KR = B0F8 BDC3)
  const euc = Buffer.from([0xb0, 0xf8, 0xbd, 0xc3]);
  const eucDoc = (head) => makeZip([['doc.xml', Buffer.concat([Buffer.from(`${head}<P>`), euc, Buffer.from('</P>')])]]);
  assert.match(dartm.unzipXml(eucDoc('<?xml version="1.0" encoding="euc-kr"?>')), /<P>공시<\/P>/, 'EUC-KR');
  assert.match(dartm.unzipXml(eucDoc('')), /<P>공시<\/P>/, '선언 없는 EUC-KR');
  assert.match(dartm.unzipXml(eucDoc('<?xml version="1.0" encoding="utf-8"?>')), /<P>공시<\/P>/, 'UTF-8이라고 선언한 EUC-KR');
  assert.match(dartm.unzipXml(makeZip([['doc.xml', '<?xml version="1.0" encoding="euc-kr"?><P>공시</P>']])), /<P>공시<\/P>/, 'EUC-KR이라고 선언한 UTF-8');
  assert.equal(dartm.decodeBytes(Buffer.from('<?xml version="1.0"?><A>2026-10-29</A>')).enc, 'utf8', '영문·숫자뿐이면 UTF-8');
  assert.equal(dartm.decodeBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<P>공시</P>', 'utf16le')])).text, '<P>공시</P>', 'BOM 있는 UTF-16');
  const broken = dartm.decodeBytes(Buffer.concat([Buffer.from('<P>결산실적 공시예정일</P>'), Buffer.from([0xff]), Buffer.from('<P>기업설명회 일시</P>')]));
  assert.deepEqual([broken.enc, /결산실적 공시예정일/.test(broken.text), /기업설명회 일시/.test(broken.text)], ['utf8(깨짐)', true, true], '한 바이트 깨진 UTF-8은 UTF-8로');
  assert.match(dartm.decodeBytes(Buffer.concat([Buffer.from('<P>결과</P>'), Buffer.from([0xff])])).text, /<P>결과<\/P>/, '짧은 글도 — 잘못 읽어 한자가 쏟아지는 쪽은 감점');
  // 본문 파일 고르기 — '{접수번호}.xml' · 첨부(번호 붙은 파일) 제외 · 그 밖엔 가장 큰 것
  const no = '20261022000123', big = (w) => `<A>${w.repeat(50)}</A>`;
  assert.equal(dartm.unzipXml(makeZip([[`${no}_00760.xml`, big('첨부 ')], [`${no}.xml`, '<A>본문</A>']]), no), '<A>본문</A>', '첨부가 앞에 있고 더 커도 본문');
  assert.equal(dartm.unzipXml(makeZip([[`${no}.xml`, '<A>본문</A>'], ['cover.xml', big('표지 ')]]), no), '<A>본문</A>', '이름이 접수번호인 파일');
  assert.equal(dartm.unzipXml(makeZip([['x_00760.xml', big('첨부 ')], ['y.xml', '<A>본문</A>']])), '<A>본문</A>', '접수번호를 몰라도 첨부는 피함');
  assert.equal(dartm.unzipXml(makeZip([['cover.xml', '<A>표지</A>'], ['main.xml', big('본문 ')]])), big('본문 '), '그 밖엔 가장 큰 파일');
  const map = dartm.parseCorpXml(xml);
  assert.equal(Object.keys(map).length, 1102, '비상장사(종목코드 빈칸) 제외');
  assert.equal(map['005930'], '00126380');
  assert.equal(dartm.corpOf(map, '005935'), '00126380', '우선주 → 보통주 회사');
  assert.equal(dartm.corpOf(map, '005936'), null);
  assert.equal(dartm.corpOf(map, 'AAPL'), null);
  const titles = ['단일판매ㆍ공급계약체결', '연결재무제표기준영업(잠정)실적(공정공시)', '유상증자결정', '자기주식취득결정', '현금ㆍ현물배당결정',
    '회사합병결정', '횡령ㆍ배임혐의발생', '조회공시요구(현저한시세변동)에대한답변', '반기보고서 (2026.06)', '임원ㆍ주요주주특정증권등소유상황보고서',
    '기업설명회(IR)개최(안내공시)', '투자판단관련주요경영사항', '주주총회소집공고',
    '결산실적공시예고(안내공시)', '전환청구권행사', '불성실공시법인지정예고']; // 아래 3건은 배포 후 실제 공시 제목에서 발견
  assert.deepEqual(titles.map(dartm.tagOf), ['계약', '실적', '증자·사채', '자사주', '배당', 'M&A', '위험', '해명', '정기보고', '지분', 'IR', '주요사항', '기타',
    '예고', '증자·사채', '위험']);
  assert.equal(dartm.kstYmd(T('2026-10-15T15:30:00Z')), '20261016', '한국은 이미 다음 날 00:30');
});
await test('공시(OpenDART): 키 있을 때만 · 국내 종목만(ETF 제외·우선주는 보통주 회사) · 2주 · 철회 제외 · 최신 5건 · 종류 · 키는 파일·로그에 없음', async () => {
  const off = workspace();
  await pipeline(off);
  assert.equal(callsTo(/opendart/), 0, '키 없음 → 요청 0건');
  assert.ok(!fs.existsSync(file(off, 'disclosures.json')) && !('dart' in read(off, 'status.json')), '키 없음 → 파일·상태 그대로');
  await withDartKey(async () => {
    const items5 = [...ITEMS, { code: '069500', market: 'KR', name: 'KODEX 200' }, { code: '005935', market: 'KR', name: '삼성전자우' }];
    const root = workspace(items5);
    const { lines } = await pipeline(root);
    assert.equal(callsTo(/corpCode\.xml/), 1);
    const lists = NET.calls.filter((u) => /list\.json/.test(u)).map((u) => new URL(u));
    assert.deepEqual(lists.map((u) => u.searchParams.get('corp_code')).sort(), ['00126380', '00126380', '00164779'], 'ETF·미국 종목은 요청 안 함');
    assert.deepEqual(['bgn_de', 'end_de', 'last_reprt_at'].map((k) => lists[0].searchParams.get(k)), ['20261001', '20261015', 'Y']);
    const d = read(root, 'disclosures.json');
    assert.deepEqual(Object.keys(d).sort(), ['000660', '005930', '005935']);
    assert.deepEqual(d['005930'].items, [
      { title: '단일판매ㆍ공급계약체결', date: '20261015', no: '20261015000321', tag: '계약', key: true },
      { title: '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)', date: '20261015', no: '20261015000100', tag: '실적', key: true },
      { title: '임원ㆍ주요주주특정증권등소유상황보고서', date: '20261014', no: '20261014000500', tag: '지분' },
      { title: '현금ㆍ현물배당결정', date: '20261013', no: '20261013000200', tag: '배당', key: true },
      { title: '기업설명회(IR)개최(안내공시)', date: '20261010', no: '20261010000050', tag: 'IR' },
    ]);
    assert.deepEqual(d['005935'], d['005930']);
    assert.deepEqual(d['000660'].items.map((x) => x.tag), ['지분']);
    const corp = read(root, 'dartcorp.json');
    assert.equal(corp.map['005930'], '00126380');
    assert.deepEqual([corp.at, corp.tried, corp.none], [NOW_KR, NOW_KR, ['069500']]);
    assert.equal(read(root, 'status.json').dart, 'ok');
    for (const f of fs.readdirSync(path.join(root, 'docs', 'data'))) assert.ok(!raw(root, f).includes(DART_KEY), `${f}에 키 없음`);
    assert.ok(!lines.join('\n').includes(DART_KEY), '로그에 키 없음');
    await pipeline(root, {}, NOW_KR + 5 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 0, '표가 새것 → 다시 받지 않음');
    await pipeline(root, {}, NOW_KR + 7 * 60 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 0, 'ETF는 없음 목록에 기억 → 6시간이 지나도 다시 받지 않음');
    fs.writeFileSync(path.join(root, 'config', 'watchlist.json'), JSON.stringify({ items: [...items5, { code: '123456', market: 'KR', name: '새 종목' }] }));
    await pipeline(root, {}, NOW_KR + 7 * 60 * MIN + 5 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 1, '표에 없는 새 종목 → 다시 받음');
    assert.deepEqual(read(root, 'dartcorp.json').none, ['069500', '123456']);
    await pipeline(root, {}, NOW_KR + 8 * 1440 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 1, '7일 지나면 다시 받음');
  });
});
await test('공시 오류: 키 오류면 이유 기록·30분 뒤 재시도 · 한도 초과면 그 회차 중단 · 공시 없음·일시 오류는 종목별로', async () => {
  await withDartKey(async () => {
    const root = workspace();
    const keyErr = () => text('<?xml version="1.0" encoding="UTF-8"?>\n<result><status>010</status><message>등록되지 않은 키입니다.</message></result>');
    await pipeline(root, { corpZip: keyErr });
    assert.equal(callsTo(/list\.json/), 0, '고유번호 표가 없으면 목록 요청 안 함');
    assert.equal(read(root, 'status.json').dart, '등록되지 않은 인증키(010)');
    assert.deepEqual([read(root, 'dartcorp.json').at, read(root, 'dartcorp.json').tried], [null, NOW_KR]);
    await pipeline(root, { corpZip: keyErr }, NOW_KR + 20 * MIN);
    assert.equal(callsTo(/corpCode\.xml/), 0, '30분 안에는 다시 받지 않음');
    await pipeline(root, {}, NOW_KR + 31 * MIN); // 키를 고친 뒤
    assert.equal(callsTo(/corpCode\.xml/), 1);
    assert.equal(read(root, 'status.json').dart, 'ok');
    const before = read(root, 'disclosures.json');
    assert.equal(before['005930'].items.length, 5);
    await pipeline(root, { dartList: () => json({ status: '020', message: '요청 제한을 초과하였습니다.' }) }, NOW_KR + 45 * MIN);
    assert.equal(callsTo(/list\.json/), 1, '첫 요청에서 멈춤');
    assert.deepEqual(read(root, 'disclosures.json'), before, '직전 값 유지');
    assert.equal(read(root, 'status.json').dart, '하루 요청 한도 초과(020)');
    const mixed = (corp) => (corp === '00126380' ? text('error', 500) : json({ status: '013', message: '조회된 데이타가 없습니다.' }));
    await pipeline(root, { dartList: mixed }, NOW_KR + 60 * MIN);
    const d = read(root, 'disclosures.json');
    assert.deepEqual(d['005930'], before['005930'], '일시 오류 → 그 종목만 직전 값');
    assert.deepEqual(d['000660'], { ok: true, items: [] }, '기간 안에 공시 없음');
    assert.equal(read(root, 'status.json').dart, 'ok', '일시 오류는 중단 사유가 아님');
    const bad = workspace();
    await pipeline(bad, { corpZip: () => new Response(makeZip([['CORPCODE.xml', corpXml().slice(0, 3000)]])) });
    assert.match(read(bad, 'status.json').dart, /고유번호 목록 받기 실패 — 고유번호 목록이 너무 적음/, '잘린 목록은 쓰지 않음');
    assert.deepEqual(read(bad, 'dartcorp.json').map, {});
  });
});
await test('공시 → AI 분석: 국내 급등락 종목 요청에 최근 공시(오늘 표시) · 새 공시면 다시 분석 · 키 없으면 예전 그대로', async () => {
  const stockBodies = () => NET.bodies.filter((b, i) => isGemini(NET.calls[i]) && b.includes("'삼성전자'"));
  const plain = workspace();
  await pipeline(plain);
  assert.ok(stockBodies().length === 1 && !stockBodies()[0].includes('최근 공시'), '키 없음 → 공시 줄 없음');
  assert.ok(!read(plain, 'analysis.json')['005930'].sig.includes('|d:'), '시그니처도 예전 형식');
  await withDartKey(async () => {
    const root = workspace();
    await pipeline(root);
    const body = stockBodies()[0];
    assert.ok(body.includes('최근 공시(전자공시 2주, 최신순)') && body.includes('- 오늘 [계약] 단일판매ㆍ공급계약체결')
      && body.includes('- 10/13 [배당] 현금ㆍ현물배당결정') && body.includes('뉴스+공시+수급+추세'), body.slice(0, 800));
    assert.ok(read(root, 'analysis.json')['005930'].sig.endsWith('|d:20261015000321,20261015000100,20261014000500'));
    await pipeline(root, {}, NOW_KR + 5 * MIN);
    assert.equal(stockBodies().length, 0, '같은 공시 → 재사용');
    const rows = { ...DART_ROWS, '00126380': [['20261015000999', '투자판단관련주요경영사항'], ...DART_ROWS['00126380']] };
    await pipeline(root, { dartRows: rows }, NOW_KR + 10 * MIN);
    assert.equal(stockBodies().length, 1, '새 공시 → 다시 분석');
  });
});
await test('다음 분석 가능 시각: 리셋 직후·모델 수·몫 소진·지금 가능·주말·쓸 모델 없음', () => {
  const mk = (ms, used = {}) => ({ ...bud.startBudget(null, ms), used });
  assert.equal(bud.nextAllowanceAt(mk(NOW_EVE), ['a', 'b'], NOW_EVE), T('2026-10-14T14:12:00Z'), '미국장 시작 42분 뒤(23:12 KST)');
  assert.equal(bud.nextAllowanceAt(mk(NOW_EVE), ['a', 'b', 'c'], NOW_EVE), T('2026-10-14T13:58:00Z'), '모델 3개면 더 빨리(22:58 KST)');
  assert.equal(bud.nextAllowanceAt(mk(NOW_KR, { a: 12, b: 10 }), ['a', 'b'], NOW_KR), T('2026-10-15T03:07:00Z'), '몫을 다 썼으면 7분 뒤');
  assert.equal(bud.nextAllowanceAt(mk(NOW_KR), ['a', 'b'], NOW_KR), NOW_KR, '지금 쓸 수 있으면 지금');
  assert.equal(bud.nextAllowanceAt(mk(NOW_KR, { a: 20, b: 19 }), ['a', 'b'], NOW_KR), T('2026-10-15T06:00:00Z'), '거의 다 썼으면 리셋 1시간 전(15:00 KST)');
  assert.equal(bud.nextAllowanceAt(mk(T('2026-10-18T03:00:00Z')), ['a', 'b'], T('2026-10-18T03:00:00Z')), T('2026-10-18T06:00:00Z'), '일요일 — 리셋 1시간 전(15:00 KST)');
  assert.equal(bud.nextAllowanceAt({ ...mk(NOW_KR), out: { a: 'quota', b: 'quota' } }, ['a', 'b'], NOW_KR), null);
});

// ===== 종목 검색 목록(stocklist) =====
// 국내: 네이버 시가총액 목록(KOSPI 150개 = 2쪽, KOSDAQ 30개, 형식이 다른 코드 1개 섞음) / KIND(EUC-KR 표)
// 시가총액(억원, 쉼표 문자열): KOSPI i번째 (150−i)×1000, 맨 앞 005930은 9,000,000 / KOSDAQ i번째 (30−i)×3000+500
//  → 합친 시가총액 순위: 005930 1위, KOSDAQ 첫 종목(90,500)은 KOSPI 1~59번째(149,000~91,000) 다음인 61위
// caps: 'normal' | 'none'(시가총액 값 없음) | 'flip'(KOSDAQ이 모두 더 큼 — 순위만 바뀐 상황)
const krCap = (market, i, caps) => {
  if (caps === 'none') return undefined;
  if (market === 'KOSPI') return i === 0 ? 9000000 : (150 - i) * 1000;
  return caps === 'flip' ? 20000000 - i : (30 - i) * 3000 + 500;
};
const krPage = (market, page, caps = 'normal') => {
  const total = market === 'KOSPI' ? 150 : 30;
  const from = (page - 1) * 100, to = Math.min(total, page * 100);
  const stocks = [];
  for (let i = from; i < to; i++) {
    const cap = krCap(market, i, caps);
    stocks.push({ itemCode: i === 0 && market === 'KOSPI' ? '005930' : String((market === 'KOSPI' ? 100000 : 200000) + i),
      stockName: i === 0 && market === 'KOSPI' ? '삼성전자' : `${market}종목${i}`, stockEndType: 'stock',
      ...(cap === undefined ? {} : { marketValue: cap.toLocaleString('en-US') }) });
  }
  if (market === 'KOSDAQ' && page === 1) stocks.push({ itemCode: '0000J0', stockName: '새형식코드', stockEndType: 'stock', marketValue: '1' });
  return { stocks, totalCount: total };
};
const EUCKR_SAMSUNG = [0xBB, 0xEF, 0xBC, 0xBA, 0xC0, 0xFC, 0xC0, 0xDA]; // '삼성전자'
function kindBytes(market) {
  const enc = (s) => [...Buffer.from(s, 'latin1')];
  const rows = [enc('<tr><td>'), EUCKR_SAMSUNG, enc('</td><td>KOSPI</td><td>005930</td><td>x</td></tr>')].flat();
  const more = Array.from({ length: 12 }, (_, i) => enc(`<tr><td>KIND ${market} Corp ${i}</td><td>${market}</td><td>${String((market === 'KOSPI' ? 300000 : 400000) + i)}</td></tr>`)).flat();
  const head = enc('<html><head><meta http-equiv="Content-Type" content="text/html; charset=EUC-KR"></head><table><tr><th>name</th><th>code</th></tr>');
  return Uint8Array.from([...head, ...(market === 'KOSPI' ? rows : []), ...more, ...enc('</table></html>')]);
}
const NASDAQ_TXT = [
  'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
  'NVDA|NVIDIA Corporation - Common Stock|Q|N|N|100|N|N',
  'AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N',
  'GOOGL|Alphabet Inc. - Class A Common Stock|Q|N|N|100|N|N',
  'QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N',
  'PLUG|Plug Power, Inc. - Common Stock|Q|N|N|100|N|N',
  'ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N',
  'ABCDW|ABC Acquisition Corp - Warrants|S|N|N|100|N|N',
  'ABCDU|ABC Acquisition Corp - Units|S|N|N|100|N|N',
  'File Creation Time: 1015202608:00|||||||',
].join('\r\n');
const OTHER_TXT = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'BRK.B|Berkshire Hathaway Inc. Class B Common Stock|N|BRK.B|N|100|N|BRK.B',
  'KO|Coca-Cola Company (The) Common Stock|N|KO|N|100|N|KO',
  'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
  'BAC$K|Bank of America Corporation 6.45% Preferred Stock|N|BACpK|N|100|N|BAC-K',
  'XYZP|XYZ Corp 5% Series A Preferred Stock|N|XYZP|N|100|N|XYZP',
  'File Creation Time: 1015202608:00|||||||',
].join('\n');
// 네이버 해외 목록(시가총액 순) — 합친 순위: NVDA 1 · AAPL 2 · BRK-B 3 · KO 4 · PLUG 5 (GOOGL·QQQ·SPY는 목록 밖 → 순위 없음)
const US_KO = { NASDAQ: [{ symbolCode: 'NVDA', stockName: '엔비디아', stockNameEng: 'NVIDIA Corp', marketValue: '4,500' }, { symbolCode: 'AAPL', stockName: '애플', marketValue: '3,500' },
  { symbolCode: 'PLUG', stockName: '플러그 파워', marketValue: '5' }],
  NYSE: [{ symbolCode: 'BRK.B', stockName: '버크셔 해서웨이 B', marketValue: '1,000' }, { symbolCode: 'KO', stockName: 'Coca-Cola', marketValue: '300' }] };
function listRoutes({ naverKr = true, kind = true, nasdaq = true, usKo = true, caps = 'normal' } = {}) {
  const fail = () => text('blocked', 403);
  return [
    { re: /m\.stock\.naver\.com\/api\/stocks\/marketValue\/(KOSPI|KOSDAQ)\?page=(\d+)/, fn: (m) => (naverKr ? json(krPage(m[1], +m[2], caps)) : fail()) },
    { re: /kind\.krx\.co\.kr\/corpgeneral\/corpList\.do\?.*marketType=(stockMkt|kosdaqMkt)/, fn: (m) => (kind ? new Response(kindBytes(m[1] === 'stockMkt' ? 'KOSPI' : 'KOSDAQ'), { headers: { 'content-type': 'text/html; charset=euc-kr' } }) : fail()) },
    { re: /nasdaqtrader\.com\/dynamic\/SymDir\/(nasdaqlisted|otherlisted)\.txt/, fn: (m) => (nasdaq ? text(m[1] === 'nasdaqlisted' ? NASDAQ_TXT : OTHER_TXT) : fail()) },
    { re: /api\.stock\.naver\.com\/stock\/exchange\/(NASDAQ|NYSE|AMEX)\/marketValue\?page=(\d+)/, fn: (m) => (usKo && US_KO[m[1]] && m[2] === '1' ? json({ stocks: US_KO[m[1]] }) : text('not found', 404)) },
  ];
}
async function buildList(root, opts, buildOpts = {}) {
  NET.routes = listRoutes(opts); NET.calls = []; NET.bodies = []; NET.blocked = [];
  return quiet(() => stocklist.build({ root, now: NOW_KR, minKr: 10, minUs: 3, ...buildOpts }));
}
const listOf = (root) => read(root, 'stocklist.json');
const usRow = (l, sym) => l.us.find((r) => r[0] === sym);

await test('검색 목록: 네이버 국내(쪽 넘김·새 형식 코드 제외) + 미국 디렉터리(시험·워런트·유닛·우선주 제외) + 한글명', async () => {
  const root = workspace();
  const { value } = await buildList(root);
  assert.equal(value.written, true);
  const l = listOf(root);
  assert.equal(l.kr.length, 180, 'KOSPI 150 + KOSDAQ 30');
  assert.deepEqual(l.kr.find((r) => r[0] === '005930'), ['005930', '삼성전자', 'KOSPI', 1], '시가총액 1위');
  assert.ok(!l.kr.some((r) => r[0] === '0000J0'), '6자리 숫자가 아닌 코드는 제외(파이프라인이 처리 못함)');
  const krRank = (code) => l.kr.find((r) => r[0] === code)[3];
  assert.deepEqual([krRank('200000'), krRank('100060')], [61, 62], '두 시장을 합쳐 시가총액 순(코스닥 1위 90,500 > 코스피 90,000)');
  assert.deepEqual(l.kr.map((r) => r[3]).sort((a, b) => a - b), Array.from({ length: 180 }, (_, i) => i + 1), '순위는 1~180 빠짐없이');
  assert.deepEqual(l.us.map((r) => r[0]).sort(), ['AAPL', 'BRK-B', 'GOOGL', 'KO', 'NVDA', 'PLUG', 'QQQ', 'SPY']);
  assert.deepEqual(usRow(l, 'NVDA'), ['NVDA', '엔비디아', 'NVIDIA Corporation', 'NASDAQ', 1], '한글명은 네이버 우선 · 시가총액 1위');
  assert.deepEqual(usRow(l, 'PLUG'), ['PLUG', '플러그 파워', 'Plug Power, Inc.', 'NASDAQ', 5], '네이버 이름이 별칭보다 우선');
  assert.deepEqual(usRow(l, 'GOOGL'), ['GOOGL', '알파벳 A(구글)', 'Alphabet Inc. Class A', 'NASDAQ'], '네이버에 없으면 기본 별칭 · 순위 없음');
  assert.deepEqual(usRow(l, 'BRK-B'), ['BRK-B', '버크셔 해서웨이 B', 'Berkshire Hathaway Inc. Class B', 'NYSE', 3], 'BRK.B → 야후 표기 BRK-B · 거래소 합쳐 순위');
  assert.deepEqual(usRow(l, 'KO'), ['KO', '코카콜라', 'Coca-Cola Company (The)', 'NYSE', 4], '한글이 아닌 이름은 별칭으로');
  assert.equal(usRow(l, 'SPY')[3], 'NYSE Arca ETF');
  assert.equal(usRow(l, 'QQQ')[3], 'NASDAQ ETF');
  assert.deepEqual([l.meta.src.KOSPI, l.meta.src.KOSDAQ, l.meta.src.US, l.meta.src.krCap, l.meta.src.usCap], ['naver-KOSPI:150', 'naver-KOSDAQ:30', 'nasdaqtrader:8', 180, 5]);
  assert.equal(l.v, 2);
  assert.equal(NET.blocked.length, 0, `차단된 호출: ${NET.blocked.join(', ')}`);
});
await test('검색 목록: 네이버 국내가 막히면 KRX KIND(EUC-KR) 목록으로 · 한글명 소스가 막혀도 별칭으로', async () => {
  const root = workspace();
  await buildList(root, { naverKr: false, usKo: false });
  const l = listOf(root);
  assert.deepEqual(l.kr.find((r) => r[0] === '005930'), ['005930', '삼성전자', 'KOSPI'], 'EUC-KR 한글 해독');
  assert.equal(l.kr.length, 25, 'KOSPI 13 + KOSDAQ 12');
  assert.equal(l.meta.src.KOSPI, 'kind-KOSPI:13');
  assert.ok(l.kr.every((r) => r.length === 3), 'KIND엔 시가총액이 없어 순위 없음');
  assert.deepEqual(usRow(l, 'NVDA'), ['NVDA', '엔비디아', 'NVIDIA Corporation', 'NASDAQ'], '별칭 · 순위 없음');
  assert.equal(usRow(l, 'SPY')[1], 'SPDR S&P500 ETF');
});
await test('검색 목록: 너무 적거나 실패한 시장은 기존 목록 유지 · 전부 실패면 파일 그대로 · 내용이 같으면 다시 안 씀', async () => {
  const root = workspace();
  await buildList(root);
  const first = raw(root, 'stocklist.json');
  const again = await buildList(root, {}, { now: NOW_KR + 86400e3 });
  assert.equal(again.value.written, false, '날짜만 바뀐 재생성은 쓰지 않음');
  assert.equal(raw(root, 'stocklist.json'), first);
  const allFail = await buildList(root, { naverKr: false, kind: false, nasdaq: false, usKo: false });
  assert.equal(allFail.value.written, true, '소스 상태(실패)는 기록');
  const l = listOf(root);
  assert.equal(l.kr.length, 180, '국내 기존 목록 유지');
  assert.equal(l.us.length, 8, '미국 기존 목록 유지');
  assert.equal(l.kr.find((r) => r[0] === '005930')[3], 1, '유지한 목록의 순위도 그대로');
  assert.equal(l.meta.src.krKept, true);
  const empty = workspace();
  const none = await buildList(empty, { naverKr: false, kind: false, nasdaq: false });
  assert.equal(none.value.written, false);
  assert.equal(fs.existsSync(file(empty, 'stocklist.json')), false, '만들 게 없으면 파일을 만들지 않음');
  const few = await buildList(workspace(), {}, { minKr: 500 });
  assert.equal(few.value.kr, 0, '기준(500)보다 적으면 국내는 기존(없음) 유지');
});

await test('검색 순위: 시가총액 값이 없으면 목록 순서 · 순위만 바뀐 건 7일마다 반영 · 한글명 유지 · 옛 형식은 바로 갱신', async () => {
  const rk = (l, code) => l.kr.find((r) => r[0] === code)[3];
  const none = workspace();
  await buildList(none, { caps: 'none' });
  const ln = listOf(none);
  assert.deepEqual([rk(ln, '005930'), rk(ln, '200000'), rk(ln, '100001'), rk(ln, '200001')], [1, 2, 3, 4], '값이 없으면 시장별 목록 순서를 번갈아(같은 순번은 코스피 먼저)');
  assert.equal(ln.meta.src.krCap, 0);

  const root = workspace();
  await buildList(root);
  assert.equal(rk(listOf(root), '200000'), 61);
  const flip1 = await buildList(root, { caps: 'flip' }, { now: NOW_KR + 86400e3 });
  assert.equal(flip1.value.written, false, '종목·이름이 같고 순위만 바뀌면 7일 안에는 다시 쓰지 않음');
  const flip8 = await buildList(root, { caps: 'flip' }, { now: NOW_KR + 8 * 86400e3 });
  assert.equal(flip8.value.written, true, '7일이 지나면 순위 갱신');
  assert.equal(rk(listOf(root), '200000'), 1, '코스닥이 모두 커진 순위 반영');
  // 네이버 해외 목록이 막혀도 전에 받은 한글명은 그대로(별칭으로 바뀌지 않음) — 순위만 빠짐
  const noKo = await buildList(root, { caps: 'flip', usKo: false }, { now: NOW_KR + 9 * 86400e3 });
  assert.equal(noKo.value.written, false, '이름이 그대로라 바뀐 것 없음');
  const noKo2 = await buildList(root, { caps: 'flip', usKo: false }, { now: NOW_KR + 16 * 86400e3 });
  assert.equal(noKo2.value.written, true);
  assert.deepEqual(usRow(listOf(root), 'PLUG'), ['PLUG', '플러그 파워', 'Plug Power, Inc.', 'NASDAQ'], '네이버 한글명 유지 · 순위 없음');

  // 옛 형식(v1, 순위 없음) 파일은 내용이 같아도 바로 새 형식으로
  const old = workspace();
  await buildList(old);
  const v1 = listOf(old);
  writeData(old, 'stocklist.json', { v: 1, kr: v1.kr.map((r) => r.slice(0, 3)), us: v1.us.map((r) => r.slice(0, 4)), meta: v1.meta });
  const up = await buildList(old, {}, { now: NOW_KR + 3600e3 });
  assert.equal(up.value.written, true);
  assert.deepEqual([listOf(old).v, rk(listOf(old), '005930')], [2, 1]);
});

// ===== 종목 편집 요청 반영(watchlist-apply) =====
const issueBody = (req) => `대시보드에서 보낸 변경 요청입니다.\n\n\`\`\`json\n${typeof req === 'string' ? req : JSON.stringify(req)}\n\`\`\`\n`;
function applyIn(root, body) {
  const out = path.join(root, 'gh-output.txt'), res = path.join(root, 'result.md');
  const log = console.log;
  console.log = () => {}; // 결과 요약 출력은 감춘다(파일로 확인)
  let r;
  try { r = wl.run({ root, body, outputFile: out, resultFile: res }); } finally { console.log = log; }
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'watchlist.json'), 'utf8')); } catch {}
  return { ...r, output: fs.readFileSync(out, 'utf8'), result: fs.readFileSync(res, 'utf8'), cfg };
}
const cfgRaw = (root) => fs.readFileSync(path.join(root, 'config', 'watchlist.json'), 'utf8');

await test('종목 편집 반영: 추가·삭제 · 형식 오류·중복 건너뜀 · 없는 종목 삭제 알림 · 한 줄에 한 종목 형식', async () => {
  const root = workspace();
  const r = applyIn(root, issueBody({
    add: [{ code: 'NVDA', market: 'US', name: '엔비디아' }, { code: 'ABC123', market: 'KR', name: '오타' }, { code: '005930', market: 'KR', name: '삼성전자' }],
    remove: ['000660', 'ZZZZ'],
  }));
  assert.equal(r.changed, true);
  assert.equal(r.output, 'changed=true\n');
  assert.deepEqual(r.cfg.items.map((x) => x.code), ['005930', 'AAPL', 'NVDA']);
  assert.ok(r.result.includes('추가: 엔비디아(NVDA)'), r.result);
  assert.ok(r.result.includes('삭제: SK하이닉스(000660)'));
  assert.ok(r.result.includes('ABC123(코드 형식 오류)') && r.result.includes('005930(이미 있음)'));
  assert.ok(r.result.includes('목록에 없어 삭제하지 않음: ZZZZ'));
  assert.equal(cfgRaw(root).split('\n').filter((l) => l.includes('"code"')).length, 3, '한 줄에 한 종목');
  assert.ok(cfgRaw(root).includes('{ "code": "NVDA", "market": "US", "name": "엔비디아" }'));
  // 깃허브 웹 양식으로 만든 이슈는 줄바꿈이 CRLF — 같은 요청으로 읽혀야 한다
  const crlf = applyIn(workspace(), issueBody({ add: [{ code: 'NVDA', market: 'US', name: '엔비디아' }] }).replace(/\n/g, '\r\n'));
  assert.equal(crlf.changed, true);
  assert.ok(crlf.cfg.items.some((x) => x.code === 'NVDA'));
});
await test('종목 편집 반영: 최대 60개 · 소문자 티커·숫자 코드 보정 · 이름 속 @멘션·서식 순화', async () => {
  const items = Array.from({ length: 59 }, (_, i) => ({ code: String(100000 + i), market: 'KR', name: `종목${i}` }));
  const root = workspace(items);
  const r = applyIn(root, issueBody({ add: [{ code: 'msft', name: '@everyone `x`' }, { code: 'AAPL' }, { code: 'TSLA' }] }));
  assert.equal(r.cfg.items.length, 60);
  assert.equal(r.cfg.items[59].code, 'MSFT', '소문자 티커 대문자로');
  assert.ok(r.result.includes('AAPL(최대 60개)') && r.result.includes('TSLA(최대 60개)'));
  assert.ok(!r.result.includes('@everyone') && r.result.includes('＠everyone'), '멘션 알림 방지');
  const pad = applyIn(workspace(), issueBody({ add: [{ code: 5930 + 1, market: 'KR', name: '숫자코드' }] }));
  assert.ok(pad.cfg.items.some((x) => x.code === '005931'), '숫자로 온 국내 코드는 6자리로');
});
await test('종목 편집 반영: AI 켜고 끄기 — 끄면 "ai": false 한 줄 · 켜면 표시 지움 · 이미 그 상태면 바뀐 것 없음 · 목록에 없는 종목 알림 · 새로 추가하며 끄기', async () => {
  const root = workspace(); // 삼성전자 · SK하이닉스 · 애플
  const off = applyIn(root, issueBody({ ai: { '005930': false, aapl: false, ZZZZ: false, '000660': 'no' } }));
  assert.equal(off.changed, true);
  assert.equal(off.output, 'changed=true\n');
  assert.deepEqual(off.cfg.items.map((x) => [x.code, x.ai]), [['005930', false], ['000660', undefined], ['AAPL', false]], '소문자 티커도 · 참·거짓이 아닌 값은 무시');
  assert.ok(cfgRaw(root).includes('{ "code": "005930", "market": "KR", "name": "삼성전자", "ai": false }'), cfgRaw(root));
  assert.ok(off.result.includes('AI 분석 끔: 삼성전자(005930), 애플(AAPL)') && off.result.includes('목록에 없어 AI 설정 안 함: ZZZZ'), off.result);
  assert.ok(off.result.includes('총 3개 · AI 분석 1개'), off.result);
  const on = applyIn(root, issueBody({ ai: { '005930': true, '000660': true } }));
  assert.equal(on.changed, true);
  assert.equal(on.cfg.items[0].ai, undefined, '켜면 표시를 지운다(기본 켜짐)');
  assert.ok(on.result.includes('AI 분석 켬: 삼성전자(005930)') && !on.result.includes('SK하이닉스'), '이미 켜진 종목은 바뀐 것으로 안 셈');
  const same = applyIn(root, issueBody({ ai: { '000660': true, AAPL: false } })); // 이미 켜짐 · 이미 꺼짐
  assert.equal(same.changed, false);
  assert.ok(same.result.startsWith('ℹ️ 바뀐 내용이 없습니다'));
  const addOff = applyIn(root, issueBody({ add: [{ code: 'NVDA', market: 'US', name: '엔비디아' }], ai: { NVDA: false } }));
  assert.deepEqual(addOff.cfg.items.find((x) => x.code === 'NVDA'), { code: 'NVDA', market: 'US', name: '엔비디아', ai: false }, '새로 추가하면서 끄기');
});
await test('종목 편집 반영: 잘못된 요청·읽을 수 없는 설정 파일이면 아무것도 바꾸지 않음', async () => {
  const bad = [
    '그냥 글만 있는 본문',
    issueBody('{ 깨진 json'),
    issueBody({ add: [], remove: [] }),
    issueBody([1, 2]),
    issueBody({ add: Array.from({ length: 151 }, (_, i) => ({ code: String(100000 + i) })) }),
    issueBody({ ai: {} }), // AI 켜고 끄기도 비어 있으면 바꿀 것 없음
    issueBody({ add: [{ code: 'NVDA' }] }) + 'x'.repeat(20001), // 요청은 멀쩡해도 본문이 너무 길면 거절
  ];
  for (const body of bad) {
    const root = workspace();
    const before = cfgRaw(root);
    const r = applyIn(root, body);
    assert.equal(r.changed, false);
    assert.equal(r.output, 'changed=false\n');
    assert.ok(r.result.startsWith('⚠️ 반영하지 못했습니다'), r.result);
    assert.equal(cfgRaw(root), before);
  }
  const root = workspace('{ 깨진 설정');
  const r = applyIn(root, issueBody({ add: [{ code: 'NVDA' }] }));
  assert.equal(r.changed, false);
  assert.ok(r.result.includes('읽지 못해 반영하지 않았습니다'));
  assert.equal(cfgRaw(root), '{ 깨진 설정', '깨진 파일을 덮어쓰지 않음');
  const same = applyIn(workspace(), issueBody({ add: [{ code: '005930' }] }));
  assert.equal(same.changed, false, '이미 있는 종목만 → 바뀐 것 없음');
  assert.ok(same.result.startsWith('ℹ️ 바뀐 내용이 없습니다'));
});

// ---------- 정리 · 결과 ----------
for (const d of workspaces) fs.rmSync(d, { recursive: true, force: true });
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     → ${r.err?.message}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n결과: ${results.length}개 중 ${results.length - failed}개 통과${failed ? ` · ${failed}개 실패` : ''}`);
process.exitCode = failed ? 1 : 0;
