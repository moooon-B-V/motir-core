import type { PlanStory } from '../types';

/**
 * Story 7.19 — Design-system selection (palette / typography / shape → project
 * design tokens), recorded in motir-ai. The capability that gives every Motir
 * project its OWN design system — chosen BEFORE planning, in a guided design
 * step — so that every mockup the planner later generates (every `type: design`
 * subtask) is rendered in the project's tokens, not an improvised default.
 *
 * **What this productizes — DOGFOOD.** Motir's own UI flows colour through the
 * Tier-3 `--el-*` element tokens and shape through `[data-display-style]`
 * radius/spacing/sizing/shadow tokens (motir-core `CLAUDE.md` § "Colour flows
 * through `--el-*`" + § "Shape flows through element-semantic shape tokens"),
 * with the `/tokens` specimen route as the living spec. Those very tokens were
 * DECIDED by a palette/typography/shape selection — this story is that process,
 * productized: a user picks a colour palette, a typography, and a shape /
 * display-style, and Motir GENERATES the project's design tokens in the same
 * multi-axis architecture Motir itself uses (a project theme mirroring
 * `globals.css`'s Tier-0 → Tier-3 `--el-*` colour layer + the
 * `[data-display-style]` shape layer + the type scale). The confirmation page is
 * the project's OWN `/tokens`-style specimen — the chosen tokens applied to real
 * shipped primitives.
 *
 * **A DESIGN STEP BEFORE PLANNING, for ALL SIX workflows.** Per Yue's spec the
 * design-system selection runs UP FRONT — before discovery / generation — for
 * every onboarding workflow (the two named wizards 7.15 start-fresh + 7.16
 * migrate, and the four other entry paths Epic 7 serves). The reason is the
 * design gate (notes.html #31 / Principle #13): every later design-subtask
 * mockup must compose a KNOWN token set, so the tokens must EXIST before the
 * planner generates any design subtask. Choosing the design system first is the
 * project-scoped analogue of the per-subtask design gate — it closes the gap
 * where "unspecified design" would otherwise mean "improvise."
 *
 * **Where it lives — the FIFTH stateful-motir-ai store (architecture #5, on the
 * 7.1.3 spine).** Per the locked Epic-7 architecture (story-7.1.ts header),
 * motir-ai owns its OWN Postgres holding the context classes with no home in an
 * open PM tool — direction docs (7.2), planning-mistakes (7.10), the code graph
 * (7.5/7.7), the coding convention + code-health audit (7.14), and — HERE — the
 * **design system**, the fifth member, a sibling to the other four on the same
 * `AiProject` spine (7.1.3). `DesignSystem` is a motir-ai-side table, NOT a
 * motir-core table — motir-core stays a complete, exportable Jira clone with
 * zero AI tables; the only motir-core surfaces are the selection WIZARD + the
 * token-preview/confirmation page, which read/write the store over the 7.1
 * boundary like every other motir-core→motir-ai call. The design system sits
 * exactly alongside the coding convention (7.14): both are per-project, durable,
 * approved artifacts that the planner INJECTS into later work — the convention
 * into 7.6 coding prompts, the design system into every 7.x design subtask.
 *
 * **Sourcing — getdesign.md for palettes + shapes, a Motir-curated list for
 * typography (VERIFIED this planning session, not asserted).** I fetched
 * https://getdesign.md/ and the Google DESIGN.md spec it is built on:
 *   - **getdesign.md** is "a curated collection of DESIGN.md files extracted
 *     from real production design systems" — **73 analyzed design systems** as
 *     of 2026-06-12 (automotive / fintech / e-commerce / AI / media), exposing
 *     "analyzed patterns, tokens, and rules" as inspiration for AI coding
 *     agents, **built on Google's DESIGN.md spec**.
 *   - **The DESIGN.md spec** (github.com/google-labs-code/design.md) is a
 *     two-part format: YAML front-matter MACHINE-READABLE tokens + markdown
 *     prose ("the tokens are the normative values; the prose provides context").
 *     Its eight sections include **Colors** (`map<string, Color>`, ≥ a `primary`
 *     palette, hex/named/functional/wide-gamut), **Typography**
 *     (`map<string, Typography>` with `fontFamily`/`fontSize`/`fontWeight`/
 *     `lineHeight`/`letterSpacing`, semantic names like `headline-lg`,
 *     `body-md`), **Shapes** (`rounded` as `map<string, Dimension>`, scale
 *     `sm`/`md`/`lg`/`full`, e.g. `4px`/`8px`/`12px`/`9999px`), and Layout
 *     (spacing). All tokens are "easily convertible to tokens.json, Figma
 *     variables, and Tailwind configs."
 * So PALETTES + SHAPE SETS come from getdesign.md's distilled DESIGN.md library
 * (the 73 real systems' Colors + Shapes/rounded + Layout/spacing); TYPOGRAPHY is
 * a MOTIR-CURATED list (a hand-picked, license-cleared set of type pairings) —
 * the spec exposes a Typography section but Motir curates its own offering
 * rather than scraping arbitrary font choices.
 *
 * **The output is the same multi-axis token architecture Motir uses.** The
 * selection generates a per-project THEME mirroring `globals.css`:
 *   - palette → the Tier-3 `--el-*` element tokens (the swap layer a
 *     `data-palette` would override — `--el-text*`, `--el-accent*`,
 *     `--el-surface*`, `--el-border*`, `--el-danger/success/warning/info`, the
 *     `--el-tint-*` pastels, the `--el-type-{epic,story,task,bug,subtask}` issue
 *     hues), each mapped onto the chosen palette's Tier-0 `--color-*` values;
 *   - shape → the `[data-display-style]` radius/spacing/sizing/shadow tokens
 *     (`--radius-{btn,card,input,modal,badge,control,kbd}`, the
 *     `--spacing-*`/`--height-*` control sizing, `--shadow-*`) — a new
 *     display-style is a getdesign.md shape set, not just "soft vs default";
 *   - typography → the curated type scale (`--font-*` / the family + the
 *     `--font-size-*` ramp).
 * This is exactly the COLOR axis + the SHAPE axis the two CLAUDE.md sections
 * describe — generated per project instead of hand-decided once for Motir.
 *
 * **INJECTED into ALL later design-subtask planning.** Once recorded + approved,
 * the design system is folded into the planner's design-subtask generation: when
 * the generation engine (7.3) or augment/expand/replan (7.4) emits a
 * `type: design` subtask, AND when 7.6 generates that subtask's dispatch prompt,
 * the project's tokens are injected — so every `*.mock.html` the design gate
 * demands composes THIS project's `--el-*` + `[data-display-style]` tokens. This
 * is the design-system analogue of 7.14.6's convention injection: the convention
 * is the productized `CLAUDE.md` for code; the design system is the productized
 * `globals.css` + `/tokens` for design.
 *
 * **ADOPT-EXISTING for migrate (mirrors 7.14's adopt-if-clear).** For a
 * migrate-existing-codebase project there may already BE a design system in the
 * code (a `globals.css` / a Tailwind theme / a tokens file). Like 7.14's
 * adopt-if-clear convention detection, the migrate path DETECTS and ADOPTS the
 * existing design system where it is discernible (read via the 7.5 code graph +
 * the connected repo), recording it as the project's design system rather than
 * forcing a re-pick; where none is discernible, it falls back to the
 * getdesign.md picker. (Fresh always picks; migrate adopts-or-picks.)
 *
 * **Mirror (rung 1 + the verified design-token sources).** The
 * choose-a-design-system-then-generate-tokens shape is what getdesign.md +
 * Google's DESIGN.md (verified above) exist to feed AI coding agents; the
 * per-project, approved, injected-into-every-prompt pattern mirrors 7.14's
 * coding convention exactly (the SIBLING store + contract pattern this story
 * follows as its coding convention). The Atlassian-Rovo generate→customize→
 * approve posture (verified across Epic 7) is the select→preview→confirm shape
 * the wizard's confirmation page uses.
 *
 * **The design gate fires (the wizard + the confirmation page are real UI).**
 * The palette/typography/shape pickers and the `/tokens`-style preview are
 * rendered + acted on in motir-core, so 7.19.1 is a `type: design` subtask FIRST
 * (AREA `design/design-selection/`, deps `[]`, `planned`) producing the
 * multi-panel mock, and the UI code subtask (7.19.7) blocks on it. No improvised
 * picker (the design-gate rule applied to the design-system-chooser itself).
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward deps.** Every
 * `dependsOn` id is same-epic backward/sideways: 7.1.3 (the motir-ai DB the
 * store sits on), 7.15.2 / 7.16.2 (the onboarding state machines the pre-
 * planning design step wires into), and same-story 7.19.x. All are ≤ 7.19. No
 * card points forward. Status rule: 7.19.1 (design, deps `[]`) + 7.19.2
 * (decision, deps `[]`) are `'planned'`; everything chained behind a not-yet-done
 * 7.1.x / 7.15.x / 7.16.x / 7.19.x id is `'blocked'`.
 *
 * **Scope (the nine cards).** the selection-wizard + token-preview/confirmation
 * design (7.19.1); the multi-axis token model + getdesign.md sourcing + the
 * output format + record-in-motir-ai + inject-into-design-planning + adopt-
 * existing decision (7.19.2); the getdesign.md integration provisioning (7.19.3,
 * manual); the `DesignSystem` store on the motir-ai DB (7.19.4); the getdesign.md
 * fetch integration (7.19.5); the curated typography list + the token GENERATOR
 * (7.19.6); the motir-core wizard UI + the `/tokens`-style confirmation page
 * (7.19.7); injecting the recorded design system into all later design-subtask
 * planning + wiring the design step as the pre-planning step in the onboarding
 * flows (7.19.8); the vitest suite (7.19.9).
 *
 * **Out of scope (named so they land in their owning stories, not here):** the
 * onboarding WIZARDS themselves (7.15 / 7.16 — 7.19 adds a PRE-planning step they
 * sequence, it does not rebuild the wizards); the per-subtask design gate + the
 * `*.mock.html` authoring convention (a standing Epic-wide rule — 7.19 supplies
 * the tokens those mocks compose); the prompt-generation engine (7.6 — 7.19.8
 * injects the design system into the design-subtask prompt the SAME way 7.14.6
 * injects the convention into the code prompt); the runtime theme-SWITCHER for an
 * end user of the built product (Motir builds the project's design system; how
 * the built app exposes theming to ITS users is that app's own scope).
 */
export const story_7_19: PlanStory = {
  id: '7.19',
  title:
    'Design-system selection (palette / typography / shape → project design tokens), recorded in motir-ai',
  status: 'planned',
  gitBranch: 'feat/PROD-7.19-design-system-selection',
  descriptionMd:
    'A guided **design step BEFORE planning** — for all six onboarding ' +
    'workflows — where the user chooses their project’s design system (a ' +
    '**colour palette**, a **typography**, and a **shape / display-style**), ' +
    'and Motir GENERATES the project’s **design tokens** in the same ' +
    'multi-axis architecture Motir’s own UI uses: the Tier-3 `--el-*` colour ' +
    'layer + the `[data-display-style]` shape layer (radius / spacing / sizing ' +
    '/ shadow) + the type scale, a project theme mirroring `globals.css`. The ' +
    'confirmation page is the project’s OWN `/tokens`-style specimen — the ' +
    'chosen tokens applied to real shipped primitives. **This is dogfood:** ' +
    'Motir’s own tokens were decided by exactly this palette/typography/shape ' +
    'process.\n\n' +
    '**Why before planning.** Every later `type: design` subtask must compose a ' +
    'KNOWN token set (the design gate — no improvised UI), so the tokens have ' +
    'to EXIST before the planner generates any design subtask. Choosing the ' +
    'design system up front is the project-scoped analogue of the per-subtask ' +
    'design gate.\n\n' +
    '**The fifth stateful-motir-ai store (locked architecture #5, on the 7.1.3 ' +
    'spine).** motir-ai owns its own Postgres for the context classes with no ' +
    'home in an open PM tool — direction docs (7.2), planning-mistakes (7.10), ' +
    'the code graph (7.5/7.7), the coding convention + audit (7.14), and ' +
    '**here** the design system, the fifth member, sibling to the other four on ' +
    'the same `AiProject` spine. `DesignSystem` is a motir-ai-side table, NOT a ' +
    'motir-core table — motir-core stays a complete exportable Jira clone with ' +
    'zero AI tables. The design system sits exactly alongside the 7.14 coding ' +
    'convention: both are per-project, approved, injected-into-prompts ' +
    'artifacts — the convention is the productized `CLAUDE.md` for code, the ' +
    'design system the productized `globals.css` + `/tokens` for design.\n\n' +
    '**Sourcing (VERIFIED — getdesign.md + Google’s DESIGN.md spec):** PALETTES ' +
    '+ SHAPE sets come from **getdesign.md** — a curated library of `DESIGN.md` ' +
    'files distilled from **~73 real design systems**, built on Google’s ' +
    '`DESIGN.md` spec (machine-readable Colors / Shapes-rounded / Layout-spacing ' +
    'tokens + prose). TYPOGRAPHY is a **Motir-curated list** (a hand-picked, ' +
    'license-cleared set of type pairings) rather than scraped fonts.\n\n' +
    '**The output is Motir’s own token architecture, per project:** palette → ' +
    'the `--el-*` element tokens (the swap layer); shape → the ' +
    '`[data-display-style]` radius/spacing/sizing/shadow tokens; typography → ' +
    'the curated type scale — exactly the COLOR axis + SHAPE axis the two ' +
    '`CLAUDE.md` sections describe, generated per project instead of ' +
    'hand-decided once.\n\n' +
    '**INJECTED into all later design-subtask planning.** Once recorded + ' +
    'approved, the design system is folded into the planner’s design-subtask ' +
    'generation (7.3/7.4) AND the 7.6 prompt for each design subtask — so every ' +
    '`*.mock.html` the design gate demands composes THIS project’s tokens (the ' +
    'design-system analogue of 7.14.6’s convention injection).\n\n' +
    '**Adopt-existing for migrate (mirrors 7.14’s adopt-if-clear).** A migrate ' +
    'project may already HAVE a design system in code (a `globals.css` / a ' +
    'Tailwind theme / a tokens file); the migrate path DETECTS and ADOPTS it ' +
    'where discernible (via the code graph + the connected repo), else falls ' +
    'back to the getdesign.md picker. Fresh always picks; migrate ' +
    'adopts-or-picks.\n\n' +
    '**Scope:** the wizard + confirmation-page design (7.19.1); the token-model ' +
    '+ sourcing + record + inject + adopt-existing decision (7.19.2); the ' +
    'getdesign.md integration provisioning (7.19.3, manual); the `DesignSystem` ' +
    'store (7.19.4); the getdesign.md fetch (7.19.5); the curated typography ' +
    'list + the token generator (7.19.6); the wizard UI + the `/tokens`-style ' +
    'confirmation page (7.19.7); injection into design-subtask planning + the ' +
    'pre-planning wiring into the onboarding flows (7.19.8); vitest (7.19.9).\n\n' +
    '**Out of scope (named so they land elsewhere):** the onboarding WIZARDS ' +
    'themselves (7.15 / 7.16 — 7.19 adds a pre-planning step they sequence); the ' +
    'per-subtask design gate + the `*.mock.html` convention (a standing ' +
    'Epic-wide rule — 7.19 supplies the tokens those mocks compose); the ' +
    'prompt-generation engine (7.6 — 7.19.8 injects into it the way 7.14.6 ' +
    'does); a runtime theme-switcher for the BUILT product’s own end users (that ' +
    'app’s scope, not Motir’s planning layer).',
  verificationRecipeMd:
    '- Pull the Story branch; in `motir-core` run `pnpm install`, `pnpm prisma ' +
    'generate`, `pnpm db:seed`; in `motir-ai` run its install + `pnpm prisma ' +
    'generate` + `pnpm migrate` against the local docker Postgres (7.1.3), with ' +
    'the getdesign.md integration access provisioned (7.19.3) or its recorded ' +
    'fixture in place for offline runs.\n' +
    '- **The selection → generation → confirmation flow (the story).** Sign in ' +
    'as `zhuyue@motir.co`; start an onboarding flow → the FIRST step is the ' +
    'design-system selection (before discovery/generation). Pick a PALETTE ' +
    '(from getdesign.md’s distilled list), a TYPOGRAPHY (from the Motir-curated ' +
    'list), and a SHAPE / display-style (from getdesign.md). Continue → the ' +
    'token-preview/CONFIRMATION page renders like Motir’s `/tokens` specimen: ' +
    'the chosen tokens applied to REAL primitives (Button, Card, Pill, Input, ' +
    'the issue-type icons), with the colour swatches, the type ramp, and the ' +
    'radius/shadow specimens reflecting the selection. Confirm → the design ' +
    'system is recorded in motir-ai.\n' +
    '- **The generated tokens are Motir’s architecture.** Inspect the recorded ' +
    'design system: the palette produced the Tier-3 `--el-*` element tokens ' +
    '(text / accent / surface / border / danger-success-warning-info / the ' +
    '`--el-tint-*` pastels / the `--el-type-*` issue hues) mapped onto the ' +
    'palette’s `--color-*` values; the shape produced the ' +
    '`[data-display-style]` radius/spacing/sizing/shadow tokens; the typography ' +
    'produced the type scale — a project theme mirroring `globals.css`, NOT a ' +
    'flat colour blob.\n' +
    '- **Recorded in motir-ai (the fifth store).** Query the `DesignSystem` ' +
    'table → one row per `AiProject` with `palette` / `typography` / ' +
    '`displayStyle` + the generated `tokensJson` + `status`. It is a ' +
    'motir-ai-side table; there is NO design-system table in motir-core.\n' +
    '- **Injected into design-subtask planning (the payoff).** Trigger a ' +
    'generation (or expand) that emits a `type: design` subtask, then generate ' +
    'that subtask’s 7.6 dispatch prompt → the prompt CARRIES the project’s ' +
    'design tokens (assert the `--el-*` / `[data-display-style]` token set + the ' +
    'chosen type appear in the prompt), so the mockup it asks for composes THIS ' +
    'project’s system. With NO recorded design system (a project that skipped ' +
    'the step), injection is a clean no-op.\n' +
    '- **Adopt-existing for migrate.** For a migrate project whose connected ' +
    'repo already has a `globals.css` / Tailwind theme (the 7.5.4 fixture), the ' +
    'design step DETECTS and ADOPTS the existing design system (records it ' +
    'without forcing a re-pick) and says so; for a fixture with no discernible ' +
    'system, it falls back to the getdesign.md picker.\n' +
    '- `pnpm test` (motir-ai) + `pnpm test` (motir-core) — 7.19.9 covers ' +
    'selection → token generation → preview → recorded-in-motir-ai → injected ' +
    'into a design-subtask plan, plus the migrate adopt-existing path.\n' +
    '- **Open-core check (this Epic’s recurring posture).** The `DesignSystem` ' +
    'table exists ONLY in motir-ai (no such table in motir-core’s schema); the ' +
    'wizard + the confirmation page reach it solely over the 7.1 boundary (no ' +
    '`motir-ai` import in motir-core, no shared DB). The design system is part ' +
    'of the closed planning brain, alongside the convention + the lessons.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '7.19.1',
      title:
        'Design — the design-system-selection wizard (palette / typography / shape pickers) + the token-preview / confirmation page',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, notes.html #31 / ' +
        'Principle #13 — applied to the design-system-CHOOSER itself). The ' +
        'wizard + the confirmation page are real motir-core UI; the UI code ' +
        'subtask (7.19.7) depends on this and is blocked until it exists. ' +
        'Without it the pickers + the preview would be improvised, which is ' +
        'forbidden.\n\n' +
        'Produce the design asset for the **design-system-selection** surface ' +
        'under `motir-core/design/design-selection/`. Author it as a ' +
        '**`*.mock.html` mockup** built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen` (the ' +
        'coding-agent-produced-design route; the reviewer sees the actual ' +
        'tokens). A PNG export is optional; the `.mock.html` is the source of ' +
        'truth.\n\n' +
        '**Framing note for the mock — meta but real.** This surface CHOOSES a ' +
        'design system, so the mock itself is rendered in Motir’s OWN shipped ' +
        'tokens (the chrome), while the PICKER OPTIONS preview the candidate ' +
        'systems (each palette swatch / each shape specimen shows what that ' +
        'option would produce). Keep the chrome on `--el-*` + ' +
        '`[data-display-style]`; the option previews are inert specimens, not a ' +
        'live re-theme of the page.\n\n' +
        '**Surfaces to draw** (multi-panel board — EVERY panel, the multi-panel ' +
        'rule, notes.html #31):\n\n' +
        '- **Panel 1 — the palette picker (getdesign.md).** A gallery of ' +
        'candidate palettes distilled from getdesign.md’s ~73 real design ' +
        'systems: each option a card with the palette’s swatches (the accent, ' +
        'the surfaces, the text ramp, a tint or two) + a one-line descriptor ' +
        '(e.g. "Pure black canvas, tricolor accents"). A selected state. The ' +
        'gallery VIRTUALIZES / paginates (73+ systems — the planning-time scale ' +
        'check, no "load all rows").\n' +
        '- **Panel 2 — the typography picker (Motir-curated list).** A list of ' +
        'curated type options, each rendering a real specimen (a heading + body ' +
        'line + a label set in that family/scale) so the choice is WYSIWYG. Make ' +
        'clear in copy this is Motir’s curated, license-cleared list (distinct ' +
        'from the getdesign.md-sourced palette/shape).\n' +
        '- **Panel 3 — the shape / display-style picker (getdesign.md).** A set ' +
        'of shape options each shown as a small specimen — a button + a card + ' +
        'an input rendered at that option’s radius/spacing/shadow — so the user ' +
        'sees the shape language (sharp vs soft vs pill, tight vs generous), the ' +
        '`[data-display-style]` axis made choosable. A selected state.\n' +
        '- **Panel 4 — the token-preview / CONFIRMATION page (like ' +
        '`/tokens`).** The chosen palette + typography + shape APPLIED to real ' +
        'shipped primitives, laid out like Motir’s `/tokens` specimen: a colour ' +
        'section (the `--el-*` roles as swatches), a type ramp, a radius/shadow ' +
        'specimen row, and a "components" strip (Button, Card, Pill, Input, the ' +
        'IssueTypeIcon set) rendered in the selection. A prominent **status / ' +
        'confirm** affordance ("This is your project’s design system — every ' +
        'screen Motir designs will use it") + the **Confirm design system** ' +
        'primary action. Draw the pre-confirm (review) and post-confirm ' +
        '(recorded) states.\n' +
        '- **Panel 5 — the migrate ADOPT-EXISTING + empty/error states.** For a ' +
        'migrate project whose repo already has a design system: an "We found ' +
        'your design system" panel showing the DETECTED palette/shape/type ' +
        '(adopted from the code, mirror 7.14’s adopt-if-clear) with an ' +
        '"adopt as-is" vs "pick a new one" choice. Also draw the no-system-' +
        'found fallback (→ the pickers) and the getdesign.md-unreachable error ' +
        '(a danger callout via `--el-danger`, the cached/fixture fallback ' +
        'noted).\n\n' +
        'Also write **`design/design-selection/design-notes.md`** naming the ' +
        'exact primitives composed per surface, the exact copy strings (the ' +
        'picker headings, the "Motir-curated typography" note, the confirm copy, ' +
        'the adopt-existing copy, the error copy), the placement decisions, the ' +
        'per-`--el-*` colour role for each chrome element (the selected-option ' +
        'tone, the confirm banner, the danger callout — AA on a tint, finding ' +
        '#35, NOT a page-level tinted surface), and a "primitives composed (no ' +
        'hand-rolling)" checklist.\n\n' +
        '**Mirror (VERIFIED — cite in design-notes).** getdesign.md (the ~73 ' +
        'real-system DESIGN.md library the palette + shape galleries draw from) ' +
        '+ Google’s DESIGN.md spec (Colors / Typography / Shapes token sections) ' +
        '+ Motir’s own `/tokens` specimen route (the confirmation-page layout to ' +
        'mirror) + 7.14.1’s convention review surface (the sibling per-project ' +
        'approve-an-artifact shape).\n\n' +
        '**Branch.** `design/PROD-7.19.1-design-selection`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy — this PR only ' +
        'edits `design/design-selection/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/design-selection/design-selection.mock.html` ' +
        'exists, renders the five panels side-by-side, and references ONLY ' +
        '`--el-*` colour + `[data-display-style]` shape tokens for the CHROME ' +
        '(no Tier-0 `--color-*`, no hand-rolled radius/spacing — the ' +
        '`motir-core/CLAUDE.md` rules); the option previews are inert specimens, ' +
        'not a live page re-theme.\n' +
        '- The three pickers (palette [getdesign.md], typography [curated], ' +
        'shape/display-style [getdesign.md]) are each drawn with selectable ' +
        'options + a selected state; the palette gallery is ' +
        'virtualized/paginated (not an unbounded dump of 73+).\n' +
        '- The confirmation page is drawn like the `/tokens` specimen — the ' +
        'chosen tokens applied to real primitives (Button/Card/Pill/Input/' +
        'IssueTypeIcon) + the colour/type/radius specimens — with the **Confirm ' +
        'design system** action (pre- and post-confirm states).\n' +
        '- The migrate adopt-existing panel + the no-system fallback + the ' +
        'getdesign.md-error state are drawn (Panel 5).\n' +
        '- `design/design-selection/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` role, ' +
        'and cites the getdesign.md / DESIGN.md-spec / `/tokens` / 7.14.1 ' +
        'mirror.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Button`, ' +
        '`Pill`, `Input`, the swatch/specimen, `EmptyState`, the danger callout) ' +
        '— no new design-system entry invented inside this Story (if one is ' +
        'needed, that is a NEW `design/` subtask, not a code workaround).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/app/tokens/page.tsx` — the `/tokens` specimen route the ' +
        'confirmation page mirrors (the colour/type/radius/shadow specimen ' +
        'layout + the primitives strip).\n' +
        '- `motir-core/design/coding-convention/` (7.14.1) — the closest ' +
        'sibling per-project approve-an-artifact surface to mirror for layout + ' +
        '`design-notes.md` shape.\n' +
        '- `motir-core/components/ui/Pill.tsx` + `IssueTypeIcon` — the ' +
        'primitives the preview applies the selection to.\n' +
        '- `motir-core/app/globals.css` — the Tier-0 → Tier-3 `--el-*` colour + ' +
        'the `[data-display-style]` shape tokens the generated theme mirrors ' +
        '(the OUTPUT shape this surface previews).\n' +
        '- 7.19.4 — the `DesignSystem` field shapes the panels render ' +
        '(palette / typography / displayStyle / tokensJson / status).\n' +
        '- getdesign.md (https://getdesign.md/) + the DESIGN.md spec — the ' +
        'verified palette + shape source, cited in design-notes.',
      dependsOn: [],
    },
    {
      id: '7.19.2',
      title:
        'Decision — the multi-axis token model: palette→`--el-*`, shape→`[data-display-style]`, typography→curated; getdesign.md sourcing; record in motir-ai; inject into design planning; adopt-existing for migrate',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** decision (the keystone ADR the rest of 7.19 — and the ' +
        'pre-planning wiring into 7.15/7.16 — build against). Produce ' +
        '`motir-ai/docs/decisions/design-system-model.md`; no app behavior ' +
        'ships here, but the shapes it fixes are load-bearing.\n\n' +
        'Fix the model:\n\n' +
        '1. **The three axes + the multi-axis token output.** The selection has ' +
        'THREE axes — **palette**, **typography**, **shape / display-style** — ' +
        'and GENERATES a per-project theme in Motir’s OWN architecture: palette ' +
        '→ the Tier-3 `--el-*` element tokens (the colour swap layer: ' +
        '`--el-text*`, `--el-accent*`, `--el-surface*`, `--el-border*`, ' +
        '`--el-link*`, `--el-danger/success/warning/info`, the `--el-tint-*` ' +
        'pastels, and the `--el-type-{epic,story,task,bug,subtask}` issue hues), ' +
        'each mapped onto the chosen palette’s Tier-0 `--color-*` values; shape ' +
        '→ the `[data-display-style]` radius/spacing/sizing/shadow tokens ' +
        '(`--radius-{btn,card,input,modal,badge,control,kbd}`, the ' +
        '`--spacing-*` / `--height-*` control sizing, `--shadow-*`); typography ' +
        '→ the curated type scale (family + the `--font-size-*` ramp). This is ' +
        'exactly the COLOR axis + SHAPE axis the two `motir-core/CLAUDE.md` ' +
        'sections describe — generated per project (the dogfood: Motir’s own ' +
        'tokens came from this process).\n' +
        '2. **The token OUTPUT FORMAT — a project theme mirroring `globals.css`.** ' +
        'Fix the serialized shape recorded per project (`tokensJson`): the ' +
        'Tier-0 `--color-*` palette values, the Tier-3 `--el-*` mapping, the ' +
        '`[data-display-style]` shape block, and the type scale — enough to ' +
        'render the `/tokens`-style preview AND to inject into a design-subtask ' +
        'prompt. It mirrors `globals.css`’s tier structure so a generated ' +
        'mockup’s tokens are byte-compatible with how Motir authors its own.\n' +
        '3. **Sourcing (VERIFIED — cite, do not assert).** PALETTES + SHAPE sets ' +
        'come from **getdesign.md** — a curated library of `DESIGN.md` files ' +
        'distilled from ~73 real design systems, built on Google’s `DESIGN.md` ' +
        'spec (YAML machine-readable Colors `map<string,Color>` / Shapes ' +
        '`rounded map<string,Dimension>` / Layout spacing + prose). TYPOGRAPHY ' +
        'is a **Motir-curated list** (hand-picked, license-cleared type ' +
        'pairings). Fix WHICH DESIGN.md sections map to which Motir axis (Colors ' +
        '→ palette → `--el-*`; Shapes-rounded + Layout-spacing → shape → ' +
        '`[data-display-style]`; the curated list → typography).\n' +
        '4. **Recorded in motir-ai (the fifth store, on the 7.1.3 spine).** The ' +
        'design system is a `DesignSystem` row per `AiProject` in motir-ai’s own ' +
        'Postgres — sibling to direction docs (7.2), mistakes (7.10), the code ' +
        'graph (7.5/7.7), and the coding convention (7.14). NOT a motir-core ' +
        'table (open-core line). It carries a `status` (the select→confirm ' +
        'gate, mirroring 7.14’s proposed→standard).\n' +
        '5. **INJECTED into ALL later design-subtask planning.** Fix that the ' +
        'recorded design system is folded into (a) the planner’s design-subtask ' +
        'GENERATION (7.3/7.4 emit design subtasks whose acceptance/context names ' +
        'the project tokens) and (b) the 7.6 dispatch PROMPT for each design ' +
        'subtask (the tokens ride into the `*.mock.html`-authoring prompt). This ' +
        'is the design-system analogue of 7.14.6’s convention injection — same ' +
        'shape, different artifact. Only a CONFIRMED design system is injected; ' +
        'no design system → a clean no-op (the enhancement property).\n' +
        '6. **Adopt-existing for migrate (mirror 7.14’s adopt-if-clear).** Fix ' +
        'the DETECTION rule: for a migrate project, read the connected repo / ' +
        'the 7.5 code graph for an existing design system (a `globals.css` / a ' +
        'Tailwind theme / a tokens file with a discernible palette + ' +
        'radius/spacing language); where it is CLEAR, ADOPT it (record it as the ' +
        'project’s design system, provenance = adopted-from-code) rather than ' +
        'forcing a re-pick; where it is absent/unclear, fall back to the ' +
        'getdesign.md picker. Fresh always picks. Cite 7.14’s ' +
        'adopt-if-clear/propose-if-messy as the sibling pattern this follows.\n' +
        '7. **The pre-planning ordering.** Fix that the design step runs BEFORE ' +
        'discovery/generation in every onboarding workflow (the reason: the ' +
        'design gate needs the tokens to exist before any design subtask is ' +
        'generated). It is a step the 7.15/7.16 state machines sequence, not a ' +
        'new wizard.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/docs/decisions/design-system-model.md` exists and fixes all ' +
        'seven points with a concrete `DesignSystem` schema (the input to ' +
        '7.19.4), a worked `tokensJson` example mirroring `globals.css` (Tier-0 ' +
        '`--color-*` + Tier-3 `--el-*` + the `[data-display-style]` block + the ' +
        'type scale), and the DESIGN.md-section → Motir-axis mapping.\n' +
        '- The three axes + the multi-axis output (palette→`--el-*`, ' +
        'shape→`[data-display-style]`, typography→curated scale) are fixed; the ' +
        'output format is byte-compatible with how Motir authors `globals.css`.\n' +
        '- Sourcing is CITED (getdesign.md ~73 systems, Google DESIGN.md spec ' +
        'Colors/Shapes/Layout sections; typography = Motir-curated), not ' +
        'asserted.\n' +
        '- The record-in-motir-ai (fifth store), the inject-into-design-planning ' +
        '(standard-only, the 7.14.6 analogue), and the migrate adopt-existing ' +
        '(the 7.14 adopt-if-clear analogue) rules are all fixed, with the ' +
        'pre-planning ordering.\n\n' +
        '## Context refs\n\n' +
        '- story-7.1.ts header §4–5 — motir-ai is stateful; the context stores; ' +
        'this design system is the fifth, on the 7.1.3 spine.\n' +
        '- `motir-core/app/globals.css` — the Tier-0 → Tier-3 `--el-*` colour ' +
        'layer + the `[data-display-style]` shape layer + the type scale the ' +
        'output mirrors.\n' +
        '- `motir-core/CLAUDE.md` § "Colour flows through `--el-*`" + § "Shape ' +
        'flows through element-semantic shape tokens" — the two axes this ' +
        'generates per project.\n' +
        '- `motir-core/app/tokens/page.tsx` — the specimen route the ' +
        'confirmation preview mirrors.\n' +
        '- story-7.14.ts (7.14.2) — the SIBLING decision (per-project artifact, ' +
        'adopt-if-clear, recorded in motir-ai, injected into prompts) this ' +
        'follows as its coding convention; 7.14.6 — the convention-injection ' +
        'analogue.\n' +
        '- getdesign.md (https://getdesign.md/) + ' +
        'github.com/google-labs-code/design.md (the spec) — the verified palette ' +
        '+ shape source.',
      dependsOn: [],
    },
    {
      id: '7.19.3',
      title: 'getdesign.md integration access — the palette + shape data source (license / terms)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 30,
      descriptionMd:
        '**Type:** manual/human (no PR — provisioning / external-service / ' +
        'terms work, mirror 1.6.7; marked done on Yue’s confirmation). A coding ' +
        'agent cannot accept terms of use, mint an API key, or clear a content ' +
        'license. Wired here via `dependsOn` so the prerequisite is visible at ' +
        'PLAN time (notes.html #30), not discovered at run time.\n\n' +
        'Establish the access Motir uses to source PALETTES + SHAPE sets from ' +
        '**getdesign.md** (the data source 7.19.5 fetches from):\n\n' +
        '1. **Determine the access shape.** getdesign.md exposes a curated ' +
        'library of `DESIGN.md` files distilled from ~73 real design systems ' +
        '(built on Google’s `DESIGN.md` spec). Determine HOW Motir consumes it ' +
        '— a documented API / a bulk export / fetching the published `DESIGN.md` ' +
        'files — and whether an account / API key is required. Provision that ' +
        'credential (if any) and set the env key 7.19.2 names (e.g. ' +
        '`GETDESIGN_MD_*`) on the motir-ai deployment.\n' +
        '2. **Clear the license / terms.** Confirm Motir may redistribute / ' +
        'derive palettes + shape sets from the distilled `DESIGN.md` files into ' +
        'a customer’s project design tokens (the underlying Google `DESIGN.md` ' +
        'spec is open; verify getdesign.md’s OWN curation terms permit this ' +
        'use). Record the cleared terms + any attribution requirement so 7.19.5 ' +
        'honours it.\n' +
        '3. **Offline/fixture fallback.** Confirm a recorded snapshot / fixture ' +
        'of the sourced palettes + shape sets is acceptable for dev + CI (so the ' +
        'suite + local runs do not hit getdesign.md live) — the same offline ' +
        'posture the rest of Epic 7 uses.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The getdesign.md access shape is determined (API / export / fetch) ' +
        'and any required credential is provisioned + env-wired on motir-ai ' +
        '(the key 7.19.2 named).\n' +
        '- The license / terms for deriving palettes + shapes into a customer’s ' +
        'project tokens are cleared and recorded (incl. any attribution).\n' +
        '- A recorded fixture/snapshot of the sourced data exists or is approved ' +
        'for dev + CI (offline runs).\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 7.19.2 — the sourcing decision (getdesign.md for palettes + shapes) + ' +
        'the env-key inventory this provisions.\n' +
        '- 7.19.5 — the fetch integration this unblocks.\n' +
        '- getdesign.md (https://getdesign.md/) + ' +
        'github.com/google-labs-code/design.md — the source + the underlying ' +
        'open spec.\n' +
        '- 7.2.3 / 7.7.2 — the precedent manual-provisioning subtask shape ' +
        '(secret / external-service / terms, no PR).',
      dependsOn: ['7.19.2'],
    },
    {
      id: '7.19.4',
      title:
        'The design-system store (motir-ai) — `DesignSystem` schema + repo/service (the fifth store)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Stand up the design-system store as the FIFTH context store on ' +
        'motir-ai’s own Postgres (the 7.1.3 Prisma foundation) — alongside ' +
        'direction docs (7.2), planning-mistakes (7.10), the code graph ' +
        '(7.5/7.7), and the coding convention + audit (7.14). This is a ' +
        'motir-ai-side table; motir-core never gets a design-system table (the ' +
        'open-core boundary stays clean).\n\n' +
        'Add the model per the 7.19.2 decision:\n\n' +
        '```prisma\n' +
        '// motir-ai/prisma/schema.prisma\n' +
        'model DesignSystem {\n' +
        '  id           String              @id @default(cuid())\n' +
        '  aiProjectId  String              @unique // one design system per project\n' +
        '  aiProject    AiProject           @relation(fields: [aiProjectId], references: [id], onDelete: Cascade)\n' +
        '  // the three chosen axes (palette + shape sourced from getdesign.md; typography from the curated list)\n' +
        '  palette      Json                // the chosen palette (id + the Tier-0 --color-* values)\n' +
        '  typography   Json                // the chosen curated type option (family + the type scale)\n' +
        '  displayStyle Json                // the chosen shape set (the [data-display-style] radius/spacing/sizing/shadow)\n' +
        '  // the GENERATED project theme — the multi-axis token output (mirrors globals.css)\n' +
        '  tokensJson   Json                // Tier-0 --color-* + Tier-3 --el-* + the [data-display-style] block + the type scale\n' +
        '  source       DesignSystemSource  // picked | adopted (migrate adopt-existing)\n' +
        '  status       DesignSystemStatus  // draft | confirmed\n' +
        '  confirmedByUserId String?         // the core user who confirmed (set when status flips to confirmed)\n' +
        '  confirmedAt  DateTime?\n' +
        '  createdAt    DateTime            @default(now())\n' +
        '  updatedAt    DateTime            @updatedAt\n' +
        '  @@index([aiProjectId, status])\n' +
        '}\n' +
        '\n' +
        'enum DesignSystemSource { picked adopted }\n' +
        'enum DesignSystemStatus { draft confirmed }\n' +
        '```\n\n' +
        'Exactly ONE design system per `AiProject` (the `@unique`) — selecting a ' +
        'new one REPLACES the draft until confirmed. `source` records whether it ' +
        'was PICKED from getdesign.md (fresh, or migrate-with-no-discernible-' +
        'system) or ADOPTED from existing code (migrate adopt-existing — the ' +
        '7.14 adopt-if-clear analogue). `status` is the select→confirm gate ' +
        '(draft until the user confirms on the `/tokens`-style page, then ' +
        'confirmed) — only a `confirmed` system is injected (7.19.8), mirroring ' +
        '7.14’s proposed→standard.\n\n' +
        'Layer it the way 7.1.3 / 7.10.1 / 7.14.3 established (mirror ' +
        'motir-core’s Route→Service→Repository spirit lightly):\n\n' +
        '- **`designSystemRepository`** — single-op Prisma: `upsert` (write, ' +
        'takes `tx` — the per-project unique makes select-or-replace an upsert), ' +
        '`update`, `findByProject(aiProjectId)`, ' +
        '`findConfirmed(aiProjectId)` (the one confirmed system, for ' +
        'injection).\n' +
        '- **`designSystemService`** — business logic: ' +
        '`recordDraft(aiProjectId, { palette, typography, displayStyle, ' +
        'tokensJson, source })` (the 7.19.6 generator calls this — picked or ' +
        'adopted), `confirm(aiProjectId, userId)` (the 7.19.7 gate — flips ' +
        'draft→confirmed, records `confirmedByUserId` + `confirmedAt`, ' +
        'idempotent), `getConfirmedForInjection(aiProjectId)` (the 7.19.8 read — ' +
        'returns the confirmed `tokensJson` or null), `getForPreview' +
        '(aiProjectId)` (the latest draft/confirmed for the confirmation page). ' +
        'Returns DTOs, not raw Prisma rows.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/schema.prisma` gains `DesignSystem` + ' +
        '`DesignSystemSource` + `DesignSystemStatus` with a migration; ' +
        '`pnpm prisma generate` + `pnpm migrate` run clean against the local ' +
        'docker Postgres (FKs as `@relation`s, no drift).\n' +
        '- The model hangs off `AiProject` (unique per project) and cascades on ' +
        'its delete; `source` distinguishes picked vs adopted; `status` is ' +
        'draft|confirmed.\n' +
        '- `confirm` flips exactly the project’s draft to `confirmed`, records ' +
        'the approver, and is idempotent; `getConfirmedForInjection` returns the ' +
        'confirmed `tokensJson` or null when none is confirmed.\n' +
        '- Repo write methods require `tx`; the service returns DTOs.\n' +
        '- The table exists ONLY in motir-ai — no design-system table in ' +
        'motir-core’s schema; no motir-core DB connection in motir-ai.\n\n' +
        '## Context refs\n\n' +
        '- `motir-ai/prisma/schema.prisma` + the `AiProject` spine from 7.1.3 ' +
        '(the per-project identity this hangs off).\n' +
        '- 7.14.3 (`CodingConvention` store) — the closest existing motir-ai ' +
        'store (repo/service shape, the status gate, DTOs) to mirror; the design ' +
        'system is its sibling.\n' +
        '- 7.19.2 — the model decision fixing the schema + the status machine + ' +
        'the `tokensJson` shape.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer — the Route→Service→Repository ' +
        'pattern motir-ai mirrors lightly.',
      dependsOn: ['7.1.3'],
    },
    {
      id: '7.19.5',
      title:
        'The getdesign.md integration — fetch palettes + shape sets from the DESIGN.md library',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Build the integration that sources the PALETTE + SHAPE options from ' +
        '**getdesign.md** — the curated `DESIGN.md` library distilled from ~73 ' +
        'real design systems (built on Google’s `DESIGN.md` spec). This feeds ' +
        'the palette picker (Panel 1) + the shape/display-style picker (Panel 3); ' +
        'typography comes from the curated list (7.19.6), NOT here.\n\n' +
        '**The integration (motir-ai side).** A `getdesignMdSource` module that ' +
        'fetches the DESIGN.md library (via the access shape 7.19.3 provisioned ' +
        '— API / export / published-files) and PARSES each `DESIGN.md`’s ' +
        'machine-readable sections into Motir’s candidate-option shape:\n\n' +
        '- **Colors → palette options.** Parse each DESIGN.md `Colors` section ' +
        '(`map<string, Color>`, ≥ a `primary` palette, supporting ' +
        'hex/named/functional/wide-gamut per the spec) into a candidate PALETTE ' +
        '— the Tier-0 `--color-*` values Motir needs (accent / surfaces / text ' +
        'ramp / borders / semantic / tints) + a short descriptor. Normalize ' +
        'across the spec’s colour formats to the form 7.19.6’s generator ' +
        'consumes.\n' +
        '- **Shapes/rounded + Layout/spacing → shape options.** Parse each ' +
        'DESIGN.md `Shapes` (`rounded map<string, Dimension>`, scale ' +
        '`sm/md/lg/full`) + the Layout spacing into a candidate ' +
        'DISPLAY-STYLE / shape set — the radius/spacing/sizing/shadow language ' +
        'Motir’s `[data-display-style]` axis needs.\n\n' +
        '**Durable + offline.** Cache the fetched library (the getdesign.md ' +
        'content is curated + slow-moving) and honour the 7.19.3 fixture for dev ' +
        '+ CI (no live getdesign.md call in tests). Handle the unreachable case ' +
        'with a typed error the wizard renders as the Panel-5 error state ' +
        '(falling back to the cached/fixture set). Respect any attribution the ' +
        '7.19.3 terms require. This is a READ integration — Motir derives ' +
        'candidate options from the distilled files; it does not write back to ' +
        'getdesign.md.\n\n' +
        '**Lightly layered.** A source-client module + a parser module ' +
        '(DESIGN.md → candidate options) + a cache; expose ' +
        '`listPaletteOptions()` / `listShapeOptions()` (paginated — 73+ systems, ' +
        'the scale check) that the wizard (7.19.7) and the generator (7.19.6) ' +
        'read. It does NOT generate the final project theme — that is 7.19.6 ' +
        '(this supplies the OPTIONS; 7.19.6 turns a chosen option into Motir ' +
        'tokens).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `getdesignMdSource` integration fetches the DESIGN.md library (via ' +
        'the 7.19.3 access) and parses each file’s `Colors` → a candidate ' +
        'palette and its `Shapes`/rounded + Layout/spacing → a candidate shape ' +
        'set, normalized to the form 7.19.6 consumes.\n' +
        '- `listPaletteOptions()` / `listShapeOptions()` return ' +
        'cursor-paginated candidates (no unbounded load of 73+); a stable id per ' +
        'option so a selection round-trips.\n' +
        '- The library is cached; dev + CI run against the 7.19.3 fixture (no ' +
        'live getdesign.md call); an unreachable source yields a typed error ' +
        '(the Panel-5 fallback), and any required attribution is carried.\n' +
        '- This is read-only sourcing (no write-back); typography is NOT sourced ' +
        'here (it is the curated list in 7.19.6).\n\n' +
        '## Context refs\n\n' +
        '- 7.19.2 — the sourcing decision + the DESIGN.md-section → Motir-axis ' +
        'mapping (Colors→palette, Shapes+Layout→shape).\n' +
        '- 7.19.3 — the getdesign.md access + terms + the fixture this rides.\n' +
        '- 7.19.6 — the generator that turns a chosen palette/shape option (+ ' +
        'the curated typography) into the project’s `--el-*` + ' +
        '`[data-display-style]` tokens.\n' +
        '- getdesign.md (https://getdesign.md/) + ' +
        'github.com/google-labs-code/design.md/blob/main/docs/spec.md — the ' +
        'Colors / Shapes / Layout section shapes parsed here.',
      dependsOn: ['7.19.2'],
    },
    {
      id: '7.19.6',
      title:
        'The curated typography list + the token GENERATOR — selection → the project theme (`--el-*` + `[data-display-style]` + type)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Two parts, both in motir-ai: (1) the **Motir-curated typography list** ' +
        '(the third axis’ option set), and (2) the **token GENERATOR** that ' +
        'turns a chosen palette + typography + shape into the project’s design ' +
        'tokens — the multi-axis theme mirroring Motir’s `globals.css`. This is ' +
        'the engine of the story: the OUTPUT the whole feature exists to ' +
        'produce.\n\n' +
        '**The curated typography list.** A hand-picked, license-cleared set of ' +
        'type options (each a family / pairing + the type-scale ramp), authored ' +
        'as motir-ai seed/config — NOT scraped from getdesign.md (the verified ' +
        'split: palettes + shapes are getdesign.md-sourced, typography is ' +
        'Motir-curated). Each option carries enough to render a specimen (7.19.1 ' +
        'Panel 2) and to emit the type scale into the generated theme. Treat the ' +
        'list as curated content (one strong, deduplicated option per ' +
        'distinct voice), with provenance/attribution where a font requires it.\n\n' +
        '**The token generator.** Given the chosen `{ palette, typography, ' +
        'displayStyle }` (palette + displayStyle from the 7.19.5 getdesign.md ' +
        'options; typography from the curated list), GENERATE the project theme ' +
        'in Motir’s architecture (`tokensJson`, the 7.19.4 field):\n\n' +
        '- **palette → Tier-0 `--color-*` + Tier-3 `--el-*`.** Emit the Tier-0 ' +
        'palette values, then MAP them onto every Tier-3 `--el-*` element token ' +
        'Motir uses (`--el-text*`, `--el-accent*`, `--el-surface*`, ' +
        '`--el-border*`, `--el-link*`, `--el-danger/success/warning/info` + ' +
        '`--el-danger-text`, the `--el-tint-*` pastels, and the ' +
        '`--el-type-{epic,story,task,bug,subtask}` issue hues) — the SAME ' +
        'mapping `globals.css` Tier-3 does, so the generated theme is ' +
        'byte-compatible with how Motir authors its own. **AA contrast holds** ' +
        '(the hue in the tint background with `--el-text-strong` text, finding ' +
        '#35) — the generator validates contrast and adjusts, it does not emit ' +
        'an inaccessible pairing.\n' +
        '- **shape → the `[data-display-style]` block.** Emit the ' +
        'radius/spacing/sizing/shadow tokens ' +
        '(`--radius-{btn,card,input,modal,badge,control,kbd}`, the ' +
        '`--spacing-*` / `--height-*` control sizing, `--shadow-*`) from the ' +
        'chosen shape set — a getdesign.md shape set becomes a full ' +
        'display-style, not just "soft vs default".\n' +
        '- **typography → the type scale.** Emit the family + the `--font-size-*` ' +
        'ramp from the chosen curated option.\n\n' +
        '**Adopt-existing variant (migrate).** The generator ALSO has an ' +
        'adopt-from-code path: given an existing design system DETECTED from the ' +
        'connected repo / the 7.5 code graph (a `globals.css` / Tailwind theme / ' +
        'tokens file), produce the SAME `tokensJson` shape from the detected ' +
        'palette + radius/spacing + type (`source: adopted`) — the 7.14 ' +
        'adopt-if-clear analogue. (The detection read rides the 7.5 graph + the ' +
        'repo; this card produces the tokens from what was detected.)\n\n' +
        'The generator records the result via ' +
        '`designSystemService.recordDraft` (7.19.4) as `status: draft` until ' +
        'the user confirms (7.19.7). It is grounded — every emitted token traces ' +
        'to a chosen option or a detected source value; no fabricated colours.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A Motir-curated typography list exists (motir-ai seed/config), each ' +
        'option with a renderable specimen + the type scale + any required ' +
        'attribution — NOT sourced from getdesign.md.\n' +
        '- The generator turns a chosen `{ palette, typography, displayStyle }` ' +
        'into a `tokensJson` mirroring `globals.css`: Tier-0 `--color-*` + the ' +
        'full Tier-3 `--el-*` mapping (incl. the `--el-tint-*` + ' +
        '`--el-type-*` hues) + the `[data-display-style]` radius/spacing/sizing/' +
        'shadow block + the type scale.\n' +
        '- Generated colour pairings pass AA (the tint-bg + `--el-text-strong` ' +
        'rule, finding #35); the generator adjusts rather than emit an ' +
        'inaccessible pairing.\n' +
        '- The adopt-existing path produces the same `tokensJson` shape from a ' +
        'design system detected in code (`source: adopted`), grounded in the ' +
        'detected values.\n' +
        '- The result is recorded via `designSystemService.recordDraft` as ' +
        '`draft`; every token traces to a chosen option or a detected source ' +
        '(no fabricated values).\n\n' +
        '## Context refs\n\n' +
        '- 7.19.5 — the getdesign.md palette + shape OPTIONS this consumes ' +
        '(palette + displayStyle inputs).\n' +
        '- 7.19.4 — `designSystemService.recordDraft` (the store this writes the ' +
        'generated `tokensJson` to).\n' +
        '- 7.19.2 — the token model + the output format + the DESIGN.md→axis ' +
        'mapping + the adopt-existing rule.\n' +
        '- `motir-core/app/globals.css` — the Tier-0 `--color-*` → Tier-3 ' +
        '`--el-*` mapping + the `[data-display-style]` block + the type scale ' +
        'the generated theme mirrors byte-for-byte in shape.\n' +
        '- `motir-core/CLAUDE.md` § colour (the `--el-*` map + the AA / ' +
        'finding-#35 rule) + § shape (the radius/spacing/sizing token roles).\n' +
        '- Story 7.5 (stub) — the code graph the migrate adopt-existing ' +
        'detection reads.',
      dependsOn: ['7.19.5', '7.19.4'],
    },
    {
      id: '7.19.7',
      title: 'The selection wizard UI + the `/tokens`-style confirmation page (motir-core)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the design-system-selection surface in **motir-core** that ' +
        'renders exactly what 7.19.1 specifies — the palette / typography / ' +
        'shape pickers + the token-preview/CONFIRMATION page (the ' +
        '`/tokens`-style specimen) — reading the getdesign.md options + writing ' +
        'the chosen system to motir-ai OVER THE 7.1 BOUNDARY (the ' +
        '`lib/ai/motirAiClient` from 7.1.5), never a direct DB reach (the ' +
        'open-core invariant: motir-core holds no AI tables, talks to the store ' +
        'only over HTTP).\n\n' +
        '**The motir-ai read/write endpoints.** This subtask adds the small ' +
        'motir-ai HTTP surface the UI consumes (service-credential + the 7.1 ' +
        'project identity, all delegating to 7.19.4/7.19.5/7.19.6): ' +
        '`GET /v1/design-system/options` (the getdesign.md palette + shape ' +
        'options [7.19.5] + the curated typography list [7.19.6], paginated), ' +
        '`POST /v1/projects/:id/design-system/generate` (run the 7.19.6 ' +
        'generator over a chosen `{ palette, typography, displayStyle }` — or ' +
        'the adopt-existing path — → a `draft` `DesignSystem` + its ' +
        '`tokensJson`), `GET /v1/projects/:id/design-system` (the draft/' +
        'confirmed for the preview), and ' +
        '`POST /v1/projects/:id/design-system/confirm` (flip draft→confirmed via ' +
        '`designSystemService.confirm`, recording the confirming core user).\n\n' +
        '**The motir-core surface (4-layer).**\n\n' +
        '- A server-side `aiDesignSystemService` in motir-core that calls the ' +
        '7.1.5 client (`listOptions` / `generate` / `getDesignSystem` / ' +
        '`confirm`), maps contract errors to motir-core typed errors, and is the ' +
        'ONLY thing the route/page calls — no client component touches the ' +
        'client directly.\n' +
        '- Routes under `app/api/ai/design-system/*` (options / generate / get / ' +
        'confirm) that parse + session-gate (the surface adopts a 6.4 ' +
        'project-admin permission — the design system drives every screen ' +
        'Motir designs, a manager action; 404-not-403 on a cross-tenant ' +
        'project), call the one service method, map errors.\n' +
        '- The page (under the established settings/onboarding location — it is ' +
        'EMBEDDED as the pre-planning step by 7.19.8, so factor it as a ' +
        'composable surface) — a Server Component rendering: the three pickers ' +
        '(palette gallery [virtualized — 73+], the curated typography specimens, ' +
        'the shape/display-style specimens), and the CONFIRMATION page ' +
        'rendering the generated tokens applied to real shipped primitives ' +
        'EXACTLY like `/tokens` (colour swatches per `--el-*` role, the type ' +
        'ramp, the radius/shadow specimens, a Button/Card/Pill/Input/' +
        'IssueTypeIcon strip), with **Confirm design system**. The migrate ' +
        'adopt-existing panel + the error/fallback states per 7.19.1 Panel 5.\n' +
        '- **i18n** — page strings in a new `designSystem` namespace; localized ' +
        'across the locale set the app ships.\n' +
        '- **Tokens** — the CHROME composes ONLY shipped `components/ui/*` ' +
        'primitives + `--el-*` colour + `[data-display-style]` shape tokens (no ' +
        'Tier-0 `--color-*`, no hand-rolled spacing); the PREVIEW renders the ' +
        'GENERATED tokens as inert specimens (the one place generated ' +
        '`--color-*`/`--el-*` values are shown, the same controlled exception ' +
        'the `/tokens` route itself is).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The page renders the three pickers from 7.19.1 (palette [getdesign.md, ' +
        'virtualized], typography [curated specimens], shape [specimens]), ' +
        'composed of the named primitives; the chrome references only `--el-*` + ' +
        '`[data-display-style]` tokens.\n' +
        '- Choosing the three axes → `generate` produces a `draft` design system ' +
        'in motir-ai (over the boundary); the CONFIRMATION page renders the ' +
        'generated tokens applied to real primitives like the `/tokens` ' +
        'specimen.\n' +
        '- **Confirm design system** flips it to `confirmed` (verifiable over ' +
        'the boundary); the migrate adopt-existing panel renders the detected ' +
        'system with adopt-vs-pick; the getdesign.md-error fallback renders.\n' +
        '- The surface is gated to the project-admin permission (a non-admin is ' +
        'blocked); a cross-tenant project is 404-not-403; reads/writes are over ' +
        'the 7.1 boundary (no `motir-ai` import, no shared DB in motir-core).\n' +
        '- 4-layer respected: route → `aiDesignSystemService` → 7.1.5 client; no ' +
        'client component touches the client; the palette gallery paginates (no ' +
        'unbounded load).\n\n' +
        '## Context refs\n\n' +
        '- 7.19.1 — the design asset this implements (the pickers + the ' +
        '`/tokens`-style confirmation page + design-notes.md).\n' +
        '- `motir-core/app/tokens/page.tsx` — the specimen layout the ' +
        'confirmation page mirrors (the colour/type/radius/shadow specimens + ' +
        'the primitives strip + the inert-generated-tokens exception).\n' +
        '- 7.19.4 / 7.19.5 / 7.19.6 — the store + the options source + the ' +
        'generator + the motir-ai endpoints this exposes/consumes.\n' +
        '- 7.1.5 — `lib/ai/motirAiClient` (the server-to-server boundary).\n' +
        '- `motir-core/app/(authed)/settings/ai/coding-convention/page.tsx` ' +
        '(7.14.5) — the sibling motir-ai-backed per-project artifact surface to ' +
        'mirror.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour / § shape.',
      dependsOn: ['7.19.1', '7.19.6'],
    },
    {
      id: '7.19.8',
      title:
        'Inject the recorded design system into ALL later design-subtask planning + wire the design step as the PRE-PLANNING step in the onboarding flows',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Two wirings that make the recorded design system MATTER: (1) INJECT it ' +
        'into every later design-subtask plan (so the design gate’s mockups use ' +
        'the project tokens), and (2) sequence the design-system selection as ' +
        'the PRE-PLANNING step in the onboarding flows (so the tokens exist ' +
        'before any design subtask is generated). This is the design-system ' +
        'analogue of 7.14.6 (convention injection) + 7.15.2/7.16.2 (the wizard ' +
        'orchestration), reused not rebuilt.\n\n' +
        '**Injection (the payoff — the productized `globals.css` + `/tokens`).** ' +
        'Only a `status: confirmed` design system is injected. Two injection ' +
        'points, both reading `designSystemService.getConfirmedForInjection' +
        '(aiProjectId)`:\n\n' +
        '- **design-subtask GENERATION (7.3/7.4).** When the planner emits a ' +
        '`type: design` subtask, fold the project’s tokens into the subtask’s ' +
        'generated acceptance/context (the mockup must compose THESE `--el-*` + ' +
        '`[data-display-style]` tokens) — so a generated design card already ' +
        'names the project’s system.\n' +
        '- **the 7.6 design-subtask PROMPT.** When `generate_prompt` (7.6.2) ' +
        'assembles a design subtask’s dispatch prompt, fold the project’s ' +
        '`tokensJson` (the palette `--el-*` map + the `[data-display-style]` ' +
        'block + the chosen type) into the prompt’s design-constraints section — ' +
        'alongside the per-type design rules 7.6.2 already embeds. This is the ' +
        'EXACT shape 7.14.6 uses for the coding convention, applied to the ' +
        'design artifact. With NO confirmed design system, injection is a clean ' +
        'no-op (the prompt is unchanged — the enhancement property).\n\n' +
        '**Pre-planning wiring into the onboarding flows.** Add the ' +
        'design-system selection as a STEP the onboarding state machines ' +
        'sequence BEFORE discovery/generation — it is a step, not a new wizard ' +
        '(7.15/7.16 own the wizards; this card wires the step in):\n\n' +
        '- **7.15 (start-fresh):** insert `select_design_system` before the ' +
        'discovery/generate steps in the 7.15.2 machine — the design system is ' +
        'chosen up front so the first generated design subtask + the first ' +
        'dispatched design prompt already carry it.\n' +
        '- **7.16 (migrate):** insert the design step before generation, using ' +
        'the ADOPT-EXISTING path (detect the repo’s design system after the ' +
        'index step, present adopt-vs-pick) — sequenced alongside the 7.16.3 ' +
        'convention gate (both are "approve the project’s standards before ' +
        'generating").\n' +
        '- The other onboarding entry paths reuse the same step. The step gates ' +
        'generation the way 7.16.3’s convention gate does: no generation until ' +
        'the design system is CONFIRMED (so no design subtask is ever generated ' +
        'token-less).\n\n' +
        'This card WIRES into the 7.15.2 / 7.16.2 machines + the 7.3/7.4/7.6 ' +
        'planning — it does not rebuild the wizards or the planner; it adds the ' +
        'step + the two injection points.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Only a `confirmed` design system is injected; a generated ' +
        '`type: design` subtask’s acceptance/context names the project tokens, ' +
        'and the 7.6 design-subtask prompt carries the `tokensJson` (the ' +
        '`--el-*` map + `[data-display-style]` block + type) — asserted; with no ' +
        'confirmed system, both are a clean no-op.\n' +
        '- The 7.15.2 (fresh) + 7.16.2 (migrate) state machines gain a ' +
        '`select_design_system` step BEFORE discovery/generation; migrate uses ' +
        'the adopt-existing path; generation is GATED on the design system being ' +
        'confirmed (no token-less design subtask is ever generated).\n' +
        '- The injection reuses `getConfirmedForInjection` + the 7.6.2 prompt ' +
        'assembly (the 7.14.6 analogue) — additive, not a rewrite of the planner ' +
        'or the wizards.\n' +
        '- Open-core holds: the design system is read over the 7.1 boundary; no ' +
        '`motir-ai` import added to motir-core’s planner-adjacent code beyond the ' +
        'existing client.\n\n' +
        '## Context refs\n\n' +
        '- 7.19.4 — `getConfirmedForInjection` (the confirmed tokens this ' +
        'injects).\n' +
        '- 7.14.6 — the SIBLING injection (the coding convention into the 7.6 ' +
        'prompt) this mirrors exactly for the design artifact.\n' +
        '- Story 7.3 (stub) 7.3.2 / Story 7.4 (stub) — the generation/expand ' +
        'jobs that emit `type: design` subtasks the tokens fold into.\n' +
        '- Story 7.6 (stub) 7.6.2 — the `generate_prompt` job the design tokens ' +
        'inject into (the design-constraints section).\n' +
        '- 7.15.2 — the start-fresh state machine the pre-planning step inserts ' +
        'into; 7.16.2 / 7.16.3 — the migrate state machine + the convention gate ' +
        'this design step is sequenced alongside.',
      dependsOn: ['7.19.4', '7.19.6', '7.15.2', '7.16.2'],
    },
    {
      id: '7.19.9',
      title:
        'Vitest — selection → token generation → preview → recorded-in-motir-ai → injected into a design-subtask plan; adopt-existing for migrate',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the whole flow — selection → generation → record → inject — and ' +
        'the migrate adopt-existing path. Tests run over a real Postgres on each ' +
        'side (the no-mocks convention 7.1.3 established mirroring motir-core; ' +
        'the getdesign.md source + the LLM/detection seams are stubbed ' +
        'deterministically at the 7.19.5 boundary / the 7.19.3 fixture so the ' +
        'run is offline + stable).\n\n' +
        '**Selection → generation (7.19.5 / 7.19.6):**\n\n' +
        '- `listPaletteOptions` / `listShapeOptions` return the parsed ' +
        'getdesign.md candidates from the fixture (paginated); the curated ' +
        'typography list loads.\n' +
        '- The generator turns a chosen `{ palette, typography, displayStyle }` ' +
        'into a `tokensJson` mirroring `globals.css`: the full Tier-3 `--el-*` ' +
        'mapping (incl. `--el-tint-*` + `--el-type-*`) + the ' +
        '`[data-display-style]` radius/spacing/sizing/shadow block + the type ' +
        'scale are all present; every token traces to a chosen option (no ' +
        'fabricated value).\n' +
        '- **AA holds:** a generated colour pairing passes the contrast rule ' +
        '(tint-bg + `--el-text-strong`, finding #35); a would-be inaccessible ' +
        'pairing is adjusted, not emitted.\n\n' +
        '**Record + preview + confirm (7.19.4 / 7.19.7):**\n\n' +
        '- The generated theme records a `draft` `DesignSystem` (one per ' +
        'project, the `@unique`); `getForPreview` returns it for the ' +
        '`/tokens`-style page; `confirm` flips it to `confirmed` (idempotent, ' +
        'records the approver) and `getConfirmedForInjection` then returns the ' +
        '`tokensJson`.\n\n' +
        '**Injection (7.19.8):**\n\n' +
        '- With a CONFIRMED design system, a generated `type: design` subtask’s ' +
        'context names the project tokens AND the 7.6 design-subtask prompt ' +
        'carries the `tokensJson` (the `--el-*` map + `[data-display-style]` ' +
        'block + type) — asserted; with a DRAFT (unconfirmed) or NO design ' +
        'system, neither carries it (the confirm gate + the enhancement no-op ' +
        'both proven).\n' +
        '- The onboarding machines gate generation on a confirmed design system ' +
        '(a generation attempt with no confirmed system is rejected — no ' +
        'token-less design subtask).\n\n' +
        '**Adopt-existing for migrate (7.19.6):**\n\n' +
        '- Given a detected design system from a fixture repo/code graph (a ' +
        '`globals.css` / tokens file), the adopt path produces the same ' +
        '`tokensJson` shape with `source: adopted` and records it; a fixture ' +
        'with no discernible system falls back to the picker path.\n\n' +
        '## Acceptance criteria\n\n' +
        '- All cases above pass over a real Postgres (the only stubs are the ' +
        'getdesign.md source [7.19.3 fixture] + the detection/LLM seam); the ' +
        'generation, the store, the confirm gate, and the injection run for ' +
        'real.\n' +
        '- The confirm-gate case FAILS if a draft system is injected (proving ' +
        'the gate guards injection); the no-system case proves the enhancement ' +
        'no-op.\n' +
        '- The migrate adopt-existing path is proven with a detected fixture and ' +
        'the no-discernible-system fallback.\n' +
        '- New service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) — no untested branch in the ' +
        'generator’s axis mapping / the AA adjustment / the confirm gate / the ' +
        'adopt-vs-pick split.\n\n' +
        '## Context refs\n\n' +
        '- 7.19.4 (store), 7.19.5 (getdesign.md source), 7.19.6 (generator + ' +
        'curated typography), 7.19.8 (injection + pre-planning gate) — ' +
        'everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate (the ' +
        'convention motir-ai mirrors) + § colour (the AA / finding-#35 rule the ' +
        'generator must satisfy).\n' +
        '- 7.1.3 — the motir-ai test harness (real docker Postgres) this rides.\n' +
        '- 7.14.8 — the sibling convention suite (generate → record → ' +
        'confirm/approve → inject) whose structure this mirrors.',
      dependsOn: ['7.19.6', '7.19.8'],
    },
  ],
};
