# Epic-level privacy on public projects — design notes

Design reference for **Story 6.14** (Epic 6 · `motir-core`). Produced by the
6.14.1 design gate. The asset source is **`epic-privacy.mock.html`** (the
layout source of truth); **`epic-privacy.png`** is its full-page export. This
is the design every UI code subtask in the story builds against:

- **6.14.5** — the tree-expand placeholder (panels 1, 2)
- **6.14.6** — the detail child-panel placeholder (panel 3)
- **6.14.7** — the project-admin "set epic private" control (panel 4)

each carries `6.14.1` in `dependsOn` and is `blocked` until this lands.

It composes **only shipped `components/ui/*` primitives** plus the `--el-*` colour
tokens and the `[data-display-style]` shape tokens — no Tier-0 `--color-*`, no
hand-rolled radius/spacing. It is a NEW ARRANGEMENT of existing primitives, no
new vocabulary. The surfaces **extend, never fork, the 6.12 public projection**
(the public board / roadmap / tree this privacy filter threads into).

---

## The invariants the design encodes (state these in writing — they are the spec)

1. **The epic ROW stays visible; its children + aggregate TELLS are absent for
   the public.** A private epic is NOT a 404 and NOT a deletion. To a
   public/non-member viewer the row shows **title + kind icon + a "Not public"
   badge** and nothing else — **no child count, no progress meter, no point
   total.** Those tells are **stripped server-side** in the 6.12.4 public
   projection (absent from the response payload), not merely hidden in the DOM.
   Panel 1 draws the private row directly beside normal epic rows that DO show
   count / progress / points, so the difference is explicit.
2. **The same "this epic is not public" statement appears in TWO places**, with
   identical copy: (a) the **tree-expand** placeholder (panel 2 — expanding the
   private epic replaces its children with one inline row at the child indent),
   and (b) the **detail child-panel** placeholder (panel 3 — the epic's
   work-item detail "Child issues" panel shows the statement instead of a list).
3. **Members bypass the exclusion entirely.** A project member sees the children
   and the real count / progress / points, with NO placeholder (panel 5). A
   quiet "Members only" marker signals the epic IS private to the public while
   making clear the member can see it.
4. **The set-private control is project-admin-gated.** Only a project admin can
   flip it; a non-admin member sees it **read-only** (disabled), never hidden,
   so the state stays legible to everyone with access (panels 4 + 6c).

---

## Panel-by-panel

### Panel 1 — the private epic's PUBLIC tree row (no tells)

- **Container:** the work-item **tree-grid row** (`role="treegrid"` / `role="row"`),
  the same grammar as `design/work-items/tree-scale` — `cell-tree` with the
  rotate-on-expand **chevron** (`button`, lucide `chevron-right`, `.is-open`
  rotates 90°), a 22px-per-level indent, the **`IssueTypeIcon`** (lucide `zap`
  in `--el-type-epic`), the monospace `lr-id`, and the title.
- **The private marker:** a **`Pill`** with a NEW `private` tone — a lucide
  `lock` glyph + label **"Not public"**. Tone = `--el-tint-lavender` background
  with `--el-text-strong` text (the AA-safe tint-bg / charcoal-text recipe,
  finding #35 — measured **9.7:1**). See _Primitive growth_ below.
- **The stripped tells:** where a normal epic row shows the **child-count chip**
  (lucide `list-checks` + "N items"), the **progress meter** (a `track`/`fill`
  bar in `--el-type-story` + "%"), and the **point total**, the private row
  shows a single italic **"Contents hidden"** marker (`--el-text-secondary`,
  spanning those columns). The row itself carries a faint `--el-tint-lavender`
  wash (`color-mix`, 26%) to read as a distinct state without tinting a
  page-level surface.
- **Copy it against:** normal epic rows above/below that DO show count /
  progress / points (so the omission is unmistakable in the mock).

### Panel 2 — the TREE-EXPAND placeholder

- The private epic, now **expanded** (chevron `.is-open`). Its children are
  replaced by **one inline placeholder row** at the children's indent
  (`padding-left: 50px` = chevron slot + one tree level), so it reads as "this
  is where the children would be".
- **Placeholder = the `EmptyState` family, inline variant:** a lucide
  **`eye-off`** glyph (`--el-text-muted`) + a bold title and a one-line
  explanation.
  - **Title:** `This epic is not public`
  - **Subtext:** `The project admin has kept this epic’s contents private.`
    (`--el-text-secondary` — it sits on `--el-surface-soft`, where `-muted`
    would fall to ~4.35:1; `-secondary` clears AA. Same sidebar-caption-AA
    lesson.)

### Panel 3 — the DETAIL child-panel placeholder

- The epic's **work-item detail page**: header (`IssueTypeIcon` + `lr-id` +
  serif title + the "Not public" `Pill`), then the **"Child issues"** panel (a
  `Card` + `SectionLabel`) rendering the centered **`EmptyState`** instead of a
  child list — lucide `eye-off` (40px), serif title, subtext. **Same copy as
  panel 2.**
- The detail **sidebar** `Card` shows Status / Type normally but renders
  **Children → "Hidden"** and **Progress → "Hidden"** (italic
  `--el-text-secondary`) — the rollups are stripped from the public projection
  exactly as the tree row's tells are.

### Panel 4 — the project-admin "set epic private" control

- A `Card` settings panel: a lucide **`shield`** + label **"Make this epic
  private"**, an explanatory line, and the shipped **`Switch`**
  (`role="switch"`, `h-5 w-9`, `rounded-full`, knob translates; OFF =
  `--el-muted` track / `--el-border-strong` border, ON = `--el-accent` track).
  Drawn in both **OFF** (public, default) and **ON** (private) states.
- **Explanatory copy (exact):**
  `Private epics stay visible as a row to the public, but their stories, tasks,
and progress are hidden from non-members. Members still see everything.`
- On **ON**, a confirmation helper line (lucide `lock` + `--el-text-muted`):
  `Non-members now see only this epic’s row — its contents are hidden.`

### Panel 5 — the MEMBER view (contrast / control case)

- The **same** private epic (`PROD-48`) as a project member: **expanded with
  real child rows** (stories with their own progress meters / points), the
  epic's real **count / progress / point** tells shown, and **NO placeholder.**
- The quiet **"Members only"** marker — a `Pill` in the **neutral** tone
  (`--el-surface` + `--el-border` + `--el-text-secondary`, lucide `lock`),
  deliberately distinct from the public lavender "Not public" badge. It signals
  the epic IS private to the public while making clear the member can see it
  (mirrors Jira showing a security-level marker to those cleared for it).

### Panel 6 — states

- **6a — list density:** the "Not public" badge among many epic siblings in a
  dense tree (it reads at row scale; the stripped row still aligns).
- **6b — board + roadmap card scale:** the badge on a board card and a public
  roadmap card (no vote tell on the private one), beside a normal card showing
  count + %.
- **6c — admin control states:** **loading** (Switch shows a spinner, disabled),
  **disabled / non-admin** (read-only Switch + helper
  `Only project admins can change epic visibility.`), and **error** (lucide
  `alert-triangle`, `--el-danger`, `Couldn’t update visibility. Try again.`).

---

## Exact copy (single source — use verbatim in 6.14.5/6/7)

| Surface                                                    | String                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public badge (tree row, board/roadmap card, detail header) | **Not public**                                                                                                                                           |
| Member marker (panel 5)                                    | **Members only**                                                                                                                                         |
| Stripped-tells marker (tree row)                           | **Contents hidden**                                                                                                                                      |
| Detail sidebar rollups (Children / Progress)               | **Hidden**                                                                                                                                               |
| Placeholder title (tree-expand + detail child-panel)       | **This epic is not public**                                                                                                                              |
| Placeholder subtext (both)                                 | **The project admin has kept this epic’s contents private.**                                                                                             |
| Admin control label                                        | **Make this epic private**                                                                                                                               |
| Admin control description                                  | **Private epics stay visible as a row to the public, but their stories, tasks, and progress are hidden from non-members. Members still see everything.** |
| Admin ON confirmation                                      | **Non-members now see only this epic’s row — its contents are hidden.**                                                                                  |
| Admin disabled (non-admin)                                 | **Only project admins can change epic visibility.**                                                                                                      |
| Admin error                                                | **Couldn’t update visibility. Try again.**                                                                                                               |

---

## Per-element `--el-*` colour roles (use the palette, not grey-only — finding #54)

| Element                                            | Token role                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Epic kind icon (`IssueTypeIcon`)                   | `--el-type-epic` (the type hue)                                                                 |
| Story kind icon (member children)                  | `--el-type-story`                                                                               |
| "Not public" badge — background / text             | `--el-tint-lavender` / `--el-text-strong`                                                       |
| "Members only" marker — bg / border / text         | `--el-surface` / `--el-border` / `--el-text-secondary`                                          |
| Private-row wash                                   | `color-mix(--el-tint-lavender 26%)` (not a page-surface tint)                                   |
| Placeholder icon (`eye-off`)                       | `--el-text-muted`                                                                               |
| Placeholder title                                  | `--el-text`                                                                                     |
| Placeholder subtext / "Contents hidden" / "Hidden" | `--el-text-secondary` (AA on soft / tinted surfaces)                                            |
| Progress meter — track / fill                      | `--el-muted` / `--el-type-story`                                                                |
| Count chip / points / "%"                          | `--el-text-secondary` (glyph `--el-text-faint`)                                                 |
| Admin shield — OFF / ON                            | `--el-text-muted` / `--el-accent`                                                               |
| Switch — track OFF / ON, border OFF, knob          | `--el-muted` / `--el-accent`, `--el-border-strong`, `--el-surface` (ON knob `--el-accent-text`) |
| Admin ON helper                                    | `--el-text-muted`                                                                               |
| Error helper + icon                                | `--el-danger`                                                                                   |
| Section label / column headers / state tags        | `--el-text-faint`                                                                               |
| Card surface / border / shadow                     | `--el-page-bg` / `--el-border` / `--shadow-card`                                                |

**Shape** (every surface, via `[data-display-style]` tokens — never raw
`rounded-*`/`p-*`/`h-*`): cards `--radius-card` + `--spacing-card-padding`;
pills/badges `--radius-badge` + `--spacing-chip-x/y`; the chevron/menu
affordances `--radius-control`; shadows `--shadow-subtle` / `--shadow-card`. The
`Switch` track + knob and the progress meter are genuinely circular
(`rounded-full`) — the shape-rule carve-out for pill controls.

**AA contrast** (measured): "Not public" badge charcoal-on-lavender **9.7:1**;
placeholder title on card **≈16:1**; placeholder subtext / "Contents hidden" /
"Hidden" `--el-text-secondary` on `--el-surface-soft` / the lavender wash
**≥6:1**; error helper `--el-danger` clears AA. (The two text colours moved from
`-muted`/`-faint` to `-secondary` precisely to clear AA on the soft/tinted
backgrounds — sidebar-caption-AA lesson.)

---

## Primitives composed (no hand-rolling) — checklist

- [x] **Tree-grid row** — `cell-tree` + 22px indent + rotate-on-expand chevron
      button (from `design/work-items/tree-scale`); no `row-link` anchor, so
      **no nested-interactive** (the chevron is the only control).
- [x] **`IssueTypeIcon`** — lucide `zap`/`book` in `--el-type-*`.
- [x] **`Pill`** — status (`in-progress`/`done`) + neutral + the NEW `private`
      tone (see growth note).
- [x] **`EmptyState`** — the placeholder (inline row variant in the tree;
      centered card variant on the detail page).
- [x] **`Card`** + **`SectionLabel`** — the detail child-panel + sidebar + admin
      panel.
- [x] **`Switch`** (`components/ui/Switch.tsx`) — the admin toggle, ON / OFF /
      disabled / loading.
- [x] Board + roadmap cards — reused from `design/public-projects`.
- [x] Tokens — `--el-*` colour + `[data-display-style]` shape only; **no Tier-0
      `--color-*`, no raw `rounded-*`/`p-*`/`h-*`** in any component markup
      (verified). Icons all `viewBox="0 0 24 24"`.

### Primitive growth — a `private` Pill tone

The "Not public" badge needs a tone the shipped `Pill` does not yet expose. Add
it as a **new variant axis value** on `components/ui/Pill.tsx` — `tone="private"`
→ `bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent` (the same
AA recipe as `status="planned"` / `memberRole="admin"`, which already use
lavender). It carries the lucide `lock` glyph at the call site. This is the
per-component token/variant growth pattern (notes.html mistake #20) — no new
Tier-0 colour, no hand-rolled chip. The "Members only" marker reuses the
existing **neutral** tone; no growth needed for it.

---

## Mirror-product grounding (rung 1, cited)

- **GitLab confidential issues** — hidden from non-members server-side,
  including in search; Motir raises this from one issue to an epic subtree, with
  the parent row kept as a visible placeholder rather than a hard 404.
  (https://docs.gitlab.com/ee/user/project/issues/confidential_issues.html)
- **Canny public-roadmap visibility** — the "what shows on the public roadmap"
  control Motir productizes at epic granularity.
  (https://help.canny.io/en/articles/3828148-public-roadmap)

The "kept-row + placeholder" shape (vs a 404 that makes the roadmap look
incomplete, or a client-side hide that leaks children over the wire) is the
durable, no-leak posture both mirrors enforce.
