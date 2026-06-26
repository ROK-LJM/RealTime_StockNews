# 📈 실시간 주식시장 파악 — 100% 깃허브 무료 버전

**GitHub Pages + GitHub Actions만 사용** → 청구 개념 자체가 없어 **과금이 구조적으로 불가능**합니다. PC가 꺼져 있어도 링크로 어디서나 접속됩니다.

- **GitHub Actions 봇**이 약 5분마다 시세·뉴스를 받아 `docs/data/*.json`으로 저장 (공개 저장소는 Actions 무제한 무료)
- **GitHub Pages**가 그 JSON을 정적으로 서빙 (무료)
- 데이터: 야후 파이낸스 + 구글뉴스 (API 키 불필요, 한국 종목은 `005930.KS`/`.KQ`로 조회)
- 추적 종목: `config/watchlist.json` 파일로 관리

> ⚠️ 무료 Pages는 **공개(public) 저장소**여야 합니다. 종목 코드 목록이 공개되니(수량·금액은 아님) 감안하세요.

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

---

## 종목 추가/삭제
저장소의 **`config/watchlist.json`** 파일을 깃허브 웹에서 편집(연필 아이콘) → 커밋하면 5분 안에 반영됩니다.
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
node scripts/fetch.mjs      # 데이터 JSON 생성
node scripts/serve.mjs      # http://localhost:5175 에서 확인
```

---

## 한계
- 깃허브 예약작업 특성상 **갱신은 약 5분 주기**(실시간 10~30초 아님). "왜 급등/급락했는지" 파악엔 충분합니다.
- 야후·구글뉴스는 비공식 공개 데이터입니다(개인용).
- 저장소가 60일간 활동이 없으면 예약작업이 자동 비활성화됩니다(봇이 매 5분 커밋하므로 보통 유지됨).
- 매매·주문 기능 없음(모니터링 전용).

## 구조
```
pages/
  .github/workflows/update.yml   5분마다 데이터 갱신 + 커밋
  config/watchlist.json          추적 종목 목록
  scripts/
    fetch.mjs                    시세·뉴스 → docs/data/*.json 생성
    sources.mjs                  야후·구글뉴스 수집·태깅·분위기 산출
    serve.mjs                    로컬 미리보기용(배포 미사용)
  docs/                          ← GitHub Pages가 서빙하는 폴더
    index.html / style.css / app.js
    data/*.json                  봇이 생성 (시세·뉴스·분위기)
```
