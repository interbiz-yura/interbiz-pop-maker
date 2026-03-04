// ==========================================
// 가격 데이터 (price.xlsx → JSON)
// ==========================================
export interface PriceRow {
  channel: string;
  category: string;       // D열 - 제품군
  model: string;          // E열 - 판매모델코드
  listPrice: number;      // F열 - 기준가(일시불)
  careType: string;       // G열 - 케어십형태
  careGrade: string;      // H열 - 케어십구분
  visitCycle: string;     // I열 - 방문주기
  careKey: string;        // J열 - 구분자 (케어서비스 조회키)
  activation: number;     // K열 - 활성화 할인금액
  y3base: number;         // L열 - 3년 기본
  y4base: number;         // M열 - 4년 기본
  y4new: number;          // N열 - 4년 신규결합
  y4exist: number;        // O열 - 4년 기존결합
  y5base: number;         // P열 - 5년 기본
  y5new: number;          // Q열 - 5년 신규결합
  y5exist: number;        // R열 - 5년 기존결합
  y6base: number;         // S열 - 6년 기본 ★ 최우선
  y6new: number;          // T열 - 6년 신규결합
  y6exist: number;        // U열 - 6년 기존결합
  prepay30amount: number; // V열 - 30% 선납금
  prepay30base: number;   // W열 - 30% 선납 월구독
  prepay30new: number;    // X열 - 30% 신규결합
  prepay30exist: number;  // Y열 - 30% 기존결합
  prepay50amount: number; // Z열 - 50% 선납금
  prepay50base: number;   // AA열 - 50% 선납 월구독
  prepay50new: number;    // AB열 - 50% 신규결합
  prepay50exist: number;  // AC열 - 50% 기존결합
}

// ==========================================
// 제휴카드
// ==========================================
export interface CardInfo {
  cardName: string;
  monthUsage: string;
  discountAmount: number;
  message: string;
  order: number;
}

// ==========================================
// QR코드 매핑
// ==========================================
export type QRMapping = Record<string, string>;

// ==========================================
// 케어서비스 혜택
// ==========================================
export interface CareBenefit {
  product: string;
  careKey: string;
  benefits: string[];        // 일반 혜택 01~04
  benefits_large2: string[]; // 대형2 혜택 01~04
  paymentValue: number;      // 지불가치 금액
  modelCondition: string;    // 모델 조건 (앞 3글자)
}

// ==========================================
// 템플릿 JSON
// ==========================================
export interface TemplateText {
  position_ratio: [number, number];
  font_size_pt: number;
  color: string;
  align: 'left' | 'center' | 'right';
  font_family: string;
  letter_spacing: string;
}

export interface TemplateQRSettings {
  position_ratio: [number, number];
  size_ratio: number;
}

export interface TemplateBatchSettings {
  paper_orientation: string;
  item_width_mm: number;
  item_height_mm: number;
  grid_cols: number;
  grid_rows: number;
}

export interface Template {
  name: string;
  background_color: string;
  border_color?: string;
  border_width?: number;
  background_image: string;
  background_image_base64: string;
  background_image_format?: string;
  image_size: string;
  size_dimensions: [number, number];
  texts: Record<string, TemplateText>;
  qr_settings?: TemplateQRSettings;
  qr_enabled?: boolean;
  batch_enabled?: boolean;
  batch_settings?: TemplateBatchSettings;
}

// ==========================================
// 계산 결과
// ==========================================
export interface CalculatedData {
  model: string;
  category: string;
  listPrice: number;        // 일시불/정상가
  basePrice: number;        // 기본 구독료 (GetPriorityValue)
  discountAmount: number;   // 카드 할인금액
  discountPrice: number;    // 할인 후 가격
  dailyPrice: number;       // 일구독 (÷31)
  prepay30amount: number;   // 30% 선납금
  prepay30monthly: number;  // 30% 선납 월구독
  prepay50amount: number;   // 50% 선납금
  prepay50monthly: number;  // 50% 선납 월구독
  cardMessage: string;      // 카드 안내 문구
  qrCode: string;           // QR코드 파일명
  benefits: string[];       // 케어서비스 혜택 4개
  careKey: string;
}

// ==========================================
// 앱 상태
// ==========================================
export interface AppState {
  channel: string;
  templateName: string;
  cardName: string;
  monthUsage: string;
  activationDiscount: boolean; // 활성화 할인 ON/OFF
  selectedModels: string[];
}
