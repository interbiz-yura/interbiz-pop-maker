// ==============================================
// price-compare.ts
// 두 시점의 가격표를 비교하여 변동 내역을 반환
// ==============================================

export interface PriceChangeItem {
  model: string;
  category: string;
  careType: string;
  careGrade: string;
  visitCycle: string;
  status: 'new' | 'deleted' | 'up' | 'down';
  prevPrice: number;
  currPrice: number;
  diff: number;
  // 계약기간별 가격 (비교용)
  period: string;
}

export interface PriceChangeGroup {
  model: string;
  category: string;
  items: PriceChangeItem[];
  summary: {
    newCount: number;
    deletedCount: number;
    upCount: number;
    downCount: number;
  };
}

export interface CompareResult {
  groups: PriceChangeGroup[];
  summary: {
    totalChanges: number;
    newModels: number;
    deletedModels: number;
    priceUp: number;
    priceDown: number;
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

// 엑셀 파싱 (비교 전용 - 모든 행 유지, 중복 제거 안함)
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

// 행의 고유 키 생성 (모델 + 케어십형태 + 구분 + 방문주기)
function rowKey(row: RawRow): string {
  return `${row.model}|${row.careType}|${row.careGrade}|${row.visitCycle}`;
}

// 해당 행에서 가장 긴 계약기간의 가격
function getBestPrice(row: RawRow): { price: number; period: string } {
  if (row.y6base > 0) return { price: row.y6base, period: '6년' };
  if (row.y5base > 0) return { price: row.y5base, period: '5년' };
  if (row.y4base > 0) return { price: row.y4base, period: '4년' };
  if (row.y3base > 0) return { price: row.y3base, period: '3년' };
  return { price: 0, period: '-' };
}

// 두 가격표 비교
export function comparePriceData(prevRows: RawRow[], currRows: RawRow[]): CompareResult {
  // 1) 각 행을 키로 매핑
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

  // 2) 현재에만 있는 것 → 신규
  for (const [key, curr] of Array.from(currMap.entries())) {
    if (!prevMap.has(key)) {
      const best = getBestPrice(curr);
      if (best.price > 0) {
        changes.push({
          model: curr.model,
          category: curr.category,
          careType: curr.careType,
          careGrade: curr.careGrade,
          visitCycle: curr.visitCycle,
          status: 'new',
          prevPrice: 0,
          currPrice: best.price,
          diff: best.price,
          period: best.period,
        });
      }
    }
  }

  // 3) 이전에만 있던 것 → 삭제
  for (const [key, prev] of Array.from(prevMap.entries())) {
    if (!currMap.has(key)) {
      const best = getBestPrice(prev);
      if (best.price > 0) {
        changes.push({
          model: prev.model,
          category: prev.category,
          careType: prev.careType,
          careGrade: prev.careGrade,
          visitCycle: prev.visitCycle,
          status: 'deleted',
          prevPrice: best.price,
          currPrice: 0,
          diff: -best.price,
          period: best.period,
        });
      }
    }
  }

  // 4) 둘 다 있는 것 → 가격 비교
  for (const [key, curr] of Array.from(currMap.entries())) {
    const prev = prevMap.get(key);
    if (!prev) continue;

    // 각 계약기간별 비교
    const periods: { period: string; prevP: number; currP: number }[] = [
      { period: '6년', prevP: prev.y6base, currP: curr.y6base },
      { period: '5년', prevP: prev.y5base, currP: curr.y5base },
      { period: '4년', prevP: prev.y4base, currP: curr.y4base },
      { period: '3년', prevP: prev.y3base, currP: curr.y3base },
    ];

    for (const p of periods) {
      if (p.prevP > 0 && p.currP > 0 && p.prevP !== p.currP) {
        changes.push({
          model: curr.model,
          category: curr.category,
          careType: curr.careType,
          careGrade: curr.careGrade,
          visitCycle: curr.visitCycle,
          status: p.currP < p.prevP ? 'down' : 'up',
          prevPrice: p.prevP,
          currPrice: p.currP,
          diff: p.currP - p.prevP,
          period: p.period,
        });
      }
    }
  }

  // 5) 모델별 그룹핑
  const groupMap = new Map<string, PriceChangeItem[]>();
  for (const item of changes) {
    if (!groupMap.has(item.model)) groupMap.set(item.model, []);
    groupMap.get(item.model)!.push(item);
  }

  const groups: PriceChangeGroup[] = [];
  for (const [model, items] of Array.from(groupMap.entries())) {
    groups.push({
      model,
      category: items[0].category,
      items,
      summary: {
        newCount: items.filter(i => i.status === 'new').length,
        deletedCount: items.filter(i => i.status === 'deleted').length,
        upCount: items.filter(i => i.status === 'up').length,
        downCount: items.filter(i => i.status === 'down').length,
      },
    });
  }

  // 카테고리 → 모델명 순 정렬
  groups.sort((a, b) => a.category.localeCompare(b.category) || a.model.localeCompare(b.model));

  // 전체 요약 (모델 단위)
  const modelStatuses = new Map<string, Set<string>>();
  for (const item of changes) {
    if (!modelStatuses.has(item.model)) modelStatuses.set(item.model, new Set());
    modelStatuses.get(item.model)!.add(item.status);
  }

  let newModels = 0, deletedModels = 0, priceUp = 0, priceDown = 0;
  for (const [, statuses] of Array.from(modelStatuses.entries())) {
    if (statuses.has('new')) newModels++;
    if (statuses.has('deleted')) deletedModels++;
    if (statuses.has('up')) priceUp++;
    if (statuses.has('down')) priceDown++;
  }

  return {
    groups,
    summary: {
      totalChanges: changes.length,
      newModels,
      deletedModels,
      priceUp,
      priceDown,
    },
  };
}
