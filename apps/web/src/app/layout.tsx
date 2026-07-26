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
  // Arayuz tek temada (koyu zumrut) calisir; mobil tarayici cubugu da ayni
  // zemini alir, boylece sayfa kenarinda renk kirilmasi olusmaz.
  themeColor: '#05130e',
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
