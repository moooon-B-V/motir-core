import type { Metadata } from 'next';
import { Fraunces, Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemeProvider } from '@/lib/contexts/theme-context';
import { themeInitScript } from '@/lib/theme/init-script';
import { ToastProvider } from '@/components/ui/Toast';
import { localeDir, type Locale } from '@/lib/i18n/locales';
import './globals.css';

/**
 * The base variable fonts loaded via Next.js's self-hosting font loader.
 *
 * Each font gets a CSS variable that the @theme block in globals.css picks
 * up and exposes as Tailwind utility classes (font-sans, font-serif,
 * font-mono). A fourth face (Fraunces) is loaded below for the `editorial`
 * type pairing.
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

/**
 * Fraunces — the display serif for the `editorial` type pairing (Subtask
 * 7.3.55). It is the only NEW face beyond the three base loads above; the
 * `editorial` pairing re-points the `--font-serif` headline role at it in the
 * `html[data-type='editorial']` block in globals.css, while body (Inter) and
 * mono (JetBrains) keep the base roles. Loaded as the variable font (optical
 * sizing for display) so it only pays its weight when a user picks Editorial.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-editorial-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Motir',
  description: 'AI-native project management — open-source PM substrate.',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Locale comes from the NEXT_LOCALE cookie (resolved in i18n/request.ts), so
  // <html lang/dir> is correct on the first byte — no client flash. (The theme
  // attributes still need the FOUC script below because they live in
  // localStorage, which the server can't read; the locale does not.)
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      dir={localeDir[locale]}
      className={`${inter.variable} ${sourceSerif.variable} ${jetbrainsMono.variable} ${fraunces.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/*
          FOUC prevention: run before React hydrates to apply the user's
          saved theme + style to <html>. Without this the page
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
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <ToastProvider>{children}</ToastProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
