import type { SeedStory } from '../types';

/**
 * Story 7.18 — WF3: BYOK + existing codebase + Jira/Linear import. The THIRD
 * BYOK onboarding workflow, completing the BYOK row of Yue's 6-workflow matrix
 * (3 starting states × 2 execution modes): WF1 start-fresh = 7.15 ✓, WF2
 * existing-codebase = 7.16 ✓, **WF3 existing-codebase + import = this story**.
 * Where WF2 onboards a team that has a CODEBASE but no issue tracker, WF3
 * onboards a team that has BOTH a codebase AND a backlog already living in
 * Jira / Linear / GitHub Issues — they want Motir to plan over their existing
 * code AND ingest their existing tickets, not start from a blank backlog.
 *
 * **This is a THIN orchestration+verification story — it COMPOSES, it does not
 * REIMPLEMENT.** Every heavy piece WF3 sequences is OWNED elsewhere and shipped
 * by another story; 7.18 adds exactly the GLUE the COMBINATION needs plus the
 * end-to-end verification (a human manual-test pass + an automated e2e). The
 * two capabilities it composes:
 *   - **7.16** — the migrate-existing-codebase onboarding wizard (connect →
 *     index → audit+convention approve → discovery → code-aware generate →
 *     approve). WF3 IS WF2 plus an import; it reuses 7.16's whole wizard.
 *   - **7.17** — the issue importer (Jira / Linear / GitHub Issues / CSV →
 *     Motir work items, via a connect → map → dry-run → run wizard with an
 *     idempotent external-id map). WF3 runs the import as a step ALONGSIDE the
 *     codebase onboarding.
 *
 * **The one genuinely new thing WF3 needs (the gap the `code` subtask fills):
 * RECONCILIATION of the imported backlog WITH the code graph.** WF2's
 * code-aware generation (7.16.4) augments a backlog from the code; WF3 also has
 * an IMPORTED backlog (7.17) describing intended/in-flight work. Run naively,
 * the two collide: the planner's augmentation (7.4) would re-generate stories
 * the import already brought in (a "build login" ticket imported from Jira AND
 * a "build login" story the planner proposes from reading the auth-less code).
 * So WF3's glue sequences the 7.16 onboarding + the 7.17 import, then ensures
 * the 7.4 augment pass RECONCILES the imported backlog against the code graph —
 * DE-DUPING imported-vs-generated work (the imported ticket wins as the system
 * of record; the planner augments the GAPS the import didn't cover, grounded in
 * the code) rather than producing a doubled tree. This de-dup reconciliation is
 * the substance of 7.18.2; nothing else in WF3 is new.
 *
 * **The sequence (Workflow 3 — BYOK execution).**
 *   1–2. **Connect + index the codebase** — the 7.16 wizard's connect (7.7.3)
 *        + index (7.7.5 → 7.5.4) steps, unchanged.
 *   3.   **Import the existing backlog** — run the 7.17 importer (Jira / Linear
 *        / GitHub Issues / CSV → work items, mapped + idempotent + dry-run-
 *        previewed) so the team's existing tickets land as Motir work items
 *        BEFORE planning augments them.
 *   4.   **Audit + convention approve** — the 7.16 gate (convention-before-
 *        generation), unchanged.
 *   5.   **Code-aware augment that RECONCILES code + imported backlog** — the
 *        7.4 augment/7.16.4 code-aware pass, now de-duping the imported tree
 *        against what the planner would generate from the code (the new glue).
 *   6.   **Review/approve** — the standard 7.3 review/approve; on approve the
 *        reconciled tree persists via `workItemsService`.
 *   …then **BYOK dispatch** — the 7.6 ready set / `motir auto` exit (this is
 *   the BYOK column; hosted execution is the Epic-9 WF4/5/6 row).
 *
 * **Locked Epic-7 architecture it inherits (full prose in story-7.1.ts).**
 * One-directional writes — WF3 never writes the tree itself; the import persists
 * through `workItemsService` (7.17.5) and the augment persists via 7.3.4's
 * generate→approve→persist; reconciliation is a planning concern resolved BEFORE
 * the human approve, not a second write path. STATEFUL motir-ai holds the code
 * graph + direction docs + convention; the import model + external-id map (7.17)
 * and the onboarding-session progress (7.16) are the only new persistence, both
 * already owned by their stories — 7.18 adds NO new table.
 *
 * **Mirror (the import-into-an-existing-project shape — cite the 7.17/7.16
 * mirrors, lightly verified; WF3 composes pieces already mirror-checked by their
 * owning stories).** The importer half mirrors Plane's Jira importer + Linear's
 * Jira/GitHub/Asana/CSV importers (multi-step: connect → map → review/confirm-
 * before-write — verified on 7.17). The codebase-onboarding half mirrors
 * CodeRabbit's connect-your-repo + Cursor's index-progress gate (verified on
 * 7.16). The genuinely WF3-specific concern — reconciling an imported backlog
 * with a code-derived plan — is the same de-dup posture Jira-import tools take
 * when re-running an import (the external-id map prevents dupes); 7.18 extends
 * that no-dupe posture across the import↔generation seam, not just import re-run.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward-pointing deps.**
 * Every `dependsOn` id's story number is ≤ 7.18: 7.16.2 (the migrate wizard
 * orchestration WF3 reuses), 7.17.5 (the import mapping+persist WF3 runs +
 * reconciles), and same-story 7.18.x. All backward/sideways. Statuses follow the
 * rule: EVERY subtask depends on a not-yet-done upstream (7.16.2 / 7.17.5 are
 * unbuilt), so NONE is `planned` — all three are `blocked`; the STORY is
 * `planned`.
 *
 * **No design subtask (deliberate).** WF3 introduces no genuinely new combined
 * surface — it reuses the 7.16 wizard shell + the 7.17 import wizard. The
 * reconciliation surfaces inside the EXISTING 7.3 review/approve diff (an
 * imported-vs-generated node is a node in that tree). So per the workflows-brief
 * ("NO new design subtask unless a genuinely new combined surface exists"), 7.18
 * carries no `design` card; if review reveals the reconciliation needs its own
 * affordance, that is a NEW `design/` subtask, not improvised UI.
 */
export const story_7_18: SeedStory = {
  id: '7.18',
  title: 'WF3 — BYOK + existing codebase + Jira/Linear import (orchestration + verification)',
  status: 'planned',
  gitBranch: 'feat/PROD-7.18-wf3-byok-codebase-import',
  descriptionMd:
    'The THIRD BYOK onboarding workflow — **existing codebase + an existing ' +
    'Jira / Linear / GitHub Issues backlog**, completing the BYOK row of the ' +
    '6-workflow matrix (WF1 fresh = 7.15, WF2 existing-codebase = 7.16, **WF3 ' +
    '= this**). A team that already has BOTH a codebase on GitHub AND a tracker ' +
    'full of tickets is onboarded so Motir plans over the real code AND ingests ' +
    'the existing backlog, rather than starting blank.\n\n' +
    'This is a **THIN orchestration + verification story**: it COMPOSES shipped ' +
    'capabilities — the 7.16 migrate wizard (connect → index → audit+convention ' +
    '→ discovery → code-aware generate → approve) and the 7.17 issue importer ' +
    '(Jira/Linear/GitHub/CSV → work items, idempotent + dry-run) — and adds ' +
    'ONLY the glue the COMBINATION needs plus the end-to-end test. It ' +
    'reimplements neither the wizard nor the importer.\n\n' +
    '**The one genuinely new thing (the gap the code subtask fills): ' +
    'RECONCILE the imported backlog WITH the code graph.** WF3 has TWO sources ' +
    'of backlog — the IMPORTED tickets (7.17) and what the planner would ' +
    'GENERATE from reading the existing code (7.16.4 code-aware augment). Run ' +
    'naively they double up (an imported "build login" ticket AND a planner-' +
    'proposed "build login" story). So WF3 sequences onboarding + import, then ' +
    'makes the 7.4 augment pass DE-DUPE imported-vs-generated work (the imported ' +
    'ticket is the system of record; the planner augments only the GAPS the ' +
    'import did not cover, grounded in the code) — a reconciled tree, not a ' +
    'doubled one.\n\n' +
    '**The sequence (BYOK execution):** connect + index the codebase (7.16) → ' +
    'IMPORT the existing backlog (7.17) → audit + approve the convention (the ' +
    '7.16 gate) → code-aware augment that RECONCILES code + imported backlog ' +
    '(the new glue) → review/approve (persist via `workItemsService`) → BYOK ' +
    'dispatch (7.6 ready set / `motir auto`; hosted execution is the Epic-9 ' +
    'row).\n\n' +
    '**Scope:** the end-to-end MANUAL test of WF3 (7.18.1, human); the WF3 ' +
    'orchestration glue — sequence the 7.16 onboarding + the 7.17 import and ' +
    'make 7.4 augment RECONCILE/de-dupe imported-vs-generated against the code ' +
    'graph (7.18.2); the automated e2e of WF3 (7.18.3).\n\n' +
    '**Out of scope (owned by their stories, not here):** the migrate ' +
    'onboarding wizard itself (7.16 — WF3 drives it); the issue importer + its ' +
    'connectors / mapping / idempotency / dry-run + its wizard (7.17 — WF3 runs ' +
    'it); the generation / augment / two-graph engines (7.3 / 7.4 / 7.5.6 — WF3 ' +
    'invokes the augment, it does not build it); the BYOK dispatch surface (7.6 ' +
    '— the exit); and ALL hosted-execution workflows (WF4/5/6 = Epic 9, the ' +
    'other matrix row).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services (motir-core on `:3000`, ' +
    'motir-ai on its dev port, each pointed at the other), with the 7.7 GitHub ' +
    'App provisioned + a test repo to connect, and the 7.17 import sources ' +
    'provisioned (7.17.7 — a Jira export / a Linear workspace / a CSV to ' +
    'import).\n' +
    '- **WF3 end to end (the story).** Sign in as `zhuyue@motir.co`; start a ' +
    'new **existing-codebase** project and walk the wizard: (1–2) connect + ' +
    'index the repo (the 7.16 steps); (3) run the IMPORT step — connect a ' +
    'source (Jira/Linear/GitHub/CSV), map fields/statuses, dry-run preview, run ' +
    '— and confirm the existing tickets appear as Motir work items; (4) approve ' +
    'the proposed coding convention (the 7.16 gate); (5) trigger the code-aware ' +
    'augment and confirm the proposed tree RECONCILES — an imported ticket that ' +
    'overlaps generated work appears ONCE (the imported one), and the planner ' +
    'adds only the gaps the import did not cover, grounded in the code; (6) ' +
    'review + approve → the reconciled backlog persists; then the ready set / ' +
    'BYOK dispatch is reachable.\n' +
    '- **The de-dup holds (the load-bearing assertion).** A backlog that ' +
    'contained both an imported ticket and a clearly-overlapping generated ' +
    'candidate ends up with ONE item (the imported one survives as the system ' +
    'of record), NOT two — and re-running the import does not dupe (the 7.17 ' +
    'external-id map) nor re-double against the prior augment.\n' +
    '- **Orchestration, not reimplementation.** Confirm WF3 DRIVES the 7.16 ' +
    'wizard + the 7.17 importer + the 7.4 augment over their existing ' +
    'APIs/surfaces — it contains no new wizard, no new connector, no new ' +
    'generation engine; the only new logic is the reconciliation/de-dup pass.\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.18.3’s e2e drives the ' +
    'whole WF3 path over the seeded tenant + a fixture import + the stubbed ' +
    'planner; the reconciliation/de-dup is asserted.\n' +
    '- **Open-core boundary review.** WF3 adds NO new table; the import model + ' +
    'external-id map live where 7.17 put them, the code graph + convention in ' +
    'motir-ai; the augment runs over the 7.1 boundary (no `motir-ai` import in ' +
    'motir-core; browsers never call motir-ai).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '7.18.1',
      title:
        'Manual — end-to-end test of WF3 (connect+index 7.16 → import issues 7.17 → augment reconciling code + imported backlog → BYOK dispatch)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** manual/human (no PR — a HUMAN walks the whole WF3 path end ' +
        'to end and confirms it works; marked done on Yue’s confirmation, the ' +
        '1.6.7 manual-card shape). This is the end-to-end MANUAL TEST of the ' +
        'third BYOK workflow — a real person, not a coding agent, drives the ' +
        'composed flow from a user’s seat and judges that the COMBINATION (a ' +
        'codebase onboarding + an issue import + a reconciling augment) ' +
        'actually produces a sane, de-duped backlog ready to dispatch. It is ' +
        'wired via `dependsOn` to the two capabilities it exercises so the ' +
        'prerequisite is visible at PLAN time (notes.html #30); it cannot run ' +
        'until both land.\n\n' +
        '**Walk the full WF3 path (BYOK execution):**\n\n' +
        '1. **Connect + index the codebase** — start a new existing-codebase ' +
        'project; complete the 7.16 connect (GitHub App + repo selection) and ' +
        'wait on the index-progress gate (the code graph builds). Confirm you ' +
        'cannot proceed past indexing until the graph is ready.\n' +
        '2. **Import the existing backlog** — at the IMPORT step run the 7.17 ' +
        'importer against a REAL source you control (a Jira export / a Linear ' +
        'workspace / a GitHub Issues repo / a CSV): connect the source, map ' +
        'fields/statuses/users/labels, review the DRY-RUN preview, then run. ' +
        'Confirm the existing tickets land as Motir work items mapped ' +
        'correctly (kind/status/priority/assignee/labels/parent), and that ' +
        're-running the import does NOT duplicate them.\n' +
        '3. **Audit + convention approve** — review the audit report + the ' +
        'proposed coding convention and APPROVE it (the 7.16 gate). Confirm ' +
        'generation is blocked until you approve.\n' +
        '4. **Code-aware augment that RECONCILES** — trigger the code-aware ' +
        'augment. **The judgment call this manual test exists for:** inspect ' +
        'the proposed tree and confirm it RECONCILES the imported backlog with ' +
        'the code — an imported ticket that overlaps what the planner would ' +
        'generate appears ONCE (the imported one), and the planner adds only ' +
        'the GAPS the import did not cover, grounded in the existing code. It ' +
        'is NOT a doubled tree (imported + a parallel generated copy).\n' +
        '5. **Review + approve** — approve the reconciled tree; confirm the ' +
        'backlog persists and is parented per the grammar.\n' +
        '6. **BYOK dispatch** — confirm the ready set / `motir auto` exit is ' +
        'reachable for the reconciled backlog (this is the BYOK column; hosted ' +
        'execution is Epic 9).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A human completes the entire WF3 path (connect → index → import → ' +
        'approve convention → reconciling augment → approve → dispatch-ready) ' +
        'against a real codebase + a real import source, and confirms each step ' +
        'works.\n' +
        '- The imported backlog appears as correctly-mapped work items, and a ' +
        're-run of the import does not duplicate them (the 7.17 idempotency ' +
        'holds in practice).\n' +
        '- The reconciliation is confirmed by eye: imported-vs-generated ' +
        'overlap is DE-DUPED (the imported ticket survives; the planner ' +
        'augments the gaps) — the tree is reconciled, not doubled.\n' +
        '- Any rough edge in the COMBINATION (a doubled item, a mis-sequenced ' +
        'step, a confusing hand-off) is filed as a follow-up Subtask under this ' +
        'Story, not silently fixed.\n' +
        '- Yue confirms the WF3 path is sound; Motir marks the subtask done (no ' +
        'PR).\n\n' +
        '## Context refs\n\n' +
        '- 7.16 — the migrate-existing-codebase wizard this drives (connect → ' +
        'index → audit+convention → discovery → code-aware generate → ' +
        'approve).\n' +
        '- 7.17 — the issue importer this runs (Jira/Linear/GitHub/CSV → work ' +
        'items, idempotent + dry-run); 7.17.7 — the source OAuth/token ' +
        'provisioning the import needs.\n' +
        '- 7.18.2 — the WF3 reconciliation glue this manual test exercises.\n' +
        '- 7.4 — the augment pass the reconciliation rides; 7.6 — the BYOK ' +
        'dispatch exit.\n' +
        '- This module header — the orchestrate-don’t-reimplement framing + the ' +
        'de-dup reconciliation that is WF3’s substance.',
      dependsOn: ['7.16.2', '7.17.5'],
    },
    {
      id: '7.18.2',
      title:
        'WF3 orchestration glue — sequence the 7.16 codebase onboarding + the 7.17 import, and make 7.4 augment RECONCILE the imported backlog with the code graph (de-dupe imported vs generated)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The orchestration glue that makes WF3 a single coherent flow — and ' +
        'the one genuinely new capability the COMBINATION needs: ' +
        'RECONCILIATION of the imported backlog WITH the code graph. This card ' +
        'COMPOSES shipped pieces (the 7.16 wizard, the 7.17 importer, the 7.4 ' +
        'augment) and adds the de-dup logic the import↔generation seam ' +
        'requires; it reimplements none of them. 4-layer ' +
        '(Route→Service→Repository→Prisma, `motir-core/CLAUDE.md`).\n\n' +
        '**1. Sequence the onboarding + the import (an import STEP in the WF3 ' +
        'path).** Extend the 7.16 onboarding state machine (7.16.2) so the ' +
        'existing-codebase flow has an IMPORT step between index and the ' +
        'code-aware augment: after the code graph is ready (and as part of, or ' +
        'just before, the audit/convention step), the wizard can run the 7.17 ' +
        'importer for the project. The orchestration submits/awaits the 7.17 ' +
        'import (connect → map → dry-run → run) via the importer’s existing ' +
        'API; it does NOT re-build a connector or a mapping engine. The import ' +
        'is OPTIONAL within WF3 (a team may connect a codebase without a ' +
        'tracker — that is plain WF2) and IDEMPOTENT (it rides 7.17’s ' +
        'external-id map, so re-running the step does not dupe).\n\n' +
        '**2. RECONCILE on augment (the de-dup — the substance).** When the ' +
        'WF3 path reaches the code-aware augment (7.16.4 / 7.4), the imported ' +
        'work items ALREADY EXIST in the tree. The augment must therefore ' +
        'reconcile rather than re-generate: it runs over the EXISTING tree ' +
        '(including the imported items) + the code graph, and the planner ' +
        'AUGMENTS THE GAPS the import did not cover (work the code implies that ' +
        'no imported ticket describes) WITHOUT re-proposing an item that ' +
        'overlaps an imported one. Concretely: feed the imported items into the ' +
        '7.4 augment as IMMUTABLE context (the same locked-context posture ' +
        '7.4.4 re-plan uses for done work — the imported ticket is the system ' +
        'of record, it is not regenerated), and the augment’s no-duplicate ' +
        'placement (7.4.2, which already places new work WITHOUT duplicating ' +
        'using the skeleton + the 6.1.1 FilterAST search) now also matches ' +
        'against the imported tree. Where a generated candidate clearly ' +
        'overlaps an imported ticket (title/scope match via the search), the ' +
        'imported one WINS and the candidate is dropped/merged — the de-dup ' +
        'rule. The reconciled delta is what the human reviews (7.3 ' +
        'review/approve) and approves to persist via `workItemsService`.\n\n' +
        '**3. Orchestration, not a new write path.** The import persists ' +
        'through 7.17.5 (`workItemsService`); the augment persists through ' +
        '7.3.4’s generate→approve→persist. This card adds the SEQUENCING + the ' +
        'reconciliation INPUT (imported items as immutable context) + the ' +
        'de-dup matching — it owns no second write authority and no second ' +
        'store. The reconciliation runs BEFORE the human approve (it shapes the ' +
        'proposed delta), so the one-directional-write rule holds (the AI never ' +
        'writes the tree; the human approves the reconciled delta).\n\n' +
        '**API.** Thin additions to the 7.16 onboarding service: an ' +
        '`import`-step transition (drive the 7.17 import for the project) and ' +
        'the augment step passing the imported tree as reconciliation context. ' +
        'Routes call ONE service method; the service owns the orchestration; no ' +
        '`motir-ai` import (the augment goes through the 7.1.5 client); no raw ' +
        'Prisma in a route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The WF3 path runs the 7.17 import as a step within the 7.16 ' +
        'existing-codebase onboarding (between index and the code-aware ' +
        'augment), via the importer’s existing API — no re-implemented ' +
        'connector / mapping / dry-run.\n' +
        '- The code-aware augment RECONCILES: it runs over the existing tree ' +
        '(incl. imported items) + the code graph, feeds the imported items as ' +
        'IMMUTABLE context (7.4.4 locked-context posture), and AUGMENTS only ' +
        'the gaps the import did not cover (7.4.2 no-duplicate placement now ' +
        'matching the imported tree).\n' +
        '- DE-DUP holds: a generated candidate that clearly overlaps an ' +
        'imported ticket is dropped/merged (the imported one is the system of ' +
        'record) — the reviewed delta is reconciled, not doubled; a re-run of ' +
        'the import or the augment does not re-double (idempotent on the ' +
        'external-id map + the existing tree).\n' +
        '- No new write path / store: the import persists via 7.17.5, the ' +
        'augment via 7.3.4 (human-approved → `workItemsService`); ' +
        'reconciliation shapes the delta BEFORE approve.\n' +
        '- 4-layer respected; routes call one service method; no `motir-ai` ' +
        'import (the augment rides the 7.1.5 client); no forward dep ' +
        'introduced.\n\n' +
        '## Context refs\n\n' +
        '- 7.16.2 — the existing-codebase onboarding state machine this ' +
        'extends with the import step + the reconciling augment.\n' +
        '- 7.17.5 — the import mapping+persist (work items via ' +
        '`workItemsService`) WF3 runs and reconciles against; 7.17.3 — the ' +
        'external-id map that makes the import idempotent.\n' +
        '- 7.4.2 — the augment’s no-duplicate placement (skeleton + 6.1.1 ' +
        'FilterAST search) the de-dup extends to the imported tree; 7.4.4 — the ' +
        'locked/immutable-context posture the imported items are fed as.\n' +
        '- 7.16.4 — the code-aware generation/augment the reconciliation runs ' +
        'within; 7.3.4 — the generate→approve→persist the reconciled delta ' +
        'rides.\n' +
        '- 7.1.5 — the core→ai client the augment is submitted through.\n' +
        '- This module header — the de-dup reconciliation that is WF3’s ' +
        'substance.',
      dependsOn: ['7.16.2', '7.17.5'],
    },
    {
      id: '7.18.3',
      title:
        'Playwright E2E — WF3 end to end (connect+index → import → reconciling augment → approve)',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'The automated end-to-end test of WF3 ' +
        '(`tests/e2e/wf3-byok-codebase-import.spec.ts`) over the seeded ' +
        '`moooon`/`motir` tenant — closes the WF3 promise from a user’s seat ' +
        'and LOCKS the reconciliation/de-dup against regression. Because a real ' +
        'GitHub App install + a real code-graph index + a live import source in ' +
        'CI are impractical, the spec drives the wizard UI and simulates the ' +
        'externals deterministically: the connect step via the stubbed-GitHub ' +
        'path (the 7.7.9 signed-`installation`-webhook fixture), the index ' +
        'backed by the local codegraph FIXTURE (7.5.4), the IMPORT backed by a ' +
        'recorded fixture source (a Jira-export / CSV fixture — the 7.17.9 ' +
        'import-e2e pattern), and the augment by the recorded planner fixtures ' +
        '(7.3.7 / 7.4.9) — so the test asserts the WF3 LOOP + the de-dup, not ' +
        'model quality or live GitHub.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` via the existing `signIn` helper; ' +
        'start a new existing-codebase project. Complete the stubbed connect + ' +
        'wait on the index gate (the 7.16 steps).\n' +
        '2. **Import:** run the import step against the fixture source; assert ' +
        'the imported tickets appear as work items mapped correctly, and a ' +
        're-run does not duplicate them (the 7.17 external-id map).\n' +
        '3. **Convention:** approve the proposed convention (the 7.16 gate).\n' +
        '4. **Reconciling augment (the load-bearing assertion):** trigger the ' +
        'code-aware augment over a fixture where an imported ticket OVERLAPS a ' +
        'candidate the planner would generate from the code, plus a code-' +
        'implied GAP no ticket covers. Assert the proposed tree contains the ' +
        'imported ticket ONCE (not doubled) AND the gap item — i.e. the ' +
        'de-dup/reconciliation fired.\n' +
        '5. **Approve:** approve the reconciled tree; navigate to /issues and ' +
        'assert the reconciled backlog exists (the imported items + the ' +
        'augmented gaps, no duplicates), parented per the grammar.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e wf3-byok-codebase-import` passes locally + in CI, ' +
        'backed by the stubbed connect + the codegraph fixture + a recorded ' +
        'import source + recorded planner fixtures (no live GitHub / import ' +
        'source / model).\n' +
        '- The spec asserts the DE-DUP: an imported-vs-generated overlap ' +
        'resolves to ONE item (the imported one) and a code-implied gap is ' +
        'added — the reconciled tree is not doubled; a re-run does not ' +
        're-double.\n' +
        '- It reuses the existing `signIn` helper + the 7.7.9 webhook stub + ' +
        'the 7.5.4 fixture + the 7.17.9 import-e2e + the 7.3.7/7.4.9 planner ' +
        'patterns — no new auth / GitHub / import plumbing invented.\n' +
        '- Not flake-prone: explicit waits on the index-progress + the import ' +
        'progress + the augment `aria-live` regions and the post-approve ' +
        'confirmation (no fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 7.18.2 — the WF3 orchestration + reconciliation under test.\n' +
        '- 7.16.7 — the migrate-onboarding E2E (connect/index/convention) ' +
        'patterns this composes with; 7.17.9 — the import E2E (Jira-export + ' +
        'CSV → work items, no-dupe re-run) fixture pattern.\n' +
        '- 7.3.7 / 7.4.9 — the generate/augment E2E stub patterns + recorded ' +
        'planner fixtures the augment reuses.\n' +
        '- `motir-core/tests/e2e/` — the `signIn` helper + the established ' +
        'aria-live waiting patterns to mirror.',
      dependsOn: ['7.18.2'],
    },
  ],
};
