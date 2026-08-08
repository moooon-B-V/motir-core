import type { Metadata } from 'next';
import {
  Fraunces,
  IBM_Plex_Mono,
  Inter,
  JetBrains_Mono,
  Source_Serif_4,
  Space_Grotesk,
} from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemeProvider } from '@/lib/contexts/theme-context';
import { buildThemeInitScript } from '@/lib/theme/init-script';
// ⚠️ THE TWO IMPORTS BELOW PUT A PRISMA CLIENT IN EVERY ROUTE IN THE PRODUCT.
// They are deliberate and load-bearing; the reasoning is the "Why the database
// reach cannot move down" block above RootLayout. Do not add a third without
// reading it — `tests/root-layout-db-imports.test.ts` will stop you.
import { getSession } from '@/lib/auth';
import { appearancePreferenceService } from '@/lib/services/appearancePreferenceService';
import type { AppliedAppearanceDto } from '@/lib/dto/appearancePreference';
import { ImmersiveTilt } from '@/components/theme/ImmersiveTilt';
import { HandDrawnFilter } from '@/components/theme/HandDrawnFilter';
import { ToastProvider } from '@/components/ui/Toast';
import { localeDir, type Locale } from '@/lib/i18n/locales';
import './globals.css';

/**
 * Variable fonts loaded via Next.js's self-hosting font loader.
 *
 * Each font is exposed as a `--font-*-SOURCE` CSS variable — the RAW face. The
 * @theme block in globals.css composes the role token off it
 * (`--font-sans: var(--font-sans-source, <system fallbacks>)`) and the
 * `[data-type]` axis blocks re-point a role at a different `-source` var. This
 * indirection is what the type axis (7.3.53) requires: a pairing's
 * `[data-type='…']` block swaps which `-source` face a role wears, so the role
 * token must read `var(--font-*-source, …)`, never the loader variable directly.
 * (The loader variable name MUST therefore be the `-source` one — naming it the
 * bare role token leaves every `var(--font-*-source)` reference unresolved and
 * the whole UI silently falls back to system faces.)
 *
 * `display: 'swap'` shows fallback fonts immediately and swaps to the real
 * font when loaded. The visible reflow on swap is small because next/font
 * generates a metric-matched fallback face automatically.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans-source',
  display: 'swap',
});

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif-source',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono-source',
  display: 'swap',
});

// Mono-Technical type pairing (7.3.56) — IBM Plex Mono dresses the headline +
// meta/code roles; the Inter body is reused (one new face). Loaded here as its
// own `-source` var so the `[data-type='mono-technical']` block can point the
// `--font-serif` / `--font-mono` roles at it.
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono-technical-source',
  display: 'swap',
});

// The Grotesk type pairing's display face (Subtask 7.3.54). Not a base role —
// it feeds ONLY the `[data-type='grotesk']` headline override in globals.css
// via `--font-grotesk-source`; the base roles stay Inter / Source Serif / mono
// when the pairing is not selected, so this adds payload only for that pairing.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-grotesk-source',
  display: 'swap',
});

// The Editorial type pairing's display serif (Subtask 7.3.55) — Fraunces. Not a
// base role: it feeds ONLY the `[data-type='editorial']` headline override in
// globals.css via `--font-editorial-source`, re-pointing the `--font-serif` role
// while body (Inter) and meta (JetBrains) keep the base roles. Loaded as the
// variable font (optical sizing for display) so it only pays its weight when a
// user picks Editorial.
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-editorial-source',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Motir',
  description: 'AI-native project management — open-source PM substrate.',
};

/**
 * ── Why the database reach cannot move down (MOTIR-2381) ────────────────────
 *
 * This layout is in EVERY route's module graph, so everything it imports is
 * traced into every server function Next builds. Measured on `.next/**\/*.nft.json`
 * with `scripts/measure-prisma-traces.mjs`: **340 of 348 traced functions carry
 * `@prisma/client`** — a 404, the `/tokens` specimen and the published docs tree
 * among them. And `lib/db.ts` builds its `PrismaClient` at MODULE scope (throwing
 * when `DATABASE_URL` is unset), so those routes do not merely *ship* a database
 * client: they *instantiate* one. That is a blast-radius fact, not a size one,
 * and it is why the question below was asked at all.
 *
 * The question was whether `getSession` + `appearancePreferenceService` could sit
 * in `(authed)/layout.tsx` instead. **They cannot**, and the reason is scope, not
 * taste: the appearance is applied to the `<html>` element and to the pre-paint
 * `<head>` script, and a nested layout can render neither. So there is no "move"
 * available — only *keep*, or *drop 7.3.61's cross-device no-flash guarantee for
 * the whole app*, including the authed shell, which is the surface it exists for.
 *
 * MEASURED CEILING, so the trade is a number rather than an opinion. Deleting
 * both imports takes 340 → **330**: the landing page, the four `(auth)` screens,
 * `_not-found`, and the four `/tokens` routes. Ten functions, bought by removing
 * a shipped feature from every route. Not worth it.
 *
 * Two things this rules out, so nobody re-derives them:
 *
 * - **`outputFileTracingExcludes` cannot paper over it.** Next 16 builds with
 *   Turbopack, and `build/index.js` guards `collect-build-traces.js` with
 *   `bundler !== Bundler.Turbopack`, so both tracing keys are inert (MOTIR-2403).
 *   It would be a lie regardless: the layout genuinely calls the DB.
 * - **A lighter session probe exists but does not help.** `getSessionCookie`
 *   (`better-auth/cookies`, already used by `proxy.ts`) answers "is someone signed
 *   in" with no Prisma — enough for `ThemeProvider`'s `signedIn`, and nothing
 *   else. `applied` is keyed by user id, which needs a *validated* session.
 *
 * ⚠️ AND THE ROOT LAYOUT IS NOT THE ONLY CARRIER. With both imports removed the
 * public docs tree STILL traces `@prisma/client`, because
 * `app/(public)/docs/layout.tsx` reads `projectTagsService.listCategories()` for
 * up to six footer topic links. That one is independent of this file — MOTIR-2452.
 */
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

  // Cross-device appearance (Subtask 7.3.61): for a signed-in user the SERVER
  // preference is authoritative — it followed them to this device. Resolve it
  // here so the user's real appearance applies on the FIRST byte on any device,
  // with no flash and no client round-trip. Anonymous visitors keep the
  // localStorage-only path (`applied === null`).
  const session = await getSession();
  const applied: AppliedAppearanceDto | null = session
    ? await appearancePreferenceService.getApplied(session.user.id)
    : null;

  // The fully server-resolvable axes render directly on <html> so they paint on
  // the first byte. `data-theme` is the exception: an explicit `light`/`dark` is
  // server-set, but `system` only resolves via matchMedia on the client, so it
  // is left to the init script (same for every anonymous visitor).
  const serverThemeAttrs: Record<string, string> = applied
    ? {
        'data-style': applied.styleId,
        'data-palette': applied.paletteId,
        'data-type': applied.typeId,
        ...(applied.pattern !== 'system' ? { 'data-theme': applied.pattern } : {}),
      }
    : {};

  return (
    <html
      lang={locale}
      dir={localeDir[locale]}
      className={`${inter.variable} ${sourceSerif.variable} ${jetbrainsMono.variable} ${ibmPlexMono.variable} ${spaceGrotesk.variable} ${fraunces.variable} h-full antialiased`}
      suppressHydrationWarning
      {...serverThemeAttrs}
    >
      <head>
        {/*
          FOUC prevention: run before React hydrates to apply the user's
          appearance to <html>. For a signed-in user the server preference is
          embedded (it wins over localStorage and reconciles it); for an
          anonymous visitor it reads localStorage. Without this the page
          briefly flashes the default before the client applies preferences.

          Safety: the only per-request data is the user's APPLIED preference,
          whose fields are closed-enum registry ids / `system|light|dark` / a
          boolean — never free user input — and it is JSON-embedded with `<`
          escaped (see buildThemeInitScript). The rest is a static, compile-time
          string. This is the standard theme-init pattern (next-themes,
          shadcn/ui, dooooWeb).
        */}
        <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript(applied) }} />
      </head>
      <body className="min-h-full">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider initialPreference={applied} signedIn={Boolean(session)}>
            {/* Pointer-parallax engine for the 3D / Immersive style — inert for
                every other style and under reduced motion (7.3.39). */}
            <ImmersiveTilt />
            {/* Hidden SVG roughen filter for the Hand-Drawn / Indie style —
                referenced by globals.css only under that style, inert otherwise
                (7.3.41). */}
            <HandDrawnFilter />
            <ToastProvider>{children}</ToastProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
