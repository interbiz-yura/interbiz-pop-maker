import { Template, TemplateText, TemplateBatchSettings } from './types';

// ==========================================
// LG 폰트 매핑
// ==========================================
const FONT_MAP: Record<string, { file: string; family: string }> = {
  'LG스마트체 Bold': { file: '/fonts/LGSMHAB.TTF', family: 'LGSmartBold' },
  'LG스마트체 Light': { file: '/fonts/LGSMHAL.TTF', family: 'LGSmartLight' },
  'LG스마트체 Regular': { file: '/fonts/LGSMHAR.TTF', family: 'LGSmartRegular' },
  'LG스마트체 SemiBold': { file: '/fonts/LGSMHASB.TTF', family: 'LGSmartSemiBold' },
  'G마켓 산스 TTF Bold': { file: '/fonts/GmarketSansTTFBold.ttf', family: 'GmarketSansTTFBold' },
  'G마켓 산스 TTF Medium': { file: '/fonts/GmarketSansTTFMedium.ttf', family: 'GmarketSansTTFMedium' },
  'G마켓 산스 TTF Light': { file: '/fonts/GmarketSansTTFLight.ttf', family: 'GmarketSansTTFLight' },
  'G마켓 산스 Bold': { file: '/fonts/GmarketSansBold.otf', family: 'GmarketSansBold' },
  'G마켓 산스 Medium': { file: '/fonts/GmarketSansMedium.otf', family: 'GmarketSansMedium' },
  'G마켓 산스 Light': { file: '/fonts/GmarketSansLight.otf', family: 'GmarketSansLight' },
  '맑은 고딕': { file: '', family: 'Malgun Gothic, sans-serif' },
  '맑은 고딕 Semilight': { file: '', family: 'Malgun Gothic Semilight, Malgun Gothic, sans-serif' },
  'HY견고딕': { file: '', family: 'HY견고딕, HYGothic-Extra, 맑은 고딕, Malgun Gothic, sans-serif' },
};

// 폰트 로딩 캐시
const loadedFonts = new Set<string>();

/**
 * LG 커스텀 폰트 로드 (브라우저 FontFace API)
 */
async function loadFont(fontFamily: string): Promise<void> {
  const mapping = FONT_MAP[fontFamily];
  if (!mapping) return;
  if (loadedFonts.has(mapping.family)) return;
  if (!mapping.file) { loadedFonts.add(mapping.family); return; }

  try {
    const font = new FontFace(mapping.family, `url(${mapping.file})`);
    const loaded = await font.load();
    document.fonts.add(loaded);
    loadedFonts.add(mapping.family);
  } catch (e) {
    console.warn(`폰트 로드 실패: ${fontFamily}`, e);
  }
}

/**
 * 템플릿에서 사용하는 모든 폰트를 사전 로드
 */
export async function preloadFonts(template: Template): Promise<void> {
  const fontNames = new Set<string>();
  for (const text of Object.values(template.texts)) {
    if (text.font_family) fontNames.add(text.font_family);
  }
  await Promise.all(Array.from(fontNames).map(loadFont));
}

/**
 * font_family 이름을 Canvas에서 사용할 family 이름으로 변환
 */
function getCanvasFontFamily(fontFamily: string): string {
  const mapping = FONT_MAP[fontFamily];
  return mapping ? mapping.family : 'sans-serif';
}

/**
 * letter_spacing 값을 px로 변환
 */
function getLetterSpacingPx(spacing: string, fontSize: number): number {
  switch (spacing) {
    case '좁게': return -fontSize * 0.03;
    case '넓게': return fontSize * 0.05;
    case '보통':
    default: return 0;
  }
}

/**
 * 커스텀 letter-spacing으로 텍스트 그리기
 */
function drawTextWithSpacing(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  align: 'left' | 'center' | 'right'
): void {
  if (spacing === 0 || Math.abs(spacing) < 0.5) {
    ctx.fillText(text, x, y);
    return;
  }

  // letter-spacing이 있으면 한 글자씩 그리기
  const chars = text.split('');
  const charWidths = chars.map(ch => ctx.measureText(ch).width);
  const totalWidth = charWidths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);

  let startX = x;
  if (align === 'center') startX = x - totalWidth / 2;
  else if (align === 'right') startX = x - totalWidth;

  // left로 그리기 (수동 배치)
  ctx.save();
  ctx.textAlign = 'left';
  let curX = startX;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], curX, y);
    curX += charWidths[i] + spacing;
  }
  ctx.restore();
}

// ==========================================
// 메인 렌더 함수
// ==========================================

export interface RenderOptions {
  template: Template;
  values: Record<string, string>;  // name → 표시할 텍스트
  qrDataUrl?: string;              // QR코드 이미지 data URL
}

/**
 * 템플릿을 Canvas에 렌더링하고 data URL 반환
 */
export async function renderTemplate(options: RenderOptions): Promise<string> {
  const { template, values, qrDataUrl } = options;
  const [width, height] = template.size_dimensions;

  // 폰트 사전 로드
  await preloadFonts(template);

  // Canvas 생성
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // 1) 배경색
  ctx.fillStyle = template.background_color || '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // 2) 배경 이미지
  if (template.background_image_base64) {
    const fmt = template.background_image_format || '.jpg';
    const mimeType = fmt === '.png' ? 'image/png' : 'image/jpeg';
    const imgSrc = `data:${mimeType};base64,${template.background_image_base64}`;

    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height);
        resolve();
      };
      img.onerror = () => {
        console.warn('배경 이미지 로드 실패');
        resolve();
      };
      img.src = imgSrc;
    });
  }

  // 3) 텍스트 렌더링
  for (const [name, textDef] of Object.entries(template.texts)) {
    const value = values[name];
    if (!value && value !== '0') continue; // 빈 값은 스킵

    const [ratioX, ratioY] = textDef.position_ratio;
    const x = ratioX * width;
    const y = ratioY * height;

// 폰트 크기: pt → px 변환 (템플릿의 기준 해상도에 맞게)
    // 원본 파이썬에서는 pt를 직접 사용했으므로 비율 유지
    const fontSizePx = Math.max(8, Math.round(textDef.font_size_pt * 4.0));
    const fontFamily = getCanvasFontFamily(textDef.font_family);
    const spacing = getLetterSpacingPx(textDef.letter_spacing, fontSizePx);

    const boldPrefix = textDef.bold ? 'bold ' : '';
    ctx.font = `${boldPrefix}${fontSizePx}px ${fontFamily}`;
    ctx.fillStyle = textDef.color;
    ctx.textAlign = textDef.align;
    ctx.textBaseline = 'middle';

    drawTextWithSpacing(ctx, value, x, y, spacing, textDef.align);
  }

  // 4) QR코드 렌더링
  if (qrDataUrl && template.qr_enabled && template.qr_settings) {
    const { position_ratio, size_ratio } = template.qr_settings;
    const qrSize = size_ratio * width * 0.7;
    const qrX = position_ratio[0] * width - qrSize / 2;
    const qrY = position_ratio[1] * height - qrSize / 2;

    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = qrDataUrl;
    });
  }

  // 5) 테두리
  if (template.border_width && template.border_width > 0) {
    ctx.strokeStyle = template.border_color || '#CCCCCC';
    ctx.lineWidth = template.border_width;
    ctx.strokeRect(0, 0, width, height);
  }

  return canvas.toDataURL('image/png');
}

/**
 * 여러 모델을 배치(batch)로 렌더링하여 A4 한 장에 배치
 */
export async function renderBatch(
  template: Template,
  allValues: Record<string, string>[],
  qrDataUrls?: string[]
): Promise<string[]> {
  const results: string[] = [];

  if (!template.batch_enabled) {
    // 배치 비활성화: 개별 이미지 생성
    for (let i = 0; i < allValues.length; i++) {
      const dataUrl = await renderTemplate({
        template,
        values: allValues[i],
        qrDataUrl: qrDataUrls?.[i],
      });
      results.push(dataUrl);
    }
    return results;
  }

  // 배치 모드: A4 용지에 그리드로 배치
  const batch = template.batch_settings || {
    paper_orientation: '가로',
    item_width_mm: 148,
    item_height_mm: 105,
    grid_cols: 2,
    grid_rows: 2,
  };

  const cols = batch.grid_cols;
  const rows = batch.grid_rows;
  const itemsPerPage = cols * rows;

  // A4 크기 (300dpi): 가로 3508 x 세로 2480 / 세로 2480 x 가로 3508
  const A4_LONG = 3508;
  const A4_SHORT = 2480;
  const paperW = batch.paper_orientation === '가로' ? A4_LONG : A4_SHORT;
  const paperH = batch.paper_orientation === '가로' ? A4_SHORT : A4_LONG;

  const cellW = Math.floor(paperW / cols);
  const cellH = Math.floor(paperH / rows);

  // 개별 아이템 먼저 렌더링
  const itemImages: string[] = [];
  for (let i = 0; i < allValues.length; i++) {
    const dataUrl = await renderTemplate({
      template,
      values: allValues[i],
      qrDataUrl: qrDataUrls?.[i],
    });
    itemImages.push(dataUrl);
  }

  // 페이지별로 배치
  for (let pageStart = 0; pageStart < itemImages.length; pageStart += itemsPerPage) {
    const pageItems = itemImages.slice(pageStart, pageStart + itemsPerPage);

    const canvas = document.createElement('canvas');
    canvas.width = paperW;
    canvas.height = paperH;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, paperW, paperH);

    for (let i = 0; i < pageItems.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cellW;
      const y = row * cellH;

      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => {
          // 비율 유지하며 셀 안에 맞추기
          const imgRatio = img.width / img.height;
          const cellRatio = cellW / cellH;
          let drawW = cellW, drawH = cellH, drawX = x, drawY = y;
          if (imgRatio > cellRatio) {
            drawH = cellW / imgRatio;
            drawY = y + (cellH - drawH) / 2;
          } else {
            drawW = cellH * imgRatio;
            drawX = x + (cellW - drawW) / 2;
          }
          ctx.drawImage(img, drawX, drawY, drawW, drawH);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = pageItems[i];
      });
    }

// 절취선 그리기
    ctx.setLineDash([10, 6]);
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1.5;

    // 세로 절취선
    for (let c = 1; c < cols; c++) {
      const x = c * cellW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, paperH);
      ctx.stroke();
    }

    // 가로 절취선
    for (let r = 1; r < rows; r++) {
      const y = r * cellH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(paperW, y);
      ctx.stroke();
    }

    ctx.setLineDash([]);

    results.push(canvas.toDataURL('image/png'));
  }

  return results;
}

/**
 * data URL을 다운로드
 */
export function downloadImage(dataUrl: string, fileName: string): void {
  const link = document.createElement('a');
  link.download = fileName;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * 여러 이미지를 ZIP으로 다운로드 (선택적)
 */
export function downloadAllImages(dataUrls: string[], prefix: string = 'price'): void {
  dataUrls.forEach((url, i) => {
    setTimeout(() => {
      downloadImage(url, `${prefix}_${String(i + 1).padStart(3, '0')}.png`);
    }, i * 200); // 연속 다운로드 딜레이
  });
}
