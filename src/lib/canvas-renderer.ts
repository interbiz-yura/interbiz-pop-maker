import { Template, CalculatedData } from './types';
import { formatNumber } from './price-engine';

// 폰트 매핑 (font_family → CSS weight)
const FONT_WEIGHT_MAP: Record<string, number> = {
  'LG스마트체 Light': 300,
  'LG스마트체 Regular': 400,
  'LG스마트체 SemiBold': 600,
  'LG스마트체 Bold': 700,
};

// 폰트 로드 상태
let fontsLoaded = false;

export async function loadFonts(): Promise<void> {
  if (fontsLoaded) return;

  const fontFiles: [string, string][] = [
    ['/fonts/LGSMHAL.TTF', 'LGSmartLight'],
    ['/fonts/LGSMHAR.TTF', 'LGSmartRegular'],
    ['/fonts/LGSMHASB.TTF', 'LGSmartSemiBold'],
    ['/fonts/LGSMHAB.TTF', 'LGSmartBold'],
  ];

  const fontFaces = fontFiles.map(([url, name]) => {
    const face = new FontFace(name, `url(${url})`);
    return face.load().then((loaded) => {
      document.fonts.add(loaded);
    });
  });

  await Promise.all(fontFaces);
  fontsLoaded = true;
}

function getFontString(fontFamily: string, sizePt: number): string {
  // pt → px 변환 (파이썬 POP Maker와 동일: ×4.0, 캔버스 해상도에 맞춤)
  const pxSize = Math.round(sizePt * 4.0);

  const familyMap: Record<string, string> = {
    'LG스마트체 Light': 'LGSmartLight',
    'LG스마트체 Regular': 'LGSmartRegular',
    'LG스마트체 SemiBold': 'LGSmartSemiBold',
    'LG스마트체 Bold': 'LGSmartBold',
  };

  const weight = FONT_WEIGHT_MAP[fontFamily] || 400;
  const family = familyMap[fontFamily] || 'LGSmartRegular';

  return `${weight} ${pxSize}px ${family}`;
}

// ==========================================
// 템플릿별 데이터 매핑 (텍스트 요소명 → 값)
// ==========================================
export function mapDataToTemplate(
  templateName: string,
  data: CalculatedData
): Record<string, string> {
  const mapped: Record<string, string> = {};

  // 패턴B: 이마트/홈플러스/트레이더스/QR
  if (templateName.includes('이마트') || templateName.includes('홈플러스') || templateName.includes('트레이더스')) {
    mapped['모델명'] = data.model;
    mapped['기존'] = formatNumber(data.basePrice);
    mapped['할인'] = formatNumber(data.discountPrice);
    mapped['일구독'] = `일 ${formatNumber(data.dailyPrice)}원`;
    mapped['혜택 01'] = data.benefits[0] || '';
    mapped['혜택 02'] = data.benefits[1] || '';
    mapped['혜택 03'] = data.benefits[2] || '';
    mapped['혜택 04'] = data.benefits[3] || '';
    mapped['제휴카드 안내'] = data.cardMessage;
  }

  // 패턴A: 선납 가격표
  if (templateName.includes('구독 선납')) {
    mapped['모델명'] = data.model;
    mapped['일시불'] = `${formatNumber(data.listPrice)}원`;
    mapped['기본 구독료'] = `월 ${formatNumber(data.basePrice)}원`;
    mapped['30% 선납금'] = data.prepay30amount > 0 ? `(${formatNumber(data.prepay30amount)}원)` : '';
    mapped['30 월'] = `${formatNumber(data.prepay30monthly)}원`;
    mapped['50% 선납금'] = data.prepay50amount > 0 ? `(${formatNumber(data.prepay50amount)}원)` : '50% 선납 미운영';
    mapped['50 월'] = `${formatNumber(data.prepay50monthly)}원`;
    mapped['제휴카드 안내'] = data.cardMessage;
  }

  return mapped;
}

// ==========================================
// 메인 렌더링 함수
// ==========================================
export async function renderImage(
  template: Template,
  data: CalculatedData,
  qrImageSrc?: string
): Promise<HTMLCanvasElement> {
  await loadFonts();

  const [canvasW, canvasH] = template.size_dimensions;

  // 캔버스 생성
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d')!;

  // 배경 이미지 그리기
  const bgImage = new Image();
  await new Promise<void>((resolve, reject) => {
    bgImage.onload = () => resolve();
    bgImage.onerror = reject;
    bgImage.src = `data:image/jpeg;base64,${template.background_image_base64}`;
  });
  ctx.drawImage(bgImage, 0, 0, canvasW, canvasH);

  // 데이터 매핑
  const mapped = mapDataToTemplate(template.name, data);

  // 텍스트 렌더링
  for (const [name, config] of Object.entries(template.texts)) {
    const text = mapped[name];
    if (!text || text.trim() === '') continue;

    const [xRatio, yRatio] = config.position_ratio;
    const x = Math.round(xRatio * canvasW);
    const y = Math.round(yRatio * canvasH);

    ctx.font = getFontString(config.font_family, config.font_size_pt);
    ctx.fillStyle = config.color;

    // 정렬
    if (config.align === 'right') {
      ctx.textAlign = 'right';
    } else if (config.align === 'center') {
      ctx.textAlign = 'center';
    } else {
      ctx.textAlign = 'left';
    }
    ctx.textBaseline = 'middle';

    ctx.fillText(text, x, y);
  }

  // QR코드 이미지 (있으면)
  if (qrImageSrc && template.qr_enabled && template.qr_settings) {
    try {
      const qrImage = new Image();
      await new Promise<void>((resolve, reject) => {
        qrImage.onload = () => resolve();
        qrImage.onerror = () => resolve(); // QR 없어도 계속 진행
        qrImage.src = qrImageSrc;
      });

      const [qrXRatio, qrYRatio] = template.qr_settings.position_ratio;
      const qrSize = Math.round(template.qr_settings.size_ratio * canvasW);
      const qrX = Math.round(qrXRatio * canvasW) - qrSize / 2;
      const qrY = Math.round(qrYRatio * canvasH) - qrSize / 2;

      ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);
    } catch {
      // QR 이미지 로드 실패 시 무시
    }
  }

  return canvas;
}

// ==========================================
// JPG 다운로드
// ==========================================
export function downloadAsJPG(canvas: HTMLCanvasElement, fileName: string): void {
  const link = document.createElement('a');
  link.download = `${fileName}.jpg`;
  link.href = canvas.toDataURL('image/jpeg', 0.95);
  link.click();
}

// ==========================================
// ZIP 다운로드 (여러 장)
// ==========================================
export async function downloadAsZIP(
  canvases: { canvas: HTMLCanvasElement; fileName: string }[]
): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const { saveAs } = await import('file-saver');

  const zip = new JSZip();

  for (const { canvas, fileName } of canvases) {
    const blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.95);
    });
    zip.file(`${fileName}.jpg`, blob);
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  saveAs(zipBlob, 'LG_POP_가격표.zip');
}
