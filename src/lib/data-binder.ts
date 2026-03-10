import { CalculatedData } from './types';
import { formatNumber } from './price-engine';

// ==========================================
// name 컨벤션 → CalculatedData 값 매핑
// ==========================================

export function bindValue(name: string, data: CalculatedData): string {
  switch (name) {
    // ----- 모델명 -----
    case '모델명':
      return data.model ? `모델명 : ${data.model}` : '';
    case '모델명02':
      return data.model || '';
    case '제품군':
      return data.category || '';

    // ----- 가격 (기본 가격표용) -----
    case '정상가':
      return data.listPrice > 0 ? formatNumber(data.listPrice) : '';
    case '기존':
    case '정상구독료':
    case '기본구독료':
      return data.basePrice > 0 ? formatNumber(data.basePrice) : '';
    case '할인':
    case '할인가':
    case '월구독료':
      return data.discountPrice > 0 ? formatNumber(data.discountPrice) : '';
    case '일구독':
      return data.dailyPrice > 0 ? `일 ${formatNumber(data.dailyPrice)}원` : '';

    // ----- 가격 (선납 가격표용) -----
    case '기본':
      return data.basePrice > 0 ? `월 ${formatNumber(data.basePrice)}원` : '';
    case '일시불':
      return data.listPrice > 0 ? `${formatNumber(data.listPrice)}원` : '';
    case '30% 선납금':
      return data.prepay30amount > 0 ? `(${formatNumber(data.prepay30amount)}원)` : '';
    case '30 월':
      return data.prepay30monthly > 0 ? `${formatNumber(data.prepay30monthly)}원` : (data.prepay30amount > 0 ? '0원' : '');
    case '50% 선납금':
      if (data.prepay50amount > 0) return `(${formatNumber(data.prepay50amount)}원)`;
      if (data.listPrice > 0) return '50% 선납 미운영';
      return '';
    case '50 월':
      return data.prepay50monthly > 0 ? `${formatNumber(data.prepay50monthly)}원` : (data.prepay50amount > 0 ? '0원' : '');

    // ----- 카드/혜택 -----
    case '제휴카드 안내':
    case '카드안내':
      return data.cardMessage || '';
    case '혜택 01':
      return data.benefits?.[0] || '';
    case '혜택 02':
      return data.benefits?.[1] || '';
    case '혜택 03':
      return data.benefits?.[2] || '';
    case '혜택 04':
      return data.benefits?.[3] || '';
    case '카드할인':
    case '할인금액':
      return data.discountAmount > 0 ? formatNumber(data.discountAmount) : '';

    default:
      break;
  }

  // ----- 선납 관련 (인덱스 포함 — 기존 호환) -----
  if (name.startsWith('실적')) {
    return data.cardMessage || '';
  }
  if (name.startsWith('일반가격')) {
    return data.basePrice > 0 ? formatNumber(data.basePrice) : '';
  }
  if (name.startsWith('할인가격')) {
    return data.discountPrice > 0 ? formatNumber(data.discountPrice) : '';
  }
  if (name === '선납' || name.startsWith('선납 ')) {
    const idx = extractIndex(name);
    if (idx <= 1 && data.prepay30amount > 0) return formatNumber(data.prepay30amount) + '원';
    if (idx === 2 && data.prepay50amount > 0) return formatNumber(data.prepay50amount) + '원';
    return '';
  }
  if (name.startsWith('선납할인')) {
    const idx = extractIndex(name);
    if (idx <= 1 && data.prepay30monthly > 0) return formatNumber(data.prepay30monthly);
    if (idx === 2 && data.prepay50monthly > 0) return formatNumber(data.prepay50monthly);
    return '';
  }
  if (name === '주의 사항' || name === '주의사항') {
    return '';
  }

  return '';
}

function extractIndex(name: string): number {
  const match = name.match(/(\d+)/);
  return match ? parseInt(match[1]) : 1;
}

export function bindAllValues(
  textNames: string[],
  data: CalculatedData
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of textNames) {
    result[name] = bindValue(name, data);
  }
  return result;
}
