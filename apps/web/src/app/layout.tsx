import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SessionProvider } from '../lib/session-context';

export const metadata: Metadata = {
  title: 'ToptanPortal',
  description: 'HoReCa B2B sipariş ve cari hesap portalı',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1115' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
