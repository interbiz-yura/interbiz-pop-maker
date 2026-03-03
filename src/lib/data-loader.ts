import { PriceRow, CardInfo, CareBenefit, QRMapping, Template } from './types';

let cachedPrice: PriceRow[] | null = null;
let cachedCards: CardInfo[] | null = null;
let cachedQR: QRMapping | null = null;
let cachedCare: CareBenefit[] | null = null;
const cachedTemplates: Record<string, Template> = {};

export async function loadPriceData(channel: string = 'emart'): Promise<PriceRow[]> {
  if (cachedPrice) return cachedPrice;
  const res = await fetch(`/data/price-${channel}.json`);
  cachedPrice = await res.json();
  return cachedPrice!;
}

export async function loadCards(): Promise<CardInfo[]> {
  if (cachedCards) return cachedCards;
  const res = await fetch('/data/cards.json');
  cachedCards = await res.json();
  return cachedCards!;
}

export async function loadQRMapping(): Promise<QRMapping> {
  if (cachedQR) return cachedQR;
  const res = await fetch('/data/qr-mapping.json');
  cachedQR = await res.json();
  return cachedQR!;
}

export async function loadCareBenefits(): Promise<CareBenefit[]> {
  if (cachedCare) return cachedCare;
  const res = await fetch('/data/care-benefits.json');
  cachedCare = await res.json();
  return cachedCare!;
}

export async function loadTemplate(fileName: string): Promise<Template> {
  if (cachedTemplates[fileName]) return cachedTemplates[fileName];
  const res = await fetch(`/data/templates/${fileName}`);
  const template = await res.json();
  cachedTemplates[fileName] = template;
  return template;
}

export function clearCache(): void {
  cachedPrice = null;
  cachedCards = null;
  cachedQR = null;
  cachedCare = null;
}
