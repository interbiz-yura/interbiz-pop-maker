// ==============================================
// price-compare.ts
// 두 시점의 가격표를 비교하여 변동 내역을 반환
// ==============================================

export type ChangeStatus = 'new' | 'deleted' | 'up' | 'down';

export interface PriceChangeItem {
  model: string;
  category: string;
  careType: string;
  careGrade: string;
  visitCycle: string;
  status: ChangeStatus;
  prevPrice: number;
  currPrice: number;
  diff: number;
  period: string;
}

export interface ModelChangeInfo {
  model: string;
  category: string;
  /** 모델의 대표 상태 (우선순위: new > down > up > deleted) */
  mainStatus: ChangeStatus;
  items: PriceChangeItem[];
  summary: {
    newCount: number;
    deletedCount: number;
    upCount: number;
    downCount: number;
  };
  /** 대표 변동액 (인하/인상 시 가장 큰 변동) */
  mainDiff: number;
  mainPrevPrice: number;
  mainCurrPrice: number;
}

export interface CompareResult {
  /** 모델별 변동 정보 */
  modelChanges: Map<string, ModelChangeInfo>;
  /** 변동된 모델명 Set (신규/인하/인상/삭제 모두 포함) */
  changedModels: Set<string>;
  /** 상태별 모델명 Set */
  newModels: Set<string>;
  deletedModels: Set<string>;
  priceUpModels: Set<string>;
  priceDownModels: Set<string>;
  summary: {
    totalChanges: number;
    newCount: number;
    deletedCount: number;
    upCount: number;
    downCount: number;
  };
}

interface RawRow {
  model: string;
  category: string;
  careType: string;
  careGrade: string;
  visitCycle: string;
  y3base: number;
  y4base: number;
  y5base: number;
  y6base: number;
}

// 엑셀 파싱 (비교 전용)
export async function parseExcelForCompare(url: string, sheetName: string): Promise<RawRow[]> {
  const XLSX = await import('xlsx');
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];

  const rows: RawRow[] = [];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  for (let r = 4; r <= range.e.r; r++) {
    const cell = (c: number) => ws[XLSX.utils.encode_cell({ r, c })]?.v;
    const model = cell(4);
    if (!model) continue;

    const num = (c: number) => {
      const v = cell(c);
      return typeof v === 'number' ? v : (parseInt(String(v)) || 0);
    };
    const str = (c: number) => {
      const v = cell(c);
      return v != null ? String(v).trim() : '';
    };

    rows.push({
      model: str(4),
      category: str(3),
      careType: str(6),
      careGrade: str(7),
      visitCycle: str(8),
      y3base: num(11),
      y4base: num(12),
      y5base: num(15),
      y6base: num(18),
    });
  }
  return rows;
}

// 신규 양식 엑셀 파싱 (비교 전용, Master_*.xlsx)
export async function parseNewExcelForCompare(url: string, sheetName: string): Promise<RawRow[]> {
  const XLSX = await import('xlsx');
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const cell = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })]?.v;
  const num = (r: number, c: number) => { const v = cell(r, c); return typeof v === 'number' ? v : (parseInt(String(v)) || 0); };
  const str = (r: number, c: number) => { const v = cell(r, c); return v != null ? String(v).trim() : ''; };

  interface Entry { model: string; category: string; careType: string; careGrade: string; visitCycle: string; period: number; comboType: string; finalPrice: number; }
  const entries: Entry[] = [];
  for (let r = 1; r <= range.e.r; r++) {
    const model = str(r, 1);
    if (!model) continue;
    entries.push({
      model, category: str(r, 0), careType: str(r, 2), careGrade: str(r, 3), visitCycle: str(r, 4),
      period: num(r, 5), comboType: str(r, 6), finalPrice: num(r, 11),
    });
  }

  // 같은 (모델명+케어십형태+케어십구분+방문주기)로 그룹핑
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = `${e.model}|${e.careType}|${e.careGrade}|${e.visitCycle}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const rows: RawRow[] = [];
  groups.forEach((group) => {
    const first = group[0];
    const find = (period: number, combo: string) => group.find((e: Entry) => e.period === period && e.comboType === combo);
    rows.push({
      model: first.model, category: first.category,
      careType: first.careType, careGrade: first.careGrade, visitCycle: first.visitCycle,
      y3base: find(36, '결합없음')?.finalPrice || 0,
      y4base: find(48, '결합없음')?.finalPrice || 0,
      y5base: find(60, '결합없음')?.finalPrice || 0,
      y6base: find(72, '결합없음')?.finalPrice || 0,
    });
  });
  return rows;
}

// 행의 고유 키 생성
function rowKey(row: RawRow): string {
  return `${row.model}|${row.careType}|${row.careGrade}|${row.visitCycle}`;
}

function getBestPrice(row: RawRow): { price: number; period: string } {
  if (row.y6base > 0) return { price: row.y6base, period: '6년' };
  if (row.y5base > 0) return { price: row.y5base, period: '5년' };
  if (row.y4base > 0) return { price: row.y4base, period: '4년' };
  if (row.y3base > 0) return { price: row.y3base, period: '3년' };
  return { price: 0, period: '-' };
}

// 두 가격표 비교
export function comparePriceData(prevRows: RawRow[], currRows: RawRow[]): CompareResult {
  const prevMap = new Map<string, RawRow>();
  for (const row of prevRows) {
    const key = rowKey(row);
    if (!prevMap.has(key)) prevMap.set(key, row);
  }

  const currMap = new Map<string, RawRow>();
  for (const row of currRows) {
    const key = rowKey(row);
    if (!currMap.has(key)) currMap.set(key, row);
  }

  const changes: PriceChangeItem[] = [];

  // 현재에만 있는 것 → 신규
  for (const [key, curr] of Array.from(currMap.entries())) {
    if (!prevMap.has(key)) {
      const best = getBestPrice(curr);
      if (best.price > 0) {
        changes.push({
          model: curr.model, category: curr.category,
          careType: curr.careType, careGrade: curr.careGrade, visitCycle: curr.visitCycle,
          status: 'new', prevPrice: 0, currPrice: best.price, diff: best.price, period: best.period,
        });
      }
    }
  }

  // 이전에만 있던 것 → 삭제
  for (const [key, prev] of Array.from(prevMap.entries())) {
    if (!currMap.has(key)) {
      const best = getBestPrice(prev);
      if (best.price > 0) {
        changes.push({
          model: prev.model, category: prev.category,
          careType: prev.careType, careGrade: prev.careGrade, visitCycle: prev.visitCycle,
          status: 'deleted', prevPrice: best.price, currPrice: 0, diff: -best.price, period: best.period,
        });
      }
    }
  }

  // 둘 다 있는 것 → 가격 비교
  for (const [key, curr] of Array.from(currMap.entries())) {
    const prev = prevMap.get(key);
    if (!prev) continue;

    const periods = [
      { period: '6년', prevP: prev.y6base, currP: curr.y6base },
      { period: '5년', prevP: prev.y5base, currP: curr.y5base },
      { period: '4년', prevP: prev.y4base, currP: curr.y4base },
      { period: '3년', prevP: prev.y3base, currP: curr.y3base },
    ];

    for (const p of periods) {
      if (p.prevP > 0 && p.currP > 0 && p.prevP !== p.currP) {
        changes.push({
          model: curr.model, category: curr.category,
          careType: curr.careType, careGrade: curr.careGrade, visitCycle: curr.visitCycle,
          status: p.currP < p.prevP ? 'down' : 'up',
          prevPrice: p.prevP, currPrice: p.currP, diff: p.currP - p.prevP, period: p.period,
        });
      }
    }
  }

  // 모델별 그룹핑
  const modelItemsMap = new Map<string, PriceChangeItem[]>();
  for (const item of changes) {
    if (!modelItemsMap.has(item.model)) modelItemsMap.set(item.model, []);
    modelItemsMap.get(item.model)!.push(item);
  }

  const modelChanges = new Map<string, ModelChangeInfo>();
  const newModels = new Set<string>();
  const deletedModels = new Set<string>();
  const priceUpModels = new Set<string>();
  const priceDownModels = new Set<string>();

  for (const [model, items] of Array.from(modelItemsMap.entries())) {
    const summary = {
      newCount: items.filter(i => i.status === 'new').length,
      deletedCount: items.filter(i => i.status === 'deleted').length,
      upCount: items.filter(i => i.status === 'up').length,
      downCount: items.filter(i => i.status === 'down').length,
    };

    // 대표 상태 결정
    let mainStatus: ChangeStatus = 'new';
    if (summary.newCount > 0) mainStatus = 'new';
    else if (summary.downCount > 0) mainStatus = 'down';
    else if (summary.upCount > 0) mainStatus = 'up';
    else if (summary.deletedCount > 0) mainStatus = 'deleted';

    // 대표 변동액 (가장 큰 변동)
    let mainDiff = 0, mainPrevPrice = 0, mainCurrPrice = 0;
    const priceItems = items.filter(i => i.status === 'down' || i.status === 'up');
    if (priceItems.length > 0) {
      const maxItem = priceItems.reduce((a, b) => Math.abs(a.diff) > Math.abs(b.diff) ? a : b);
      mainDiff = maxItem.diff;
      mainPrevPrice = maxItem.prevPrice;
      mainCurrPrice = maxItem.currPrice;
    }

    // Set에 추가
    if (summary.newCount > 0) newModels.add(model);
    if (summary.deletedCount > 0) deletedModels.add(model);
    if (summary.upCount > 0) priceUpModels.add(model);
    if (summary.downCount > 0) priceDownModels.add(model);

    modelChanges.set(model, {
      model,
      category: items[0].category,
      mainStatus,
      items,
      summary,
      mainDiff,
      mainPrevPrice,
      mainCurrPrice,
    });
  }

  return {
    modelChanges,
    changedModels: new Set([...Array.from(newModels), ...Array.from(deletedModels), ...Array.from(priceUpModels), ...Array.from(priceDownModels)]),
    newModels,
    deletedModels,
    priceUpModels,
    priceDownModels,
    summary: {
      totalChanges: modelChanges.size,
      newCount: newModels.size,
      deletedCount: deletedModels.size,
      upCount: priceUpModels.size,
      downCount: priceDownModels.size,
    },
  };
}
