import type { PlanStory } from '../types';

/**
 * Story 7.16 — Migrate-existing-codebase onboarding flow (guided wizard).
 * The second of Epic 7's two onboarding wizards (7.15 = start-fresh; 7.16 =
 * migrate-existing-codebase). It is the GUIDED, multi-step entry path for the
 * "I already have a codebase on GitHub" project kind — a state-machine WIZARD
 * that ORCHESTRATES the AI pieces other stories already built, in the right
 * order, with the one gate Yue flagged baked in: **the proposed coding
 * convention must be reviewed + APPROVED before any plan generation runs, and
 * that first generation must be CODE-AWARE (it reads the code graph).**
 *
 * **What 7.16 is — an orchestrator, not a re-implementation.** Every heavy
 * piece this wizard sequences is OWNED elsewhere and consumed here; 7.16 adds
 * the state machine + the wizard UI + the gates, nothing more (the
 * onboarding-brief rule: "Onboarding flows are GUIDED WIZARDS that ORCHESTRATE
 * the existing AI pieces; they don't reimplement them"). The sequence
 * (Workflow B) is:
 *
 *   1. **Connect GitHub** — the 7.7 GitHub App install + OAuth identity grant
 *      (7.7.3) + repo selection. The wizard drives the user through the connect
 *      flow 7.7 ships; it does not re-build OAuth or the installation model.
 *   2. **Index the codebase** — on connect, 7.7.5's code-graph FEED fetches the
 *      selected repo via the installation token and drives 7.5.4's codegraph
 *      indexer to build the per-tenant code graph. The wizard renders the
 *      INDEX-PROGRESS step and waits on it (the Cursor mirror: indexing has a
 *      visible progress indicator and downstream capability is gated until the
 *      index is sufficiently complete).
 *   3. ★**AUDIT + proposed-coding-convention review/approve**★ — the missing
 *      step Yue flagged. Once the code graph exists, 7.14.4's `code_audit` /
 *      `propose_convention` job runs: it emits the code-issues report + a
 *      PROPOSED coding convention (adopt-if-clear / propose-if-messy). The
 *      wizard surfaces 7.14.5's review/approve UI; the user edits + APPROVES,
 *      and the convention becomes the project STANDARD. **This step GATES
 *      generation — the wizard cannot proceed to generate until the convention
 *      is approved** (7.16.3 wires that gate; 7.16.6 tests it).
 *   4. **Light discovery** — a SHORT 7.2 discovery pass. Migrate projects need
 *      less "do you care?" interview than start-fresh: the stack/structure is
 *      already DISCOVERABLE from the code graph + the audit, so discovery
 *      focuses on intent/goals/scope, not re-deriving the tech choices the code
 *      already encodes.
 *   5. **Code-aware generate** — the 7.3 `generate_tree` job, but the FIRST
 *      generation runs through the 7.5.6 two-graph planning loop so the planner
 *      reads the EXISTING code (code graph) before proposing the initial plan
 *      (7.16.4 ensures this; a migrate project's first plan must reflect the
 *      codebase that already exists, not a fresh-project blank slate).
 *   6. **Review/approve the plan** — the standard 7.3 generate→review→approve
 *      surface; on approve, the tree persists through `workItemsService`.
 *
 * **The two gates this wizard exists to enforce (Yue, the onboarding brief).**
 *   - **Convention-before-generation.** The proposed convention is approved
 *     BEFORE generation proceeds (step 3 gates step 5). Skipping it would mean
 *     generating a plan against a codebase whose conventions the planner never
 *     reviewed — the exact gap the audit step closes.
 *   - **Code-aware first generation.** The initial plan is grounded in the real
 *     code via the code graph (7.5.6), so a migrate project's backlog reflects
 *     what's already built (and what the audit found wrong), not a from-scratch
 *     tree. The approved convention also feeds 7.6 prompt generation (7.14.6),
 *     so every dispatched prompt from day one carries the project's standard.
 *
 * **Mirror products (rung 1 + the code-import analogues — VERIFIED via
 * WebSearch this planning session, cited on the cards, not asserted).**
 *   - **CodeRabbit** — the "connect your repo" hosted-AI-reads-your-codebase
 *     onboarding: install the GitHub App, pick repos ("all" or "only select
 *     repositories"), and within minutes it analyzes a PR "in the context of
 *     your full repository" (docs.coderabbit.ai/platforms/github-com). This is
 *     the connect→index→read-the-whole-repo shape 7.16's steps 1–2 mirror.
 *   - **Cursor** — codebase indexing on project open with a visible PROGRESS
 *     indicator, and semantic search "isn't available until at least 80% of
 *     that work is finished" (cursor.com/docs/context/codebase-indexing) — the
 *     index-progress step (7.16 step 2) + the gate that a code-dependent step
 *     waits on indexing completion (the structural precedent for gating
 *     code-aware generation on the index being ready).
 *   - **Plane's Jira importer** — a multi-step MIGRATION WIZARD: connect the
 *     source → configure → MAP statuses/priorities → REVIEW + Confirm before
 *     the migration commits (docs.plane.so/importers/jira). The verified
 *     "guided wizard with a review/confirm gate before it writes" shape; 7.16's
 *     audit/convention approve + plan approve are Motir's two such gates.
 *
 * **Design gate fires (AREA `design/onboarding-migrate/`).** The wizard is a
 * real user-facing multi-step surface, so 7.16.1 produces the design asset
 * FIRST (every wizard step as a panel, incl. the index-progress + the
 * audit/convention review/approve), and every UI code subtask (7.16.5) depends
 * on it and is `blocked` until it lands. The wizard COMPOSES surfaces other
 * stories already designed (7.7's connect/settings, 7.14's audit+convention
 * review, 7.2's discovery chat, 7.3's tree review) into one stepped flow — it
 * designs the ORCHESTRATION shell + the index-progress step, not net-new
 * versions of those embedded surfaces.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward-pointing dep.**
 * Every `dependsOn` id's story number is ≤ 7.16: same-story 7.16.x, plus
 * 7.7.3 (connect), 7.5.4 (the code-graph store / index), 7.7.5 (the live feed),
 * 7.14.4 (the audit+propose job), 7.14.5 (the convention review/approve UI),
 * 7.2.x (discovery), 7.3.4 (generate+persist service), 7.5.6 (the code-aware
 * planning loop). All backward/sideways. Status rule: the design card
 * (7.16.1, `dependsOn: []`) is `planned`; every other card chains behind it or
 * behind a not-yet-done upstream id → `blocked`.
 */
export const story_7_16: PlanStory = {
  id: '7.16',
  title: 'Migrate-existing-codebase onboarding flow (guided wizard)',
  status: 'planned',
  gitBranch: 'feat/PROD-7.16-migrate-onboarding-wizard',
  descriptionMd:
    'The **guided onboarding wizard** for the migrate-existing-codebase ' +
    'project kind: a user who already has a codebase on GitHub is walked ' +
    'through a stepped, resumable flow that connects the repo, indexes it, ' +
    'AUDITS it and gets a proposed coding convention APPROVED, runs a light ' +
    'discovery pass, then generates a **code-aware** initial plan grounded in ' +
    'the existing code — each AI step orchestrated, not re-implemented. This ' +
    'is the sibling of 7.15 (start-fresh); together they are the two front ' +
    'doors into the Epic-7 planning layer.\n\n' +
    '**The wizard sequence (Workflow B — locked; see the module header for the ' +
    'full rationale):**\n\n' +
    '1. **Connect GitHub** — the 7.7 App install + OAuth identity (7.7.3) + ' +
    'repo selection (the wizard drives 7.7’s connect flow; it does not ' +
    'rebuild it).\n' +
    '2. **Index the codebase** — 7.7.5’s feed fetches the selected repo ' +
    'via the installation token and drives 7.5.4’s codegraph indexer; the ' +
    'wizard shows an INDEX-PROGRESS step and waits on it (the Cursor mirror: ' +
    'visible progress, downstream capability gated on completion).\n' +
    '3. ★ **AUDIT + proposed-convention review/approve** ★ — the ' +
    '7.14.4 `code_audit` / `propose_convention` job emits the code-issues ' +
    'report + a proposed coding convention; the wizard surfaces 7.14.5’s ' +
    'review/approve UI; the user edits + APPROVES and it becomes the project ' +
    'STANDARD. **This step GATES generation** — the wizard cannot generate ' +
    'until the convention is approved (the missing step, baked in as a hard ' +
    'gate).\n' +
    '4. **Light discovery** — a SHORT 7.2 discovery pass (stack/structure is ' +
    'already discoverable from the code graph + audit, so discovery focuses on ' +
    'intent/goals/scope, not re-deriving the tech the code already encodes).\n' +
    '5. **Code-aware generate** — the 7.3 `generate_tree` job run through the ' +
    '7.5.6 two-graph loop so the FIRST plan reads the existing code (the ' +
    'backlog reflects what’s already built + what the audit found, not a ' +
    'blank-slate tree).\n' +
    '6. **Review/approve the plan** — the standard 7.3 generate→review' +
    '→approve surface; on approve the tree persists via ' +
    '`workItemsService`.\n\n' +
    '**The two gates this wizard enforces (Yue):** convention-before-' +
    'generation (step 3 gates step 5), and a code-aware FIRST generation (step ' +
    '5 reads the code graph). The approved convention also feeds 7.6 prompt ' +
    'generation (7.14.6), so dispatched prompts carry the project standard from ' +
    'day one.\n\n' +
    '**Scope:** the wizard design asset (7.16.1); the orchestration state ' +
    'machine sequencing connect→index→audit+convention→discovery' +
    '→code-aware-generate→approve (7.16.2); wiring the audit/' +
    'convention-approval step as the generation GATE (7.16.3); ensuring the ' +
    'first generation is code-aware (7.16.4); the multi-step wizard UI incl. ' +
    'index-progress + the audit/convention approval (7.16.5); the orchestration ' +
    '+ gate vitest (7.16.6); and the connect→index→approve-convention' +
    '→generate→approve-plan E2E (7.16.7).\n\n' +
    '**Out of scope (named so they land in their owning stories, not here):** ' +
    'the GitHub App + connect model + the code-graph feed (7.7 — 7.16 drives ' +
    'them); the code-graph STORE + index (7.5.4 — 7.16 waits on it); the ' +
    'audit + propose-convention ENGINE + its review/approve UI (7.14 — 7.16 ' +
    'sequences + gates on them); the discovery interview + direction docs ' +
    '(7.2); the generation engine + the generate/approve surface (7.3); the ' +
    'two-graph planning loop (7.5.6); and the START-FRESH wizard (7.15 — its ' +
    'own story, no audit half).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services (motir-core on `:3000`, ' +
    'motir-ai on its dev port, each pointed at the other), with the 7.7 ' +
    'GitHub App provisioned (7.7.2) and a test repo available to connect.\n' +
    '- **The wizard, end to end (the story).** Sign in as ' +
    '`zhuyue@motir.co`; start a new project as **migrate-existing-codebase**. ' +
    'Step through the wizard:\n' +
    '  1. **Connect** — authorize + install the App on a test repo (the 7.7 ' +
    'connect flow embedded as the first step); the wizard advances when the ' +
    'repo is connected.\n' +
    '  2. **Index** — the index-progress step shows the code graph building ' +
    '(7.7.5 feed → 7.5.4 indexer); the wizard waits on it and advances ' +
    'when the index is ready (it does NOT let you proceed to generate before ' +
    'the graph exists).\n' +
    '  3. **Audit + convention** — the audit report + the proposed coding ' +
    'convention appear (7.14.5 surface embedded); EDIT the convention, then ' +
    '**Approve**. Confirm the convention is now the project STANDARD. **Try to ' +
    'skip to generation WITHOUT approving** — the wizard blocks it (the ' +
    'gate).\n' +
    '  4. **Light discovery** — a short discovery pass runs (focused on ' +
    'intent/scope, not re-deriving the stack the code already shows).\n' +
    '  5. **Code-aware generate** — trigger generation; confirm (job log / ' +
    'stream) the planner CALLED the code-graph tools mid-loop (7.5.6) so the ' +
    'proposed plan reflects the existing code, not a blank slate.\n' +
    '  6. **Approve the plan** — review + approve the generated tree; navigate ' +
    'to /issues and confirm the backlog exists, parented per the grammar.\n' +
    '- **The gate holds (the load-bearing assertion).** A run that reaches ' +
    'step 5 with the convention NOT approved is impossible — the wizard ' +
    'state machine refuses to enter generation until step 3 is approved ' +
    '(7.16.3); and the first generation is verifiably code-aware (the code ' +
    'graph was read — 7.16.4).\n' +
    '- **Resumability.** Close the wizard mid-flow (e.g. during indexing) and ' +
    're-open the project — it RESUMES at the saved step, it does not ' +
    'restart from connect (the state machine persists progress).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.16.6 covers the ' +
    'orchestration state machine, the convention-before-generation gate, ' +
    'resumability, and that the first generation submits a code-aware job.\n' +
    '- `pnpm test:e2e onboarding-migrate` — 7.16.7 drives connect → index ' +
    '→ review+approve convention → code-aware generate → approve ' +
    'plan from a user’s seat.\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** The ' +
    'wizard orchestration + UI live in motir-core; the audit/convention store ' +
    '+ job + the code graph live in motir-ai; the wizard reaches them ONLY ' +
    'through the 7.1 boundary (no `motir-ai` import in motir-core; browsers ' +
    'never call motir-ai). The convention store has no home in motir-core (zero ' +
    'AI tables).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up ' +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.16.1',
      title:
        'Design — the migrate-onboarding wizard (connect → index → audit+convention approve → discovery → code-aware generate → approve)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The wizard UI (7.16.5) depends on this card; ' +
        'without it the multi-step flow would be improvised, which is forbidden ' +
        '(notes.html #31). This card designs the ORCHESTRATION SHELL + the ' +
        'index-progress step — it COMPOSES surfaces other stories already ' +
        'designed (7.7 connect, 7.14 audit+convention review/approve, 7.2 ' +
        'discovery chat, 7.3 tree review) into one stepped flow; it does not ' +
        're-design those embedded surfaces.\n\n' +
        'Produce the design asset for the migrate-onboarding wizard under ' +
        '`motir-core/design/onboarding-migrate/`. Author it as a ' +
        '**`*.mock.html` mockup** built from the real design system (the ' +
        'shipped `components/ui/*` primitives + the `--el-*` colour tokens + ' +
        'the `[data-display-style]` shape tokens) — NOT a `.pen`. The HTML ' +
        'route is preferred when a coding agent produces the design (no ' +
        'Pencil→code translation gap; the reviewer sees the actual ' +
        'tokens). The `.mock.html` is the source of truth (MOTIR.md ' +
        '§ Design-reference rule).\n\n' +
        '**Mirror (VERIFIED this session — cite in design-notes.md).** ' +
        'CodeRabbit’s connect-your-repo onboarding (install the App, pick ' +
        '"all" or "only select repositories", it reads the repo in full ' +
        'context); Cursor’s codebase-indexing PROGRESS indicator with a ' +
        'completion gate before code-dependent capability is available; ' +
        'Plane’s Jira-import WIZARD (connect → configure → map ' +
        '→ review+Confirm before it writes). Draw the migrate flow as ' +
        'THAT guided, gated wizard.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 0 — the wizard chrome + a step rail.** The overall ' +
        'stepped-wizard frame: a left/top STEP RAIL showing the six steps ' +
        '(Connect · Index · Audit & convention · Discovery ' +
        '· Generate · Review) with done / current / locked states, a ' +
        'Back/Next footer, and an obvious "you can leave and resume" ' +
        'affordance. The rail makes the gate VISIBLE — Generate is a LOCKED ' +
        'step until the convention is approved.\n' +
        '- **Panel 1 — Connect GitHub (step 1).** The 7.7 connect surface ' +
        'embedded as the first step (the two-grants explanation + "Connect ' +
        'GitHub" + repo selection). Drawn as a COMPOSITION of 7.7.1’s ' +
        'design, not a new connect screen — reference 7.7.1.\n' +
        '- **Panel 2 — Index progress (step 2).** The code-graph indexing ' +
        'progress step: a progress indicator (files/symbols indexed), a "this ' +
        'can take a few minutes for a large repo" note, and the Next action ' +
        'DISABLED until the index is ready (the Cursor-mirror gate). An ' +
        'in-flight + a complete state.\n' +
        '- **Panel 3 — Audit + proposed-convention review/approve (step 3, ' +
        'the ★ gate step).** The 7.14.5 review/approve surface embedded: ' +
        'the code-issues audit report + the proposed coding convention, with ' +
        'EDIT + a primary **Approve & set as standard** CTA. Make ' +
        'unmistakable that **approve is REQUIRED to continue** (the Generate ' +
        'step stays locked until then) — draw the locked-Generate treatment ' +
        'and the "approve the convention to continue" copy. Reference ' +
        '7.14.1’s design for the embedded report/convention surface.\n' +
        '- **Panel 4 — Light discovery (step 4).** A SHORT discovery pass ' +
        '(the 7.2 chat surface embedded), framed for migrate: "we read your ' +
        'code — now tell us your goals", focused on intent/scope rather than ' +
        're-deriving the stack. Reference 7.2.1.\n' +
        '- **Panel 5 — Code-aware generate + review (steps 5–6).** The ' +
        '7.3 generate→review→approve surface embedded, with a ' +
        'migrate-specific affordance making clear the plan is GROUNDED IN YOUR ' +
        'CODE (e.g. a "reading your codebase" generating state + a note that ' +
        'the plan reflects the existing code + the audit). Reference ' +
        '7.3.1.\n' +
        '- **Panel 6 — empty / error / resume states.** The connect-failed, ' +
        'index-failed (retry), audit-failed states, and the RESUME state when ' +
        'a user re-opens a half-finished wizard (it returns to the saved ' +
        'step). Reuse the shipped `EmptyState` + a danger callout via ' +
        '`--el-danger`.\n\n' +
        'Also write **`design/onboarding-migrate/design-notes.md`** naming the ' +
        'exact primitives used per surface, the exact copy strings (especially ' +
        'the gate copy — "approve the convention to continue" — and the ' +
        'code-aware-generation framing), the placement decisions, the ' +
        'per-`--el-*` colour role for each element (the step-rail done/current/' +
        'locked tones; the danger callouts), the WHICH-STORY-OWNS-IT note for ' +
        'each embedded surface (Connect=7.7.1, Audit/convention=7.14.1, ' +
        'Discovery=7.2.1, Generate=7.3.1), the VERIFIED mirror citations ' +
        '(CodeRabbit / Cursor / Plane), and a "primitives composed (no ' +
        'hand-rolling)" checklist (the `design-notes.md` convention 1.3.3 / ' +
        '1.5.1 / 7.0.1 established).\n\n' +
        '**Branch.** `design/PROD-7.16.1-migrate-onboarding-surface`. The ' +
        '`design/*` prefix gate skips CI E2E + the Vercel preview deploy (per ' +
        'MOTIR.md § Plan-seed Workflow) — this PR only edits ' +
        '`design/onboarding-migrate/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/onboarding-migrate/onboarding-migrate.mock.html` ' +
        'exists, renders the panels above (incl. the step rail with the LOCKED ' +
        'Generate step), and references ONLY `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- The wizard makes the **convention-before-generation GATE visible**: ' +
        'the Generate step is drawn as LOCKED until the convention is approved, ' +
        'with the "approve to continue" copy.\n' +
        '- The index-progress step is drawn with Next DISABLED until indexing ' +
        'completes (the Cursor-mirror gate), and the resume state is drawn.\n' +
        '- `design/onboarding-migrate/design-notes.md` exists, names every ' +
        'primitive + copy string + per-element `--el-*` role, the which-story-' +
        'owns-each-embedded-surface note, and the verified mirror citations.\n' +
        '- The mockup COMPOSES the shipped primitives + the already-designed ' +
        'embedded surfaces (7.7.1 / 7.14.1 / 7.2.1 / 7.3.1) — it invents no new ' +
        'design-system entry inside this Story (if one is needed, that is a NEW ' +
        '`design/` subtask, not a code workaround).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/github/` (7.7.1), `design/coding-convention/` ' +
        '(7.14.1), `design/ai-chat/` (7.2.1), `design/ai-planning/` (7.3.1) — ' +
        'the embedded surfaces this wizard composes; mirror their layout + ' +
        '`design-notes.md` shape.\n' +
        '- `motir-core/components/ui/` — the `Card`, `Button`, `EmptyState`, ' +
        'the step/progress primitives, the toast — the composable surface.\n' +
        '- `motir-core/app/globals.css` — `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (the swap layer the mockup ' +
        'references).\n' +
        '- docs.coderabbit.ai/platforms/github-com (connect-the-repo ' +
        'onboarding), cursor.com/docs/context/codebase-indexing (index ' +
        'progress + completion gate), docs.plane.so/importers/jira (the ' +
        'connect→configure→review+confirm migration wizard) — the ' +
        'verified mirrors.',
      dependsOn: [],
    },
    {
      id: '7.16.2',
      title:
        'Migrate-onboarding ORCHESTRATION — the wizard state machine sequencing connect → index → audit+convention → discovery → code-aware generate → approve',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'The heart of the story: a durable, RESUMABLE wizard STATE MACHINE in ' +
        'motir-core that sequences the six steps of Workflow B, ORCHESTRATING ' +
        'the AI pieces other stories own — it submits/awaits their jobs and ' +
        'advances on their results; it re-implements none of them. 4-layer ' +
        '(Route→Service→Repository→Prisma, `motir-core/' +
        'CLAUDE.md`).\n\n' +
        '**The state machine.** Model the wizard as a persisted ' +
        '`MigrateOnboarding` record `{ id, projectId, kind: ' +
        "'migrate', step, status, connectedRepoRef?, codeGraphReady, " +
        'conventionApprovedAt?, discoveryJobId?, generateJobId?, createdAt, ' +
        'updatedAt }` whose `step` is an explicit enum `connect → index ' +
        '→ audit_convention → discovery → generate → review ' +
        '→ done`. Each transition is a service method that (a) verifies ' +
        'the CURRENT step’s exit condition is met, (b) advances `step`, ' +
        '(c) kicks the next step’s underlying action. The record persists ' +
        'progress so the wizard is RESUMABLE — re-opening the project resumes ' +
        'at the saved `step`, never restarts (durable shape, no "redo from ' +
        'scratch" shortcut).\n\n' +
        '**What each step orchestrates (consumed, not rebuilt):**\n\n' +
        '- **connect** → drives the 7.7.3 connect flow (OAuth identity + ' +
        'App install + repo selection); exit condition: a repo is connected ' +
        '(a `GithubRepo` row for the project exists).\n' +
        '- **index** → the 7.7.5 feed has fired the initial code-graph ' +
        'index (7.5.4) for the connected repo; the wizard POLLS index readiness ' +
        'and exit-gates on `codeGraphReady` (the Cursor-mirror completion ' +
        'gate). It does not index itself — it waits on 7.7.5/7.5.4.\n' +
        '- **audit_convention** → submits the 7.14.4 `code_audit` / ' +
        '`propose_convention` job over the now-built code graph; exit ' +
        'condition is the convention APPROVAL (owned by 7.16.3 — this card ' +
        'leaves the gate seam; 7.16.3 wires the hard block).\n' +
        '- **discovery** → submits a SHORT 7.2 `discovery` job (migrate ' +
        'variant: intent/scope-focused, since the stack is already in the code ' +
        'graph + audit); exit: the direction docs exist.\n' +
        '- **generate** → submits the 7.3.4 generate-and-persist flow, ' +
        'CODE-AWARE (owned by 7.16.4 — this card calls the generate seam; ' +
        '7.16.4 ensures the job reads the code graph).\n' +
        '- **review** → the standard 7.3 review/approve; on plan approve, ' +
        '`step → done`.\n\n' +
        '**Orchestration, not re-implementation (the brief rule).** This ' +
        'service calls the EXISTING connect/index/audit/discovery/generate ' +
        'surfaces + jobs over their existing APIs / the 7.1 client; it adds the ' +
        'SEQUENCING + the persisted progress + the exit conditions. It owns no ' +
        'planning logic, no GitHub logic, no codegraph logic.\n\n' +
        '**API.** `POST /api/onboarding/migrate` (start a migrate wizard for ' +
        'the active project), `GET /api/onboarding/migrate/:id` (current step + ' +
        'status, for resume), `POST /api/onboarding/migrate/:id/advance` ' +
        '(attempt the next transition; rejects if the current exit condition ' +
        'is unmet — the generic guard the 7.16.3 gate specializes). Routes call ' +
        'ONE service method; the service owns the transaction + the ' +
        'orchestration; no `motir-ai` import, no raw Prisma in a route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `MigrateOnboarding` model + repository + service exist (4-layer); ' +
        'the `step` enum + the transition methods model the six-step ' +
        'sequence; `pnpm migrate` runs clean (FKs as `@relation`s, no drift).\n' +
        '- Each transition verifies the current step’s exit condition ' +
        'before advancing, and kicks the next step’s underlying action ' +
        '(connect / index-poll / audit job / discovery job / generate) by ' +
        'CALLING the owning story’s surface — no re-implemented planning / ' +
        'GitHub / codegraph logic.\n' +
        '- The wizard is RESUMABLE: `GET …/:id` returns the saved step; ' +
        're-opening resumes there, never restarts from connect.\n' +
        '- `…/advance` rejects a transition whose exit condition is unmet ' +
        '(the generic guard; the convention gate is specialized in 7.16.3).\n' +
        '- 4-layer respected; routes call one service method; no `motir-ai` ' +
        'import; the orchestration owns sequencing only.\n\n' +
        '## Context refs\n\n' +
        '- 7.16.1 — the wizard design (the steps this state machine drives).\n' +
        '- 7.7.3 — the connect flow (step 1) this orchestrates.\n' +
        '- 7.5.4 / 7.7.5 — the code-graph store + the feed (step 2) the wizard ' +
        'polls for readiness.\n' +
        '- 7.14.4 — the audit + propose-convention job (step 3) this submits.\n' +
        '- 7.2.5 / 7.2.6 — the discovery job + chat proxy (step 4).\n' +
        '- 7.3.4 — the generate-and-persist service (steps 5–6).\n' +
        '- `motir-core/lib/services/` + `motir-core/CLAUDE.md` § 4-layer — ' +
        'the service/repository pattern to mirror.\n' +
        '- 7.15 (start-fresh wizard) — the sibling orchestration shape (no ' +
        'audit half) to stay consistent with.',
      dependsOn: ['7.16.1', '7.7.3', '7.5.4', '7.14.4', '7.3.4'],
    },
    {
      id: '7.16.3',
      title:
        'Wire the AUDIT + convention-approval step as the generation GATE (consumes 7.14.5 before generate proceeds)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The load-bearing gate Yue flagged: **the proposed coding convention ' +
        'must be reviewed + APPROVED before the wizard proceeds to ' +
        'generation.** 7.16.2 left the `audit_convention → discovery / ' +
        'generate` transition as a generic exit-condition seam; this card wires ' +
        'the SPECIFIC hard block — the wizard cannot enter generation until the ' +
        'convention is approved as the project STANDARD.\n\n' +
        '**Consume 7.14.5 (do not rebuild it).** Embed 7.14.5’s review/' +
        'approve UI + API as the `audit_convention` step’s surface: it ' +
        'renders the 7.14.4 code-issues audit report + the proposed convention, ' +
        'the user edits + approves, and on approve the convention transitions ' +
        'to STANDARD (recorded in motir-ai over the 7.1 boundary — 7.14.5 owns ' +
        'that write). This card adds the WIZARD-SIDE gate that reads that ' +
        'standard-convention state and unlocks the next step ONLY when it ' +
        'holds.\n\n' +
        '**The gate (the hard block).** The `advance` transition out of ' +
        '`audit_convention` checks: is there an APPROVED (status `standard`) ' +
        'convention for this project (via the 7.14 store over the 7.1 ' +
        'boundary)? If NOT, the transition is REJECTED with a typed ' +
        '`ConventionNotApprovedError` → a clear 409/422 the UI renders as ' +
        '"approve the coding convention to continue" — generation is ' +
        'UNREACHABLE. The generate step (7.16.4) additionally re-checks the ' +
        'gate server-side at submit time (defense in depth — the gate is never ' +
        'trusted to be enforced only by the UI / only by the step transition).\n\n' +
        '**Convention feeds prompts too (the downstream consequence, noted).** ' +
        'Once standard, the convention is injected into 7.6 prompt generation ' +
        '(7.14.6 owns that) — so a migrate project’s dispatched prompts ' +
        'carry the project standard from day one. This card does not implement ' +
        '7.14.6; it ensures the convention is APPROVED (the precondition 7.14.6 ' +
        'relies on) before any generation/dispatch.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The `audit_convention` step embeds 7.14.5’s review/approve ' +
        'surface (the audit report + the proposed convention; edit + approve), ' +
        'consuming it — not a re-implemented review UI.\n' +
        '- The `advance` out of `audit_convention` is BLOCKED until an approved ' +
        '(status `standard`) convention exists for the project: an unapproved ' +
        'attempt is rejected with a typed error the UI renders as ' +
        '"approve to continue"; generation is unreachable.\n' +
        '- The generate step (7.16.4) re-checks the gate at job-submit time ' +
        '(defense in depth) — a forced/bypassed transition still cannot ' +
        'generate without an approved convention.\n' +
        '- The approval (convention → standard) is recorded via 7.14.5 in ' +
        'motir-ai over the 7.1 boundary (no convention table in motir-core); ' +
        'the wizard only READS the approved state to unlock.\n' +
        '- A test proves a no-approval run cannot reach generation (the ' +
        'gate is real, not asserted) — see 7.16.6.\n\n' +
        '## Context refs\n\n' +
        '- 7.14.5 — the convention review/approve UI + API this embeds + ' +
        'gates on (approve → standard).\n' +
        '- 7.14.4 — the audit + proposed-convention job whose output this step ' +
        'reviews.\n' +
        '- 7.14.6 — the prompt-injection of the standard convention (the ' +
        'downstream consumer this gate’s approval unblocks; not ' +
        'implemented here).\n' +
        '- 7.16.2 — the orchestration state machine + the generic exit-' +
        'condition seam this specializes.\n' +
        '- 7.16.4 — the code-aware generate step this gate protects (the ' +
        'server-side re-check).',
      dependsOn: ['7.16.2', '7.14.5'],
    },
    {
      id: '7.16.4',
      title:
        'Ensure the FIRST generation is CODE-AWARE — the initial plan reads the code graph (7.5.6)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'The second gate the story exists for: a migrate project’s FIRST ' +
        'plan must reflect the codebase that ALREADY EXISTS, so the wizard’s ' +
        'generate step submits a CODE-AWARE `generate_tree` job — one that runs ' +
        'through the 7.5.6 two-graph planning loop and reads the code graph ' +
        '(7.5.4, fed by 7.7.5) before proposing the tree. Without this, the ' +
        'first generation would be a blank-slate (start-fresh) plan that ' +
        'ignores the existing code — the exact failure migrate onboarding ' +
        'exists to avoid.\n\n' +
        '**What "code-aware" means here (concretely).** The 7.3 `generate_tree` ' +
        'job is the SAME engine; "code-aware" is a property of the CONTEXT it ' +
        'runs with. The wizard’s generate step submits the job with the ' +
        'connected repo’s `aiProjectId` + `repoRef` in the envelope so the ' +
        '7.5.6 loop’s code-graph tools (`code_explore` / `code_impact` / ' +
        '`code_callers`…) resolve THIS project’s graph, and the ' +
        'planner reads the existing code (and the 7.14 audit findings) when ' +
        'drafting the initial backlog. The job is submitted through the ' +
        'existing 7.3.4 generate-and-persist service — this card does NOT add a ' +
        'new generation engine; it ensures the migrate FIRST-generation path ' +
        'carries the code-graph context, where a start-fresh project (7.15) ' +
        'would not.\n\n' +
        '**Precondition: the graph is ready + the convention is approved.** The ' +
        'generate step only runs after the index step set `codeGraphReady` ' +
        '(7.16.2) AND the convention gate passed (7.16.3, re-checked here ' +
        'server-side). If the code graph is somehow absent, the step fails ' +
        'cleanly with a typed error (it does NOT silently fall back to a ' +
        'blank-slate generation — that would defeat the story).\n\n' +
        '**No forward dep.** 7.5.6 (the two-graph loop) + 7.3.4 (generate/' +
        'persist) + 7.5.4 (the store) are all ≤ 7.16 — this card WIRES them ' +
        'into the migrate generate step, it does not build them.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The wizard generate step submits a `generate_tree` job carrying the ' +
        'connected repo’s `aiProjectId` + `repoRef`, so the 7.5.6 loop ' +
        'reads THIS project’s code graph mid-generation (verified via the ' +
        'job log: the code-graph tools were called before the delta was ' +
        'emitted).\n' +
        '- The first proposed plan reflects the existing code + the 7.14 audit ' +
        '(it is NOT a blank-slate fresh-project tree) — demonstrated over a ' +
        'fixture-indexed repo.\n' +
        '- The step runs only when `codeGraphReady` AND the convention is ' +
        'approved (the 7.16.3 gate re-checked server-side); a missing code ' +
        'graph fails cleanly with a typed error (no silent blank-slate ' +
        'fallback).\n' +
        '- Generation still goes through the existing 7.3.4 service + the ' +
        'generate→review→approve surface (no new engine; persist stays ' +
        'human-approved + `workItemsService`-committed).\n' +
        '- No forward dep introduced; the card wires 7.5.6 / 7.3.4 / 7.5.4 into ' +
        'the migrate path only.\n\n' +
        '## Context refs\n\n' +
        '- 7.5.6 — the two-graph planning loop (the code-graph tools the ' +
        'code-aware generation calls).\n' +
        '- 7.5.4 / 7.7.5 — the per-tenant code-graph store + the feed that ' +
        'built it (the graph this generation reads).\n' +
        '- 7.3.2 / 7.3.4 — the `generate_tree` engine + the generate-and-' +
        'persist service this submits through (unchanged engine; code-aware ' +
        'context).\n' +
        '- 7.16.2 — the `codeGraphReady` exit condition the generate step ' +
        'requires; 7.16.3 — the convention gate re-checked here.',
      dependsOn: ['7.16.2'],
    },
    {
      id: '7.16.5',
      title:
        'The migrate-onboarding wizard UI — multi-step flow incl. index-progress + audit/convention approval',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the user-facing wizard EXACTLY as 7.16.1 specifies — the ' +
        'stepped, resumable flow that walks a migrate user through ' +
        'connect → index → audit+convention approve → discovery ' +
        '→ code-aware generate → review. This is the UI subtask the ' +
        'design gate guards: it depends on 7.16.1 (design) + 7.16.2 (the state ' +
        'machine it drives) and is `blocked` until both land.\n\n' +
        '**The wizard shell.** A route under the authed shell (e.g. ' +
        '`app/(authed)/onboarding/migrate/[id]/page.tsx`) that reads the ' +
        'current step from 7.16.2’s `GET …/:id` (Server Component ' +
        'via a service) and renders the step rail (Connect · Index · ' +
        'Audit & convention · Discovery · Generate · Review) ' +
        'with done / current / LOCKED states. The Generate step renders LOCKED ' +
        'until the convention is approved (the visible gate from 7.16.1). ' +
        'Back/Next + a "leave and resume" affordance; re-opening resumes at the ' +
        'saved step (no restart).\n\n' +
        '**The steps EMBED the existing surfaces (composition, not ' +
        'duplication).** Each step renders the owning story’s surface: ' +
        'step 1 the 7.7.7 connect/repo-selection UI; step 2 the index-progress ' +
        'view (the NET-NEW surface this card builds — a progress indicator on ' +
        'the 7.7.5/7.5.4 index readiness, Next disabled until ready); step 3 ' +
        'the 7.14.5 audit + convention review/approve UI with the **Approve & ' +
        'set as standard** CTA that unlocks Generate (the 7.16.3 gate); step 4 ' +
        'the 7.2.7 discovery chat (migrate framing); steps 5–6 the 7.3.5 ' +
        'generate/review/approve surface with the "reading your codebase" ' +
        'code-aware-generation framing. The wizard does NOT re-implement these ' +
        '— it composes them + owns the rail, the gating, and the ' +
        'index-progress step.\n\n' +
        '**Tokens + a11y + i18n.** References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 utilities — the ' +
        '`motir-core/CLAUDE.md` colour/shape rules); the step-rail done/current/' +
        'locked states use the `--el-*` tones 7.16.1 assigns (locked = a quiet ' +
        'tone + the "approve to continue" hint; NOT a page-level tinted ' +
        'surface, finding #35). The progress + streaming regions are ' +
        '`aria-live`; the rail + Back/Next are keyboard-reachable. Add an ' +
        '`onboardingMigrate` i18n namespace for all wizard chrome strings (the ' +
        'embedded surfaces keep their own namespaces) across the locale set the ' +
        'app ships.\n\n' +
        '**No business logic in the client.** A client component owns the ' +
        'step-advance interactions + the index-progress poll/stream, but it ' +
        'calls the 7.16.2 `…/advance` API — it never touches the service ' +
        'layer directly; the page is a Server Component reading via a service ' +
        '(4-layer).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The wizard renders the step rail + the six steps per the 7.16.1 ' +
        'mockup, composed of the named primitives + the embedded story surfaces ' +
        '(7.7.7 / 7.14.5 / 7.2.7 / 7.3.5), referencing ONLY `--el-*` + shape ' +
        'tokens (no Tier-0 utilities).\n' +
        '- The index-progress step (the net-new surface) shows progress on the ' +
        'code-graph index and DISABLES Next until the index is ready (the ' +
        'Cursor-mirror gate).\n' +
        '- The Generate step is rendered LOCKED until the convention is ' +
        'approved (the 7.16.3 gate made visible), with the "approve to ' +
        'continue" hint; approving unlocks it.\n' +
        '- The wizard is resumable: re-opening returns to the saved step ' +
        '(reads 7.16.2), never restarts from connect.\n' +
        '- A11y: `aria-live` progress/streaming regions, keyboard-reachable ' +
        'rail + Back/Next; no client component calls the service layer directly ' +
        '(it goes through the 7.16.2 API); strings in the `onboardingMigrate` ' +
        'namespace.\n\n' +
        '## Context refs\n\n' +
        '- 7.16.1 — the design asset this implements (every panel + the step ' +
        'rail + the gate treatment).\n' +
        '- 7.16.2 — the state machine + `GET …/:id` / `…/advance` ' +
        'this drives; 7.16.3 — the convention gate the Generate-locked state ' +
        'reflects; 7.16.4 — the code-aware generate framing.\n' +
        '- 7.7.7 (connect UI), 7.14.5 (audit/convention review UI), 7.2.7 ' +
        '(discovery chat), 7.3.5 (tree review) — the embedded surfaces this ' +
        'composes.\n' +
        '- `motir-core/components/ui/` — the step/progress primitives + the ' +
        'authed shell to mirror.\n' +
        '- `motir-core/app/globals.css` — `--el-*` + `[data-display-style]` ' +
        'tokens.',
      dependsOn: ['7.16.1', '7.16.2'],
    },
    {
      id: '7.16.6',
      title:
        'Vitest — the orchestration state machine + the convention-before-generation gate + resumability',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Lock the wizard’s orchestration + the two gates against ' +
        'regression. motir-core tests run over a real Postgres (the project ' +
        'convention; `tests/helpers/db.ts` truncates between tests; the only ' +
        'allowed `vi.mock` is `getSession()`). The downstream jobs ' +
        '(connect/index/audit/discovery/generate) are stubbed at the 7.1 ' +
        'client / job boundary with recorded results (the wizard’s job is ' +
        'SEQUENCING + GATING, not the jobs themselves) — but the state machine, ' +
        'the exit conditions, and the gate run for real.\n\n' +
        '**State machine + transitions** (7.16.2):\n\n' +
        '- A fresh migrate wizard starts at `connect`; each `advance` moves to ' +
        'the next step ONLY when the current exit condition is met (a connected ' +
        'repo → index; `codeGraphReady` → audit_convention; etc.) and ' +
        'rejects when it is not.\n' +
        '- **Resumability**: `GET …/:id` returns the persisted step; ' +
        'simulating a re-open mid-flow resumes at the saved step, never resets ' +
        'to `connect`.\n\n' +
        '**The convention gate** (7.16.3 — the load-bearing case):\n\n' +
        '- With NO approved convention, `advance` out of `audit_convention` is ' +
        'REJECTED with the typed `ConventionNotApprovedError`; generation is ' +
        'unreachable.\n' +
        '- After the convention is approved (status `standard`, via the stubbed ' +
        '7.14.5 boundary), `advance` proceeds.\n' +
        '- **Defense in depth**: even a forced transition into `generate` ' +
        '(bypassing the step guard) is rejected at job-submit time when no ' +
        'approved convention exists (the 7.16.4 server-side re-check) — proving ' +
        'the gate is enforced in TWO places, not only by the UI.\n\n' +
        '**Code-aware generation** (7.16.4):\n\n' +
        '- The generate step submits a job carrying the repo’s ' +
        '`aiProjectId` + `repoRef` (the code-aware context) — asserted on the ' +
        'submitted envelope; a missing code graph fails the step cleanly (no ' +
        'silent blank-slate fallback).\n\n' +
        '## Acceptance criteria\n\n' +
        '- All cases above pass over a real Postgres; the only mocks are ' +
        '`getSession()` + the 7.1 client/job boundary (the downstream jobs) — ' +
        'every DB / state-machine / gate path is real.\n' +
        '- The convention-gate case FAILS if the gate is removed (no-approval ' +
        '→ generation reachable) — proving the test guards the gate; and ' +
        'the defense-in-depth case proves the gate holds at BOTH the step ' +
        'transition and job submit.\n' +
        '- The resumability case FAILS if the wizard restarts from `connect` ' +
        'instead of the saved step.\n' +
        '- New service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) — no untested branch in the ' +
        'transition guards or the gate.\n\n' +
        '## Context refs\n\n' +
        '- 7.16.2 (the state machine), 7.16.3 (the convention gate), 7.16.4 ' +
        '(the code-aware submit) — everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage ' +
        'gate + the single-allowed-`getSession`-mock rule.\n' +
        '- `motir-core/tests/helpers/db.ts` — the truncate-between-tests ' +
        'harness.',
      dependsOn: ['7.16.2'],
    },
    {
      id: '7.16.7',
      title:
        'Playwright E2E — connect repo → index → review+approve convention → code-aware generate → approve plan',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/onboarding-migrate.spec.ts`) over ' +
        'the seeded `moooon`/`motir` tenant — closes the migrate-onboarding ' +
        'promise from a user’s seat. Because a REAL GitHub App install + a ' +
        'real code-graph index in CI is impractical, the spec drives the wizard ' +
        'UI and simulates the externals deterministically: the connect step is ' +
        'completed via the stubbed-GitHub path (the 7.7.9 pattern — a signed ' +
        '`installation` webhook fixture), the index is backed by the local ' +
        'codegraph FIXTURE (7.5.4), and the audit/discovery/generate jobs use ' +
        'recorded fixture results (the 7.14 / 7.2 / 7.3 boundary stubs) — so the ' +
        'test asserts the WIZARD loop + the gates, not model quality or live ' +
        'GitHub.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` via the existing `signIn` helper; ' +
        'start a new **migrate-existing-codebase** project. Assert the wizard ' +
        'opens at the **Connect** step with the step rail showing Generate ' +
        'LOCKED.\n' +
        '2. **Connect**: complete the stubbed connect (OAuth identity + a ' +
        'signed `installation` fixture selecting a test repo). Assert the ' +
        'wizard advances to **Index**.\n' +
        '3. **Index**: with the codegraph fixture backing the index, assert the ' +
        'index-progress step shows progress and the Next action ENABLES only ' +
        'when the index is ready (the gate); advance to **Audit & ' +
        'convention**.\n' +
        '4. **Audit + convention**: assert the audit report + the proposed ' +
        'convention render. **Try to proceed WITHOUT approving** — assert ' +
        'Generate stays LOCKED / the advance is blocked with the "approve to ' +
        'continue" message. EDIT then **Approve & set as standard**; assert ' +
        'Generate UNLOCKS.\n' +
        '5. **Discovery**: complete the short discovery pass (stubbed) — ' +
        'assert it proceeds.\n' +
        '6. **Generate (code-aware)**: trigger generation; assert the ' +
        '"reading your codebase" generating state, then the proposed tree ' +
        '(reflecting the fixture code). **Approve** the plan; navigate to ' +
        '/issues and assert the backlog exists, parented per the grammar.\n' +
        '7. **Resume**: re-open the project mid-way in a second pass and assert ' +
        'it resumes at the saved step (not from Connect).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e onboarding-migrate` passes locally + in CI, backed by ' +
        'the stubbed connect + the codegraph fixture + recorded job results (no ' +
        'live GitHub, no live model).\n' +
        '- The spec asserts the GATE: with the convention un-approved, ' +
        'generation is unreachable (Generate locked / advance blocked); after ' +
        'approve, it unlocks.\n' +
        '- The spec asserts the index-progress gate (Next enabled only when the ' +
        'index is ready) and resumability (re-open returns to the saved step).\n' +
        '- It uses the existing `signIn(page, email, password)` helper + the ' +
        '7.7.9 signed-webhook + the 7.5.4 fixture patterns — no new auth / ' +
        'GitHub plumbing invented.\n' +
        '- Not flake-prone: explicit waits on the step-rail state, the ' +
        'index-progress `aria-live` region, and the post-approve confirmation ' +
        '(no fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 7.16.5 (the wizard UI under test), 7.16.3 (the convention gate), ' +
        '7.16.4 (the code-aware generate).\n' +
        '- 7.7.9 — the signed-`installation`-webhook stub pattern for the ' +
        'connect step; 7.5.4 — the codegraph fixture backing the index; 7.3.7 ' +
        '/ 7.2.10 — the generate/discovery E2E stub patterns to reuse.\n' +
        '- `motir-core/tests/e2e/` — the `signIn` helper + the established ' +
        'aria-live waiting patterns to mirror.',
      dependsOn: ['7.16.5'],
    },
  ],
};
