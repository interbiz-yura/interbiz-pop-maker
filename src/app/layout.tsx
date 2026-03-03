import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LG POP Maker',
  description: 'LG 구독 가격표 자동 생성기',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
