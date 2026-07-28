import type { Metadata, Viewport } from 'next';

import { Providers } from '@/components/providers';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Intoto ERP',
    template: '%s · Intoto ERP',
  },
  description: 'AI-powered ERP for Intoto — clothing wholesale and retail, India',
  applicationName: 'Intoto ERP',
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The POS runs on tablets at the counter; a pinch-zoom on mis-tap is disorienting
  // mid-sale, but capping at 5 keeps the page genuinely zoomable for accessibility.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f5fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0f' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        {/*
          Applies the saved theme before first paint. Without this the page renders
          light, then flips — a full-screen flash on every load for dark-mode users.
          It must be inline and synchronous to beat the first paint.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('intoto.theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
