import { PriceRow, CardInfo, CareBenefit, QRMapping, CalculatedData } from './types';

const DEFAULT_DISCOUNT = 16000;

// ==========================================
// GetPriorityValue: S(6년)→P(5년)→M(4년) + K보너스
// ==========================================
export function getPriorityValue(row: PriceRow, activationDiscount: boolean): number {
  const kBonus = activationDiscount ? 0 : (row.activation || 0);

  let s = row.y6base || 0; // S열 = 6년
  let p = row.y5base || 0; // P열 = 5년
  let m = row.y4base || 0; // M열 = 4년

  if (kBonus > 0) {
    if (s > 0) s += kBonus;
    if (p > 0) p += kBonus;
    if (m > 0) m += kBonus;
  }

  if (s > 0) return s;
  if (p > 0) return p;
  if (m > 0) return m;
  return 0;
}

// ==========================================
// GetWValueWithK: W열(30%선납 월구독) + K보너스
// ==========================================
export function getWValueWithK(row: PriceRow, activationDiscount: boolean): number {
  const w = row.prepay30base || 0;
  if (activationDiscount) return w;
  const k = row.activation || 0;
  if (k > 0 && w > 0) return w + k;
  return w;
}

// ==========================================
// GetAAValueWithK: AA열(50%선납 월구독) + K보너스
// ==========================================
export function getAAValueWithK(row: PriceRow, activationDiscount: boolean): number {
  const aa = row.prepay50base || 0;
  if (activationDiscount) return aa;
  const k = row.activation || 0;
  if (k > 0 && aa > 0) return aa + k;
  return aa;
}

// ==========================================
// FindLowestPriceRow: 모델명으로 최저가 행 찾기
// ==========================================
export function findLowestPriceRow(
  priceData: PriceRow[],
  modelName: string,
  activationDiscount: boolean = false
): PriceRow | null {
  let foundRow: PriceRow | null = null;
  let minPrice = 999999999;

  for (const row of priceData) {
    if (row.model.trim() === modelName.trim()) {
      const price = getPriorityValue(row, activationDiscount);
      if (price > 0 && price < minPrice) {
        minPrice = price;
        foundRow = row;
      } else if (!foundRow) {
        foundRow = row;
      }
    }
  }
  return foundRow;
}

// ==========================================
// FindHighestPriceRow: 모델명으로 최고가 행 찾기 (지불가치용)
// ==========================================
export function findHighestPriceRow(
  priceData: PriceRow[],
  modelName: string,
  activationDiscount: boolean = false
): PriceRow | null {
  let foundRow: PriceRow | null = null;
  let maxPrice = 0;

  for (const row of priceData) {
    if (row.model.trim() === modelName.trim()) {
      const price = getPriorityValue(row, activationDiscount);
      if (price > 0 && price > maxPrice) {
        maxPrice = price;
        foundRow = row;
      } else if (!foundRow) {
        foundRow = row;
      }
    }
  }
  return foundRow;
}

// ==========================================
// 제휴카드 할인금액 조회
// ==========================================
export function getCardDiscount(
  cards: CardInfo[],
  cardName: string,
  monthUsage: string
): { discountAmount: number; message: string } {
  if (!cardName || cardName === '(미선택)') {
    return { discountAmount: DEFAULT_DISCOUNT, message: '※제휴카드 혜택 금액' };
  }

  const found = cards.find(
    (c) => c.cardName === cardName && c.monthUsage === monthUsage
  );

  if (found) {
    return { discountAmount: found.discountAmount, message: found.message };
  }
  return { discountAmount: DEFAULT_DISCOUNT, message: '※제휴카드 혜택 금액' };
}

// ==========================================
// BJY용 카드 순서별 조회
// ==========================================
export function getCardInfoByOrder(
  cards: CardInfo[],
  cardName: string,
  orderNum: number
): { monthUsage: string; discountAmount: number } {
  const found = cards.find(
    (c) => c.cardName === cardName && c.order === orderNum
  );

  if (found) {
    return { monthUsage: found.monthUsage, discountAmount: found.discountAmount };
  }
  return { monthUsage: '', discountAmount: 0 };
}

// ==========================================
// QR코드 파일명 조회
// ==========================================
export function getQRCode(qrMapping: QRMapping, category: string): string {
  return qrMapping[category.trim()] || '';
}

// ==========================================
// 케어서비스 혜택 조회 (일반)
// ==========================================
export function getBenefits(
  careBenefits: CareBenefit[],
  category: string,
  careKey: string
): string[] {
  const found = careBenefits.find(
    (c) => c.product.trim() === category.trim() && c.careKey.trim() === careKey.trim()
  );
  return found ? found.benefits : ['', '', '', ''];
}

// ==========================================
// 케어서비스 혜택 조회 (대형2)
// ==========================================
export function getBenefitsLarge2(
  careBenefits: CareBenefit[],
  category: string,
  careKey: string,
  modelName: string = ''
): string[] {
  for (const c of careBenefits) {
    if (c.product.trim() === category.trim() && c.careKey.trim() === careKey.trim()) {
      if (c.modelCondition && c.modelCondition !== '') {
        if (modelName.substring(0, 3) === c.modelCondition) {
          return c.benefits_large2;
        }
      } else {
        return c.benefits_large2;
      }
    }
  }
  return ['', '', '', ''];
}

// ==========================================
// 패턴B: 이마트/홈플러스/트레이더스/QR 계산
// ==========================================
export function calculatePatternB(
  priceData: PriceRow[],
  cards: CardInfo[],
  qrMapping: QRMapping,
  careBenefits: CareBenefit[],
  modelName: string,
  cardName: string,
  monthUsage: string,
  activationDiscount: boolean
): CalculatedData | null {
  const row = findLowestPriceRow(priceData, modelName, activationDiscount);
  if (!row) return null;

  const basePrice = getPriorityValue(row, activationDiscount);
  const { discountAmount, message } = getCardDiscount(cards, cardName, monthUsage);
  const discountPrice = Math.max(0, basePrice - discountAmount);
  const dailyPrice = discountPrice > 0 ? Math.round(discountPrice / 31) : 0;
  const qrCode = getQRCode(qrMapping, row.category);
  const benefits = getBenefits(careBenefits, row.category, row.careKey);

  return {
    model: modelName,
    category: row.category,
    listPrice: row.listPrice,
    basePrice,
    discountAmount,
    discountPrice,
    dailyPrice,
    prepay30amount: row.prepay30amount,
    prepay30monthly: Math.max(0, getWValueWithK(row, activationDiscount) - discountAmount),
    prepay50amount: row.prepay50amount,
    prepay50monthly: Math.max(0, getAAValueWithK(row, activationDiscount) - discountAmount),
    cardMessage: message,
    qrCode,
    benefits,
    careKey: row.careKey,
  };
}

// ==========================================
// 패턴A: 선납 가격표 계산
// ==========================================
export function calculatePatternA(
  priceData: PriceRow[],
  cards: CardInfo[],
  modelName: string,
  cardName: string,
  monthUsage: string,
  activationDiscount: boolean
): CalculatedData | null {
  const row = findLowestPriceRow(priceData, modelName, activationDiscount);
  if (!row) return null;

  const basePrice = getPriorityValue(row, activationDiscount);
  const { discountAmount, message } = getCardDiscount(cards, cardName, monthUsage);

  const w = getWValueWithK(row, activationDiscount);
  const aa = getAAValueWithK(row, activationDiscount);

  return {
    model: modelName,
    category: row.category,
    listPrice: row.listPrice,
    basePrice,
    discountAmount,
    discountPrice: Math.max(0, basePrice - discountAmount),
    dailyPrice: 0,
    prepay30amount: row.prepay30amount,
    prepay30monthly: w > 0 ? Math.max(0, w - discountAmount) : 0,
    prepay50amount: row.prepay50amount,
    prepay50monthly: aa > 0 ? Math.max(0, aa - discountAmount) : 0,
    cardMessage: message,
    qrCode: '',
    benefits: [],
    careKey: row.careKey,
  };
}

// ==========================================
// 모델 검색 (자동완성용)
// ==========================================
export function searchModels(priceData: PriceRow[], query: string, limit: number = 20): string[] {
  if (!query || query.length < 2) return [];

  const upper = query.toUpperCase();
  const seen = new Set<string>();
  const results: string[] = [];

  for (const row of priceData) {
    const model = row.model.trim();
    if (model && model.toUpperCase().includes(upper) && !seen.has(model)) {
      seen.add(model);
      results.push(model);
      if (results.length >= limit) break;
    }
  }
  return results;
}

// ==========================================
// 유니크 카드 목록
// ==========================================
export function getUniqueCardNames(cards: CardInfo[]): string[] {
  const seen = new Set<string>();
  return cards.filter((c) => {
    if (seen.has(c.cardName)) return false;
    seen.add(c.cardName);
    return true;
  }).map((c) => c.cardName);
}

// ==========================================
// 카드별 월실적 목록
// ==========================================
export function getUsagesByCard(cards: CardInfo[], cardName: string): string[] {
  return cards.filter((c) => c.cardName === cardName).map((c) => c.monthUsage);
}

// ==========================================
// 숫자 포맷
// ==========================================
export function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR');
}
