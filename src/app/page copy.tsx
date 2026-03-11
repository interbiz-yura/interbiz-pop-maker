'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { loadCards, loadQRMapping, loadCareBenefits } from '@/lib/data-loader';
import {
  getCardDiscount, getUniqueCardNames, getUsagesByCard, formatNumber
} from '@/lib/price-engine';
import {
  parseExcelForCompare, comparePriceData,
  type CompareResult, type ChangeStatus
} from '@/lib/price-compare';
import { loadTemplate } from '@/lib/data-loader';
import { renderBatch, downloadImage, downloadAllImages, preloadFonts } from '@/lib/template-renderer';
import { bindAllValues } from '@/lib/data-binder';
import type { PriceRow, CardInfo, QRMapping, CareBenefit } from '@/lib/types';
import QRCode from 'qrcode';

interface TemplateInfo {
  id: string;
  name: string;
  file: string;
  pattern: 'A' | 'B';
  channel: string[];  // 추가
  qr: boolean;        // 추가
  prepay: boolean;     // 추가
}

// ==========================================
// 채널 정의
// ==========================================
const CHANNELS = [
  { id: 'emart', name: '이마트', sheet: '이마트-업데이트' },
  { id: 'homeplus', name: '홈플러스', sheet: '홈플러스-업데이트' },
  { id: 'jeonjaland', name: '전자랜드', sheet: '전자랜드-업데이트' },
  { id: 'traders', name: '트레이더스', sheet: '이마트-업데이트' },
  { id: 'electromart', name: '일렉트로마트', sheet: '이마트-업데이트' },
];

// ==========================================
// 카테고리 순서 (ㄱㄴㄷ)
// ==========================================
const CATEGORY_ORDER = [
  '가습기', '건조기', '김치냉장고', '냉장고', '로봇청소기',
  '세탁기', '스탠바이미', '식기세척기', '에어케어', '에어컨',
  '얼음정수기', '정수기', '청소기', 'TV'
];

// ==========================================
// 엑셀 파서 (SheetJS)
// ==========================================
async function parseExcelFromURL(url: string, sheetName: string): Promise<PriceRow[]> {
  const XLSX = await import('xlsx');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`파일 로드 실패: ${url} (${res.status})`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) throw new Error(`잘못된 응답 (HTML): ${url}`);
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    console.warn(`[POP] 시트 '${sheetName}'를 찾을 수 없음. 사용 가능: ${wb.SheetNames.join(', ')}`);
    return [];
  }

  const rows: PriceRow[] = [];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  for (let r = 4; r <= range.e.r; r++) {
    const cell = (c: number) => ws[XLSX.utils.encode_cell({ r, c })]?.v;
    const model = cell(4);
    if (!model) continue;

    const num = (c: number) => { const v = cell(c); return typeof v === 'number' ? v : (parseInt(String(v)) || 0); };
    const str = (c: number) => { const v = cell(c); return v != null ? String(v).trim() : ''; };

    rows.push({
      channel: str(0), category: str(3), model: str(4), listPrice: num(5),
      careType: str(6), careGrade: str(7), visitCycle: str(8), careKey: str(9),
      activation: num(10),
      y3base: num(11), y4base: num(12), y4new: num(13), y4exist: num(14),
      y5base: num(15), y5new: num(16), y5exist: num(17),
      y6base: num(18), y6new: num(19), y6exist: num(20),
      prepay30amount: num(21), prepay30base: num(22), prepay30new: num(23), prepay30exist: num(24),
      prepay50amount: num(25), prepay50base: num(26), prepay50new: num(27), prepay50exist: num(28),
    });
  }
  return rows;
}

// ==========================================
// 모델별 행 그룹 타입
// ==========================================
interface ModelGroup {
  model: string;
  category: string;
  rows: PriceRow[];
}

// ==========================================
// 계약기간별 가격 가져오기
// ==========================================
function getPriceByPeriod(row: PriceRow, period: string, activationOn: boolean): number {
  const kBonus = activationOn ? 0 : (row.activation || 0);
  let base = 0;
  switch (period) {
    case '6년': base = row.y6base || 0; break;
    case '5년': base = row.y5base || 0; break;
    case '4년': base = row.y4base || 0; break;
    case '3년': base = row.y3base || 0; break;
  }
  if (base > 0 && kBonus > 0) base += kBonus;
  return base;
}

function getAvailablePeriods(row: PriceRow): string[] {
  const periods: string[] = [];
  if (row.y6base && row.y6base > 0) periods.push('6년');
  if (row.y5base && row.y5base > 0) periods.push('5년');
  if (row.y4base && row.y4base > 0) periods.push('4년');
  if (row.y3base && row.y3base > 0) periods.push('3년');
  return periods;
}

function formatDateStr(d: string): string {
  if (d.length !== 6) return d;
  return `20${d.slice(0,2)}.${d.slice(2,4)}.${d.slice(4,6)}`;
}

// 변동 상태 설정
const STATUS_CONFIG: Record<ChangeStatus, { color: string; bg: string; label: string; border: string }> = {
  new:     { color: '#16A34A', bg: '#F0FDF4', label: '신규', border: '#BBF7D0' },
  down:    { color: '#2563EB', bg: '#EFF6FF', label: '인하', border: '#BFDBFE' },
  up:      { color: '#EA580C', bg: '#FFF7ED', label: '인상', border: '#FED7AA' },
  deleted: { color: '#9CA3AF', bg: '#F9FAFB', label: '삭제', border: '#E5E7EB' },
};

// 상태 순서
const STATUS_ORDER: ChangeStatus[] = ['new', 'down', 'up', 'deleted'];

// ==========================================
// 메인 컴포넌트
// ==========================================
export default function PopMakerPage() {
  // ----- 데이터 로딩 상태 -----
  const [priceData, setPriceData] = useState<PriceRow[]>([]);
  const [cards, setCards] = useState<CardInfo[]>([]);
  const [qrMapping, setQrMapping] = useState<QRMapping>({});
  const [careBenefits, setCareBenefits] = useState<CareBenefit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ----- UI 상태 -----
  const [channel, setChannel] = useState(CHANNELS[0]);
  const [priceDates, setPriceDates] = useState<string[]>([]);
  const [latestDate, setLatestDate] = useState('');
  const [cardName, setCardName] = useState('');
  const [monthUsage, setMonthUsage] = useState('');
  const [activationOn, setActivationOn] = useState(false);
  const [qrOn, setQrOn] = useState(true);
  const [showSuffix, setShowSuffix] = useState(false);
  const [prepay, setPrepay] = useState('없음');
  const [activeCategory, setActiveCategory] = useState('전체');
  const [searchQuery, setSearchQuery] = useState('');
  const [checkedModels, setCheckedModels] = useState<Set<string>>(new Set());
  const [templateThumb, setTemplateThumb] = useState<string>('');
  const [templateBatch, setTemplateBatch] = useState<any>(null);
  const [templateBatchEnabled, setTemplateBatchEnabled] = useState(true);
  const [templateOrientation, setTemplateOrientation] = useState<'가로' | '세로'>('가로');
  

  // ----- 모델별 드롭다운 선택 상태 -----
  const [modelSelections, setModelSelections] = useState<Record<string, {
    period: string; careType: string; careGrade: string; visitCycle: string;
  }>>({});

  // ----- 변동 제품 상태 -----
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [selectedCompareDate, setSelectedCompareDate] = useState('');
  const [changeFilter, setChangeFilter] = useState<'all' | ChangeStatus>('all');
  // 삭제 모델용: 이전 엑셀의 PriceRow 데이터
  const [prevPriceData, setPrevPriceData] = useState<PriceRow[]>([]);

  // ----- 가격표 생성 상태 -----
  const [generating, setGenerating] = useState(false);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [generatedNames, setGeneratedNames] = useState<string[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [genProgress, setGenProgress] = useState({ current: 0, total: 0 });

  // ----- 캘린더 상태 -----
  const [calendarMonth, setCalendarMonth] = useState<Date>(new Date());
  const [showCalendar, setShowCalendar] = useState(false);

  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [template, setTemplate] = useState<TemplateInfo>({ id: '', name: '', file: '', pattern: 'B', channel: [], qr: false, prepay: false });

  // 템플릿 타입 판단
  const isPrepayTemplate = template.prepay === true;
  const isPrepayDetailTemplate = template.id?.includes('prepay-detail') || false;

  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [printSize, setPrintSize] = useState<'기본' | 'A4' | 'A5' | 'A6'>('기본');

  // ----- 데이터 로딩 -----
  useEffect(() => {
    async function loadAll() {
      try {
        setLoading(true);
        setError(null);

        // price-index.json에서 파일 목록 로드
        let dates: string[] = [];
        try {
          const indexRes = await fetch('/data/price-index.json');
          const files: string[] = await indexRes.json();
          // 파일명에서 날짜 추출: price_260303.xlsx → 260303
          dates = files.map(f => f.replace('price_', '').replace('.xlsx', '')).sort();
        } catch {
          console.warn('price-index.json 로드 실패');
        }
        setPriceDates(dates);

        const latest = dates[dates.length - 1] || '';
        setLatestDate(latest);
        if (!latest) throw new Error('가격표 파일이 없습니다.');

        const [price, cardData, qr, care] = await Promise.all([
          parseExcelFromURL(`/data/price_${latest}.xlsx`, channel.sheet),
          loadCards(),
          loadQRMapping(),
          loadCareBenefits(),
        ]);
        setPriceData(price);
        console.log(`[POP] price_${latest}.xlsx → ${price.length}행 로드, activation>0: ${price.filter(r => (r.activation||0) > 0).length}개`);
        setCards(cardData);
        setQrMapping(qr);
        setCareBenefits(care);
        setModelSelections({});
        setCheckedModels(new Set());
        setCompareResult(null);
        setSelectedCompareDate('');
        setPrevPriceData([]);
      } catch (e) {
        setError('데이터를 불러오는데 실패했습니다.');
        console.error(e);
      } finally {
        setLoading(false);
      }

      // price-index.json 로드 코드 아래에
      try {
        const tmplRes = await fetch('/data/templates/template-index.json');
        const tmplList: TemplateInfo[] = await tmplRes.json();
        setTemplates(tmplList);
        if (tmplList.length > 0 && !template.file) setTemplate(tmplList[0]);
      } catch {
        console.warn('template-index.json 로드 실패');
      }
    }
    loadAll();
  }, [channel]);


  useEffect(() => {
    if (!template.file) { setTemplateThumb(''); return; }
    (async () => {
      try {
        const res = await fetch(`/data/templates/${template.file}`);
        const json = await res.json();
        console.log('[THUMB] keys:', Object.keys(json));
        console.log('[THUMB] has background_image:', !!json.background_image);
        console.log('[THUMB] format:', json.background_image_format);
        console.log('[THUMB] base64 length:', json.background_image?.length);
        console.log('[THUMB] value:', json.background_image);
        console.log('[THUMB] keys:', Object.keys(json).join(', '));
          if (json.background_image_base64) {
          const fmt = (json.background_image_format || 'png').replace('.', '');
          const binary = atob(json.background_image_base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: `image/${fmt}` });
          const url = URL.createObjectURL(blob);
          console.log('[THUMB] blob url:', url);
          setTemplateBatch(json.batch_settings || null);
          setTemplateBatchEnabled(json.batch_enabled !== false);
          console.log('[BATCH] enabled:', json.batch_enabled, '→', json.batch_enabled !== false);
          const [w, h] = json.size_dimensions || [2700, 1900];
          setTemplateOrientation(w > h ? '가로' : '세로');
          console.log('[ORIENT] size:', json.size_dimensions, 'w:', w, 'h:', h, '→', w > h ? '가로' : '세로');
          setTemplateThumb(url);
        } else {
          setTemplateThumb('');
        }
      } catch (e) { console.error('[THUMB] error:', e); setTemplateThumb(''); }
    })();
  }, [template]);

  // ----- 변동 비교 실행 -----
  const runCompare = useCallback(async (oldDate: string) => {
    if (!latestDate || oldDate === latestDate) return;
    try {
      setCompareLoading(true);
      setSelectedCompareDate(oldDate);

      // 비교 엔진용 파싱 + 삭제 모델 표시용 전체 PriceRow 파싱
      const [prevRowsCompare, currRowsCompare, prevFull] = await Promise.all([
        parseExcelForCompare(`/data/price_${oldDate}.xlsx`, channel.sheet),
        parseExcelForCompare(`/data/price_${latestDate}.xlsx`, channel.sheet),
        parseExcelFromURL(`/data/price_${oldDate}.xlsx`, channel.sheet),
      ]);

      const result = comparePriceData(prevRowsCompare, currRowsCompare);
      setCompareResult(result);
      setPrevPriceData(prevFull);
      setChangeFilter('all');
    } catch (e) {
      console.error('비교 실패:', e);
      setCompareResult(null);
    } finally {
      setCompareLoading(false);
    }
  }, [latestDate, channel.sheet]);

  // ----- 모델별 그룹핑 -----
  const categoryModelGroups = useMemo(() => {
    const modelMap: Record<string, PriceRow[]> = {};
    const modelCategory: Record<string, string> = {};
    for (const row of priceData) {
      const model = row.model?.trim();
      const cat = row.category?.trim();
      if (!model || !cat) continue;
      if (!modelMap[model]) {
        modelMap[model] = [];
        modelCategory[model] = cat;
      }
      modelMap[model].push(row);
    }

    const groups: Record<string, ModelGroup[]> = {};
    for (const [model, rows] of Object.entries(modelMap)) {
      const cat = modelCategory[model];
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ model, category: cat, rows });
    }

    const sorted: Record<string, ModelGroup[]> = {};
    for (const cat of CATEGORY_ORDER) {
      if (groups[cat]) sorted[cat] = groups[cat];
    }
    for (const cat of Object.keys(groups).sort()) {
      if (!sorted[cat]) sorted[cat] = groups[cat];
    }
    return sorted;
  }, [priceData]);

  // ----- 이전 데이터 모델 그룹핑 (삭제 모델용) -----
  const prevModelGroups = useMemo(() => {
    const map: Record<string, ModelGroup> = {};
    for (const row of prevPriceData) {
      const model = row.model?.trim();
      if (!model) continue;
      if (!map[model]) map[model] = { model, category: row.category?.trim() || '', rows: [] };
      map[model].rows.push(row);
    }
    return map;
  }, [prevPriceData]);

  // ----- 카테고리 목록 -----
  const categories = useMemo(() => Object.keys(categoryModelGroups), [categoryModelGroups]);

  // ----- 활성화 제품 필터 -----
  const activationModelGroups = useMemo(() => {
    const result: Record<string, ModelGroup[]> = {};
    for (const [cat, groups] of Object.entries(categoryModelGroups)) {
      const filtered = groups.filter(g => g.rows.some(r => (r.activation || 0) > 0));
      if (filtered.length > 0) result[cat] = filtered;
    }
    return result;
  }, [categoryModelGroups]);

  const activationCount = useMemo(
    () => Object.values(activationModelGroups).flat().length,
    [activationModelGroups]
  );

// ----- 30% 선납 필터 -----
  const prepay30ModelGroups = useMemo(() => {
    const result: Record<string, ModelGroup[]> = {};
    for (const [cat, groups] of Object.entries(categoryModelGroups)) {
      const filtered = groups.filter(g => g.rows.some(r => (r.prepay30base || 0) > 0));
      if (filtered.length > 0) result[cat] = filtered;
    }
    return result;
  }, [categoryModelGroups]);

  const prepay30Count = useMemo(
    () => Object.values(prepay30ModelGroups).flat().length,
    [prepay30ModelGroups]
  );

  // ----- 50% 선납 필터 -----
  const prepay50ModelGroups = useMemo(() => {
    const result: Record<string, ModelGroup[]> = {};
    for (const [cat, groups] of Object.entries(categoryModelGroups)) {
      const filtered = groups.filter(g => g.rows.some(r => (r.prepay50base || 0) > 0));
      if (filtered.length > 0) result[cat] = filtered;
    }
    return result;
  }, [categoryModelGroups]);

  const prepay50Count = useMemo(
    () => Object.values(prepay50ModelGroups).flat().length,
    [prepay50ModelGroups]
  );

  // ----- 변동 제품 카운트 -----
  const changeCount = useMemo(() => compareResult?.summary.totalChanges || 0, [compareResult]);

  // ----- 변동 제품: 상태별 그룹 데이터 (기존 테이블 형태로) -----
  const changeTableData = useMemo(() => {
    if (!compareResult) return [];

    const result: { status: ChangeStatus; label: string; groups: ModelGroup[]; isDeleted: boolean }[] = [];

    for (const status of STATUS_ORDER) {
      let modelNames: Set<string>;
      switch (status) {
        case 'new': modelNames = compareResult.newModels; break;
        case 'down': modelNames = compareResult.priceDownModels; break;
        case 'up': modelNames = compareResult.priceUpModels; break;
        case 'deleted': modelNames = compareResult.deletedModels; break;
      }

      if (modelNames.size === 0) continue;

      const groups: ModelGroup[] = [];
      for (const model of Array.from(modelNames)) {
        if (status === 'deleted') {
          // 삭제 모델 → 이전 데이터
          const prev = prevModelGroups[model];
          if (prev) groups.push(prev);
        } else {
          // 신규/인하/인상 → 현재 데이터
          const allCurrGroups = Object.values(categoryModelGroups).flat();
          const found = allCurrGroups.find(g => g.model === model);
          if (found) groups.push(found);
        }
      }

      if (groups.length > 0) {
        result.push({
          status,
          label: STATUS_CONFIG[status].label,
          groups,
          isDeleted: status === 'deleted',
        });
      }
    }

    return result;
  }, [compareResult, categoryModelGroups, prevModelGroups]);

  // ----- 필터 적용된 변동 테이블 -----
  const filteredChangeTableData = useMemo(() => {
    if (changeFilter === 'all') return changeTableData;
    return changeTableData.filter(s => s.status === changeFilter);
  }, [changeTableData, changeFilter]);

  const filteredData = useMemo(() => {
      let data: Record<string, ModelGroup[]> = {};
      if (activeCategory === '전체') data = categoryModelGroups;
      else if (activeCategory === '활성화 제품') data = activationModelGroups;
      else if (activeCategory === '변동 제품') return {};
      else if (activeCategory === '30%선납') data = prepay30ModelGroups;
      else if (activeCategory === '50%선납') data = prepay50ModelGroups;
      else if (categoryModelGroups[activeCategory]) {
        data = { [activeCategory]: categoryModelGroups[activeCategory] };
      }

      // 검색어 필터
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const result: Record<string, ModelGroup[]> = {};
        for (const [cat, groups] of Object.entries(data)) {
          const filtered = groups.filter(g => g.model.toLowerCase().includes(q));
          if (filtered.length > 0) result[cat] = filtered;
        }
        return result;
      }

      return data;
    }, [activeCategory, categoryModelGroups, activationModelGroups, searchQuery]);

  const visibleCategories = useMemo(() => Object.keys(filteredData), [filteredData]);
  const totalModels = useMemo(() => Object.values(categoryModelGroups).flat().length, [categoryModelGroups]);
  const filteredCount = useMemo(() => Object.values(filteredData).flat().length, [filteredData]);

  // ----- 모델의 현재 선택에 해당하는 행 찾기 -----
  const getSelectedRow = useCallback((group: ModelGroup): PriceRow => {
    const sel = modelSelections[group.model];
    if (!sel) {
      let minPrice = Infinity;
      let minRow = group.rows[0];
      for (const row of group.rows) {
        const price = row.y6base || row.y5base || row.y4base || row.y3base || 0;
        if (price > 0 && price < minPrice) {
          minPrice = price;
          minRow = row;
        }
      }
      return minRow;
    }

    let candidates = group.rows;
    if (sel.careType) {
      const filtered = candidates.filter(r => r.careType === sel.careType);
      if (filtered.length > 0) candidates = filtered;
    }
    if (sel.careGrade) {
      const filtered = candidates.filter(r => r.careGrade === sel.careGrade);
      if (filtered.length > 0) candidates = filtered;
    }
    if (sel.visitCycle) {
      const filtered = candidates.filter(r => r.visitCycle === sel.visitCycle);
      if (filtered.length > 0) candidates = filtered;
    }
    return candidates[0];
  }, [modelSelections]);

  // ----- 연쇄 드롭다운 옵션 계산 -----
  const getDropdownOptions = useCallback((group: ModelGroup) => {
    const sel = modelSelections[group.model] || {};

    const careTypes = Array.from(new Set(group.rows.map(r => r.careType).filter(Boolean)));

    let careGradeRows = group.rows;
    if (sel.careType) {
      const f = careGradeRows.filter(r => r.careType === sel.careType);
      if (f.length > 0) careGradeRows = f;
    }
    const careGrades = Array.from(new Set(careGradeRows.map(r => r.careGrade).filter(Boolean)));

    let visitRows = careGradeRows;
    if (sel.careGrade) {
      const f = visitRows.filter(r => r.careGrade === sel.careGrade);
      if (f.length > 0) visitRows = f;
    }
    const visitCycles = Array.from(new Set(visitRows.map(r => r.visitCycle).filter(Boolean)));

    return { careTypes, careGrades, visitCycles };
  }, [modelSelections]);

  // ----- 드롭다운 변경 핸들러 -----
  const updateSelection = useCallback((model: string, field: string, value: string) => {
    setModelSelections(prev => {
      const current = prev[model] || { period: '6년', careType: '', careGrade: '', visitCycle: '' };
      const next = { ...current, [field]: value };

      if (field === 'careType') {
        next.careGrade = '';
        next.visitCycle = '';
      } else if (field === 'careGrade') {
        next.visitCycle = '';
      }

      return { ...prev, [model]: next };
    });
  }, []);

  // ----- 가격 계산 -----
  const getCalculatedPrice = useCallback((group: ModelGroup) => {
    const sel = modelSelections[group.model];
    const row = getSelectedRow(group);
    const defaultPeriod = row.y6base ? '6년' : row.y5base ? '5년' : row.y4base ? '4년' : row.y3base ? '3년' : '6년';
    const period = sel?.period || defaultPeriod;

    const basePrice = getPriceByPeriod(row, period, activationOn);
    const { discountAmount } = getCardDiscount(cards, cardName, monthUsage);
    const discountPrice = Math.max(0, basePrice - discountAmount);
    const dailyPrice = discountPrice > 0 ? Math.round(discountPrice / 31) : 0;
    return { basePrice, discountAmount, discountPrice, dailyPrice, activation: row.activation || 0 };
  }, [getSelectedRow, modelSelections, activationOn, cards, cardName, monthUsage]);

  // ----- 카드 목록 -----
  const uniqueCardNames = useMemo(() => getUniqueCardNames(cards), [cards]);
  const usageList = useMemo(
    () => cardName ? getUsagesByCard(cards, cardName) : [],
    [cards, cardName]
  );

  // ----- 체크박스 핸들러 -----
  const toggleModel = useCallback((model: string) => {
    setCheckedModels(prev => {
      const next = new Set(prev);
      next.has(model) ? next.delete(model) : next.add(model);
      return next;
    });
  }, []);

  const toggleCatAll = useCallback((cat: string) => {
    const groups = filteredData[cat] || [];
    const allChecked = groups.every(g => checkedModels.has(g.model));
    setCheckedModels(prev => {
      const next = new Set(prev);
      groups.forEach(g => allChecked ? next.delete(g.model) : next.add(g.model));
      return next;
    });
  }, [filteredData, checkedModels]);

  const toggleAll = useCallback(() => {
    const allGroups = Object.values(filteredData).flat();
    const allChecked = allGroups.every(g => checkedModels.has(g.model));
    setCheckedModels(prev => {
      const next = new Set(prev);
      allGroups.forEach(g => allChecked ? next.delete(g.model) : next.add(g.model));
      return next;
    });
  }, [filteredData, checkedModels]);

  // ----- 변동 제품 전체선택 (삭제 제외) -----
  const toggleAllChanges = useCallback(() => {
    const selectableGroups = filteredChangeTableData
      .filter(s => !s.isDeleted)
      .flatMap(s => s.groups);
    const allChecked = selectableGroups.every(g => checkedModels.has(g.model));
    setCheckedModels(prev => {
      const next = new Set(prev);
      selectableGroups.forEach(g => allChecked ? next.delete(g.model) : next.add(g.model));
      return next;
    });
  }, [filteredChangeTableData, checkedModels]);

  // ----- 변동 상태별 전체선택 -----
  const toggleStatusAll = useCallback((status: ChangeStatus) => {
    if (status === 'deleted') return; // 삭제는 선택 불가
    const section = changeTableData.find(s => s.status === status);
    if (!section) return;
    const allChecked = section.groups.every(g => checkedModels.has(g.model));
    setCheckedModels(prev => {
      const next = new Set(prev);
      section.groups.forEach(g => allChecked ? next.delete(g.model) : next.add(g.model));
      return next;
    });
  }, [changeTableData, checkedModels]);

  // ----- 카드 변경 시 월실적 리셋 -----
  useEffect(() => { setMonthUsage(''); }, [cardName]);

  useEffect(() => {
    const filtered = templates.filter(t => t.channel?.includes(channel.id));
    if (filtered.length > 0) setTemplate(filtered[0]);
  }, [channel, templates]);

    useEffect(() => {
    if (isPrepayDetailTemplate) {
      setPrepay('30%');
    }
  }, [template]);

  // ----- 가격표 생성 -----
  const handleGenerate = useCallback(async () => {
      if (checkedModels.size === 0 || !template.file) return;
      setGenerating(true);
      setGeneratedImages([]);
      setGeneratedNames([]);
      setGenProgress({ current: 0, total: checkedModels.size });
      try {
        const tmpl = await loadTemplate(template.file);
        const models = Array.from(checkedModels);
        const allValues: Record<string, string>[] = [];
        const allNames: string[] = [];
        const textNames = Object.keys(tmpl.texts || {});
        const allGroups = Object.values(categoryModelGroups).flat();

// 카드 할인 정보 — 선납 금액별 가격표는 order 기반 자동, 나머지는 사용자 선택
      const isPrepayDetail = template.id?.includes('prepay-detail');
      let discountAmount: number, cardMsg: string;
      let discountAmount2 = 0, cardMessage2 = '';

      if (isPrepayDetail && cardName) {
        // 선납 금액별: 카드의 order 1, 2 자동
        const card1 = cards.find(c => c.cardName === cardName && c.order === 1);
        const card2 = cards.find(c => c.cardName === cardName && c.order === 2);
        discountAmount = card1 ? card1.discountAmount : 16000;
        cardMsg = card1 ? card1.message : '※제휴카드 혜택 금액';
        discountAmount2 = card2 ? card2.discountAmount : 0;
        cardMessage2 = card2 ? card2.message : '';
      } else {
        // 일반: 사용자가 선택한 monthUsage 기반
        const result = getCardDiscount(cards, cardName, monthUsage);
        discountAmount = result.discountAmount;
        cardMsg = result.message;
        const card2 = cards.find(c => c.cardName === cardName && c.order === 2);
        discountAmount2 = card2 ? card2.discountAmount : 0;
        cardMessage2 = card2 ? card2.message : '';
      }

        for (let i = 0; i < models.length; i++) {
          const modelName = models[i];
          setGenProgress({ current: i + 1, total: models.length });

          // 모델 그룹 찾기
          const group = allGroups.find(g => g.model === modelName);
          if (!group) continue;

          // 선택된 행 & 가격 계산
          const row = getSelectedRow(group);
          const sel = modelSelections[modelName];
          const defaultPeriod = row.y6base ? '6년' : row.y5base ? '5년' : row.y4base ? '4년' : '3년';
          const period = sel?.period || defaultPeriod;
          const basePrice = getPriceByPeriod(row, period, activationOn);
          const finalPrice = Math.max(0, basePrice - discountAmount);
          const dailyPrice = finalPrice > 0 ? Math.round(finalPrice / 31) : 0;

          // 케어서비스 혜택 찾기
          const careKey = row.careKey || '';
          const careBenefit = careBenefits.find(cb => cb.careKey === careKey);
          const benefits = careBenefit?.benefits || ['', '', '', ''];

          // QR코드
          const qrCode = qrMapping[modelName] || '';

          // CalculatedData 생성
          const calcData = {
            model: showSuffix ? modelName : (modelName.includes('.') ? modelName.split('.')[0] : modelName),
            category: row.category || '',
            listPrice: row.listPrice || 0,
            basePrice,
            discountAmount,
            discountPrice: finalPrice,
            dailyPrice,
            prepay30amount: row.prepay30amount || 0,
            prepay30monthly: row.prepay30base ? Math.max(0, row.prepay30base - discountAmount) : 0,
            prepay50amount: row.prepay50amount || 0,
            prepay50monthly: row.prepay50base ? Math.max(0, row.prepay50base - discountAmount) : 0,
            cardMessage: cardMsg,
            qrCode,
            benefits,
            careKey,
            discountAmount2,
            discountPrice2: Math.max(0, basePrice - discountAmount2),
            cardMessage2,
            prepay30monthly2: row.prepay30base ? Math.max(0, row.prepay30base - discountAmount2) : 0,
            prepay50monthly2: row.prepay50base ? Math.max(0, row.prepay50base - discountAmount2) : 0,
          };

          const values = bindAllValues(textNames, calcData);
          allValues.push(values);
          allNames.push(modelName);
        }
        if (allValues.length === 0) { setGenerating(false); return; }

  // 출력 설정 오버라이드
        if (printSize !== '기본') {
          // 템플릿 비율로 최적 방향 자동 결정
          const [tw, th] = tmpl.size_dimensions || [2700, 1900];
          const isLandscape = tw > th;
          
          const autoOrientation = (() => {
            if (printSize === 'A4') return isLandscape ? '가로' : '세로';
            if (printSize === 'A5') return isLandscape ? '세로' : '가로';
            if (printSize === 'A6') return isLandscape ? '가로' : '세로';
            return '가로';
          })();
          const sizeConfig = {
            'A4': { cols: 1, rows: 1, w_mm: autoOrientation === '가로' ? 297 : 210, h_mm: autoOrientation === '가로' ? 210 : 297 },
            'A5': { cols: 1, rows: 2, w_mm: autoOrientation === '세로' ? 210 : 297, h_mm: autoOrientation === '세로' ? 148 : 105 },
            'A6': { cols: 2, rows: 2, w_mm: isLandscape ? 148 : 105, h_mm: isLandscape ? 105 : 148 },
          }[printSize]!;

          tmpl.batch_enabled = true;
          tmpl.batch_settings = {
            paper_orientation: autoOrientation,
            item_width_mm: sizeConfig.w_mm,
            item_height_mm: sizeConfig.h_mm,
            grid_cols: sizeConfig.cols,
            grid_rows: sizeConfig.rows,
          };
        }

        // QR코드 생성
        let qrDataUrls: string[] = [];
        if (tmpl.qr_enabled) {
          for (const modelName of allNames) {
            const group = allGroups.find(g => g.model === modelName);
            const category = group?.category || '';
            const qrUrl = qrMapping[category] || '';
            console.log('[QR]', modelName, '→ category:', category, '→ url:', qrUrl);
            console.log('[QR] qrOn:', qrOn, 'qr_enabled:', tmpl.qr_enabled);
            console.log('[QR] category:', JSON.stringify(category), '→ mapping keys:', Object.keys(qrMapping).filter(k => k.includes(category.slice(0, 2))));
            if (qrUrl) {
              try {
                const dataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 1 });
                qrDataUrls.push(dataUrl);
              } catch {
                qrDataUrls.push('');
              }
            } else {
              qrDataUrls.push('');
            }
          }
        }


        console.log('[GEN] batch:', printSize, tmpl.batch_enabled, tmpl.batch_settings);
        const images = await renderBatch(tmpl, allValues, qrDataUrls);
        setGeneratedImages(images);
        setGeneratedNames(allNames);
        setPreviewIndex(0);
        setShowPreview(true);
      } catch (e) {
        console.error('가격표 생성 실패:', e);
        alert('가격표 생성 중 오류가 발생했습니다.');
      } finally {
        setGenerating(false);
      }
    }, [checkedModels, template, categoryModelGroups, getSelectedRow, modelSelections, activationOn, cards, cardName, monthUsage, careBenefits, qrMapping, printSize, qrOn, showSuffix]);
    // ----- 비교 가능한 과거 날짜 (최신 제외) -----
    const comparableDates = useMemo(
      () => priceDates.filter(d => d !== latestDate),
      [priceDates, latestDate]
      
    );


  // ----- 로딩/에러 -----
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f3f0]">
        <div className="text-center">
          <div className="w-10 h-10 border-[3px] border-[#A50034] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-500">데이터 로딩 중...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f3f0]">
        <div className="text-center p-8 bg-white rounded-xl shadow-sm">
          <p className="text-red-500 font-semibold mb-2">⚠️ {error}</p>
          <button onClick={() => window.location.reload()} className="text-sm text-[#A50034] underline">다시 시도</button>
        </div>
      </div>
    );
  }

  // ==========================================
  // 테이블 행 렌더링 함수 (공통)
  // ==========================================
  function renderModelRow(group: ModelGroup, options: {
    disabled?: boolean;
    statusBadge?: ChangeStatus;
    showChange?: boolean;
  } = {}) {
    const { disabled = false, statusBadge, showChange = false } = options;
    const checked = checkedModels.has(group.model);
    const calc = getCalculatedPrice(group);
    const sel = modelSelections[group.model] || { period: '6년', careType: '', careGrade: '', visitCycle: '' };
    const opts = getDropdownOptions(group);
    const selectedRow = getSelectedRow(group);
    const prepay30 = selectedRow.prepay30base || 0;
    const prepay50 = selectedRow.prepay50base || 0;
    const availPeriods = getAvailablePeriods(selectedRow);

    // 변동 정보
    const changeInfo = compareResult?.modelChanges.get(group.model);

    return (
      <tr key={group.model}
        className="border-t border-gray-50 transition-all"
        style={{
          background: disabled ? '#f5f5f5' : checked ? '#fff' : '#fafafa',
          opacity: disabled ? 0.45 : checked ? 1 : 0.5,
        }}>
        {/* 체크박스 */}
        <td className="text-center p-2">
          {disabled ? (
            <span className="text-gray-300 text-xs">—</span>
          ) : (
            <div className="cursor-pointer" onClick={() => toggleModel(group.model)}>
              <input type="checkbox" checked={checked} onChange={() => {}} className="w-4 h-4 accent-[#A50034] cursor-pointer" />
            </div>
          )}
        </td>
        {/* 모델명 + 상태 뱃지 */}
        <td className={`p-2 font-bold text-[11px] tracking-tight ${disabled ? '' : 'cursor-pointer'}`}
          onClick={() => !disabled && toggleModel(group.model)}
          style={{ fontFamily: "'Inter', sans-serif", color: disabled ? '#aaa' : '#374151' }}>
          <div className="flex items-center gap-1.5">
            {group.model}
            {statusBadge && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                style={{ background: STATUS_CONFIG[statusBadge].bg, color: STATUS_CONFIG[statusBadge].color, border: `1px solid ${STATUS_CONFIG[statusBadge].border}` }}>
                {STATUS_CONFIG[statusBadge].label}
              </span>
            )}
          </div>
        </td>
        {/* 계약기간 */}
        <td className="text-center p-2">
          {availPeriods.length === 0 ? (
            <span className="text-[11px] text-gray-400">-</span>
          ) : availPeriods.length === 1 ? (
            <span className="text-[11px]" style={{ color: disabled ? '#bbb' : '#374151' }}>{availPeriods[0]}</span>
          ) : (
            <select value={sel.period || availPeriods[0]}
              disabled={disabled}
              onChange={e => { e.stopPropagation(); updateSelection(group.model, 'period', e.target.value); }}
              onClick={e => e.stopPropagation()}
              className="text-[11px] p-1 rounded border border-gray-200 bg-white cursor-pointer w-full text-gray-700">
              {availPeriods.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
        </td>
        {/* 케어십형태 */}
        <td className="text-center p-2">
          {opts.careTypes.length <= 1 ? (
            <span className="text-[11px]" style={{ color: disabled ? '#bbb' : '#6B7280' }}>{opts.careTypes[0] || '-'}</span>
          ) : (
            <select value={sel.careType || opts.careTypes[0]}
              disabled={disabled}
              onChange={e => { e.stopPropagation(); updateSelection(group.model, 'careType', e.target.value); }}
              onClick={e => e.stopPropagation()}
              className="text-[11px] p-1 rounded border border-gray-200 bg-white cursor-pointer w-full text-gray-700">
              {opts.careTypes.map(ct => <option key={ct} value={ct}>{ct}</option>)}
            </select>
          )}
        </td>
        {/* 케어십구분 */}
        <td className="text-center p-2">
          {opts.careGrades.length <= 1 ? (
            <span className="text-[11px]" style={{ color: disabled ? '#bbb' : '#374151' }}>{opts.careGrades[0] || '-'}</span>
          ) : (
            <select value={sel.careGrade || opts.careGrades[0]}
              disabled={disabled}
              onChange={e => { e.stopPropagation(); updateSelection(group.model, 'careGrade', e.target.value); }}
              onClick={e => e.stopPropagation()}
              className="text-[11px] p-1 rounded border border-gray-200 bg-white cursor-pointer w-full text-gray-700">
              {opts.careGrades.map(cg => <option key={cg} value={cg}>{cg}</option>)}
            </select>
          )}
        </td>
        {/* 방문주기 */}
        <td className="text-center p-2">
          {opts.visitCycles.length <= 1 ? (
            <span className="text-[11px]" style={{ color: disabled ? '#bbb' : '#374151' }}>{opts.visitCycles[0] || '-'}</span>
          ) : (
            <select value={sel.visitCycle || opts.visitCycles[0]}
              disabled={disabled}
              onChange={e => { e.stopPropagation(); updateSelection(group.model, 'visitCycle', e.target.value); }}
              onClick={e => e.stopPropagation()}
              className="text-[11px] p-1 rounded border border-gray-200 bg-white cursor-pointer w-full text-gray-700">
              {opts.visitCycles.map(vc => <option key={vc} value={vc}>{vc}</option>)}
            </select>
          )}
        </td>
        {/* 정상구독료 */}
        <td className="text-center p-2 font-semibold" style={{ color: disabled ? '#bbb' : '#1F2937' }}>
          {formatNumber(calc.basePrice)}
        </td>
        {/* 활성화 */}
        <td className="text-center p-2 font-semibold" style={{
          color: disabled ? '#ddd' : !activationOn ? '#ccc' : calc.activation > 0 ? '#E67E22' : '#ccc',
          fontWeight: disabled || !activationOn ? 400 : calc.activation > 0 ? 700 : 400,
          textDecoration: !disabled && !activationOn && calc.activation > 0 ? 'line-through' : 'none',
        }}>{formatNumber(calc.activation)}</td>
        {/* 카드혜택 */}
        <td className="text-center p-2 font-bold" style={{ color: disabled ? '#bbb' : '#2563EB' }}>
          {formatNumber(calc.discountAmount)}
        </td>
        {/* 월구독료 */}
        <td className="text-center p-2">
          <span className="font-extrabold text-sm" style={{ color: disabled ? '#bbb' : '#A50034' }}>
            {formatNumber(calc.discountPrice)}
          </span>
          <div className="text-[9px] mt-0.5" style={{ color: disabled ? '#ccc' : '#9CA3AF' }}>
            일 {formatNumber(calc.dailyPrice)}원
          </div>
        </td>

        {/* 30% 선납 */}
        <td className="text-center p-2">
          {prepay30 > 0 ? (
            <span className="text-[11px] font-semibold" style={{ color: disabled ? '#bbb' : '#0D9488' }}>
              {formatNumber(Math.max(0, prepay30 - calc.discountAmount))}
            </span>
          ) : (
            <span className="text-[10px] text-gray-300">-</span>
          )}
        </td>
        {/* 50% 선납 */}
        <td className="text-center p-2">
          {prepay50 > 0 ? (
            <span className="text-[11px] font-semibold" style={{ color: disabled ? '#bbb' : '#7C3AED' }}>
              {formatNumber(Math.max(0, prepay50 - calc.discountAmount))}
            </span>
          ) : (
            <span className="text-[10px] text-gray-300">-</span>
          )}
        </td>

        {/* 변동 정보 (변동 제품 탭에서만) */}
        {showChange && (
          <td className="text-center p-2">
            {changeInfo && (changeInfo.mainDiff !== 0) ? (
              <div>
                <span className="text-[10px] font-bold" style={{
                  color: changeInfo.mainDiff < 0 ? '#2563EB' : '#EA580C'
                }}>
                  {changeInfo.mainDiff > 0 ? '+' : ''}{formatNumber(changeInfo.mainDiff)}원
                </span>
                <div className="text-[9px] text-gray-400 mt-0.5">
                  {formatNumber(changeInfo.mainPrevPrice)} → {formatNumber(changeInfo.mainCurrPrice)}
                </div>
              </div>
            ) : statusBadge === 'new' ? (
              <span className="text-[10px] font-bold text-green-600">NEW</span>
            ) : statusBadge === 'deleted' ? (
              <span className="text-[10px] font-bold text-gray-400">삭제됨</span>
            ) : (
              <span className="text-gray-300">-</span>
            )}
          </td>
        )}
      </tr>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F5F5F7]">
      {/* ========== 헤더 ========== */}
      <header className="bg-white border-b border-gray-100 shadow-sm px-7 h-14 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="bg-[#A50034] rounded-lg px-2.5 py-1">
            <span className="font-black text-sm text-white" style={{ fontFamily: 'Georgia, serif' }}>LG</span>
          </div>
          <h1 className="text-lg font-extrabold text-gray-900 tracking-tight" style={{ fontFamily: "'Inter', sans-serif" }}>POP Maker</h1>
          <select
            value={channel.id}
            onChange={e => setChannel(CHANNELS.find(c => c.id === e.target.value) || CHANNELS[0])}
            className="text-xs text-[#A50034] font-bold border-[1.5px] border-[#A50034] px-2 py-0.5 rounded bg-transparent outline-none cursor-pointer"
          >

            {CHANNELS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3">
          {latestDate && <span className="text-xs text-gray-400">최신: {formatDateStr(latestDate)}</span>}
          {latestDate && <span className="text-xs text-gray-400">📊 {formatDateStr(latestDate)}</span>}
          <span className="text-xs text-gray-400">모델 {totalModels}개 로드</span>
        </div>
      </header>

      {/* ========== 메인 ========== */}
      <div className="flex-1 overflow-auto p-4 pb-10">
        <div className="max-w-[1600px] mx-auto flex gap-4">

          {/* ========== 좌측: 설정 패널 ========== */}
          <div className="w-[300px] shrink-0 flex flex-col gap-3">
            <Panel title="템플릿 선택">
              <select value={template.id}
                onChange={e => setTemplate(templates.find(t => t.id === e.target.value) || templates[0])}
                className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm font-semibold bg-gray-50 outline-none cursor-pointer">
                {templates.filter(t => t.channel?.includes(channel.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Panel>

            <Panel title="미리보기">
              <div className="bg-gray-50 rounded-xl border border-gray-100 h-[200px] flex items-center justify-center overflow-hidden">
                {templateThumb ? (
                  <img src={templateThumb} alt={template.name} className="max-w-full max-h-full object-contain rounded" />
                ) : (
                  <span className="text-xs text-gray-300">템플릿을 선택하세요</span>
                )}
              </div>
                {template.file && (
                  <div className="mt-2 text-[10px] text-gray-500 space-y-0.5">
                    {templateBatchEnabled ? (
                      <>
                        <div className="flex justify-between">
                          <span className="text-gray-400">용지</span>
                          <span className="font-semibold">A4 {templateBatch?.paper_orientation || '가로'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-400">배치</span>
                          <span className="font-semibold">{templateBatch?.grid_cols || 2} × {templateBatch?.grid_rows || 2}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-400">개별 크기</span>
                          <span className="font-semibold">{templateBatch?.item_width_mm || 148}mm × {templateBatch?.item_height_mm || 105}mm</span>
                        </div>
                      </>
                        ) : (
                          <div className="flex justify-between">
                            <span className="text-gray-400">출력</span>
                            <span className="font-semibold">A4 {templateOrientation} · 1장</span>
                          </div>
                        )}
                  </div>
                )}
            </Panel>

            <Panel title="제휴카드">
              <select value={cardName} onChange={e => setCardName(e.target.value)}
                className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer">
                <option value="">카드 미선택 (기본 16,000원)</option>
                {uniqueCardNames.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
              {cardName && usageList.length > 0 && !isPrepayDetailTemplate && (
                <select value={monthUsage} onChange={e => setMonthUsage(e.target.value)}
                  className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer mt-2">
                  <option value="">월실적 선택...</option>
                  {usageList.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              )}
            </Panel>

            <Panel title="옵션">
              <div className="flex flex-col gap-2.5">
                  {!isPrepayTemplate && (
                    <>
                      <ToggleRow label="활성화 할인 적용" desc="OFF 시 K열 금액 가산" checked={activationOn} onChange={() => setActivationOn(!activationOn)} />
                      <div className="h-px bg-[#f0ece4]" />
                    </>
                  )}
                <ToggleRow label="모델명 서픽스 표시" desc="OFF 시 마침표(.) 뒤 제거" checked={showSuffix} onChange={() => setShowSuffix(!showSuffix)} />
                {isPrepayDetailTemplate && (
                  <>
                    <div className="h-px bg-[#f0ece4]" />
                    <div>
                      <div className="text-sm font-semibold text-gray-700 mb-1.5">선납 할인</div>
                      <select value={prepay} onChange={e => setPrepay(e.target.value)}
                        className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer">
                        {!isPrepayDetailTemplate && <option value="없음">미선택</option>}
                        <option value="30%">30% 선납</option>
                        <option value="50%">50% 선납</option>
                      </select>
                    </div>
                  </>
                )}
              </div>
            </Panel>

            <button
              onClick={() => setShowPrintDialog(true)}
              disabled={checkedModels.size === 0 || generating || !template.file}
              className="w-full py-3.5 rounded-xl border-none text-base font-bold transition-all"
              style={{
                background: (checkedModels.size > 0 && !generating && template.file) ? 'linear-gradient(135deg, #A50034, #D4004A)' : '#ddd',
                color: (checkedModels.size > 0 && !generating && template.file) ? '#fff' : '#999',
                cursor: (checkedModels.size > 0 && !generating && template.file) ? 'pointer' : 'not-allowed',
                boxShadow: (checkedModels.size > 0 && !generating) ? '0 4px 16px rgba(165,0,52,0.25)' : 'none',
              }}
            >
              {generating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  생성 중... ({genProgress.current}/{genProgress.total})
                </span>
              ) : !template.file ? (
                '⚠️ 템플릿 미등록'
              ) : (
                `🎨 가격표 생성 (${checkedModels.size}개)`
              )}
            </button>
          </div>

          {showPrintDialog && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
              onClick={() => setShowPrintDialog(false)}>
              <div className="bg-white rounded-2xl shadow-2xl p-6 w-[420px]"
                onClick={e => e.stopPropagation()}>
                <h3 className="text-base font-extrabold text-gray-800 mb-4">출력 설정</h3>

                <div className="flex gap-4">
                  {/* 좌: 출력 크기 선택 */}
                  <div className="flex-1">
                    <div className="text-xs font-bold text-gray-500 mb-2">출력 크기</div>
                    <div className="flex flex-col gap-2">
                      {(['기본', 'A4', 'A5', 'A6'] as const)
                        .filter(size => !(size === 'A4' && !templateBatchEnabled))
                        .map(size => {
                        const desc = size === '기본'
                          ? (templateBatchEnabled ? `${templateBatch?.grid_cols || 2}×${templateBatch?.grid_rows || 2}` : 'A4 1장')
                          : size === 'A4' ? '1개/장' : size === 'A5' ? '2개/장' : '4개/장';
                        return (
                          <button key={size} onClick={() => setPrintSize(size)}
                            className="py-2 px-3 rounded-xl text-sm font-bold border-2 transition-all cursor-pointer text-left"
                            style={{
                              background: printSize === size ? '#A50034' : '#fff',
                              color: printSize === size ? '#fff' : '#666',
                              borderColor: printSize === size ? '#A50034' : '#e5e5e5',
                            }}>
                            {size}
                            <span className="text-[10px] font-normal ml-2" style={{ color: printSize === size ? 'rgba(255,255,255,0.7)' : '#aaa' }}>
                              {desc}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 우: 배치 미리보기 */}
                  <div className="w-[160px] flex flex-col items-center">
                    <div className="text-xs font-bold text-gray-500 mb-2">배치 미리보기</div>
                    {(() => {
                      const isLandscapeTmpl = templateOrientation === '가로';

                      let cols: number, rows: number, orient: string;
                      if (printSize === '기본') {
                        if (templateBatchEnabled) {
                          cols = templateBatch?.grid_cols || 2;
                          rows = templateBatch?.grid_rows || 2;
                          orient = templateBatch?.paper_orientation || '가로';
                        } else {
                          cols = 1; rows = 1;
                          orient = isLandscapeTmpl ? '가로' : '세로';
                        }
                      } else if (printSize === 'A4') {
                        cols = 1; rows = 1;
                        orient = isLandscapeTmpl ? '가로' : '세로';

                      } else if (printSize === 'A5') {
                        cols = isLandscapeTmpl ? 1 : 2;
                        rows = isLandscapeTmpl ? 2 : 1;
                        orient = isLandscapeTmpl ? '세로' : '가로';
                      } else {
                        cols = 2; rows = 2;
                        orient = isLandscapeTmpl ? '가로' : '세로';
                      }

                      const perPage = cols * rows;
                      const totalPages = Math.ceil(checkedModels.size / perPage);
                      const paperW = orient === '가로' ? 140 : 100;
                      const paperH = orient === '가로' ? 100 : 140;

                      return (
                        <div className="flex flex-col items-center gap-2">
                          {/* A4 용지 시뮬레이션 */}
                          <div className="border-2 border-gray-300 rounded bg-white relative"
                            style={{ width: paperW, height: paperH }}>
                            <div className="absolute inset-1 grid gap-px"
                              style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
                              {Array.from({ length: Math.min(perPage, checkedModels.size || perPage) }).map((_, i) => (
                                <div key={i} className="bg-[#A50034]/15 rounded-sm border border-[#A50034]/30 flex items-center justify-center">
                                  <span className="text-[8px] font-bold text-[#A50034]/50">{i + 1}</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* 정보 */}
                          <div className="text-center space-y-1 mt-1">
                            <div className="text-[11px] font-bold text-gray-700">A4 {orient} · {perPage}개/장</div>
                            <div className="text-[11px] text-gray-500">{checkedModels.size}개 제품 선택</div>
                            {checkedModels.size > 0 && (
                              <div className="text-[12px] font-bold text-[#A50034]">📄 {totalPages}장 출력</div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* 버튼 */}
                <div className="flex gap-2 mt-5">
                  <button onClick={() => setShowPrintDialog(false)}
                    className="flex-1 py-2.5 rounded-xl text-sm font-semibold border border-gray-200 text-gray-500 cursor-pointer hover:bg-gray-50">
                    취소
                  </button>
                  <button onClick={() => { setShowPrintDialog(false); handleGenerate(); }}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white cursor-pointer"
                    style={{ background: 'linear-gradient(135deg, #A50034, #C4003D)' }}>
                    🎨 생성하기
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ========== 미리보기 모달 ========== */}
          {showPreview && generatedImages.length > 0 && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              onClick={() => setShowPreview(false)}>
              <div className="bg-white rounded-2xl shadow-2xl max-w-[90vw] max-h-[90vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()} style={{ width: 960 }}>
                <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-[#FAF8F5]">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-extrabold text-gray-800">가격표 미리보기</h3>
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                      {previewIndex + 1} / {generatedImages.length}
                      {generatedNames[previewIndex] && ` · ${generatedNames[previewIndex]}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => downloadImage(generatedImages[previewIndex], `${generatedNames[previewIndex] || 'price'}_${previewIndex + 1}.png`)}
                      className="text-xs px-3 py-1.5 bg-blue-500 text-white rounded-lg font-semibold hover:bg-blue-600 transition-colors cursor-pointer">
                      📥 이 이미지 저장
                    </button>
                    {generatedImages.length > 1 && (
                      <button onClick={() => downloadAllImages(generatedImages, template.name)}
                        className="text-xs px-3 py-1.5 bg-[#A50034] text-white rounded-lg font-semibold hover:bg-[#8a002c] transition-colors cursor-pointer">
                        📦 전체 저장 ({generatedImages.length}개)
                      </button>
                    )}
                    <button
                        onClick={() => {
                        const iframe = document.createElement('iframe');
                        iframe.style.display = 'none';
                        document.body.appendChild(iframe);
                        const doc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (doc) {
                          // 첫 번째 이미지로 방향 판단
                          const img = new Image();
                          img.src = generatedImages[0];
                          img.onload = () => {
                            const orient = img.width > img.height ? 'landscape' : 'portrait';
                            doc.open();
                            doc.write(`<html><head><title>가격표</title><style>@page{size:A4 ${orient};margin:0;}body{margin:0;}img{width:100%;height:100vh;object-fit:contain;display:block;page-break-after:always;}img:last-child{page-break-after:auto;}</style></head><body>`);
                            generatedImages.forEach(src => {
                              doc.write(`<img src="${src}" />`);
                            });
                            doc.write('</body></html>');
                            doc.close();
                            setTimeout(() => {
                              iframe.contentWindow?.print();
                              setTimeout(() => document.body.removeChild(iframe), 1000);
                            }, 500);
                          };
                        }
                      }}
                      className="text-xs px-3 py-1.5 bg-gray-600 text-white rounded-lg font-semibold hover:bg-gray-700 transition-colors cursor-pointer">
                      🖨️ 인쇄 / PDF
                    </button>

                    <button onClick={() => setShowPreview(false)}
                      className="w-7 h-7 rounded-full bg-gray-100 text-gray-400 text-sm flex items-center justify-center hover:bg-gray-200 transition-colors cursor-pointer">
                      ✕
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-gray-50" style={{ minHeight: 400 }}>
                  <img src={generatedImages[previewIndex]} alt={`가격표 ${previewIndex + 1}`}
                    className="max-w-full max-h-[70vh] object-contain rounded-lg shadow-md" />
                </div>
                {generatedImages.length > 1 && (
                  <div className="flex items-center justify-center gap-3 px-5 py-3 border-t border-gray-100 bg-[#FAF8F5]">
                    <button onClick={() => setPreviewIndex(Math.max(0, previewIndex - 1))} disabled={previewIndex === 0}
                      className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-600 disabled:opacity-30 cursor-pointer">
                      ◀ 이전
                    </button>
                    <div className="flex gap-1.5 overflow-x-auto max-w-[600px] py-1">
                      {generatedImages.map((img, i) => (
                        <button key={i} onClick={() => setPreviewIndex(i)}
                          className="shrink-0 rounded-md overflow-hidden border-2 transition-all cursor-pointer"
                          style={{ borderColor: i === previewIndex ? '#A50034' : 'transparent', opacity: i === previewIndex ? 1 : 0.5 }}>
                          <img src={img} alt="" className="w-12 h-8 object-cover" />
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setPreviewIndex(Math.min(generatedImages.length - 1, previewIndex + 1))}
                      disabled={previewIndex === generatedImages.length - 1}
                      className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-600 disabled:opacity-30 cursor-pointer">
                      다음 ▶
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ========== 우측: 제품 테이블 ========== */}
          <div className="flex-1 flex flex-col min-w-0">

            {/* 카테고리 필터 + 통계 */}
            <div className="bg-white rounded-t-xl p-4 pb-3 shadow-sm">
              <div className="flex gap-1.5 flex-wrap mb-3">
                <CatButton label="전체" active={activeCategory === '전체'} onClick={() => setActiveCategory('전체')} />
                <CatButton label="활성화 제품" count={activationCount} active={activeCategory === '활성화 제품'} color="#E67E22" bgTint="#FFF8F0" onClick={() => setActiveCategory('활성화 제품')} />
                <CatButton label="변동 제품" count={changeCount} active={activeCategory === '변동 제품'} color="#8E24AA" bgTint="#F9F0FF" onClick={() => setActiveCategory('변동 제품')} />
                <CatButton label="30%선납" count={prepay30Count} active={activeCategory === '30%선납'} color="#0D9488" bgTint="#F0FDFA" onClick={() => setActiveCategory('30%선납')} />
                <CatButton label="50%선납" count={prepay50Count} active={activeCategory === '50%선납'} color="#7C3AED" bgTint="#F5F3FF" onClick={() => setActiveCategory('50%선납')} />           
                <div className="w-px h-6 bg-gray-200 self-center mx-1" />
                {categories.map(cat => (
                  <CatButton key={cat} label={cat} active={activeCategory === cat} onClick={() => setActiveCategory(cat)} />
                ))}
              </div>

            {/* 검색창 */}
              <div className="mt-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="모델명 검색..."
                  className="w-48 px-3 py-1.5 text-xs rounded-lg border border-[#e0dcd4] bg-[#FAFAF8] outline-none focus:border-[#A50034] transition-colors"
                />
              </div>

              <div className="flex justify-between items-center pt-2.5 border-t border-gray-100">
                <div className="flex gap-4 items-center">
                  {activeCategory !== '변동 제품' && (
                    <>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox"
                          checked={Object.values(filteredData).flat().every(g => checkedModels.has(g.model)) && filteredCount > 0}
                          onChange={toggleAll} className="w-4 h-4 accent-[#A50034]" />
                        <span className="text-xs text-gray-400">전체</span>
                        <span className="text-base font-extrabold text-gray-700">{totalModels}</span>
                      </label>
                      {activeCategory !== '전체' && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-400">필터</span>
                          <span className="text-base font-extrabold text-[#E67E22]">{filteredCount}</span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">선택</span>
                    <span className="text-base font-extrabold text-[#A50034]">{checkedModels.size}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 컨텐츠 영역 */}
            <div className="bg-white rounded-b-xl px-5 pb-5 flex-1 shadow-sm overflow-x-auto">

              {/* ===== 변동 제품 탭 ===== */}
              {activeCategory === '변동 제품' ? (
                <div className="py-4">
                  {/* 날짜 선택 - 캘린더 */}
                  <div className="bg-[#F9F7FF] rounded-xl p-4 mb-4 border border-[#E8E0F0]">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-sm font-bold text-[#8E24AA]">📅 비교 기준 날짜</span>
                      {latestDate && <span className="text-xs text-gray-400">현재: {formatDateStr(latestDate)}</span>}
                    </div>
                    {comparableDates.length === 0 ? (
                      <div className="text-sm text-gray-400 py-2">
                        비교할 과거 가격표가 없습니다.
                      </div>
                    ) : (
                      <>


                        {/* 미니 캘린더 */}
                        <MiniCalendar
                            availableDates={comparableDates}
                            selectedDate={selectedCompareDate}
                            latestDate={latestDate}
                            month={calendarMonth}
                            onMonthChange={setCalendarMonth}
                            onSelect={(d) => { runCompare(d); }}
                          />
              
                      </>
                    )}
                    {selectedCompareDate && latestDate && (
                      <div className="mt-3 text-xs text-gray-500">
                        {formatDateStr(selectedCompareDate)} → {formatDateStr(latestDate)} 변동 비교
                      </div>
                    )}
                  </div>

                  {/* 로딩 */}
                  {compareLoading && (
                    <div className="py-10 text-center">
                      <div className="w-8 h-8 border-[3px] border-[#8E24AA] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                      <p className="text-sm text-gray-400">비교 중...</p>
                    </div>
                  )}

                  {/* 비교 결과 */}
                  {!compareLoading && compareResult && (
                    <>
                      {/* 요약 필터 카드: 전체 → 신규 → 인하 → 인상 → 삭제 */}
                      <div className="flex gap-3 mb-4">
                        {[
                          { key: 'all' as const, label: '전체', count: compareResult.summary.totalChanges, color: '#6B7280', bg: '#F3F4F6' },
                          { key: 'new' as const, label: '신규', count: compareResult.summary.newCount, color: '#16A34A', bg: '#F0FDF4' },
                          { key: 'down' as const, label: '인하', count: compareResult.summary.downCount, color: '#2563EB', bg: '#EFF6FF' },
                          { key: 'up' as const, label: '인상', count: compareResult.summary.upCount, color: '#EA580C', bg: '#FFF7ED' },
                          { key: 'deleted' as const, label: '삭제', count: compareResult.summary.deletedCount, color: '#9CA3AF', bg: '#F9FAFB' },
                        ].map(s => (
                          <button key={s.key} onClick={() => setChangeFilter(s.key)}
                            className="flex-1 rounded-xl p-3 text-center transition-all border-2 cursor-pointer"
                            style={{
                              background: s.bg,
                              borderColor: changeFilter === s.key ? s.color : 'transparent',
                              opacity: s.count === 0 && s.key !== 'all' ? 0.4 : 1,
                            }}>
                            <div className="text-2xl font-extrabold" style={{ color: s.color }}>{s.count}</div>
                            <div className="text-xs font-semibold mt-0.5" style={{ color: s.color }}>{s.label}</div>
                          </button>
                        ))}
                      </div>

                      {/* 전체 선택 (삭제 제외) */}
                      <div className="flex items-center mb-3">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox"
                            checked={
                              filteredChangeTableData.filter(s => !s.isDeleted).flatMap(s => s.groups).length > 0 &&
                              filteredChangeTableData.filter(s => !s.isDeleted).flatMap(s => s.groups).every(g => checkedModels.has(g.model))
                            }
                            onChange={toggleAllChanges}
                            className="w-4 h-4 accent-[#8E24AA]" />
                          <span className="text-xs text-gray-500">변동 모델 전체 선택 (삭제 제외)</span>
                        </label>
                      </div>

                      {/* 상태별 테이블: 신규 → 인하 → 인상 → 삭제 */}
                      {filteredChangeTableData.length === 0 ? (
                        <div className="py-8 text-center text-gray-300 text-sm">해당 유형의 변동이 없습니다.</div>
                      ) : (
                        filteredChangeTableData.map(section => {
                          const sc = STATUS_CONFIG[section.status];
                          return (
                            <div key={section.status} className="mt-4">
                              {/* 섹션 헤더 */}
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-1 h-5 rounded-full" style={{ background: sc.color }} />
                                <span className="text-base font-extrabold" style={{ color: sc.color }}>{sc.label}</span>
                                <span className="text-xs text-gray-500 font-semibold">({section.groups.length}개 모델)</span>
                                <div className="flex-1" />
                              </div>

                              <div className="rounded-2xl overflow-hidden border border-gray-100 shadow-sm">
                                <table className="w-full border-collapse text-xs" style={{ minWidth: 1000 }}>
                                  <thead>
                                    <tr className="bg-gray-50/80">
                                      <th className="w-9 p-2 border-b-2" style={{ borderColor: sc.color }}>
                                        {!section.isDeleted && (
                                          <input type="checkbox"
                                            checked={section.groups.every(g => checkedModels.has(g.model))}
                                            onChange={() => toggleStatusAll(section.status)}
                                            className="w-4 h-4 cursor-pointer" style={{ accentColor: sc.color }} />
                                        )}
                                      </th>
                                      <th className="w-[160px] p-2 text-left text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>모델명</th>
                                      <th className="w-[68px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>계약기간</th>
                                      <th className="w-[90px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>케어십형태</th>
                                      <th className="w-[110px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>케어십구분</th>
                                      <th className="w-[76px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>방문주기</th>
                                      <th className="w-[76px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>정상구독료</th>
                                      <th className="w-[56px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>활성화</th>
                                      <th className="w-[60px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>카드혜택</th>
                                      <th className="w-[80px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>월구독료</th>
                                      <th className="w-[70px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>30%선납</th>
                                      <th className="w-[70px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>50%선납</th>
                                      <th className="w-[90px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2" style={{ borderColor: sc.color }}>변동</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {section.groups.map(group =>
                                      renderModelRow(group, {
                                        disabled: section.isDeleted,
                                        statusBadge: section.status,
                                        showChange: true,
                                      })
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </>
                  )}

                  {/* 비교 전 안내 */}
                  {!compareLoading && !compareResult && comparableDates.length > 0 && (
                    <div className="py-10 text-center text-gray-300 text-sm">
                      위에서 비교할 날짜를 선택하세요.
                    </div>
                  )}
                </div>
              ) : (
                /* ===== 기존 가격 테이블 ===== */
                visibleCategories.length === 0 ? (
                  <div className="py-10 text-center text-gray-300 text-sm">해당 카테고리에 모델이 없습니다</div>
                ) : (
                  visibleCategories.map(cat => {
                    const catGroups = filteredData[cat];
                    return (
                      <div key={cat} className="mt-4">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-1 h-5 bg-[#A50034] rounded-full" />
                          <span className="text-base font-extrabold text-gray-900">{cat}</span>
                          <span className="text-xs text-gray-500 font-semibold">({catGroups.length}개 모델)</span>
                          <div className="flex-1" />
                        </div>

                        <div className="rounded-2xl overflow-hidden border border-gray-100 shadow-sm">
                          <table className="w-full border-collapse text-xs" style={{ minWidth: 900 }}>
                            <thead>
                              <tr className="bg-[#FAF8F5]">
                                <th className="w-9 p-2 border-b-2 border-[#A50034]">
                                  <input type="checkbox"
                                    checked={catGroups.every(g => checkedModels.has(g.model))}
                                    onChange={() => toggleCatAll(cat)}
                                    className="w-4 h-4 accent-[#A50034] cursor-pointer" />
                                </th>
                                <th className="w-[160px] p-2 text-left text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">모델명</th>
                                <th className="w-[68px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">계약기간</th>
                                <th className="w-[90px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">케어십형태</th>
                                <th className="w-[110px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">케어십구분</th>
                                <th className="w-[76px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">방문주기</th>
                                <th className="w-[76px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">정상구독료</th>
                                <th className="w-[56px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">활성화</th>
                                <th className="w-[60px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">카드혜택</th>
                                <th className="w-[80px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">월구독료</th>
                                <th className="w-[70px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">30%선납</th>
                                <th className="w-[70px] p-2 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">50%선납</th>
                              </tr>
                            </thead>
                            <tbody>
                              {catGroups.map(group => renderModelRow(group))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 하위 컴포넌트
// ==========================================
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-md border border-gray-50">
      <div className="text-xs font-bold text-[#A50034] tracking-wide mb-3">{title}</div>
      {children}
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc?: string; checked: boolean; onChange: () => void;
}) {
  return (
    <div className="flex justify-between items-center">
      <div>
        <div className="text-sm font-semibold text-gray-700">{label}</div>
        {desc && <div className="text-[10px] text-gray-400 mt-0.5">{desc}</div>}
      </div>
      <div onClick={onChange} className="w-10 h-[22px] rounded-full relative cursor-pointer transition-colors shrink-0"
        style={{ background: checked ? '#A50034' : '#ddd' }}>
        <div className="w-[18px] h-[18px] rounded-full bg-white absolute top-[2px] transition-transform"
          style={{ transform: checked ? 'translateX(20px)' : 'translateX(2px)', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }} />
      </div>
    </div>
  );
}

function CatButton({ label, count, active, color, bgTint, onClick }: {
  label: string; count?: number; active: boolean; color?: string; bgTint?: string; onClick: () => void;
}) {
  const isSpecial = !!color;
  const activeColor = color || '#A50034';
  return (
    <button onClick={onClick}
      className="flex items-center gap-1 text-xs rounded-full border transition-all cursor-pointer"
      style={{
        padding: '6px 16px',
        background: active ? activeColor : (isSpecial ? bgTint : '#fff'),
        color: active ? '#fff' : (isSpecial ? activeColor : '#777'),
        borderColor: active ? activeColor : (isSpecial ? activeColor + '44' : '#e5e5e5'),
        fontWeight: active ? 700 : 500,
      }}>
      {label}
      {count !== undefined && count > 0 && (
        <span className="text-[10px] font-bold min-w-[18px] h-[18px] rounded-full inline-flex items-center justify-center"
          style={{ background: active ? 'rgba(255,255,255,0.3)' : activeColor + '22', color: active ? '#fff' : activeColor }}>
          {count}
        </span>
      )}
    </button>
  );
}

// ==========================================
// 미니 캘린더 컴포넌트
// ==========================================
function MiniCalendar({ availableDates, selectedDate, latestDate, month, onMonthChange, onSelect }: {
  availableDates: string[];
  selectedDate: string;
  latestDate: string;
  month: Date;
  onMonthChange: (d: Date) => void;
  onSelect: (d: string) => void;
}) {
  // YYMMDD → Date
  const parseDateStr = (d: string) => new Date(2000 + parseInt(d.slice(0,2)), parseInt(d.slice(2,4)) - 1, parseInt(d.slice(4,6)));
  const dateSet = new Set(availableDates);
  const latestSet = new Set([latestDate]);

  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstDay = new Date(year, mon, 1).getDay();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();

  const prevMonth = () => onMonthChange(new Date(year, mon - 1, 1));
  const nextMonth = () => onMonthChange(new Date(year, mon + 1, 1));

  // 날짜를 YYMMDD로 변환
  const toDateStr = (day: number) => {
    const y = String(year).slice(2);
    const m = String(mon + 1).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${y}${m}${d}`;
  };

  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  return (
    <div className="bg-white rounded-xl border border-[#E8E0F0] p-3 mt-2" style={{ maxWidth: 320 }}>
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-2">
        <button onClick={prevMonth} className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center cursor-pointer text-gray-500 text-sm">◀</button>
        <span className="text-sm font-bold text-gray-700">{year}년 {mon + 1}월</span>
        <button onClick={nextMonth} className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center cursor-pointer text-gray-500 text-sm">▶</button>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {dayNames.map(d => (
          <div key={d} className="text-center text-[10px] font-bold text-gray-400 py-1">{d}</div>
        ))}
      </div>

      {/* 날짜 그리드 */}
      <div className="grid grid-cols-7 gap-0.5">
        {/* 빈 칸 */}
        {Array.from({ length: firstDay }).map((_, i) => (
          <div key={`empty-${i}`} className="h-8" />
        ))}
        {/* 날짜 */}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const ds = toDateStr(day);
          const isAvailable = dateSet.has(ds);
          const isLatest = latestSet.has(ds);
          const isSelected = selectedDate === ds;

          return (
            <button
              key={day}
              onClick={() => isAvailable && onSelect(ds)}
              disabled={!isAvailable && !isLatest}
              className="h-8 rounded-lg text-xs font-semibold flex items-center justify-center relative transition-all"
              style={{
                background: isSelected ? '#8E24AA' : isLatest ? '#F0FDF4' : isAvailable ? '#F3E8FF' : 'transparent',
                color: isSelected ? '#fff' : isLatest ? '#16A34A' : isAvailable ? '#8E24AA' : '#D1D5DB',
                cursor: isAvailable ? 'pointer' : 'default',
                border: isLatest ? '1.5px solid #86EFAC' : isAvailable ? '1.5px solid #D8B4FE' : '1px solid transparent',
                fontWeight: isAvailable || isLatest ? 700 : 400,
              }}
            >
              {day}
              {isLatest && <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-400 rounded-full" />}
            </button>
          );
        })}
      </div>

      {/* 범례 */}
      <div className="flex gap-4 mt-2 pt-2 border-t border-gray-100">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-[#F3E8FF] border border-[#D8B4FE]" />
          <span className="text-[10px] text-gray-500">과거 가격표</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-[#F0FDF4] border border-[#86EFAC]" />
          <span className="text-[10px] text-gray-500">최신 (현재)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-[#8E24AA]" />
          <span className="text-[10px] text-gray-500">선택됨</span>
        </div>
      </div>
    </div>
  );
}
