# 📈 실시간 주식시장 파악 — 100% 깃허브 무료 버전

**GitHub Pages + GitHub Actions만 사용** → 청구 개념 자체가 없어 **과금이 구조적으로 불가능**합니다. PC가 꺼져 있어도 링크로 어디서나 접속됩니다.

- **GitHub Actions 봇**이 약 5분마다 시세·뉴스를 받아 `docs/data/*.json`으로 저장 (공개 저장소는 Actions 무제한 무료)
- **GitHub Pages**가 그 JSON을 정적으로 서빙 (무료)
- 데이터: 네이버 금융(국내 실시간 시세·수급) · Yahoo Finance(해외 시세·과거 일봉·환율) · Google 뉴스 RSS · Google Gemini(선택, AI 요약 — `GEMINI_API_KEY` Secret, 무료 한도를 국내 장 시간 우선으로 배분) · 금융감독원 OpenDART(선택, 국내 종목 최근 공시 — `DART_API_KEY` Secret)
- 추적 종목: `config/watchlist.json` 파일로 관리

> ⚠️ 무료 Pages는 **공개(public) 저장소**여야 합니다. 종목 코드 목록이 공개되니(수량·금액은 아님) 감안하세요.
>
> ℹ️ 위 시세·뉴스는 비공식 공개 데이터로, **개인 모니터링 용도**로만 사용합니다.

---

## 설치 (한 번만)

### 1) GitHub에 빈 저장소 만들기
github.com → New repository → 이름 입력(예: `my-market`) → **Public** 선택 → Create.

### 2) 이 `pages` 폴더를 그 저장소에 올리기
터미널에서 (USERNAME/REPO는 본인 것으로):
```bash
cd "D:\claudeCode_dev\개인프로젝트\01_실시간주식시장파악\pages"
git init
git add .
git commit -m "init: 실시간 주식 대시보드"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

### 3) Actions 쓰기 권한 켜기
저장소 → **Settings → Actions → General → Workflow permissions** → **Read and write permissions** 선택 → Save.
(봇이 데이터 JSON을 커밋하려면 필요합니다.)

### 4) GitHub Pages 켜기
저장소 → **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**, 폴더: **/docs** → Save.

### 5) 첫 데이터 생성 실행
저장소 → **Actions 탭** → 좌측 "시세·뉴스 갱신" → **Run workflow** 클릭.
(이후에는 5분마다 자동 실행됩니다.)

### 6) 접속
1~2분 뒤 **`https://USERNAME.github.io/REPO/`** 로 접속. (휴대폰·다른 PC 어디서나)

### (선택) AI 요약·공시 켜기
저장소 → **Settings → Secrets and variables → Actions → New repository secret**
- `GEMINI_API_KEY` — Google AI Studio 무료 키 → 🤖 AI 핵심·🧠 AI 종합분석
- `DART_API_KEY` — opendart.fss.or.kr 무료 인증키 → 국내 종목 카드의 📋 최근 공시(AI 분석에도 반영)

키가 없으면 그 기능만 꺼지고 나머지는 그대로 동작합니다.

---

## 종목 추가/삭제
대시보드의 **✏️ 종목 편집** 버튼 → 종목명·코드·티커로 검색해 추가·삭제 → **저장**하면 1~2분 뒤 반영됩니다.
- 저장은 제목이 `watchlist:`인 깃허브 이슈로 변경 요청을 남기고, 봇(`.github/workflows/watchlist.yml`)이 저장소 주인의 요청만 반영합니다.
- 토큰 없이: 저장 때 열리는 깃허브 창에서 **Create** 한 번 / 버튼 한 번으로: **이슈 쓰기(Issues: Read and write) 권한만 있는** Fine-grained 토큰을 편집 창에 넣어 두기(그 브라우저에만 저장).
- 검색용 전체 종목 목록은 봇(`stocklist.yml`)이 매일 07:40 KST에 만듭니다.
- 저장소 Settings에서 **Issues** 기능이 켜져 있어야 합니다(기본값 켜짐).

직접 고치려면 저장소의 **`config/watchlist.json`** 파일을 깃허브 웹에서 편집(연필 아이콘) → 커밋하면 5분 안에 반영됩니다.
```json
{
  "items": [
    { "code": "005930", "market": "KR", "name": "삼성전자" },
    { "code": "AAPL",   "market": "US", "name": "Apple" }
  ]
}
```
한국 종목은 6자리 코드, 미국은 티커. `name`은 화면에 표시할 별칭(선택).

---

## 로컬에서 미리보기 (선택)
```bash
cd pages
node scripts/selftest.mjs   # 오프라인 자체 테스트 (외부 접속 없음)
node scripts/fetch.mjs      # 데이터 JSON 생성 (외부 데이터 소스에 접속함)
node scripts/serve.mjs      # http://localhost:5175 에서 확인
```

---

## 한계
- 깃허브 예약작업 특성상 **갱신은 약 5분 주기**(실시간 10~30초 아님). "왜 급등/급락했는지" 파악엔 충분합니다.
- 야후·구글뉴스는 비공식 공개 데이터입니다(개인용).
- 저장소가 60일간 활동이 없으면 예약작업이 자동 비활성화됩니다(봇이 매 5분 커밋하므로 보통 유지됨).
- Gemini 무료 한도는 모델당 하루 수십 회뿐이라 무료 Flash-Lite 모델 3개(2.5·3.5·3.1)를 함께 쓰고 국내 장 시간에 우선 배분합니다(매일 16:00 KST, 겨울 17:00 초기화). 한도를 다 쓰면 그날 AI만 쉬고 요금은 없습니다(결제 계정 미연결). 사용량·상태는 화면 하단 'AI 상태'에서 확인.
- 매매·주문 기능 없음(모니터링 전용).

## 구조
```
pages/
  .github/workflows/update.yml   5분마다 데이터 갱신 + 커밋
  .github/workflows/watchlist.yml  '종목 편집' 이슈 → watchlist.json 반영 → 시세 갱신 실행
  .github/workflows/stocklist.yml  매일 검색용 전체 종목 목록 갱신
  config/watchlist.json          추적 종목 목록
  scripts/
    fetch.mjs                    시세·뉴스 → docs/data/*.json 생성
    sources.mjs                  시세·뉴스·수급 수집, 태깅, 분위기 산출, AI(Gemini)
    aibudget.mjs                 AI 무료 한도 하루 배분(장 시간 가중치·모델 배분)
    stocklist.mjs                검색용 국내·미국 전체 종목 목록 생성
    watchlist-apply.mjs          '종목 편집' 요청 검증·반영
    util.mjs                     설정 검증·원자적 쓰기 등 공통 유틸
    selftest.mjs                 오프라인 자체 테스트(가짜 네트워크)
    serve.mjs                    로컬 미리보기용(배포 미사용, --mock-github로 편집 저장 시험)
  docs/                          ← GitHub Pages가 서빙하는 폴더
    index.html / style.css / app.js
    editor.js                    ✏️ 종목 편집(검색·추가·삭제·저장)
    help.html                    사용설명서
    data/*.json                  봇이 생성 (시세·뉴스·분위기·종목 목록)
```
