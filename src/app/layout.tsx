import type { Metadata } from 'next';
import Script from 'next/script';
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
      <body>
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-KZ9TVBW7HN" strategy="afterInteractive" />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-KZ9TVBW7HN');
          `}
        </Script>
        {children}
      </body>
    </html>
  );
}
