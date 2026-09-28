import {
  Fraunces,
  IBM_Plex_Mono,
  Inter,
  JetBrains_Mono,
  Source_Serif_4,
  Space_Grotesk,
} from 'next/font/google';

// The app's font families, declared ONCE for the two documents that own an
// `<html>` element: the root layout (`app/layout.tsx`) and the root error
// boundary (`app/global-error.tsx`), which REPLACES that layout when it throws
// and so has to bring its own fonts (MOTIR-6855 · design MOTIR-6854,
// `design/shell/design-notes.md` § The server-error page). Each family exposes a
// CSS variable that `app/globals.css` composes into `--font-sans` / `--font-serif`
// / …; without these classes on `<html>` the serif title falls back to Georgia.

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

// MOTIR-2505 — a FUNCTION, not `export const metadata`. The object carries
// `metadataBase`, which is read from the environment, and a static export is
// evaluated at module load — build time for a statically-rendered route, where
// `MOTIR_BASE_URL` is deliberately unset (the Dockerfile sets only the
// placeholders module-load checks need). That would freeze the localhost
// fallback into the output. See `lib/rootMetadata.ts` for the whole reasoning;
// the two exports are mutually exclusive, so this replaced the const.

/** Every family's variable class, for an `<html>` element's `className`. */
export const fontVariables = [
  inter.variable,
  sourceSerif.variable,
  jetbrainsMono.variable,
  ibmPlexMono.variable,
  spaceGrotesk.variable,
  fraunces.variable,
].join(' ');
