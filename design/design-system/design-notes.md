# Element-token taxonomy — design notes

Design reference / **token spec** for the `design-system` area, surface
**granular `--el-*` element colour tokens**. This is the **spec deliverable of
MOTIR-1267 (1266.1)** — a doc the five code subtasks read; it contains **no
component changes**. It is audit-driven: every token below is grounded in a
5-part sweep of `origin/main` (commit `5e15d17a`), cited by `file:line`.

> **Asset** — `element-tokens.mock.html` (+ `element-tokens.png` export): a
> swatch specimen of every new family, resolved against the real `motir` base in
> **light and dark side-by-side** to prove the swap layer. The HTML embeds the
> base `--color-*` hexes and defines the proposed `--el-*` on top (the tokens
> don't exist in `globals.css` yet — that's this spec's output), so it is
> self-contained by necessity.

> **The problem (parent story MOTIR-1266).** Palettes "can't differentiate nav
> icons / borders / priority / status — Candy exposed it." The cause is
> **collapse**: too many distinct UI meanings share a tiny set of tokens —
> the six `--el-tint-*` (labels, avatars, roles, privacy, diffs, drop-targets,
> sprint emphasis all pull from the same six pastels), the `--el-text-muted` /
> `--el-text` pair doing triple duty for body text AND icons AND captions, and
> `--el-type-*` (work-item-type hues) **borrowed** for notification badges, AI
> models, and avatar fallbacks. When a vivid palette (Candy) re-tints those six
> pastels, every collapsed meaning moves together — priority `medium` and
> `lowest` are *both* grey, a status dot bypasses the swap layer entirely
> (`StatusPicker`), and a notification badge inherits a work-item-type colour it
> has nothing to do with. **This spec un-collapses each meaning onto its own
> `--el-*` token so a palette can tune it independently.**

---

## 1. The governing principle — how a token gets its value in all 10 palettes

The colour system in `app/globals.css` is three tiers (file header, lines 39-46):

- **Tier 0** — `@theme` base `--color-*` vars (≈36; the light/warm-editorial base).
- **Tier 1** — `[data-theme='dark']` overrides a subset of `--color-*`.
- **Tier 3** — `:root` `--el-*` **element tokens** that each reference a `--color-*`.
  Components reference `--el-*`, **never** `--color-*` or a raw hex.

A **palette** (`[data-palette='<id>']`, registry `lib/theme/palettes.ts`) re-skins
the app by **overriding the Tier-0 `--color-*` SOURCE** that the Tier-3 `--el-*`
layer reads — not by overriding `--el-*` directly. Verified across all 9
override blocks: each sets **≈83 `--color-*` vars and exactly ONE `--el-*`**
(`--el-sidebar-item-bg-hover`, the lone concrete hex with no `--color-*` base).

> **∴ THE RULE: a new `--el-*` token that maps to an existing Tier-0 `--color-*`
> re-skins across all 10 palettes AND light/dark with ZERO per-palette work.**
> Its "value in palette X" *is* whatever palette X already sets that `--color-*`
> to. This is exactly how the gold-standard `--el-chart-*` and `--el-type-*`
> ramps work (globals.css 2238-2302) — every entry maps to a `--color-*`, so the
> dark block and every palette re-skin them for free. **This spec mirrors that
> pattern: each token below names a `--color-*` base, not ten hand-tuned hexes.**

Confirmed the 10 palettes exist on `origin/main` (motir base + cobalt, graphite,
evergreen, spectrum, amber, sienna, garnet, citrine, candy) and that vivid ones
(spectrum/candy/graphite) set distinct `--color-success/warning/info/destructive/
accent*/tint-*` — so hue-based tokens stay legible everywhere.

**Two concrete-value exceptions** (not routed through `--color-*`, so they carry
explicit light + dark values, exactly like `--el-sidebar-item-bg-hover`):
`--el-overlay-scrim` (a black scrim, palette-independent). Everything else is a
`--color-*` mapping.

---

## 2. Backwards-compatible by construction (why this is low-risk)

Most target families are **already token-compliant** — they route through
`--el-tint-*` or a semantic `--el-*`; they are merely **collapsed onto shared
tokens**. So each new dedicated token **DEFAULTS to today's exact base** →
**zero visual change in the `motir` base palette**. The payoff is (a) per-palette
tunability, (b) semantic clarity, (c) decoupling shared tints. The migration is a
rename-with-same-value, not a re-colour.

**The only real bugs the sweep found (these DO change pixels — and should):**

1. **`StatusPicker` Tier-0 violation** — `components/issues/StatusPicker.tsx:19-26`
   sets the status dot via an inline `style` reading raw `--color-muted-foreground`
   / `--color-info` / `--color-accent-green`, **bypassing the `--el-*` swap layer**
   (so a palette can't move it). Fix: route through `--el-status-*`.
2. **`--el-type-*` misuse** (work-item-type hues borrowed for non-type meaning):
   - `app/(authed)/_components/NotificationRow.tsx:31-36` — `commented`→`--el-type-task`,
     `assigned`→`--el-type-story`, `transitioned`→`--el-type-subtask`.
   - `app/(authed)/_components/ProjectAvatar.tsx:121` — mono fallback tile →`--el-type-task`.
   - `app/(authed)/org/.../OrgUsageClient.tsx:224` — DeepSeek model →`--el-type-subtask`.
3. **`--el-vote-bg` defined-but-unused** — globals.css:2312 maps it to
   `--color-tint-lavender`, but `app/(public)/_components/PublicRoadmapVote.tsx:98`
   renders the resting vote button as `bg-(--el-page-bg)`. Wire the token.

---

## 3. AA contract (finding #35 — non-negotiable)

- A coloured **SURFACE** carries its own readable text token: `--el-*-surface`
  pairs with `--el-*-surface-text` = a strong ink (`--color-charcoal`,
  ≈10:1 on the pale tint, both themes). Never put body text on a hue fill.
- Colour is **never the sole cue** — status/priority/diff/notification all keep a
  redundant icon or text label (the existing `PRIORITY_META` direction icon, the
  `ReadinessBadge` glyph). A palette swap must not be able to erase meaning.
- Icon/UI hues clear **≥3:1**; text clears **≥4.5:1**. Verify numerically per
  palette (the per-palette `docs/palettes/<id>.md` AA tables), never by eye.
- Watch the known traps: `--el-text-inverted` flips on a non-flipping fill
  (use `--el-accent-text`); muted/faint text fails AA on the rail surface
  (sidebar captions use `--el-text-secondary`).

---

## 4. Don't-churn list (already gold-standard — leave untouched)

`--el-chart-*`, `--el-type-*` (the work-item KIND + NATURE ramps), `--el-build-*`,
`--el-vote-active-*` (the *token* — only its unused sibling gets wired),
`--el-roadmap-*`, `--el-public-banner-*`, `--el-hero-wash-*`, `--el-code-*`. These
already map cleanly to `--color-*` and re-skin correctly; the spec adds *around*
them.

---

## 5. The taxonomy

Each table: **token · `--color-*` base · current source (file:line) · note**.
"matches shipped" = the default reproduces today's pixels (zero-change migration);
"NEW (no impl)" = the surface isn't built yet, the token is defined ahead of it.

### A. Data hues — STATUS  → owned by **MOTIR-1273 (1266.2)**

Un-collapses the workflow statuses. Today the dot bypasses `--el-*` (bug #1) and
the filter bars map only by *category* (`--el-text-faint`/`--el-info`/`--el-success`),
so `in_review` is indistinguishable from `in_progress` and `blocked`/`cancelled`
inherit a wrong terminal colour. Defs: `lib/workflows/defaultWorkflow.ts:27-39`.

| Token | base | current source | note |
|---|---|---|---|
| `--el-status-todo` | `--color-stone` | StatusPicker `--color-muted-foreground` | neutral grey |
| `--el-status-in-progress` | `--color-info` | `--color-info` / `--el-info` | blue |
| `--el-status-in-review` | `--color-primary` | shares info-blue today | **differentiate** from in-progress |
| `--el-status-done` | `--color-success` | `--color-accent-green` / `--el-success` | green |
| `--el-status-blocked` | `--color-warning` | falls back to todo grey | **gap fixed** → amber |
| `--el-status-cancelled` | `--color-steel` | falls back to done green | **gap fixed** → terminal grey (not red — cancel ≠ error) |

Status **chip** bg = `color-mix(in srgb, var(--el-status-X) 14%, var(--el-surface))`
with `--el-text-strong`; the **dot/icon** uses the hue at full strength. Replaces
the `CATEGORY_VAR` inline-style in `StatusPicker.tsx` and the per-category maps in
`IssueFilterBar.tsx:60-64`, `AdvancedFilterValueEditor.tsx:66-70`, `AutomationParts.tsx:47-51`.

### B. Data hues — PRIORITY  → **MOTIR-1273 (1266.2)**

The headline collapse: `lib/issues/priorityMeta.ts:15-19` routes priority through
`Pill` `severity`/`tone`, so **`medium` AND `lowest` are both `neutral` grey** —
the exact "can't differentiate" complaint. A graded 5-step diverging ramp:

| Token | base | current (`priorityMeta.ts`) | note |
|---|---|---|---|
| `--el-priority-highest` | `--color-destructive` | `severity: danger` (rose) | red |
| `--el-priority-high` | `--color-warning` | `severity: warning` (peach) | orange |
| `--el-priority-medium` | `--color-slate` | `tone: neutral` (grey) | **un-collapsed** → mid slate |
| `--el-priority-low` | `--color-info` | `severity: info` (sky) | blue |
| `--el-priority-lowest` | `--color-stone` | `tone: neutral` (grey) | **un-collapsed** → faint stone |

`medium` (slate) vs `lowest` (stone) are now two distinct greys; keep the
`ArrowUp/Minus/ArrowDown` redundant icon (AA). 1273 may add a `priority` axis to
`Pill` or have `PRIORITY_META` reference these tokens directly.

### C. Semantic SURFACES (banner / callout backgrounds)  → **MOTIR-1273 (1266.2)**

Today only `--el-danger-surface` exists in spirit (`FormField.tsx:53` =
`--el-tint-rose`); warning/success/info have **borders only** (`Toast.tsx`), no fill.
Each = a tint base + a strong-ink text token (§3).

| Token | base | current source | note |
|---|---|---|---|
| `--el-danger-surface` / `-text` | `--color-tint-rose` / `--color-charcoal` | `FormField.tsx:53` | matches shipped |
| `--el-warning-surface` | `--color-tint-peach` | none (Toast border only) | NEW fill |
| `--el-success-surface` | `--color-tint-mint` | none (Toast border only) | NEW fill |
| `--el-notice-info-bg` / `-border` | `--color-tint-sky` / `--color-info` | `Toast.tsx:35` border | NEW fill + existing border |
| `--el-callout-bg` / `-text` | `--color-tint-lavender` / `--color-charcoal` | `CascadeBackBanner.tsx:28` (peach) | generic callout; banner may keep warning semantic |
| `--el-warning-text` | `--color-charcoal` | — | ink on the warning surface |

> If a palette's tint is too saturated to carry charcoal at AA, the surface may
> instead be `color-mix(in srgb, var(--color-<hue>) 14%, var(--el-surface))`; the
> code subtask verifies AA per palette and picks per token.

### D. Identity hues  → **MOTIR-1274 (1266.3)**

These are **already tint-compliant but collapsed** onto the six shared
`--el-tint-*` (so a label, a role, and an avatar can't diverge). Dedicated tokens
default to today's value (zero-change) and decouple the `--el-type-*` misuse.

**Roles / privacy** (today hardcoded in `Pill.tsx` CVA, lines 62-80):

| Token | base | current | note |
|---|---|---|---|
| `--el-role-admin` / `-member` / `-viewer` | `--color-tint-lavender` / `-sky` / `-mint` | `Pill memberRole` | matches shipped; lets workspace roles (today `tone="neutral"`, `MembersCard.tsx:131`) adopt the same hues |
| `--el-org-role-owner` / `-admin` / `-member` | `--color-tint-lavender` / `-sky` / `-mint` | `Pill orgRole` (`OrgMembersClient.tsx:356`) | matches shipped |
| `--el-privacy-private` / `-public` | `--color-tint-lavender` / `--color-tint-sky` | `Pill tone="private"` (epic-privacy) | private matches shipped; public = open/sky |

**Label + avatar ramps** (deterministic hash → tint):

| Token | base | current | note |
|---|---|---|---|
| `--el-label-1..6` | tint `peach,rose,mint,lavender,sky,yellow` (in order) | `lib/labels/labelTint.ts:15` `LABEL_TINTS` + `MultiSelectPicker` | hash `fnv1a(name)%6`→token; matches shipped |
| `--el-avatar-{peach,rose,mint,lavender,sky,yellow}` | matching tint | `ProjectAvatar.tsx:69-76`, `TriageAvatar.tsx:11-18` | **keep the named keys** — `lib/projects/avatar.ts` persists `project.avatarColor` ∈ these strings; numbering them (`1..N`) would break stored rows. Spec deviates from the card's "1..N" for **migration safety** (rung-2: `avatar.ts` is the DB contract). |
| `--el-avatar-fallback` | `--color-info` | `ProjectAvatar.tsx:121` (`--el-type-task`) | **fixes misuse #2** — mono initials tile keeps its blue, stops borrowing the type token |

**`--el-type-*` misuse decouple** (bug #2 — give each its own token):

| Token | base | current misuse | file:line |
|---|---|---|---|
| `--el-notif-mentioned` | `--color-accent` | (already `--el-accent` — alias for consistency) | `NotificationRow.tsx:31` |
| `--el-notif-commented` | `--color-info` | `--el-type-task` | `NotificationRow.tsx:32` |
| `--el-notif-assigned` | `--color-accent-green` | `--el-type-story` | `NotificationRow.tsx:33` |
| `--el-notif-transitioned` | `--color-accent-teal` | `--el-type-subtask` | `NotificationRow.tsx:34` |
| `--el-model-opus` / `-sonnet` / `-haiku` | `--color-accent` / `--color-info` / `--color-success` | (already `--el-*` — promote to a named family) | `OrgUsageClient.tsx:221-223` |
| `--el-model-deepseek` | `--color-accent-teal` | `--el-type-subtask` | `OrgUsageClient.tsx:224` |

### E. Icon + text roles  → **MOTIR-1275 (1266.4)**

Splits the `--el-text-muted` / `--el-text` triple-duty so an icon can be tuned
apart from body copy. All map to existing neutrals → zero-change defaults.

| Token | base | current source | note |
|---|---|---|---|
| `--el-icon-muted` | `--color-muted-foreground` | `Sidebar.tsx:191`, `Combobox.tsx:574`, `Modal.tsx:179` | inactive nav/chevron/close |
| `--el-icon-active` | `--color-primary` | `Sidebar.tsx:134` (`--el-accent-on-surface`) | active nav |
| `--el-icon-btn` | `--color-foreground` | `Button.tsx:88-96` (inherits) | usually `currentColor`; token for explicit cases |
| `--el-icon-heading` | `--color-charcoal` | (inherits heading) | icon beside a heading |
| `--el-icon-field` | `--color-muted-foreground` | `Input.tsx:70,88`, `DatePicker.tsx:266` | search/chevron/calendar in inputs |
| `--el-text-eyebrow` | `--color-muted-foreground` | `SectionLabel.tsx:35`, `Combobox.tsx:463` | uppercase mono overline |
| `--el-text-subtitle` | `--color-slate` | (Modal/EmptyState desc, `--el-text-secondary`) | lead paragraph |
| `--el-text-helper` | `--color-muted-foreground` | `FormField.tsx:60` | form hint |
| `--el-text-identifier` | `--color-slate` | `Combobox.tsx:488` | monospace `MOTIR-123` keys |

### F. Component-surface primitives  → **MOTIR-1275 (1266.4)**

| Token | base | current source | note |
|---|---|---|---|
| `--el-tooltip-bg` / `-text` | `--color-foreground` / `--color-background` | `Tooltip.tsx:44-52` | matches shipped (inverted) |
| `--el-switch-on` | `--color-primary-fill` | `Switch.tsx:55-66` (`--el-accent`) | checked track |
| `--el-switch-knob` | `--color-surface` | `Switch.tsx` knob | the thumb |
| `--el-option-active-bg` | `--color-muted` | `Combobox.tsx:479` (`--el-surface`) | highlighted option |
| `--el-overlay-scrim` | **concrete** `#00000066` (light) / `#000000a6` (dark) | `Modal.tsx:131` `bg-black/40` | the lone non-`--color-*` token here; carries explicit dark value |
| `--el-chip-bg` / `-border` | `--color-surface` / `--color-border` | `Pill.tsx` neutral tone | neutral chip (tinted chips keep their tint) |
| `--el-card` | `--color-background` | `Card.tsx:23` (`--el-page-bg`) | untinted card surface |
| `--el-input-border` | `--color-hairline-strong` | `Input.tsx:65` | input outline |
| `--el-button-border` | `--color-hairline-strong` | `Button.tsx:41` | secondary-button outline |
| `--el-count-bg` / `-text` | `--color-surface` / `--color-slate` | `Sidebar.tsx:62`, `Pill.tsx:76` | numeric count badge |

### G. Interaction / agile surfaces  → **MOTIR-1276 (1266.5)**

| Token | base | current source | note |
|---|---|---|---|
| `--el-selection-bg` | `--color-tint-sky` | none | **NEW** — selected row/card highlight (not impl) |
| `--el-droptarget-bg` | `--color-tint-lavender` | `BoardColumn.tsx:143-145` | matches shipped dnd drop-zone |
| `--el-board-column-accent` | `--color-primary` | `BoardColumn.tsx:142-146` (accent ring) | drop ring/border |
| `--el-overdue` | `--color-destructive` | none (`issueCellPrimitives.tsx:77-84` plain text) | **NEW** — past-due date |
| `--el-due-soon` | `--color-warning` | none | **NEW** — due within N days |
| `--el-sprint-accent` | `--color-tint-lavender` | `SprintHeader.tsx:59-60` emphasis | matches shipped |
| `--el-epic-accent` | `--color-accent` | `--el-type-epic` (globals 2241) | the pink epic identity |
| `--el-archived-pill-bg` / `-text` | `--color-muted` / `--color-slate` | `ProjectSwitcher.tsx:98-102` (`Pill neutral`) | inactive-state badge |
| `--el-auth-wash` | `--color-tint-sky` | none (`AuthShell.tsx` plain) | **NEW** — sign-in background wash (not impl) |
| `--el-tabnav-track` / `--el-tabnav-active` | `--color-surface` / `--color-primary` | `Segmented.tsx:59,85-87` | the de-facto tab primitive |
| `--el-card-icon-bg` / `-fg` | `--color-muted` / `--color-primary` | none | **NEW** — coloured icon tile on a hub/settings card (not impl) |
| `--el-vote-bg` *(exists)* | `--color-tint-lavender` | **unused** — `PublicRoadmapVote.tsx:98` uses `--el-page-bg` | **wire it** (bug #3) |

### H. Onboarding / canvas surfaces  → **MOTIR-1277 (1266.6)**

| Token | base | current source | note |
|---|---|---|---|
| `--el-diff-added` | `--color-tint-mint` | `RevisionDiff.tsx:50` | matches shipped |
| `--el-diff-removed` | `--color-tint-rose` | `RevisionDiff.tsx:51` | matches shipped |
| `--el-diff-moved` | `--color-tint-sky` | `RevisionDiff.tsx:52` ("changed") | matches shipped |
| `--el-chat-bubble-user` | `--color-primary-fill` | `DiscoveryChatRail.tsx:170` (`--el-accent`) | + text `--el-accent-text` |
| `--el-chat-bubble-ai` | `--color-surface-soft` | `DiscoveryChatRail.tsx:171` | + text `--el-text` |
| `--el-canvas-edge-pending` | `--color-border` | `PlanningCanvas.tsx:300` (dashed) | matches shipped |
| `--el-canvas-edge-committed` | `--color-hairline-strong` | `PlanningCanvas.tsx:300` (solid) | matches shipped |
| `--el-station-tier-{discovery,vision,feasibility,validation}` | tint `sky,lavender,mint,peach` | `StationNode.tsx:44-49` | **optional**; defaults match shipped tier tints |

> **⚠️ Card correction (rung-2).** The card says "wire existing `--el-roadmap-*`
> into StationNode." The sweep shows that is a **mismatch**: `StationNode.tsx:44-49`
> renders **onboarding TIER states** (Discovery/Vision/Feasibility/Validation) and
> StatePill states (done/deciding/active) — a different concept from the **public
> roadmap** states `--el-roadmap-{submitted,planned,progress,done}` (globals 2315-2318,
> used by the public projects view). **Do NOT force `--el-roadmap-*` onto StationNode.**
> Either leave StationNode on its tints (already compliant) or adopt the optional
> `--el-station-tier-*` tokens above. The `--el-roadmap-*` family stays scoped to
> the public roadmap. (No replan: the card's intent — give the canvas tunable
> tokens — is satisfied; only its token-reuse assumption was wrong.)

---

## 6. Per-subtask handoff (what each consumer implements)

Every subtask: add the token block to the `:root` layer in `app/globals.css`
**after** the existing `--el-*` groups, mirroring the chart/type comment style;
each token maps to a `--color-*` (so no per-palette block changes — §1); register
the new families in the `/tokens` reference route (`app/tokens/page.tsx`); migrate
the cited components off raw `--color-*` / wrong `--el-*` / hardcoded values; ship
a test that the swap layer holds (a palette swap moves the token). Concrete-value
tokens (`--el-overlay-scrim`) need a `[data-theme='dark']` companion.

| Subtask | Families (§) | Real fixes (pixel-changing) |
|---|---|---|
| **1273** (1266.2) | A status · B priority · C surfaces | StatusPicker Tier-0 violation; priority medium/lowest un-collapse |
| **1274** (1266.3) | D identity hues | `--el-type-*` misuse ×5 (NotificationRow, ProjectAvatar, OrgUsageClient); preserve avatar DB keys |
| **1275** (1266.4) | E icon/text roles · F surface primitives | split icon/text from body copy; `--el-overlay-scrim` dark companion |
| **1276** (1266.5) | G interaction/agile | wire unused `--el-vote-bg`; selection/overdue/auth-wash are NEW (define now, render when surface lands) |
| **1277** (1266.6) | H onboarding/canvas | `--el-roadmap-*` correction (don't force onto StationNode) |

## 7. Decisions resolved here (no user round-trip — `motir run` never asks)

1. **Avatar tokens keep named keys** (`peach…yellow`), not `1..N` — the keys are
   DB-persisted (`lib/projects/avatar.ts`). Migration safety over the card's wording.
2. **StationNode stays off `--el-roadmap-*`** — different semantic; §5H.
3. **`cancelled` = terminal grey, not red** — cancel is not an error.
4. **NEW (un-built) surfaces** (`selection`, `overdue`/`due-soon`, `auth-wash`,
   `card-icon`) — tokens are **defined now** so the eventual build has a home, but
   **not forced** onto a surface that doesn't render them yet.
5. **`--el-model-*` promoted to a named family** — folds in the bonus DeepSeek
   misuse so all four model colours are explicit, not ad-hoc `--el-*` reuse.
