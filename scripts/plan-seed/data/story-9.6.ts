import type { SeedStory } from '../types';

/**
 * Story 9.6 — WF6: Hosted + existing codebase + Jira/Linear import. The SIXTH
 * and final workflow, closing Yue's 6-workflow matrix (3 starting states × 2
 * execution modes). It is the FULL combination: an existing codebase AND an
 * existing Jira/Linear/GitHub backlog AND hosted execution. WF6 is to WF5 (9.5,
 * hosted + codebase) what WF3 (7.18) is to WF2 (7.16) — the same flow plus an
 * issue import and the reconciliation it forces; and it is the HOSTED twin of
 * WF3 (the BYOK +code&import workflow). It therefore inherits BOTH the WF3
 * reconciliation concern AND the WF5 whose-repo concern — and adds nothing new
 * beyond composing them.
 *
 * **This is a THIN orchestration+verification story — it COMPOSES, it does not
 * REIMPLEMENT.** Every heavy piece WF6 sequences is owned elsewhere; 9.6 adds
 * only the glue the COMBINATION needs plus the end-to-end verification (a human
 * manual-test pass + an automated e2e). The three capabilities it composes:
 *   - **7.16** — the migrate-existing-codebase onboarding wizard (connect →
 *     index → audit+convention approve → discovery → code-aware generate →
 *     approve).
 *   - **7.17** — the issue importer (Jira/Linear/GitHub Issues/CSV → Motir work
 *     items, idempotent + dry-run).
 *   - **9.1** — the hosted agent container + run lifecycle (dispatch → container
 *     → build → PR → review), gateway-metered.
 * …and it reuses the two GAP-FILLERS its siblings already settled:
 *   - **7.18.2** — the WF3 reconciliation glue (de-dupe imported backlog vs the
 *     code-derived plan). WF6's planning half IS WF3's, so the same reconciling
 *     augment applies.
 *   - **9.5.2** — the WF5 build-target resolution (build in the user's CONNECTED
 *     repo by default; Motir-owned fork as the opt-in alternative). WF6's
 *     execution half IS WF5's, so the same build target applies.
 *
 * **The gap the `code` subtask fills: COMPOSE the WF3 reconciliation and the WF5
 * build-target into one hosted+code+import flow.** WF6's substance is exactly
 * the union of its two siblings' substances — there is no THIRD new concern.
 * The code subtask (9.6.2) sequences: the 7.16 codebase onboarding + the 7.17
 * import (the WF3 ingredients), the 7.4 augment RECONCILING the imported backlog
 * with the code graph (de-dupe imported-vs-generated, reusing 7.18.2's
 * reconciliation), then dispatch into 9.1 HOSTED runs that build in the user's
 * CONNECTED repo (reusing 9.5.2's build-target decision). The only WF6-specific
 * work is wiring those two already-settled gap-fillers together in the hosted
 * existing-codebase+import path; it re-decides neither.
 *
 * **The sequence (Workflow 6 — hosted execution, existing codebase + import):**
 *   1–2. **Connect → index the codebase** — the 7.16 steps.
 *   3.   **Import the existing backlog** — the 7.17 importer (the WF3 step).
 *   4.   **Audit + convention approve** — the 7.16 gate.
 *   5.   **Code-aware augment that RECONCILES code + imported backlog** — the
 *        7.18.2 reconciling/de-dup augment.
 *   6.   **Review/approve** — the 7.3 review/approve; persist via
 *        `workItemsService`.
 *   …then **hosted build into the CONNECTED repo** — dispatch the reconciled
 *   ready items into 9.1 hosted runs targeting the user's connected repo (the
 *   9.5.2 default), building + opening PRs there.
 *
 * **Mirror (the full hosted+code+import shape — cite the 7.16 / 7.17 / 9.1
 * mirrors via its siblings, lightly verified; WF6 composes pieces already
 * mirror-checked).** The codebase-onboarding half mirrors CodeRabbit + Cursor
 * (verified on 7.16); the import half mirrors Plane's Jira importer + Linear's
 * importers (verified on 7.17); the hosted-build-against-a-connected-repo half
 * mirrors Devin / Jules / Codex cloud / Copilot coding agent building in the
 * connected repo + opening a PR (verified on 9.1/9.5). WF6 is the end-to-end
 * stitch of those three, with the reconciliation (7.18) and build-target (9.5)
 * decisions inherited.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward-pointing deps.**
 * Every `dependsOn` id's story number is ≤ 9.6: 7.16.2 (codebase onboarding —
 * Epic 7, backward), 7.17.5 (import mapping+persist — Epic 7, backward), 9.3.4
 * (the hosted execution layer; 9.3 < 9.6, backward), and same-story 9.6.x. The
 * sibling gap-fillers it reuses — 7.18.2 (WF3 reconciliation) and 9.5.2 (WF5
 * build-target) — are referenced in prose and are ≤ 9.6 (7.18 < 9.6; 9.5 < 9.6,
 * backward). 9.1 (the hosted run) + 7.7.3 (the connected-repo write path) are
 * referenced in prose and ≤ 9.6. All backward/sideways. Statuses follow the
 * rule: EVERY subtask depends on a not-yet-done upstream (7.16.2 / 7.17.5 /
 * 9.3.4 unbuilt), so NONE is `planned` — all three are `blocked`; the STORY is
 * `planned`.
 *
 * **No design subtask (deliberate).** WF6 introduces no genuinely new combined
 * surface — it reuses the 7.16 wizard shell + the 7.17 import wizard + the 9.1
 * hosted-run surface; the reconciliation surfaces in the EXISTING 7.3
 * review/approve diff and the build-target in the EXISTING 9.1 run-target
 * attribute (both already settled by 7.18 / 9.5). Per the workflows-brief ("NO
 * new design subtask unless a genuinely new combined surface exists"), 9.6
 * carries no `design` card; a net-new combined affordance, if review reveals
 * one, is a NEW `design/` subtask, not improvised UI.
 */
export const story_9_6: SeedStory = {
  id: '9.6',
  title: 'WF6 — Hosted + existing codebase + Jira/Linear import (orchestration + verification)',
  status: 'planned',
  gitBranch: 'feat/PROD-9.6-wf6-hosted-codebase-import',
  descriptionMd:
    'The SIXTH and final workflow, closing the 6-workflow matrix — the FULL ' +
    'combination of **existing codebase + an existing Jira/Linear/GitHub ' +
    'backlog + hosted execution**. WF6 is to WF5 (9.5, hosted + codebase) what ' +
    'WF3 (7.18) is to WF2 (7.16): the same flow plus an issue import and the ' +
    'reconciliation it forces — and it is the HOSTED twin of WF3. It therefore ' +
    'inherits BOTH the WF3 reconciliation concern AND the WF5 whose-repo ' +
    'concern, and adds nothing beyond composing them.\n\n' +
    'This is a **THIN orchestration + verification story**: it COMPOSES shipped ' +
    'capabilities — the 7.16 migrate wizard, the 7.17 issue importer, the 9.1 ' +
    'hosted agent run — AND reuses the two gap-fillers its siblings already ' +
    'settled: **7.18.2** (the WF3 de-dupe of imported backlog vs the code-' +
    'derived plan) and **9.5.2** (the WF5 build-target: build in the user’s ' +
    'CONNECTED repo by default). It adds ONLY the glue that wires those into the ' +
    'hosted existing-codebase+import path plus the end-to-end test; it ' +
    'reimplements and re-decides none of them.\n\n' +
    '**The gap the code subtask fills: COMPOSE the WF3 reconciliation and the ' +
    'WF5 build-target into one hosted+code+import flow.** WF6’s substance is ' +
    'the union of its two siblings’ — there is no THIRD new concern. The glue ' +
    'sequences: 7.16 codebase onboarding + 7.17 import (the WF3 ingredients) → ' +
    'the 7.4 augment RECONCILING imported backlog with the code graph (de-dupe, ' +
    'reusing 7.18.2) → dispatch into 9.1 HOSTED runs building in the user’s ' +
    'CONNECTED repo (reusing 9.5.2). The only WF6-specific work is wiring those ' +
    'two settled gap-fillers together in the hosted code+import path.\n\n' +
    '**The sequence (hosted, existing codebase + import):** the 7.16 connect → ' +
    'index → IMPORT the existing backlog (7.17) → audit + approve the ' +
    'convention (the 7.16 gate) → code-aware augment that RECONCILES code + ' +
    'imported backlog (de-dupe, 7.18.2) → review/approve (persist via ' +
    '`workItemsService`) → hosted build into the CONNECTED repo (dispatch the ' +
    'reconciled ready items into 9.1 hosted runs targeting the user’s repo, ' +
    '9.5.2, building + opening PRs there).\n\n' +
    '**Scope:** the end-to-end MANUAL test of WF6 (9.6.1, human); the WF6 ' +
    'orchestration glue — sequence codebase onboarding (7.16) + import (7.17) + ' +
    'the reconciling augment (7.18.2) → hosted build in the connected repo ' +
    '(9.1, 9.5.2) (9.6.2); the automated e2e of WF6 (9.6.3).\n\n' +
    '**Out of scope (owned by their stories, not here):** the migrate wizard ' +
    '(7.16); the issue importer + connectors/mapping/idempotency/dry-run + its ' +
    'wizard (7.17); the WF3 reconciliation engine itself (7.18.2 — WF6 reuses ' +
    'it, does not re-decide de-dupe); the WF5 build-target decision itself ' +
    '(9.5.2 — WF6 reuses the connected-repo default); the hosted agent ' +
    'container + run lifecycle + gateway metering (9.1); the repo-provision/' +
    'scaffold/transfer engine (9.3 — only the transfer machinery, for the ' +
    'opt-in fork alternative); and the OTHER five workflows.',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services (motir-core on `:3000`, ' +
    'motir-ai on its dev port, each pointed at the other), with the 7.7 GitHub ' +
    'App provisioned + a test repo to connect, the 7.17 import sources ' +
    'provisioned (7.17.7), and the hosted-run infra reachable (9.1.3).\n' +
    '- **WF6 end to end (the story).** Sign in as `zhuyue@motir.co`; start a ' +
    'new **existing-codebase** project in the HOSTED execution mode. Walk: ' +
    '(1–2) connect + index the repo (7.16); (3) run the IMPORT step (7.17) and ' +
    'confirm the existing tickets land as work items; (4) approve the proposed ' +
    'convention (the 7.16 gate); (5) trigger the code-aware augment and confirm ' +
    'the proposed tree RECONCILES — imported-vs-generated overlap is de-duped ' +
    '(the imported ticket wins; the planner adds only the code-implied gaps, ' +
    'the 7.18.2 reconciliation); (6) review + approve → the reconciled backlog ' +
    'persists. Then dispatch the reconciled ready items into HOSTED runs ' +
    '(9.1).\n' +
    '- **Both inherited decisions hold (the load-bearing assertions).** ' +
    '(a) RECONCILE: a backlog with an imported ticket + an overlapping ' +
    'generated candidate ends up with ONE item (the imported one), not two; a ' +
    're-run does not re-double (7.18.2). (b) WHOSE REPO: the hosted runs build ' +
    'in the USER’S CONNECTED repo (commits + PR land there, authored as the ' +
    'user — NOT a surprise Motir-owned fork), the 9.5.2 default; any fork/' +
    'transfer alternative is opt-in.\n' +
    '- **Orchestration, not reimplementation.** Confirm WF6 DRIVES the 7.16 ' +
    'wizard + the 7.17 importer + the 7.18.2 reconciling augment + the 9.1 ' +
    'hosted runs over their existing surfaces — it contains no new wizard, ' +
    'connector, generation engine, or run container, and it does not re-decide ' +
    'de-dupe or the build target; the only new logic is wiring the two settled ' +
    'gap-fillers into the hosted code+import path.\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 9.6.3’s e2e drives the ' +
    'whole WF6 path over the seeded tenant + the stubbed connect/index/import/' +
    'planner + a fake hosted agent targeting the connected repo (no live model ' +
    '/ GitHub / import source / container in CI); both the de-dup and the ' +
    'build-target are asserted.\n' +
    '- **Open-core boundary review.** WF6 adds NO new table; the import model + ' +
    'external-id map, the code graph + convention, the run + metering all live ' +
    'where their owning stories put them; the augment rides the 7.1 boundary ' +
    '(no `motir-ai` import in motir-core; browsers never call motir-ai or the ' +
    'container).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '9.6.1',
      title:
        'Manual — end-to-end test of WF6 (connect+index 7.16 → import issues 7.17 → audit/convention → code-aware plan reconciling code+imported backlog → hosted build 9.1)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 55,
      descriptionMd:
        '**Type:** manual/human (no PR — a HUMAN walks the whole WF6 path end ' +
        'to end and confirms it works; marked done on Yue’s confirmation, the ' +
        '1.6.7 manual-card shape). This is the end-to-end MANUAL TEST of the ' +
        'sixth and most complete workflow — a real person, not a coding agent, ' +
        'drives the composed flow from a user’s seat and judges that the FULL ' +
        'COMBINATION (a codebase onboarding + an issue import + a reconciling ' +
        'augment + a hosted build) produces a sane, de-duped backlog built into ' +
        'the right repo. Wired via `dependsOn` to the capabilities it exercises ' +
        'so the prerequisite is visible at PLAN time (notes.html #30); it ' +
        'cannot run until they land.\n\n' +
        '**Walk the full WF6 path (hosted execution, existing codebase + ' +
        'import):**\n\n' +
        '1. **Connect + index (7.16)** — start a new existing-codebase project ' +
        'in the HOSTED execution mode; connect the test repo (the App installs ' +
        'on YOUR repo) and wait on the index-progress gate.\n' +
        '2. **Import the existing backlog (7.17)** — run the importer against a ' +
        'REAL source you control (Jira export / Linear / GitHub Issues / CSV): ' +
        'connect → map → dry-run → run. Confirm the tickets land as correctly-' +
        'mapped work items, and a re-run does not duplicate them.\n' +
        '3. **Audit + convention approve (the 7.16 gate)** — review + APPROVE ' +
        'the proposed convention; confirm generation is blocked until you ' +
        'approve.\n' +
        '4. **Code-aware augment that RECONCILES (judgment call #1)** — trigger ' +
        'the code-aware augment; inspect the proposed tree and confirm it ' +
        'RECONCILES the imported backlog with the code: an imported ticket ' +
        'overlapping generated work appears ONCE (the imported one), and the ' +
        'planner adds only the code-implied GAPS the import did not cover — NOT ' +
        'a doubled tree (the 7.18.2 reconciliation).\n' +
        '5. **Review + approve** — approve the reconciled tree; the backlog ' +
        'persists.\n' +
        '6. **Hosted build — WHOSE REPO (judgment call #2)** — dispatch the ' +
        'reconciled ready items into HOSTED runs (9.1). Confirm the runs build ' +
        'in the USER’S CONNECTED repo (the 9.5.2 default): commits + PR land in ' +
        'the repo you connected (NOT a surprise Motir-owned fork), authored as ' +
        'you, gateway-metered against your credits. Any fork/transfer ' +
        'alternative is opt-in.\n' +
        '7. **Review** — review/merge the PRs in the connected repo.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A human completes the entire WF6 path (connect → index → import → ' +
        'approve convention → reconciling augment → approve → hosted build → ' +
        'review) against a real connected repo + a real import source and ' +
        'confirms each step works.\n' +
        '- RECONCILE holds by eye: imported-vs-generated overlap is DE-DUPED ' +
        '(the imported ticket survives; the planner augments the gaps), the ' +
        'tree is reconciled not doubled, and a re-run does not re-double ' +
        '(7.18.2).\n' +
        '- WHOSE REPO holds by eye: the hosted runs build in the USER’S ' +
        'CONNECTED repo (commits + PR there, authored as the user — not a ' +
        'surprise fork), the 9.5.2 default; any fork/transfer is opt-in.\n' +
        '- Any rough edge in the FULL COMBINATION (a doubled item, a build in ' +
        'the wrong repo, a mis-sequenced step) is filed as a follow-up Subtask ' +
        'under this Story, not silently fixed.\n' +
        '- Yue confirms the WF6 path is sound; Motir marks the subtask done (no ' +
        'PR).\n\n' +
        '## Context refs\n\n' +
        '- 7.16 — the migrate wizard; 7.17 — the issue importer (+ 7.17.7, the ' +
        'source provisioning); 9.1 — the hosted agent run.\n' +
        '- 7.18.2 — the WF3 reconciliation/de-dup glue WF6 reuses for ' +
        'judgment-call #1; 9.5.2 — the WF5 build-target (connected-repo) ' +
        'decision WF6 reuses for judgment-call #2.\n' +
        '- 9.6.2 — the WF6 sequencing glue this manual test exercises.\n' +
        '- This module header — the orchestrate-don’t-reimplement framing + the ' +
        'union-of-WF3-and-WF5 substance that is WF6.',
      dependsOn: ['7.16.2', '7.17.5', '9.3.4'],
    },
    {
      id: '9.6.2',
      title:
        'WF6 orchestration glue — sequence codebase onboarding (7.16) + import (7.17) + the reconciling augment (7.18.2) → hosted build in the connected repo (9.1, 9.5.2)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The orchestration glue that makes WF6 a single coherent flow by ' +
        'COMPOSING the two gap-fillers its siblings already settled — the WF3 ' +
        'reconciliation (7.18.2) and the WF5 build-target (9.5.2) — into one ' +
        'hosted existing-codebase+import path. WF6 has no THIRD new concern: its ' +
        'substance is exactly the union of WF3’s and WF5’s. This card COMPOSES ' +
        'shipped pieces (the 7.16 wizard, the 7.17 importer, the 7.4 augment, ' +
        'the 9.1 hosted run) + reuses 7.18.2 + 9.5.2; it reimplements and ' +
        're-decides none of them. 4-layer ' +
        '(Route→Service→Repository→Prisma, `motir-core/CLAUDE.md`).\n\n' +
        '**1. Codebase onboarding + import + reconciling augment (the WF3 half, ' +
        'reusing 7.18.2).** Run the 7.16 existing-codebase onboarding (connect → ' +
        'index → audit+convention approve → discovery) with the project’s ' +
        'EXECUTION MODE set to hosted, run the 7.17 import step (ingest the ' +
        'existing backlog, idempotent + dry-run), then run the code-aware ' +
        'augment that RECONCILES the imported backlog with the code graph — ' +
        'de-duping imported-vs-generated, the imported ticket as the system of ' +
        'record, the planner augmenting only the code-implied gaps. This is ' +
        'EXACTLY the 7.18.2 reconciliation; WF6 REUSES it (it does not re-decide ' +
        'or re-implement de-dupe — it invokes the same reconciling-augment ' +
        'path). The reconciled delta is human-approved → persisted via ' +
        '`workItemsService` (7.3.4).\n\n' +
        '**2. Hosted build in the connected repo (the WF5 half, reusing ' +
        '9.5.2).** Dispatch the reconciled ready items into 9.1 HOSTED runs ' +
        'whose target repo is the user’s CONNECTED repo (the 9.5.2 settled ' +
        'default — a team that already owns a repo expects the build to land ' +
        'there; the 7.7 installation token is the write path, the 9.1 ' +
        'run-scoped token authors the PR as the user). The Motir-owned fork + ' +
        'PR-upstream/transfer (9.3.7) remains the OPT-IN alternative 9.5.2 ' +
        'named. WF6 REUSES the 9.5.2 build-target resolution; it does not ' +
        're-decide whose repo.\n\n' +
        '**3. Orchestration, not new engines or new decisions.** The import ' +
        'persists via 7.17.5; the augment + reconciliation is 7.18.2’s; the ' +
        'build target is 9.5.2’s; the build + PR + metering is 9.1’s; the ' +
        'connect + installation token is 7.7’s. This card adds the SEQUENCING ' +
        'that strings them in order for the hosted code+import path + the ' +
        'execution-mode/build-target wiring. Routes call ONE service method; ' +
        'the service owns the orchestration; no `motir-ai` import (the augment ' +
        'rides the 7.1.5 client); no raw Prisma in a route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The WF6 flow runs the 7.16 existing-codebase onboarding + the 7.17 ' +
        'import + the 7.18.2 reconciling/de-dup augment with EXECUTION MODE = ' +
        'hosted — reusing 7.18.2 (no re-decided/re-implemented de-dupe), no ' +
        're-implemented wizard/connector/generation engine.\n' +
        '- RECONCILE holds: imported-vs-generated overlap is de-duped (imported ' +
        'wins; planner augments only the gaps), the reviewed delta is ' +
        'reconciled not doubled, and a re-run does not re-double (7.18.2 ' +
        'reused).\n' +
        '- The reconciled ready items dispatch into 9.1 HOSTED runs targeting ' +
        'the user’s CONNECTED repo (the 9.5.2 default — 7.7 installation token ' +
        'write path, PR authored as the user); the fork/transfer (9.3.7) is the ' +
        'opt-in alternative — WF6 reuses 9.5.2, it does not re-decide whose ' +
        'repo.\n' +
        '- No new write path / store / decision: import via 7.17.5, augment via ' +
        '7.3.4 + 7.18.2, build via 9.1 + 9.5.2; WF6 only sequences.\n' +
        '- 4-layer respected; routes call one service method; no `motir-ai` ' +
        'import; no forward dep introduced.\n\n' +
        '## Context refs\n\n' +
        '- 7.16.2 — the existing-codebase onboarding state machine; 7.17.5 — ' +
        'the import mapping+persist; 7.18.2 — the WF3 reconciling/de-dup augment ' +
        'this REUSES; 9.5.2 — the WF5 build-target (connected-repo) resolution ' +
        'this REUSES.\n' +
        '- 9.1 (9.1.7) — the hosted-run orchestration the reconciled ready ' +
        'items dispatch into (target=hosted + connected repo); 7.6.3 — the ' +
        'dispatch payload contract; 7.7.3 — the installation token write ' +
        'path.\n' +
        '- 7.4.2 / 7.4.4 — the no-duplicate placement + locked-context posture ' +
        'the reconciliation rides (via 7.18.2); 7.3.4 — the ' +
        'generate→approve→persist; 7.1.5 — the core→ai client.\n' +
        '- 9.3.7 — the fork/transfer machinery the opt-in build-target ' +
        'alternative reuses (via 9.5.2).\n' +
        '- This module header — the union-of-WF3-and-WF5 substance that is ' +
        'WF6’s glue.',
      dependsOn: ['7.16.2', '7.17.5', '9.3.4'],
    },
    {
      id: '9.6.3',
      title:
        'Playwright E2E — WF6 end to end (connect+index → import → reconciling augment → hosted build in the connected repo → review)',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The automated end-to-end test of WF6 ' +
        '(`tests/e2e/wf6-hosted-codebase-import.spec.ts`) over the seeded ' +
        '`moooon`/`motir` tenant — closes the WF6 promise from a user’s seat ' +
        'and LOCKS BOTH inherited decisions (the 7.18.2 de-dup and the 9.5.2 ' +
        'connected-repo build target) against regression. Because a real GitHub ' +
        'App install + a real code-graph index + a live import source + a real ' +
        'hosted container in CI are impractical, the spec drives the UI and ' +
        'simulates the externals deterministically: the connect via the ' +
        'stubbed-GitHub path (the 7.7.9 signed-`installation`-webhook fixture), ' +
        'the index backed by the local codegraph FIXTURE (7.5.4), the IMPORT by ' +
        'a recorded fixture source (the 7.17.9 / 7.18.3 pattern), the augment by ' +
        'recorded planner fixtures (7.3.7 / 7.4.9), and the hosted build by a ' +
        'FAKE hosted agent over the 9.1 run harness (the 9.1.9 / 9.5.3 pattern — ' +
        'a fake agent that edits a file + opens a stub PR) — so the test asserts ' +
        'the WF6 LOOP + both decisions, not model quality or live infra.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` via the existing `signIn` helper; ' +
        'start a new existing-codebase project in the HOSTED execution mode. ' +
        'Complete the stubbed connect (a signed `installation` fixture ' +
        'selecting a test repo) + wait on the index gate.\n' +
        '2. **Import:** run the import step against the fixture source; assert ' +
        'the tickets land as mapped work items, and a re-run does not duplicate ' +
        'them.\n' +
        '3. **Convention:** approve the proposed convention (the 7.16 gate).\n' +
        '4. **Reconciling augment (assertion #1):** trigger the code-aware ' +
        'augment over a fixture where an imported ticket OVERLAPS a generated ' +
        'candidate + a code-implied GAP exists. Assert the proposed tree ' +
        'contains the imported ticket ONCE (not doubled) AND the gap item — the ' +
        '7.18.2 reconciliation fired; approve.\n' +
        '5. **Hosted build (assertion #2):** dispatch a reconciled ready item ' +
        'into a hosted run; assert the run TARGETS THE CONNECTED repo (the ' +
        'connect fixture’s repo — NOT a Motir-owned fork), the fake agent ' +
        'builds + opens a (stub) PR there authored as the user, and the run is ' +
        'metered.\n' +
        '6. **Review:** assert the PR link surfaces on the run + the item moves ' +
        'to its review state.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e wf6-hosted-codebase-import` passes locally + in CI, ' +
        'backed by the stubbed connect + the codegraph fixture + a recorded ' +
        'import source + recorded planner fixtures + the fake 9.1 hosted agent ' +
        '(no live model / GitHub / import source / container).\n' +
        '- Assertion #1 (DE-DUP): an imported-vs-generated overlap resolves to ' +
        'ONE item (the imported one) + a code-implied gap is added (7.18.2); a ' +
        're-run does not re-double.\n' +
        '- Assertion #2 (BUILD TARGET): the hosted run targets the CONNECTED ' +
        'repo (the 9.5.2 default) and opens a PR there as the user — NOT a ' +
        'Motir-owned fork; any fork/transfer is opt-in.\n' +
        '- It reuses the existing `signIn` helper + the 7.7.9 webhook stub + ' +
        'the 7.5.4 fixture + the 7.17.9/7.18.3 import + the 7.3.7/7.4.9 planner ' +
        '+ the 9.1.9/9.5.3 fake-agent patterns — no new auth / GitHub / import ' +
        '/ run plumbing invented.\n' +
        '- Not flake-prone: explicit waits on the index-progress + import + ' +
        'augment `aria-live` regions and the hosted-run lifecycle stepper (no ' +
        'fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 9.6.2 — the WF6 orchestration under test (composing 7.18.2 + ' +
        '9.5.2).\n' +
        '- 7.18.3 — the WF3 e2e (connect/index/import/reconciling-augment) this ' +
        'composes with; 9.5.3 — the WF5 e2e (hosted build in the connected ' +
        'repo) this composes with.\n' +
        '- 7.16.7 / 7.17.9 — the onboarding + import E2E patterns; 7.3.7 / ' +
        '7.4.9 — the generate/augment stub patterns; 9.1.9 — the ' +
        'fake-agent/stub-PR hosted-run pattern.\n' +
        '- `motir-core/tests/e2e/` — the `signIn` helper + the established ' +
        'aria-live waiting patterns to mirror.',
      dependsOn: ['9.6.2'],
    },
  ],
};
