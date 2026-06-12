import type { PlanStory } from '../types';

/**
 * Story 7.14 — Coding convention + code-health audit (the engine). The
 * capability that gives the planner a PROJECT-SPECIFIC sense of "what good code
 * looks like here" — by reading the existing codebase (via the 7.5 code graph)
 * against a clean-code rule set, producing TWO artifacts, and injecting the
 * approved one into every dispatched prompt. This is the productization of
 * MOTIR.md's own per-repo `CLAUDE.md` architecture-contract pattern: the
 * hand-kept "4-layer Route→Service→Repository→Prisma / `--el-*` tokens / tests
 * use real Postgres" contract that motir-core auto-loads for every Subtask
 * prompt becomes a GENERATED, per-project, user-approved artifact every Motir
 * tenant gets for their OWN codebase.
 *
 * **TWO artifacts (confirmed with Yue).** 7.14 produces, per project:
 *   1. **A code-issues audit report** — what is wrong / what to improve in the
 *      existing code, measured against a clean-code rule set (the CodeScene
 *      CodeHealth™ / SonarQube code-smell analog). This is a READ-ONLY
 *      diagnostic; Motir never auto-edits the user's code (Principle #3 — the AI
 *      proposes, the human acts).
 *   2. **A proposed coding convention** — the durable "how we write code here"
 *      document, DERIVED from the existing code structure + clean-code
 *      principles. **Adopt-if-clear / propose-if-messy:** where the repo already
 *      has a clear, consistent convention (a discernible layering, a naming
 *      scheme, a test posture) Motir ADOPTS and documents it; where the repo is
 *      messy / has no discernible convention, Motir PROPOSES one from clean-code
 *      principles + the chosen stack's idioms. The proposed convention is
 *      `status: proposed` until the USER APPROVES it, at which point it becomes
 *      `status: standard`.
 *
 * **The STANDARD convention is INJECTED into 7.6 prompt generation.** Once a
 * project's convention is `standard`, every `generate_prompt` job (7.6.2) folds
 * it into the assembled prompt — the productized auto-load of MOTIR.md's
 * `CLAUDE.md`: every dispatched coding/test/design prompt now carries THIS
 * project's house rules, not a generic template. This is the second prompt-
 * quality moat (after 7.5's retrieved context): the agent writes code that fits
 * the project because the convention is in the prompt.
 *
 * **Where it lives — the FOURTH stateful-motir-ai store (architecture #5, on the
 * 7.1.3 spine).** Per the locked Epic-7 architecture (story-7.1.ts header),
 * motir-ai owns its OWN Postgres holding the context classes with no home in an
 * open PM tool — direction docs (7.2), planning-mistakes (7.10), the code graph
 * (7.5/7.7), and — HERE — the **coding convention + code-health audit**, the
 * fourth member, a sibling to the other three on the same `AiProject` spine
 * (7.1.3). `CodingConvention` + `CodeAudit` are motir-ai-side tables, NOT
 * motir-core tables — motir-core stays a complete, exportable Jira clone with
 * zero AI tables; the only motir-core surfaces are the audit-report VIEW + the
 * convention review/approve UI, which read/write the store over the 7.1 boundary
 * like every other motir-core→motir-ai call.
 *
 * **Fresh vs migrate — the audit half is MIGRATE-only (confirmed with Yue).**
 * Two project kinds (story-7.1.ts header):
 *   - **migrate-existing-codebase** — there IS code to read, so 7.14 runs the
 *     FULL engine: the `code_audit` job emits the issues report AND the
 *     `propose_convention` job derives the convention from the existing code
 *     (adopt-if-clear). Sequenced by the 7.16 migrate-onboarding wizard.
 *   - **start-fresh** — there is no code yet, so the AUDIT half does not run;
 *     7.14 only ESTABLISHES a convention from the CHOSEN STACK / starter
 *     (clean-code defaults for that stack), recorded via the same store. The
 *     7.15 fresh-onboarding wizard calls this establish-only path; the audit job
 *     simply has nothing to analyze and is skipped (the code graph is empty —
 *     the same "no code graph yet" branch 7.5.5 already handles).
 *
 * **Mirror (rung 1, VERIFIED this planning session — not asserted).** The
 * clean-code/code-health analyzers and the convention-from-code generators that
 * already exist in the market, each confirming a piece of this design:
 *   - **CodeScene CodeHealth™** — a proprietary code-health METRIC that flags
 *     tech-debt hotspots and high-impact refactor targets: the code-issues audit
 *     report (artifact 1) modelled on a code-health score, not a raw lint dump.
 *   - **SonarQube** — rule-based static analysis (bugs / code smells / quality
 *     gates) across 20+ languages: the clean-code RULE SET the audit measures
 *     against (the deterministic, auditable half).
 *   - **CodeRabbit `code-guidelines` + `@coderabbitai emit path instructions`**
 *     — CodeRabbit collects suggestions from PR history + "repo history, prior
 *     PR patterns, team conventions" and opens a PR that MERGES the learned
 *     rules into `.coderabbit.yaml` "without overwriting existing entries":
 *     EXACTLY the derive-a-convention-from-the-code → propose → human-merge/
 *     approve loop (our propose_convention → review → standard). Its AST-grep
 *     `.yaml` custom rules are the structural-rule encoding.
 *   - **Sourcery "Teaching Sourcery"** — *learns the team's style from feedback,
 *     adapts to the codebase's conventions, reduces noise over weeks*: the
 *     adopt-the-repo's-convention-if-clear half, learned from the code rather
 *     than configured upfront.
 *   - **"Learning Natural Coding Conventions" (Allamanis et al., arXiv
 *     1402.4182) + the infer-conventions-with-ML line** — the academic basis for
 *     adopt-if-clear: emergent conventions can be learned DIRECTLY from a
 *     codebase "without the need to define rules upfront." This is precisely the
 *     adopt-vs-propose decision (a clear emergent convention → adopt; none → fall
 *     back to clean-code defaults).
 *   - **AGENTS.md / CLAUDE.md generators (`agent-dev-guide`)** — auto-generate a
 *     context doc for AI agents from the codebase: the productized-CLAUDE.md
 *     shape. CRUCIAL VERIFIED CAVEAT: an ETH Zurich study found BLINDLY
 *     auto-generated context files reduced task success ~3% and raised cost
 *     ~20%; the field's guidance is "write yours by hand, every line earning its
 *     place." Motir's answer is the explicit PROPOSED→STANDARD human-approval
 *     gate (7.14.5) — we generate a FIRST DRAFT, but a human edits + approves
 *     before it ever enters a prompt, so the convention is curated, not bloated
 *     auto-gen. This caveat is WHY the approval gate is load-bearing, not
 *     optional.
 *
 * **The design gate fires (the report view + the review/approve surface are real
 * UI).** Both artifacts are rendered + acted on in motir-core: the audit report
 * is read, the proposed convention is reviewed / edited / approved. So 7.14.1 is
 * a `type: design` subtask FIRST (AREA `design/coding-convention/`, deps `[]`,
 * `planned`) producing the multi-panel mock, and every UI code subtask (7.14.5)
 * blocks on it. No improvised admin/review screen (the design-gate rule).
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward deps.** Every
 * `dependsOn` id is same-epic backward/sideways: 7.1.3 (the motir-ai DB the store
 * sits on), 7.5.4 (the code graph the audit + propose jobs read), 7.6.2 (the
 * `generate_prompt` job the standard convention injects INTO), and same-story
 * 7.14.x. All are ≤ 7.14. No card points forward: the 7.15 fresh and 7.16
 * migrate onboarding wizards depend on 7.14, never the reverse. Status rule:
 * 7.14.1 (design, deps `[]`) and 7.14.2 (decision, deps `[]`) are `'planned'`;
 * everything chained behind a not-yet-done 7.1.x / 7.5.x / 7.6.x / 7.14.x id is
 * `'blocked'`.
 *
 * **Scope (the eight cards).** the report + review/approve design (7.14.1); the
 * model decision — two artifacts, derived-from-graph, adopt/propose, stored in
 * motir-ai, injected into 7.6 (7.14.2); the `CodingConvention` + `CodeAudit`
 * store on the motir-ai DB (7.14.3); the `code_audit` / `propose_convention` job
 * (7.14.4); the motir-core review/approve UI + API → proposed becomes standard
 * (7.14.5); injecting the standard convention into 7.6 prompt generation
 * (7.14.6); re-audit / refresh as code evolves, versioning the convention
 * (7.14.7); the vitest suite over audit + propose + approve→standard + injection
 * (7.14.8).
 *
 * **Out of scope (named so they land in their owning stories, not here):** the
 * onboarding WIZARDS that sequence 7.14 into the start-fresh (7.15) and migrate
 * (7.16) flows — 7.14 is the ENGINE those wizards orchestrate, not the wizard;
 * the GitHub App + webhook code feed that drives a re-audit (7.7 — 7.14.7 leaves
 * the on-push refresh seam, 7.7 wires the webhook); auto-EDITING the user's code
 * to fix audit findings (forbidden — the report is read-only diagnostic, the AI
 * never writes the tree OR the code outside the dispatch→PR→human-review loop);
 * the clean-code rule SET as a separately shippable product (it is an internal
 * input here, curated alongside the audit job).
 */
export const story_7_14: PlanStory = {
  id: '7.14',
  title: 'Coding convention + code-health audit (the engine)',
  status: 'planned',
  gitBranch: 'feat/PROD-7.14-coding-convention-audit',
  descriptionMd:
    'Give the planner a PROJECT-SPECIFIC sense of "what good code looks like ' +
    'here" by reading the codebase against a clean-code rule set, producing ' +
    'TWO artifacts, and injecting the approved one into every dispatched ' +
    "prompt. This productizes MOTIR.md's own per-repo `CLAUDE.md` " +
    'architecture-contract pattern (the hand-kept 4-layer / `--el-*` / ' +
    'real-Postgres contract motir-core auto-loads for every Subtask prompt) ' +
    'into a GENERATED, per-project, USER-APPROVED artifact every tenant gets ' +
    'for their OWN codebase.\n\n' +
    '**Two artifacts (confirmed):**\n\n' +
    '1. **A code-issues audit report** — what is wrong / to improve in the ' +
    'existing code vs a clean-code rule set (the CodeScene CodeHealth™ / ' +
    'SonarQube code-smell analog). READ-ONLY diagnostic — Motir never ' +
    'auto-edits the code (the AI proposes, the human acts, Principle #3).\n' +
    '2. **A proposed coding convention** — the durable "how we write code ' +
    'here" doc, DERIVED from the existing code structure + clean-code ' +
    'principles. **Adopt-if-clear / propose-if-messy:** adopt + document the ' +
    "repo's convention where it is clear; propose one from clean-code + the " +
    'stack idioms where the repo is messy. It is `status: proposed` until the ' +
    'USER APPROVES, then `status: standard`.\n\n' +
    '**The STANDARD convention is INJECTED into 7.6 prompt generation.** Once ' +
    "a project's convention is `standard`, every `generate_prompt` job (7.6.2) " +
    'folds it into the prompt — the productized auto-load of the `CLAUDE.md` ' +
    'contract, so every dispatched coding/test/design prompt carries THIS ' +
    "project's house rules. The second prompt-quality moat (after 7.5's " +
    'retrieved context).\n\n' +
    '**The FOURTH stateful-motir-ai store (locked architecture #5, on the ' +
    '7.1.3 spine).** motir-ai owns its own Postgres for the context classes ' +
    'with no home in an open PM tool — direction docs (7.2), planning-mistakes ' +
    '(7.10), the code graph (7.5/7.7), and **here** the coding convention + ' +
    'code-health audit, the fourth member, sibling to the other three on the ' +
    'same `AiProject` spine. `CodingConvention` + `CodeAudit` are ' +
    'motir-ai-side tables, NOT motir-core tables — motir-core stays a complete ' +
    'exportable Jira clone with zero AI tables. The only motir-core surfaces ' +
    'are the report VIEW + the review/approve UI, over the 7.1 boundary.\n\n' +
    '**Fresh vs migrate — the AUDIT half is MIGRATE-only (confirmed).** For a ' +
    'migrate-existing-codebase project there IS code, so 7.14 runs the full ' +
    'engine (audit report + convention derived from the code). For a ' +
    'start-fresh project there is no code yet, so the audit does not run — ' +
    '7.14 only ESTABLISHES a convention from the CHOSEN STACK / starter ' +
    '(clean-code defaults), via the same store. The audit job is simply ' +
    'skipped when the code graph is empty (the "no code graph yet" branch).\n\n' +
    '**Mirror (rung-1, VERIFIED):** CodeScene CodeHealth™ (the code-health ' +
    'report metric), SonarQube (the clean-code rule set / code smells), ' +
    'CodeRabbit `code-guidelines` + `emit path instructions` (derive a ' +
    'convention from PR/repo history → propose → human-merge into ' +
    '`.coderabbit.yaml` — our propose→approve→standard loop), Sourcery ' +
    '"Teaching Sourcery" (learn the team style from the codebase = ' +
    'adopt-if-clear), the "Learning Natural Coding Conventions" research ' +
    '(infer emergent conventions directly from code), and AGENTS.md/CLAUDE.md ' +
    'generators (`agent-dev-guide`) — with the VERIFIED caveat that blindly ' +
    'auto-generated context files hurt (ETH Zurich: ~3% worse, ~20% costlier), ' +
    'which is WHY the PROPOSED→STANDARD human-approval gate is load-bearing.\n\n' +
    '**Scope:** the report + review/approve design (7.14.1); the model ' +
    'decision (7.14.2); the `CodingConvention` + `CodeAudit` store (7.14.3); ' +
    'the `code_audit` / `propose_convention` job (7.14.4); the review/approve ' +
    'UI + API → standard (7.14.5); injection into 7.6 prompt gen (7.14.6); ' +
    're-audit / refresh + versioning (7.14.7); vitest (7.14.8).\n\n' +
    '**Out of scope (named so they land elsewhere):** the onboarding WIZARDS ' +
    'that sequence 7.14 (start-fresh 7.15, migrate 7.16) — 7.14 is the ENGINE ' +
    'they orchestrate, not the wizard; the GitHub webhook that drives a ' +
    're-audit (7.7 — 7.14.7 leaves the seam); auto-EDITING the code to fix ' +
    'findings (forbidden — the report is read-only; code only changes through ' +
    'the dispatch→PR→human-review loop); the clean-code rule set as a separate ' +
    'product (an internal input here).',
  verificationRecipeMd:
    '- Pull the Story branch; in `motir-core` run `pnpm install`, `pnpm prisma ' +
    'generate`, `pnpm db:seed`; in `motir-ai` run its install + `pnpm prisma ' +
    'generate` + `pnpm migrate` against the local docker Postgres (7.1.3), ' +
    'with a fixture code graph indexed (7.5.4).\n' +
    '- **The audit + propose smoke (migrate path — the engine).** For a ' +
    'project whose code graph is the 7.5.4 fixture, submit a `code_audit` job ' +
    '→ a `CodeAudit` report appears listing concrete issues measured against ' +
    'the clean-code rule set (each with a file/symbol ref from the code graph, ' +
    'a severity, and a "why"); submit a `propose_convention` job → a ' +
    '`CodingConvention` row appears with `status: proposed`, a `contentMd` ' +
    'that ADOPTS the clear conventions present in the fixture (e.g. its ' +
    'layering / naming) and PROPOSES rules where the fixture is silent. ' +
    'Neither job edits the fixture code (read-only).\n' +
    '- **Adopt-if-clear / propose-if-messy.** Run `propose_convention` over a ' +
    'CLEAN fixture (consistent layering) → the convention ADOPTS it and says ' +
    'so; run it over a MESSY fixture (inconsistent) → it falls back to ' +
    'proposing clean-code defaults for the stack and flags the inconsistency. ' +
    'The provenance of each rule (adopted-from-code vs proposed-from-clean-' +
    'code) is visible.\n' +
    '- **The review/approve gate → standard.** In motir-core, signed in as the ' +
    'project manager, open the coding-convention surface (7.14.5): the audit ' +
    'report renders; the proposed convention renders editable; edit a rule, ' +
    'then **Approve** → the convention flips to `status: standard` in motir-ai ' +
    '(verify over the boundary). A non-PM member is gated (the 6.4 permission ' +
    'the surface adopts).\n' +
    '- **Injection into 7.6 (the moat).** With the convention `standard`, ' +
    'submit a `generate_prompt` job (7.6.2) for a ready `code` item → the ' +
    "assembled prompt now CARRIES the project's standard convention (assert " +
    'the convention text appears in the prompt). With the convention still ' +
    '`proposed` (not approved), the prompt does NOT carry it (only the ' +
    'approved standard is injected — the approval gate is enforced).\n' +
    '- **Fresh path (establish-only, no audit).** For a start-fresh project ' +
    '(empty code graph), the establish path records a convention from the ' +
    'chosen stack WITHOUT running an audit (no `CodeAudit` row is produced — ' +
    'there is nothing to analyze); the convention still goes through the same ' +
    'proposed→approve→standard gate before it is injected.\n' +
    '- **Re-audit / refresh.** Re-run the audit + propose on a changed ' +
    'fixture (or via the 7.7 webhook seam) → a NEW `CodeAudit` is recorded and ' +
    'the convention is VERSIONED (the prior standard is retained as history; ' +
    'the new proposal must be re-approved before it supersedes — a refresh ' +
    'never silently changes an approved standard).\n' +
    '- `pnpm test` (motir-ai) + `pnpm test` (motir-core) — 7.14.8 covers the ' +
    'audit + propose jobs, adopt/propose detection, approve→standard, the ' +
    'injection (standard carried / proposed not carried), and the versioning.\n' +
    '- **Open-core check (this Epic’s recurring posture).** The ' +
    '`CodingConvention` + `CodeAudit` tables exist ONLY in motir-ai (no such ' +
    "tables in motir-core's schema); the report/review UI reaches them solely " +
    'over the 7.1 boundary (no `motir-ai` import in motir-core, no shared DB). ' +
    'The convention + audit are part of the closed planning brain.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    "fails, comment with what didn't work and Motir will produce a follow-up " +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.14.1',
      title:
        'Design — the code-health audit report view + the proposed-convention review/approve surface',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** design (the planning-time design gate, notes.html #31 — the ' +
        'design-reference rule the lessons store itself encodes). Both ' +
        'artifacts are RENDERED + ACTED ON in motir-core (the audit report is ' +
        'read; the proposed convention is reviewed / edited / approved), so ' +
        'this surface is real UI; the UI code subtask (7.14.5) depends on this ' +
        'and is blocked until it exists. Without it the report/approve screen ' +
        'would be improvised, which is forbidden.\n\n' +
        'Produce the design asset for the **coding-convention** surface under ' +
        '`motir-core/design/coding-convention/`. Author it as a ' +
        '**`*.mock.html` mockup** built from the real design system (the ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen` (the ' +
        'coding-agent-produced-design route; the reviewer sees the actual ' +
        'tokens). Render a PNG export if useful, but the `.mock.html` is the ' +
        'source of truth.\n\n' +
        '**Surfaces to draw** (multi-panel board — EVERY panel, the ' +
        'multi-panel rule, notes.html #31):\n\n' +
        '- **Panel 1 — the code-health audit report.** A header ("Code health" ' +
        '+ an overall health summary — a CodeScene-CodeHealth-style score / ' +
        'grade, NOT a raw lint dump) and below it a list of ISSUE cards grouped ' +
        'by severity or by rule category (layering / naming / duplication / ' +
        'complexity / test-coverage gaps). Each row: the rule it violates, a ' +
        'file/symbol ref (from the code graph), a severity `Pill` (distinct ' +
        '`--el-*` tone per severity, AA on a tint), and a one-line "why this ' +
        'matters". The list VIRTUALIZES / paginates (a real codebase yields ' +
        'many findings — the planning-time scale check, no "load all rows"). ' +
        'This panel is MIGRATE-only — see Panel 4 for the fresh state.\n' +
        '- **Panel 2 — the proposed-convention review.** The proposed ' +
        '`contentMd` rendered as a readable document (sectioned: layering / ' +
        'naming / testing / error-handling / etc.), with each rule badged by ' +
        'PROVENANCE — **Adopted** (a `--el-*` tone meaning "your code already ' +
        'does this, we documented it") vs **Proposed** (a distinct tone ' +
        'meaning "your code was silent/inconsistent, here is a clean-code ' +
        'default"). A prominent **status banner**: `PROPOSED — review & ' +
        'approve` vs `STANDARD — injected into every prompt`. Draw both states.\n' +
        '- **Panel 3 — edit + approve.** The editable form state (the ' +
        'convention is editable Markdown on the `--el-*` input/textarea ' +
        'tokens before approval), a **Approve as standard** primary button, and ' +
        'a small explainer of what approval DOES ("this becomes the coding ' +
        'standard injected into every prompt Motir generates for this ' +
        'project"). Show the approve-confirmation (reuse the shipped confirm/' +
        'dialog primitive). This panel communicates that approval is a ' +
        'deliberate human gate (the ETH-Zurich-caveat answer — no silent ' +
        'auto-gen into prompts).\n' +
        '- **Panel 4 — the FRESH (establish-only) + empty/version states.** ' +
        'For a start-fresh project there is no audit (Panel 1 shows an ' +
        '`EmptyState`: "No codebase to analyze yet — your convention is ' +
        'established from your chosen stack"), and Panel 2 shows the ' +
        'stack-derived proposal. Also draw the VERSION-history affordance (a ' +
        'prior approved standard retained when a re-audit proposes a new ' +
        'version — the 7.14.7 refresh) and the "re-run audit" action.\n\n' +
        'Also write **`design/coding-convention/design-notes.md`** naming the ' +
        'exact primitives composed per surface, the exact copy strings (the ' +
        'health-summary wording, the Adopted/Proposed badge labels, the ' +
        'status-banner copy, the approve-confirmation copy, the fresh empty ' +
        'state), the placement decisions, the per-`--el-*` colour role for each ' +
        'element (the severity tones, the Adopted-vs-Proposed tones, the ' +
        'proposed-vs-standard banner), and a "primitives composed (no ' +
        'hand-rolling)" checklist.\n\n' +
        '**Mirror (rung-1, VERIFIED).** Cite in design-notes: CodeScene ' +
        'CodeHealth™ (the report is a health SCORE + hotspots, not a raw lint ' +
        'list); CodeRabbit `code-guidelines` (the propose→review→approve-into-' +
        'config shape); the AGENTS.md/CLAUDE.md-generator caveat (the ETH ' +
        'Zurich finding that blind auto-gen hurts) → which JUSTIFIES the ' +
        'explicit approve gate Panel 3 draws.\n\n' +
        '**Branch.** `design/PROD-7.14.1-coding-convention`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy — this PR only ' +
        'edits `design/coding-convention/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/coding-convention/convention.mock.html` exists, ' +
        'renders the four panels side-by-side, and references ONLY `--el-*` ' +
        'colour + `[data-display-style]` shape tokens (no Tier-0 `--color-*`, ' +
        'no hand-rolled radius/spacing — the `motir-core/CLAUDE.md` rules).\n' +
        '- The audit report renders as a HEALTH summary + grouped issue cards ' +
        '(severity tones, file/symbol refs), virtualized/paginated — NOT an ' +
        'unbounded raw dump.\n' +
        '- The proposed convention badges each rule by provenance ' +
        '(Adopted vs Proposed), shows the PROPOSED vs STANDARD status banner ' +
        '(both states drawn), and the **Approve as standard** action + its ' +
        'confirmation are present.\n' +
        '- The fresh (establish-only) empty-audit state and the version-history ' +
        '/ re-run affordance are drawn (Panel 4).\n' +
        '- `motir-core/design/coding-convention/design-notes.md` exists, names ' +
        'every primitive composed + every copy string + the per-element ' +
        '`--el-*` role, and cites the CodeScene / CodeRabbit / CLAUDE.md-' +
        'generator-caveat mirror.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, the confirm dialog, textarea, `EmptyState`, the virtualized ' +
        'list) — no new design-system entry invented inside this Story (if one ' +
        'is needed, that is a NEW `design/` subtask, not a code workaround).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ai-admin/` (7.10.5) + `motir-core/design/ready/` ' +
        '(7.0.1) — the closest existing multi-panel `*.mock.html` + ' +
        '`design-notes.md` to mirror for layout (report list + review surface).\n' +
        '- `motir-core/components/ui/Pill.tsx` — the severity + provenance ' +
        'badges (the scope/status tones).\n' +
        '- `motir-core/components/ui/EmptyState.tsx` — the fresh / no-audit ' +
        'state (Panel 4).\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + ' +
        '`[data-display-style]` shape tokens the mockup references.\n' +
        '- 7.14.3 — the `CodingConvention` + `CodeAudit` field shapes the ' +
        'panels render (status / version / contentMd / the audit issues).\n' +
        '- CodeScene CodeHealth™ + CodeRabbit `code-guidelines` (the verified ' +
        'mirror) — cited in design-notes.',
      dependsOn: [],
    },
    {
      id: '7.14.2',
      title:
        'Decision — the model: two artifacts (audit + proposed→standard convention), graph-derived, motir-ai-stored, 7.6-injected',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** decision (the keystone ADR the rest of 7.14 — and the 7.15/' +
        '7.16 onboarding wizards — build against). Produce ' +
        '`motir-ai/docs/decisions/coding-convention-model.md`; no app behavior ' +
        'ships here, but the shapes it fixes are load-bearing.\n\n' +
        'Fix the model:\n\n' +
        '1. **Two artifacts, one store.** (a) a **code-issues audit** ' +
        '(`CodeAudit`) — a structured report of findings vs a clean-code rule ' +
        'set, READ-ONLY (Motir never auto-edits code); (b) a **coding ' +
        'convention** (`CodingConvention`) — a Markdown document with ' +
        '`status: proposed | standard` + a `version`. Both hang off the 7.1.3 ' +
        '`AiProject` spine in motir-ai (the fourth context store).\n' +
        '2. **Derived from the 7.5 code graph + a clean-code rule set.** The ' +
        'audit + the convention are produced by READING the existing code ' +
        'through the 7.5.4 code-graph tools (structure / layering / naming / ' +
        'call + import edges) and measuring/comparing against a curated ' +
        'CLEAN-CODE RULE SET (the SonarQube-code-smell / CodeScene-CodeHealth ' +
        'analog). Fix WHAT the rule set covers at a category level (layering, ' +
        'naming, function size/complexity, duplication, error handling, test ' +
        'posture) and that it is an internal curated input, not a separately ' +
        'shipped product.\n' +
        '3. **Adopt-if-clear / propose-if-messy — the detection rule.** Define ' +
        'how "the repo has a clear convention" vs "messy / no clear ' +
        'convention" is DETECTED per category: a category is ADOPTED when the ' +
        'code graph shows a consistent, dominant pattern (e.g. ≥ a threshold ' +
        'of modules follow one layering / naming scheme); it is PROPOSED (from ' +
        'clean-code defaults for the stack) when the pattern is absent or ' +
        'inconsistent. Each emitted rule records its PROVENANCE ' +
        '(adopted-from-code vs proposed-from-clean-code) so the review surface ' +
        '(7.14.1) can badge it. Cite the verified mirror: Sourcery learns the ' +
        'team style from the codebase; the "Learning Natural Coding ' +
        'Conventions" research infers emergent conventions directly from code ' +
        '— adopt-if-clear is exactly that, with a clean-code fallback.\n' +
        '4. **proposed → standard ONLY on user approval.** The convention is ' +
        '`proposed` when generated and becomes `standard` only when a human ' +
        'approves it (7.14.5). This is the load-bearing gate: cite the VERIFIED ' +
        'ETH-Zurich caveat (blindly auto-generated CLAUDE.md/AGENTS.md context ' +
        'files reduced task success ~3% and raised cost ~20%) — we generate a ' +
        'first draft but a human curates + approves before it enters any ' +
        'prompt, so the productized CLAUDE.md is curated, not bloated auto-gen.\n' +
        '5. **INJECTED into 7.6 prompt generation (the productized CLAUDE.md).** ' +
        'Only a `standard` convention is injected; the `generate_prompt` job ' +
        '(7.6.2) folds it into every dispatched prompt. Fix WHERE it sits in ' +
        'the prompt (the constraints/house-rules section, alongside the ' +
        'per-type 4-layer/token rules 7.6.2 already embeds) and that a ' +
        '`proposed` (un-approved) convention is NEVER injected.\n' +
        '6. **Fresh vs migrate.** Fix that the AUDIT (`CodeAudit`) runs ONLY ' +
        'for migrate (there is code); for fresh, only the convention is ' +
        'ESTABLISHED from the chosen stack (no audit), through the same store + ' +
        'the same proposed→approve→standard gate. The job layer detects "no ' +
        'code graph yet" and skips the audit.\n' +
        '7. **Versioning + refresh.** Fix that a re-audit (7.14.7) produces a ' +
        'NEW `CodeAudit` and a NEW proposed `CodingConvention` version; an ' +
        'approved standard is RETAINED as history and a refresh never silently ' +
        'overwrites it — the new version must be re-approved to supersede.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/docs/decisions/coding-convention-model.md` exists and ' +
        'fixes all seven points above with concrete schemas for `CodeAudit` + ' +
        '`CodingConvention` (the input to 7.14.3) and a worked example of an ' +
        'adopted vs a proposed rule.\n' +
        '- The adopt-vs-propose DETECTION rule is concrete (the consistency/' +
        'dominance threshold per category + the clean-code fallback) and each ' +
        'rule carries provenance.\n' +
        '- The proposed→standard approval gate is justified in one paragraph ' +
        'citing the verified ETH-Zurich auto-gen caveat; the injection point in ' +
        '7.6 is fixed (standard-only, never proposed).\n' +
        '- The fresh-vs-migrate split (audit migrate-only; establish-only for ' +
        'fresh) and the versioning/refresh rule are both fixed.\n' +
        '- The mirror is CITED, not asserted (CodeScene CodeHealth™, SonarQube, ' +
        'CodeRabbit `code-guidelines`/`emit path instructions`, Sourcery ' +
        '"Teaching Sourcery", the "Learning Natural Coding Conventions" ' +
        'research, the CLAUDE.md-generator caveat).\n\n' +
        '## Context refs\n\n' +
        '- story-7.1.ts header §4–5 — motir-ai is stateful; the context ' +
        'stores; this convention+audit is the fourth, on the 7.1.3 spine.\n' +
        '- Story 7.5 (stub) 7.5.4/7.5.5 — the code graph + query tools the ' +
        'audit + propose jobs read.\n' +
        '- Story 7.6 (stub) 7.6.2 — the `generate_prompt` job the standard ' +
        'convention injects into (the productized CLAUDE.md).\n' +
        '- `motir-core/CLAUDE.md` — the hand-kept per-repo architecture ' +
        'contract this generalizes into a per-project generated artifact.\n' +
        '- The verified mirror (CodeScene / SonarQube / CodeRabbit / Sourcery / ' +
        'the convention-inference research / the auto-gen-CLAUDE.md caveat).',
      dependsOn: [],
    },
    {
      id: '7.14.3',
      title: 'The store (motir-ai) — `CodingConvention` + `CodeAudit` schema + repo/service',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Stand up the coding-convention + code-health store as the FOURTH ' +
        "context store on motir-ai's own Postgres (the 7.1.3 Prisma " +
        'foundation) — alongside direction docs (7.2), planning-mistakes ' +
        '(7.10), and the code graph (7.5/7.7). These are motir-ai-side tables; ' +
        'motir-core never gets a convention or audit table (the open-core ' +
        'boundary stays clean).\n\n' +
        'Add the two models per the 7.14.2 decision:\n\n' +
        '```prisma\n' +
        '// motir-ai/prisma/schema.prisma\n' +
        'model CodingConvention {\n' +
        '  id           String            @id @default(cuid())\n' +
        '  aiProjectId  String\n' +
        '  aiProject    AiProject         @relation(fields: [aiProjectId], references: [id], onDelete: Cascade)\n' +
        '  status       ConventionStatus  // proposed | standard\n' +
        '  version      Int               // monotonic per project; a refresh bumps it (7.14.7)\n' +
        '  contentMd    String            // the convention document (sectioned house rules)\n' +
        '  // per-rule provenance (adopted-from-code vs proposed-from-clean-code) for the review badges\n' +
        '  provenanceJson Json?\n' +
        '  approvedByUserId String?       // the core user who approved (set when status flips to standard)\n' +
        '  approvedAt   DateTime?\n' +
        '  createdAt    DateTime          @default(now())\n' +
        '  updatedAt    DateTime          @updatedAt\n' +
        '  @@unique([aiProjectId, version])\n' +
        '  @@index([aiProjectId, status])\n' +
        '}\n' +
        '\n' +
        'model CodeAudit {\n' +
        '  id           String     @id @default(cuid())\n' +
        '  aiProjectId  String\n' +
        '  aiProject    AiProject  @relation(fields: [aiProjectId], references: [id], onDelete: Cascade)\n' +
        '  // health summary (a CodeScene-CodeHealth-style score/grade) + the structured findings\n' +
        '  healthSummaryJson Json\n' +
        '  findingsJson Json       // [{ rule, category, severity, fileRef, symbolRef, why }]\n' +
        '  codeGraphRef String?    // which CodeRepo/index version was audited (7.5.4)\n' +
        '  jobId        String?    // the code_audit job that produced it\n' +
        '  createdAt    DateTime   @default(now())\n' +
        '  @@index([aiProjectId, createdAt])\n' +
        '}\n' +
        '\n' +
        'enum ConventionStatus { proposed standard }\n' +
        '```\n\n' +
        'Exactly ONE `standard` convention per project at a time (the ' +
        'most-recently-approved version); prior standards are retained as ' +
        'history (older rows). `findingsJson` is a bounded, paginatable ' +
        'structure — a real codebase yields many findings, so the repo read ' +
        'paginates rather than returning the whole blob to a list view (the ' +
        'scale check). `provenanceJson` records, per rule, whether it was ' +
        'ADOPTED from the code or PROPOSED from clean-code defaults (the ' +
        '7.14.1 badges).\n\n' +
        "Layer it the way 7.1.3 / 7.10.1 established (mirror motir-core's " +
        'Route→Service→Repository spirit lightly):\n\n' +
        '- **`codingConventionRepository`** — single-op Prisma: `create` ' +
        '(write, takes `tx`), `update`, `findById`, ' +
        '`findStandard(aiProjectId)` (the one current standard), ' +
        '`findLatest(aiProjectId)` (the newest version, any status), ' +
        '`listVersions(aiProjectId, cursor, limit)` (version history, ' +
        'cursor-paginated — no unbounded load).\n' +
        '- **`codeAuditRepository`** — `create` (write, `tx`), ' +
        '`findLatest(aiProjectId)`, `listForProject(aiProjectId, cursor, ' +
        'limit)` (paginated), and a findings-read that pages within one audit.\n' +
        '- **`codingConventionService`** — business logic: ' +
        '`recordProposed(aiProjectId, contentMd, provenance, { version })` ' +
        '(the 7.14.4 job calls this), `approveAsStandard(conventionId, ' +
        'userId)` (the 7.14.5 gate — flips proposed→standard, demotes the ' +
        'prior standard to history, idempotent), `getStandardForInjection' +
        '(aiProjectId)` (the 7.14.6 read — returns the standard `contentMd` or ' +
        'null), `getForReview(aiProjectId)` (the latest proposed + the audit ' +
        'for the review UI). Returns DTOs, not raw Prisma rows.\n' +
        '- **`codeAuditService`** — `recordAudit(...)`, ' +
        '`getLatest(aiProjectId)`. Returns DTOs.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/schema.prisma` gains `CodingConvention` + ' +
        '`CodeAudit` + `ConventionStatus` with a migration; `pnpm prisma ' +
        'generate` + `pnpm migrate` run clean against the local docker ' +
        'Postgres.\n' +
        '- Both models hang off `AiProject` and cascade on its delete; ' +
        '`CodingConvention` is unique per `(aiProjectId, version)`.\n' +
        '- `approveAsStandard` flips exactly one convention to `standard`, ' +
        'demotes the prior standard to history (only ONE standard per project ' +
        'at a time), records `approvedByUserId` + `approvedAt`, and is ' +
        'idempotent; `getStandardForInjection` returns the current standard ' +
        '`contentMd` or null when none is approved.\n' +
        '- Repo write methods require `tx`; `listVersions` / `listForProject` / ' +
        'the findings read are cursor-paginated (no unbounded load).\n' +
        '- The tables exist ONLY in motir-ai — no convention/audit table in ' +
        "motir-core's schema; no motir-core DB connection in motir-ai.\n\n" +
        '## Context refs\n\n' +
        '- `motir-ai/prisma/schema.prisma` + the `AiProject` spine from 7.1.3 ' +
        '(the per-project identity these hang off).\n' +
        '- 7.10.1 (`Lesson` store) — the closest existing motir-ai store ' +
        'pattern (repo/service shape, cursor pagination, DTOs) to mirror.\n' +
        '- 7.14.2 — the model decision fixing the two schemas + status machine.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer — the Route→Service→Repository ' +
        'pattern motir-ai mirrors lightly.',
      dependsOn: ['7.1.3'],
    },
    {
      id: '7.14.4',
      title:
        'The audit + propose job (motir-ai) — `code_audit` / `propose_convention` over the code graph',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Implement the engine: two job handlers in motir-ai (new `jobKind`s ' +
        "registered against the 7.1.4 handler registry, replacing 7.1.7's " +
        '`noop` for these kinds) that READ the existing code via the 7.5 code ' +
        'graph + a clean-code rule set and emit the two artifacts. These jobs ' +
        'NEVER edit the code (read-only diagnostic — Principle #3).\n\n' +
        "**`jobKind: code_audit`** — analyze the project's code graph (the " +
        '7.5.4 store, queried via the 7.5.5 `code_explore`/`code_search`/' +
        '`code_callers`/`code_impact` tools) against the curated clean-code ' +
        'rule set (layering / naming / function size + complexity / ' +
        'duplication / error handling / test posture — the 7.14.2 categories). ' +
        'Emit a `CodeAudit`: a health summary (a CodeScene-CodeHealth-style ' +
        'score/grade) + structured findings, each with the rule, category, ' +
        'severity, a file/symbol ref FROM THE GRAPH, and a "why". Records via ' +
        '`codeAuditService.recordAudit`. **MIGRATE-only:** if the project has ' +
        'no indexed code graph (start-fresh before code), the job detects the ' +
        '"no code graph yet" state and SKIPS the audit cleanly (no `CodeAudit` ' +
        'row, a clear result saying there was nothing to analyze) — the same ' +
        'empty-graph branch 7.5.5 already returns.\n\n' +
        '**`jobKind: propose_convention`** — derive the coding convention. For ' +
        'each rule CATEGORY, apply the 7.14.2 adopt-if-clear / propose-if-messy ' +
        'detection: query the code graph for the dominant pattern; if a ' +
        'consistent convention is present (above the dominance threshold), ' +
        'ADOPT + document it (provenance = adopted-from-code); if absent / ' +
        "inconsistent, PROPOSE a clean-code default for the project's stack " +
        '(provenance = proposed-from-clean-code). Assemble the `contentMd` (the ' +
        'sectioned house-rules document) + the per-rule `provenanceJson`, and ' +
        'record it `status: proposed` via ' +
        '`codingConventionService.recordProposed` (version = previous + 1, or 1 ' +
        'for the first). **Fresh (establish-only):** when there is no code ' +
        'graph, this job runs from the CHOSEN STACK alone (every category is ' +
        'proposed-from-clean-code for that stack — no adoption, no audit ' +
        'dependency) so a fresh project still gets a proposed convention.\n\n' +
        '**LLM-assisted, graph-grounded.** Both jobs use the planner LLM/SDK ' +
        '(the same the 7.2.2 decision provisions) to turn graph facts + ' +
        'rule-set matches into readable findings + convention prose — but ' +
        'GROUNDED in the code graph (every finding cites a real file/symbol; no ' +
        'fabricated refs, the 7.6.2 honesty rule). Stream progress over the ' +
        '7.1.4 job stream; return the structured result (the audit id / the ' +
        'proposed convention id) motir-core consumes.\n\n' +
        'Lightly layer on the motir-ai side: handler modules + a clean-code ' +
        'rule-set module (the curated categories + per-stack defaults) + the ' +
        'context helper that wraps the 7.5 code-graph tools. The jobs reuse ' +
        "7.5.5's code-graph tools — they do NOT re-implement graph access.\n\n" +
        '## Acceptance criteria\n\n' +
        '- `code_audit` + `propose_convention` handlers are registered on the ' +
        '7.1.4 registry; submitting each for a fixture-backed project returns ' +
        'a result, streaming progress to terminal.\n' +
        '- `code_audit` emits a `CodeAudit` (health summary + findings, each ' +
        'with a real code-graph file/symbol ref + severity + why); it does NOT ' +
        'edit the code; for an un-indexed (fresh) project it SKIPS cleanly ' +
        '(no audit row).\n' +
        '- `propose_convention` emits a `status: proposed` `CodingConvention` ' +
        'whose rules carry provenance: ADOPTED where the code graph shows a ' +
        'consistent pattern, PROPOSED (clean-code default) where it is silent/' +
        'inconsistent; a clean fixture yields more adopted rules, a messy one ' +
        'more proposed.\n' +
        '- The fresh (establish-only, no code graph) path still produces a ' +
        'proposed convention from the chosen stack (all proposed-from-clean-' +
        'code) and runs NO audit.\n' +
        '- Every finding/convention ref is grounded in the code graph (no ' +
        'fabricated file refs); the jobs read ONLY via the 7.5 tools + carry ' +
        'the job-scoped token (no direct motir-core DB access).\n\n' +
        '## Context refs\n\n' +
        '- 7.14.3 — `codeAuditService` / `codingConventionService` (the store ' +
        'these jobs write).\n' +
        '- 7.14.2 — the model + the adopt-if-clear / propose-if-messy detection ' +
        'rule + the clean-code rule-set categories.\n' +
        '- Story 7.5 (stub) 7.5.4/7.5.5 — the code-graph store + ' +
        '`code_explore`/`code_search`/`code_callers`/`code_impact` tools these ' +
        'jobs read through (and the "no code graph yet" empty branch).\n' +
        '- 7.1.4 (the `jobKind` registry + job stream), 7.1.1 (the request/' +
        'result envelope).\n' +
        '- 7.2.2 (stub) — the planner LLM/SDK the grounded prose generation ' +
        'uses.\n' +
        '- The verified mirror (SonarQube code smells / CodeScene CodeHealth™ ' +
        'for the audit; Sourcery + the convention-inference research for ' +
        'adopt-if-clear).',
      dependsOn: ['7.14.3', '7.5.4'],
    },
    {
      id: '7.14.5',
      title:
        'The review/approve UI + API (motir-core) — render the audit + proposed convention; approve → standard',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the coding-convention surface in **motir-core** that renders ' +
        'exactly what 7.14.1 specifies — the audit report + the proposed ' +
        'convention — and closes the approval gate: a human edits + approves, ' +
        'and the convention becomes STANDARD (recorded in motir-ai over the ' +
        '7.1 boundary). It reads/writes the store in motir-ai via the ' +
        '`lib/ai/motirAiClient` (7.1.5) — never a direct DB reach (the ' +
        'open-core invariant: motir-core holds no AI tables, talks to the store ' +
        'only over HTTP).\n\n' +
        '**The motir-ai read/write endpoints.** This subtask adds the small ' +
        'motir-ai HTTP surface the UI consumes (service-credential + the 7.1 ' +
        'project identity, all delegating to the 7.14.3 services): ' +
        '`GET /v1/projects/:id/code-audit` (the latest audit, findings ' +
        'cursor-paginated), `GET /v1/projects/:id/convention` (the latest ' +
        'proposed/standard + provenance), `PATCH /v1/projects/:id/convention/' +
        ':conventionId` (edit the proposed `contentMd` before approval), and ' +
        '`POST /v1/projects/:id/convention/:conventionId/approve` (flip ' +
        'proposed→standard via `approveAsStandard`, recording the approving ' +
        'core user). A `standard` convention is not editable in place — a ' +
        'change means a new proposed version (the 7.14.7 refresh).\n\n' +
        '**The motir-core surface (4-layer).**\n\n' +
        '- A server-side `aiConventionService` in motir-core that calls the ' +
        '7.1.5 client (`getCodeAudit` / `getConvention` / `editConvention` / ' +
        '`approveConvention`), maps contract errors to motir-core typed ' +
        'errors, and is the ONLY thing the route/page calls — no client ' +
        'component touches the client directly.\n' +
        '- Routes under `app/api/ai/coding-convention/*` (audit / convention ' +
        'get / patch / approve) that parse + session-gate (the surface adopts a ' +
        '6.4 project-admin permission — approving the standard that drives ' +
        'every dispatched prompt is a manager action, not every member; ' +
        '404-not-403 on a cross-tenant project), call the one service method, ' +
        'map errors.\n' +
        '- The page `app/(authed)/settings/ai/coding-convention/page.tsx` (or ' +
        'the established admin/settings location) — a Server Component ' +
        'rendering the panels from the mockup: the audit report (health ' +
        'summary + the virtualized/paginated findings list), the proposed ' +
        'convention with the Adopted/Proposed provenance badges + the PROPOSED/' +
        'STANDARD status banner, the editable form, and the **Approve as ' +
        'standard** action + confirmation. The fresh/empty-audit + ' +
        'version-history states per Panel 4.\n' +
        '- **i18n** — page strings in a new `codingConvention` namespace; the ' +
        'nav/settings entry localized, the same locale set the app ships.\n' +
        '- **Tokens** — composes ONLY the shipped `components/ui/*` primitives ' +
        '+ `--el-*` colour + `[data-display-style]` shape tokens per 7.14.1 ' +
        '(no Tier-0 `--color-*`, no hand-rolled spacing).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The page renders the panels from 7.14.1 (audit report + proposed ' +
        'convention with provenance badges + status banner), composed of the ' +
        'named primitives, referencing only `--el-*` + `[data-display-style]` ' +
        'tokens; the findings list paginates (no unbounded load).\n' +
        '- Editing the proposed convention persists through the boundary into ' +
        'motir-ai; **Approve as standard** flips it to `standard` (verifiable ' +
        'over the boundary) and demotes the prior standard to history.\n' +
        '- A `standard` convention is not editable in place (an edit creates a ' +
        'new proposed version); the approve confirmation makes the effect ' +
        'explicit ("injected into every prompt").\n' +
        '- The surface is gated to the project-admin permission (a non-admin ' +
        'member is blocked); a cross-tenant project is 404-not-403; reads/' +
        'writes are over the 7.1 boundary (no `motir-ai` import, no shared DB ' +
        'in motir-core).\n' +
        '- 4-layer respected: route → `aiConventionService` → 7.1.5 client; no ' +
        'client component touches the client; the fresh/empty + version states ' +
        'render.\n\n' +
        '## Context refs\n\n' +
        '- 7.14.1 — the design asset this implements (the four panels + ' +
        'design-notes.md).\n' +
        '- 7.14.3 — `codingConventionService` / `codeAuditService` + the ' +
        'motir-ai endpoints this exposes/consumes (incl. `approveAsStandard`).\n' +
        '- 7.1.5 — `lib/ai/motirAiClient` (the server-to-server boundary the ' +
        'surface reads/writes over).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour / § shape.\n' +
        '- `motir-core/app/(authed)/settings/ai/lessons/page.tsx` (7.10.6) — ' +
        'the sibling motir-ai-backed admin surface (Server Component + ' +
        'virtualized list + 7.1-boundary reads) to mirror.',
      dependsOn: ['7.14.1', '7.14.3'],
    },
    {
      id: '7.14.6',
      title:
        'Inject the STANDARD convention into 7.6 prompt generation (the productized CLAUDE.md)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Wire the approved STANDARD convention into prompt generation so every ' +
        "dispatched prompt carries the project's house rules — the " +
        "productized auto-load of MOTIR.md's `CLAUDE.md`. This is the payoff: " +
        "the second prompt-quality moat after 7.5's retrieved context. With it, " +
        'a dispatched coding agent writes code that FITS the project because ' +
        'the convention is in the prompt.\n\n' +
        'Inside motir-ai, when the `generate_prompt` job (7.6.2) assembles its ' +
        'prompt, call `codingConventionService.getStandardForInjection' +
        "(aiProjectId)` and fold the standard `contentMd` into the prompt's " +
        'CONSTRAINTS / house-rules section — alongside (not replacing) the ' +
        'per-type 4-layer / `--el-*` / real-Postgres rules 7.6.2 already ' +
        'embeds. The project convention is the PROJECT-SPECIFIC layer; the ' +
        'per-type template is the type-specific layer; both ride into the ' +
        'prompt.\n\n' +
        '**Standard-only — the approval gate is enforced HERE too.** Only a ' +
        '`status: standard` convention is injected. A `proposed` (un-approved) ' +
        'convention is NEVER folded into a prompt — the human-approval gate ' +
        '(the ETH-Zurich-caveat answer) holds at the injection point, not just ' +
        'the UI. If no standard exists yet (a fresh project before approval, or ' +
        'a project that has not run 7.14), injection is a clean no-op and the ' +
        'prompt is unchanged — the enhancement property (7.6 generation runs ' +
        'fine with no convention, this makes it better).\n\n' +
        'This is additive to the 7.6.2 assembly: one injection point, one ' +
        'service read, guarded by status. It does not change the 7.6.2 per-type ' +
        'registry or the 7.5 context injection — it adds the project-convention ' +
        'layer to the same assembled prompt.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `generate_prompt` (7.6.2) folds the project's STANDARD convention " +
        '`contentMd` into the prompt constraints/house-rules section (alongside ' +
        'the per-type rules), via `getStandardForInjection`.\n' +
        '- Only a `standard` convention is injected; a `proposed` (un-approved) ' +
        'convention is NEVER injected (asserted) — the approval gate holds at ' +
        'the prompt boundary.\n' +
        '- With NO standard convention (fresh-before-approval / 7.14 not run), ' +
        'injection is a no-op and the prompt is unchanged (the enhancement ' +
        'property).\n' +
        '- The injection is additive: it does not alter the 7.6.2 per-type ' +
        'registry or the 7.5 retrieved-context injection — it adds the ' +
        'project-convention layer to the same prompt.\n' +
        '- The injected convention is visible in the assembled prompt the ' +
        'dispatch surface shows (so a human can eyeball that the house rules ' +
        'landed).\n\n' +
        '## Context refs\n\n' +
        '- Story 7.6 (stub) 7.6.2 — the `generate_prompt` job + its prompt ' +
        'assembly (the constraints section) this injects the convention into.\n' +
        '- 7.14.3 — `codingConventionService.getStandardForInjection` (the ' +
        'standard-only read this calls).\n' +
        '- 7.14.2 — the decision fixing standard-only injection + the prompt ' +
        'placement (the productized CLAUDE.md).\n' +
        '- `motir-core/CLAUDE.md` — the hand-kept contract this generalizes ' +
        '(the auto-loaded-for-every-prompt shape it productizes).\n' +
        '- story-7.10.ts 7.10.3 — the sibling plan-time injection (lessons into ' +
        'the planner) this mirrors on the prompt-gen side.',
      dependsOn: ['7.14.3', '7.6.2'],
    },
    {
      id: '7.14.7',
      title:
        're-audit / refresh — re-run as the code evolves (on-demand or 7.7 webhook); version the convention',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Keep the audit + convention CURRENT as the codebase evolves. A ' +
        'convention generated once at onboarding goes stale; this card makes ' +
        'the audit + propose re-runnable and VERSIONS the convention so a ' +
        'refresh never silently changes the approved standard.\n\n' +
        '**Triggers.** (1) **on-demand** — a "re-run audit" action on the ' +
        '7.14.5 surface (re-submits `code_audit` + `propose_convention` for the ' +
        'project); (2) **the 7.7 webhook seam** — on a push/PR webhook (once ' +
        '7.7 wires it), after the code-graph feed re-indexes (7.7.5), trigger a ' +
        'refresh so the audit + convention track the new code. 7.14.7 OWNS the ' +
        're-run + versioning logic and EXPOSES the refresh entry point; 7.7 ' +
        'OWNS the webhook that calls it (the dep points backward — 7.14.7 does ' +
        'not depend on 7.7; 7.7 will depend on this seam).\n\n' +
        '**Versioning (the durable shape).** A refresh produces a NEW ' +
        '`CodeAudit` (the prior audits are retained as history) and a NEW ' +
        '`CodingConvention` version `status: proposed` (version = prior + 1). ' +
        'The currently-approved STANDARD is RETAINED and stays the injected one ' +
        '(7.14.6) until the new proposed version is RE-APPROVED via the 7.14.5 ' +
        'gate. So a refresh never silently overwrites an approved standard or ' +
        'changes what prompts inject — the human re-approves to adopt the new ' +
        'version (the same approval gate, applied to every revision). The ' +
        'diff-from-the-previous-version is surfaced to the reviewer (what ' +
        'changed since the approved standard) so re-approval is informed, not ' +
        'blind.\n\n' +
        '**Idempotency + dedup.** A refresh that finds NO material change ' +
        '(identical findings + an identical proposed convention) does not pile ' +
        'up redundant versions — it records the audit run but does not mint a ' +
        'no-op convention version (the store stays curated, the 7.10 dedup ' +
        'discipline applied here).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A re-run (on-demand) re-submits `code_audit` + `propose_convention` ' +
        'and records a NEW `CodeAudit` + a NEW `proposed` `CodingConvention` ' +
        'version (prior + 1); prior audits + convention versions are retained ' +
        'as history.\n' +
        '- The currently-approved STANDARD stays the injected convention ' +
        '(7.14.6) until the new version is re-approved (7.14.5) — a refresh ' +
        'never silently changes the injected standard.\n' +
        '- A refresh entry point is exposed for the 7.7 webhook to call ' +
        '(post-re-index), WITHOUT 7.14.7 depending on 7.7 (the seam points ' +
        'backward).\n' +
        '- A no-material-change refresh does not mint a redundant convention ' +
        'version (idempotent/dedup); the version-diff is surfaced to the ' +
        'reviewer for informed re-approval.\n\n' +
        '## Context refs\n\n' +
        '- 7.14.4 — the `code_audit` / `propose_convention` jobs this re-runs.\n' +
        '- 7.14.3 — `listVersions` / `recordProposed` / the version field (the ' +
        'versioning this drives) + `approveAsStandard` (re-approval).\n' +
        '- 7.14.5 — the review/approve surface a refreshed version flows ' +
        'through (the re-approval gate + the version diff).\n' +
        '- Story 7.7 (stub) 7.7.5 — the code-graph FEED whose re-index will ' +
        'call this refresh seam (the backward-pointing dep 7.7 owns).\n' +
        '- story-7.10.ts 7.10.4 — the dedup discipline (reinforce/version, not ' +
        'pile up) this mirrors.',
      dependsOn: ['7.14.4'],
    },
    {
      id: '7.14.8',
      title:
        'Vitest — audit + propose, adopt/propose, approve→standard, prompt injection carries the convention',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the engine + the approval gate + the injection against drift. ' +
        'Cover both sides — the motir-ai audit/propose jobs + store and the ' +
        'motir-core review/approve + the 7.6 injection — at the unit/' +
        'integration level (NOT browser E2E; the review-surface flow is covered ' +
        'at the integration level). Tests use a real Postgres on each side (the ' +
        'motir-core standing rule, mirrored in motir-ai; the single allowed ' +
        '`vi.mock` on the core side is `getSession()`; the distillation/LLM ' +
        'call in the jobs is stubbed deterministically so audit/propose are ' +
        'asserted on a fixed code-graph fixture).\n\n' +
        '**Audit + propose jobs (motir-ai, over the 7.5.4 fixture graph):**\n\n' +
        '- `code_audit` over the fixture emits a `CodeAudit` whose findings ' +
        'each cite a real fixture file/symbol + a severity + a rule (no ' +
        'fabricated refs); it does NOT mutate the fixture.\n' +
        '- **Migrate-only:** for an un-indexed (fresh) project the audit job ' +
        'SKIPS cleanly — no `CodeAudit` row, a clear "nothing to analyze" ' +
        'result.\n' +
        '- `propose_convention` over a CLEAN fixture (consistent layering/' +
        'naming) yields more ADOPTED-from-code rules; over a MESSY fixture ' +
        'yields more PROPOSED-from-clean-code rules — the adopt-if-clear / ' +
        'propose-if-messy detection (assert the provenance split shifts with ' +
        'fixture consistency).\n' +
        '- **Fresh establish-only:** with no code graph, `propose_convention` ' +
        'still produces a proposed convention from the chosen stack (all ' +
        'proposed-from-clean-code) and runs no audit.\n\n' +
        '**Store + approval gate (motir-ai):**\n\n' +
        '- `recordProposed` versions monotonically; `approveAsStandard` flips ' +
        'exactly one to `standard`, demotes the prior standard to history (only ' +
        'ONE standard at a time), records the approver, and is idempotent.\n' +
        '- `getStandardForInjection` returns the standard `contentMd` when one ' +
        'is approved and null otherwise.\n' +
        '- A refresh (7.14.7) mints a NEW proposed version without changing the ' +
        'approved standard; a no-material-change refresh does not mint a ' +
        'redundant version (dedup).\n\n' +
        '**Injection (7.14.6) + the gate at the prompt boundary:**\n\n' +
        '- With a STANDARD convention, `generate_prompt` (7.6.2) folds its ' +
        '`contentMd` into the prompt (assert the convention text appears, ' +
        'alongside the per-type rules).\n' +
        '- With only a PROPOSED (un-approved) convention, the prompt does NOT ' +
        'carry it (the approval gate at the injection point — the explicit ' +
        'guard test).\n' +
        '- With NO convention, injection is a no-op and the prompt is ' +
        'unchanged (the enhancement property).\n\n' +
        '**Review/approve API (motir-core):**\n\n' +
        '- The approve route flips proposed→standard over the boundary and is ' +
        'gated to the project-admin permission (a non-admin is blocked; a ' +
        'cross-tenant project is 404-not-403).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass green on both sides over a real Postgres; the ' +
        "suites run in each repo's CI.\n" +
        '- The proposed-not-injected guard test FAILS if a future change ever ' +
        'injects an un-approved convention (it actually guards the approval ' +
        'gate); the migrate-only-audit skip + the adopt/propose split each have ' +
        'an explicit test.\n' +
        '- The motir-core cases respect the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) for the new convention ' +
        'service/route code.\n\n' +
        '## Context refs\n\n' +
        '- 7.14.3 (store), 7.14.4 (audit + propose jobs), 7.14.5 (review/' +
        'approve), 7.14.6 (injection), 7.14.7 (refresh/versioning) — everything ' +
        'under test.\n' +
        '- 7.5.4 — the LOCAL FIXTURE code graph the audit/propose tests index ' +
        'against (incl. a clean + a messy variant for the adopt/propose split).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage gate.\n' +
        '- story-7.10.ts 7.10.7 — the sibling motir-ai store + injection + ' +
        'capture test suite (real Postgres, stubbed LLM seam) to mirror.',
      dependsOn: ['7.14.4', '7.14.5'],
    },
  ],
};
