'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { loadCards, loadQRMapping, loadCareBenefits } from '@/lib/data-loader';
import {
  getCardDiscount, getUniqueCardNames, getUsagesByCard, formatNumber
} from '@/lib/price-engine';
import {
  parseExcelForCompare, parseNewExcelForCompare, comparePriceData,
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
  { id: 'emart', name: '이마트', sheet: '이마트-업데이트', sheetNew: '이마트' },
  { id: 'homeplus', name: '홈플러스', sheet: '홈플러스-업데이트', sheetNew: '홈플러스' },
  { id: 'traders', name: '트레이더스', sheet: '이마트-업데이트', sheetNew: '이마트' },
  { id: 'electromart', name: '일렉트로마트', sheet: '이마트-업데이트', sheetNew: '이마트' },
  { id: 'electroland', name: '전자랜드', sheet: '이마트-업데이트', sheetNew: '전자랜드' },
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
// 신규 양식 엑셀 파서 (Master_*.xlsx)
// ==========================================
async function parseNewExcel(url: string, sheetName: string): Promise<PriceRow[]> {
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

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const cell = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })]?.v;
  const num = (r: number, c: number) => { const v = cell(r, c); return typeof v === 'number' ? v : (parseInt(String(v)) || 0); };
  const str = (r: number, c: number) => { const v = cell(r, c); return v != null ? String(v).trim() : ''; };

  // 1행부터 데이터 (0행은 헤더)
  interface RawEntry {
    row: number;
    category: string; model: string; careType: string; careGrade: string; visitCycle: string;
    period: number; comboType: string;
    listPrice: number; finalPrice: number; activation: number;
    prepay30amount: number; prepay30final: number;
    prepay50amount: number; prepay50final: number;
  }

  const entries: RawEntry[] = [];
  for (let r = 1; r <= range.e.r; r++) {
    const model = str(r, 1); // B열 = 모델명
    if (!model) continue;
    entries.push({
      row: r,
      category: str(r, 0),    // A열
      model,
      careType: str(r, 2),    // C열
      careGrade: str(r, 3),   // D열
      visitCycle: str(r, 4),  // E열
      period: num(r, 5),      // F열 (36/48/60/72)
      comboType: str(r, 6),   // G열 (결합없음/신규결합/기존결합)
      listPrice: num(r, 7),   // H열
      finalPrice: num(r, 11), // L열 (최종요금)
      activation: num(r, 10), // K열
      prepay30amount: num(r, 12), // M열
      prepay30final: num(r, 13),  // N열
      prepay50amount: num(r, 14), // O열
      prepay50final: num(r, 15),  // P열
    });
  }

  // 같은 (모델명+케어십형태+케어십구분+방문주기)로 그룹핑
  const groups = new Map<string, RawEntry[]>();
  for (const e of entries) {
    const key = `${e.model}|${e.careType}|${e.careGrade}|${e.visitCycle}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const rows: PriceRow[] = [];
  groups.forEach((group) => {
    const first = group[0];
    const find = (period: number, combo: string) =>
      group.find((e: RawEntry) => e.period === period && e.comboType === combo);

    const y3none = find(36, '결합없음');
    const y4none = find(48, '결합없음');
    const y4new  = find(48, '신규결합');
    const y4ext  = find(48, '기존결합');
    const y5none = find(60, '결합없음');
    const y5new  = find(60, '신규결합');
    const y5ext  = find(60, '기존결합');
    const y6none = find(72, '결합없음');
    const y6new  = find(72, '신규결합');
    const y6ext  = find(72, '기존결합');

    rows.push({
      channel: '',
      category: first.category,
      model: first.model,
      listPrice: first.listPrice,
      careType: first.careType,
      careGrade: first.careGrade,
      visitCycle: first.visitCycle,
      careKey: (!first.careType || first.careType === '무관리') ? '무관리' : `${first.careType}/${first.visitCycle}/${first.careGrade}`,
      activation: y6none?.activation || y5none?.activation || y4none?.activation || y3none?.activation || 0,
      y3base: y3none?.finalPrice || 0,
      y4base: y4none?.finalPrice || 0,
      y4new:  y4new?.finalPrice || 0,
      y4exist: y4ext?.finalPrice || 0,
      y5base: y5none?.finalPrice || 0,
      y5new:  y5new?.finalPrice || 0,
      y5exist: y5ext?.finalPrice || 0,
      y6base: y6none?.finalPrice || 0,
      y6new:  y6new?.finalPrice || 0,
      y6exist: y6ext?.finalPrice || 0,
      prepay30amount: y6none?.prepay30amount || 0,
      prepay30base:   y6none?.prepay30final || 0,
      prepay30new:    y6new?.prepay30final || 0,
      prepay30exist:  y6ext?.prepay30final || 0,
      prepay50amount: y6none?.prepay50amount || 0,
      prepay50base:   y6none?.prepay50final || 0,
      prepay50new:    y6new?.prepay50final || 0,
      prepay50exist:  y6ext?.prepay50final || 0,
    });
  });
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
  const [priceFiles, setPriceFiles] = useState<string[]>([]);
  const [latestDate, setLatestDate] = useState('');
  const [cardName, setCardName] = useState('[신한]더구독케어');
  const [monthUsage, setMonthUsage] = useState('30만');
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
  const [printSize, setPrintSize] = useState<'기본' | 'A4' | 'A5' | 'A6' | '90x55'>('기본');

  // ----- 데이터 로딩 -----
  useEffect(() => {
    async function loadAll() {
      try {
        setLoading(true);
        setError(null);

        // price-index.json에서 파일 목록 로드
        let files: string[] = [];
        try {
          const indexRes = await fetch('/data/price-index.json');
          files = await indexRes.json();
        } catch {
          console.warn('price-index.json 로드 실패');
        }

        // 파일명에서 날짜(6자리) 추출
        const extractDate = (f: string): string => {
          if (f.startsWith('Master_')) {
            // Master_20260411.xlsx → 260411 (앞 "20" 제거)
            return f.replace('Master_', '').replace('.xlsx', '').slice(2);
          }
          // price_260303.xlsx → 260303
          return f.replace('price_', '').replace('.xlsx', '');
        };
        const dates = files.map(extractDate).sort();
        setPriceDates(dates);
        setPriceFiles(files);

        const latestFile = files[files.length - 1] || '';
        const latest = dates[dates.length - 1] || '';
        setLatestDate(latest);
        if (!latest) throw new Error('가격표 파일이 없습니다.');

        const parsePrice = latestFile.startsWith('Master_')
          ? parseNewExcel(`/data/${latestFile}`, channel.sheetNew || channel.sheet)
          : parseExcelFromURL(`/data/${latestFile}`, channel.sheet);

        const [price, cardData, qr, care] = await Promise.all([
          parsePrice,
          loadCards(),
          loadQRMapping(),
          loadCareBenefits(),
        ]);
        setPriceData(price);
        console.log(`[POP] ${latestFile} → ${price.length}행 로드, activation>0: ${price.filter(r => (r.activation||0) > 0).length}개`);
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

      // 날짜 → 파일명 찾기
      const findFile = (date: string) => {
        const found = priceFiles.find(f => {
          if (f.startsWith('Master_')) return f.replace('Master_', '').replace('.xlsx', '').slice(2) === date;
          return f.replace('price_', '').replace('.xlsx', '') === date;
        });
        return found || `price_${date}.xlsx`;
      };
      const oldFile = findFile(oldDate);
      const currFile = findFile(latestDate);

      // 파일 형식에 따라 파서 선택
      const parseCompare = (file: string) =>
        file.startsWith('Master_')
          ? parseNewExcelForCompare(`/data/${file}`, channel.sheetNew || channel.sheet)
          : parseExcelForCompare(`/data/${file}`, channel.sheet);
      const parseFull = (file: string) =>
        file.startsWith('Master_')
          ? parseNewExcel(`/data/${file}`, channel.sheetNew || channel.sheet)
          : parseExcelFromURL(`/data/${file}`, channel.sheet);

      const [prevRowsCompare, currRowsCompare, prevFull] = await Promise.all([
        parseCompare(oldFile),
        parseCompare(currFile),
        parseFull(oldFile),
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
  }, [latestDate, channel.sheet, channel.sheetNew, priceFiles]);

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

  // ----- 모델의 현재 선택에 해당하는 최적의 행 찾기 (6년->5년->4년->3년 우선순위) -----
    const getSelectedRow = useCallback((group: any) => {
      const sel = modelSelections[group.model] || {};
      let candidates = group.rows;

      // 1. 사용자가 선택한 케어십/방문주기가 있다면 먼저 필터링
      if (sel.careType) {
        const filtered = candidates.filter((r: any) => r.careType === sel.careType);
        if (filtered.length > 0) candidates = filtered;
      }
      if (sel.careGrade) {
        const filtered = candidates.filter((r: any) => r.careGrade === sel.careGrade);
        if (filtered.length > 0) candidates = filtered;
      }
      if (sel.visitCycle) {
        const filtered = candidates.filter((r: any) => r.visitCycle === sel.visitCycle);
        if (filtered.length > 0) candidates = filtered;
      }

      // 2. 남은 후보들 중에서 [6년 -> 5년 -> 4년 -> 3년] 순서로 가장 저렴한 행 찾기
      const periodKeys = ["y6base", "y5base", "y4base", "y3base"];
      
      for (const key of periodKeys) {
        let minPrice = Infinity;
        let bestRow = null;
        
        for (const row of candidates) {
          const price = row[key] || 0;
          if (price > 0 && price < minPrice) {
            minPrice = price;
            bestRow = row;
          }
        }
        
        // 해당 기간(예: 6년)에 유효한 가격이 하나라도 있으면 바로 그 행을 반환 (동점일 경우 먼저 검색된 것 반환)
        if (bestRow) return bestRow; 
      }

      // 조건에 맞는게 없으면 기본 첫 번째 행 반환
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
  // 👇 1. 숫자도 받을 수 있게 value: string 을 value: any 로 변경!
  const updateSelection = useCallback((model: string, field: string, value: any) => {
    // 👇 2. prev 에러 방지를 위해 명시적으로 prev: any 추가
    setModelSelections((prev: any) => {
      // 👇 3. 기본값 객체에 quantity: 1 추가!
      const current = prev[model] || { period: '', careType: '', careGrade: '', visitCycle: '', quantity: 1 };
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

  // ----- 카드 변경 시 해당 카드 첫 번째 월실적으로 자동 설정 -----
  useEffect(() => {
    if (cardName) {
      const usages = getUsagesByCard(cards, cardName);
      setMonthUsage(usages.length > 0 ? usages[0] : '');
    } else {
      setMonthUsage('');
    }
  }, [cardName, cards]);

  // ----- 활성화 탭에서 빠져나가면 드롭다운 초기화 -----
  const prevCategory = useRef(activeCategory);
  useEffect(() => {
    if (prevCategory.current === '활성화 제품' && activeCategory !== '활성화 제품') {
      setModelSelections({});
    }
    prevCategory.current = activeCategory;
  }, [activeCategory]);

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
        
        // 👇 sel을 (sel as any)로 감싸서 타입스크립트 검사를 강제 패스합니다!
        const quantity = (sel as any)?.quantity || 1; 
        
        for (let q = 0; q < quantity; q++) {
          allValues.push(values);
          allNames.push(modelName);
        }
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
            if (printSize === '90x55') return '세로';
            return '가로';
          })();
          const sizeConfig = {
            'A4': { cols: 1, rows: 1, w_mm: autoOrientation === '가로' ? 297 : 210, h_mm: autoOrientation === '가로' ? 210 : 297 },
            'A5': { cols: 1, rows: 2, w_mm: autoOrientation === '세로' ? 210 : 297, h_mm: autoOrientation === '세로' ? 148 : 105 },
            'A6': { cols: 2, rows: 2, w_mm: isLandscape ? 148 : 105, h_mm: isLandscape ? 105 : 148 },
            '90x55': { cols: 2, rows: 5, w_mm: 90, h_mm: 55 },
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

/// ==========================================
  // 테이블 행 렌더링 함수 (공통)
  // ==========================================
  function renderModelRow(group: any, options: any = {}) {
    const { disabled = false, statusBadge, showChange = false } = options;
    const checked = checkedModels.has(group.model);
    const calc = getCalculatedPrice(group);
    // 👇 sel 객체에 quantity 기본값(1) 추가
    const sel: any = modelSelections[group.model] || { period: "", careType: "", careGrade: "", visitCycle: "", quantity: 1 };
    const opts = getDropdownOptions(group);
    const selectedRow = getSelectedRow(group);
    const prepay30 = selectedRow.prepay30base || 0;
    const prepay50 = selectedRow.prepay50base || 0;
    const availPeriods = getAvailablePeriods(selectedRow);

    const changeInfo = compareResult?.modelChanges.get(group.model);

    return (
      <tr
        key={group.model}
        // 👇 checked ? 'bg-white' 부분을 'bg-rose-50/60' 으로 변경했습니다!
        className={`border-b border-gray-100 transition-colors group ${disabled ? 'opacity-50 bg-slate-50' : checked ? 'bg-rose-50/60' : 'hover:bg-slate-50'}`}
      >
        <td className="p-3 text-center">
          {disabled ? (
            <span className="text-slate-300 text-xs">—</span>
          ) : (
            <div className="cursor-pointer" onClick={() => toggleModel(group.model)}>
              <input type="checkbox" checked={checked} onChange={() => {}} className="w-4 h-4 accent-blue-600 cursor-pointer" />
            </div>
          )}
        </td>
        <td
          className={`p-3 font-bold text-[13px] tracking-tight ${disabled ? "" : "cursor-pointer"} text-slate-800`}
          onClick={() => !disabled && toggleModel(group.model)}
        >
          <div className="flex items-center gap-1.5">
            {group.model}
            {statusBadge && (
              <span
                className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                style={{
                  background: STATUS_CONFIG[statusBadge as keyof typeof STATUS_CONFIG].bg,
                  color: STATUS_CONFIG[statusBadge as keyof typeof STATUS_CONFIG].color,
                  border: `1px solid ${STATUS_CONFIG[statusBadge as keyof typeof STATUS_CONFIG].border}`
                }}
              >
                {STATUS_CONFIG[statusBadge as keyof typeof STATUS_CONFIG].label}
              </span>
            )}
          </div>
        </td>

        {/* 👇 [추가됨] 출력수량 조절기 (- 1 +) */}
        <td className="p-3 text-center">
          {disabled ? (
            <span className="text-slate-300 text-xs">-</span>
          ) : (
            <div className="flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => updateSelection(group.model, "quantity", Math.max(1, (sel.quantity || 1) - 1))}
                className="w-5 h-5 flex items-center justify-center rounded bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors font-bold"
              >
                -
              </button>
              <span className="text-[12px] font-extrabold text-slate-700 w-4 text-center">{sel.quantity || 1}</span>
              <button
                onClick={() => updateSelection(group.model, "quantity", (sel.quantity || 1) + 1)}
                className="w-5 h-5 flex items-center justify-center rounded bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors font-bold"
              >
                +
              </button>
            </div>
          )}
        </td>

        <td className="p-3 text-center">
          {availPeriods.length === 0 ? (
            <span className="text-[11px] text-slate-400">-</span>
          ) : availPeriods.length === 1 ? (
            <span className="text-[12px] text-slate-700">{availPeriods[0]}</span>
          ) : (
            <select
              value={sel.period || availPeriods[0]}
              disabled={disabled}
              onChange={(e) => { e.stopPropagation(); updateSelection(group.model, "period", e.target.value); }}
              onClick={(e) => e.stopPropagation()}
              className="bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded p-1 cursor-pointer text-slate-700 font-bold text-[11px] tracking-tight outline-none transition-colors w-full"
            >
              {availPeriods.map((p: string) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
        </td>
        <td className="p-3 text-center">
          {opts.careTypes.length <= 1 ? (
            <span className="text-[12px] text-slate-500">{opts.careTypes[0] || "-"}</span>
          ) : (
            <select
              value={sel.careType || opts.careTypes[0]}
              disabled={disabled}
              onChange={(e) => { e.stopPropagation(); updateSelection(group.model, "careType", e.target.value); }}
              onClick={(e) => e.stopPropagation()}
              className="bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded p-1 cursor-pointer text-slate-700 font-bold text-[11px] tracking-tight outline-none transition-colors w-full"
            >
              {opts.careTypes.map((ct: string) => <option key={ct} value={ct}>{ct}</option>)}
            </select>
          )}
        </td>
        <td className="p-3 text-center">
          {opts.careGrades.length <= 1 ? (
            <span className="text-[12px] text-slate-700">{opts.careGrades[0] || "-"}</span>
          ) : (
            <select
              value={sel.careGrade || opts.careGrades[0]}
              disabled={disabled}
              onChange={(e) => { e.stopPropagation(); updateSelection(group.model, "careGrade", e.target.value); }}
              onClick={(e) => e.stopPropagation()}
              className="bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded p-1 cursor-pointer text-slate-700 font-bold text-[11px] tracking-tight outline-none transition-colors w-full"
            >
              {opts.careGrades.map((cg: string) => <option key={cg} value={cg}>{cg}</option>)}
            </select>
          )}
        </td>
        <td className="p-3 text-center">
          {opts.visitCycles.length <= 1 ? (
            <span className="text-[12px] text-slate-700">{opts.visitCycles[0] || "-"}</span>
          ) : (
            <select
              value={sel.visitCycle || opts.visitCycles[0]}
              disabled={disabled}
              onChange={(e) => { e.stopPropagation(); updateSelection(group.model, "visitCycle", e.target.value); }}
              onClick={(e) => e.stopPropagation()}
              className="bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded p-1 cursor-pointer text-slate-700 font-bold text-[11px] tracking-tight outline-none transition-colors w-full"
            >
              {opts.visitCycles.map((vc: string) => <option key={vc} value={vc}>{vc}</option>)}
            </select>
          )}
        </td>
        <td className="p-3 text-right font-medium text-slate-600">
          {formatNumber(calc.basePrice)}
        </td>
        <td className="p-3 text-center font-medium" style={{
          color: disabled ? "#cbd5e1" : !activationOn ? "#cbd5e1" : calc.activation > 0 ? "#ea580c" : "#cbd5e1",
          textDecoration: !disabled && !activationOn && calc.activation > 0 ? "line-through" : "none"
        }}>
          {formatNumber(calc.activation)}
        </td>
        <td className="p-3 text-right font-bold text-blue-600">
          {formatNumber(calc.discountAmount)}
        </td>
        <td className={`p-3 text-right transition-colors ${disabled ? '' : 'bg-rose-50/30 group-hover:bg-rose-50'}`}>
          <div className="font-extrabold text-[15px] text-rose-600">
            {formatNumber(calc.discountPrice)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">
            일 {formatNumber(calc.dailyPrice)}원
          </div>
        </td>
        <td className="p-3 text-right">
          {prepay30 > 0 ? (
            <span className="text-[12px] font-semibold text-teal-600">
              {formatNumber(Math.max(0, prepay30 - calc.discountAmount))}
            </span>
          ) : (
            <span className="text-[11px] text-slate-300">-</span>
          )}
        </td>
        <td className="p-3 text-right">
          {prepay50 > 0 ? (
            <span className="text-[12px] font-semibold text-indigo-600">
              {formatNumber(Math.max(0, prepay50 - calc.discountAmount))}
            </span>
          ) : (
            <span className="text-[11px] text-slate-300">-</span>
          )}
        </td>
        {showChange && (
          <td className="p-3 text-right">
            {changeInfo && changeInfo.mainDiff !== 0 ? (
              <div>
                <span className={`text-[11px] font-bold ${changeInfo.mainDiff < 0 ? "text-blue-600" : "text-orange-600"}`}>
                  {changeInfo.mainDiff > 0 ? "+" : ""}{formatNumber(changeInfo.mainDiff)}원
                </span>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  {formatNumber(changeInfo.mainPrevPrice)} → {formatNumber(changeInfo.mainCurrPrice)}
                </div>
              </div>
            ) : statusBadge === "new" ? (
              <span className="text-[11px] font-bold text-green-600">NEW</span>
            ) : statusBadge === "deleted" ? (
              <span className="text-[11px] font-bold text-slate-400">삭제됨</span>
            ) : (
              <span className="text-slate-300">-</span>
            )}
          </td>
        )}
      </tr>
    );
  }

return (
    <div className="min-h-screen flex flex-col bg-[#F8F9FA] font-sans">
      {/* 상단 헤더 */}
      <header className="bg-white border-b border-gray-200 px-7 h-16 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          {/* 👇 반짝이 이모지 대신 요청하신 회사 로고 이미지 추가 */}
          <img 
            src="https://cdn.imweb.me/upload/S202407200b6b0c77cbd4a/57662c681acb4.png" 
            alt="Company Logo" 
            className="h-4 object-contain" 
          />
          <span className="text-xl">✨</span>
          <h1 className="text-xl font-extrabold text-slate-800 tracking-tight">LG POP Maker</h1>

        </div>
        <div className="flex items-center gap-3">
          {latestDate && <span className="text-xs text-slate-400">📊 가격 기준일: {formatDateStr(latestDate)}</span>}
          <span className="text-xs text-slate-500 font-semibold bg-slate-100 px-2.5 py-1 rounded-md">모델 {totalModels}개 로드</span>
        </div>
      </header>

      <div className="flex-1 overflow-hidden p-6 pb-10 flex gap-6 max-w-[1600px] mx-auto w-full">
        
        {/* 좌측 패널 (버튼 하단 고정 완벽 적용) */}
        <div className="w-[300px] shrink-0 flex flex-col h-full">
          
          {/* 스크롤되는 옵션 영역 */}
          <div className="flex-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
            <Panel title="채널 & 템플릿">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="text-[11px] font-bold text-slate-500 mb-1.5">채널 선택</div>
                  <select
                    value={channel.id}
                    onChange={(e) => setChannel(CHANNELS.find((c) => c.id === e.target.value) || CHANNELS[0])}
                    className="w-full p-2.5 rounded-lg border border-gray-200 text-sm font-semibold bg-gray-50 outline-none cursor-pointer focus:ring-2 focus:ring-slate-500/20 transition-all text-slate-700"
                  >
                    {CHANNELS.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <div className="text-[11px] font-bold text-slate-500 mb-1.5">템플릿 선택</div>
                  <select
                    value={template.id}
                    onChange={(e) => setTemplate(templates.find((t: any) => t.id === e.target.value) || templates[0])}
                    className="w-full p-2.5 rounded-lg border border-gray-200 text-sm font-semibold bg-gray-50 outline-none cursor-pointer focus:ring-2 focus:ring-slate-500/20 transition-all text-slate-700"
                  >
                    {templates
                      .filter((t: any) => t.channel?.includes(channel.id))
                      .map((t: any) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                  </select>
                </div>
              </div>
            </Panel>

            <Panel title="미리보기">
              <div className="bg-slate-50 rounded-xl border border-gray-200 h-[200px] flex items-center justify-center overflow-hidden">
                {templateThumb ? (
                  <img src={templateThumb} alt={template.name} className="max-w-full max-h-full object-contain rounded" />
                ) : (
                  <span className="text-xs text-slate-400">템플릿을 선택하세요</span>
                )}
              </div>
              {template.file && (
                <div className="mt-3 text-[10px] text-slate-500 space-y-1">
                  {templateBatchEnabled ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-slate-400">용지</span>
                        <span className="font-semibold text-slate-700">A4 {templateBatch?.paper_orientation || "가로"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">배치</span>
                        <span className="font-semibold text-slate-700">{templateBatch?.grid_cols || 2} × {templateBatch?.grid_rows || 2}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">개별 크기</span>
                        <span className="font-semibold text-slate-700">{templateBatch?.item_width_mm || 148}mm × {templateBatch?.item_height_mm || 105}mm</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex justify-between">
                      <span className="text-slate-400">출력</span>
                      <span className="font-semibold text-slate-700">A4 {templateOrientation} · 1장</span>
                    </div>
                  )}
                </div>
              )}
            </Panel>

            <Panel title="제휴카드 & 옵션">
              <select
                value={cardName}
                onChange={(e) => setCardName(e.target.value)}
                className="w-full p-2.5 rounded-lg border border-gray-200 text-sm bg-gray-50 outline-none cursor-pointer text-slate-700"
              >

                {uniqueCardNames.map((name: string) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              
              {usageList.length > 0 && !isPrepayDetailTemplate && (
                <select
                  value={monthUsage}
                  onChange={(e) => setMonthUsage(e.target.value)}
                  className="w-full p-2.5 rounded-lg border border-gray-200 text-sm bg-gray-50 outline-none cursor-pointer text-slate-700 mt-2"
                >
  
                  {usageList.map((u: string) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              )}

              <div className="border-b border-gray-100 my-4"></div>

              <div className="flex flex-col gap-3">
                {!isPrepayTemplate && (
                  <ToggleRow
                    label="활성화 할인 적용"
                    desc="OFF 시 K열 금액 가산"
                    checked={activationOn}
                    onChange={() => setActivationOn(!activationOn)}
                  />
                )}
                <ToggleRow
                  label="모델명 서픽스 표시"
                  desc="OFF 시 마침표(.) 뒤 제거"
                  checked={showSuffix}
                  onChange={() => setShowSuffix(!showSuffix)}
                />

                {isPrepayDetailTemplate && (
                  <>
                    <div className="h-px bg-gray-100 my-1"></div>
                    <div>
                      <div className="text-sm font-bold text-slate-800 mb-1.5">선납 할인</div>
                      <select
                        value={prepay}
                        onChange={(e) => setPrepay(e.target.value)}
                        className="w-full p-2.5 rounded-lg border border-gray-200 text-sm bg-gray-50 outline-none cursor-pointer text-slate-700"
                      >
                        {!isPrepayDetailTemplate && <option value="없음">미선택</option>}
                        <option value="30%">30% 선납</option>
                        <option value="50%">50% 선납</option>
                      </select>
                    </div>
                  </>
                )}
              </div>
            </Panel>
          </div>

          {/* 항상 화면 맨 밑에 고정되는 '생성하기' 버튼 */}
          <div className="shrink-0 pt-4">
            <button
              onClick={() => setShowPrintDialog(true)}
              disabled={checkedModels.size === 0 || generating || !template.file}
              className="w-full py-4 rounded-xl text-base font-bold text-white bg-slate-800 hover:bg-slate-900 shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  생성 중... ({genProgress.current}/{genProgress.total})
                </span>
              ) : !template.file ? (
                "⚠️ 템플릿 미등록"
              ) : checkedModels.size === 0 ? (
                "⚠️ 제품을 선택하세요" // 아무것도 체크 안 했을 때 명확히 안내
              ) : (
                `🎨 가격표 생성 (${checkedModels.size}개)`
              )}
            </button>
          </div>
          <div className="text-center mt-3 text-[10px] text-slate-400">
            Developed by 인터비즈 오유라
          </div>
        </div>

        {/* --- 출력 설정 모달 --- */}
        {showPrintDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm transition-opacity" onClick={() => setShowPrintDialog(false)}>
            <div className="bg-white rounded-2xl shadow-2xl p-7 w-[460px] flex flex-col" onClick={(e) => e.stopPropagation()}>
              
              {/* 모달 헤더 (타이틀 & 닫기 버튼) */}
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-extrabold text-slate-800">출력 설정</h3>
                <button onClick={() => setShowPrintDialog(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                  ✕
                </button>
              </div>

              <div className="flex gap-6">
                {/* 좌측: 출력 크기 선택 (카드형 라디오 버튼) */}
                <div className="flex-1">
                  <div className="text-xs font-bold text-slate-500 mb-3">용지 크기 선택</div>
                  <div className="flex flex-col gap-2.5">
                    {["기본", "A4", "A5", "A6", "90x55"].filter((size) => !(size === "A4" && !templateBatchEnabled)).map((size) => {
                      const desc = size === "기본" ? (templateBatchEnabled ? `${templateBatch?.grid_cols || 2}×${templateBatch?.grid_rows || 2} 배치` : "A4 1장") : size === "A4" ? "1개 / A4 1장" : size === "A5" ? "2개 / A4 1장" : size === "90x55" ? "10개 / A4 1장" : "4개 / A4 1장";
                      const isSelected = printSize === size;
                      
                      return (
                        <button
                          key={size}
                          onClick={() => setPrintSize(size as any)}
                          className={`relative p-3.5 rounded-xl border-2 text-left transition-all overflow-hidden ${
                            isSelected 
                              ? 'border-rose-500 bg-rose-50 ring-1 ring-rose-500' 
                              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          <div className={`font-extrabold text-sm ${isSelected ? 'text-rose-700' : 'text-slate-700'}`}>
                            {size}
                          </div>
                          <div className={`text-[11px] mt-1 font-medium ${isSelected ? 'text-rose-500' : 'text-slate-400'}`}>
                            {desc}
                          </div>
                          {/* 선택된 상태 표시 동그라미 (우측 상단) */}
                          {isSelected && (
                            <div className="absolute top-4 right-4 w-2.5 h-2.5 rounded-full bg-rose-500"></div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 우측: 배치 미리보기 */}
                <div className="w-[170px] flex flex-col items-center">
                  <div className="text-xs font-bold text-slate-500 mb-3 w-full text-center">배치 미리보기</div>
                  {(() => {
                    const isLandscapeTmpl = templateOrientation === "가로";
                    let cols, rows, orient;
                    if (printSize === "기본") {
                      if (templateBatchEnabled) {
                        cols = templateBatch?.grid_cols || 2; rows = templateBatch?.grid_rows || 2; orient = templateBatch?.paper_orientation || "가로";
                      } else {
                        cols = 1; rows = 1; orient = isLandscapeTmpl ? "가로" : "세로";
                      }
                    } else if (printSize === "A4") {
                      cols = 1; rows = 1; orient = isLandscapeTmpl ? "가로" : "세로";
                    } else if (printSize === "A5") {
                      cols = isLandscapeTmpl ? 1 : 2; rows = isLandscapeTmpl ? 2 : 1; orient = isLandscapeTmpl ? "세로" : "가로";
                    } else if (printSize === "A6") {
                      cols = 2; rows = 2; orient = isLandscapeTmpl ? "가로" : "세로";
                    } else {
                      cols = 2; rows = 5; orient = "세로";
                    }
                    const perPage = cols * rows;
                    const totalPages = Math.ceil(checkedModels.size / perPage);
                    const paperW = orient === "가로" ? 150 : 106;
                    const paperH = orient === "가로" ? 106 : 150;

                    return (
                      <div className="flex flex-col items-center w-full">
                        {/* 종이 모양 디자인 (그림자 추가) */}
                        <div className="border border-slate-200 rounded shadow-sm bg-white relative mb-4" style={{ width: paperW, height: paperH }}>
                          <div className="absolute inset-1.5 grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
                            {Array.from({ length: Math.min(perPage, checkedModels.size || perPage) }).map((_, i) => (
                              <div key={i} className="bg-rose-100/50 rounded-[3px] border border-rose-300 flex items-center justify-center">
                                <span className="text-[9px] font-extrabold text-rose-400">{i + 1}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* 요약 정보 뱃지 스타일 */}
                        <div className="w-full space-y-1.5 flex flex-col items-center">
                          <div className="bg-slate-100 text-slate-600 px-3 py-1 rounded-md text-[11px] font-bold">
                            A4 {orient} · {perPage}개/장
                          </div>
                          <div className="text-[11px] font-medium text-slate-500">
                            총 {checkedModels.size}개 제품
                          </div>
                          {checkedModels.size > 0 && (
                            <div className="text-[13px] font-extrabold text-rose-600 mt-1">
                              📄 총 {totalPages}장 출력
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* 하단 액션 버튼 */}
              <div className="flex gap-3 mt-7 pt-5 border-t border-slate-100">
                <button onClick={() => setShowPrintDialog(false)} className="flex-1 py-3 rounded-xl text-sm font-bold border border-slate-200 text-slate-600 cursor-pointer hover:bg-slate-50 transition-colors">
                  취소
                </button>
                <button onClick={() => { setShowPrintDialog(false); handleGenerate(); }} className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-slate-800 hover:bg-slate-900 cursor-pointer shadow-md transition-colors flex items-center justify-center gap-2">
                  <span>🎨</span> 생성하기
                </button>
              </div>

            </div>
          </div>
        )}

 {/* --- 미리보기 모달 --- */}
        {showPreview && generatedImages.length > 0 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm transition-opacity" onClick={() => setShowPreview(false)}>
            <div className="bg-white rounded-2xl shadow-2xl max-w-[90vw] max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} style={{ width: 1000 }}>
              
              {/* 헤더 영역 */ }
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-white shrink-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-base font-extrabold text-slate-800">가격표 미리보기</h3>
                  <div className="text-xs text-rose-600 bg-rose-50 border border-rose-100 px-3 py-1.5 rounded-full font-bold shadow-sm">
                    {previewIndex + 1} <span className="text-rose-400 font-medium px-1">/</span> {generatedImages.length}
                    {generatedNames[previewIndex] && <span className="text-slate-500 font-medium ml-1.5 pl-1.5 border-l border-rose-200">{generatedNames[previewIndex]}</span>}
                  </div>
                </div>
                
                {/* 상단 액션 버튼들 */ }
                <div className="flex items-center gap-2.5">
                  <button onClick={() => downloadImage(generatedImages[previewIndex], `${generatedNames[previewIndex] || "price"}_${previewIndex + 1}.png`)} 
                          className="text-xs px-3.5 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg font-bold hover:bg-slate-50 transition-colors shadow-sm">
                    📥 현재 이미지 저장
                  </button>
                  
                  {generatedImages.length > 1 && (
                    <button onClick={() => downloadAllImages(generatedImages, template.name)} 
                            className="text-xs px-3.5 py-2 bg-slate-800 text-white rounded-lg font-bold hover:bg-slate-900 transition-colors shadow-md">
                      📦 전체 저장 ({generatedImages.length}개)
                    </button>
                  )}
                  
                  <button onClick={() => {
                    const iframe = document.createElement("iframe");
                    iframe.style.display = "none";
                    document.body.appendChild(iframe);
                    const doc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (doc) {
                      const img = new Image();
                      img.src = generatedImages[0];
                      img.onload = () => {
                        const orient = img.width > img.height ? "landscape" : "portrait";
                        doc.open();
                        doc.write(`<html><head><title>가격표</title><style>@page{size:A4 ${orient};margin:0;}body{margin:0;}img{width:100%;height:100vh;object-fit:contain;display:block;page-break-after:always;}img:last-child{page-break-after:auto;}</style></head><body>`);
                        generatedImages.forEach((src) => { doc.write(`<img src="${src}" />`); });
                        doc.write("</body></html>");
                        doc.close();
                        setTimeout(() => { iframe.contentWindow?.print(); setTimeout(() => document.body.removeChild(iframe), 1000); }, 500);
                      };
                    }
                  }} className="text-xs px-3.5 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg font-bold hover:bg-slate-50 transition-colors shadow-sm ml-1">
                    🖨️ 인쇄 / PDF저장
                  </button>
                  
                  <div className="w-px h-5 bg-slate-200 mx-1"></div>
                  
                  <button onClick={() => setShowPreview(false)} className="w-8 h-8 rounded-full bg-slate-100 text-slate-500 text-base flex items-center justify-center hover:bg-slate-200 hover:text-slate-700 transition-colors">
                    ✕
                  </button>
                </div>
              </div>

              {/* 이미지 뷰어 영역 */ }
              <div className="flex-1 overflow-auto p-6 flex items-center justify-center bg-slate-100/50" style={{ minHeight: 450 }}>
                <img 
                  src={generatedImages[previewIndex]} 
                  alt={`가격표 ${previewIndex + 1}`} 
                  className="max-w-full max-h-[65vh] object-contain rounded-xl shadow-lg ring-1 ring-slate-900/5 bg-white" 
                />
              </div>

              {/* 하단 썸네일 네비게이션 */ }
              {generatedImages.length > 1 && (
                <div className="flex items-center justify-center gap-4 px-6 py-4 border-t border-gray-200 bg-white shrink-0">
                  <button 
                    onClick={() => setPreviewIndex(Math.max(0, previewIndex - 1))} 
                    disabled={previewIndex === 0} 
                    className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-50 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    ◀
                  </button>
                  
                  <div className="flex gap-2.5 overflow-x-auto max-w-[700px] py-2 px-1 scrollbar-hide items-center">
                    {generatedImages.map((img, i) => (
                      <button 
                        key={i} 
                        onClick={() => setPreviewIndex(i)} 
                        className={`shrink-0 rounded-lg overflow-hidden transition-all duration-200 cursor-pointer ${
                          i === previewIndex 
                            ? 'ring-2 ring-rose-500 ring-offset-2 scale-[1.03] shadow-md border-transparent' 
                            : 'border border-slate-200 opacity-50 hover:opacity-100 hover:border-slate-400'
                        }`}
                      >
                        <img src={img} alt="" className="w-16 h-11 object-cover bg-white" />
                      </button>
                    ))}
                  </div>
                  
                  <button 
                    onClick={() => setPreviewIndex(Math.min(generatedImages.length - 1, previewIndex + 1))} 
                    disabled={previewIndex === generatedImages.length - 1} 
                    className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-50 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    ▶
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0 bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          
          {/* 상단 탭 영역 */}
          <div className="px-6 pt-5 pb-4 border-b border-gray-100 bg-white z-20 shrink-0">
            <div className="flex gap-2 mb-4">
              <FilterButton active={activeCategory === "활성화 제품"} onClick={() => {
                const newSelections: Record<string, { period: string; careType: string; careGrade: string; visitCycle: string }> = {};
                Object.values(activationModelGroups).flat().forEach((group: ModelGroup) => {
                  const periodKeys: { key: keyof PriceRow; period: string }[] = [
                    { key: 'y6base', period: '6년' },
                    { key: 'y5base', period: '5년' },
                    { key: 'y4base', period: '4년' },
                    { key: 'y3base', period: '3년' },
                  ];
                  for (const { key, period } of periodKeys) {
                    const actRow = group.rows.find((r: PriceRow) => (r.activation || 0) > 0 && ((r[key] as number) || 0) > 0);
                    if (actRow) {
                      newSelections[group.model] = {
                        period,
                        careType: actRow.careType || '',
                        careGrade: actRow.careGrade || '',
                        visitCycle: actRow.visitCycle || '',
                      };
                      break;
                    }
                  }
                });
                setModelSelections(prev => ({ ...prev, ...newSelections }));
                setActiveCategory("활성화 제품");
              }} activeColor="text-orange-600 bg-orange-50 border-orange-200 shadow-sm">
                활성화 제품 ({activationCount})
              </FilterButton>
              <FilterButton active={activeCategory === "변동 제품"} onClick={() => setActiveCategory("변동 제품")} activeColor="text-purple-600 bg-purple-50 border-purple-200 shadow-sm">
                변동 제품 ({changeCount})
              </FilterButton>
              <FilterButton active={activeCategory === "30%선납"} onClick={() => setActiveCategory("30%선납")} activeColor="text-teal-600 bg-teal-50 border-teal-200 shadow-sm">
                30%선납 ({prepay30Count})
              </FilterButton>
              <FilterButton active={activeCategory === "50%선납"} onClick={() => setActiveCategory("50%선납")} activeColor="text-blue-600 bg-blue-50 border-blue-200 shadow-sm">
                50%선납 ({prepay50Count})
              </FilterButton>
            </div>
            
            <div className="flex gap-2 flex-wrap items-center">
              <CategoryTab active={activeCategory === "전체"} onClick={() => setActiveCategory("전체")}>
                전체보기
              </CategoryTab>
              <div className="w-px h-4 bg-gray-300 mx-1"></div>
              {categories.map((cat) => (
                <CategoryTab key={cat} active={activeCategory === cat} onClick={() => setActiveCategory(cat)}>
                  {cat}
                </CategoryTab>
              ))}
            </div>

            <div className="mt-4 flex justify-between items-center">
              <div className="flex gap-4 items-center">
                {activeCategory !== "변동 제품" && (
                  <label className="flex items-center gap-2 cursor-pointer bg-slate-50 px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-slate-100 transition-colors">
                    {/* 전체선택 숫자 동적 변경 (filteredCount) 적용 완료 */ }
                    <input type="checkbox" checked={Object.values(filteredData).flat().every((g: any) => checkedModels.has(g.model)) && filteredCount > 0} onChange={toggleAll} className="w-4 h-4 accent-blue-600 cursor-pointer" />
                    <span className="text-xs font-bold text-slate-600">전체 선택 ({filteredCount})</span>
                  </label>
                )}
                <div className="text-xs text-slate-500 font-medium">선택됨: <span className="text-rose-600 font-bold">{checkedModels.size}</span>개</div>
              </div>
              <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="모델명 검색..." className="w-56 px-4 py-2 text-xs rounded-full border border-gray-300 bg-gray-50 outline-none focus:border-rose-400 focus:bg-white transition-colors" />
            </div>
          </div>

          <div className="flex-1 overflow-auto bg-slate-50/50 p-6 relative">
            {activeCategory === "변동 제품" ? (
              <div className="pb-4">
                <div className="bg-white rounded-xl p-5 mb-5 border border-gray-200 shadow-sm">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="text-sm font-extrabold text-purple-700">🗓️ 비교 기준 날짜</span>
                    {latestDate && <span className="text-xs text-slate-500 font-medium bg-slate-100 px-2 py-1 rounded-md">현재 적용 기준: {formatDateStr(latestDate)}</span>}
                  </div>
                  {comparableDates.length === 0 ? (
                    <div className="text-sm text-slate-400 py-2">비교할 과거 가격표가 없습니다.</div>
                  ) : (
                    <MiniCalendar availableDates={comparableDates} selectedDate={selectedCompareDate} latestDate={latestDate} month={calendarMonth} onMonthChange={setCalendarMonth} onSelect={(d: any) => { runCompare(d); }} />
                  )}
                  {selectedCompareDate && latestDate && (
                    <div className="mt-4 text-xs font-bold text-slate-500 bg-purple-50 text-purple-700 inline-block px-3 py-1.5 rounded-lg border border-purple-100">
                      {formatDateStr(selectedCompareDate)} → {formatDateStr(latestDate)} 변동 내역
                    </div>
                  )}
                </div>

                {compareLoading && (
                  <div className="py-10 text-center">
                    <div className="w-8 h-8 border-[3px] border-purple-600 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                    <p className="text-sm font-bold text-slate-500">데이터 비교 분석 중...</p>
                  </div>
                )}

                {!compareLoading && compareResult && (
                  <>
                    <div className="flex gap-3 mb-5">
                      {[
                        { key: "all", label: "전체", count: compareResult.summary.totalChanges, color: "#475569", bg: "#f1f5f9", border: "#cbd5e1" },
                        { key: "new", label: "신규", count: compareResult.summary.newCount, color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
                        { key: "down", label: "인하", count: compareResult.summary.downCount, color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
                        { key: "up", label: "인상", count: compareResult.summary.upCount, color: "#ea580c", bg: "#fff7ed", border: "#fed7aa" },
                        { key: "deleted", label: "삭제", count: compareResult.summary.deletedCount, color: "#64748b", bg: "#f8fafc", border: "#e2e8f0" }
                      ].map((s) => (
                        <button
                          key={s.key}
                          onClick={() => setChangeFilter(s.key as any)}
                          className="flex-1 rounded-xl p-4 text-center transition-all border-2 cursor-pointer shadow-sm"
                          style={{
                            background: s.bg,
                            borderColor: changeFilter === s.key ? s.color : s.border,
                            opacity: s.count === 0 && s.key !== "all" ? 0.4 : 1
                          }}
                        >
                          <div className="text-2xl font-black mb-1" style={{ color: s.color }}>{s.count}</div>
                          <div className="text-xs font-bold" style={{ color: s.color }}>{s.label}</div>
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center mb-4">
                      <label className="flex items-center gap-2 cursor-pointer bg-slate-50 px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-slate-100 transition-colors">
                        <input
                          type="checkbox"
                          checked={filteredChangeTableData.filter((s) => !s.isDeleted).flatMap((s) => s.groups).length > 0 && filteredChangeTableData.filter((s) => !s.isDeleted).flatMap((s) => s.groups).every((g) => checkedModels.has(g.model))}
                          onChange={toggleAllChanges}
                          className="w-4 h-4 accent-purple-600 cursor-pointer"
                        />
                        <span className="text-xs font-bold text-slate-600">변동 모델 전체 선택 (삭제 제외)</span>
                      </label>
                    </div>

                    {filteredChangeTableData.length === 0 ? (
                      <div className="py-12 text-center text-slate-400 font-bold text-sm bg-white rounded-2xl border border-gray-200">해당 유형의 변동 내역이 없습니다.</div>
                    ) : (
                      filteredChangeTableData.map((section) => {
                        const sc = STATUS_CONFIG[section.status as keyof typeof STATUS_CONFIG];
                        return (
                          <div key={section.status} className="mb-8">
                            <div className="flex items-center gap-2 mb-3">
                              <div className="w-1.5 h-4 rounded-full" style={{ background: sc.color }}></div>
                              <span className="text-base font-extrabold text-slate-800">{sc.label}</span>
                              <span className="text-xs text-slate-400 font-semibold">({section.groups.length}개 모델)</span>
                            </div>
                            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
                              <table className="w-full border-collapse text-xs whitespace-nowrap">
                                <thead className="sticky top-0 z-10 bg-slate-100/50 shadow-sm backdrop-blur-sm">
                                  <tr>
                                    <th className="w-10 p-3 border-b-2 border-gray-300 text-center">
                                      {!section.isDeleted && <input type="checkbox" checked={section.groups.every((g) => checkedModels.has(g.model))} onChange={() => toggleStatusAll(section.status as any)} className="w-4 h-4 cursor-pointer accent-blue-600" />}
                                    </th>
                                    <th className="w-[160px] p-3 border-b-2 border-gray-300 text-left font-extrabold text-slate-700 text-[13px]">모델명</th>
                                    <th className="w-[70px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">수량</th>
                                    <th className="w-[68px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">계약기간</th>
                                    <th className="w-[90px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">케어십형태</th>
                                    <th className="w-[110px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">케어십구분</th>
                                    <th className="w-[76px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">방문주기</th>
                                    <th className="w-[76px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">정상구독료</th>
                                    <th className="w-[56px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">활성화</th>
                                    <th className="w-[60px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">카드할인</th>
                                    <th className="w-[80px] p-3 border-b-2 border-rose-200 text-right font-extrabold text-rose-600 bg-rose-50/50 text-[13px]">월구독료</th>
                                    <th className="w-[70px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">30%선납</th>
                                    <th className="w-[70px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">50%선납</th>
                                    <th className="w-[100px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">가격 변동</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {section.groups.map((group) => renderModelRow(group, { disabled: section.isDeleted, statusBadge: section.status as any, showChange: true }))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </>
                )}
                {!compareLoading && !compareResult && comparableDates.length > 0 && (
                  <div className="py-12 text-center text-slate-400 font-bold text-sm bg-white rounded-2xl border border-gray-200">위에서 비교할 날짜를 선택하세요.</div>
                )}
              </div>
            ) : visibleCategories.length === 0 ? (
              <div className="py-12 text-center text-slate-400 font-bold text-sm bg-white rounded-2xl border border-gray-200">해당 카테고리에 모델이 없습니다.</div>
            ) : (
              visibleCategories.map((cat) => {
                const catGroups = filteredData[cat];
                return (
                  <div key={cat} className="mb-8">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-1.5 h-4 bg-slate-800 rounded-full"></div>
                      <span className="text-base font-extrabold text-slate-800">{cat}</span>
                      <span className="text-xs text-slate-400 font-semibold">({catGroups.length}개 모델)</span>
                    </div>
                    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
                      <table className="w-full border-collapse text-xs whitespace-nowrap">
                        <thead className="sticky top-0 z-10 bg-slate-100/50 shadow-sm backdrop-blur-sm">
                          <tr>
                            <th className="w-10 p-3 border-b-2 border-gray-300 text-center"><input type="checkbox" checked={catGroups.every((g: any) => checkedModels.has(g.model))} onChange={() => toggleCatAll(cat)} className="w-4 h-4 accent-blue-600 cursor-pointer" /></th>
                            <th className="w-[160px] p-3 border-b-2 border-gray-300 text-left font-extrabold text-slate-700 text-[13px]">모델명</th>
                            <th className="w-[60px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">수량</th>
                            <th className="w-[68px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">계약기간</th>
                            <th className="w-[90px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">케어십형태</th>
                            <th className="w-[110px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">케어십구분</th>
                            <th className="w-[76px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">방문주기</th>
                            <th className="w-[76px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">정상구독료</th>
                            <th className="w-[56px] p-3 border-b-2 border-gray-300 text-center font-extrabold text-slate-700 text-[13px]">활성화</th>
                            <th className="w-[60px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">카드할인</th>
                            <th className="w-[80px] p-3 border-b-2 border-rose-200 text-right font-extrabold text-rose-600 bg-rose-50/50 text-[13px]">월구독료</th>
                            <th className="w-[70px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">30%선납</th>
                            <th className="w-[70px] p-3 border-b-2 border-gray-300 text-right font-extrabold text-slate-700 text-[13px]">50%선납</th>
                          </tr>
                        </thead>
                        <tbody>
                          {catGroups.map((group: any) => renderModelRow(group))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 하위 컴포넌트
// ==========================================
function Panel({ title, children }: any) {
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-200">
      <div className="text-sm font-extrabold text-slate-800 mb-4 flex items-center gap-1.5">
        <div className="w-1.5 h-3.5 bg-rose-600 rounded-full"></div>
        {title}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }: any) {
  return (
    <div className="flex justify-between items-center py-1">
      <div>
        <div className="text-sm font-bold text-slate-800">{label}</div>
        {desc && <div className="text-[11px] text-slate-400 mt-0.5">{desc}</div>}
      </div>
      <div onClick={onChange} className={`w-10 h-[22px] rounded-full relative cursor-pointer shadow-inner transition-colors shrink-0 ${checked ? "bg-green-500" : "bg-slate-200"}`}>
        <div className={`w-[18px] h-[18px] rounded-full bg-white absolute top-[2px] shadow-sm transition-transform ${checked ? "translate-x-[20px]" : "translate-x-[2px]"}`}></div>
      </div>
    </div>
  );
}

function FilterButton({ children, active = false, activeColor, onClick }: any) {
  const inactiveClass = "bg-slate-100 text-slate-500 border-transparent hover:bg-slate-200";
  return (
    <button onClick={onClick} className={`px-4 py-1.5 rounded-full text-xs font-bold border transition-colors ${active ? activeColor : inactiveClass}`}>
      {children}
    </button>
  );
}

function CategoryTab({ children, active = false, onClick }: any) {
  return (
    <button onClick={onClick} className={`px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors border ${active ? 'text-rose-600 bg-rose-50 border-rose-200 shadow-sm' : 'bg-white text-slate-600 border-gray-200 hover:bg-gray-50'}`}>
      {children}
    </button>
  );
}

function MiniCalendar({ availableDates, selectedDate, latestDate, month, onMonthChange, onSelect }: any) {
  const parseDateStr = (d: string) => new Date(2000 + parseInt(d.slice(0, 2)), parseInt(d.slice(2, 4)) - 1, parseInt(d.slice(4, 6)));
  const dateSet = new Set(availableDates);
  const latestSet = new Set([latestDate]);
  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstDay = new Date(year, mon, 1).getDay();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const prevMonth = () => onMonthChange(new Date(year, mon - 1, 1));
  const nextMonth = () => onMonthChange(new Date(year, mon + 1, 1));
  const toDateStr = (day: number) => {
    const y = String(year).slice(2);
    const m = String(mon + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    return `${y}${m}${d}`;
  };
  const dayNames = ["일", "월", "화", "수", "목", "금", "토"];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mt-2" style={{ maxWidth: 320 }}>
      <div className="flex items-center justify-between mb-3">
        <button onClick={prevMonth} className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center cursor-pointer text-slate-600 text-sm font-bold transition-colors">◀</button>
        <span className="text-sm font-extrabold text-slate-800">{year}년 {mon + 1}월</span>
        <button onClick={nextMonth} className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center cursor-pointer text-slate-600 text-sm font-bold transition-colors">▶</button>
      </div>
      <div className="grid grid-cols-7 gap-1 mb-2">
        {dayNames.map((d) => <div key={d} className="text-center text-[11px] font-bold text-slate-400 py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstDay }).map((_, i) => <div key={`empty-${i}`} className="h-8" />)}
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
              className="h-8 rounded-lg text-xs font-bold flex items-center justify-center relative transition-all"
              style={{
                background: isSelected ? "#e11d48" : isLatest ? "#f0fdf4" : isAvailable ? "#f8fafc" : "transparent",
                color: isSelected ? "#fff" : isLatest ? "#16a34a" : isAvailable ? "#475569" : "#cbd5e1",
                cursor: isAvailable ? "pointer" : "default",
                border: isLatest ? "1.5px solid #86efac" : isAvailable ? "1px solid #e2e8f0" : "1px solid transparent",
              }}
            >
              {day}
              {isLatest && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-500 border-2 border-white rounded-full" />}
            </button>
          );
        })}
      </div>
      <div className="flex gap-4 mt-4 pt-3 border-t border-gray-100">
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-slate-100 border border-slate-300" /><span className="text-[10px] font-bold text-slate-500">과거 가격표</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-green-50 border border-green-300" /><span className="text-[10px] font-bold text-slate-500">최신 (현재)</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-rose-600" /><span className="text-[10px] font-bold text-slate-500">비교 기준</span></div>
      </div>
    </div>
  );
}