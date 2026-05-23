import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import { ThemeProvider } from '@/lib/contexts/theme-context';
import { themeInitScript } from '@/lib/theme/init-script';
import { ToastProvider } from '@/components/ui/Toast';
import './globals.css';

/**
 * Three variable fonts loaded via Next.js's self-hosting font loader.
 *
 * Each font gets a CSS variable that the @theme block in globals.css picks
 * up and exposes as Tailwind utility classes (font-sans, font-serif,
 * font-mono).
 *
 * `display: 'swap'` shows fallback fonts immediately and swaps to the real
 * font when loaded. The visible reflow on swap is small because next/font
 * generates a metric-matched fallback face automatically.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Prodect',
  description: 'AI-native project management — open-source PM substrate.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${sourceSerif.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/*
          FOUC prevention: run before React hydrates to apply the user's
          saved theme + display-style to <html>. Without this the page
          briefly flashes the SSR default before the client applies
          localStorage preferences.

          Safety: `themeInitScript` is a static, compile-time string in
          lib/theme/init-script.ts — no user input flows into it. This is
          the standard theme-init pattern (see next-themes, shadcn/ui,
          dooooWeb) and is XSS-safe because the script content is fixed.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full">
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
