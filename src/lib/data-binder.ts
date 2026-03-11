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
    
    // ----- 제품군 -----
    case '제품군':
      return data.category ? `LG ${data.category}` : '';

    // ----- 가격 (기본 가격표용 — 숫자만) -----
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

    // ----- 가격 (선납 가격표용 — "월 OOO원" 형식) -----
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

    // ----- 제휴카드 혜택 총 구독 (할인가 × 72개월) -----

      case '제휴카드 혜택 총 구독': {
          if (data.discountPrice <= 0) return '';
          const msg = data.cardMessage || '';
          if (msg.includes('KB국민')) {
            // KB국민: 1~60개월 + 61~72개월 (할인액 감소)
            const late = data.discountPrice + data.discountAmount - (data.discountAmount <= 17000 ? 10000 : 15000);
            const total = data.discountPrice * 60 + late * 12;
            return `${formatNumber(total)}원`;
          }
          return `${formatNumber(data.discountPrice * 72)}원`;
        }

    default:
      break;
  }

  // ----- 선납 금액별 가격표 전용 (02 = 2번째 카드실적) -----

  // 실적 (카드 월실적 — "만" 제거, 숫자만)
  // 실적 (카드 월실적 — "만" 제거, 숫자만)
    if (name === '실적') {
      const msg = data.cardMessage || '';
      const match = msg.match(/월\s*(\d+)/);
      if (match) return match[1];
      return '';
    }
    if (name === '실적02') {
      const msg = data.cardMessage2 || '';
      const match = msg.match(/월\s*(\d+)/);
      if (match) return match[1];
      return '';
  }

 // 일반가격 / 일반가격02
  if (name === '일반가격' || name === '일반가격02') {
    return data.basePrice > 0 ? formatNumber(data.basePrice) : '';
  }

  // 할인가격 (1번째 실적)
  if (name === '할인가격') {
    return data.discountPrice > 0 ? formatNumber(data.discountPrice) : '0';
  }
  // 할인가격02 (2번째 실적)
  if (name === '할인가격02') {
    return data.discountPrice2 > 0 ? formatNumber(data.discountPrice2) : '0';
  }

  // 선납 / 선납02 (선납 안내 텍스트 — 동일)
  if (name === '선납' || name === '선납02') {
    if (data.prepay30amount > 0) {
      return `선납 30%(${formatNumber(data.prepay30amount)}원) 시`;
    }
    if (data.prepay50amount > 0) {
      return `선납 50%(${formatNumber(data.prepay50amount)}원) 시`;
    }
    return '선납 미운영';
  }

  // 선납할인 (1번째 실적)
  if (name === '선납할인') {
    if (data.prepay30monthly > 0) return formatNumber(data.prepay30monthly);
    if (data.prepay50monthly > 0) return formatNumber(data.prepay50monthly);
    return '0';
  }
  // 선납할인02 (2번째 실적)
  if (name === '선납할인02') {
    if (data.prepay30monthly2 > 0) return formatNumber(data.prepay30monthly2);
    if (data.prepay50monthly2 > 0) return formatNumber(data.prepay50monthly2);
    return '0';
  }

  // 주의 사항 (동적: 카드명 + 고정 문구)
  if (name === '주의 사항' || name === '주의사항') {
    const msg = data.cardMessage || '';
    // "※ 롯데 제휴카드 프로모션 적용, 월 40만원 이상 사용 시" → "롯데"
    const cardMatch = msg.match(/※\s*(.+?)\s*제휴카드/);
    if (cardMatch) {
      return `${cardMatch[1]} 제휴카드 프로모션 적용, 구독 72개월 기준`;
    }
    return '';
  }

  // ----- 기존 호환: 선납 인덱스 형식 -----
  if (name.startsWith('선납 ') && !name.startsWith('선납할인')) {
    const idx = extractIndex(name);
    if (idx <= 1 && data.prepay30amount > 0) return formatNumber(data.prepay30amount) + '원';
    if (idx === 2 && data.prepay50amount > 0) return formatNumber(data.prepay50amount) + '원';
    return '';
  }

  if (name.startsWith('선납할인') && name !== '선납할인' && name !== '선납할인02') {
    const idx = extractIndex(name);
    if (idx <= 1 && data.prepay30monthly > 0) return formatNumber(data.prepay30monthly);
    if (idx === 2 && data.prepay50monthly > 0) return formatNumber(data.prepay50monthly);
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
