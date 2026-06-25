import type { SeedStory } from '../types';

/**
 * Story 9.4 — WF4: Hosted + start fresh. The FIRST hosted-execution workflow,
 * opening the HOSTED row of Yue's 6-workflow matrix (3 starting states × 2
 * execution modes). The BYOK row is done (WF1 fresh = 7.15, WF2 +code = 7.16,
 * WF3 +code&import = 7.18); the hosted row is WF4 fresh = **this story**, WF5
 * +code = 9.5, WF6 +code&import = 9.6. WF4 is the hosted twin of 7.15: a
 * brand-new project (no code yet) that, instead of dispatching the approved
 * backlog to the USER'S OWN agent on the USER'S OWN machine (BYOK), dispatches
 * it into a MOTIR-OPERATED hosted sandbox that builds in a Motir-owned repo and
 * opens PRs — "describe it, approve the plan, get a built foundation back".
 *
 * **This is a THIN orchestration+verification story — it COMPOSES, it does not
 * REIMPLEMENT.** Every heavy piece WF4 sequences is owned elsewhere; 9.4 adds
 * only the glue the COMBINATION needs plus the end-to-end verification (a human
 * manual-test pass + an automated e2e). The three capabilities it composes:
 *   - **7.15** — the start-fresh onboarding wizard (name → discovery →
 *     establish-convention-from-stack → generate → review/approve → ready). WF4
 *     reuses the WHOLE fresh planning flow, foundation-and-all (7.15 plans the
 *     foundation — auth/design/infra are PLAN content, never a silent
 *     template).
 *   - **9.3** — the hosted execution layer: repo PROVISIONING + the per-stack
 *     one-line SCAFFOLD (9.3.4), the starter LIBRARY (fork a matching starter
 *     when one exists, else scaffold — 9.3.5), and the GitHub handoff (9.3.7).
 *     WF4's "where does the build happen" is a Motir-owned repo scaffolded by
 *     9.3 — the confirmed **scaffold-then-build** default.
 *   - **9.1** — the hosted agent container + run lifecycle (dispatch → provision
 *     a container-per-run → agent builds → PR → review), gateway-metered. WF4's
 *     execution column IS a 9.1 hosted run.
 *
 * **The gap the `code` subtask fills: sequence FRESH PLANNING → hosted PROVISION
 * /SCAFFOLD → hosted BUILD as one flow.** 7.15 ends at "ready to dispatch"
 * assuming a BYOK exit (a repo the user already has + the user's own agent). WF4
 * has NEITHER yet — a fresh hosted project has no repo at all until 9.3
 * provisions one, and no local agent. So WF4's glue: after the fresh plan is
 * approved (7.15), PROVISION the Motir-owned repo + run the per-stack scaffold
 * (9.3.4) — or fork a matching starter (9.3.5) — for the stack the user pinned
 * in discovery, THEN dispatch the ready items into hosted runs (9.1) that build
 * the foundation the plan describes INTO that scaffolded repo. The
 * scaffold-then-build default (a one-line scaffold + the plan builds
 * auth/design/infra, NOT a fat template) is the confirmed shape. That sequencing
 * — fresh-plan → provision/scaffold → hosted-build — is the substance of 9.4.2;
 * nothing else in WF4 is new.
 *
 * **The sequence (Workflow 4 — hosted execution, fresh):**
 *   1. **Fresh plan** — the 7.15 wizard: name → discovery (pin the stack) →
 *      establish convention from that stack → generate → review/approve. The
 *      plan includes the FOUNDATION (auth/design/infra are plan content).
 *   2. **Provision + scaffold the Motir-owned repo** — on the approved fresh
 *      plan, 9.3.4 creates a Motir-owned repo under Motir's org and runs the
 *      per-stack one-line scaffold (`create-next-app` / `spring init` /
 *      `create-expo-app`) for the pinned stack; or 9.3.5 forks a matching
 *      starter if the library has one (else fall back to scaffold).
 *   3. **Hosted build** — dispatch the ready items into 9.1 hosted runs that
 *      build the planned foundation into the scaffolded repo, opening PRs.
 *   4. **Review** — the human reviews/merges the PRs (the 9.1 review exit;
 *      transfer-to-the-user's-GitHub is 9.3.7, on request).
 *
 * **The hosted-default baked in (confirmed): scaffold-then-build.** Fork a
 * matching library starter if one exists, ELSE one-line scaffold + the plan
 * builds the foundation. The repo is Motir-owned under Motir's org by default
 * (the user may never touch GitHub); transfer-on-request via 9.3.7. WF4 inherits
 * these — it does not re-decide them (9.3.2 owns the decision).
 *
 * **Mirror (the fresh-hosted "describe → built foundation" shape — cite the
 * 7.15 / 9.1 / 9.3 mirrors, lightly verified; WF4 composes pieces already
 * mirror-checked by their owners).** The fresh-plan half mirrors Vercel's New
 * Project / Linear / Plane staged onboarding (verified on 7.15). The hosted-
 * build half mirrors Devin / Google Jules / OpenAI Codex cloud / GitHub Copilot
 * coding agent (dispatch → cloud sandbox → PR — verified on 9.1). The provision/
 * scaffold-then-build + platform-owned-repo half mirrors Lovable / Bolt / v0 /
 * Replit (platform-owned repo + the one-line scaffolds + optional GitHub export
 * — verified on 9.3). WF4 is the end-to-end stitch of those three.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward-pointing deps.**
 * Every `dependsOn` id's story number is ≤ 9.4: 7.15.2 (the fresh onboarding
 * orchestration WF4 reuses — Epic 7, backward), 9.3.4 (the hosted repo provision
 * + scaffold WF4 sequences into — 9.3 < 9.4, backward), and same-story 9.4.x.
 * 9.1 (the hosted run) is referenced in prose and is ≤ 9.4 (backward). All
 * backward/sideways. Statuses follow the rule: EVERY subtask depends on a
 * not-yet-done upstream (7.15.2 / 9.3.4 unbuilt), so NONE is `planned` — all
 * three are `blocked`; the STORY is `planned`.
 *
 * **No design subtask (deliberate).** WF4 introduces no genuinely new combined
 * surface — it reuses the 7.15 fresh-wizard shell + the 9.1 hosted-run surface
 * (the build/PR/cost view) + the 9.3 hosted-repo view. Per the workflows-brief
 * ("NO new design subtask unless a genuinely new combined surface exists"), 9.4
 * carries no `design` card; a net-new combined affordance, if review reveals
 * one, is a NEW `design/` subtask, not improvised UI.
 */
export const story_9_4: SeedStory = {
  id: '9.4',
  title: 'WF4 — Hosted + start fresh (orchestration + verification)',
  status: 'planned',
  gitBranch: 'feat/PROD-9.4-wf4-hosted-fresh',
  descriptionMd:
    'The FIRST hosted-execution workflow — **start fresh, built in Motir’s ' +
    'cloud** — opening the HOSTED row of the 6-workflow matrix (BYOK row done: ' +
    'WF1=7.15, WF2=7.16, WF3=7.18; hosted row: **WF4 fresh = this**, WF5=9.5, ' +
    'WF6=9.6). WF4 is the hosted twin of 7.15: a brand-new project (no code ' +
    'yet) where, instead of dispatching the approved backlog to the user’s OWN ' +
    'agent on the user’s OWN machine (BYOK), Motir provisions a Motir-owned ' +
    'repo, scaffolds it, and runs the agent in a hosted sandbox that builds the ' +
    'planned foundation and opens PRs — “describe it, approve the plan, get a ' +
    'built foundation back”.\n\n' +
    'This is a **THIN orchestration + verification story**: it COMPOSES shipped ' +
    'capabilities — the 7.15 fresh wizard (name → discovery → ' +
    'establish-convention → generate → approve), the 9.3 hosted execution layer ' +
    '(repo provision + per-stack scaffold + starter library + GitHub handoff), ' +
    'and the 9.1 hosted agent run (dispatch → container → build → PR → review) ' +
    '— and adds ONLY the glue the COMBINATION needs plus the end-to-end test. ' +
    'It reimplements none of them.\n\n' +
    '**The gap the code subtask fills: sequence FRESH PLANNING → hosted ' +
    'PROVISION/SCAFFOLD → hosted BUILD.** 7.15 ends at “ready to dispatch” ' +
    'assuming a BYOK exit (a repo the user has + the user’s own agent). A fresh ' +
    'HOSTED project has NEITHER until 9.3 provisions one. So WF4’s glue: after ' +
    'the fresh plan is approved, PROVISION a Motir-owned repo + run the ' +
    'per-stack one-line SCAFFOLD (9.3.4) — or FORK a matching starter (9.3.5) — ' +
    'for the stack pinned in discovery, then dispatch the ready items into 9.1 ' +
    'HOSTED RUNS that build the planned foundation into that repo. The confirmed ' +
    'default is **scaffold-then-build**: a one-line scaffold + the plan builds ' +
    'auth/design/infra (NOT a fat silent template).\n\n' +
    '**The sequence (hosted, fresh):** the 7.15 fresh plan (incl. the ' +
    'foundation as plan content) → provision + scaffold the Motir-owned repo ' +
    '(9.3.4, or fork a starter 9.3.5) for the pinned stack → dispatch ready ' +
    'items into 9.1 hosted runs that build into that repo, opening PRs → ' +
    'human review/merge (transfer-to-your-GitHub on request is 9.3.7).\n\n' +
    '**Hosted defaults inherited (not re-decided — owned by 9.3.2):** ' +
    'scaffold-then-build; Motir-owned repo under Motir’s org by default (the ' +
    'user may never touch GitHub); transfer-on-request via 9.3.7.\n\n' +
    '**Scope:** the end-to-end MANUAL test of WF4 (9.4.1, human); the WF4 ' +
    'orchestration glue — fresh planning (7.15) → hosted provisioning/scaffold ' +
    '(9.3.4) → hosted build (9.1) (9.4.2); the automated e2e of WF4 (9.4.3).\n\n' +
    '**Out of scope (owned by their stories, not here):** the fresh onboarding ' +
    'wizard (7.15 — WF4 drives it); the repo-provision/scaffold/starter-library/' +
    'handoff engine (9.3 — WF4 sequences it); the hosted agent container + run ' +
    'lifecycle + gateway metering (9.1 — WF4 dispatches into it); the BYOK ' +
    'workflows (WF1/2/3 = Epic 7); and the OTHER hosted workflows (WF5 = 9.5, ' +
    'WF6 = 9.6).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services (motir-core on `:3000`, ' +
    'motir-ai on its dev port, each pointed at the other), with the hosted-run ' +
    'infra reachable (9.1.3) and the hosted-repo provisioning provisioned ' +
    '(9.3.3 — the Motir GitHub org + the App’s repo-create scopes + the ' +
    'scaffold runners).\n' +
    '- **WF4 end to end (the story).** Sign in as `zhuyue@motir.co`; start a ' +
    'brand-new project and choose the HOSTED execution mode. Walk the wizard: ' +
    '(1) name → discovery (pin a stack, e.g. Next.js + Prisma) → establish the ' +
    'convention from that stack → generate the plan (incl. the foundation) → ' +
    'review + approve (the 7.15 flow); (2) on approve, confirm Motir PROVISIONS ' +
    'a Motir-owned repo under its org and SCAFFOLDS it (the per-stack one-line ' +
    'scaffold, or a forked starter if one matches the stack); (3) dispatch the ' +
    'ready items into HOSTED runs (9.1) that build the planned foundation INTO ' +
    'that repo and open PRs; (4) review/merge the PRs.\n' +
    '- **The hosted-default holds (the load-bearing assertion).** The repo is ' +
    'MOTIR-OWNED under Motir’s org (the user never had to create or connect a ' +
    'GitHub repo), it was SCAFFOLDED (scaffold-then-build — a real one-line ' +
    'scaffold or a forked starter, not a fat hidden template), and the hosted ' +
    'runs built the FOUNDATION the PLAN described into it (auth/design/infra ' +
    'came from the plan, not a silent boilerplate). Transfer-to-the-user’s-' +
    'GitHub (9.3.7) is offered on request but not required.\n' +
    '- **Orchestration, not reimplementation.** Confirm WF4 DRIVES the 7.15 ' +
    'wizard + the 9.3 provision/scaffold + the 9.1 hosted runs over their ' +
    'existing surfaces — it contains no new wizard, no new scaffold engine, no ' +
    'new run container; the only new logic is the fresh-plan → provision → ' +
    'hosted-build sequencing.\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 9.4.3’s e2e drives the ' +
    'whole WF4 path over the seeded tenant + the stubbed planner + a stub ' +
    'scaffold/provision + a fake hosted agent (no live model / GitHub / ' +
    'container in CI).\n' +
    '- **Open-core boundary review.** WF4 adds NO new table; the provision/' +
    'scaffold/run + the metering live where 9.3 / 9.1 put them (motir-ai / the ' +
    'orchestrator); the planning rides the 7.1 boundary (no `motir-ai` import ' +
    'in motir-core; browsers never call motir-ai or the container).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '9.4.1',
      title:
        'Manual — end-to-end test of WF4 (fresh: AI plans incl. foundation 7.15 → provision Motir repo + scaffold 9.3 → hosted build 9.1 → review)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** manual/human (no PR — a HUMAN walks the whole WF4 path end ' +
        'to end and confirms it works; marked done on Yue’s confirmation, the ' +
        '1.6.7 manual-card shape). This is the end-to-end MANUAL TEST of the ' +
        'first hosted workflow — a real person, not a coding agent, drives the ' +
        'composed flow from a user’s seat and judges that the COMBINATION (a ' +
        'fresh plan + a provisioned/scaffolded Motir-owned repo + a hosted ' +
        'build) actually produces a built foundation in a repo the user never ' +
        'had to touch. Wired via `dependsOn` to the capabilities it exercises ' +
        'so the prerequisite is visible at PLAN time (notes.html #30); it ' +
        'cannot run until they land.\n\n' +
        '**Walk the full WF4 path (hosted execution, fresh):**\n\n' +
        '1. **Fresh plan (7.15)** — start a brand-new project in the HOSTED ' +
        'execution mode. Walk the fresh wizard: name → discovery (PIN a stack, ' +
        'e.g. Next.js + Prisma + Postgres) → establish the coding convention ' +
        'from that stack → generate the plan → review + approve. Confirm the ' +
        'plan INCLUDES the foundation (auth/design/infra are plan content — not ' +
        'assumed to be a silent template).\n' +
        '2. **Provision + scaffold the Motir-owned repo (9.3)** — on approve, ' +
        'confirm Motir CREATES a Motir-owned repo under Motir’s GitHub org and ' +
        'SCAFFOLDS it: the per-stack one-line scaffold for the pinned stack ' +
        '(`create-next-app` / …), OR a forked starter if the library has one ' +
        'matching the stack (else the scaffold). Confirm you (the user) did NOT ' +
        'have to create or connect a GitHub repo.\n' +
        '3. **Hosted build (9.1)** — dispatch the ready items into HOSTED runs. ' +
        'Confirm each run provisions a container, builds the planned foundation ' +
        'INTO the scaffolded repo, and opens a PR (the “dispatch a ticket, get ' +
        'a PR back” payoff), gateway-metered against your credits.\n' +
        '4. **Review** — review/merge the PRs. Optionally exercise the ' +
        'transfer-to-your-GitHub handoff (9.3.7) and confirm it is OFFERED but ' +
        'not required.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A human completes the entire WF4 path (fresh plan incl. foundation → ' +
        'provision + scaffold a Motir-owned repo → hosted build into it → ' +
        'review) and confirms each step works.\n' +
        '- The hosted-default holds by eye: the repo is MOTIR-OWNED (the user ' +
        'never touched GitHub), it was SCAFFOLDED (scaffold-then-build — a real ' +
        'one-line scaffold or a forked starter, not a fat hidden template), and ' +
        'the hosted runs built the FOUNDATION the plan described.\n' +
        '- The hosted runs open PRs against the Motir-owned repo and are ' +
        'metered against the shared credits (the 9.1 posture).\n' +
        '- Any rough edge in the COMBINATION (a missing scaffold step, a ' +
        'mis-sequenced provision-before-plan, a confusing hand-off) is filed as ' +
        'a follow-up Subtask under this Story, not silently fixed.\n' +
        '- Yue confirms the WF4 path is sound; Motir marks the subtask done (no ' +
        'PR).\n\n' +
        '## Context refs\n\n' +
        '- 7.15 — the start-fresh onboarding wizard this drives (name → ' +
        'discovery → establish-convention → generate → approve, incl. the ' +
        'foundation as plan content).\n' +
        '- 9.3 — the hosted execution layer this exercises: 9.3.4 (repo ' +
        'provision + per-stack scaffold), 9.3.5 (fork a matching starter), ' +
        '9.3.7 (the GitHub transfer handoff); 9.3.3 — the org/scope/scaffold-' +
        'runner provisioning it needs.\n' +
        '- 9.1 — the hosted agent run (dispatch → container → build → PR → ' +
        'review) the build rides.\n' +
        '- 9.4.2 — the WF4 sequencing glue this manual test exercises.\n' +
        '- This module header — the orchestrate-don’t-reimplement framing + the ' +
        'scaffold-then-build default that is WF4’s substance.',
      dependsOn: ['7.15.2', '9.3.4'],
    },
    {
      id: '9.4.2',
      title:
        'WF4 orchestration glue — fresh planning (7.15) → hosted provisioning/scaffold (9.3.4) → hosted build (9.1)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The orchestration glue that makes WF4 a single coherent flow — and ' +
        'the one genuinely new capability the COMBINATION needs: sequencing the ' +
        'FRESH PLAN → hosted PROVISION/SCAFFOLD → hosted BUILD where 7.15 alone ' +
        'ends at a BYOK “ready to dispatch” that assumes a repo + a local agent ' +
        'a fresh hosted project does not have. This card COMPOSES shipped ' +
        'pieces (the 7.15 fresh wizard, the 9.3 provision/scaffold, the 9.1 ' +
        'hosted run) and adds the sequencing; it reimplements none of them. ' +
        '4-layer (Route→Service→Repository→Prisma, `motir-core/CLAUDE.md`).\n\n' +
        '**1. Carry the fresh plan to an APPROVED state (7.15, unchanged).** ' +
        'The 7.15 onboarding orchestration (7.15.2) runs the fresh path (name → ' +
        'discovery → establish-convention-from-stack → generate → ' +
        'review/approve). WF4 sets the project’s EXECUTION MODE to hosted (a ' +
        'project attribute, so the dispatch exit targets hosted runs rather ' +
        'than the BYOK ready-set), and reads the PINNED STACK from the ' +
        'discovery doc (the same stack 7.15.3 derives the convention from) — it ' +
        'is the input to the scaffold choice.\n\n' +
        '**2. On approve: PROVISION + SCAFFOLD the Motir-owned repo (9.3.4 / ' +
        '9.3.5) — the scaffold-then-build default.** When the fresh plan is ' +
        'approved (and the project has no repo yet — it is fresh), the ' +
        'orchestration calls 9.3.4 to CREATE a Motir-owned repo under Motir’s ' +
        'org and run the per-stack one-line SCAFFOLD for the pinned stack; if ' +
        '9.3.5’s starter library has a starter MATCHING the stack, FORK it ' +
        'instead (else fall back to the scaffold). It does NOT re-build the ' +
        'provision/scaffold/starter logic — it calls 9.3 over its existing ' +
        'API/the 9.3 client. The repo is Motir-owned by default (the user may ' +
        'never touch GitHub — the 9.3.2 decision); transfer is 9.3.7, ' +
        'on-request, not part of this flow.\n\n' +
        '**3. Dispatch the ready items into 9.1 HOSTED RUNS that build into the ' +
        'scaffolded repo.** With the repo provisioned + scaffolded, the ready ' +
        'items (the approved foundation backlog) are dispatched as 9.1 hosted ' +
        'runs whose target repo is the Motir-owned one — each run builds the ' +
        'planned foundation into it and opens a PR (the 9.1 lifecycle, ' +
        'gateway-metered). WF4 sets the dispatch TARGET (hosted) + the repo; it ' +
        'does NOT re-implement the 9.1 container/run/metering.\n\n' +
        '**4. Orchestration, not a new engine.** The plan persists via 7.15 / ' +
        '7.3.4 (human-approved → `workItemsService`); the repo/scaffold is ' +
        '9.3.4’s; the build + PR + metering is 9.1’s. This card adds the ' +
        'SEQUENCING (fresh-plan → provision/scaffold → hosted-build) + the ' +
        'execution-mode + repo wiring. Routes call ONE service method; the ' +
        'service owns the orchestration; no `motir-ai` import (planning rides ' +
        'the 7.1.5 client; the provision/run ride the 9.3/9.1 clients); no raw ' +
        'Prisma in a route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The WF4 flow runs the 7.15 fresh path to an approved plan with the ' +
        'project’s EXECUTION MODE = hosted, reading the pinned stack from the ' +
        'discovery doc — no re-implemented discovery / generation / convention ' +
        'engine.\n' +
        '- On approve (fresh project, no repo yet), the orchestration ' +
        'PROVISIONS a Motir-owned repo + SCAFFOLDS it via 9.3.4 (or forks a ' +
        'matching starter via 9.3.5, else scaffold) for the pinned stack — ' +
        'calling 9.3, not re-building it; the repo is Motir-owned (transfer is ' +
        '9.3.7, on-request, not here).\n' +
        '- The ready items are dispatched into 9.1 HOSTED runs targeting the ' +
        'scaffolded Motir-owned repo (build → PR → metered) — WF4 sets the ' +
        'target/repo; it does not re-implement the run.\n' +
        '- No new write path / store: the plan persists via 7.15/7.3.4 ' +
        '(human-approved → `workItemsService`); the repo/scaffold is 9.3.4’s; ' +
        'the run is 9.1’s.\n' +
        '- 4-layer respected; routes call one service method; no `motir-ai` ' +
        'import; no forward dep introduced.\n\n' +
        '## Context refs\n\n' +
        '- 7.15.2 — the fresh onboarding state machine this drives to an ' +
        'approved plan (+ 7.15.3 — the pinned-stack-from-discovery this reads ' +
        'for the scaffold choice).\n' +
        '- 9.3.4 — the repo PROVISION + per-stack SCAFFOLD this calls on ' +
        'approve; 9.3.5 — the starter LIBRARY fork-if-matched; 9.3.2 — the ' +
        'Motir-owned-repo + scaffold-then-build decision inherited; 9.3.7 — the ' +
        'transfer handoff (on-request, not in this flow).\n' +
        '- 9.1 (9.1.7) — the hosted-run orchestration the ready items dispatch ' +
        'into (target=hosted + the Motir-owned repo); 7.6.3 — the dispatch ' +
        'payload contract the hosted target rides.\n' +
        '- 7.3.4 — the generate→approve→persist the plan rides; 7.1.5 — the ' +
        'core→ai client.\n' +
        '- This module header — the fresh-plan → provision/scaffold → ' +
        'hosted-build sequencing that is WF4’s substance.',
      dependsOn: ['7.15.2', '9.3.4'],
    },
    {
      id: '9.4.3',
      title:
        'Playwright E2E — WF4 end to end (fresh plan → provision+scaffold Motir repo → hosted build → review)',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'The automated end-to-end test of WF4 ' +
        '(`tests/e2e/wf4-hosted-fresh.spec.ts`) over the seeded ' +
        '`moooon`/`motir` tenant — closes the WF4 promise from a user’s seat ' +
        'and LOCKS the fresh-plan → provision/scaffold → hosted-build sequence ' +
        'against regression. Because a real repo-provision + a real scaffold + ' +
        'a real hosted container in CI are impractical, the spec drives the UI ' +
        'and simulates the externals deterministically: the fresh planning ' +
        'backed by the recorded discovery/generate fixtures (the 7.15.6 ' +
        'pattern), the provision/scaffold by a STUB 9.3 provisioner (a fake ' +
        'repo + a recorded scaffold result), and the hosted build by a FAKE ' +
        'hosted agent over the 9.1 run harness (the 9.1.9 pattern — a fake ' +
        'agent that edits a file + opens a stub PR, no real LLM/container) — so ' +
        'the test asserts the WF4 LOOP + the scaffold-then-build sequencing, ' +
        'not model quality or live infra.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` via the existing `signIn` helper; ' +
        'start a brand-new project in the HOSTED execution mode. Walk the 7.15 ' +
        'fresh wizard (name → discovery pinning a stack → establish convention ' +
        '→ generate → approve), asserting the plan includes foundation items.\n' +
        '2. **Provision + scaffold:** on approve, assert the STUB provisioner ' +
        'was called to create a Motir-owned repo + run the per-stack scaffold ' +
        '(or fork a matching starter) for the pinned stack — and that the user ' +
        'was NOT asked to connect a GitHub repo.\n' +
        '3. **Hosted build:** dispatch a ready foundation item into a hosted ' +
        'run; assert the run targets the scaffolded Motir-owned repo, the fake ' +
        'agent builds + opens a (stub) PR, and the run is metered (the 9.1 ' +
        'lifecycle).\n' +
        '4. **Review:** assert the PR link surfaces on the run + the item moves ' +
        'to its review state.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e wf4-hosted-fresh` passes locally + in CI, backed by ' +
        'the recorded planning fixtures + the stub 9.3 provisioner + the fake ' +
        '9.1 hosted agent (no live model / GitHub / container).\n' +
        '- The spec asserts the SEQUENCE: a Motir-owned repo is provisioned + ' +
        'scaffolded on approve (the user never connects a repo), and the hosted ' +
        'run targets THAT repo and opens a PR — the scaffold-then-build flow ' +
        'fired in order.\n' +
        '- It reuses the existing `signIn` helper + the 7.15.6 fresh-wizard ' +
        'fixtures + the 9.1.9 fake-agent/stub-PR pattern — no new auth / ' +
        'provision / run plumbing invented.\n' +
        '- Not flake-prone: explicit waits on the discovery/generate ' +
        '`aria-live` regions, the provision/scaffold completion, and the ' +
        'hosted-run lifecycle stepper (no fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 9.4.2 — the WF4 orchestration sequence under test.\n' +
        '- 7.15.6 — the fresh-onboarding E2E (name → discovery → generate → ' +
        'approve) patterns + recorded fixtures this composes with.\n' +
        '- 9.3.9 — the provision/scaffold/starter-fork test patterns + the stub ' +
        'provisioner; 9.1.9 — the fake-agent / stub-PR hosted-run test pattern ' +
        'this reuses.\n' +
        '- `motir-core/tests/e2e/` — the `signIn` helper + the established ' +
        'aria-live waiting patterns to mirror.',
      dependsOn: ['9.4.2'],
    },
  ],
};
