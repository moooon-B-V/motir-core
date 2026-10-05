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
> `lowest` are _both_ grey, a status dot bypasses the swap layer entirely
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
> Its "value in palette X" _is_ whatever palette X already sets that `--color-*`
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
   - the project-avatar component's mono fallback tile →`--el-type-task`. (Its file is
     deliberately not addressed here: MOTIR-2679 DELETED that component, so a repo path
     would send the next reader looking for nothing. The fix below shipped first, and
     the `--el-avatar-fallback` tile it introduced now lives in
     `app/(authed)/settings/workspace/_components/gitSettingsPrimitives.tsx` and
     `app/(authed)/settings/project/code-access/_components/CodeAccessSettings.tsx`.)
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
`--el-vote-active-*` (the _token_ — only its unused sibling gets wired),
`--el-roadmap-*`, `--el-public-banner-*`, `--el-hero-wash-*`, `--el-code-*`. These
already map cleanly to `--color-*` and re-skin correctly; the spec adds _around_
them.

---

## 5. The taxonomy

Each table: **token · `--color-*` base · current source (file:line) · note**.
"matches shipped" = the default reproduces today's pixels (zero-change migration);
"NEW (no impl)" = the surface isn't built yet, the token is defined ahead of it.

### A. Data hues — STATUS → owned by **MOTIR-1273 (1266.2)**

Un-collapses the workflow statuses. Today the dot bypasses `--el-*` (bug #1) and
the filter bars map only by _category_ (`--el-text-faint`/`--el-info`/`--el-success`),
so `in_review` is indistinguishable from `in_progress` and `blocked`/`cancelled`
inherit a wrong terminal colour. Defs: `lib/workflows/defaultWorkflow.ts:27-39`.

| Token                     | base              | current source                          | note                                                     |
| ------------------------- | ----------------- | --------------------------------------- | -------------------------------------------------------- |
| `--el-status-todo`        | `--color-stone`   | StatusPicker `--color-muted-foreground` | neutral grey                                             |
| `--el-status-in-progress` | `--color-info`    | `--color-info` / `--el-info`            | blue                                                     |
| `--el-status-in-review`   | `--color-primary` | shares info-blue today                  | **differentiate** from in-progress                       |
| `--el-status-done`        | `--color-success` | `--color-accent-green` / `--el-success` | green                                                    |
| `--el-status-blocked`     | `--color-warning` | falls back to todo grey                 | **gap fixed** → amber                                    |
| `--el-status-cancelled`   | `--color-steel`   | falls back to done green                | **gap fixed** → terminal grey (not red — cancel ≠ error) |

Status **chip** bg = `color-mix(in srgb, var(--el-status-X) 14%, var(--el-surface))`
with `--el-text-strong`; the **dot/icon** uses the hue at full strength. Replaces
the `CATEGORY_VAR` inline-style in `StatusPicker.tsx` and the per-category maps in
`IssueFilterBar.tsx:60-64`, `AdvancedFilterValueEditor.tsx:66-70`, `AutomationParts.tsx:47-51`.

### B. Data hues — PRIORITY → **MOTIR-1273 (1266.2)**

The headline collapse: `lib/issues/priorityMeta.ts:15-19` routes priority through
`Pill` `severity`/`tone`, so **`medium` AND `lowest` are both `neutral` grey** —
the exact "can't differentiate" complaint. A graded 5-step diverging ramp:

| Token                   | base                  | current (`priorityMeta.ts`) | note                           |
| ----------------------- | --------------------- | --------------------------- | ------------------------------ |
| `--el-priority-highest` | `--color-destructive` | `severity: danger` (rose)   | red                            |
| `--el-priority-high`    | `--color-warning`     | `severity: warning` (peach) | orange                         |
| `--el-priority-medium`  | `--color-slate`       | `tone: neutral` (grey)      | **un-collapsed** → mid slate   |
| `--el-priority-low`     | `--color-info`        | `severity: info` (sky)      | blue                           |
| `--el-priority-lowest`  | `--color-stone`       | `tone: neutral` (grey)      | **un-collapsed** → faint stone |

`medium` (slate) vs `lowest` (stone) are now two distinct greys; keep the
`ArrowUp/Minus/ArrowDown` redundant icon (AA). 1273 may add a `priority` axis to
`Pill` or have `PRIORITY_META` reference these tokens directly.

### C. Semantic SURFACES (banner / callout backgrounds) → **MOTIR-1273 (1266.2)**

Today only `--el-danger-surface` exists in spirit (`FormField.tsx:53` =
`--el-tint-rose`); warning/success/info have **borders only** (`Toast.tsx`), no fill.
Each = a tint base + a strong-ink text token (§3).

| Token                             | base                                         | current source                     | note                                              |
| --------------------------------- | -------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| `--el-danger-surface` / `-text`   | `--color-tint-rose` / `--color-charcoal`     | `FormField.tsx:53`                 | matches shipped                                   |
| `--el-warning-surface`            | `--color-tint-peach`                         | none (Toast border only)           | NEW fill                                          |
| `--el-success-surface`            | `--color-tint-mint`                          | none (Toast border only)           | NEW fill                                          |
| `--el-notice-info-bg` / `-border` | `--color-tint-sky` / `--color-info`          | `Toast.tsx:35` border              | NEW fill + existing border                        |
| `--el-callout-bg` / `-text`       | `--color-tint-lavender` / `--color-charcoal` | `CascadeBackBanner.tsx:28` (peach) | generic callout; banner may keep warning semantic |
| `--el-warning-text`               | `--color-charcoal`                           | —                                  | ink on the warning surface                        |

> If a palette's tint is too saturated to carry charcoal at AA, the surface may
> instead be `color-mix(in srgb, var(--color-<hue>) 14%, var(--el-surface))`; the
> code subtask verifies AA per palette and picks per token.

### D. Identity hues → **MOTIR-1274 (1266.3)**

These are **already tint-compliant but collapsed** onto the six shared
`--el-tint-*` (so a label, a role, and an avatar can't diverge). Dedicated tokens
default to today's value (zero-change) and decouple the `--el-type-*` misuse.

**Roles / privacy** (today hardcoded in `Pill.tsx` CVA, lines 62-80):

| Token                                        | base                                         | current                                     | note                                                                                                      |
| -------------------------------------------- | -------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--el-role-admin` / `-member` / `-viewer`    | `--color-tint-lavender` / `-sky` / `-mint`   | `Pill memberRole`                           | matches shipped; lets workspace roles (today `tone="neutral"`, `MembersCard.tsx:131`) adopt the same hues |
| `--el-org-role-owner` / `-admin` / `-member` | `--color-tint-lavender` / `-sky` / `-mint`   | `Pill orgRole` (`OrgMembersClient.tsx:356`) | matches shipped                                                                                           |
| `--el-privacy-private` / `-public`           | `--color-tint-lavender` / `--color-tint-sky` | `Pill tone="private"` (epic-privacy)        | private matches shipped; public = open/sky                                                                |

**Label + avatar ramps** (deterministic hash → tint):

| Token                                               | base                                                  | current                                                                 | note                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--el-label-1..6`                                   | tint `peach,rose,mint,lavender,sky,yellow` (in order) | `lib/labels/labelTint.ts:15` `LABEL_TINTS` + `MultiSelectPicker`        | hash `fnv1a(name)%6`→token; matches shipped                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--el-avatar-{peach,rose,mint,lavender,sky,yellow}` | matching tint                                         | `app/(authed)/triage/_components/TriageAvatar.tsx:20-27`                | **keep the named keys.** As written, for **migration safety** — a project column persisted the colour key. MOTIR-2680 dropped that column and MOTIR-2679 deleted `ProjectAvatar`, so the ramp is now PERSON-avatar only; the keys stay because `TriageAvatar` hashes a name onto them BY NAME and they are 1:1 with `--el-label-1..6`. Same conclusion, a different reason — recorded so the next reader does not restore a numbering the DB no longer forbids. |
| `--el-avatar-fallback`                              | `--color-info`                                        | `app/(authed)/settings/workspace/_components/gitSettingsPrimitives.tsx` | **fixes misuse #2** — the initials tile keeps its blue, stops borrowing the type token. Cited against `ProjectAvatar.tsx:121` when written; that component is gone (MOTIR-2679) and the tile's surviving consumers are this file and `CodeAccessSettings.tsx`.                                                                                                                                                                                                  |

**`--el-type-*` misuse decouple** (bug #2 — give each its own token):

| Token                                    | base                                                  | current misuse                                  | file:line                    |
| ---------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- | ---------------------------- |
| `--el-notif-mentioned`                   | `--color-accent`                                      | (already `--el-accent` — alias for consistency) | `NotificationRow.tsx:31`     |
| `--el-notif-commented`                   | `--color-info`                                        | `--el-type-task`                                | `NotificationRow.tsx:32`     |
| `--el-notif-assigned`                    | `--color-accent-green`                                | `--el-type-story`                               | `NotificationRow.tsx:33`     |
| `--el-notif-transitioned`                | `--color-accent-teal`                                 | `--el-type-subtask`                             | `NotificationRow.tsx:34`     |
| `--el-model-opus` / `-sonnet` / `-haiku` | `--color-accent` / `--color-info` / `--color-success` | (already `--el-*` — promote to a named family)  | `OrgUsageClient.tsx:221-223` |
| `--el-model-deepseek`                    | `--color-accent-teal`                                 | `--el-type-subtask`                             | `OrgUsageClient.tsx:224`     |

### E. Icon + text roles → **MOTIR-1275 (1266.4)**

Splits the `--el-text-muted` / `--el-text` triple-duty so an icon can be tuned
apart from body copy. All map to existing neutrals → zero-change defaults.

| Token                  | base                       | current source                                         | note                                             |
| ---------------------- | -------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `--el-icon-muted`      | `--color-muted-foreground` | `Sidebar.tsx:191`, `Combobox.tsx:574`, `Modal.tsx:179` | inactive nav/chevron/close                       |
| `--el-icon-active`     | `--color-primary`          | `Sidebar.tsx:134` (`--el-accent-on-surface`)           | active nav                                       |
| `--el-icon-btn`        | `--color-foreground`       | `Button.tsx:88-96` (inherits)                          | usually `currentColor`; token for explicit cases |
| `--el-icon-heading`    | `--color-charcoal`         | (inherits heading)                                     | icon beside a heading                            |
| `--el-icon-field`      | `--color-muted-foreground` | `Input.tsx:70,88`, `DatePicker.tsx:266`                | search/chevron/calendar in inputs                |
| `--el-text-eyebrow`    | `--color-muted-foreground` | `SectionLabel.tsx:35`, `Combobox.tsx:463`              | uppercase mono overline                          |
| `--el-text-subtitle`   | `--color-slate`            | (Modal/EmptyState desc, `--el-text-secondary`)         | lead paragraph                                   |
| `--el-text-helper`     | `--color-muted-foreground` | `FormField.tsx:60`                                     | form hint                                        |
| `--el-text-identifier` | `--color-slate`            | `Combobox.tsx:488`                                     | monospace `MOTIR-123` keys                       |

### F. Component-surface primitives → **MOTIR-1275 (1266.4)**

| Token                       | base                                                  | current source                      | note                                                                  |
| --------------------------- | ----------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `--el-tooltip-bg` / `-text` | `--color-foreground` / `--color-background`           | `Tooltip.tsx:44-52`                 | matches shipped (inverted)                                            |
| `--el-switch-on`            | `--color-primary-fill`                                | `Switch.tsx:55-66` (`--el-accent`)  | checked track                                                         |
| `--el-switch-on-border`     | `--color-primary`                                     | `Switch.tsx` track border, ON       | the ON edge on `--el-page-bg` — ≥ 3:1 in all 20 pairs (MOTIR-5715)    |
| `--el-switch-off-border`    | `--color-muted-foreground`                            | `Switch.tsx` track border, OFF      | the OFF edge on `--el-page-bg` — ≥ 3:1 in all 20 pairs (MOTIR-5725)   |
| `--el-switch-knob`          | `--color-primary-foreground`                          | `Switch.tsx` knob, ON               | the ON thumb — the fill's own ink (was `--color-surface`, MOTIR-5711) |
| `--el-switch-knob-off`      | `--color-muted-foreground`                            | `Switch.tsx` knob, OFF              | the OFF thumb on `--el-muted` — ≥ 3:1 in all 20 pairs (MOTIR-5711)    |
| `--el-option-active-bg`     | `--color-muted`                                       | `Combobox.tsx:479` (`--el-surface`) | highlighted option                                                    |
| `--el-overlay-scrim`        | **concrete** `#00000066` (light) / `#000000a6` (dark) | `Modal.tsx:131` `bg-black/40`       | the lone non-`--color-*` token here; carries explicit dark value      |
| `--el-chip-bg` / `-border`  | `--color-surface` / `--color-border`                  | `Pill.tsx` neutral tone             | neutral chip (tinted chips keep their tint)                           |
| `--el-card`                 | `--color-background`                                  | `Card.tsx:23` (`--el-page-bg`)      | untinted card surface                                                 |
| `--el-input-border`         | `--color-hairline-strong`                             | `Input.tsx:65`                      | input outline                                                         |
| `--el-button-border`        | `--color-hairline-strong`                             | `Button.tsx:41`                     | secondary-button outline                                              |
| `--el-count-bg` / `-text`   | `--color-surface` / `--color-slate`                   | `Sidebar.tsx:62`, `Pill.tsx:76`     | numeric count badge                                                   |

### G. Interaction / agile surfaces → **MOTIR-1276 (1266.5)**

| Token                                      | base                                  | current source                                              | note                                                           |
| ------------------------------------------ | ------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `--el-selection-bg`                        | `--color-tint-sky`                    | none                                                        | **NEW** — selected row/card highlight (not impl)               |
| `--el-droptarget-bg`                       | `--color-tint-lavender`               | `BoardColumn.tsx:143-145`                                   | matches shipped dnd drop-zone                                  |
| `--el-board-column-accent`                 | `--color-primary`                     | `BoardColumn.tsx:142-146` (accent ring)                     | drop ring/border                                               |
| `--el-overdue`                             | `--color-destructive`                 | none (`issueCellPrimitives.tsx:77-84` plain text)           | **NEW** — past-due date                                        |
| `--el-due-soon`                            | `--color-warning`                     | none                                                        | **NEW** — due within N days                                    |
| `--el-sprint-accent`                       | `--color-tint-lavender`               | `SprintHeader.tsx:59-60` emphasis                           | matches shipped                                                |
| `--el-epic-accent`                         | `--color-accent`                      | `--el-type-epic` (globals 2241)                             | the pink epic identity                                         |
| `--el-archived-pill-bg` / `-text`          | `--color-muted` / `--color-slate`     | `ProjectSwitcher.tsx:98-102` (`Pill neutral`)               | inactive-state badge                                           |
| `--el-auth-wash`                           | `--color-tint-sky`                    | none (`AuthShell.tsx` plain)                                | **NEW** — sign-in background wash (not impl)                   |
| `--el-tabnav-track` / `--el-tabnav-active` | `--color-surface` / `--color-primary` | `Segmented.tsx:59,85-87`                                    | the de-facto tab primitive                                     |
| `--el-card-icon-bg` / `-fg`                | `--color-muted` / `--color-primary`   | none                                                        | **NEW** — coloured icon tile on a hub/settings card (not impl) |
| `--el-vote-bg` _(exists)_                  | `--color-tint-lavender`               | **unused** — `PublicRoadmapVote.tsx:98` uses `--el-page-bg` | **wire it** (bug #3)                                           |

### H. Onboarding / canvas surfaces → **MOTIR-1277 (1266.6)**

| Token                                                         | base                           | current source                              | note                                            |
| ------------------------------------------------------------- | ------------------------------ | ------------------------------------------- | ----------------------------------------------- |
| `--el-diff-added`                                             | `--color-tint-mint`            | `RevisionDiff.tsx:50`                       | matches shipped                                 |
| `--el-diff-removed`                                           | `--color-tint-rose`            | `RevisionDiff.tsx:51`                       | matches shipped                                 |
| `--el-diff-moved`                                             | `--color-tint-sky`             | `RevisionDiff.tsx:52` ("changed")           | matches shipped                                 |
| `--el-chat-bubble-user`                                       | `--color-primary-fill`         | `DiscoveryChatRail.tsx:170` (`--el-accent`) | + text `--el-accent-text`                       |
| `--el-chat-bubble-ai`                                         | `--color-surface-soft`         | `DiscoveryChatRail.tsx:171`                 | + text `--el-text`                              |
| `--el-canvas-edge-pending`                                    | `--color-border`               | `PlanningCanvas.tsx:300` (dashed)           | matches shipped                                 |
| `--el-canvas-edge-committed`                                  | `--color-hairline-strong`      | `PlanningCanvas.tsx:300` (solid)            | matches shipped                                 |
| `--el-station-tier-{discovery,vision,feasibility,validation}` | tint `sky,lavender,mint,peach` | `StationNode.tsx:44-49`                     | **optional**; defaults match shipped tier tints |

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

| Subtask           | Families (§)                             | Real fixes (pixel-changing)                                                                             |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **1273** (1266.2) | A status · B priority · C surfaces       | StatusPicker Tier-0 violation; priority medium/lowest un-collapse                                       |
| **1274** (1266.3) | D identity hues                          | `--el-type-*` misuse ×5 (NotificationRow, ProjectAvatar, OrgUsageClient); preserve avatar DB keys       |
| **1275** (1266.4) | E icon/text roles · F surface primitives | split icon/text from body copy; `--el-overlay-scrim` dark companion                                     |
| **1276** (1266.5) | G interaction/agile                      | wire unused `--el-vote-bg`; selection/overdue/auth-wash are NEW (define now, render when surface lands) |
| **1277** (1266.6) | H onboarding/canvas                      | `--el-roadmap-*` correction (don't force onto StationNode)                                              |

## 7. Decisions resolved here (no user round-trip — `motir run` never asks)

1. **Avatar tokens keep named keys** (`peach…yellow`), not `1..N` — the keys are
   DB-persisted at the time (a project colour column, dropped by MOTIR-2680).
   Migration safety over the card's wording; see the token table for why the named
   keys still stand now that the column does not.
2. **StationNode stays off `--el-roadmap-*`** — different semantic; §5H.
3. **`cancelled` = terminal grey, not red** — cancel is not an error.
4. **NEW (un-built) surfaces** (`selection`, `overdue`/`due-soon`, `auth-wash`,
   `card-icon`) — tokens are **defined now** so the eventual build has a home, but
   **not forced** onto a surface that doesn't render them yet.
5. **`--el-model-*` promoted to a named family** — folds in the bonus DeepSeek
   misuse so all four model colours are explicit, not ad-hoc `--el-*` reuse.

---

## 8. Warm touches in the default Motir palette (MOTIR-7583)

**Amends:** the `[data-palette='motir']` light block and its dark companion in
`packages/design-system/theme.css`, and the role reference `docs/palettes/motir.md`. It
re-draws the `--el-*` showcase rows that move — `design/design-system/element-tokens.mock.html`
is the base; the delta is `design/design-system/element-tokens--motir-warm-touches.mock.html`.
The board surfaces are drawn in `design/boards/board--motir-warm-touches.mock.html` (base
`design/boards/board.mock.html`, cited from `design/boards/design-notes.md`). Neither base is edited.

**What it decides.** Motir keeps its monochrome identity and gains two warm touches on
DECORATIVE roles only: a warm ORANGE (the highlight, Epic, progress, chart segment 6) and a CITRINE gold
for Design — borrowed from the Citrine palette's own documented Mirotone steps, so Design gets its own
hue instead of sharing Epic's. The change is three Tier-0 values per theme, one Tier-3 value the motir
blocks set directly (`--el-type-design`, as Citrine itself sets `--el-sidebar-item-bg-hover`) and two
new Tier-3 roles; every other `--color-*` in the motir
blocks, and every other palette, is untouched.

**Revision 2 (2026-10-05).** The first version (evidence `cmuufps5w00gmhwoithztvrn6`) was sent back
with _"I want to add "citrine" color too"_. This revision adds citrine as the Design hue — §8.1, the
citrine matrix in §8.3, and §8.7. Nothing else moved.

### 8.1 The role table (recommended intensity: SUBTLE)

| role                                                                                                                                                               | light: today → proposed     | dark: today → proposed      | how it moves                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-accent`                                                                                                                                                   | `#2563c9` → **`#d66000`**   | `#5b9dff` → **`#fa5500`**   | the source the six roles below read                                                                                                                                                                               |
| `--el-highlight`                                                                                                                                                   | `#2563c9` → `#d66000`       | `#5b9dff` → `#fa5500`       | rides `--color-accent`                                                                                                                                                                                            |
| `--el-type-epic` · `--el-epic-accent`                                                                                                                              | `#2563c9` → `#d66000`       | `#5b9dff` → `#fa5500`       | rides `--color-accent`                                                                                                                                                                                            |
| `--el-type-design`                                                                                                                                                 | `#2563c9` → **`#91771e`**   | `#5b9dff` → **`#ffd02f`**   | **citrine** — set directly in both motir blocks (Mirotone `yellow-650` light / Sunglow `yellow-500` dark, the Citrine palette's own steps); the base keeps `var(--color-accent)`, so other palettes are untouched |
| `--el-chart-cat-6`                                                                                                                                                 | `#2563c9` → `#d66000`       | `#5b9dff` → `#fa5500`       | rides `--color-accent`                                                                                                                                                                                            |
| `--el-progress-fill` — **NEW**                                                                                                                                     | `#1a1d21` (ink) → `#d66000` | `#edeef0` (ink) → `#fa5500` | base `var(--color-primary-fill)`; motir overrides to `var(--color-accent)`                                                                                                                                        |
| `--el-editor-focus` — **NEW**                                                                                                                                      | `#2563c9` → `#155bc4`       | `#5b9dff` → `#7db1ff`       | base `var(--color-accent)`; motir overrides to `var(--color-primary)` — keeps the editor's focus BLUE                                                                                                             |
| `--color-tint-peach`                                                                                                                                               | `#f7e6d6` → **`#fde0c8`**   | `#2e2418` → **`#36230f`**   | source of the peach roles below                                                                                                                                                                                   |
| `--el-tint-peach` · `--el-warning-surface` · `--el-role-custom` · `--el-label-1` · `--el-avatar-peach` · `--el-roadmap-submitted` · `--el-station-tier-validation` | `#f7e6d6` → `#fde0c8`       | `#2e2418` → `#36230f`       | ride `--color-tint-peach`                                                                                                                                                                                         |
| `--color-tint-yellow`                                                                                                                                              | `#f6f1d6` → **`#fdf0c6`**   | `#2a2716` → **`#302a12`**   | source of the yellow roles below                                                                                                                                                                                  |
| `--el-tint-yellow` · `--el-label-6` · `--el-avatar-yellow`                                                                                                         | `#f6f1d6` → `#fdf0c6`       | `#2a2716` → `#302a12`       | ride `--color-tint-yellow`                                                                                                                                                                                        |

That list is COMPLETE: it is every `--el-*` token whose resolved value moves, computed by resolving
the whole token layer with `tests/theme/paletteCascade.ts` (the resolver every palette suite uses)
before and after the three Tier-0 edits — 15 roles per theme — plus the two new roles and the citrine
`--el-type-design` override (which takes Design out of the orange group).

**Identity roles that deliberately do NOT change** (light / dark, both unchanged):

| role                                                                                                        | value                                         | why it stays                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--color-primary-fill` → `--el-accent` (the ink CTA, e.g. **Create**)                                       | `#1a1d21` / `#edeef0`                         | the monochrome statement                                                                                   |
| `--color-primary-foreground` → `--el-accent-text`                                                           | `#ffffff` / `#0c0d0f`                         | ink-CTA label                                                                                              |
| `--color-primary` → `--el-accent-on-surface`, `--focus-ring-color`, `--el-status-in-review` source          | `#155bc4` / `#7db1ff`                         | links / active / selected / focus stay the cool blue                                                       |
| `--color-link` · `--color-link-pressed`                                                                     | `#155bc4` · `#114a9e` / `#7db1ff` · `#a3c8ff` | links                                                                                                      |
| `--color-info` → `--el-status-in-progress`, `--el-type-task`, `--el-type-code`, `--el-avatar-fallback`      | `#155bc4` / `#7db1ff`                         | the blue in-progress column and the fallback avatar tile                                                   |
| `--el-selection-bg` (`--color-tint-sky`)                                                                    | `#dde9f6` / `#15233a`                         | the selected-row wash                                                                                      |
| surfaces, ink, borders (`--color-background` … `--color-border`)                                            | unchanged                                     | cool slate                                                                                                 |
| **sidebar brand tile** (`--el-accent` fill, `--el-accent-text` mark)                                        | `#1a1d21` / `#edeef0`                         | **stays ink** — the brand mark, tab icon, app icons, emails and Stripe colours are fixed ink by MOTIR-6473 |
| Settings › Appearance › Palette swatch (`PALETTE_SWATCH_HEX.motir`)                                         | `#1a1d21`                                     | the swatch is the ink CTA fill; Motir stays first and selected                                             |
| `--color-warning` / `--color-accent-orange`, `--el-priority-high`, `--color-destructive`, `--color-success` | unchanged                                     | the neighbours the new hue was measured against                                                            |

### 8.2 Why these hexes — and why not the review's starting values

The review proposed `#F26100` light / `#FF7A1A` dark. Both fail a floor, so neither is carried:

- **`#F26100` (light)** clears ΔE 14.0 from the burnt-orange warning but is only **2.84:1 on
  `--el-surface`, 2.64 on `--el-canvas`, 2.63 on the selected row and 2.75 on its own chip** — under
  the 3.0 a glyph needs.
- **`#FF7A1A` (dark)** is **ΔE 5.5** from the dark warning orange `#f08a4b` — an Epic would read as
  a warning.

In light, the orange has to sit between `--color-warning` `#c2410c` (Review, Verification, Blocked)
and the amber `--el-priority-high` `#ab6400`, and stay ≥3.0 on every surface. A grid search over
orange hues (HSL 10–45°) found that slot to be narrow: `#d66000` is equidistant from both
(ΔE 11.0 / 11.0) and is ≥3.08:1 everywhere. In dark the neighbour is one light orange, so a deeper,
redder orange clears it: `#fa5500` is ΔE 11.5 from it and ≥4.77:1 on every dark surface. Both are the
Base44 orange family (`#FF6A00`), tuned to their bar.

### 8.3 The measurement matrix

Computed from RESOLVED values (the resolver above, the proposal applied), CIEDE2000 and WCAG 2.x
relative luminance, with the maths of `tests/theme/colorMetrics.ts`. Floors: **ΔE 10** for a hue that
is a glyph's only carrier (the status-dot bar of `statusHueSeparation.test.ts`, which
`familyHueSeparation.test.ts` applies to every glyph family), **3.0:1** for an icon / UI mark, **4.5:1**
for text. The new hue is never text (it paints icons, chip glyphs, the progress fill, chart segments
and glows), so 3.0 is its bar; every TEXT pair on a changed tint is measured against 4.5 in §8.4.

#### light — new accent `#d66000` (`--color-accent` → `--el-highlight` / `--el-type-epic` / `--el-epic-accent` / `--el-chart-cat-6` / proposed `--el-progress-fill`)

| neighbour (resolved)                                                                                                                                            | hex       | ΔE2000 | floor | clears |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------ | ----- | ------ |
| `--el-warning` · `--el-status-blocked` · `--el-type-review` · `--el-type-verification`                                                                          | `#c2410c` | 11.0   | 10    | ✓      |
| `--el-priority-high`                                                                                                                                            | `#ab6400` | 11.0   | 10    | ✓      |
| `--el-danger` · `--el-priority-highest` · `--el-type-bug` · `--el-type-deploy`                                                                                  | `#c92a2a` | 19.5   | 10    | ✓      |
| `--el-status-todo` · `--el-priority-lowest` · `--el-type-manual`                                                                                                | `#8a8f98` | 32.7   | 10    | ✓      |
| `--el-status-cancelled`                                                                                                                                         | `#6b7079` | 33.5   | 10    | ✓      |
| `--el-priority-medium` · `--el-type-chore`                                                                                                                      | `#565c64` | 36.2   | 10    | ✓      |
| `--el-status-implemented` · `--el-type-decision` · `--el-type-legal` · `--el-type-choice`                                                                       | `#20242a` | 46.1   | 10    | ✓      |
| `--el-status-planning` · `--el-type-subtask` · `--el-type-content` · `--el-type-copy` · `--el-type-translate`                                                   | `#0e8f86` | 49.5   | 10    | ✓      |
| `--el-status-approved`                                                                                                                                          | `#17382b` | 49.8   | 10    | ✓      |
| `--el-status-done`                                                                                                                                              | `#197245` | 52.0   | 10    | ✓      |
| `--el-link` · `--el-info` · `--el-status-in-progress` · `--el-priority-low` · `--el-type-task` · `--el-type-code` · `--el-type-research` · `--focus-ring-color` | `#155bc4` | 52.3   | 10    | ✓      |
| `--el-status-in-review`                                                                                                                                         | `#113264` | 52.8   | 10    | ✓      |
| `--el-success` · `--el-type-story` · `--el-type-test`                                                                                                           | `#18804a` | 52.8   | 10    | ✓      |

| surface (light)                     | hex       | contrast | floor (icon/UI) | clears |
| ----------------------------------- | --------- | -------- | --------------- | ------ |
| page / card `--el-page-bg`          | `#ffffff` | 3.80     | 3.0             | ✓      |
| surface `--el-surface`              | `#eef0f3` | 3.32     | 3.0             | ✓      |
| surface-soft `--el-surface-soft`    | `#f8f9fa` | 3.60     | 3.0             | ✓      |
| muted (progress track) `--el-muted` | `#eef0f3` | 3.32     | 3.0             | ✓      |
| canvas `--el-canvas`                | `#e6e8ed` | 3.10     | 3.0             | ✓      |
| selected row `--el-selection-bg`    | `#dde9f6` | 3.08     | 3.0             | ✓      |
| its own type chip (14% over page)   | `#f9e9db` | 3.20     | 3.0             | ✓      |

#### dark — new accent `#fa5500` (`--color-accent` → `--el-highlight` / `--el-type-epic` / `--el-epic-accent` / `--el-chart-cat-6` / proposed `--el-progress-fill`)

| neighbour (resolved)                                                                                                                                            | hex       | ΔE2000 | floor | clears |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------ | ----- | ------ |
| `--el-warning` · `--el-status-blocked` · `--el-priority-high` · `--el-type-review` · `--el-type-verification`                                                   | `#f08a4b` | 11.5   | 10    | ✓      |
| `--el-danger` · `--el-priority-highest` · `--el-type-bug` · `--el-type-deploy`                                                                                  | `#d83847` | 19.9   | 10    | ✓      |
| `--el-status-cancelled`                                                                                                                                         | `#888d96` | 34.0   | 10    | ✓      |
| `--el-priority-medium` · `--el-type-chore`                                                                                                                      | `#a9adb5` | 34.7   | 10    | ✓      |
| `--el-status-todo` · `--el-priority-lowest` · `--el-type-manual`                                                                                                | `#696e77` | 36.2   | 10    | ✓      |
| `--el-status-implemented` · `--el-type-decision` · `--el-type-legal` · `--el-type-choice`                                                                       | `#d7d9dd` | 37.9   | 10    | ✓      |
| `--el-status-in-review`                                                                                                                                         | `#c2e6ff` | 49.8   | 10    | ✓      |
| `--el-link` · `--el-info` · `--el-status-in-progress` · `--el-priority-low` · `--el-type-task` · `--el-type-code` · `--el-type-research` · `--focus-ring-color` | `#7db1ff` | 50.0   | 10    | ✓      |
| `--el-status-approved`                                                                                                                                          | `#b5dec9` | 50.4   | 10    | ✓      |
| `--el-status-planning` · `--el-type-subtask` · `--el-type-content` · `--el-type-copy` · `--el-type-translate`                                                   | `#2db6a8` | 57.3   | 10    | ✓      |
| `--el-status-done`                                                                                                                                              | `#4cbd7f` | 62.2   | 10    | ✓      |
| `--el-success` · `--el-type-story` · `--el-type-test`                                                                                                           | `#34b86e` | 64.1   | 10    | ✓      |

| surface (dark)                      | hex       | contrast | floor (icon/UI) | clears |
| ----------------------------------- | --------- | -------- | --------------- | ------ |
| page / card `--el-page-bg`          | `#0c0d0f` | 5.89     | 3.0             | ✓      |
| surface `--el-surface`              | `#18191c` | 5.33     | 3.0             | ✓      |
| surface-soft `--el-surface-soft`    | `#141517` | 5.54     | 3.0             | ✓      |
| muted (progress track) `--el-muted` | `#18191c` | 5.33     | 3.0             | ✓      |
| canvas `--el-canvas`                | `#08090b` | 6.04     | 3.0             | ✓      |
| selected row `--el-selection-bg`    | `#15233a` | 4.77     | 3.0             | ✓      |
| its own type chip (14% over page)   | `#2d170d` | 5.13     | 3.0             | ✓      |

Every row clears. The tightest figures are the light orange's ΔE 11.0 from the warning and the amber
(both 1.0 over the floor) and its 3.08:1 on the selected row — the slot is narrow by construction, and
these are its middle, not its edge.

**Citrine — the Design hue.** Design takes the Citrine palette's gold, using a documented step on
each side rather than an invented one: light needs a deep gold to reach 3:1 on the selected row (the
Sunglow `#ffd02f` itself is 1.19:1 on white), and dark can carry Sunglow itself. Measured against
every glyph hue, the new orange included:

#### light — citrine `#91771e` (Mirotone `yellow-650`, Citrine’s own `--color-warning` / `--color-accent-orange` step) → `--el-type-design`

| neighbour (resolved)                                                                   | hex       | ΔE2000 | floor | clears |
| -------------------------------------------------------------------------------------- | --------- | ------ | ----- | ------ |
| `--el-priority-high`                                                                   | `#ab6400` | 14.0   | 10    | ✓      |
| `--el-highlight` · `--el-type-epic`                                                    | `#d66000` | 23.8   | 10    | ✓      |
| `--el-success` · `--el-type-story` · `--el-type-test`                                  | `#18804a` | 28.5   | 10    | ✓      |
| `--el-warning` · `--el-status-blocked` · `--el-type-review` · `--el-type-verification` | `#c2410c` | 28.9   | 10    | ✓      |
| `--el-status-done`                                                                     | `#197245` | 28.9   | 10    | ✓      |
| `--el-status-cancelled`                                                                | `#6b7079` | 29.3   | 10    | ✓      |
| `--el-status-todo` · `--el-priority-lowest` · `--el-type-manual`                       | `#8a8f98` | 29.9   | 10    | ✓      |
| `--el-priority-medium` · `--el-type-chore`                                             | `#565c64` | 32.4   | 10    | ✓      |
| … every other glyph hue                                                                |           | ≥ 33.9 | 10    | ✓      |

| surface (light)                   | hex       | contrast | floor (icon/UI) | clears |
| --------------------------------- | --------- | -------- | --------------- | ------ |
| page / card `--el-page-bg`        | `#ffffff` | 4.32     | 3.0             | ✓      |
| surface `--el-surface`            | `#eef0f3` | 3.78     | 3.0             | ✓      |
| surface-soft `--el-surface-soft`  | `#f8f9fa` | 4.10     | 3.0             | ✓      |
| muted `--el-muted`                | `#eef0f3` | 3.78     | 3.0             | ✓      |
| canvas `--el-canvas`              | `#e6e8ed` | 3.52     | 3.0             | ✓      |
| selected row `--el-selection-bg`  | `#dde9f6` | 3.51     | 3.0             | ✓      |
| its own type chip (14% over page) | `#f0ecdf` | 3.66     | 3.0             | ✓      |

`--el-text-strong` on the citrine chip: 13.19. Chip wash vs the orange Epic chip ΔE 5.6, vs the amber High chip ΔE 2.8, vs Review ΔE 8.2 (duplicate floor 2).

#### dark — citrine `#ffd02f` (Miro Sunglow, Mirotone `yellow-500`, Citrine’s `--color-primary-fill`) → `--el-type-design`

| neighbour (resolved)                                                                                          | hex       | ΔE2000 | floor | clears |
| ------------------------------------------------------------------------------------------------------------- | --------- | ------ | ----- | ------ |
| `--el-warning` · `--el-status-blocked` · `--el-priority-high` · `--el-type-review` · `--el-type-verification` | `#f08a4b` | 27.5   | 10    | ✓      |
| `--el-status-implemented` · `--el-type-decision` · `--el-type-legal` · `--el-type-choice`                     | `#d7d9dd` | 30.8   | 10    | ✓      |
| `--el-status-approved`                                                                                        | `#b5dec9` | 30.8   | 10    | ✓      |
| `--el-priority-medium` · `--el-type-chore`                                                                    | `#a9adb5` | 34.7   | 10    | ✓      |
| `--el-status-done`                                                                                            | `#4cbd7f` | 35.9   | 10    | ✓      |
| `--el-success` · `--el-type-story` · `--el-type-test`                                                         | `#34b86e` | 36.7   | 10    | ✓      |
| `--el-highlight` · `--el-type-epic`                                                                           | `#fa5500` | 38.4   | 10    | ✓      |
| `--el-status-cancelled`                                                                                       | `#888d96` | 39.4   | 10    | ✓      |
| … every other glyph hue                                                                                       |           | ≥ 41.3 | 10    | ✓      |

| surface (dark)                    | hex       | contrast | floor (icon/UI) | clears |
| --------------------------------- | --------- | -------- | --------------- | ------ |
| page / card `--el-page-bg`        | `#0c0d0f` | 13.25    | 3.0             | ✓      |
| surface `--el-surface`            | `#18191c` | 11.98    | 3.0             | ✓      |
| surface-soft `--el-surface-soft`  | `#141517` | 12.45    | 3.0             | ✓      |
| muted `--el-muted`                | `#18191c` | 11.98    | 3.0             | ✓      |
| canvas `--el-canvas`              | `#08090b` | 13.58    | 3.0             | ✓      |
| selected row `--el-selection-bg`  | `#15233a` | 10.74    | 3.0             | ✓      |
| its own type chip (14% over page) | `#2e2813` | 10.02    | 3.0             | ✓      |

`--el-text-strong` on the citrine chip: 10.40. Chip wash vs the orange Epic chip ΔE 14.2, vs the amber High chip ΔE 10.7, vs Review ΔE 10.7 (duplicate floor 2).

**The type CHIP.** A chip paints the hue at 14% over the page with `--el-text-strong` text; the glyph
carries the hue at full strength. Epic chip vs Review/Verification chip: ΔE 3.9 light / 4.5
dark — above the 2.0 duplicate-detector floor tints use. The chips differ by glyph and label as well
as hue; the glyph hues are the ΔE 11 pair above. The citrine Design chip's figures are under its
matrix above.

**The donut gets FIXED, not just warmed.** Today `--el-chart-cat-6` (the accent) and
`--el-chart-cat-1` / `-2` (`--color-primary` / `--color-info`) are the same blue in motir — three
segments of a seven-segment donut share one family. Segment 6 now sits ΔE 11.0 / 11.5 from segment 4
(the warning) and ≥49 from every other segment.

### 8.4 The tints

#### light — tints

| tint                  | old → new             | ΔE old→new | nearest sibling tint (ΔE, floor 2) | --el-text-strong `#20242a` (≥4.5) | --el-text-secondary `#565c64` (≥4.5) | --el-warning (icon on peach tiles) `#c2410c` (≥3.0) |
| --------------------- | --------------------- | ---------- | ---------------------------------- | --------------------------------- | ------------------------------------ | --------------------------------------------------- |
| `--color-tint-peach`  | `#f7e6d6` → `#fde0c8` | 4.5        | yellow 10.8                        | 12.38 ✓                           | 5.36 ✓                               | 4.11 ✓                                              |
| `--color-tint-yellow` | `#f6f1d6` → `#fdf0c6` | 4.8        | peach 10.8                         | 13.70 ✓                           | 5.93 ✓                               | 4.55 ✓                                              |

Type CHIP washes (light, 14% over the page): Epic `#f9e9db` vs Review/Verification `#f6e4dd` ΔE 3.9; vs Peach tint `#fde0c8` ΔE 5.2 (duplicate-detector floor 2). `--el-text-strong` on the Epic chip: 13.14.

#### dark — tints

| tint                  | old → new             | ΔE old→new | nearest sibling tint (ΔE, floor 2) | --el-text-strong `#d7d9dd` (≥4.5) | --el-text-secondary `#a9adb5` (≥4.5) | --el-warning (icon on peach tiles) `#f08a4b` (≥3.0) |
| --------------------- | --------------------- | ---------- | ---------------------------------- | --------------------------------- | ------------------------------------ | --------------------------------------------------- |
| `--color-tint-peach`  | `#2e2418` → `#36230f` | 5.4        | yellow 9.1                         | 10.58 ✓                           | 6.65 ✓                               | 6.01 ✓                                              |
| `--color-tint-yellow` | `#2a2716` → `#302a12` | 3.3        | peach 9.1                          | 10.14 ✓                           | 6.37 ✓                               | 5.76 ✓                                              |

Type CHIP washes (dark, 14% over the page): Epic `#2d170d` vs Review/Verification `#2c1e17` ΔE 4.5; vs Peach tint `#36230f` ΔE 7.2 (duplicate-detector floor 2). `--el-text-strong` on the Epic chip: 11.98.

Peach moves 4.5 / 5.4 ΔE warmer and yellow 4.8 / 3.3, so the pair that was tightest among the six
washes (peach–yellow, ΔE 8.4 light / 6.2 dark) moves APART (10.8 / 9.1). Every text ink on them
still clears AA by a wide margin. `tests/theme/inkContrastScan.test.ts` — which measures every
shipped ink-on-surface pair in components — and the other 44 theme suites stay green with the
proposal applied (run 2026-10-04; the one red is `paletteRename.test.ts`'s fixture, which pins
motir's resolved values on purpose and is regenerated by MOTIR-7584 — §8.8).

### 8.5 Every consumer of every changed source, with its disposition

The grep: `git grep -n "var(--color-accent)" origin/main -- packages/design-system/theme.css`, then the
same for `--color-tint-peach` and `--color-tint-yellow`, then `git grep -n -- "--<role>\b" origin/main
-- components app lib packages/design-system/src ':!*.test.*'` for each role found.

**`--color-accent` → 6 Tier-3 roles (+ 4 other palettes' overrides)**

| consumer                                                                                                        | where it paints                                                                                                                                    | disposition                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--el-type-epic`                                                                                                | `components/issues/IssueTypeIcon.tsx` (every kind icon: board card, backlog row, detail header, pickers), `components/planning/PlanPreview.tsx`    | **warms**                                                                                                                                                                                               |
| `--el-type-design`                                                                                              | `lib/issues/workItemTypeMeta.ts` → `WorkItemTypeChip` (items list, ready list, detail rail, planning node), `components/approvals/ApprovalRow.tsx` | **re-pointed** — motir sets it directly to citrine gold, so it leaves the orange group                                                                                                                  |
| `--el-epic-accent`                                                                                              | `app/tokens/page.tsx` only                                                                                                                         | **warms**                                                                                                                                                                                               |
| `--el-chart-cat-6`                                                                                              | `components/ui/charts/tokens.ts` (donut ramp)                                                                                                      | **warms** — and de-duplicates segment 6 from 1/2 (§8.3)                                                                                                                                                 |
| `--el-highlight` → `PlanWithAILauncher.tsx`, `PlanWithAIFab.tsx`, `PlanningTargetNode.tsx`, `AiCalloutMenu.tsx` | glows and gradients mixed with the ink `--el-accent`                                                                                               | **warms** — the ink fill stays dominant; the glow turns warm (board mock panel 7)                                                                                                                       |
| `--el-highlight` → `components/ui/MarkdownEditor.tsx` (`focus-within:border-`, two `focus-visible:ring-`)       | a FOCUS indicator                                                                                                                                  | **re-pointed** to the new `--el-editor-focus` — focus is an identity role and stays blue in motir; the token's base is `var(--color-accent)` so every other palette paints exactly what it paints today |
| `--el-status-implemented` (base `color-mix` over the accent)                                                    | status                                                                                                                                             | **unaffected** — motir already overrides it to `var(--color-charcoal)` in both themes                                                                                                                   |
| `--el-status-approved` (evergreen), `--el-status-blocked` (sienna)                                              | status in OTHER palettes                                                                                                                           | **unaffected** — those palettes keep their own `--color-accent`                                                                                                                                         |

**`--color-tint-peach` → 7 roles; `--el-tint-peach` itself: 52 files.** All paint a pale wash under
ink — `Pill` `severity="warning"` (the board's **Blocked** pill), `Card` tone, callouts, admin tiles,
onboarding stations, settings callouts, the ToFix/Readiness badges, run tone pills. `--el-warning-surface`
(25 files: device approval, consent, sprint strip, monitor notices, plan-change rail…), `--el-role-custom`
(`Pill` `memberRole="custom"`, `MemberChips`, `roleIdentity`), `--el-label-1` (`MultiSelectPicker`),
`--el-avatar-peach` (`TriageAvatar`), `--el-station-tier-validation` (`StationNode`),
`--el-roadmap-submitted` (no consumer today). **Disposition: all warm.** None is an identity role; the
icon on a peach tile (`admin/monitoring` `text-(--el-warning)`) stays ≥4.1:1, over its 3.0 bar.

**`--color-tint-yellow` → 3 roles; `--el-tint-yellow` itself: 32 files.** Callouts and notices
(`OverCapBanner`, `StaffSessionBar`, `AiPaywall`, `DecisionWaitingMarker`, `StatusHeldNotice`, plan
review rail…), `--el-label-6`, `--el-avatar-yellow`. **Disposition: all warm.**

**Progress has no token today** (`git grep -nE "el-[a-z-]*progress" origin/main --
packages/design-system/theme.css` returns only `--el-status-in-progress` and `--el-roadmap-progress`).
The components that draw a progress FILL:

| component                                                                  | fill today          | disposition                                                       |
| -------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `components/planning/WorkItemNode.tsx` subtree meter (done / total)        | `--el-success`      | **unaffected** — it means DONE, and green is the meaning          |
| `app/(onboarding)/onboarding/import/_components/RunStep.tsx` `ProgressBar` | `--el-accent` (ink) | **re-pointed** to the new `--el-progress-fill` → warm in motir    |
| `app/(authed)/items/[key]/_components/AttachmentsPanel.tsx` upload bar     | `--el-accent` (ink) | **re-pointed** to `--el-progress-fill` → warm in motir            |
| `--el-roadmap-progress` (`--color-tint-sky`, public roadmap)               | sky                 | **unaffected** — it is the in-progress STATUS wash, which is blue |

The new role's base is `var(--color-primary-fill)` — the value `--el-accent` gives those two bars
today — so every other palette is pixel-identical; only the motir blocks set `var(--color-accent)`.
`--el-progress-fill` against its `--el-muted` track: 3.32:1 light / 5.33:1 dark.

### 8.6 motir.co — the second consumer

The grep: `git -C motir-marketing grep -nE "el-(highlight|type-|tint-|avatar-|chart-)" origin/main -- app`
(`e9d52ee`; component names below are motir-marketing's, under its `app/` tree). Only the two tints reach it — no type hue, highlight, avatar or chart:

| consumer                                                                       | role               | disposition                                      |
| ------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------ |
| landing `OpenCore` icon tile                                                   | `--el-tint-peach`  | warms                                            |
| docs `DocSchema` / `DocsRail` — `PATCH` / `PUT` method chips, 4xx status chips | `--el-tint-peach`  | warms                                            |
| docs `CopyControls` — copied banner + active toggle                            | `--el-tint-peach`  | warms                                            |
| docs MCP tools guide — "writes" hint chip                                      | `--el-tint-peach`  | warms                                            |
| public project `States` — the "could not load" alert                           | `--el-tint-peach`  | warms (`--el-text-secondary` on it: 5.36 / 6.65) |
| docs public-address guide and sandbox `SetupSteps` notes                       | `--el-tint-yellow` | warms                                            |

All drawn in the element-tokens delta, panel 4. They reach the site only through the release
(MOTIR-7587) and the re-pin (MOTIR-7588).

### 8.7 Two intensities, one decision — SUBTLE

Drawn one above the other in the board mock (panels 9–10):

- **Subtle** — the orange, the citrine Design hue and the two tints, as above.
- **A bit more colourful** — the same hues, plus chips at 22% instead of 14% and column-count pills
  tinted by their status hue.

**Recommendation: subtle.** The evidence: (1) the 22% chips and tinted counts change COMPONENT
recipes (`workItemTypeChipBackground`, `BoardColumn`), which would move every palette, not just
motir — outside a palette story. (2) They add no hue: everything the colourful board shows that is
not recipe is already in the subtle one. (3) Subtle already delivers the brief: Epic reads warm
orange, Design reads citrine, neither is the task/code blue, and the default look warms without
losing its calm.

The first revision's colourful variant gave Design a coral (`#e0533f` / `#ff6b5a`) and was rejected
because that coral is ΔE 10.2 from the danger red Bug and Deploy wear. Citrine solves the same want —
Design apart from Epic — at ΔE 14.0 from its nearest neighbour in light and 27.5 in dark, so it is
in the recommendation rather than in the alternative.

### 8.8 Hand-off — GIVES / TAKES

Every `MOTIR-<n>` this asset names (grepped from this section and both delta mocks):

- **MOTIR-7582** (the story) — TAKES its scope; GIVES nothing beyond this table.
- **MOTIR-7583** (this card) — the design result.
- **MOTIR-7584** (apply the tokens) — **GIVES**: write §8.1 verbatim in both motir blocks (including
  `--el-type-design` set directly to the citrine hex in each motir block); add
  `--el-progress-fill` and `--el-editor-focus` to the Tier-3 base block (base values as §8.1) with motir
  overrides in BOTH themes; re-point `RunStep.tsx` / `AttachmentsPanel.tsx` to `--el-progress-fill`
  and `MarkdownEditor.tsx`'s three focus classes to `--el-editor-focus`; register both roles in
  `app/tokens/page.tsx`; regenerate `tests/fixtures/paletteRename6471.before.json`'s motir entries
  (the fixture says to regenerate on a deliberate retune); add a separation assertion that measures
  motir's `--color-accent` against `--color-warning`, `--el-priority-high` and `--color-destructive`
  at ΔE 10, and against every surface at 3.0, in both themes, and the same for `--el-type-design`
  (citrine) against every other glyph hue, the orange included; update `docs/palettes/motir.md` (a
  warm-touches section with this table and why) and the registry tagline (keep the
  `Stark and editorial` prefix `paletteRename.test.ts` pins); add the `@motir/design-system` changeset.
- **MOTIR-7585** (integration gate) — TAKES: the two re-pointed components and the new roles are its
  seams.
- **MOTIR-7586** (E2E + receipt) — **GIVES**: the board shows the Epic kind ICON orange, not a Design
  chip — the citrine Design **chip** lives in the items list / ready list / detail rail, so verify it there;
  the focus ring and links stay blue; Settings › Appearance unchanged.
- **MOTIR-7587** (release) / **MOTIR-7588** (motir.co re-pin) — GIVES: the §8.6 list is what the re-pin
  must show; nothing else on the site moves.
- **MOTIR-6470** / **MOTIR-6473** (monochrome default; static brand colours) — TAKES: the ink brand
  tile, swatch, icons and emails stay ink.
