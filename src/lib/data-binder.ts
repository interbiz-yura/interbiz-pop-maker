import { CalculatedData } from './types';
import { formatNumber } from './price-engine';

// ==========================================
// name 컨벤션 → CalculatedData 값 매핑
// ==========================================
// 템플릿 JSON의 texts 키(name)를 CalculatedData 필드에 매핑
// 같은 이름 = 같은 계산식
// ==========================================

/**
 * 템플릿 텍스트 name에 해당하는 값을 CalculatedData에서 추출
 * @returns 표시할 문자열. 매핑 안 되면 '' 반환
 */
export function bindValue(name: string, data: CalculatedData): string {
  // 정확히 일치
  switch (name) {
    case '모델명':
      return data.model || '';
    case '제품군':
      return data.category || '';
    case '정상가':
      return data.listPrice > 0 ? formatNumber(data.listPrice) : '';

    // 기본 구독료 (카드 할인 전)
    case '기존':
    case '정상구독료':
    case '기본구독료':
      return data.basePrice > 0 ? formatNumber(data.basePrice) : '';

    // 카드 할인 후 가격
    case '할인':
    case '할인가':
    case '월구독료':
      return data.discountPrice > 0 ? formatNumber(data.discountPrice) : '';

    // 일구독 (÷31)
    case '일구독':
      return data.dailyPrice > 0 ? `일 ${formatNumber(data.dailyPrice)}원` : '';

    // 카드 안내 문구
    case '제휴카드 안내':
    case '카드안내':
      return data.cardMessage || '';

    // 케어서비스 혜택
    case '혜택 01':
      return data.benefits?.[0] || '';
    case '혜택 02':
      return data.benefits?.[1] || '';
    case '혜택 03':
      return data.benefits?.[2] || '';
    case '혜택 04':
      return data.benefits?.[3] || '';

    // 카드 할인 금액
    case '카드할인':
    case '할인금액':
      return data.discountAmount > 0 ? formatNumber(data.discountAmount) : '';

    default:
      break;
  }

  // ----- 선납 관련 (인덱스 포함) -----
  // "실적", "실적 1", "실적 2" → 카드 실적 표시 (현재는 cardMessage에서 추출)
  // "일반가격", "일반가격 1" → 기본 구독료
  // "할인가격", "할인가격 1" → 카드 할인 후
  // "선납", "선납 1" → 선납금액 텍스트
  // "선납할인", "선납할인 1" → 선납 할인 적용 월구독료

  // 실적 (카드 월실적 금액)
  if (name.startsWith('실적')) {
    return data.cardMessage || '';
  }

  // 일반가격 (카드할인 전 기본 구독료)
  if (name.startsWith('일반가격')) {
    return data.basePrice > 0 ? formatNumber(data.basePrice) : '';
  }

  // 할인가격 (카드할인 후)
  if (name.startsWith('할인가격')) {
    return data.discountPrice > 0 ? formatNumber(data.discountPrice) : '';
  }

  // 선납 금액 텍스트
  if (name === '선납' || name.startsWith('선납 ')) {
    // 선납 1 = 30%, 선납 2 = 50%
    const idx = extractIndex(name);
    if (idx <= 1 && data.prepay30amount > 0) {
      return formatNumber(data.prepay30amount) + '원';
    }
    if (idx === 2 && data.prepay50amount > 0) {
      return formatNumber(data.prepay50amount) + '원';
    }
    return '';
  }

  // 선납할인 (선납 적용 후 월구독료)
  if (name.startsWith('선납할인')) {
    const idx = extractIndex(name);
    if (idx <= 1 && data.prepay30monthly > 0) {
      return formatNumber(data.prepay30monthly);
    }
    if (idx === 2 && data.prepay50monthly > 0) {
      return formatNumber(data.prepay50monthly);
    }
    return '';
  }

  // 주의 사항 등 고정 텍스트는 빈 문자열 → 템플릿의 기본값 사용
  if (name === '주의 사항' || name === '주의사항') {
    return ''; // 고정 텍스트는 배경 이미지에 이미 포함
  }

  return '';
}

/**
 * name에서 숫자 인덱스 추출 (예: "선납 2" → 2, "선납" → 1)
 */
function extractIndex(name: string): number {
  const match = name.match(/(\d+)/);
  return match ? parseInt(match[1]) : 1;
}

/**
 * 템플릿의 모든 텍스트 name에 대해 바인딩 수행
 * @returns Record<name, 표시값>
 */
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
