import type { SeedStory } from '../types';

/**
 * Story 7.15 — Start-fresh onboarding flow (guided wizard). The "Workflow A"
 * front-of-house: the guided, multi-step experience a NEW project (no code yet)
 * walks through to go from an empty workspace to a reviewed-and-approved backlog
 * that is ready to dispatch. It is the start-fresh sibling of 7.16
 * (migrate-existing-codebase); both are GUIDED WIZARDS.
 *
 * **The load-bearing idea: 7.15 ORCHESTRATES, it does not REIMPLEMENT.** Every
 * heavy piece this wizard drives already exists as a shipped Epic-7 capability —
 * 7.2 discovery + direction docs, 7.3 generate_tree + the review/approve
 * surface, 7.14 the coding-convention store, 7.6/7.0 dispatch setup. 7.15 adds
 * exactly ONE new thing: a **state machine** that sequences those pieces into a
 * single legible "new project" path, holds the user's place across steps, and
 * resumes mid-flow. It introduces NO new planner job, NO new generation engine,
 * NO new convention engine — it is the conductor, and the existing jobs are the
 * orchestra. (Any temptation to re-draft discovery or re-implement generation
 * inside the wizard is a bug: the wizard calls 7.2/7.3/7.14 and renders their
 * surfaces inside its frame.)
 *
 * **The sequence (Workflow A — start-fresh).**
 *   1. **Name the project** — create/select the motir-core project the wizard
 *      operates on (the tenant the whole flow is scoped to).
 *   2. **Discovery** — run the 7.2 `discovery` job (the "do you care?" interview)
 *      and review the three direction docs (vision / discovery / feasibility).
 *   3. **Establish the coding convention from the chosen stack** — record a
 *      convention in 7.14's store DERIVED FROM the stack/starter the user pinned
 *      in discovery. **No audit** — there is no code to analyze yet (the audit
 *      half of 7.14 is migrate-only); fresh just ESTABLISHES the standard so the
 *      very first dispatched prompt (7.6 + 7.14.6) already carries it.
 *   4. **Generate the plan** — run the 7.3 `generate_tree` job over the direction
 *      docs.
 *   5. **Review + approve** — the 7.3 review/approve surface (preview → edit →
 *      approve → persist via `workItemsService`). Approve is the only write.
 *   6. **Ready to dispatch** — hand off to the 7.0 ready set / 7.6 dispatch
 *      surface; the wizard's job is done once a real, approved backlog exists.
 *
 * **What is NEW here vs what is REUSED.**
 *   - NEW (this story): the wizard STATE MACHINE (the ordered steps + the
 *     transition rules + a persisted per-project wizard-progress record), the
 *     wizard SHELL UI (the multi-step frame + progress indicator that embeds the
 *     existing surfaces), the fresh-only "establish convention from stack" wiring
 *     (recording, not auditing), and resumability.
 *   - REUSED (other stories, called not copied): 7.2 discovery + docs view; 7.3
 *     generate + review/approve; 7.14's `CodingConvention` store (7.14.3); 7.0/
 *     7.6 dispatch setup as the exit.
 *
 * **The locked Epic-7 architecture it inherits (full prose in story-7.1.ts).**
 * One-directional writes — the wizard never writes the tree itself; it drives
 * 7.3's generate → human-approve → persist (through `workItemsService`). A
 * tool-use SESSION, not a one-shot — discovery and generation are 7.1.4 async
 * jobs the wizard submits/streams, so the wizard is a state machine OVER jobs,
 * not a long-held socket. STATEFUL motir-ai — the direction docs and the
 * convention persist in motir-ai; the wizard's OWN progress record lives in
 * motir-core (it is plan/onboarding state about a motir-core project, not AI
 * context), keeping the open-core line clean.
 *
 * **Mirror product (rung 1 + the named product onboarding wizards — VERIFIED,
 * June 2026, not asserted).** The "guided new-project wizard that calmly walks
 * connect → configure → first result" is the shape Vercel's **New Project** flow
 * ships (vercel.com/new + vercel.com/docs/git): "a calm flow following a simple
 * hierarchy — account, Git provider, import project," where framework detection
 * is automatic and the first deploy streams a live progress log ending in the
 * URL as the payoff. Linear's onboarding (linear.app/docs/start-guide) is the
 * staged "create workspace → configure → create first team → guided task
 * checklist" pattern (hands-on, learn-by-doing). Plane's setup
 * (docs.plane.so/introduction/quickstart) is the staged "create workspace →
 * create first project → configure states/labels → add work items" sequence.
 * Motir's start-fresh wizard mirrors that staged, calm, one-decision-per-step
 * posture — but its steps are AI steps (discovery interview → generate →
 * approve) rather than manual config. The Atlassian-Rovo generate→customize→
 * approve loop (verified in 7.3) is the engine the wizard wraps for step 5.
 *
 * **Resumability is industry-standard, not a nice-to-have (no shortcut).** The
 * save-and-resume wizard pattern (AppMaster / NN-g wizard guidance) is explicit:
 * persist progress from the FIRST step, save on each transition, and let the user
 * return to a "resume" screen ("3 of 6 complete — continue from step 4") rather
 * than restarting. Discovery and generation are long-running AI jobs, so a fresh
 * checkout / reload / next-day return MUST land back at the right step with the
 * already-produced artifacts intact — the wizard-progress record (7.15.2) makes
 * that durable, and 7.15.5 tests it.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward-pointing deps.**
 * Every 7.15 leaf depends only on backward/sideways ids: same-story 7.15.x, and
 * upstream 7.2.x (discovery), 7.3.4 (the generate-and-persist service the
 * orchestration drives), 7.14.3 (the convention store the fresh path records
 * into). All have story number ≤ 7.15. Nothing depends on 7.16+ or any later
 * story. Statuses follow the rule: the design subtask (7.15.1, `dependsOn: []`)
 * is `planned`; everything chained behind it or behind any not-yet-done id is
 * `blocked`.
 *
 * **The design gate fires (Principle #13).** 7.15 ships a real user-facing
 * surface — the multi-step wizard shell. So the FIRST subtask (7.15.1) is a
 * `design` card producing `design/onboarding-fresh/*.mock.html` +
 * `design-notes.md`, and EVERY UI-touching code subtask (7.15.4) depends on it
 * and is `blocked` behind it.
 */
export const story_7_15: SeedStory = {
  id: '7.15',
  title: 'Start-fresh onboarding flow (guided wizard)',
  status: 'planned',
  gitBranch: 'feat/PROD-7.15-onboarding-fresh-wizard',
  descriptionMd:
    'The guided, multi-step experience a brand-new project (no code yet) walks ' +
    'through to go from an empty workspace to a reviewed-and-approved backlog ' +
    'that is **ready to dispatch**. This is **Workflow A** (start-fresh), the ' +
    'sibling of 7.16 (migrate-existing-codebase). Critically, the wizard ' +
    '**ORCHESTRATES the existing AI pieces — it does not reimplement them**: it ' +
    'is a state machine that sequences 7.2 discovery → establish-convention → ' +
    '7.3 generate → review/approve → dispatch setup, holding the user’s place ' +
    'and resuming mid-flow. The only NEW capability is the conductor (the step ' +
    'machine + the wizard shell + the fresh-only convention wiring); the heavy ' +
    'lifting is the shipped jobs and surfaces it drives.\n\n' +
    '**The steps (locked — see the module header for the full rationale):**\n\n' +
    '1. **Name the project** — create/select the motir-core project the whole ' +
    'flow is scoped to.\n' +
    '2. **Discovery** — run the 7.2 `discovery` job (the "do you care?" ' +
    'interview) and review the three direction docs (vision / discovery / ' +
    'feasibility).\n' +
    '3. **Establish the coding convention from the chosen stack** — record a ' +
    'convention in 7.14’s store derived from the stack/starter pinned in ' +
    'discovery. **No audit** (no code yet — the audit half of 7.14 is ' +
    'migrate-only); fresh just establishes the standard so the very first ' +
    'dispatched prompt already carries it.\n' +
    '4. **Generate the plan** — run the 7.3 `generate_tree` job over the ' +
    'direction docs.\n' +
    '5. **Review + approve** — the 7.3 review/approve surface (preview → edit ' +
    '→ approve → persist via `workItemsService`). **Approve is the only ' +
    'write.**\n' +
    '6. **Ready to dispatch** — hand off to the 7.0 ready set / 7.6 dispatch ' +
    'surface; the wizard is done once a real, approved backlog exists.\n\n' +
    '**Scope:** the wizard-shell design (7.15.1); the orchestration state ' +
    'machine + the persisted wizard-progress record + resumability (7.15.2); ' +
    'the fresh-only "establish convention from the chosen stack" wiring into ' +
    '7.14’s store, with NO audit (7.15.3); the wizard shell UI — the ' +
    'multi-step frame + progress that EMBEDS the existing surfaces (7.15.4); the ' +
    'orchestration + resumability vitest (7.15.5); and the new-project → ' +
    'discovery → generate → approve → ready-to-dispatch E2E (7.15.6).\n\n' +
    '**Out of scope (named so they land in their owning stories, not here):** ' +
    'the discovery interview + direction-doc engine (7.2 — the wizard CALLS ' +
    'it); the generate_tree engine + the review/approve surface (7.3 — embedded, ' +
    'not rebuilt); the convention/audit ENGINE + the convention store schema ' +
    '(7.14 — 7.15 records into it for the fresh case only); the migrate ' +
    'wizard + its audit/convention-approval step (7.16); per-issue prompt ' +
    'generation + the dispatch surface itself (7.6 — the wizard’s exit, not its ' +
    'body).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services locally (motir-core on ' +
    '`:3000`, motir-ai on its dev port, each pointed at the other), with the ' +
    '7.2 discovery job and the 7.3 generate/approve flow able to run for a new ' +
    'project (the planner backed by the same deterministic stubbed-SDK ' +
    'transport the 7.2/7.3 suites use, so the run is offline + stable).\n' +
    '- **End-to-end happy path (the story).** Start the start-fresh wizard for ' +
    'a brand-new project. Step through: (1) name the project; (2) run discovery ' +
    'and see the three direction docs (pin a stack in the interview); (3) the ' +
    'wizard ESTABLISHES a coding convention derived from that stack and records ' +
    'it as the project’s STANDARD in 7.14’s store — with **no audit step** ' +
    '(there is no code to audit); (4) generate the plan; (5) review the ' +
    'proposed tree, edit a node, **Approve** — the backlog is persisted via ' +
    '`workItemsService`; (6) land on the "ready to dispatch" step that links ' +
    'into the 7.0 ready set / 7.6 dispatch.\n' +
    '- **Orchestration, not reimplementation.** Confirm the wizard SUBMITS the ' +
    'existing 7.2 `discovery` and 7.3 `generate_tree` jobs and EMBEDS the ' +
    '7.2/7.3 surfaces — it does not contain its own discovery prompt, its own ' +
    'generation engine, or its own convention engine. The only NEW persistence ' +
    'is the wizard-progress record (motir-core) + the fresh convention RECORD ' +
    '(written through 7.14’s store, motir-ai).\n' +
    '- **Resumability.** Mid-flow (say, right after discovery), reload the ' +
    'browser / sign out and back in: the wizard RESUMES at the step you left ' +
    '(a "resume — N of 6" entry), with the already-produced direction docs ' +
    'intact, NOT a fresh restart. Completing an earlier step and returning does ' +
    'not re-run it.\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.15.5 covers the step ' +
    'machine’s legal transitions + gates (you cannot reach generate before the ' +
    'docs exist; convention is established before dispatch), resume from each ' +
    'step, and the fresh path recording a convention with NO audit.\n' +
    '- `pnpm test:e2e` (Playwright) — 7.15.6 drives the whole wizard from a new ' +
    'project to a ready-to-dispatch backlog over the seeded tenant + the stubbed ' +
    'planner.\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** The ' +
    'wizard-progress record is the ONLY new table and it lives in motir-core ' +
    '(it is onboarding/plan state about a motir-core project); the direction ' +
    'docs + the convention stay in motir-ai, reached only over the 7.1 ' +
    'boundary; no `motir-ai` import in motir-core; browsers never call ' +
    'motir-ai.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '7.15.1',
      title: 'Design — the start-fresh onboarding wizard (the 6-step guided flow + progress)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The wizard shell UI (7.15.4) depends on this ' +
        'card; without it the multi-step surface would be improvised, which is ' +
        'forbidden (notes.html #31). This wizard is the FIRST thing a new ' +
        'project owner sees, so it sets the onboarding grammar the migrate ' +
        'wizard (7.16) mirrors.\n\n' +
        'Produce the design asset for the **start-fresh onboarding wizard** ' +
        'under `motir-core/design/onboarding-fresh/`. Author it as a ' +
        '**`*.mock.html` mockup** built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route is ' +
        'preferred when a coding agent produces the design (no translation gap; ' +
        'the reviewer sees the actual tokens). A PNG export is optional; the ' +
        '`.mock.html` is the source of truth (MOTIR.md § Design-reference ' +
        'rule).\n\n' +
        '**Critical framing for the mock: this is a SHELL that EMBEDS existing ' +
        'surfaces, not a redraw of them.** The discovery panel (step 2) IS the ' +
        '7.2 chat/docs surface; the generate + review/approve panel (steps 4–5) ' +
        'IS the 7.3 review surface. Draw the wizard FRAME (the step rail, the ' +
        'progress indicator, the back/next + resume affordances, the per-step ' +
        'header) and show the existing surface composed INSIDE the frame for the ' +
        'AI steps — do NOT re-spec discovery or the tree-review (reference the ' +
        '7.2.1 / 7.3.1 mocks for those). The genuinely new pixels are the frame ' +
        'and the fresh-only convention step.\n\n' +
        '**Mirror (VERIFIED — product new-project wizards).** Vercel’s New ' +
        'Project flow (vercel.com/new) is "a calm flow following a simple ' +
        'hierarchy" with one decision per step and a streaming progress payoff; ' +
        'Linear (linear.app/docs/start-guide) and Plane ' +
        '(docs.plane.so/introduction/quickstart) both stage onboarding as ' +
        'create → configure → first-result with a visible step/checklist. Mirror ' +
        'that calm, one-decision-per-step posture — but Motir’s steps are AI ' +
        'steps (discovery → generate → approve), not manual config. Note this ' +
        'verified-mirror framing in design-notes.md.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the multi-panel ' +
        'rule, mistake #31):\n\n' +
        '- **Panel 1 — the wizard frame + step rail (overview).** The persistent ' +
        'chrome: a step rail / progress indicator showing all six steps (name → ' +
        'discovery → convention → generate → review/approve → ready), the ' +
        'current step highlighted, completed steps checked, future steps muted. ' +
        'Show the "N of 6" progress and the back/next affordances. This is the ' +
        'one piece reused across every step.\n' +
        '- **Panel 2 — step 1, name the project.** Create/select the project ' +
        '(the shipped input + the project-create affordance) — the tenant the ' +
        'flow scopes to. Keep it to one decision (the Vercel "calm" posture).\n' +
        '- **Panel 3 — step 2, discovery (EMBEDDED 7.2).** The 7.2 chat/' +
        'discovery + the three-direction-docs view rendered INSIDE the wizard ' +
        'frame, with the wizard’s "continue once you’re happy with the docs" ' +
        'advance control. Draw it as the embedded 7.2 surface, NOT a re-spec — ' +
        'reference design/ai-chat/ in the notes.\n' +
        '- **Panel 4 — step 3, establish the coding convention from the stack ' +
        '(NEW, fresh-only).** A review surface showing the convention DERIVED ' +
        'from the stack the user pinned in discovery (e.g. "TypeScript + ' +
        'Next.js + Prisma → here’s your starting convention"), with a light ' +
        'edit + an "adopt as the project standard" confirm. Make explicit ' +
        '(copy) that there is **no code audit** here — this is fresh, so we ' +
        'ESTABLISH a convention rather than analyze existing code (the audit ' +
        'half is the 7.16/migrate path). This is the one genuinely new content ' +
        'panel.\n' +
        '- **Panel 5 — steps 4–5, generate + review/approve (EMBEDDED 7.3).** ' +
        'The 7.3 "Generating your plan…" streaming state and the tree ' +
        'review/approve surface inside the wizard frame, with the wizard’s ' +
        'advance gated on approve. Draw it as the embedded 7.3 surface — ' +
        'reference design/ai-planning/ in the notes, do not re-spec the ' +
        'tree-review.\n' +
        '- **Panel 6 — step 6, ready to dispatch + the RESUME state.** The ' +
        'completion step: a "your backlog is ready" summary (counts) with a ' +
        'primary CTA into the ready set / dispatch (7.0/7.6). ALSO draw the ' +
        '**resume** entry state: when a user returns mid-flow, a "Resume ' +
        'onboarding — step N of 6" card (the save-and-resume pattern) that ' +
        'continues from where they left off, NOT a restart.\n\n' +
        'Also write **`design/onboarding-fresh/design-notes.md`** naming the ' +
        'exact primitives used per surface (and, for the embedded steps, ' +
        'pointing at the 7.2.1 / 7.3.1 mocks rather than re-specifying), the ' +
        'exact copy strings (incl. the "no audit for fresh" convention copy and ' +
        'the resume-card copy), the placement decisions, the per-`--el-*` ' +
        'colour role for each frame element (step-rail states: current / done / ' +
        'upcoming via `--el-*` — NOT a page-level tinted surface, finding #35), ' +
        'and a "primitives composed (no hand-rolling)" checklist (the ' +
        'design-notes.md convention 1.3.3 / 1.5.1 / 7.0.1 established).\n\n' +
        '**Branch.** `design/PROD-7.15.1-onboarding-fresh-wizard`. The ' +
        '`design/*` prefix gate skips CI E2E + the Vercel preview deploy ' +
        '(MOTIR.md § Plan-seed Workflow) — this PR only edits ' +
        '`design/onboarding-fresh/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/onboarding-fresh/onboarding-fresh.mock.html` ' +
        'exists, renders the six panels above, and references ONLY `--el-*` ' +
        'tokens + `[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- The wizard FRAME (step rail + "N of 6" progress + back/next + resume) ' +
        'is drawn as the reused chrome; the discovery (step 2) and generate/' +
        'review (steps 4–5) panels are shown as EMBEDDED 7.2/7.3 surfaces, not ' +
        're-specified, and the notes reference design/ai-chat/ + ' +
        'design/ai-planning/.\n' +
        '- The convention step (Panel 4) is drawn as a fresh-only ESTABLISH ' +
        'surface with explicit "no code audit" copy, and the resume state ' +
        '(Panel 6) is drawn.\n' +
        '- `motir-core/design/onboarding-fresh/design-notes.md` exists, names ' +
        'every primitive composed (or points at the embedded surfaces’ mocks) + ' +
        'every copy string + the per-element `--el-*` role (incl. the step-rail ' +
        'state roles), and records the verified product-wizard mirror.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Button`, the ' +
        'step/stepper/progress primitive if one exists — else flag a NEW ' +
        '`design/` subtask, not a code workaround — `EmptyState`, the toast, ' +
        'the Markdown renderer for the convention).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ai-chat/` (7.2.1) + `motir-core/design/' +
        'ai-planning/` (7.3.1) — the surfaces this wizard EMBEDS (reference, ' +
        'don’t re-spec) + the `design-notes.md` shape to mirror.\n' +
        '- `motir-core/design/ready/` (7.0.1) — the dispatch/ready exit the ' +
        'final step links into.\n' +
        '- `motir-core/components/ui/*` — the shipped primitives (Card, Button, ' +
        'the stepper/progress primitive, EmptyState, the Markdown renderer) the ' +
        'frame composes.\n' +
        '- `motir-core/app/globals.css` — `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (the swap layer the mock ' +
        'references).\n' +
        '- This module header — the orchestrate-don’t-reimplement framing + the ' +
        'verified product-wizard mirror + the resumability pattern.',
      dependsOn: [],
    },
    {
      id: '7.15.2',
      title:
        'Fresh-onboarding orchestration — the wizard state machine + resumable progress record',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the brain of the wizard: a **state machine** (in motir-core) ' +
        'that sequences the start-fresh steps and a **durable per-project ' +
        'wizard-progress record** that makes the flow resumable. This is the ' +
        'ONE genuinely new capability of the story — it ORCHESTRATES the ' +
        'existing 7.2 / 7.3 / 7.14 pieces; it does NOT contain a discovery ' +
        'prompt, a generation engine, or a convention engine.\n\n' +
        '**The state machine.** Model the ordered steps and the legal ' +
        'transitions explicitly: `name_project → discovery → ' +
        'establish_convention → generate → review_approve → ready_to_dispatch` ' +
        '(plus a terminal `done`). Each transition has a GATE — a step can only ' +
        'be entered when its precondition holds: `generate` requires the three ' +
        'direction docs to exist (7.2); `review_approve` requires a generated ' +
        'delta (7.3); `ready_to_dispatch` requires both an approved backlog AND ' +
        'an established convention. The machine is a pure, testable module ' +
        '(`lib/onboarding/freshWizardMachine.ts`) — given a progress record + ' +
        'an event, it returns the next state or rejects an illegal transition. ' +
        '(Mirror the save-and-resume guidance: the machine is the conductor; ' +
        'the heavy work is the jobs it triggers.)\n\n' +
        '**The progress record (the resumability spine).** Add a motir-core ' +
        '`OnboardingSession` model (4-layer: repository + service + migration) ' +
        'keyed to the project: `{ id, projectId, kind ("fresh"), currentStep, ' +
        'completedSteps, dataJson (the per-step references — e.g. the generated ' +
        'job id, the convention id), createdAt, updatedAt }`. It is created at ' +
        'step 1 (persist from the FIRST step — the save-and-resume rule, not ' +
        'step 3) and updated on every transition, so a reload / re-login / ' +
        'next-day return RESUMES at `currentStep` with the produced artifacts ' +
        'intact, rather than restarting. **This record lives in motir-core** ' +
        '(it is onboarding/plan state ABOUT a motir-core project, not AI ' +
        'context) — the open-core line holds; the direction docs + the ' +
        'convention stay in motir-ai.\n\n' +
        '**Orchestration service.** A `freshOnboardingService` exposes the ' +
        'step-driving methods the API/UI call — `start(projectId)`, ' +
        '`advance(sessionId, event)`, `getState(sessionId)` — each of which ' +
        '(a) runs the machine to validate the transition, (b) triggers the ' +
        'RIGHT existing capability for the step (submit a 7.2 `discovery` job / ' +
        'a 7.3 `generate_tree` job via the 7.1.5 client; record the convention ' +
        'via 7.15.3; hand off to dispatch), and (c) persists the new progress. ' +
        'It owns NO planning logic — it delegates to the shipped jobs/services. ' +
        '4-layer: routes call ONE service method; the service owns the ' +
        'transaction around the progress write.\n\n' +
        '**Idempotent + non-destructive.** Re-entering a completed step does ' +
        'NOT re-run its job (returns the existing artifact); advancing is ' +
        'idempotent on the recorded step (a double-submit does not double-' +
        'generate). The actual generate→approve→persist still flows through ' +
        '7.3.4 behind a human approve — the wizard never writes the tree ' +
        'itself.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lib/onboarding/freshWizardMachine.ts` models the six ordered steps ' +
        '+ the gated transitions as a pure module; an illegal transition (e.g. ' +
        '`generate` before the docs exist, `ready_to_dispatch` before approve + ' +
        'convention) is rejected, not silently allowed.\n' +
        '- A motir-core `OnboardingSession` model + migration + repository + ' +
        'service exist (4-layer, write methods require `tx`); the session is ' +
        'created at step 1 and updated on every transition.\n' +
        '- `freshOnboardingService.start/advance/getState` drive the machine ' +
        'and TRIGGER the existing 7.2 discovery / 7.3 generate jobs (via the ' +
        '7.1.5 client) + the 7.15.3 convention record — containing no discovery ' +
        'prompt / generation engine / convention engine of their own.\n' +
        '- Resume: given a persisted session, `getState` returns the exact ' +
        'step + the produced-artifact references; re-entering a completed step ' +
        'returns the existing artifact (no re-run, no duplicate).\n' +
        '- The `OnboardingSession` table lives in motir-core only; no AI table ' +
        'is added; no `motir-ai` import (jobs go through the 7.1.5 client); ' +
        '4-layer respected.\n\n' +
        '## Context refs\n\n' +
        '- 7.2.5 / 7.2.6 — the `discovery` job + chat proxy the machine ' +
        'triggers for step 2.\n' +
        '- 7.3.4 — the generate-and-persist service (submit `generate_tree`, ' +
        'approve→persist) the machine drives for steps 4–5.\n' +
        '- 7.15.3 — the fresh convention-establish wiring the machine invokes ' +
        'for step 3.\n' +
        '- 7.1.5 — the core→ai client the orchestration submits jobs through.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer (the repository/service/transaction ' +
        'rules the progress store follows).\n' +
        '- This module header — the orchestrate-don’t-reimplement contract + ' +
        'the resumability requirement.',
      dependsOn: ['7.15.1', '7.3.4'],
    },
    {
      id: '7.15.3',
      title: 'Establish the coding convention from the chosen stack/starter — fresh, NO audit',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Wire the fresh-project CONVENTION step: derive a coding convention ' +
        'from the stack/starter the user pinned in discovery and RECORD it as ' +
        'the project’s STANDARD in 7.14’s store — with **NO code audit** (this ' +
        'is the start-fresh path; there is no code yet to analyze). This is the ' +
        'confirmed-design split: the audit half of 7.14 (file 1, the ' +
        'code-issues report) runs only for MIGRATE; FRESH just ESTABLISHES a ' +
        'convention so the very first dispatched prompt already carries it ' +
        '(7.6 + 7.14.6, the productized CLAUDE.md auto-load).\n\n' +
        '**Where the stack comes from.** The discovery doc (7.2) already ' +
        'records the pinned stack / framework / DB / deploy target (the ' +
        '"do you care?" decisions). This step READS those pinned decisions ' +
        '(over the 7.1 boundary, the same way 7.2.8 fetches direction docs) and ' +
        'derives a starting convention from them — adopt a well-known ' +
        'starter’s convention if the stack matches one, else compose a ' +
        'clean-code baseline for that stack. (The derivation may itself be a ' +
        'small motir-ai call OR a deterministic template keyed by stack — pick ' +
        'the durable shape; either way it RECORDS through 7.14’s store, it does ' +
        'not invent a parallel store.)\n\n' +
        '**Recording into 7.14’s store (not a new store).** Persist the result ' +
        'as a `CodingConvention` row via 7.14.3’s store ' +
        '(`aiProjectId, contentMd, status, version`). It lands as ' +
        '`status: standard` once the user confirms it in the wizard (Panel 4) — ' +
        'fresh has no "messy repo" so there is no propose-then-approve audit ' +
        'gate; the user simply reviews + adopts the derived convention. NO ' +
        '`CodeAudit` row is written for a fresh project (there is nothing to ' +
        'audit) — the audit artifact is migrate-only.\n' +
        'The motir-core side is a thin proxy over the 7.1 boundary (4-layer: ' +
        'route → a service → the 7.1.5 client); no `motir-ai` import, no AI ' +
        'table in motir-core.\n\n' +
        '**Why establish (not skip).** Without a convention the first dispatch ' +
        'would carry no house style and the generated code would drift from day ' +
        'one — so fresh MUST establish a standard up front, even though it can’t ' +
        'audit. This is the no-shortcut, durable shape: the same store + ' +
        'injection path (7.14.6) the migrate flow uses, minus the audit it ' +
        'cannot run.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The step reads the pinned stack/starter from the 7.2 discovery doc ' +
        '(over the 7.1 boundary) and derives a starting coding convention from ' +
        'it (adopt-a-starter if matched, else a clean-code baseline for that ' +
        'stack).\n' +
        '- The convention is RECORDED through 7.14.3’s `CodingConvention` store ' +
        '(per project, in motir-ai) and becomes `status: standard` on the ' +
        'user’s adopt-confirm — NOT a new parallel store.\n' +
        '- **No audit for fresh:** no `CodeAudit` (code-issues report) row is ' +
        'created — there is no code to analyze; the audit half is migrate-only ' +
        '(7.16).\n' +
        '- The established standard is the one 7.6/7.14.6 injects into the first ' +
        'dispatched prompt (verified by reference to that injection path — the ' +
        'wiring exists, it is not re-implemented here).\n' +
        '- 4-layer respected: motir-core proxies via the 7.1.5 client; no ' +
        '`motir-ai` import, no AI table in motir-core.\n\n' +
        '## Context refs\n\n' +
        '- 7.14.3 — the `CodingConvention` (+ `CodeAudit`) store in motir-ai ' +
        'this records into (convention only, no audit for fresh).\n' +
        '- 7.14.6 — the inject-into-7.6-prompt path the established standard ' +
        'feeds (the productized CLAUDE.md).\n' +
        '- 7.2.4 / 7.2.8 — the `DirectionDoc` store + the read path; the ' +
        'discovery doc is where the pinned stack comes from.\n' +
        '- 7.15.2 — the orchestration service that invokes this step + the ' +
        'wizard Panel 4 the user adopts in.\n' +
        '- The onboarding brief’s confirmed design — "fresh just ESTABLISHES a ' +
        'convention from the chosen stack/starter (no audit — no code yet)".',
      dependsOn: ['7.15.2', '7.14.3'],
    },
    {
      id: '7.15.4',
      title:
        'The wizard shell UI — the multi-step frame + progress that embeds the existing surfaces',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the wizard SHELL exactly as 7.15.1 specifies: the multi-step ' +
        'frame (step rail + "N of 6" progress + back/next + resume) that EMBEDS ' +
        'the existing surfaces for the AI steps and renders the one new content ' +
        'step (convention). The genuinely new UI is the FRAME and the ' +
        'convention panel — the discovery and generate/review panels are the ' +
        'shipped 7.2 / 7.3 surfaces rendered INSIDE the frame (composed, not ' +
        're-implemented).\n\n' +
        '- **The shell + step rail.** A route under the authed shell (e.g. ' +
        '`app/(authed)/onboarding/page.tsx` or `…/projects/[key]/onboarding`) ' +
        'that reads the wizard state from 7.15.2 (`getState`) and renders the ' +
        'step rail + progress, the current step’s body, and the back/next/' +
        'resume controls. Advancing calls the 7.15.2 `advance` endpoint; the ' +
        'next control is GATED on the step’s precondition (disabled until the ' +
        'docs exist / the tree is approved / the convention is adopted).\n' +
        '- **Step 1 (name) + step 6 (ready).** The project-create/select input ' +
        '(reuse the shipped project-create affordance) and the completion ' +
        'summary with the primary CTA into the 7.0 ready set / 7.6 dispatch.\n' +
        '- **Steps 2 & 4–5 (EMBED, don’t rebuild).** Render the 7.2 chat/docs ' +
        'surface (7.2.7 / 7.2.8) and the 7.3 review/approve surface (7.3.5) ' +
        'INSIDE the wizard frame — import and compose those components; do NOT ' +
        'duplicate their logic. The wizard adds only the "continue" advance once ' +
        'the embedded step is satisfied (docs accepted / tree approved).\n' +
        '- **Step 3 (convention, NEW).** The fresh-only convention panel ' +
        '(7.15.1 Panel 4): render the derived convention (Markdown, the shipped ' +
        'renderer) with a light edit + an "adopt as the project standard" ' +
        'confirm wired to 7.15.3, and explicit "no code audit (you have no code ' +
        'yet)" copy.\n' +
        '- **Resume.** On entry, if a session exists mid-flow, open the resume ' +
        'card ("Resume onboarding — step N of 6") and continue from ' +
        '`currentStep` — never a blank restart (the save-and-resume pattern).\n' +
        '- **Tokens + a11y + i18n.** References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 utilities — the ' +
        '`motir-core/CLAUDE.md` colour/shape rules); the step rail’s current/' +
        'done/upcoming states via `--el-*` (no page-level tint, finding #35); ' +
        'the stepper is keyboard-reachable with `aria-current` on the active ' +
        'step; new `onboarding` i18n namespace for the frame + convention copy ' +
        '(the embedded surfaces keep their own `aiChat` / `aiPlanning` ' +
        'namespaces). No client component touches the service layer directly — ' +
        'all traffic goes through the 7.15.2 / 7.15.3 endpoints.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The shell renders the step rail + "N of 6" progress + back/next/' +
        'resume from the 7.15.1 mock, referencing ONLY `--el-*` + shape tokens ' +
        '(no Tier-0 utilities).\n' +
        '- Steps 2 and 4–5 EMBED the shipped 7.2 (7.2.7/7.2.8) and 7.3 (7.3.5) ' +
        'components inside the frame (composed, not re-implemented); the wizard ' +
        'adds only the gated advance.\n' +
        '- Step 3 renders the derived convention with adopt-confirm (→ 7.15.3) ' +
        'and explicit "no audit for fresh" copy; step 6 links into the ready ' +
        'set / dispatch.\n' +
        '- The next control is gated per step (disabled until the precondition ' +
        'holds); returning mid-flow opens the resume card at the right step, ' +
        'not a restart.\n' +
        '- A11y: `aria-current` on the active step, keyboard-reachable stepper; ' +
        'no client component calls the service layer directly (all via the ' +
        '7.15.2/7.15.3 routes); copy lives in the `onboarding` namespace.\n\n' +
        '## Context refs\n\n' +
        '- 7.15.1 — the design asset (the six panels this implements; the ' +
        'frame + convention panel are the new pixels).\n' +
        '- 7.15.2 — the `getState` / `advance` orchestration endpoints this ' +
        'consumes; 7.15.3 — the convention adopt-confirm endpoint.\n' +
        '- 7.2.7 / 7.2.8 (the chat + docs surfaces) + 7.3.5 (the tree-review ' +
        'surface) — the components this EMBEDS, not rebuilds.\n' +
        '- `motir-core/app/(authed)/*` — the authed shell + the existing ' +
        'client-component patterns to mirror.\n' +
        '- `motir-core/app/globals.css` — `--el-*` colour + ' +
        '`[data-display-style]` shape tokens.\n' +
        '- `motir-core/CLAUDE.md` § colour / shape + Server/Client component ' +
        'conventions.',
      dependsOn: ['7.15.1', '7.15.2'],
    },
    {
      id: '7.15.5',
      title: 'Vitest — the orchestration state machine + resumability',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Lock the wizard’s orchestration + resumability at the unit/integration ' +
        'level (NOT browser E2E — that’s 7.15.6). motir-core tests run over a ' +
        'real Postgres (the project convention; `tests/helpers/db.ts` truncates ' +
        'between tests; the only allowed `vi.mock` is `getSession()`). The 7.2 ' +
        'discovery + 7.3 generate jobs the orchestration triggers are stubbed at ' +
        'the same SDK/job boundary the 7.2/7.3 suites use (canned docs + a ' +
        'recorded delta) so the suite is deterministic + offline — the state ' +
        'machine, the progress store, and the persist path are exercised for ' +
        'real.\n\n' +
        '- **The state machine (pure module).** Every legal transition ' +
        '(`name → discovery → establish_convention → generate → review_approve ' +
        '→ ready_to_dispatch → done`) is accepted; every GATE is enforced — ' +
        '`generate` before the direction docs exist is rejected; ' +
        '`review_approve` before a generated delta is rejected; ' +
        '`ready_to_dispatch` before BOTH an approved backlog AND an established ' +
        'convention is rejected. Illegal transitions never mutate state.\n' +
        '- **The progress store + resume.** `start` creates the ' +
        '`OnboardingSession` at step 1 (persisted from the first step); each ' +
        '`advance` updates `currentStep` + `completedSteps` + the artifact ' +
        'references; `getState` on a persisted session returns the exact step ' +
        '+ references (resume), and re-entering a completed step returns the ' +
        'existing artifact WITHOUT re-running its job (idempotent, ' +
        'non-duplicating).\n' +
        '- **Fresh = no audit.** The `establish_convention` path records a ' +
        '`CodingConvention` (via the 7.15.3 wiring / 7.14.3 store, stubbed at ' +
        'the boundary) and writes NO `CodeAudit` row — the fresh path never ' +
        'produces a code-issues report.\n' +
        '- **Orchestration delegates.** The service triggers the EXISTING 7.2 ' +
        'discovery / 7.3 generate jobs through the 7.1.5 client (asserted via ' +
        'the boundary stub) — it contains no inline planning logic.\n\n' +
        '## Acceptance criteria\n\n' +
        '- All cases above pass; the motir-core suite runs over a real Postgres ' +
        '(no mocks beyond `getSession()` + the 7.2/7.3 job boundary stub).\n' +
        '- A gate violation (e.g. forcing `generate` before docs) FAILS the ' +
        'transition — proving the machine guards the sequence, not just ' +
        'asserts it.\n' +
        '- Resume from each step is exercised, and re-entering a completed step ' +
        'is shown NOT to re-run its job (no duplicate discovery/generate).\n' +
        '- The fresh path is shown to write a convention but NO audit row.\n' +
        '- New service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) — e.g. the machine’s ' +
        'illegal-transition guard and the session repository’s empty-input ' +
        'guard have direct tests.\n\n' +
        '## Context refs\n\n' +
        '- 7.15.2 (the machine + the progress store) + 7.15.3 (the fresh ' +
        'convention wiring) — everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + the coverage ' +
        'gate + the single-allowed-`getSession`-mock rule.\n' +
        '- 7.2.9 / 7.3.6 — the stubbed-job boundary patterns reused for a ' +
        'deterministic discovery/generate.',
      dependsOn: ['7.15.2'],
    },
    {
      id: '7.15.6',
      title: 'Playwright E2E — new project → discovery → generate → approve → ready to dispatch',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'End-to-end browser test ' +
        '(`tests/e2e/onboarding-fresh.spec.ts`) closing the story from the ' +
        'user’s seat: a brand-new project is walked through the whole guided ' +
        'wizard to a reviewed-and-approved, ready-to-dispatch backlog. To keep ' +
        'CI deterministic, the discovery + generate jobs are backed by the same ' +
        'recorded fixtures the 7.2/7.3 E2Es use (canned discovery turns + docs, ' +
        'a recorded delta — no live LLM in CI), so the test asserts the wizard ' +
        'orchestration + the real persist + resumability, not model quality.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` (the project manager) on the seeded ' +
        '`moooon`/`motir` tenant via the existing `signIn` helper; start the ' +
        'start-fresh onboarding wizard.\n' +
        '2. **Step 1 (name):** create/select the new project; assert the step ' +
        'rail shows "1 of 6" and advances.\n' +
        '3. **Step 2 (discovery):** answer the embedded discovery interview ' +
        '(pin a stack), watch the three direction docs appear; advance. Assert ' +
        'the embedded 7.2 surface rendered inside the wizard frame (not a ' +
        'separate page).\n' +
        '4. **Step 3 (convention):** assert the derived convention is shown ' +
        'with the "no code audit (you have no code yet)" copy; adopt it as the ' +
        'standard; advance.\n' +
        '5. **Steps 4–5 (generate + review/approve):** trigger generate, see ' +
        'the streaming state resolve to the proposed tree (embedded 7.3 ' +
        'surface), edit one node, **Approve & create**; assert the confirmation ' +
        'with the created count.\n' +
        '6. **Step 6 (ready):** assert the "ready to dispatch" summary + the CTA ' +
        'into the ready set / dispatch; navigate to /issues and assert the ' +
        'approved backlog exists.\n' +
        '7. **Resume branch:** start a SECOND fresh project, complete steps 1–2, ' +
        'then reload the browser; assert the wizard opens on the resume card at ' +
        'step 3 (not a restart) with the direction docs intact.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e onboarding-fresh` passes locally + in CI, backed by ' +
        'the recorded discovery/generate fixtures (no live model).\n' +
        '- The spec uses the existing `signIn(page, email, password)` helper ' +
        '(no new auth plumbing) and the established peek/navigation patterns.\n' +
        '- Every step (name, discovery, convention-with-no-audit, generate, ' +
        'approve, ready) is asserted, the embedded 7.2/7.3 surfaces are shown to ' +
        'render inside the wizard frame, and the approved backlog exists in ' +
        '/issues after approve.\n' +
        '- The resume branch asserts the wizard returns to the correct step ' +
        'with artifacts intact after a reload — not a fresh restart.\n' +
        '- Not flake-prone: explicit waits on the `aria-live` streaming regions ' +
        '(discovery + generate) and on the step-rail state (no fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 7.15.4 (the wizard shell under test) + 7.15.2 (the orchestration it ' +
        'drives).\n' +
        '- 7.2.10 / 7.3.7 — the discovery + generation E2E patterns + the ' +
        'recorded fixtures this reuses.\n' +
        '- `motir-core/tests/e2e/*` + the `signIn` helper + the established ' +
        'Playwright SSE/`aria-live` waiting patterns to mirror.\n' +
        '- `motir-core/scripts/plan-seed/` — the seeded tenant + how to fixture ' +
        'the discovery docs / delta for the run.',
      dependsOn: ['7.15.4'],
    },
  ],
};
