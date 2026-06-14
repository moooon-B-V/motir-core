# The project square — design notes

Design reference for the `project-square` UI area — **a fully public,
SEO + GEO-optimised web page** (`motir.co/explore`) that lists every project
made **public** in 6.12 (Story 6.13). A crawlable gallery any visitor can browse
with **no sign-in**: project **cards** (name · owning org · description · viewer /
upvote / activity stats), a **search bar**, **category / tag filters**, and
**sort / rank tabs** (Trending / Popular / New), paginated at scale — then click
any card through to that project's **6.12.4 public read-only view**.

Built FROM the real design system (`app/globals.css` `--el-*` colour tokens +
`[data-display-style]` shape tokens + the shipped `components/ui/*` primitives),
so the 6.13.6 code subtask composes the same primitives — no Pencil→code gap.

> **⚠️ Model revision (Yue, 2026-06-14).** This supersedes the first 6.13.1 pass.
> The square is **fully public (no auth)**, is **NOT in the app left-nav** (it's a
> standalone web page reached from the Motir **marketing site**), drops the
> redundant per-card **"Public" pill**, and is **SEO + GEO optimised** (server-
> rendered, crawlable, structured-data + answer-engine framing). The earlier
> "account-required, not anonymous" + "shell entry" framing is removed.

| Surface                          | Asset                      | Gate                                                           |
| -------------------------------- | -------------------------- | -------------------------------------------------------------- |
| **Public page (hero + gallery)** | `project-square.mock.html` | **6.13.6** (the square UI) over **6.13.2** (card projection)   |
| **Sort / rank tabs**             | `project-square.mock.html` | **6.13.6** UI · **6.13.4** (the ranking)                       |
| **Search + category/tag filter** | `project-square.mock.html` | **6.13.6** UI · **6.13.3** (search/filter) · **6.13.5** (tags) |
| **SEO + GEO scaffolding**        | `project-square.mock.html` | **6.13.6** (metadata · JSON-LD · semantic HTML · sitemap)      |
| **States** (empty/load/err/none) | `project-square.mock.html` | **6.13.6** (the state surfaces)                                |

The single UI code subtask in Story 6.13 (**6.13.6**) carries `6.13.1` in
`dependsOn` and is `blocked` until this asset lands.

## Where it lives

```
design/project-square/
  design-notes.md            ← this spec
  project-square.mock.html   ← the asset SOURCE (5 panels, one self-contained file)
  project-square.png         ← the full-page PNG export (board-visible face)
```

## The load-bearing invariants this asset draws + states in writing

The square is a **thin DISCOVERY index over 6.12**, adding NO new write and NO
new cross-org grant (the module header of `scripts/plan-seed/data/story-6.13.ts`
is the authority):

1. **FULLY PUBLIC — NO AUTH.** The page is open to **anyone, logged-out
   included** — no sign-in, no paywall. (Model revision 2026-06-14 — reverses the
   earlier account-required framing.) It is reached from the **Motir marketing
   site**, not from inside the app.
2. **NOT IN THE LEFT NAV.** The square is **NOT** an app-shell route and has **NO
   sidebar / left-nav entry**. The mock draws the **marketing-site chrome** (a top
   bar + a footer), never the app `Sidebar`.
3. **NO "PUBLIC" PILL.** Every project on this page is public by definition, so
   the per-card Public badge is redundant and **removed**. The card top shows only
   the owning **org** (the cross-org context).
4. **PUBLIC-ONLY (unchanged).** The directory lists ONLY projects whose access
   level is `public` (the cross-org READ exception 6.12.3 fixed); a
   private / open / limited project **NEVER** appears, and the 6.12.3
   **404-not-403** posture is untouched (a non-public project is simply absent,
   never "forbidden"). The 6.13.2 read filters on `access_level = 'public'` at the
   repository layer.
5. **CARD PROJECTION ONLY (unchanged).** A card surfaces ONLY name · org ·
   description · the three 6.12.6 stats — **never** an internal project field.
6. **LINKS TO THE 6.12.4 PUBLIC VIEW (unchanged).** Each card is a **whole-card
   `<a href>`** to that project's public read-only view.

> **Cross-story note (flagged for the planner, not resolved here):** with the
> square now fully anonymous + crawlable, the 6.12.4 public view a card links into
> is still **account-required** under the 6.12 model. For the crawl / anonymous
> click-through to fully work, 6.12's "account-required, not anonymous" decision
> likely needs the same revision. That is **6.12 scope**, out of 6.13.1 — surfaced
> as a finding for the 6.12 re-plan, not improvised here.

## SEO + GEO (Panel 4 — the design contract for 6.13.6)

The page is **server-rendered and crawlable** (no auth gate, no client-only
render) so search engines and generative engines read the full content:

- **Head / metadata** — `<title>`, `<meta name="description">`, a `canonical`
  URL, OpenGraph (`og:title` / `og:image` → a generated `/explore/opengraph-image`)
  and `twitter:card`.
- **JSON-LD structured data** — a `CollectionPage` whose `mainEntity` is an
  `ItemList` of `SoftwareApplication` (one per project card, with `name` /
  `applicationCategory` / `url`); a `BreadcrumbList` for the topic pages.
- **Semantic HTML** — a single `<h1>` (the hero), `<h2>` section headings
  (Trending projects · Browse by topic · What is the project square?), each card
  an `<article>` with an `<h3>`; topic browse in a `<nav>`.
- **Real URLs in a sitemap** — every state is its own indexable URL:
  `/explore`, `/explore?rank=popular`, `/explore?q=…&tag=…`, `/explore?page=2`,
  the per-topic landing pages `/explore/topic/<slug>`, and each project's
  `/explore/<org>/<project>` card link. Cards are real `<a href>` (crawlable
  without JS).
- **GEO (generative-engine optimisation)** — a concise, citable lead paragraph +
  an FAQ block ("What is the project square?", "Are these projects free to
  view?") so answer engines (GPTBot, etc.) get a clean, attributable answer with
  the canonical URL as the source.

## The rank model (drawn in Panel 2 — unchanged)

Three ranks, the GitHub-Trending / GitLab-Explore-tabs set, each a
**deterministic total order** (stable tiebreak on project id) computed at the
read layer over the 6.12.6 vote + activity signals and riding the 6.13.2 keyset
cursor — never a precomputed column, never load-all (finding #57):

- **Trending** (DEFAULT tab) — surging now: upvotes + activity inside a recency
  **window** (Today / This week / This month, default **This week**).
- **Popular** — lifetime demand: total upvotes + total viewers.
- **New** — newly made public, by `madePublicAt` (newest first).

Rank + window + search + tag are all real URL params (`/explore?rank=&window=&q=&tag=`),
each server-rendered into its own indexable page.

## Verified mirror (rung 1, cited 2026-06-12)

GitHub **Trending** + **Explore** (the card row + the Topics / Collections
browse); GitLab **Explore Projects** (the Trending / Most-starred / All TABS +
sort + Topic filter + name search). For the **public-directory + SEO** posture:
**npm / PyPI / Product Hunt / Awesome-lists** — public, server-rendered, crawlable
directories with per-item + per-topic landing pages. Adopted shape: project cards

- search + topic filters + sort/rank tabs, on a public SEO/GEO page (adopt, don't
  gold-plate).

---

## The asset is multi-panel (review EACH — mistake #31)

1. **(1)** the **public page** — the marketing-site top bar, the SEO hero (H1 +
   lede + search + trust line), the card gallery (NO Public pill), the cursor
   "Load more", and the SEO footer (topic landing links). No app shell.
2. **(2)** the **sort / rank tabs** — Trending (default) / Popular / New + the
   Trending window; each a real crawlable URL.
3. **(3)** the **search bar + category / tag filters** — the search input, the
   tag facet, the active-filter compose state, and the categories-by-count browse
   (each topic a `/explore/topic/<slug>` landing page).
4. **(4)** the **SEO + GEO scaffolding** — head meta / OpenGraph / canonical, the
   JSON-LD structured data, the semantic HTML outline, and the GEO framing.
5. **(5)** **states** — empty square · loading skeleton · fetch-error · no-results.

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive or its mock markup;
nothing re-rolls a container / typography / spacing a primitive already owns.

| Element                         | Primitive / class                                      | Notes                                                                     |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- | -------- | --------------------------------- |
| public page frame               | `.webpage` (a `Card`-shaped surface)                   | `--radius-card`, `--shadow-card`, `--el-border`                           |
| marketing top bar / footer      | `.site-top` / `.site-foot`                             | site chrome (NOT the app `Sidebar`); footer is an SEO link surface        |
| SEO hero                        | `.sq-hero` (H1 + lede + search)                        | soft `--el-tint-lavender` corner wash; serif `<h1>`                       |
| project card                    | `Card` as a link (`.pcard`)                            | whole-card `<a href>`; hover → `--shadow-elevated` + `--el-border-strong` |
| tag / topic chip (on card)      | `Pill` neutral (`.minichip`)                           | `--el-surface` + `--el-border-soft`, `tag` glyph                          |
| rank tabs · trending window     | `Segmented` (`.seg`)                                   | active = `--el-page-bg` + `--shadow-subtle`; tab glyphs                   |
| search field                    | `Input` (`.search input`)                              | leading `search` glyph in `--el-text-muted`; `--height-input`             |
| tag filter chip (facet)         | `Pill` toggle (`.tagchip`)                             | selected → `--el-tint-lavender` + `--el-text-strong`; `x` to clear        |
| active-filter summary pills     | `Pill` tones (`.filterbar`)                            | `pill-sky` (query) · `pill-lav` (tag) · `pill-neutral` (rank)             |
| categories-by-count rows        | list rows (`.cats/.catrow`)                            | each an `<a>` to a topic page; count bar fill in `--el-accent`            |
| Load more / Retry / Clear / CTA | `Button` (`.btn .btn-outline                           | -primary                                                                  | -ghost`) | `--radius-btn`, `--spacing-btn-*` |
| SEO code blocks                 | `.codeblk` (mono spec)                                 | `--el-muted` bg; syntax via `--el-accent`/`--el-info`/`--el-success`      |
| GEO callout                     | `.geo-note`                                            | `--el-tint-mint` + `--el-text-strong`, `quote`/`sparkles` glyph           |
| empty / no-results / error      | `EmptyState` / `ErrorState` (`.empty`, `.empty.error`) | glyph tint `--el-text-muted` / `--el-danger`                              |
| loading skeleton                | skeleton (`.skel-card`, `.sk.pulse`)                   | `--el-surface` blocks, opacity pulse                                      |
| icons                           | lucide `<symbol viewBox="0 0 24 24">` sprite           | referenced via `<use>` in a 16px `.ic` box                                |

### Per-element `--el-*` colour roles (palette, not grey-only — finding #54)

The three demand-signal stats use **distinct palette hues**, not the grey scale:

- **viewers** — `eye` glyph in **`--el-info`** (blue)
- **upvotes** — `chevron-up` glyph in **`--el-accent`** (the upvote accent, purple)
- **activity** — `activity` glyph in **`--el-success`** (green)
- the **go** arrow on a hovered card — `--el-link`

Other roles: the hero eyebrow + the Trending rank/window + the primary CTA use
`--el-accent`; **Popular** uses `--el-warning` (star), **New** uses `--el-info`
(clock); tag chips tint with `--el-tint-lavender`; the SEO code syntax uses
`--el-accent` (tags) / `--el-info` (attrs) / `--el-success` (strings); the GEO
note + the trust/fact checks use `--el-tint-mint` / `--el-success`. Primary ink
`--el-text`, secondary copy `--el-text-secondary`, captions `--el-text-muted`,
faint mono notes `--el-text-faint`. Surfaces sit on `--el-page-bg`; quieter fills
on `--el-surface` / `--el-muted`; borders via `--el-border` / `-soft` / `-strong`.
**No Tier-0 `--color-*` and no raw `rounded-*`/`p-*`/`h-*` on any surface** — every
radius / padding / height / shadow references a `[data-display-style]` shape token
(`--radius-card|btn|input|badge|control`, `--spacing-card-padding|input-*|control-*|chip-*`,
`--height-input`, `--shadow-card|elevated|subtle`). AA contrast holds in both
themes (the stat hues, the tag-chip tints, the GEO note) — verified by toggling
`data-theme="dark"`; coloured chips put the hue in the tint BACKGROUND with
`--el-text-strong` text (finding #35), never on a page-level surface.

## Exact copy (strings the 6.13.6 build uses, threaded via next-intl)

- **Top-bar nav:** `Product` · `Explore` (active) · `Docs` · `Pricing` · `Sign in`
  · `Start free`
- **Hero eyebrow / H1:** `Project square` · "Explore public project plans built on
  Motir"
- **Hero lede:** "Browse real, public product roadmaps and project plans from
  teams building in the open — issues, boards, and sprints, free to read with no
  sign-up. Search by name, filter by topic, and sort by what's trending."
- **Search placeholder:** "Search public projects by name or topic…"
- **Trust line:** "1,284 public projects" · "No sign-up required" · "Updated daily"
- **Rank tabs:** `Trending` · `Popular` · `New`; **window:** `Today` · `This week`
  · `This month`
- **Tag filter label:** `Filter by topic` · facet trailing: `All topics`
- **Categories view:** `Browse by topic` — "Topics sorted by their PUBLIC-project
  count…"
- **Pagination:** `Load more projects` (mono caption: "keyset cursor · 24 per page
  · each page a real crawlable URL (?page=2) · no skip / no dupe")
- **SEO panel:** "Built to be found — by search engines and by AI"
- **GEO note:** "A concise, citable lead paragraph + an FAQ block… gives generative
  engines a clean, attributable answer — with the canonical URL as the source."
- **Footer:** `Explore by topic` (topic landing links) · `Product` · `Company` ·
  "The AI-native way to plan, track, and ship — explore what teams are building in
  the open."
- **Empty:** "No public projects yet" / "When a team makes a project public, it
  shows up here for everyone to discover. Check back soon."
- **No-results:** "No projects match "{q}" in {tag}" / "Try a different search or
  topic — or clear your filters to browse the full square." + `Clear filters`
- **Error:** "Couldn't load the square" / "Something went wrong fetching public
  projects. Check your connection and try again." + `Retry`

## Layout / behaviour notes for 6.13.6

- **No app shell.** The page renders its own marketing-site top bar + footer; it
  is NOT mounted inside the authenticated app layout and has no sidebar entry.
- **Server-rendered + anonymous.** The gallery, ranks, search, and topic pages
  must render on the server without a session, so crawlers / GPTBot get full
  content and every state is a real URL.
- The card grid is **paginated / lazy** over the 6.13.2 keyset cursor (the "Load
  more" → `?page=2`) — **never load-all** (finding #57).
- **Rank + search + tag compose** under one cursored read, all carried in URL
  params, each its own indexable page.
- The whole card is the click target (an `<a>`, not a button with nested
  interactives) → no nested-interactive a11y violation; the only in-card
  interactive controls (rank tabs / tag chips) live in the toolbar.
