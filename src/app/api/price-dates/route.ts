import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  const dataDir = path.join(process.cwd(), 'public', 'data');
  const files = fs.readdirSync(dataDir);

  const dates = files
    .filter(f => /^price_\d{6}\.xlsx$/.test(f))
    .map(f => f.match(/price_(\d{6})\.xlsx/)?.[1])
    .filter(Boolean)
    .sort();

  return NextResponse.json({ dates });
}