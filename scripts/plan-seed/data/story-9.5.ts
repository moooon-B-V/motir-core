import type { PlanStory } from '../types';

/**
 * Story 9.5 — WF5: Hosted + existing codebase. The SECOND hosted-execution
 * workflow, the middle of the HOSTED row of Yue's 6-workflow matrix (WF4 fresh
 * = 9.4, **WF5 +code = this story**, WF6 +code&import = 9.6). WF5 is the hosted
 * twin of 7.16: a team that ALREADY has a codebase on GitHub is onboarded —
 * connect + index + audit/convention + code-aware plan, exactly as WF2 — but
 * the build is executed by a MOTIR-OPERATED hosted sandbox (9.1) instead of the
 * user's own BYOK agent.
 *
 * **This is a THIN orchestration+verification story — it COMPOSES, it does not
 * REIMPLEMENT.** Every heavy piece WF5 sequences is owned elsewhere; 9.5 adds
 * only the glue the COMBINATION needs plus the end-to-end verification (a human
 * manual-test pass + an automated e2e). The two capabilities it composes:
 *   - **7.16** — the migrate-existing-codebase onboarding wizard (connect →
 *     index → audit+convention approve → discovery → code-aware generate →
 *     approve). WF5 reuses the WHOLE codebase onboarding, code-aware-plan-and-all.
 *   - **9.1** — the hosted agent container + run lifecycle (dispatch → provision
 *     a container-per-run → agent builds → PR → review), gateway-metered. WF5's
 *     execution column IS a 9.1 hosted run — but against an EXISTING repo, not a
 *     fresh-scaffolded one (the WF4 distinction).
 *
 * **The gap the `code` subtask fills (a REAL decision to settle): WHOSE REPO
 * does the hosted agent build in — the user's CONNECTED repo, or a Motir-owned
 * one?** WF4 (fresh) is easy: there is no repo, so 9.3 provisions a Motir-owned
 * one and scaffolds it. WF5 is NOT: the team CONNECTED a real GitHub repo in the
 * 7.16 step (the App is installed on THEIR repo; the code graph is indexed from
 * it). So when a hosted run builds, where do its commits + PR land? Two
 * candidate shapes, and WF5 must SETTLE this (it is the substance of 9.5.2):
 *   - **(A) Build in the user's CONNECTED repo.** The hosted run targets the
 *     repo the 7.16 connect installed the App on; the agent commits to a branch
 *     + opens a PR THERE (the user reviews/merges in their own repo). This is
 *     the natural "you already have a repo; we just run the agent in the cloud
 *     against it" shape — and it matches the BYOK WF2 except the agent is
 *     Motir's hosted one. The 7.7 installation token (already granted at
 *     connect) is the write credential; the 9.1 run-scoped token authors the PR
 *     as the user.
 *   - **(B) Build in a Motir-owned FORK/mirror, transfer/PR-upstream on
 *     request.** Motir forks the connected repo into its org, the hosted run
 *     builds in the fork (the WF4 hosted-repo posture), and PRs are opened
 *     upstream to the user's repo (or the fork is transferred via 9.3.7).
 * The DEFAULT WF5 settles on is **(A) — build in the user's connected repo** (a
 * team that already owns a repo expects the build to land there; forking adds a
 * confusing second repo with no benefit when the user already controls the
 * origin). The Motir-owned-repo posture is for the FRESH case (WF4) where the
 * user has no repo. 9.5.2 wires the hosted run to target the connected repo with
 * the 7.7 installation token as the write path, and NAMES (B) as the documented
 * alternative for the rare "user won't grant write / wants isolation" case
 * (handled by the 9.3.7 transfer machinery, not re-built here). Settling this —
 * and wiring the connected-repo build target — is what 9.5.2 delivers; nothing
 * else in WF5 is new.
 *
 * **The sequence (Workflow 5 — hosted execution, existing codebase):**
 *   1–4. **Connect → index → audit+convention approve → discovery** — the 7.16
 *        wizard steps, unchanged (the App is installed on the user's repo; the
 *        code graph is indexed from it; the convention gate holds).
 *   5.   **Code-aware generate** — the 7.16.4 code-aware plan (the first plan
 *        reads the existing code), unchanged.
 *   6.   **Review/approve** — the 7.3 review/approve; persist via
 *        `workItemsService`.
 *   …then **hosted build into the CONNECTED repo** — dispatch the ready items
 *   into 9.1 hosted runs whose target repo is the user's connected repo (the
 *   settled default), building + opening PRs there.
 *
 * **Mirror (the hosted-build-against-an-existing-repo shape — cite the 7.16 /
 * 9.1 mirrors, lightly verified; WF5 composes pieces already mirror-checked by
 * their owners).** The codebase-onboarding half mirrors CodeRabbit's
 * connect-your-repo + Cursor's index-progress gate (verified on 7.16). The
 * hosted-build half mirrors Devin / Google Jules / OpenAI Codex cloud / GitHub
 * Copilot coding agent — all of which run AGAINST AN EXISTING connected repo and
 * open a PR back to IT (Jules: clones the repo, "pushes to a branch and opens a
 * pull request"; Copilot coding agent: a PR in the same repo) — which is exactly
 * the WF5 default (A) of building in the user's connected repo. WF5 is the stitch
 * of the 7.16 onboarding and that build-in-the-connected-repo hosted run.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward-pointing deps.**
 * Every `dependsOn` id's story number is ≤ 9.5: 7.16.2 (the migrate onboarding
 * orchestration WF5 reuses — Epic 7, backward), 9.3.4 (the hosted execution
 * layer — provisioning/handoff machinery WF5 references for the alternative (B)
 * fork/transfer path; 9.3 < 9.5, backward), and same-story 9.5.x. 9.1 (the
 * hosted run) + 7.7.3 (the installation token used as the connected-repo write
 * path) are referenced in prose and are ≤ 9.5 (backward). All backward/sideways.
 * Statuses follow the rule: EVERY subtask depends on a not-yet-done upstream
 * (7.16.2 / 9.3.4 unbuilt), so NONE is `planned` — all three are `blocked`; the
 * STORY is `planned`.
 *
 * **No design subtask (deliberate).** WF5 introduces no genuinely new combined
 * surface — it reuses the 7.16 migrate-wizard shell + the 9.1 hosted-run
 * surface. The build-target choice (A connected-repo default) surfaces as the
 * EXISTING 9.1 run-target attribute, not a net-new screen. Per the
 * workflows-brief ("NO new design subtask unless a genuinely new combined
 * surface exists"), 9.5 carries no `design` card; a net-new combined affordance,
 * if review reveals one, is a NEW `design/` subtask, not improvised UI.
 */
export const story_9_5: PlanStory = {
  id: '9.5',
  title: 'WF5 — Hosted + existing codebase (orchestration + verification)',
  status: 'planned',
  gitBranch: 'feat/PROD-9.5-wf5-hosted-codebase',
  descriptionMd:
    'The SECOND hosted-execution workflow — **existing codebase, built in ' +
    'Motir’s cloud** — the middle of the HOSTED row of the 6-workflow matrix ' +
    '(WF4 fresh = 9.4, **WF5 +code = this**, WF6 +code&import = 9.6). WF5 is ' +
    'the hosted twin of 7.16: a team that already has a codebase on GitHub is ' +
    'onboarded (connect → index → audit+convention → code-aware plan, exactly ' +
    'as WF2) but the build is executed by a MOTIR-OPERATED hosted sandbox (9.1) ' +
    'instead of the user’s own BYOK agent.\n\n' +
    'This is a **THIN orchestration + verification story**: it COMPOSES shipped ' +
    'capabilities — the 7.16 migrate wizard (connect → index → audit+convention ' +
    '→ discovery → code-aware generate → approve) and the 9.1 hosted agent run ' +
    '(dispatch → container → build → PR → review) — and adds ONLY the glue the ' +
    'COMBINATION needs plus the end-to-end test. It reimplements neither.\n\n' +
    '**The gap the code subtask fills (a REAL decision to settle): WHOSE REPO ' +
    'does the hosted agent build in?** WF4 (fresh) is easy — no repo exists, so ' +
    '9.3 provisions a Motir-owned one and scaffolds it. WF5 is NOT: the team ' +
    'CONNECTED a real GitHub repo in the 7.16 step (the App is on THEIR repo; ' +
    'the code graph indexed from it). So where do a hosted run’s commits + PR ' +
    'land? **WF5 settles on building in the user’s CONNECTED repo** (a team ' +
    'that already owns a repo expects the build to land there; the App’s 7.7 ' +
    'installation token is the write path, the 9.1 run-scoped token authors the ' +
    'PR as the user). A Motir-owned FORK + PR-upstream / transfer (9.3.7) is ' +
    'NAMED as the documented alternative for the rare “no write grant / wants ' +
    'isolation” case — not re-built here. The Motir-owned-repo posture is for ' +
    'the FRESH case (WF4).\n\n' +
    '**The sequence (hosted, existing codebase):** the 7.16 connect → index → ' +
    'audit+convention approve → discovery → code-aware generate → ' +
    'review/approve (persist via `workItemsService`) → hosted build into the ' +
    'CONNECTED repo (dispatch ready items into 9.1 hosted runs targeting the ' +
    'user’s repo, building + opening PRs there).\n\n' +
    '**Scope:** the end-to-end MANUAL test of WF5 (9.5.1, human); the WF5 ' +
    'orchestration glue — sequence the 7.16 codebase onboarding → hosted build ' +
    '(9.1), and SETTLE + wire whose repo the hosted agent builds in (the ' +
    'connected user repo, default; Motir-owned fork as the named alternative) ' +
    '(9.5.2); the automated e2e of WF5 (9.5.3).\n\n' +
    '**Out of scope (owned by their stories, not here):** the migrate ' +
    'onboarding wizard (7.16 — WF5 drives it); the hosted agent container + run ' +
    'lifecycle + gateway metering (9.1 — WF5 dispatches into it); the repo-' +
    'provision/scaffold/starter-library/transfer engine (9.3 — WF5 uses only ' +
    'its transfer machinery for the alternative path, and only for the FRESH ' +
    'case is its scaffold relevant); the import workflows (WF3 = 7.18, WF6 = ' +
    '9.6); and the BYOK workflows (Epic 7).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services (motir-core on `:3000`, ' +
    'motir-ai on its dev port, each pointed at the other), with the 7.7 GitHub ' +
    'App provisioned + a test repo to connect, and the hosted-run infra ' +
    'reachable (9.1.3).\n' +
    '- **WF5 end to end (the story).** Sign in as `zhuyue@motir.co`; start a ' +
    'new **existing-codebase** project in the HOSTED execution mode. Walk the ' +
    '7.16 wizard: connect the test repo → wait on the index gate → review + ' +
    'APPROVE the proposed convention (the gate) → light discovery → trigger the ' +
    'CODE-AWARE generate (the plan reads the existing code) → review + approve. ' +
    'Then dispatch the ready items into HOSTED runs (9.1).\n' +
    '- **Whose repo (the load-bearing assertion).** Confirm the hosted runs ' +
    'build in the USER’S CONNECTED repo (the settled default): the commits + ' +
    'the PR land in the repo the 7.16 connect installed the App on (NOT a ' +
    'surprise Motir-owned fork), the PR is authored AS the dispatching user, ' +
    'and the App’s installation token is the write path. (If you exercise the ' +
    'named alternative — a Motir-owned fork + PR-upstream / transfer — confirm ' +
    'it is OPT-IN, via the 9.3.7 machinery, not the default.)\n' +
    '- **Orchestration, not reimplementation.** Confirm WF5 DRIVES the 7.16 ' +
    'wizard + the 9.1 hosted runs over their existing surfaces — it contains no ' +
    'new wizard, no new run container; the only new logic is the onboarding → ' +
    'hosted-build sequencing + the build-target (connected-repo) wiring.\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 9.5.3’s e2e drives the ' +
    'whole WF5 path over the seeded tenant + the stubbed connect/index/planner ' +
    '+ a fake hosted agent targeting the connected repo (no live model / GitHub ' +
    '/ container in CI).\n' +
    '- **Open-core boundary review.** WF5 adds NO new table; the run + metering ' +
    'live where 9.1 put them; the code graph + convention in motir-ai; the ' +
    'planning rides the 7.1 boundary (no `motir-ai` import in motir-core; ' +
    'browsers never call motir-ai or the container).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '9.5.1',
      title:
        'Manual — end-to-end test of WF5 (connect+index+audit/convention 7.16 → code-aware plan → hosted build 9.1; repo is Motir-owned OR the user’s connected repo)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** manual/human (no PR — a HUMAN walks the whole WF5 path end ' +
        'to end and confirms it works; marked done on Yue’s confirmation, the ' +
        '1.6.7 manual-card shape). This is the end-to-end MANUAL TEST of the ' +
        'second hosted workflow — a real person, not a coding agent, drives the ' +
        'composed flow from a user’s seat and judges that the COMBINATION (a ' +
        'codebase onboarding + a hosted build) produces a built result IN THE ' +
        'RIGHT REPO. Wired via `dependsOn` to the capabilities it exercises so ' +
        'the prerequisite is visible at PLAN time (notes.html #30); it cannot ' +
        'run until they land.\n\n' +
        '**Walk the full WF5 path (hosted execution, existing codebase):**\n\n' +
        '1. **Connect + index (7.16)** — start a new existing-codebase project ' +
        'in the HOSTED execution mode; connect the test repo (the App installs ' +
        'on YOUR repo) and wait on the index-progress gate (the code graph ' +
        'builds from your repo). Confirm you cannot proceed until the index is ' +
        'ready.\n' +
        '2. **Audit + convention approve (the 7.16 gate)** — review the audit ' +
        'report + the proposed convention and APPROVE it. Confirm generation is ' +
        'blocked until you approve.\n' +
        '3. **Light discovery + code-aware generate** — run the short discovery ' +
        'pass, then trigger generation; confirm the plan is CODE-AWARE (it ' +
        'reflects the existing code, not a blank slate).\n' +
        '4. **Review + approve** — approve the generated tree; the backlog ' +
        'persists.\n' +
        '5. **Hosted build — WHOSE REPO (the judgment call this test exists ' +
        'for)** — dispatch the ready items into HOSTED runs (9.1). Confirm the ' +
        'runs build in the USER’S CONNECTED repo (the settled default): the ' +
        'commits + PR land in the repo you connected (NOT a surprise ' +
        'Motir-owned fork), the PR is authored AS you, and the build is ' +
        'gateway-metered against your credits. If you exercise the named ' +
        'alternative (a Motir-owned fork + PR-upstream / transfer), confirm it ' +
        'is OPT-IN, not the default.\n' +
        '6. **Review** — review/merge the PRs in the connected repo.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A human completes the entire WF5 path (connect → index → approve ' +
        'convention → code-aware generate → approve → hosted build → review) ' +
        'against a real connected repo and confirms each step works.\n' +
        '- The build-target is confirmed by eye: the hosted runs build in the ' +
        'USER’S CONNECTED repo (commits + PR land there, authored as the user), ' +
        'NOT a surprise Motir-owned fork — the settled default holds; any ' +
        'fork/transfer alternative is opt-in.\n' +
        '- The hosted runs open PRs against the connected repo and are metered ' +
        'against the shared credits (the 9.1 posture).\n' +
        '- Any rough edge in the COMBINATION (a build landing in the wrong ' +
        'repo, a missing write grant, a confusing target) is filed as a ' +
        'follow-up Subtask under this Story, not silently fixed.\n' +
        '- Yue confirms the WF5 path is sound; Motir marks the subtask done (no ' +
        'PR).\n\n' +
        '## Context refs\n\n' +
        '- 7.16 — the migrate-existing-codebase wizard this drives (connect → ' +
        'index → audit+convention → discovery → code-aware generate → ' +
        'approve).\n' +
        '- 9.1 — the hosted agent run (dispatch → container → build → PR → ' +
        'review) the build rides; 7.7.3 — the installation token used as the ' +
        'connected-repo write path.\n' +
        '- 9.3.7 — the fork/transfer machinery the named alternative (B) reuses ' +
        '(opt-in, not the default).\n' +
        '- 9.5.2 — the WF5 sequencing + build-target glue this manual test ' +
        'exercises.\n' +
        '- This module header — the orchestrate-don’t-reimplement framing + the ' +
        'whose-repo decision that is WF5’s substance.',
      dependsOn: ['7.16.2', '9.3.4'],
    },
    {
      id: '9.5.2',
      title:
        'WF5 orchestration glue — sequence the 7.16 codebase onboarding → hosted build (9.1), and SETTLE + wire whose repo the hosted agent builds in (connected user repo vs Motir-owned)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The orchestration glue that makes WF5 a single coherent flow — and ' +
        'the one genuinely new decision the COMBINATION forces: SETTLING (and ' +
        'wiring) WHOSE REPO the hosted agent builds in. This card COMPOSES ' +
        'shipped pieces (the 7.16 migrate wizard, the 9.1 hosted run) and adds ' +
        'the sequencing + the build-target resolution; it reimplements neither. ' +
        '4-layer (Route→Service→Repository→Prisma, `motir-core/CLAUDE.md`).\n\n' +
        '**1. Carry the codebase onboarding to an APPROVED code-aware plan ' +
        '(7.16, unchanged).** The 7.16 onboarding orchestration (7.16.2) runs ' +
        'the existing-codebase path (connect → index → audit+convention approve ' +
        '→ discovery → code-aware generate → review/approve). WF5 sets the ' +
        'project’s EXECUTION MODE to hosted (so the dispatch exit targets ' +
        'hosted runs rather than the BYOK ready-set).\n\n' +
        '**2. SETTLE the build target (the substance): build in the user’s ' +
        'CONNECTED repo (default).** Unlike WF4 (fresh — no repo, so 9.3 ' +
        'provisions a Motir-owned one and scaffolds it), WF5 already has a ' +
        'CONNECTED repo (the 7.16 connect installed the App on it; the code ' +
        'graph indexed from it). The settled default: the hosted run targets ' +
        'THAT connected repo — the agent commits to a branch + opens a PR ' +
        'THERE. The write path is the 7.7 installation token (already granted ' +
        'at connect), and the 9.1 run-scoped token authors the PR AS the ' +
        'dispatching user. Rationale (record it in the decision/PR): a team ' +
        'that already owns a repo expects the build to land there; forking adds ' +
        'a confusing second repo with no benefit when the user controls the ' +
        'origin. **The named ALTERNATIVE (not the default, not re-built here):** ' +
        'a Motir-owned FORK/mirror + PR-upstream or transfer (the 9.3 ' +
        'hosted-repo + 9.3.7 transfer machinery), for the rare “user won’t ' +
        'grant write / wants isolation” case — WF5 exposes it as an OPT-IN ' +
        'build-target choice that reuses 9.3.7; it does not re-implement ' +
        'forking.\n\n' +
        '**3. Dispatch the ready items into 9.1 HOSTED RUNS targeting the ' +
        'resolved repo.** With the plan approved + the build target resolved ' +
        '(connected repo, default), the ready items are dispatched as 9.1 ' +
        'hosted runs whose target repo is the connected one — each builds + ' +
        'opens a PR there (the 9.1 lifecycle, gateway-metered). WF5 sets the ' +
        'dispatch TARGET (hosted) + the repo (connected); it does NOT ' +
        're-implement the 9.1 container/run/metering or the 7.7 connect.\n\n' +
        '**4. Orchestration, not a new engine.** The plan persists via 7.16 / ' +
        '7.3.4 (human-approved → `workItemsService`); the build + PR + metering ' +
        'is 9.1’s; the connect + the installation token is 7.7’s; the ' +
        'fork/transfer alternative is 9.3.7’s. This card adds the SEQUENCING ' +
        '(onboarding → hosted-build) + the build-target RESOLUTION + the ' +
        'execution-mode wiring. Routes call ONE service method; the service ' +
        'owns the orchestration; no `motir-ai` import; no raw Prisma in a ' +
        'route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The WF5 flow runs the 7.16 existing-codebase path to an approved ' +
        'CODE-AWARE plan with the project’s EXECUTION MODE = hosted — no ' +
        're-implemented connect / index / audit / generation engine.\n' +
        '- The build target is SETTLED + wired: the default is the user’s ' +
        'CONNECTED repo (the 7.7 installation token as the write path, the 9.1 ' +
        'run-scoped token authoring the PR as the user); the Motir-owned ' +
        'fork/transfer (9.3.7) is exposed as an OPT-IN alternative, not the ' +
        'default, and is NOT re-implemented.\n' +
        '- The ready items dispatch into 9.1 HOSTED runs targeting the resolved ' +
        '(connected) repo — build → PR there → metered — WF5 sets the ' +
        'target/repo; it does not re-implement the run.\n' +
        '- No new write path / store: the plan persists via 7.16/7.3.4 ' +
        '(human-approved → `workItemsService`); the build is 9.1’s; the repo ' +
        'write is the 7.7 installation token.\n' +
        '- 4-layer respected; routes call one service method; no `motir-ai` ' +
        'import; no forward dep introduced.\n\n' +
        '## Context refs\n\n' +
        '- 7.16.2 — the existing-codebase onboarding state machine this drives ' +
        'to an approved code-aware plan.\n' +
        '- 9.1 (9.1.7) — the hosted-run orchestration the ready items dispatch ' +
        'into (target=hosted + the connected repo); 7.6.3 — the dispatch ' +
        'payload contract the hosted target rides.\n' +
        '- 7.7.3 — the GitHub App installation (the connected repo + the ' +
        'installation token used as the build write path).\n' +
        '- 9.3.4 / 9.3.7 — the hosted-repo + transfer machinery the named ' +
        'fork/PR-upstream alternative reuses (opt-in; the Motir-owned-repo ' +
        'posture is the FRESH/WF4 default, not WF5’s).\n' +
        '- 7.3.4 — the generate→approve→persist the plan rides; 7.1.5 — the ' +
        'core→ai client.\n' +
        '- 9.4 (WF4) — the sibling fresh-hosted flow (Motir-owned scaffolded ' +
        'repo) this contrasts with; this story is the existing-repo case.\n' +
        '- This module header — the whose-repo decision (build in the connected ' +
        'repo, default) that is WF5’s substance.',
      dependsOn: ['7.16.2', '9.3.4'],
    },
    {
      id: '9.5.3',
      title:
        'Playwright E2E — WF5 end to end (connect+index → code-aware plan → hosted build in the connected repo → review)',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'The automated end-to-end test of WF5 ' +
        '(`tests/e2e/wf5-hosted-codebase.spec.ts`) over the seeded ' +
        '`moooon`/`motir` tenant — closes the WF5 promise from a user’s seat ' +
        'and LOCKS the build-target decision (build in the connected repo) ' +
        'against regression. Because a real GitHub App install + a real ' +
        'code-graph index + a real hosted container in CI are impractical, the ' +
        'spec drives the UI and simulates the externals deterministically: the ' +
        'connect via the stubbed-GitHub path (the 7.7.9 signed-`installation`-' +
        'webhook fixture), the index backed by the local codegraph FIXTURE ' +
        '(7.5.4), the planner by recorded fixtures (7.16.7 / 7.3.7), and the ' +
        'hosted build by a FAKE hosted agent over the 9.1 run harness (the ' +
        '9.1.9 pattern — a fake agent that edits a file + opens a stub PR, no ' +
        'real LLM/container) — so the test asserts the WF5 LOOP + the build ' +
        'target, not model quality or live infra.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` via the existing `signIn` helper; ' +
        'start a new existing-codebase project in the HOSTED execution mode. ' +
        'Complete the stubbed connect (a signed `installation` fixture ' +
        'selecting a test repo) + wait on the index gate.\n' +
        '2. **Convention:** approve the proposed convention (the 7.16 gate).\n' +
        '3. **Code-aware generate:** trigger generation; assert the “reading ' +
        'your codebase” state, then the proposed tree (reflecting the fixture ' +
        'code); approve.\n' +
        '4. **Hosted build (the load-bearing assertion):** dispatch a ready ' +
        'item into a hosted run; assert the run TARGETS THE CONNECTED repo (the ' +
        'one the connect fixture selected — NOT a Motir-owned fork), the fake ' +
        'agent builds + opens a (stub) PR in that repo authored as the user, ' +
        'and the run is metered (the 9.1 lifecycle).\n' +
        '5. **Review:** assert the PR link surfaces on the run + the item moves ' +
        'to its review state.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e wf5-hosted-codebase` passes locally + in CI, backed ' +
        'by the stubbed connect + the codegraph fixture + recorded planner ' +
        'fixtures + the fake 9.1 hosted agent (no live model / GitHub / ' +
        'container).\n' +
        '- The spec asserts the BUILD TARGET: the hosted run targets the ' +
        'CONNECTED repo (the settled default) and opens a PR there as the user ' +
        '— NOT a Motir-owned fork; the fork/transfer path, if exercised, is ' +
        'opt-in.\n' +
        '- It reuses the existing `signIn` helper + the 7.7.9 webhook stub + ' +
        'the 7.5.4 fixture + the 7.16.7/7.3.7 planner patterns + the 9.1.9 ' +
        'fake-agent/stub-PR pattern — no new auth / GitHub / run plumbing ' +
        'invented.\n' +
        '- Not flake-prone: explicit waits on the index-progress + the planner ' +
        '`aria-live` regions and the hosted-run lifecycle stepper (no fixed ' +
        'sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 9.5.2 — the WF5 orchestration + build-target resolution under ' +
        'test.\n' +
        '- 7.16.7 — the migrate-onboarding E2E (connect/index/convention/code-' +
        'aware-generate) patterns this composes with; 9.1.9 — the ' +
        'fake-agent/stub-PR hosted-run test pattern this reuses.\n' +
        '- 7.7.9 — the signed-`installation`-webhook stub; 7.5.4 — the ' +
        'codegraph fixture; 7.3.7 — the generate E2E stub pattern.\n' +
        '- `motir-core/tests/e2e/` — the `signIn` helper + the established ' +
        'aria-live waiting patterns to mirror.',
      dependsOn: ['9.5.2'],
    },
  ],
};
