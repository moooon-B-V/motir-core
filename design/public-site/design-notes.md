# motir.co — one public chrome for the landing, /explore, /docs and /legal (`public-site.*`)

**Subtask:** MOTIR-3880 · 8.x (`type: design`) · **Story:** MOTIR-3932 (motir.co renders the public
reading surface) · **Epic 8 · Launch readiness.** **Repository: `motir-core`.**

`motir.co` is about to serve four surfaces that today wear **two different chromes on two different
hosts**, and neither knows about the other. This asset draws the **one** header, nav and footer all
four wear once /explore, /docs and /legal move onto the brand host.

**Asset files (three):** this `design-notes.md` (the AREA's note) · `public-site.mock.html` (the
source of truth — standalone, re-stating the shipped `--el-*` values so it paints without a Tailwind
build, exactly as every other motir-core design asset does) · `public-site.png` (full-page Playwright
chromium export, `deviceScaleFactor: 2`, light theme, re-exported with
`node scripts/render-design-mock.mjs --width 1440 design/public-site/public-site.mock.html`).

---

## The surface table

| surface                             | chrome today                           | where                               | chrome after this asset       |
| ----------------------------------- | -------------------------------------- | ----------------------------------- | ----------------------------- |
| the landing                         | `SiteHeader` / `SiteFooter`            | `motir-marketing/app/_components/`  | this asset's one bar + footer |
| `/explore`, `/explore/topic/[slug]` | `ExploreTopBar` / `ExploreFooter`      | `app/(public)/explore/_components/` | the same one bar + footer     |
| `/docs`                             | `ExploreTopBar` with `current="docs"`  | same                                | the same one bar + footer     |
| `/legal`                            | `ExploreTopBar` with `current="legal"` | `app/(public)/legal/`               | the same one bar + footer     |

## What the move makes newly drawable — and this is the point of the card

`ExploreTopBar` renders **Product** and **Pricing** as non-interactive `<span>` labels, with a comment
explaining why: _"Product / Pricing are future marketing pages, so they render as non-interactive
LABELS rather than dead links a crawler would 404 on."_ Its brand mark links to `/`, which on the
application host is `app/page.tsx` — a redirect to sign-in. On `motir.co` that link reaches the
landing, so **the brand lockup becomes a real home link and the nav gains its first genuine sibling
set** — Explore and Docs stop being cross-origin hand-offs and become same-origin links.

---

## The ONE chrome, decided

### The nav

The bar is `SiteHeader`'s structure (the `ExploreTopBar` pattern: `--el-surface-soft` fill, an
`--el-border` bottom hairline, the `py-3` rhythm — mirrored as `padding: 12px 24px`), carrying:

1. **Brand lockup → `/`** — `BrandMark` at 26px, the §7c proportions (`design/brand/design-notes.md`).
   The only internal link on the landing; on the reading surfaces it is the real home link.
2. **Explore → `/explore`** — now a **same-origin** link (was `${APP_ORIGIN}/explore`).
3. **Docs → `/docs`** — now a **same-origin** link (was `${APP_ORIGIN}/docs`).
4. **Design → the Design showcase** — the site's existing internal second route, kept exactly as
   `SiteHeader` ships it. Its address lives in `motir-marketing`, not in this repo, so it is the one
   nav address this asset cites that the design-address guard cannot resolve here (see the KNOWN row
   in `tests/design-asset-addresses.test.ts`).
5. **Product · Pricing — placeholders.** Drawn as a `<span>` (visibly not a link), below.
6. **Right: Sign in (ghost) · Start free (primary).** The **only deliberate cross-host links** — they
   carry the visitor INTO `app.motir.co` and must read as leaving (full URLs, never same-origin).

### The placeholder treatment — and the promotion rule

A placeholder is a `<span>` at `--el-text-secondary` (the same resting ink as the links — AA on the
bar) with **no href, no hover and a `soon` tag** in a `--el-tint-lavender` chip. Two reasons the ink
matches the links rather than dropping to a dimmer one:

- `--el-text-muted` on `--el-surface-soft` is **4.34:1** — under the 4.5:1 1.4.3 asks of 13.5px text,
  in the light `motir` palette a first-time visitor is served. The muted ink belongs inside a card,
  never on a panel (`theme.css`'s own rule, MOTIR-2455).
- The non-link reads from the _interaction_, not the ink: a `<span>` has no hover state and no pointer
  cursor, and the `soon` tag states it at a glance.

**Promotion rule:** when a page ships, its label becomes an `<a href>` to its route and the `soon`
tag is dropped. Nothing else in the bar moves.

> **⚠️ This reconciles two shipped chromes that disagree.** `SiteFooter` drops Product/Pricing
> entirely ("absent rather than drawn as labels"); `ExploreTopBar` keeps them as labels. The unified
> chrome keeps them as placeholders, because the reading surfaces a visitor reaches today via
> `app.motir.co` already show them, and dropping them on the move would be a regression in
> information. The footer's rule is unchanged — it is about the footer's own rows, not the nav.

### The current-page treatment

`--el-accent-on-surface` at `font-weight: 600`, with `aria-current="page"` — the pairing
`ExploreTopBar` and `SiteHeader` both ship. Measured on `@motir/design-system` (0.1.1):

| element      | token                                      | dark on `--el-surface-soft` | light  | AA 4.5:1 |
| ------------ | ------------------------------------------ | --------------------------- | ------ | -------- |
| current item | `--el-accent-on-surface` + weight 600      | 5.76:1                      | 6.29:1 | ✓        |
| other items  | `--el-text-secondary`                      | 6.94:1                      | 6.51:1 | ✓        |
| `soon` tag   | `--el-text-strong` on `--el-tint-lavender` | —                           | ≥ 10:1 | ✓        |

**`/legal` marks NEITHER Explore nor Docs current.** The legal pages are reached from the footer and
from sign-up, not from the bar, so marking Explore as `aria-current` there would tell a screen reader
the wrong thing — `ExploreTopBar`'s own shipped reasoning (`current: 'legal'` matches neither),
retained, not undone.

### The footer

`SiteFooter`'s four-column shape (brand + Product / Resources / Legal + the legal strip), with every
address that now lives on this host turned into a same-origin link:

- **Resources:** Explore projects → `/explore` · Docs → `/docs` · GitHub (external, the one footer
  link that is not motir-core).
- **Legal:** Privacy Policy → `/legal/privacy` · Terms of Service → `/legal/terms` · All legal
  documents → `/legal`. The seven-document list and the per-slug pages are the `/legal` card's scope;
  this asset owns the chrome rows that reach them.
- **Product:** Start free / Sign in — the app doors, cross-host.
- The legal strip stays `--el-text-secondary` (NOT muted — 4.34:1 on this band, MOTIR-3984).

The `ExploreFooter`'s "Explore by topic" crawl-links column is **not** part of the chrome: it is the
`/explore` surface's own SEO footer, owned by that card along with the crawl surface (robots.txt,
sitemap.xml, canonicals, JSON-LD). This asset's footer is the shared chrome all four surfaces wear.

---

## Surfaces / panels (inspect every panel)

- **Panel 1 — the landing, desktop light (1440).** No current item; the full bar + footer.
- **Panel 2 — the nav states, close-up.** Landing (none) · /explore (Explore) · /explore/topic/\*
  (Explore) · /docs (Docs) · /legal (neither).
- **Panel 3 — /explore, desktop.** Explore current; the square body is out of scope.
- **Panel 4 — /docs, desktop.** Docs current.
- **Panel 5 — /legal, desktop.** Neither current; footer legal rows reach the documents.
- **Panel 6 — narrow (390 × 844).** The `md:hidden` menu panel, carrying the current-page treatment
  too — a treatment that exists only on desktop is a bug the build card would have to be told about.
- **Panel 7 — the access path.** Each entrance drawn in its parent surface.
- **Panel 8 — the placeholder treatment**, and the promotion rule.
- **Panel 9 — dark theme.** The same bar under `data-theme="dark"`.

## ACCESS PATH — how each surface is reached

1. **`/explore`** — the nav item, on every surface's bar (panels 1–5, 7). The only entrance.
2. **`/docs`** — the nav item (it already had the treatment in `ExploreTopBar` via `current`).
3. **`/legal`** — **the footer**, where it is reached from today, and where it stays: Privacy ·
   Terms · All legal. Not moved into the nav, for the shipped aria-current reasoning above.
4. **The app doors** — Sign in / Start free, the only deliberate cross-host links, drawn as leaving.
5. **Back from `/explore` into a public project** — a cross-host link once `/p/[identifier]` moves; drawn as a
   normal link, never assumed same-origin (MOTIR-3877's surface, not this card's).

## Composition, not redrawing

| drawn                       | mirrored from                                                                  | how                                                              |
| --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| the bar                     | `motir-marketing/app/_components/SiteHeader.tsx`, **rendered**, not summarised | its structure + the nav's internalised links, nothing else moves |
| the footer                  | `motir-marketing/app/_components/SiteFooter.tsx`                               | its four-column shape, links internalised                        |
| the current treatment       | `app/(public)/explore/_components/ExploreTopBar.tsx`                           | `--el-accent-on-surface` + weight 600 + `aria-current`           |
| the legal/current reasoning | `app/(public)/explore/_components/ExploreTopBar.tsx`'s `current` prop          | `/legal` matches neither                                         |
| the brand lockup            | `design/brand/design-notes.md` §7c                                             | `BrandMark` 26px / 22px                                          |
| the buttons                 | `@motir/design-system` `Button` variants                                       | primary / ghost, size sm                                         |
| the tokens                  | `@motir/design-system` `theme.css`                                             | `--el-*` restated, light + dark                                  |

Every colour in the mock is an `--el-*` token; every shape an element-semantic shape token. The only
raw values are the doc-annotation scaffold's own fills (the `#f4f3f1` sheet, the `#f4f2fd` ref chip)
and the non-semantic elevation shadows — the same scaffold allowance `landing.mock.html` documents.

## Designed against shipped reality

The bar and footer already ship in two places, so this pass rendered rather than read-and-redrew: the
mock's bar is `SiteHeader`'s markup class-for-class (its `navItems` structure, its `BrandMark`
lockup, its ghost/primary CTA pair), and its footer is `SiteFooter`'s four columns. The one thing the
asset ADDS is the internalised nav (Explore/Docs become same-origin) and the placeholder `soon` tags;
everything else is the shipped structure. The landing body and the reading-surface bodies are drawn
as neutral `--el-muted` placeholder bands — they are their own cards' scope, and this asset does not
redraw them (the same _"it draws the chrome around it"_ boundary the card states).

## AA contrast

Held in both themes, over the `motir` palette (the binding default): the current item, the resting
nav links and the `soon` tag all clear 4.5:1 on the bar's `--el-surface-soft` (table above). The
footer's body ink is `--el-text-secondary` throughout — the muted ink is 4.34:1 on that band and is
used nowhere in the chrome. The `soon` tag is `--el-text-strong` on `--el-tint-lavender`.

## Out of scope — who owns what

- **The `/explore` and `/docs` surfaces** are this story's _other_ children, not this card. Their
  bodies, states, crawl surface and the `/docs` mechanism decision are theirs. This asset draws only
  the chrome they all wear.
- **The `/legal` room** is MOTIR-4005's (design) and MOTIR-4009's (render). This asset draws the
  chrome door (the footer rows), not the index or the document page.
- **`/p/[identifier]`** is MOTIR-3877's. The back-link from `/explore` is drawn here only as a normal link.
- **This asset ships three files and no code.**

## Notes for the build card

- **The nav internalises Explore and Docs**: `EXPLORE` / `DOCS` in `motir-marketing`'s
  `motir-marketing/lib/destinations.ts` stop being `${APP_ORIGIN}/…` and become `/explore` / `/docs` — same origin,
  `next/link`, prefetchable, with `aria-current="page"` on the active one.
- **Product / Pricing stay placeholders** with the `soon` tag and the promotion rule above.
- **`/legal` current state is "neither"** — do not reintroduce a current marker on Explore/Docs there.
- The `Design` nav item is untouched; it already ships in `SiteHeader`.
- The current treatment is the SHIPPED one (`--el-accent-on-surface` + weight 600), not any
  `--el-text` + underline rule a retired AA number once forced.
