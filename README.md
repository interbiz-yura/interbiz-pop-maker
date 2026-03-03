# LG POP Maker - 구독 가격표 자동 생성기

모델명 입력 → 가격 자동 계산 → JPG 가격표 이미지 생성

## 빠른 시작

```bash
npm install
npm run dev
```

http://localhost:3000 에서 확인

## Vercel 배포

1. GitHub에 push
2. vercel.com에서 Import
3. Framework: Next.js 선택
4. Deploy 클릭 → 끝!

## 데이터 업데이트 방법

### 가격 데이터 (price.xlsx 변경 시)
1. 새 xlsx 파일을 `scripts/` 폴더에 넣기
2. `node scripts/convert-xlsx.js` 실행 (또는 Python 스크립트)
3. 생성된 JSON을 `public/data/` 에 덮어쓰기
4. git commit & push → Vercel 자동 배포

### 템플릿 추가
1. 파이썬 POP Maker에서 JSON 내보내기
2. `public/data/templates/` 에 저장
3. `src/app/page.tsx`의 TEMPLATES 배열에 추가

### QR코드 이미지 교체
1. `public/qr/` 폴더에 PNG 파일 교체
2. `public/data/qr-mapping.json` 매핑 확인

## 기술 스택
- Next.js 14 (Static Export)
- TypeScript
- Tailwind CSS
- HTML Canvas API (이미지 생성)
- LG스마트체 폰트

## 프로젝트 구조
```
public/
  data/           ← 가격/카드/QR/케어 JSON 데이터
  fonts/          ← LG스마트체 폰트 4종
  qr/             ← QR코드 이미지 (추후)
src/
  app/page.tsx    ← 메인 UI
  lib/
    price-engine.ts     ← 가격 계산 엔진
    canvas-renderer.ts  ← Canvas 이미지 생성
    data-loader.ts      ← JSON 데이터 로더
    types.ts            ← 타입 정의
```
