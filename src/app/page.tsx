'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { loadCards, loadQRMapping, loadCareBenefits } from '@/lib/data-loader';
import {
  getCardDiscount, getUniqueCardNames, getUsagesByCard, formatNumber
} from '@/lib/price-engine';
import type { PriceRow, CardInfo, QRMapping, CareBenefit } from '@/lib/types';

// ==========================================
// 템플릿 정의
// ==========================================
const TEMPLATES = [
  { id: 'A6_이마트_QR코드', name: 'A6 이마트 QR코드', file: 'A6_이마트_QR코드.json', pattern: 'B' as const },
  { id: 'emart-price', name: '이마트 가격표', file: '', pattern: 'B' as const },
  { id: 'a4-prepay', name: 'A4 구독 선납 가격표', file: '', pattern: 'A' as const },
  { id: 'a5-prepay', name: 'A5 구독 선납 가격표', file: '', pattern: 'A' as const },
  { id: 'homeplus', name: 'A6 홈플러스 가격표', file: '', pattern: 'B' as const },
  { id: 'traders', name: 'A4/A6 트레이더스 가격표', file: '', pattern: 'B' as const },
];

// ==========================================
// 채널 정의
// ==========================================
const CHANNELS = [
  { id: 'emart', name: '이마트', sheet: '이마트-업데이트' },
  { id: 'homeplus', name: '홈플러스', sheet: '홈플러스-업데이트' },
  { id: 'jeonjaland', name: '전자랜드', sheet: '전자랜드-업데이트' },
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
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];

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

// 해당 행에서 사용 가능한 계약기간 목록
function getAvailablePeriods(row: PriceRow): string[] {
  const periods: string[] = [];
  if (row.y6base && row.y6base > 0) periods.push('6년');
  if (row.y5base && row.y5base > 0) periods.push('5년');
  if (row.y4base && row.y4base > 0) periods.push('4년');
  if (row.y3base && row.y3base > 0) periods.push('3년');
  return periods;
}

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
  const [template, setTemplate] = useState(TEMPLATES[0]);
  const [cardName, setCardName] = useState('');
  const [monthUsage, setMonthUsage] = useState('');
  const [activationOn, setActivationOn] = useState(false);
  const [qrOn, setQrOn] = useState(true);
  const [prepay, setPrepay] = useState('없음');
  const [activeCategory, setActiveCategory] = useState('전체');
  const [checkedModels, setCheckedModels] = useState<Set<string>>(new Set());

  // ----- 모델별 드롭다운 선택 상태 -----
  // key: 모델명, value: { period, careType, careGrade, visitCycle }
  const [modelSelections, setModelSelections] = useState<Record<string, {
    period: string; careType: string; careGrade: string; visitCycle: string;
  }>>({});

  // ----- 데이터 로딩 -----
  useEffect(() => {
    async function loadAll() {
      try {
        setLoading(true);
        setError(null);
        const [price, cardData, qr, care] = await Promise.all([
          parseExcelFromURL('/data/price.xlsx', channel.sheet),
          loadCards(),
          loadQRMapping(),
          loadCareBenefits(),
        ]);
        setPriceData(price);
        setCards(cardData);
        setQrMapping(qr);
        setCareBenefits(care);
        setModelSelections({});
        setCheckedModels(new Set());
      } catch (e) {
        setError('데이터를 불러오는데 실패했습니다.');
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    loadAll();
  }, [channel]);

  // ----- 모델별 그룹핑 (같은 모델 = 1행, 내부에 여러 PriceRow) -----
  const categoryModelGroups = useMemo(() => {
    // 1) 모델별로 모든 행 수집
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

    // 2) 카테고리별 ModelGroup 생성
    const groups: Record<string, ModelGroup[]> = {};
    for (const [model, rows] of Object.entries(modelMap)) {
      const cat = modelCategory[model];
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ model, category: cat, rows });
    }

    // 3) ㄱㄴㄷ 순서 정렬 + 나머지
    const sorted: Record<string, ModelGroup[]> = {};
    for (const cat of CATEGORY_ORDER) {
      if (groups[cat]) sorted[cat] = groups[cat];
    }
    for (const cat of Object.keys(groups).sort()) {
      if (!sorted[cat]) sorted[cat] = groups[cat];
    }
    return sorted;
  }, [priceData]);

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

  // ----- 필터된 데이터 -----
  const filteredData = useMemo(() => {
    if (activeCategory === '전체') return categoryModelGroups;
    if (activeCategory === '활성화 제품') return activationModelGroups;
    if (activeCategory === '변동 제품') return {};
    if (categoryModelGroups[activeCategory]) {
      return { [activeCategory]: categoryModelGroups[activeCategory] };
    }
    return {};
  }, [activeCategory, categoryModelGroups, activationModelGroups]);

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

    // 케어십형태 → 케어십구분 → 방문주기 순으로 매칭
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

    // 케어십형태: 모델의 모든 행에서 유니크
    const careTypes = Array.from(new Set(group.rows.map(r => r.careType).filter(Boolean)));

    // 케어십구분: 선택된 케어십형태에 해당하는 행에서 유니크
    let careGradeRows = group.rows;
    if (sel.careType) {
      const f = careGradeRows.filter(r => r.careType === sel.careType);
      if (f.length > 0) careGradeRows = f;
    }
    const careGrades = Array.from(new Set(careGradeRows.map(r => r.careGrade).filter(Boolean)));

    // 방문주기: 선택된 케어십형태 + 구분에 해당하는 행에서 유니크
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

      // 연쇄 리셋: 상위 변경 시 하위 초기화
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

  // ----- 카드 변경 시 월실적 리셋 -----
  useEffect(() => { setMonthUsage(''); }, [cardName]);

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

  return (
    <div className="min-h-screen flex flex-col bg-[#f4f3f0]">
      {/* ========== 헤더 ========== */}
      <header className="bg-[#F0ECE4] border-b border-[#e0dcd4] px-7 h-14 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="bg-[#A50034] rounded-md px-2 py-0.5">
            <span className="font-black text-sm text-white" style={{ fontFamily: 'Georgia, serif' }}>LG</span>
          </div>
          <h1 className="text-lg font-extrabold text-gray-900 tracking-tight">POP Maker</h1>
          <select
            value={channel.id}
            onChange={e => setChannel(CHANNELS.find(c => c.id === e.target.value) || CHANNELS[0])}
            className="text-xs text-[#A50034] font-bold border-[1.5px] border-[#A50034] px-2 py-0.5 rounded bg-transparent outline-none cursor-pointer"
          >
            {CHANNELS.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">모델 {totalModels}개 로드</span>
        </div>
      </header>

      {/* ========== 메인 ========== */}
      <div className="flex-1 overflow-auto p-4 pb-10">
        <div className="max-w-[1600px] mx-auto flex gap-4">

          {/* ========== 좌측: 설정 패널 ========== */}
          <div className="w-[300px] shrink-0 flex flex-col gap-3">
            <Panel title="템플릿 선택">
              <select
                value={template.id}
                onChange={e => setTemplate(TEMPLATES.find(t => t.id === e.target.value) || TEMPLATES[0])}
                className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm font-semibold bg-[#FAFAF8] outline-none cursor-pointer"
              >
                {TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Panel>

            <Panel title="미리보기">
              <div className="bg-[#f8f7f5] rounded-lg border border-[#e8e5df] h-[200px] flex items-center justify-center">
                {checkedModels.size > 0 ? (
                  <div className="text-center">
                    <div className="w-[120px] h-[160px] bg-white rounded-md border border-gray-200 mx-auto flex flex-col items-center justify-center p-2 shadow-sm">
                      <div className="text-[7px] text-[#A50034] font-extrabold mb-1">LG 구독</div>
                      <div className="text-[6px] text-gray-500 mb-0.5 truncate w-full text-center">
                        {Array.from(checkedModels)[0]}
                      </div>
                      <div className="w-4/5 h-px bg-gray-200 my-1" />
                      {(() => {
                        const firstModel = Array.from(checkedModels)[0];
                        const allGroups = Object.values(categoryModelGroups).flat();
                        const group = allGroups.find(g => g.model === firstModel);
                        if (!group) return <div className="text-[8px] text-gray-400">-</div>;
                        const calc = getCalculatedPrice(group);
                        return (
                          <>
                            <div className="text-[8px] text-[#A50034] font-extrabold">월 {formatNumber(calc.discountPrice)}원</div>
                            <div className="text-[5px] text-gray-400 mt-0.5">일 {formatNumber(calc.dailyPrice)}원</div>
                          </>
                        );
                      })()}
                      {qrOn && (
                        <div className="mt-1.5 w-6 h-6 bg-gray-100 rounded-sm flex items-center justify-center">
                          <span className="text-[5px] text-gray-400">QR</span>
                        </div>
                      )}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-2">선택: {checkedModels.size}개 모델</div>
                  </div>
                ) : (
                  <span className="text-xs text-gray-300">모델을 선택하세요</span>
                )}
              </div>
            </Panel>

            <Panel title="제휴카드">
              <select value={cardName} onChange={e => setCardName(e.target.value)}
                className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer">
                <option value="">카드 미선택 (기본 16,000원)</option>
                {uniqueCardNames.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
              {cardName && usageList.length > 0 && (
                <select value={monthUsage} onChange={e => setMonthUsage(e.target.value)}
                  className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer mt-2">
                  <option value="">월실적 선택...</option>
                  {usageList.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              )}
            </Panel>

            <Panel title="옵션">
              <div className="flex flex-col gap-2.5">
                <ToggleRow label="활성화 할인 적용" desc="OFF 시 K열 금액 가산" checked={activationOn} onChange={() => setActivationOn(!activationOn)} />
                <div className="h-px bg-[#f0ece4]" />
                <ToggleRow label="QR코드 포함" desc="가격표에 QR코드 표시" checked={qrOn} onChange={() => setQrOn(!qrOn)} />
                <div className="h-px bg-[#f0ece4]" />
                <div>
                  <div className="text-sm font-semibold text-gray-700 mb-1.5">선납 할인</div>
                  <select value={prepay} onChange={e => setPrepay(e.target.value)}
                    className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer">
                    <option value="없음">미선택</option>
                    <option value="30%">30% 선납</option>
                    <option value="50%">50% 선납</option>
                  </select>
                </div>
              </div>
            </Panel>

            <button
              disabled={checkedModels.size === 0}
              className="w-full py-3.5 rounded-xl border-none text-base font-bold transition-all"
              style={{
                background: checkedModels.size > 0 ? 'linear-gradient(135deg, #A50034, #C4003D)' : '#ddd',
                color: checkedModels.size > 0 ? '#fff' : '#999',
                cursor: checkedModels.size > 0 ? 'pointer' : 'not-allowed',
                boxShadow: checkedModels.size > 0 ? '0 4px 16px rgba(165,0,52,0.25)' : 'none',
              }}
            >
              🎨 가격표 생성 ({checkedModels.size}개)
            </button>
          </div>

          {/* ========== 우측: 제품 테이블 ========== */}
          <div className="flex-1 flex flex-col min-w-0">

            {/* 카테고리 필터 + 통계 */}
            <div className="bg-white rounded-t-xl p-4 pb-3 shadow-sm">
              <div className="flex gap-1.5 flex-wrap mb-3">
                <CatButton label="전체" active={activeCategory === '전체'} onClick={() => setActiveCategory('전체')} />
                <CatButton label="활성화 제품" count={activationCount} active={activeCategory === '활성화 제품'} color="#E67E22" bgTint="#FFF8F0" onClick={() => setActiveCategory('활성화 제품')} />
                <CatButton label="변동 제품" count={0} active={activeCategory === '변동 제품'} color="#8E24AA" bgTint="#F9F0FF" onClick={() => setActiveCategory('변동 제품')} />
                <div className="w-px h-6 bg-gray-200 self-center mx-1" />
                {categories.map(cat => (
                  <CatButton key={cat} label={cat} active={activeCategory === cat} onClick={() => setActiveCategory(cat)} />
                ))}
              </div>

              <div className="flex justify-between items-center pt-2.5 border-t border-gray-100">
                <div className="flex gap-4 items-center">
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
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">선택</span>
                    <span className="text-base font-extrabold text-[#A50034]">{checkedModels.size}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 제품군별 가격 테이블 */}
            <div className="bg-white rounded-b-xl px-5 pb-5 flex-1 shadow-sm overflow-x-auto">
              {visibleCategories.length === 0 ? (
                <div className="py-10 text-center text-gray-300 text-sm">
                  {activeCategory === '변동 제품' ? '이전 가격표를 업로드하면 변동 제품을 확인할 수 있습니다.' : '해당 카테고리에 모델이 없습니다'}
                </div>
              ) : (
                visibleCategories.map(cat => {
                  const catGroups = filteredData[cat];
                  return (
                    <div key={cat} className="mt-4">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-[3px] h-[18px] bg-[#A50034] rounded-sm" />
                        <span className="text-base font-extrabold text-gray-900">{cat}</span>
                        <span className="text-xs text-gray-500 font-semibold">({catGroups.length}개 모델)</span>
                        <div className="flex-1" />
                      </div>

                      <div className="rounded-xl overflow-hidden border border-gray-100">
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
                            </tr>
                          </thead>
                          <tbody>
                            {catGroups.map((group, idx) => {
                              const checked = checkedModels.has(group.model);
                              const calc = getCalculatedPrice(group);
                              const sel = modelSelections[group.model] || { period: '6년', careType: '', careGrade: '', visitCycle: '' };
                              const opts = getDropdownOptions(group);
                              const selectedRow = getSelectedRow(group);
                              const availPeriods = getAvailablePeriods(selectedRow);

                              return (
                                <tr key={group.model}
                                  className="border-t border-gray-50 transition-all"
                                  style={{ background: checked ? '#fff' : '#fafafa', opacity: checked ? 1 : 0.5 }}>
                                  <td className="text-center p-2 cursor-pointer" onClick={() => toggleModel(group.model)}>
                                    <input type="checkbox" checked={checked} onChange={() => {}} className="w-4 h-4 accent-[#A50034] cursor-pointer" />
                                  </td>
                                  <td className="p-2 font-bold text-[11px] text-gray-700 tracking-tight cursor-pointer" onClick={() => toggleModel(group.model)}
                                    style={{ fontFamily: "'Inter', sans-serif" }}>
                                    {group.model}
                                  </td>
                                    {/* 계약기간 */}
                                  <td className="text-center p-2">
                                    {availPeriods.length === 0 ? (
                                      <span className="text-[11px] text-gray-400">-</span>
                                    ) : availPeriods.length === 1 ? (
                                      <span className="text-[11px] text-gray-700">{availPeriods[0]}</span>
                                    ) : (
                                      <select value={sel.period || availPeriods[0]}
                                        onChange={e => { e.stopPropagation(); updateSelection(group.model, 'period', e.target.value); }}
                                        onClick={e => e.stopPropagation()}
                                        className="text-[11px] p-1 rounded border border-gray-200 bg-white cursor-pointer w-full text-gray-700">
                                        {availPeriods.map(p => (
                                          <option key={p} value={p}>{p}</option>
                                        ))}
                                      </select>
                                    )}
                                  </td>
                                  {/* 케어십형태 */}
                                  <td className="text-center p-2">
                                    {opts.careTypes.length <= 1 ? (
                                      <span className="text-[11px] text-gray-500">{opts.careTypes[0] || '-'}</span>
                                    ) : (
                                      <select value={sel.careType || opts.careTypes[0]}
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
                                      <span className="text-[11px] text-gray-700">{opts.careGrades[0] || '-'}</span>
                                    ) : (
                                      <select value={sel.careGrade || opts.careGrades[0]}
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
                                      <span className="text-[11px] text-gray-700">{opts.visitCycles[0] || '-'}</span>
                                    ) : (
                                      <select value={sel.visitCycle || opts.visitCycles[0]}
                                        onChange={e => { e.stopPropagation(); updateSelection(group.model, 'visitCycle', e.target.value); }}
                                        onClick={e => e.stopPropagation()}
                                        className="text-[11px] p-1 rounded border border-gray-200 bg-white cursor-pointer w-full text-gray-700">
                                        {opts.visitCycles.map(vc => <option key={vc} value={vc}>{vc}</option>)}
                                      </select>
                                    )}
                                  </td>
                                  {/* 가격 컬럼들 */}
                                  <td className="text-center p-2 font-semibold text-gray-800">{formatNumber(calc.basePrice)}</td>
                                  <td className="text-center p-2 font-semibold" style={{
                                    color: !activationOn ? '#ccc' : calc.activation > 0 ? '#E67E22' : '#ccc',
                                    fontWeight: !activationOn ? 400 : calc.activation > 0 ? 700 : 400,
                                    textDecoration: !activationOn && calc.activation > 0 ? 'line-through' : 'none',
                                  }}>{formatNumber(calc.activation)}</td>
                                  <td className="text-center p-2 font-bold text-blue-600">{formatNumber(calc.discountAmount)}</td>
                                  <td className="text-center p-2">
                                    <span className="font-extrabold text-[#A50034] text-sm">{formatNumber(calc.discountPrice)}</span>
                                    <div className="text-[9px] text-gray-400 mt-0.5">일 {formatNumber(calc.dailyPrice)}원</div>
                                  </td>
                                </tr>
                              );
                            })}
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
    </div>
  );
}

// ==========================================
// 하위 컴포넌트
// ==========================================
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl p-3.5 shadow-sm">
      <div className="text-[11px] font-bold text-[#A50034] uppercase tracking-wider mb-2.5">{title}</div>
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
        padding: '5px 14px',
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
