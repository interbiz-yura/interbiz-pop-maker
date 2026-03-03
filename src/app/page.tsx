'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { loadCards, loadQRMapping, loadCareBenefits } from '@/lib/data-loader';
import {
  getPriorityValue, getCardDiscount, getUniqueCardNames, getUsagesByCard,
  formatNumber
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

  for (let r = 4; r <= range.e.r; r++) { // 5행부터 (0-indexed = 4)
    const model = ws[XLSX.utils.encode_cell({ r, c: 4 })]?.v; // E열
    if (!model) continue;

    const num = (c: number) => {
      const v = ws[XLSX.utils.encode_cell({ r, c })]?.v;
      return typeof v === 'number' ? v : (parseInt(String(v)) || 0);
    };
    const str = (c: number) => {
      const v = ws[XLSX.utils.encode_cell({ r, c })]?.v;
      return v != null ? String(v) : '';
    };

    rows.push({
      channel: str(0),
      category: str(3),        // D열
      model: str(4),           // E열
      listPrice: num(5),       // F열
      careType: str(6),        // G열
      careGrade: str(7),       // H열
      visitCycle: str(8),      // I열
      careKey: str(9),         // J열
      activation: num(10),     // K열
      y3base: num(11),         // L열 (3년)
      y4base: num(12),         // M열 (4년 기본)
      y4new: num(13),          // N열 (4년 신규)
      y4exist: num(14),        // O열 (4년 기존)
      y5base: num(15),         // P열 (5년 기본)
      y5new: num(16),          // Q열 (5년 신규)
      y5exist: num(17),        // R열 (5년 기존)
      y6base: num(18),         // S열 (6년 기본) ★
      y6new: num(19),          // T열 (6년 신규)
      y6exist: num(20),        // U열 (6년 기존)
      prepay30amount: num(21), // V열
      prepay30base: num(22),   // W열
      prepay30new: num(23),    // X열
      prepay30exist: num(24),  // Y열
      prepay50amount: num(25), // Z열
      prepay50base: num(26),   // AA열
      prepay50new: num(27),    // AB열
      prepay50exist: num(28),  // AC열
    });
  }
  return rows;
}

// ==========================================
// 카테고리 순서 (ㄱㄴㄷ)
// ==========================================
const CATEGORY_ORDER = [
  '가습기', '건조기', '김치냉장고', '냉장고', '로봇청소기',
  '세탁기', '스탠바이미', '식기세척기', '에어케어', '에어컨',
  '얼음정수기', '정수기', '청소기', 'TV'
];

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
      } catch (e) {
        setError('데이터를 불러오는데 실패했습니다.');
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    loadAll();
  }, [channel]);

  // ----- 카테고리별 모델 그룹핑 -----
  const categoryModels = useMemo(() => {
    const groups: Record<string, PriceRow[]> = {};
    const seenInCategory: Record<string, Set<string>> = {};

    for (const row of priceData) {
      const cat = row.category?.trim();
      if (!cat) continue;
      if (!groups[cat]) {
        groups[cat] = [];
        seenInCategory[cat] = new Set();
      }
      const model = row.model?.trim();
      if (!model || seenInCategory[cat].has(model)) continue;
      seenInCategory[cat].add(model);
      groups[cat].push(row);
    }

    // ㄱㄴㄷ 순서로 정렬
    const sorted: Record<string, PriceRow[]> = {};
    for (const cat of CATEGORY_ORDER) {
      if (groups[cat]) sorted[cat] = groups[cat];
    }
    for (const cat of Object.keys(groups).sort()) {
      if (!sorted[cat]) sorted[cat] = groups[cat];
    }
    return sorted;
  }, [priceData]);

  // ----- 카테고리 목록 -----
  const categories = useMemo(() => Object.keys(categoryModels), [categoryModels]);

  // ----- 활성화 제품 필터 -----
  const activationModels = useMemo(() => {
    const result: Record<string, PriceRow[]> = {};
    for (const [cat, models] of Object.entries(categoryModels)) {
      const filtered = models.filter(m => (m.activation || 0) > 0);
      if (filtered.length > 0) result[cat] = filtered;
    }
    return result;
  }, [categoryModels]);

  const activationCount = useMemo(
    () => Object.values(activationModels).flat().length,
    [activationModels]
  );

  // ----- 현재 필터에 맞는 데이터 -----
  const filteredData = useMemo(() => {
    if (activeCategory === '전체') return categoryModels;
    if (activeCategory === '활성화 제품') return activationModels;
    if (activeCategory === '변동 제품') return {};
    if (categoryModels[activeCategory]) {
      return { [activeCategory]: categoryModels[activeCategory] };
    }
    return {};
  }, [activeCategory, categoryModels, activationModels]);

  const visibleCategories = useMemo(() => Object.keys(filteredData), [filteredData]);
  const totalModels = useMemo(() => Object.values(categoryModels).flat().length, [categoryModels]);
  const filteredCount = useMemo(() => Object.values(filteredData).flat().length, [filteredData]);

  // ----- 가격 계산 -----
  const getCalculatedPrice = useCallback((row: PriceRow) => {
    const basePrice = getPriorityValue(row, activationOn);
    const { discountAmount } = getCardDiscount(cards, cardName, monthUsage);
    const discountPrice = Math.max(0, basePrice - discountAmount);
    const dailyPrice = discountPrice > 0 ? Math.round(discountPrice / 31) : 0;
    return { basePrice, discountAmount, discountPrice, dailyPrice };
  }, [activationOn, cards, cardName, monthUsage]);

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
    const models = filteredData[cat] || [];
    const allChecked = models.every(m => checkedModels.has(m.model));
    setCheckedModels(prev => {
      const next = new Set(prev);
      models.forEach(m => allChecked ? next.delete(m.model) : next.add(m.model));
      return next;
    });
  }, [filteredData, checkedModels]);

  const toggleAll = useCallback(() => {
    const allModels = Object.values(filteredData).flat();
    const allChecked = allModels.every(m => checkedModels.has(m.model));
    setCheckedModels(prev => {
      const next = new Set(prev);
      allModels.forEach(m => allChecked ? next.delete(m.model) : next.add(m.model));
      return next;
    });
  }, [filteredData, checkedModels]);

  // ----- 카드 변경 시 월실적 리셋 -----
  useEffect(() => {
    setMonthUsage('');
  }, [cardName]);

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
        <div className="max-w-[1440px] mx-auto flex gap-4">

          {/* ========== 좌측: 설정 패널 ========== */}
          <div className="w-[300px] shrink-0 flex flex-col gap-3">

            {/* 템플릿 선택 */}
            <Panel title="템플릿 선택">
              <select
                value={template.id}
                onChange={e => setTemplate(TEMPLATES.find(t => t.id === e.target.value) || TEMPLATES[0])}
                className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm font-semibold bg-[#FAFAF8] outline-none cursor-pointer"
              >
                {TEMPLATES.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Panel>

            {/* 미리보기 */}
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
                        const row = priceData.find(r => r.model === firstModel);
                        if (!row) return <div className="text-[8px] text-gray-400">-</div>;
                        const calc = getCalculatedPrice(row);
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

            {/* 제휴카드 */}
            <Panel title="제휴카드">
              <select
                value={cardName}
                onChange={e => setCardName(e.target.value)}
                className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer"
              >
                <option value="">카드 미선택 (기본 16,000원)</option>
                {uniqueCardNames.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              {cardName && usageList.length > 0 && (
                <select
                  value={monthUsage}
                  onChange={e => setMonthUsage(e.target.value)}
                  className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer mt-2"
                >
                  <option value="">월실적 선택...</option>
                  {usageList.map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              )}
            </Panel>

            {/* 옵션 */}
            <Panel title="옵션">
              <div className="flex flex-col gap-2.5">
                <ToggleRow
                  label="활성화 할인 적용"
                  desc="OFF 시 K열 금액 가산"
                  checked={activationOn}
                  onChange={() => setActivationOn(!activationOn)}
                />
                <div className="h-px bg-[#f0ece4]" />
                <ToggleRow
                  label="QR코드 포함"
                  desc="가격표에 QR코드 표시"
                  checked={qrOn}
                  onChange={() => setQrOn(!qrOn)}
                />
                <div className="h-px bg-[#f0ece4]" />
                <div>
                  <div className="text-sm font-semibold text-gray-700 mb-1.5">선납 할인</div>
                  <select
                    value={prepay}
                    onChange={e => setPrepay(e.target.value)}
                    className="w-full p-2 rounded-lg border border-[#e0dcd4] text-sm bg-[#FAFAF8] outline-none cursor-pointer"
                  >
                    <option value="없음">미선택</option>
                    <option value="30%">30% 선납</option>
                    <option value="50%">50% 선납</option>
                  </select>
                </div>
              </div>
            </Panel>

            {/* 생성 버튼 */}
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
          <div className="flex-1 flex flex-col">

            {/* 카테고리 필터 + 통계 */}
            <div className="bg-white rounded-t-xl p-4 pb-3 shadow-sm">
              {/* 카테고리 버튼 */}
              <div className="flex gap-1.5 flex-wrap mb-3">
                <CatButton label="전체" active={activeCategory === '전체'} onClick={() => setActiveCategory('전체')} />
                <CatButton label="활성화 제품" count={activationCount} active={activeCategory === '활성화 제품'} color="#E67E22" bgTint="#FFF8F0" onClick={() => setActiveCategory('활성화 제품')} />
                <CatButton label="변동 제품" count={0} active={activeCategory === '변동 제품'} color="#8E24AA" bgTint="#F9F0FF" onClick={() => setActiveCategory('변동 제품')} />
                <div className="w-px h-6 bg-gray-200 self-center mx-1" />
                {categories.map(cat => (
                  <CatButton key={cat} label={cat} active={activeCategory === cat} onClick={() => setActiveCategory(cat)} />
                ))}
              </div>

              {/* 통계 바 */}
              <div className="flex justify-between items-center pt-2.5 border-t border-gray-100">
                <div className="flex gap-4 items-center">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Object.values(filteredData).flat().every(m => checkedModels.has(m.model)) && filteredCount > 0}
                      onChange={toggleAll}
                      className="w-4 h-4 accent-[#A50034]"
                    />
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
            <div className="bg-white rounded-b-xl px-5 pb-5 flex-1 shadow-sm">
              {visibleCategories.length === 0 ? (
                <div className="py-10 text-center text-gray-300 text-sm">
                  {activeCategory === '변동 제품'
                    ? '이전 가격표를 업로드하면 변동 제품을 확인할 수 있습니다.'
                    : '해당 카테고리에 모델이 없습니다'}
                </div>
              ) : (
                visibleCategories.map(cat => {
                  const catModels = filteredData[cat];
                  return (
                    <div key={cat} className="mt-4">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-[3px] h-[18px] bg-[#A50034] rounded-sm" />
                        <span className="text-base font-extrabold text-gray-900">{cat}</span>
                        <span className="text-xs text-gray-300">({catModels.length}개)</span>
                        <div className="flex-1" />
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={catModels.every(m => checkedModels.has(m.model))}
                            onChange={() => toggleCatAll(cat)}
                            className="w-3.5 h-3.5 accent-[#A50034]"
                          />
                          <span className="text-[11px] text-gray-400">전체선택</span>
                        </label>
                      </div>

                      <div className="rounded-xl overflow-hidden border border-gray-100">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="bg-[#FAF8F5]">
                              <th className="w-9 p-2.5 border-b-2 border-[#A50034]" />
                              <th className="p-2.5 text-left text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">모델명</th>
                              <th className="w-[76px] p-2.5 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">정상구독료</th>
                              <th className="w-[60px] p-2.5 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">활성화</th>
                              <th className="w-[66px] p-2.5 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">카드혜택</th>
                              <th className="w-[80px] p-2.5 text-center text-[11px] font-bold text-gray-400 border-b-2 border-[#A50034]">월구독료</th>
                            </tr>
                          </thead>
                          <tbody>
                            {catModels.map((row) => {
                              const checked = checkedModels.has(row.model);
                              const calc = getCalculatedPrice(row);
                              return (
                                <tr
                                  key={row.model}
                                  className="border-t border-gray-50 cursor-pointer transition-all"
                                  style={{ background: checked ? '#fff' : '#fafafa', opacity: checked ? 1 : 0.5 }}
                                  onClick={() => toggleModel(row.model)}
                                >
                                  <td className="text-center p-2.5">
                                    <input type="checkbox" checked={checked} onChange={() => {}} className="w-4 h-4 accent-[#A50034] cursor-pointer" />
                                  </td>
                                  <td className="p-2.5 font-bold text-[11px] text-gray-700 tracking-tight" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
                                    {row.model}
                                  </td>
                                  <td className="text-center p-2.5 font-semibold text-gray-500">{formatNumber(calc.basePrice)}</td>
                                  <td className="text-center p-2.5 font-semibold" style={{
                                    color: (row.activation || 0) > 0 ? '#E67E22' : '#ccc',
                                    textDecoration: (row.activation || 0) === 0 ? 'line-through' : 'none',
                                  }}>{formatNumber(row.activation || 0)}</td>
                                  <td className="text-center p-2.5 font-bold text-blue-600">{formatNumber(calc.discountAmount)}</td>
                                  <td className="text-center p-2.5">
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
      <div
        onClick={onChange}
        className="w-10 h-[22px] rounded-full relative cursor-pointer transition-colors shrink-0"
        style={{ background: checked ? '#A50034' : '#ddd' }}
      >
        <div
          className="w-[18px] h-[18px] rounded-full bg-white absolute top-[2px] transition-transform"
          style={{
            transform: checked ? 'translateX(20px)' : 'translateX(2px)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          }}
        />
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
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-xs rounded-full border transition-all cursor-pointer"
      style={{
        padding: '5px 14px',
        background: active ? activeColor : (isSpecial ? bgTint : '#fff'),
        color: active ? '#fff' : (isSpecial ? activeColor : '#777'),
        borderColor: active ? activeColor : (isSpecial ? activeColor + '44' : '#e5e5e5'),
        fontWeight: active ? 700 : 500,
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className="text-[10px] font-bold min-w-[18px] h-[18px] rounded-full inline-flex items-center justify-center"
          style={{
            background: active ? 'rgba(255,255,255,0.3)' : activeColor + '22',
            color: active ? '#fff' : activeColor,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}
