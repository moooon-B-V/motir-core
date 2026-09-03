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

---

---

# motir.co — the NOT-FOUND room, inside the same chrome (`not-found.*`)

**Task:** MOTIR-4245 · (`type: design`) · **Epic 8 · MOTIR-3875 (Motir's public web presence).**
**Repository: `motir-core`.** **Unblocks:** MOTIR-4193 (which builds
`motir-marketing/app/not-found.tsx`).

The asset above draws the CHROME every motir.co surface wears. **A 404 wears none.** MOTIR-4193
measured it from build output: no `main` landmark, no header, no footer, no brand, nothing on the
page that links anywhere, and an inline style that hard-codes black-on-white and swaps on
`prefers-color-scheme` alone. This asset draws the ROOM that goes inside the chrome, and decides the
one question 4193 deliberately does not answer: **what motir.co says to a lost visitor, and where it
sends them.**

It stands to 4193 exactly as MOTIR-4005 stood to MOTIR-4009 for `/legal`, and it follows that card's
own stated rule: **the chrome is a motir-core asset this card READS; the room is the deliverable.**

**Asset files (three):** this `design-notes.md` (the AREA's note) · `not-found.mock.html` (the source
of truth — standalone, re-stating the shipped `--el-*` values so it paints without a Tailwind build)
· `not-found.png` (full-page Playwright chromium export, `deviceScaleFactor: 2`, light theme,
`node scripts/render-design-mock.mjs --width 1440 design/public-site/not-found.mock.html`).

`public-site.mock.html` and `public-site.png` are **UNCHANGED** by this card. `public-site.*` is
frozen; a new surface gets a new asset in the same area, never an amendment in place.

---

## Designed against shipped reality — RENDERED, not read-and-redrawn

Every measurement in the mock was read off the **running site**, not off the Tailwind source: a
worktree at `motir-marketing` `origin/main` `61b9a13`, served with `next dev`, driven with Playwright
chromium at 1440x900 and 390x844, light and dark.

| what was measured                               | how                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| every `--el-*` value the mock restates          | `getComputedStyle(document.documentElement)` on the running page              |
| the bar's box, the footer's grid, the `h1` face | `getComputedStyle` on the real elements                                       |
| the chrome's markup                             | `document.querySelector('header').outerHTML`, mirrored class for class        |
| the stock 404 quoted in panel 5                 | `GET /no-such-page` → **status 404**, `querySelectorAll('main').length === 0` |

The restated token block was then **verified back against the site**: every colour and shape token
matches in both themes. The only differences are notation (`rgba(15, 15, 15, 0.04)` vs `#0f0f0f0a`,
the same colour) and Next's injected `"Inter Fallback"` metric-adjusted font, which cannot exist in a
standalone file.

### ⚠️ Two places the DRAWN chrome has drifted from the SHIPPED one — this asset follows the SHIPPED one

This is what rendering buys that reading does not, and it is worth stating because two sibling assets
disagree with the product:

1. **There are no `Product` / `Pricing` placeholders in the bar.** The section above specifies them
   with a `soon` tag and a promotion rule, and `motir-marketing/design/legal/legal.mock.html` draws
   them too. The shipped `navItems` array in `motir-marketing/app/_components/SiteHeader.tsx` has
   **exactly three entries — Explore, Docs, Design** — and the rendered bar shows exactly those.
   This asset draws the three that ship.
2. **`Sign in` leaves the bar below `md`, and lands in the menu panel.** It carries
   `hidden md:inline-flex`, so at 390 the bar is brand + `Start free` + the menu button, and the
   panel is Explore · Docs · Design · Sign in. Panel 3 draws the measured arrangement.

Neither is a defect in those assets — the placeholders were a decision that has not shipped yet, and
that is a legitimate state for a forward-looking asset. But a card building `not-found.tsx` composes
the chrome that EXISTS, so this asset draws that one.

---

## THE DECISION — what the room says, and where it sends a lost visitor

### The doors: TWO, ordered

| #   | label              | href       | treatment                                                 |
| --- | ------------------ | ---------- | --------------------------------------------------------- |
| 1   | Explore projects   | `/explore` | **PRIMARY** — `Button` size `md`, `--el-accent` fill      |
| 2   | Go to the homepage | `/`        | ghost — `Button` size `md`, no border, fill on hover only |

### Why Explore is primary — derived from the arrivals, not borrowed

A 404 has no entrance anybody clicks deliberately, so the question "where does it send them?" is
answerable only from **where they came from**. There are four arrivals, and every one calls
`notFound()` on ordinary input (panel 5):

| arrival                             | what the visitor wanted | the answer   |
| ----------------------------------- | ----------------------- | ------------ |
| a stale `/p/<identifier>` link      | a public project        | **Explore**  |
| an unlisted `/explore/topic/<slug>` | to browse               | **Explore**  |
| an unknown `/legal/<slug>`          | a document              | the footer   |
| a mistyped URL                      | the site                | the homepage |

**Three of the four are people who wanted a public project or to browse for one**, and `/p/[identifier]` makes
that the routine case rather than the exceptional one — MOTIR-4193's own words: "a shared link to a
project whose owner turns public access off lands a real visitor here", and MOTIR-4123 records
`/explore` linking into that hole in production. `/explore` is the only destination that answers
them, and it is a reading surface a stranger can use immediately. The landing is a pitch; it answers
the mistyped URL and nothing else, which is why it is the second door and not the first.

### Why exactly TWO — the chrome carries the rest

This is the whole argument for the count, and it is what makes the room short rather than a site map:
**the room's doors are a RANKING, not a menu.** The bar above it holds Explore, Docs and Design; the
footer below it holds all nine destinations, including the entire Legal column. So the room names the
likeliest intent and lets the chrome carry every other one.

That is also the precise reason the stock screen is bad. It has **no chrome**, so it would need to
offer everything — and it offers nothing. Once the chrome is there, the room needs very little, and
adding more doors would be re-listing the nav one inch below the nav.

- **No `Docs` door.** `Docs` is in the bar 57px above the room and in the footer below it.
- **No `/legal` door.** The footer's Legal column is on this very page, and an unknown legal slug is
  the rarest of the four arrivals.
- **No search field.** motir.co has **no site-wide search**. The one search input on the site belongs
  to `/explore` and is scoped to the project directory
  (`motir-marketing/app/explore/_components/SearchForm.tsx`). Drawing one here would invent an
  unshipped control — the design-reference rule's NONE-exists case, which is a missing prerequisite
  and not a detail to improvise. The Explore door carries the reader to the surface that _has_ the
  search.

### ⚠️ On the evidence behind the count — stated plainly

The card asked for this to be decided "from rung 1 (the mirror products) and the site's own
argument". **The warrant above is rung 2 — this site's own shipped routes, measured — and that is
deliberate, not a shortcut.** No competitor's 404 page was opened during this pass, and none is cited
below: a remembered impression of another product's error page is not a measurement, and writing one
into an asset as though it were would be the worst kind of citation, because it resolves, reads
authoritatively and cannot be checked. Rung 2 outranks rung 1 on the ladder in any case, and here it
is unusually strong: the arrival table is derived from the seven `notFound()` call sites that
actually exist. If a later pass wants a rung-1 comparison, it should open the pages and record what
it saw.

### One room, not four

All four arrivals resolve to the **same boundary**. Next resolves `notFound()` to the nearest
`not-found.tsx` above the route, and `motir-marketing` has **none anywhere**, so a single
`motir-marketing/app/not-found.tsx` serves all four. A per-route variant would need a per-segment
file nobody has asked for, and the copy below is written to be true for all four — which is what
rules out "we couldn't find that document", false for three of them.

### ⚠️ This SUPERSEDES the `/legal`-specific 404 room

`motir-marketing/design/legal/legal.mock.html` **panel 4** draws a `/legal`-scoped not-found body —
_"404 — document not found" / "There is no legal document at this address." / "← All legal
documents"_ — and `motir-marketing/design/legal/design-notes.md` § _The 404_ specifies it.

**Nothing renders it.** There is no `not-found.tsx` anywhere in that repository, so an unknown legal
slug today gets Next's stock screen; once MOTIR-4193 lands, it gets THIS room. Panel 4's room would
require a per-segment `motir-marketing/app/legal/not-found.tsx` that no card has proposed.

**So: do not build panel 4's room, and do not add `motir-marketing/app/legal/not-found.tsx`.** The one thing it has
that this room does not is the `← All legal documents` way back — which is why the footer's Legal
column earns its place in the argument above, and why arrival 3 is answered rather than dropped.
That asset's note is not corrected by this card (it is in another repository, and a design asset is a
record of the moment it was drawn); the correction is filed as its own defect record.

### No nav item is current

`isCurrent()` in `SiteHeader` matches `/explore` and `/docs` and their prefixes. A 404 URL is
neither, so no item takes the `--el-accent-on-surface` + weight-600 treatment. This is a derivation,
not an omission — worth stating so the build card does not "fix" it by marking one.

---

## Surfaces / panels (inspect every panel)

- **Panel 1 — the room, desktop light (1440).** The full shipped chrome with the room in the `main`
  landmark. The **skip link is drawn in its FOCUSED state** — it is `sr-only` at rest, and an asset
  that draws only the resting state depicts a bypass mechanism nobody can see.
- **Panel 2 — the doors, close-up**, with the decision written beside them: which destinations, in
  what order, which is primary, and why the count is two.
- **Panel 3 — narrow (390 × 844)**, with the `md:hidden` menu open. The doors **stack**: at 390 the
  two `md` buttons do not fit on one line, and a wrapped pair with no explicit order reads as two
  equal choices.
- **Panel 4 — dark theme**, under `data-theme="dark"` — the switch `motir-marketing/app/layout.tsx`'s init script
  actually throws.
- **Panel 5 — the ACCESS PATH, as the four ARRIVALS**, beside the stock screen that ships today.

---

## Composition, not redrawing

| drawn element                | mirrored from                                                  | how                                                                |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| the shell, `main`, skip link | `motir-marketing/app/_components/SiteShell.tsx`                | its structure, `id="main"`, `tabindex="-1"`, the focused skip link |
| the bar                      | `motir-marketing/app/_components/SiteHeader.tsx`, **rendered** | its box and its three real nav items, class for class              |
| the footer                   | `motir-marketing/app/_components/SiteFooter.tsx`, **rendered** | its four-column grid, headings, rows and legal strip               |
| the buttons                  | `@motir/design-system` `Button`                                | `primary` / `ghost`, size `sm` in the bar, size `md` in the room   |
| the brand lockup             | `@motir/brand` `BrandMark`                                     | 26px in the bar, 22px in the footer — the §7c proportions          |
| the room's measure           | `motir-marketing/app/legal/page.tsx`                           | `max-w-[46rem]`, the shipped measure, reused rather than re-chosen |
| the `h1` face                | the shipped `/legal` `h1`                                      | `--font-serif` 30px/700, `line-height: 1.2`, `-0.01em`             |
| the tokens                   | `@motir/design-system` `theme.css`                             | `--el-*` restated, light + dark, verified against the render       |

Every colour in the mock is an `--el-*` token; every shape an element-semantic shape token. The only
raw values are the doc-annotation scaffold's own fills (the `#f4f3f1` sheet, the `#f4f2fd` ref chip),
the non-semantic elevation shadows, and — deliberately — the **quoted** black-on-white of the stock
screen in panel 5, which is the thing that panel exists to show is wrong. Its caption leaves the
quotation and takes `--el-text-secondary`.

**`--el-text-muted` is not declared at all in this asset.** It is 4.54:1 on the page and 4.34:1 on
`--el-surface-soft`, and `theme.css`'s own rule is that the muted ink belongs inside a card, never on
a panel. The room paints on the page and the bar band, so the token has no legal use here, and not
declaring it is the only way it cannot be reached for by accident.

---

## AA contrast

Measured with Playwright against the RUNNING site over the `motir` palette (the binding default),
light and dark, by resolving each token on a live element and computing the WCAG 2.x ratio. Every
figure clears 1.4.3 (4.5:1 normal text, 3:1 large).

| element                        | ink                   | surface             | light     | dark      | AA  |
| ------------------------------ | --------------------- | ------------------- | --------- | --------- | --- |
| the room's `h1`                | `--el-text`           | `--el-page-bg`      | **17.40** | **17.42** | ✓   |
| the `404` eyebrow              | `--el-text-secondary` | `--el-page-bg`      | **6.80**  | **7.35**  | ✓   |
| the sentence under the heading | `--el-text-secondary` | `--el-page-bg`      | **6.80**  | **7.35**  | ✓   |
| door 1 label, on its fill      | `--el-accent-text`    | `--el-accent`       | **6.57**  | **4.99**  | ✓   |
| door 2 label, at rest          | `--el-text`           | `--el-page-bg`      | **17.40** | **17.42** | ✓   |
| door 2 label, hovered          | `--el-text`           | `--el-surface`      | **15.98** | **15.81** | ✓   |
| nav + footer rows (chrome)     | `--el-text-secondary` | `--el-surface-soft` | **6.51**  | **6.94**  | ✓   |
| footer row, hovered            | `--el-link`           | `--el-surface-soft` | 4.73      | 7.16      | ✓   |

### ⚠️ Why the ghost door has NO border — a measurement, not a preference

`--el-border` against `--el-page-bg` is **1.28:1 light / 1.34:1 dark**, and `--el-border-strong` is
**1.74:1 / 1.69:1**. So an outlined ghost button whose only boundary is a hairline would fail WCAG
**1.4.11**'s 3:1 for a component boundary — in both themes, with no token in the palette that fixes
it.

The shipped `Button` ghost variant has **no border at all**: it is `bg-transparent` with
`text-(--el-text)`, identified by its LABEL at 17.40:1, and it gains an `--el-surface` fill on hover.
Mirroring the shipped control is therefore both the composition rule and the accessible answer, and
drawing an outlined button here would have invented a control the site does not have _and_ failed a
success criterion. This is the one place where "mirror the shipped component" and "make it look like
a button" pulled in opposite directions, and the measurement settled it.

---

## Build note for MOTIR-4193

### The copy, verbatim

| slot           | string                                                                         |
| -------------- | ------------------------------------------------------------------------------ |
| eyebrow        | `404`                                                                          |
| heading (`h1`) | `That page isn’t here`                                                         |
| sentence       | `The address may be mistyped — or the page it pointed to is no longer public.` |
| door 1 label   | `Explore projects`                                                             |
| door 2 label   | `Go to the homepage`                                                           |

The sentence is written to be true for **all four arrivals** — it covers a mistyped URL, an unlisted
topic, an unknown legal slug and a project turned private. Do not narrow it per route. The apostrophe
in the heading is a typographic `’` (U+2019), matching the rest of the catalogue.

**⚠️ These strings go in `motir-marketing/messages/en.json`, not in the JSX.** That site routes all
copy through the catalogue (`motir-marketing/lib/copy.ts`, a plain typed import of the JSON — see its
header for why it is not `next-intl`). A `notFound` namespace beside the existing `nav` / `footer` /
`legal` ones is the shape; `Explore projects` already exists as `footer.explore` and can be reused
rather than duplicated. **This is a small obligation 4193's body does not name** — one namespace, five
keys — and it is called out here so it is not discovered in review.

### The destinations, as hrefs

| door               | href       | constant                                           |
| ------------------ | ---------- | -------------------------------------------------- |
| Explore projects   | `/explore` | `EXPLORE` in `motir-marketing/lib/destinations.ts` |
| Go to the homepage | `/`        | none — the site root, as `SiteHeader` links it     |

Both are same-origin, so both are `next/link`. Do not build either from `APP_ORIGIN`.

### The box the room sits in

`motir-marketing/app/not-found.tsx` renders `SiteShell` and passes its own `contentClassName`. The drawn box is:

```
mx-auto flex w-full max-w-[46rem] flex-col justify-center px-(--spacing-card-padding) py-16
```

`justify-center` is what makes the room sit in the middle of the viewport rather than jammed under
the bar: `main` is `flex-1` inside `SiteShell`'s `min-h-dvh` column, so the room takes the space the
chrome leaves. `max-w-[46rem]` is the shipped `/legal` measure. The room draws **no `<main>` of its
own** — `SiteShell` owns the landmark (MOTIR-4169), and a second one would be the defect that card
removed.

### The two traps 4193 already records — both still hold, re-verified

1. **No `loading.tsx` above a route that calls `notFound()`.** A boundary flushes the response head at
   200 and the 404 becomes a page that merely looks like one. Both
   `motir-marketing/app/legal/layout.tsx` and `motir-marketing/app/p/[identifier]/layout.tsx` carry
   the rule in their own comments. Seven `notFound()` call sites across four route families sit under
   it.
2. **`motir-marketing/app/not-found.tsx` is not a `page.tsx`.** `motir-marketing/tests/mainLandmark.test.tsx`
   enumerates `app/**/page.tsx` **from disk** and asserts the pattern set in
   `motir-marketing/e2e/routes.ts` is exactly that set — so it will neither cover the 404 nor complain
   about it, and the E2E lane needs its own entry. (The card names this file as `mainLandmark.test.ts`;
   the file on disk is `.test.tsx`, as do that file's own internal comments — a harmless slip worth
   knowing before grepping for it.)

**A third, from the measurement:** the E2E assertion should check **status 404 AND exactly one
`main`**, because those are two independent failures. Today the page is `404` with **zero** `main`
elements; a room that renders its own `<main>` inside `SiteShell` would give **two**, and only the
count catches that.

---

## GIVES / TAKES

**GIVES to MOTIR-4193** — everything below is now decided and needs no judgement at build time:

- the five copy strings, verbatim, and the `motir-marketing/messages/en.json` namespace they belong in;
- the two destinations as hrefs, with their constants, and which is primary;
- the `contentClassName` box, and the fact that the room draws no `<main>` of its own;
- the state set: **ONE room for all four arrivals**, no per-route variant, no current nav item;
- the panels to build to — 1 (desktop), 3 (narrow), 4 (dark);
- the instruction NOT to build `motir-marketing/design/legal/legal.mock.html`'s panel-4 room, and
  NOT to add `motir-marketing/app/legal/not-found.tsx`;
- the AA readings, so no contrast decision is left open.

**TAKES from MOTIR-4193:** nothing. This asset removes no element any card's criteria claim, and it
narrows no scope. It is purely additive to 4193.

**TAKES from any other card:** nothing in this project's tree. The one element it disposes of belongs
to an asset in another repository (`motir-marketing/design/legal/`), and that disposition is
SUPERSESSION rather than removal — see the section above and the defect record filed for it.

### Sizing re-check — MOTIR-4193 stands at 3 SP / 60 min

The estimation gate re-run against this asset, as the run-time design rule requires. **The asset did
not multiply 4193's scope; it constrained it.** Counting what each GIVES row obliges:

| obligation                                                           | work                                                |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| `motir-marketing/app/not-found.tsx` rendering `SiteShell` + the room | one file, ~40 lines                                 |
| five copy keys in `motir-marketing/messages/en.json`                 | one namespace, no wiring (`copy` is a typed import) |
| an E2E entry asserting 404 + one `main`                              | one row in the existing lane, no new job            |

No route, no background job, no retention window, no new i18n surface (the site ships one locale, and
`motir-marketing/lib/copy.ts` says so and why). **3 story points / 60 minutes is still right, and no amendment is
made to the card.** The one thing 4193's body does not currently name is the copy-catalogue namespace,
which is minutes and is recorded above rather than as a re-estimate.

---

## Out of scope — who owns what

- **The build** is MOTIR-4193's: `motir-marketing/app/not-found.tsx`, the copy keys and the E2E entry.
  This asset ships three files and no code.
- **The chrome itself** is MOTIR-3880's (`public-site.*`, above). This asset composes it and amends
  it in no way; the two drift findings recorded above are observations about the shipped component,
  not edits to that asset.
- **The `/legal` room** is MOTIR-4005's, in `motir-marketing`. This asset supersedes its 404 panel and
  says so; correcting that asset is its own defect record, not this card's diff.
- **`motir-marketing/app/error.tsx`** — a 500 room — is NOT drawn here and is not 4193's scope either. A 500 is a
  different surface with a different copy problem (nothing to browse toward), and it has no card.
