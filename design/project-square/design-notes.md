# The project square — design notes

Design reference for the `project-square` UI area — **the system-level
public-project directory** (Story 6.13). A top-level gallery / explore page any
signed-in Motir account can browse to discover every project made **public** in
6.12: project **cards** (name · org · description · viewer / upvote / activity
stats), a **search bar**, **category / tag filters**, and **sort / rank tabs**
(Trending / Popular / New), paginated at scale — then click any card through to
that project's **6.12.4 public read-only view**.

Built FROM the real design system (`app/globals.css` `--el-*` colour tokens +
`[data-display-style]` shape tokens + the shipped `components/ui/*` primitives),
so the 6.13.6 code subtask composes the same primitives — no Pencil→code gap.

| Surface                          | Asset                      | Gate                                                           |
| -------------------------------- | -------------------------- | -------------------------------------------------------------- |
| **Gallery / explore page**       | `project-square.mock.html` | **6.13.6** (the square UI) over **6.13.2** (card projection)   |
| **Sort / rank tabs**             | `project-square.mock.html` | **6.13.6** UI · **6.13.4** (the ranking)                       |
| **Search + category/tag filter** | `project-square.mock.html` | **6.13.6** UI · **6.13.3** (search/filter) · **6.13.5** (tags) |
| **Shell entry**                  | `project-square.mock.html` | **6.13.6** (the top-level Explore nav entry)                   |
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

## The three load-bearing invariants this asset draws + states in writing

The square is a **thin DISCOVERY index over 6.12**, adding NO new access
semantics (the module header of `scripts/plan-seed/data/story-6.13.ts` is the
authority):

1. **PUBLIC-ONLY.** The square lists ONLY projects whose access level is already
   `public` (the single cross-org READ exception 6.12.3 fixed). A
   private / open / limited project **NEVER** appears, for any viewer, ever — the
   6.13.2 directory read is filtered on `access_level = 'public'` at the
   repository layer, and the 6.12.3 **404-not-403** posture for non-public
   projects is untouched (a non-public project is simply absent from the set,
   never "forbidden"). Every card on every panel carries the **Public** pill to
   make this visible.
2. **ORG ON EACH CARD.** This is a SYSTEM surface that crosses orgs, so every
   card shows the **owning org** (the cross-org context) — the `building` glyph +
   org name in `.pcard-org`. The card surfaces ONLY the card-projection fields
   (name · org · description · the three 6.12.6 stats), **never** an internal
   project field (no assignee, no estimate, no internal comment).
3. **LINKS TO THE 6.12.4 PUBLIC VIEW.** Every project card is a **whole-card
   link** (`<a class="pcard">`) to that project's 6.12.4 public read-only view,
   which still enforces the public projection + the **account-required (NOT
   anonymous)** gate. The square is a discovery index, not a second view path.

**Account-required, NOT anonymous** (inherited from 6.12): the viewer must be a
signed-in Motir account (any org); anonymous / logged-out access to the square is
explicitly out of scope (a future story).

## The rank model (drawn in Panel 2 — the locked model)

Three ranks, the GitHub-Trending / GitLab-Explore-tabs set, each a
**deterministic total order** (stable tiebreak on project id) computed at the
read layer over the 6.12.6 vote + activity signals and riding the 6.13.2 keyset
cursor — never a precomputed column, never load-all (finding #57):

- **Trending** (DEFAULT tab) — surging now: upvotes + activity inside a recency
  **window** (the GitHub daily / weekly / monthly bucket — drawn as a
  Today / This week / This month selector, default **This week**), so a
  freshly-surging project rises above a higher-lifetime-but-stale one.
- **Popular** — lifetime demand: total upvotes + total viewers.
- **New** — newly made public, by `madePublicAt` (newest first).

The active rank + window are carried in URL params
(`?rank=trending&window=week`) that compose with the search + tag params.

## Verified mirror (rung 1, cited 2026-06-12)

GitHub **Trending** + **Explore** (the card row — owner/repo, language,
description, stats — + the Topics / Collections browse); GitLab **Explore
Projects** (the Trending / Most-starred / All TABS + sort + Topic filter + name
search); OpenProject / Plane public project lists. Adopted shape: project cards +
search + category/tag filters + sort/rank tabs, paginated at scale (adopt, don't
gold-plate).

---

## The asset is multi-panel (review EACH — mistake #31)

1. **(1)** the **gallery / explore page** — the system-level card grid + the rank
   tabs + the tag facet row + the cursor "Load more".
2. **(2)** the **sort / rank tabs** — the Trending / Popular / New control, the
   default tab, the Trending recency-window selector, and a per-rank explainer.
3. **(3)** the **search bar + category / tag filters** — the search input, the
   tag facet, the active-filter (compose) state, and the categories-by-count
   browse view.
4. **(4)** the **shell entry** — the top-level system "Project square / Explore"
   nav entry (distinct from the workspace project nav) + the cross-org framing
   banner.
5. **(5)** **states** — empty square · loading skeleton · fetch-error · no-results.

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive or its mock markup;
nothing re-rolls a container / typography / spacing a primitive already owns.

| Element                       | Primitive / class                                      | Notes                                                                      |
| ----------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| page / section container      | `Card` (`.card`, `.surface-card`)                      | `--radius-card`, `--spacing-card-padding`, `--shadow-card`                 |
| project card                  | `Card` as a link (`.pcard`)                            | whole-card `<a>`; hover → `--shadow-elevated` + `--el-border-strong`       |
| **Public** badge              | `Pill` (`.pill .pill-public`)                          | `--el-public-banner-bg` / `-text`, globe glyph in `--el-info`              |
| tag / topic chip (on card)    | `Pill` neutral (`.minichip`)                           | `--el-surface` + `--el-border-soft`, `tag` glyph                           |
| rank tabs · trending window   | `Segmented` (`.seg`)                                   | active = `--el-page-bg` + `--shadow-subtle`; tab glyphs                    |
| search field                  | `Input` (`.search input`)                              | leading `search` glyph in `--el-text-muted`; `--height-input`              |
| tag filter chip (facet)       | `Pill` toggle (`.tagchip`)                             | selected → `--el-tint-lavender` + `--el-text-strong`; `x` to clear         |
| active-filter summary pills   | `Pill` tones (`.filterbar`)                            | `pill-sky` (query) · `pill-lav` (tag) · `pill-neutral` (rank)              |
| categories-by-count rows      | list rows (`.cats/.catrow`)                            | `--spacing-control-y`; count bar fill in `--el-accent`                     |
| Load more / Retry / Clear     | `Button` outline (`.btn .btn-outline`)                 | `--radius-btn`, `--spacing-btn-*`                                          |
| empty / no-results / error    | `EmptyState` / `ErrorState` (`.empty`, `.empty.error`) | glyph tint `--el-text-muted` / `--el-danger`                               |
| loading skeleton              | skeleton (`.skel-card`, `.sk.pulse`)                   | `--el-surface` blocks, opacity pulse                                       |
| nav rail + entries            | `Sidebar` (`.side`, `.side-item`)                      | active → `--el-accent-soft` (→ `--el-tint-lavender`) + `--el-accent` glyph |
| org avatar (workspace footer) | `Avatar` (`.avatar.av-mint`)                           | `rounded-full` (genuinely circular) + `--el-tint-*`                        |
| icons                         | lucide `<symbol viewBox="0 0 24 24">` sprite           | referenced via `<use>` in a 16px `.ic` box                                 |

### Per-element `--el-*` colour roles (palette, not grey-only — finding #54)

The three demand-signal stats use **distinct palette hues**, not the grey scale:

- **viewers** — `eye` glyph in **`--el-info`** (blue)
- **upvotes** — `chevron-up` glyph in **`--el-accent`** (the upvote accent, purple)
- **activity** — `activity` glyph in **`--el-success`** (green)
- the **go** arrow on a hovered card — `--el-link`

Other roles: the **Explore** eyebrow + the Trending rank/window + the active
sidebar entry use `--el-accent`; **Popular** uses `--el-warning` (star),
**New** uses `--el-info` (clock); tag chips tint with `--el-tint-lavender`;
the cross-org banner uses `--el-public-banner-bg` / `-text` with an `--el-info`
globe. Primary ink `--el-text`, secondary copy `--el-text-secondary`, captions
`--el-text-muted`, faint mono notes `--el-text-faint`. Card / panel surfaces
sit on `--el-page-bg`; quieter fills on `--el-surface`; borders via
`--el-border` / `-soft` / `-strong`. **No Tier-0 `--color-*` and no raw
`rounded-*`/`p-*`/`h-*` on any surface** — every radius / padding / height / shadow
references a `[data-display-style]` shape token (`--radius-card|btn|input|badge|control`,
`--spacing-card-padding|input-*|control-*|chip-*`, `--height-input`,
`--shadow-card|elevated|subtle`). AA contrast holds in both themes (the stat hues,
the tag-chip tints, the Public pill, the banner) — verified by toggling
`data-theme="dark"`; coloured chips put the hue in the tint BACKGROUND with
`--el-text-strong` text (finding #35), never on a page-level surface.

## Exact copy (strings the 6.13.6 build uses, threaded via next-intl)

- **Eyebrow / title:** `Explore` · `Project square`
- **Subtitle:** "Discover public projects across every Motir org & workspace —
  open project management, in the open. Click any project to open its public
  read-only view."
- **Count:** `{n} public projects`
- **Rank tabs:** `Trending` · `Popular` · `New`
- **Rank one-liners (Panel 2):** Trending = "Surging now. Upvotes + project
  activity inside the recency window…"; Popular = "Most-upvoted overall. Lifetime
  demand…"; New = "Recently made public. Ordered by the moment the project's
  access level turned `public`…"
- **Trending window:** `Today` · `This week` · `This month`
- **Search placeholder:** "Search public projects by name or description…"
- **Tag filter label:** `Filter by topic` · facet trailing: `All topics`
- **Categories view:** `Browse by category` — "Topics sorted by their
  PUBLIC-project count…"
- **Pagination:** `Load more projects` (+ the mono caption "keyset cursor · 24
  per page · stable id tiebreak (no skip / no dupe at the boundary)")
- **Shell entry:** `Project square` (under a `System` section label, distinct
  from the workspace's `{org} · {project}` section)
- **Banner:** "You're exploring **public projects across Motir** — every project
  any org has made public. Read-only; click through to open one."
- **Empty:** "No public projects yet" / "When a team makes a project public, it
  shows up here for everyone to discover…"
- **No-results:** "No projects match "{q}" in {tag}" / "Try a different search or
  topic — or clear your filters to browse the full square." + `Clear filters`
- **Error:** "Couldn't load the square" / "Something went wrong fetching public
  projects. Check your connection and try again." + `Retry`

## Layout / behaviour notes for 6.13.6

- The card grid is **paginated / lazy** over the 6.13.2 keyset cursor (the
  "Load more" affordance + the page-boundary skeleton) — **never load-all**
  (finding #57). The mono caption states the cursor contract.
- **Rank + search + tag compose** under one cursored read and are all carried in
  **URL params** (`?rank=&window=&q=&tag=`), so reload / share restores the full
  state (Suspense-keyed like the shipped list params).
- The **shell entry is system-level**, drawn in its own `System` sidebar section
  ABOVE the workspace-scoped project nav — it crosses orgs, so it must not live
  under a single workspace's nav.
- The whole card is the click target (an `<a>`, not a button with nested
  interactives) → no nested-interactive a11y violation; the tag chips / rank
  tabs are the only in-card interactive controls and they live in the toolbar,
  not inside a card.
