import type { SeedStory } from '../types';

/**
 * Story 7.13 — Contextual planning from each work item. The AI planning layer
 * brought DOWN to the issue detail: a planning chat panel embedded IN a work
 * item that can expand, refine, or re-plan THAT item, its SIBLINGS, or its
 * PARENT story — every change a PROPOSAL the human reviews as a diff and
 * confirms before anything is written. This is whole-tree generation (7.3) and
 * augment/expand/replan (7.4) re-pointed at a single item's NEIGHBORHOOD and
 * surfaced where the planner is already looking: the issue they have open.
 *
 * **What 7.13 is.** Today the AI planning surfaces live at the project level
 * (the 7.2 chat front door, the 7.3 generated-tree review). 7.13 adds a
 * per-item entry point: open any issue → a planning chat scoped to it. Ask
 * "break this story into subtasks", "this is too big, split it", "the auth
 * epic is missing a rate-limit story", "re-plan this — the OAuth task is
 * done" — and the panel runs the SAME 7.4 augment / expand_item / replan jobs
 * (over the 7.1 boundary), scoped to the item's neighborhood, returning a
 * tree-DELTA. motir-core renders that delta as a proposed-change DIFF and — on
 * an explicit human approve — persists it through the 7.1.6 callback →
 * `workItemsService`. 7.13 is the engine wiring (scope a planning session to a
 * work-item id) + the issue-detail panel + the always-on confirmation gate.
 *
 * **KEY — no scope limit, but confirmation is ALWAYS required.** The chat is
 * SCOPED to the work item (the item is the anchor + the default context push),
 * but the proposals it can make are NOT scope-limited: a change may touch the
 * item itself (expand it to children), its SIBLINGS (add a missing sibling
 * story under the same parent), or its PARENT story (re-plan the parent around
 * completed work). The chat reaches the WHOLE neighborhood. What is absolute
 * is the WRITE posture: **every proposed tree change — subtask, sibling, OR
 * parent — renders a diff and persists via 7.1.6 only on explicit approve.
 * There is no auto-write path, ever.** Auto-write is not a setting, not a
 * "trusted item" shortcut, not a batch-confirm — each proposed delta is shown
 * as a diff and committed only when the human approves THAT diff. This is the
 * Atlassian-Rovo issue-side AI Work Breakdown posture, VERIFIED (not asserted):
 * Rovo's per-issue work breakdown "suggests child work items using the summary
 * and description from the work item you're breaking down as well as any
 * existing child work items"; the suggestions are DRAFTS the team "review and
 * refine" and "review and confirm" before they are created — "users remain
 * responsible for validating scope … before work begins". Motir ships that
 * generate→review→confirm loop as a first-class issue-detail panel, extended
 * from Rovo's flat child-list to Motir's neighborhood (item / siblings /
 * parent) tree-delta.
 *
 * **The locked Epic-7 architecture this story inherits (full prose in
 * story-7.1.ts's header; the parts that bear on contextual planning):**
 *
 * 1. **One-directional writes — generate → human-approve → persist.** The AI
 *    NEVER writes the tree. The contextual-planning jobs return a delta as
 *    DATA; motir-core renders the diff, the human approves, and ONLY THEN does
 *    motir-core commit through `workItemsService` (the 7.1.6 persist callback —
 *    every 6.4 permission + the 404-not-403 tenant guard applies unchanged).
 *    7.13's confirmation gate (7.13.5) is this principle made literal at the
 *    issue-detail surface: no delta — sibling or parent included — bypasses the
 *    diff-then-approve step.
 *
 * 2. **A tool-use SESSION, not a one-shot call.** A contextual planning turn is
 *    a multi-step loop scoped to the item's neighborhood (read the item + its
 *    parent + its siblings via the 7.1.6 skeleton, search related via the
 *    shipped 6.1.1 FilterAST, draft a delta, self-validate). It runs as a 7.1.4
 *    async job and rides the 7.2 chat streaming, so progress streams into the
 *    embedded panel exactly as the project-level chat streams into the front
 *    door. Two co-equal front doors over one boundary — the project chat and
 *    now the per-item panel — not a second-class bolt-on.
 *
 * 3. **Reuses the 7.4 jobs, scoped — does NOT add new jobKinds.** Contextual
 *    planning is not a new planner; it is the 7.4 `augment` / `expand_item` /
 *    `replan` jobs invoked with the work-item id as the scope anchor. "Expand
 *    this story" → `expand_item` on the item; "add a sibling" / "this epic is
 *    missing X" → `augment` scoped to the parent's subtree; "re-plan this
 *    around done work" → `replan` on the item or its parent (completed work
 *    locked as immutable, per 7.4.4). The neighborhood is the bounded context
 *    pushed to the job (Principle #2 — push the bounded neighborhood for
 *    expand/re-plan; augment adds the 6.1.1 search for breadth).
 *
 * **What 7.13 is NOT (named so each lands in its own story, not here):**
 * - **The 7.4 jobs themselves** — `augment` / `expand_item` / `replan` are
 *   BUILT in 7.4 (on 7.3.2). 7.13 SCOPES and SURFACES them at the issue detail;
 *   it does not re-implement the planners.
 * - **The project-level generated-tree review** (7.3.5) and the project-level
 *   augment/expand/replan surface (7.4.6) — those are the whole-project
 *   surfaces; 7.13 is the per-ITEM surface embedded in the detail rail. They
 *   share the diff/approve grammar; 7.13 does not replace them.
 * - **The chat front door + discovery** (7.2) — 7.13 RIDES the 7.2 chat
 *   streaming + the 7.2.6 chat proxy, scoped by work-item id; it does not add a
 *   new chat substrate.
 * - **Prompt generation + dispatch** (7.6), **retrieval/code-graph** (7.5),
 *   **lessons** (7.10) — those enrich the underlying jobs; 7.13 inherits
 *   whatever the 7.4 jobs already have and adds none of them.
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** Every 7.13 leaf depends
 * only on backward/sideways same-epic ids — 7.4.5 (the augment/expand/replan
 * APIs + services the contextual job and persist reuse), 7.2.6 (the chat
 * streaming proxy the panel rides), 7.1.6 (the persist callback the
 * confirmation gate commits through) — plus the design gate (7.13.1) it ships
 * itself. No forward-pointing dep (every upstream story number ≤ 7.13).
 * Statuses follow the rule: the design subtask (`dependsOn: []`) is `planned`;
 * everything chained behind it or behind any not-yet-done 7.x id is `blocked`.
 *
 * **The design gate fires (Principle #13).** 7.13 ships a real user-facing
 * surface — the per-item planning chat panel + the proposed-change diff
 * embedded in the issue detail. So the FIRST subtask (7.13.1) is a `design`
 * card producing `design/ai-planning/*.mock.html` + `design-notes.md`, and
 * EVERY UI-touching code subtask (7.13.4) depends on it and is `blocked` behind
 * it.
 */
export const story_7_13: SeedStory = {
  id: '7.13',
  title: 'Contextual planning from each work item',
  status: 'planned',
  gitBranch: 'feat/PROD-7.13-contextual-planning',
  descriptionMd:
    'Bring the AI planning layer onto the issue detail: a planning chat panel ' +
    'embedded IN a work item that can expand it, add or refine its SIBLINGS, ' +
    'or re-plan its PARENT story — reusing the 7.4 augment/expand/replan jobs ' +
    "scoped to the item's neighborhood, with every proposed change rendered " +
    'as a diff and persisted ONLY on an explicit human approve. This is the ' +
    'planner sitting where the user already is (the issue they have open), ' +
    'with no auto-write path anywhere.\n\n' +
    '**The loop (locked — see the module header for the full rationale):**\n\n' +
    '- **scope** — opening an issue scopes a planning chat to it: the work ' +
    'item is the anchor + the default context push (the item, its parent, its ' +
    'siblings, read via the 7.1.6 skeleton; related work found via the shipped ' +
    '6.1.1 FilterAST). The chat reaches the whole NEIGHBORHOOD — there is no ' +
    'scope limit on what a proposal may touch.\n' +
    '- **plan** — a turn runs the SAME 7.4 job for the intent: "expand this ' +
    'story" → `expand_item`; "add a sibling" / "this epic is missing X" → ' +
    '`augment` over the parent subtree; "re-plan this — the OAuth task is ' +
    'done" → `replan` (completed work locked immutable). It returns a ' +
    'tree-DELTA; progress streams over the 7.2 chat stream into the panel.\n' +
    '- **review the diff** — motir-core renders the delta as a proposed-change ' +
    'DIFF (children added under the item, a sibling added under the parent, a ' +
    'parent re-plan shown as add/keep/remove against the existing subtree). ' +
    'Nothing is written.\n' +
    '- **approve → persist** — on an explicit approve of THAT diff, motir-core ' +
    'commits the delta through the 7.1.6 callback → `workItemsService`. ' +
    '**Confirmation is ALWAYS required — subtask, sibling, OR parent — and ' +
    'there is no auto-write path, ever.**\n\n' +
    '**Scope:** the per-item planning-panel + proposed-change-diff design ' +
    "(7.13.1); the contextual planning job scoping the 7.4 jobs to an item's " +
    'neighborhood (7.13.2); the contextual-planning API + per-item chat ' +
    'session (7.13.3); the issue-detail panel UI (7.13.4); the always-on ' +
    'confirmation gate (7.13.5); vitest (7.13.6); the open→chat→diff→confirm ' +
    'E2E (7.13.7).\n\n' +
    '**Out of scope (named so they land in their own stories, not here):** the ' +
    '7.4 augment/expand/replan jobs themselves (BUILT in 7.4 — 7.13 scopes and ' +
    'surfaces them); the project-level tree-review (7.3.5) + augment surface ' +
    '(7.4.6); the chat front door + discovery (7.2); prompt generation + ' +
    'dispatch (7.6); retrieval/code-graph (7.5); lessons (7.10).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services locally (motir-core on ' +
    '`:3000`, motir-ai on its dev port, each pointed at the other), on the ' +
    'seeded `moooon`/`motir` tenant with a `PROD` project that has a few ' +
    'epics/stories/tasks (so an item has a parent + siblings to act on).\n' +
    '- **End-to-end happy path (the story).** Open a STORY issue. The ' +
    'issue-detail planning panel is present, scoped to that item. Type "break ' +
    'this story into subtasks". The job (`expand_item`, scoped to the item) ' +
    'drives `queued → running → succeeded`; progress streams in the panel. A ' +
    'proposed-change DIFF appears — children to be added UNDER this story, ' +
    'clearly "not created yet". Review it, then **Approve**. The children are ' +
    "persisted; the issue's child list now shows exactly the approved set, " +
    'parented under this story.\n' +
    '- **Sibling + parent reach (no scope limit).** From the SAME panel, ask ' +
    '"the parent epic is missing a rate-limit story" → the diff proposes a ' +
    'SIBLING under the parent (not a child of the open item); approve → the ' +
    'sibling appears under the parent. Then on a story with a completed task, ' +
    'ask "re-plan this around the done work" → the diff shows the completed ' +
    'task LOCKED (kept, not re-proposed) and new work around it; approve → it ' +
    'persists. Both a sibling edit and a parent re-plan required an explicit ' +
    'confirm.\n' +
    '- **Confirmation is ALWAYS required (the gate).** For EVERY proposal ' +
    'above — child, sibling, parent — nothing was written before Approve: a ' +
    'plan-then-Discard run leaves the tree unchanged. There is no auto-apply ' +
    'toggle anywhere in the panel; confirm a delta and ONLY that delta ' +
    'persists. A foreign-project / expired job-scoped token is 404 / 401 (the ' +
    '7.1.6 contract, re-exercised).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.13.6 covers: a ' +
    'contextual job scoped to an item invokes the right 7.4 job ' +
    '(`expand_item`/`augment`/`replan`) with the neighborhood context; the ' +
    'confirmation gate persists ONLY on explicit approve (no approve → DB ' +
    'unchanged) for each of child / sibling / parent deltas; the approve-side ' +
    're-validation rejects a malformed delta before any write.\n' +
    '- **Write authority stays in core.** Confirm every persist went through ' +
    'the 7.1.6 callback → `workItemsService` (not raw Prisma), honored 6.4 ' +
    'permissions as the session user, and that NO `motir-ai` import appears in ' +
    'motir-core (HTTP only); browsers never call motir-ai.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    "comment with what didn't work and Motir will produce a follow-up Subtask " +
    'under the same Story.',
  items: [
    {
      id: '7.13.1',
      title:
        'Design — the per-work-item planning chat panel + the proposed-change diff (issue detail)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The issue-detail planning panel UI (7.13.4) ' +
        'depends on this card; without it the embedded panel + the ' +
        'proposed-change diff would be improvised, which is forbidden ' +
        '(notes.html #31).\n\n' +
        'Produce the design asset for the **per-work-item planning chat panel ' +
        '+ the proposed-change diff** under `motir-core/design/ai-planning/` ' +
        '(the same area 7.3/7.4 use — this is a NEW surface in it: the ' +
        'issue-detail-embedded panel, distinct from the project-level ' +
        'tree-review). Author it as a **`*.mock.html` mockup** built from the ' +
        'real design system (the shipped `components/ui/*` primitives + the ' +
        '`--el-*` colour tokens + the `[data-display-style]` shape tokens) — ' +
        'NOT a `.pen`. The HTML route is preferred when a coding agent ' +
        'produces the design (no translation gap; the reviewer sees the actual ' +
        'tokens). A PNG export is optional; the `.mock.html` is the source of ' +
        'truth (MOTIR.md § Design-reference rule).\n\n' +
        '**Mirror (VERIFIED — Atlassian Rovo issue-side AI Work Breakdown).** ' +
        'Rovo\'s per-issue breakdown "suggests child work items using the ' +
        "summary and description from the work item you're breaking down as " +
        'well as any existing child work items"; the suggestions are DRAFTS ' +
        'the team "review and refine" / "review and confirm" before they are ' +
        'created (users "remain responsible for validating scope … before work ' +
        'begins"). Draw THAT loop, embedded in Motir\'s issue detail and ' +
        "extended from Rovo's flat child list to the NEIGHBORHOOD: the panel " +
        'can propose changes to the item, its SIBLINGS, or its PARENT — and ' +
        'EVERY proposal is a diff the human confirms (no auto-write). Note for ' +
        'the reviewer: Rovo surfaces breakdown as a one-shot suggestion list; ' +
        'Motir surfaces it as a persistent, scoped CHAT on the issue that ' +
        'returns successive diffs — call out the difference in design-notes.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the embedded panel at rest (scoped header).** The ' +
        'planning chat as a section/tab on the issue detail rail, with a ' +
        'header that makes the SCOPE explicit ("Planning · scoped to ' +
        'PROD-142") and quick-intent affordances ("Break into subtasks", ' +
        '"Add a sibling", "Re-plan around done work"). Show the empty/initial ' +
        'state (a prompt box + the suggested intents), composed so it reads as ' +
        'PART of the issue, not a separate page.\n' +
        '- **Panel 2 — a streaming turn.** The "Planning…" in-flight state ' +
        '(progress from the 7.2 job stream — "Reading the neighborhood…", ' +
        '"Drafting subtasks…"), the user/assistant message stack, an ' +
        '`aria-live` region. Mirror the 7.2 chat treatment so the embedded ' +
        'panel feels like the same planner, scoped.\n' +
        '- **Panel 3 — the proposed-change DIFF (the load-bearing surface).** ' +
        'The returned delta rendered as a diff AGAINST the existing ' +
        'neighborhood, with THREE distinguishable change targets drawn: (a) ' +
        'children ADDED under the open item (an "expand" result); (b) a ' +
        'SIBLING added under the parent (an "augment" result — show it nested ' +
        'beside the open item under the shared parent so the user sees it is ' +
        'NOT a child of the current item); (c) a PARENT re-plan (add / keep / ' +
        "remove rows against the parent's subtree, with COMPLETED work shown " +
        'LOCKED — immutable, never proposed for removal, per 7.4.4). Use ' +
        'add/remove/keep affordances (e.g. `--el-success` tint for added, ' +
        '`--el-danger` tint for removed, a "locked"/done treatment for ' +
        'immutable) — the tint in the BACKGROUND with `--el-text-strong`, ' +
        'never a page-level tinted surface (finding #35). Each proposed node ' +
        'is unmistakably "not created yet".\n' +
        '- **Panel 4 — the confirm bar (the always-on gate).** The footer ' +
        'action ("Approve & apply N changes") with the live count, a ' +
        'secondary "Discard", and explicit copy that approve is the ONLY thing ' +
        'that writes — for a sibling/parent change too. Draw the post-approve ' +
        'confirmation (inline "Applied 4 changes" with a peek into the ' +
        'affected items). There is NO auto-apply toggle — design it OUT, and ' +
        'say so in design-notes.\n' +
        '- **Panel 5 — empty/error + edit-before-confirm.** The failed-job ' +
        'state (clear retry, never a half-applied tree); a per-row edit on the ' +
        'diff (re-title a proposed node, exclude a proposed node from the ' +
        'approved set — the Rovo "review and refine" affordance) so the human ' +
        'shapes the diff before confirming.\n\n' +
        'Also write **`design/ai-planning/design-notes.md`** (a NEW notes file ' +
        'for this surface, or a clearly-headed addition to the 7.3 one) naming ' +
        'the exact primitives used per surface, the exact copy strings, the ' +
        'placement decisions (where on the issue rail the panel sits, ' +
        'alongside which existing detail sections), the per-`--el-*` colour ' +
        'role for each element (incl. the added/removed/locked diff roles + ' +
        'the per-kind `--el-type-*` hues + the proposed/draft treatment), the ' +
        'no-auto-write rationale, and a "primitives composed (no hand-rolling)" ' +
        'checklist (the `design-notes.md` convention 1.3.3 / 1.5.1 / 7.0.1 ' +
        'established).\n\n' +
        '**Branch.** `design/PROD-7.13.1-contextual-planning-panel`. The ' +
        '`design/*` prefix gate skips CI E2E + the Vercel preview deploy ' +
        '(MOTIR.md § Plan-seed Workflow) — this PR only edits ' +
        '`design/ai-planning/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/ai-planning/contextual-planning-panel.mock.html` ' +
        'exists, renders the five panels above, and references ONLY `--el-*` ' +
        'tokens + `[data-display-style]` shape tokens (no Tier-0 `--color-*`, ' +
        'no hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- The proposed-change diff (Panel 3) visibly distinguishes the THREE ' +
        'change targets (child-of-item / sibling-under-parent / parent-replan) ' +
        'and shows completed work as LOCKED/immutable in the re-plan case.\n' +
        '- The confirm bar (Panel 4) makes approve the ONLY write path and has ' +
        'NO auto-apply toggle; per-row edit/exclude (Panel 5) is drawn.\n' +
        '- `design-notes.md` names every primitive composed + every copy ' +
        'string + the per-element `--el-*` role (incl. the diff add/remove/' +
        'locked roles and the per-kind hues) and records the no-auto-write ' +
        'rationale + the Rovo-vs-Motir (one-shot list vs scoped chat) ' +
        'difference.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`IssueTypeIcon`, `Button`, `Combobox`/`DropdownMenu`, `EmptyState`, ' +
        'the toast, the chat message primitives the 7.2 design established) — ' +
        'if a genuinely new primitive is needed, that is a NEW `design/` ' +
        'subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ai-planning/` (7.3.1 tree-review, 7.4.1 ' +
        'augment/diff) — the closest existing design assets; reuse the ' +
        'proposed/draft + diff treatment vocabulary so the per-item surface is ' +
        'consistent with the project-level ones.\n' +
        '- `motir-core/design/ai-chat/` (7.2.1) — the chat panel + streaming ' +
        'treatment this embeds a scoped variant of.\n' +
        '- `motir-core/components/issues/IssueTypeIcon.tsx` — per-kind icon + ' +
        'hue (the `--el-type-*` mapping the diff rows use).\n' +
        '- The issue-detail layout (the existing detail rail / sections the ' +
        'panel docks into) — to place the panel as part of the issue, not a ' +
        'separate route.\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx`, the `DropdownMenu`/`Combobox` primitive — the ' +
        'composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (the swap layer the mock ' +
        'references).',
      dependsOn: [],
    },
    {
      id: '7.13.2',
      title:
        'Contextual planning job (motir-ai) — scope the 7.4 augment/expand/replan jobs to an item neighborhood',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Make the 7.4 planning jobs runnable SCOPED to a single work item — a ' +
        'chat session whose context anchor is one item and whose proposals may ' +
        'expand/modify the item, its SIBLINGS, or its PARENT story. This does ' +
        'NOT add a new `jobKind`: it is the existing 7.4 `augment` / ' +
        '`expand_item` / `replan` jobs invoked with a work-item id as the ' +
        'scope, and a neighborhood context push.\n\n' +
        '**Intent → 7.4 job mapping (the scoping logic).** A contextual turn ' +
        'classifies the user intent and dispatches the matching 7.4 job ' +
        'against the scoped item:\n' +
        '- "expand / break this into subtasks" → `expand_item` (7.4.3) on the ' +
        'item — bounded-neighborhood context push (the item + its existing ' +
        'children).\n' +
        '- "add a sibling / this parent is missing X" → `augment` (7.4.2) ' +
        "scoped to the PARENT's subtree — places new work WITHOUT duplicating, " +
        'using the 7.1.6 skeleton (breadth) + the SHIPPED 6.1.1 FilterAST ' +
        'search (find related so it does not re-create an existing sibling).\n' +
        '- "re-plan this / re-plan the parent around done work" → `replan` ' +
        '(7.4.4) on the item or its parent — completed work is locked as ' +
        'IMMUTABLE context (never re-proposed for change), per 7.4.4.\n\n' +
        '**NO scope limit — the neighborhood is reachable.** The job reads the ' +
        'item, its PARENT, and its SIBLINGS via the 7.1.6 read-back skeleton ' +
        '(plus 6.1.1 search for related breadth), so a proposal can legally ' +
        'touch any of the three targets. The work-item id is the ANCHOR (the ' +
        'default context centre + the default action target), not a hard fence ' +
        'around what may change. Every result is a PROPOSAL (a tree-delta), ' +
        'never a write — persist is core-side behind the 7.13.5 confirmation ' +
        'gate.\n\n' +
        '**Returns the SAME tree-delta shape (7.3.2).** The contextual job ' +
        'returns the versioned tree-delta the 7.3/7.4 jobs already emit ' +
        '(`tempId`/`parentTempId` for new nodes; references to existing keys ' +
        'for re-parent/modify/remove proposals), tagged with the change TARGET ' +
        '(child-of-item / sibling-under-parent / parent-replan) so the ' +
        '7.13.4 diff can render the three cases distinctly. It carries NO write ' +
        "authority — it is data core chooses to commit. Reuse the 7.4 jobs' " +
        'OWN self-validation (grammar-legal kinds, immutability of done work); ' +
        'add no parallel validator.\n\n' +
        '**Runs as a 7.1.4 async job, streams over the 7.2 stream.** A turn is ' +
        'a `POST /v1/jobs` submit (the 7.4 kind) with the scoped context ' +
        'envelope; progress streams over the 7.1.4 job stream the 7.2 chat ' +
        'already consumes, so the embedded panel shows live progress. The ' +
        'scoping (item id → neighborhood context → 7.4 job) is a discrete, ' +
        'testable motir-ai module — no business logic inlined in the ' +
        'job-dispatch glue.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A contextual planning turn for a work-item id classifies the intent ' +
        'and dispatches the correct 7.4 job (`expand_item` for the item, ' +
        '`augment` over the parent subtree for a sibling, `replan` for a ' +
        'parent re-plan) with a neighborhood context push (item + parent + ' +
        'siblings via 7.1.6; related via 6.1.1).\n' +
        '- The returned delta is the same versioned tree-delta shape (7.3.2), ' +
        'tagged with the change target (child / sibling / parent) so the diff ' +
        "can render the three cases; it conforms to the grammar (the 7.4 jobs' " +
        'self-validation, reused — no parallel validator).\n' +
        '- A re-plan locks completed work as immutable (never proposes ' +
        'changing/removing a done node), inheriting 7.4.4.\n' +
        '- NO new `jobKind` is introduced — it is the 7.4 jobs scoped; the ' +
        'scoping is a discrete testable module.\n' +
        '- No persist happens in the job — it returns the delta as data ' +
        '(persist is core-side behind the 7.13.5 gate); progress streams over ' +
        'the 7.1.4 job stream.\n\n' +
        '## Context refs\n\n' +
        '- 7.4.5 (stub) — the augment/expand/replan APIs + services (the ' +
        'core-side seam this rides; the same jobs scoped here).\n' +
        '- 7.4.2 / 7.4.3 / 7.4.4 (stubs) — the `augment` / `expand_item` / ' +
        "`replan` jobs this dispatches scoped, incl. 7.4.4's done-work " +
        'immutability.\n' +
        '- 7.1.6 — the read-back `GET /api/internal/ai/plan-tree` skeleton the ' +
        'job reads the neighborhood from; the SHIPPED 6.1.1 FilterAST search ' +
        'the augment path uses to find related siblings.\n' +
        '- 7.3.2 — the versioned tree-delta schema this reuses (the shared ' +
        'output contract).\n' +
        '- 7.1.4 — the job substrate + job stream; `motir-ai/docs/contract.md` ' +
        '(7.1.1/7.1.9) — the envelope + delta result shape.',
      dependsOn: ['7.4.5'],
    },
    {
      id: '7.13.3',
      title:
        'Contextual-planning API + per-item chat session (motir-core) — scoped by work-item id',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The motir-core side of contextual planning: the API + service that ' +
        'open a planning chat session SCOPED to a work item, submit the 7.13.2 ' +
        'contextual job, and stream its progress to the embedded panel — ' +
        'riding the 7.2 chat streaming + the 7.4.5 augment/expand/replan ' +
        'services, scoped by work-item id. (The approve→persist half is the ' +
        '7.13.5 confirmation gate; this card is the submit + stream + session ' +
        'half.)\n\n' +
        '**4-layer (motir-core/CLAUDE.md).** Routes parse + call ONE service ' +
        'method; the service owns the orchestration (resolve the item + its ' +
        'tenant, mint the 7.1.5 job-scoped token, submit via the 7.4.5 ' +
        'service path with the work-item scope, proxy the stream); writes go ' +
        'through `workItemsService` (and the ONLY write is the 7.13.5 ' +
        'approve — never here).\n\n' +
        '- **`POST /api/issues/[key]/ai/plan`** (session auth, tenant-gated) — ' +
        'resolves the work item by key (404-not-403 on a foreign-tenant key), ' +
        'opens/continues a per-ITEM chat session, submits the contextual job ' +
        '(the 7.4 job scoped to this item via 7.13.2) with the minted ' +
        'job-scoped token, returns `{ jobId, sessionId }`. The route asserts ' +
        'the requesting user can VIEW the item (6.4 permissions) before ' +
        'planning against it.\n' +
        '- **`GET /api/issues/[key]/ai/plan/:jobId/stream`** — proxies the ' +
        '7.1.4 job stream (SSE) to the browser so the embedded panel shows ' +
        'live progress; on terminal, the proposed delta (with its change-target ' +
        'tags) is available via the job result. Browsers stream from CORE, ' +
        'never from motir-ai (the open-core invariant).\n' +
        '- **The per-item chat session.** Scope the 7.2 chat session by ' +
        "work-item id so a turn's history + the streamed proposals belong to " +
        'THAT item (open the issue tomorrow → the session is its planning ' +
        'thread). Reuse the 7.2.6 chat proxy + streaming substrate; do not add ' +
        'a parallel chat stack — this is the project chat, anchored to an item.\n\n' +
        '**Scoped, not fenced.** The session is ANCHORED to the item, but the ' +
        'proposed delta may target the item, a sibling, or the parent (7.13.2). ' +
        'The service passes the work-item id as the scope anchor and lets the ' +
        'job reach the neighborhood; it does not pre-restrict the proposal ' +
        'target. It DOES enforce that the user has permission across the ' +
        'neighborhood the proposal would touch (a parent re-plan requires the ' +
        'parent be visible/editable to the user — checked at the 7.13.5 ' +
        'persist, surfaced here so the panel can warn early).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `POST /api/issues/[key]/ai/plan` resolves the item (404 ' +
        'cross-tenant), opens/continues a per-item chat session, submits the ' +
        'contextual 7.4 job (scoped via 7.13.2) with a freshly minted ' +
        'job-scoped token, and returns `{ jobId, sessionId }`; the stream ' +
        'route proxies progress to the browser.\n' +
        '- The chat session is scoped by work-item id (its history + proposals ' +
        'belong to that item) and reuses the 7.2.6 chat proxy/streaming — no ' +
        'parallel chat substrate.\n' +
        '- The session is anchored (default context = the item + neighborhood) ' +
        'but does NOT pre-fence the proposal target; 6.4 view permission on the ' +
        'item is required to plan against it.\n' +
        '- 4-layer respected; no `motir-ai` import in core (HTTP via the 7.1.5 ' +
        'client only); browsers never stream from motir-ai.\n' +
        '- No write happens in this card — submit + stream + session only ' +
        '(persist is 7.13.5).\n\n' +
        '## Context refs\n\n' +
        '- 7.13.2 — the contextual job (the 7.4 jobs scoped to a neighborhood) ' +
        'this submits.\n' +
        '- 7.4.5 (stub) — the augment/expand/replan APIs + services this rides ' +
        '(submit/diff-review/persist seam), scoped by item.\n' +
        '- 7.2.6 (stub) — the chat API + streaming proxy this scopes by ' +
        'work-item id.\n' +
        '- 7.1.5 — the core→ai client + the job-scoped token mint; 7.1.4 — the ' +
        'job stream proxied to the browser.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the item resolution ' +
        '+ 6.4 permission authority.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['7.4.5', '7.2.6'],
    },
    {
      id: '7.13.4',
      title:
        'Issue-detail planning panel UI (motir-core) — embedded streaming chat + proposed-change diff',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the embedded planning panel EXACTLY as 7.13.1 specifies — the ' +
        'per-item chat docked on the issue detail that streams a planning turn ' +
        'and renders the returned delta as a proposed-change diff. This is the ' +
        "Rovo issue-side breakdown moment, rendered in Motir's neighborhood " +
        '(item / siblings / parent) grammar, embedded where the user already ' +
        'is. (The approve action posts to the 7.13.5 gate; this card renders ' +
        'the panel + the diff and wires the streaming.)\n\n' +
        '**Embed + scope.** Dock the panel on the issue detail (the section/tab ' +
        'the 7.13.1 design places it in), scoped to the open item; the scoped ' +
        'header + the quick intents ("Break into subtasks", "Add a sibling", ' +
        '"Re-plan around done work") from the design. It reads as PART of the ' +
        'issue, not a separate route.\n\n' +
        '**Submit + stream.** A turn posts `POST /api/issues/[key]/ai/plan` ' +
        'and subscribes to `…/:jobId/stream`, showing the in-flight ' +
        '"Planning…" state (7.13.1 Panel 2) with live progress from the job ' +
        'stream. Reuse the 7.2 chat message + streaming components (the ' +
        'embedded panel IS the project chat, scoped) — do NOT re-invent the ' +
        'chat widget.\n\n' +
        '**Render the proposed-change DIFF (NOT a flat list).** On terminal, ' +
        'render the delta as the diff (7.13.1 Panel 3): children added under ' +
        'the item; a sibling added under the parent (drawn nested beside the ' +
        'item under the shared parent, so it is visibly NOT a child of the ' +
        'open item); a parent re-plan as add/keep/remove against the parent ' +
        'subtree with COMPLETED work shown LOCKED/immutable. Per-row ' +
        'edit-before-confirm (re-title a proposed node, exclude a node from the ' +
        'approved set — the Rovo "review and refine" affordance). The diff ' +
        'lives in client state until approve — NOTHING is written while ' +
        'reviewing.\n\n' +
        '**Approve / discard (delegates to the 7.13.5 gate).** "Approve & ' +
        'apply N changes" posts the (possibly edited) delta to the 7.13.5 ' +
        'confirm endpoint; "Discard" drops it. The copy makes explicit that ' +
        'approve is the ONLY thing that writes — for a sibling/parent change ' +
        'too. There is NO auto-apply control. On success, the Panel-4 ' +
        'confirmation ("Applied 4 changes" + a peek into the affected items) ' +
        'and the diff clears.\n\n' +
        '**Tokens + a11y.** References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 utilities — the ' +
        '`motir-core/CLAUDE.md` colour/shape rules); per-kind icons via ' +
        '`IssueTypeIcon` (`--el-type-*`); the diff add/remove/locked roles via ' +
        '`--el-success`/`--el-danger`/the done treatment as tint BACKGROUNDS ' +
        'with `--el-text-strong` (finding #35, never a page-level tint). ' +
        'Keyboard reachable; the per-row edit/exclude + approve/discard have ' +
        'aria-labels; the streaming region is an `aria-live` polite area. ' +
        '**i18n:** reuse/extend the `aiPlanning` namespace (the same locale ' +
        'set the app ships).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The panel is embedded on the issue detail, scoped to the open item ' +
        '(scoped header + quick intents), composed of the named 7.13.1 ' +
        'primitives + `--el-*` tokens only.\n' +
        '- A turn submits, streams progress (Panel 2 via the reused 7.2 chat ' +
        'components), then renders the delta as the proposed-change DIFF (Panel ' +
        '3) distinguishing child-of-item / sibling-under-parent / ' +
        'parent-replan, with completed work LOCKED in the re-plan case.\n' +
        '- Per-row edit (re-title) + exclude mutate ONLY client state — nothing ' +
        'is persisted before approve; the refine affordance matches the ' +
        'design.\n' +
        '- "Approve & apply" posts the EDITED delta to the 7.13.5 endpoint; on ' +
        'success the Panel-4 confirmation shows the applied count + a peek, and ' +
        'a plan-then-Discard run persists nothing. There is NO auto-apply ' +
        'control in the panel.\n' +
        '- Empty/initial state (prompt + intents) and failed-job state (retry, ' +
        'never a half-applied tree) render per the design.\n' +
        '- A11y: keyboard-reachable controls, aria-labelled edit/exclude/' +
        'approve, an `aria-live` streaming region; no client component touches ' +
        'the service layer directly (it calls the 7.13.3 + 7.13.5 endpoints).\n\n' +
        '## Context refs\n\n' +
        '- 7.13.1 — the design asset (the five panels this implements ' +
        'verbatim).\n' +
        '- 7.13.3 — the submit/stream endpoints + the per-item session this ' +
        'consumes; 7.13.5 — the confirm endpoint approve posts to.\n' +
        '- The 7.2 chat message + streaming components (the scoped panel ' +
        'reuses them) — the chat widget to reuse, not re-invent.\n' +
        '- `motir-core/components/issues/IssueTypeIcon.tsx` — per-kind icon + ' +
        'hue; the existing issue-detail layout the panel docks into.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + shape tokens.',
      dependsOn: ['7.13.1', '7.13.3'],
    },
    {
      id: '7.13.5',
      title:
        'The confirmation gate (motir-core) — every proposed change diffs + persists via 7.1.6 only on explicit approve',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The always-on write gate for contextual planning: EVERY proposed tree ' +
        'change — a subtask under the item, a SIBLING under the parent, or a ' +
        'PARENT re-plan — is rendered as a diff and persisted through the ' +
        '7.1.6 callback → `workItemsService` ONLY on an explicit human approve ' +
        'of THAT diff. **Confirmation is ALWAYS required. There is no ' +
        'auto-write path, ever** — not a setting, not a "trusted item" ' +
        'shortcut, not a batch auto-confirm. This card is Principle #1 made ' +
        'literal at the issue-detail surface; it is split from 7.13.2 (the ' +
        'engine) because the gate is the load-bearing SAFETY contract and is ' +
        'tested in its own right.\n\n' +
        '**4-layer (motir-core/CLAUDE.md).** A route parses + calls ONE service ' +
        'method; the service re-validates + persists via `workItemsService` ' +
        '(never raw Prisma in a route).\n\n' +
        '- **`POST /api/issues/[key]/ai/plan/confirm`** (session auth, ' +
        'tenant-gated) — body carries the APPROVED, possibly-edited delta (the ' +
        'human-reviewed diff from 7.13.4, which MAY differ from what the job ' +
        'proposed: nodes re-titled, nodes excluded). The service: (1) ' +
        '**re-validates** the delta against the kind-parent grammar ' +
        "INDEPENDENTLY of the planner's self-check (defense in depth — the " +
        'client-submitted delta is never trusted), (2) enforces 6.4 ' +
        'permissions across EVERY node the delta touches — incl. the PARENT and ' +
        'SIBLINGS for a parent/sibling change, not just the anchored item (a ' +
        'parent re-plan requires edit permission on the parent subtree), (3) ' +
        'commits it through the 7.1.6 persist callback → `workItemsService`, ' +
        'resolving `tempId`s → real keys + linking parents per the grammar, ' +
        'applying the 404-not-403 tenant guard as the session user, (4) ' +
        'returns the applied keys. An empty / all-excluded delta is a valid ' +
        'no-op (writes nothing).\n\n' +
        '**The gate is unconditional + per-diff.** There is NO endpoint, flag, ' +
        'or setting that persists a contextual delta without this explicit ' +
        'confirm. Each confirm applies EXACTLY one human-approved diff; a new ' +
        'planning turn produces a new diff that needs its OWN confirm. A ' +
        'sibling change and a parent re-plan go through this same gate as a ' +
        'child expansion does — the no-scope-limit on what may be PROPOSED does ' +
        'NOT relax the always-confirm on what is WRITTEN.\n\n' +
        '**Immutability of done work holds at persist.** The re-validation ' +
        'rejects any delta that would modify/remove a node marked complete (the ' +
        'planner already locks it per 7.4.4; core re-checks — defense in ' +
        'depth). A delta that violates this is a typed 400 BEFORE any write.\n\n' +
        '**Atomicity.** The whole approved delta persists in ONE transaction ' +
        "(via `workItemsService`'s transaction boundary) — a partial change is " +
        'never committed; on any node failure the whole confirm rolls back and ' +
        'surfaces a typed error.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `POST /api/issues/[key]/ai/plan/confirm` persists the approved delta ' +
        'ONLY on explicit call — there is NO code path (endpoint/flag/setting) ' +
        'that persists a contextual delta without this confirm (asserted in ' +
        'tests: no approve → DB unchanged).\n' +
        '- It re-validates the submitted delta against the grammar AND the ' +
        'done-work immutability rule, rejecting a malformed / illegal-edge / ' +
        'done-node-mutating delta with a typed 400 BEFORE any write ' +
        '(independent of the planner self-check).\n' +
        '- 6.4 permissions are enforced across EVERY node the delta touches — ' +
        'the parent and siblings for a parent/sibling change, not just the ' +
        'anchored item.\n' +
        '- Persist goes through the 7.1.6 callback → `workItemsService` ' +
        '(verified: no raw Prisma in the route), resolving temp ids → keys + ' +
        'parent links; the whole confirm is atomic (one transaction; a ' +
        'node-level failure rolls the whole thing back).\n' +
        '- An empty / all-excluded delta is a valid no-op (returns `[]`, writes ' +
        'nothing); session + tenant gate (401 no session; 404-not-403 ' +
        'cross-tenant); 4-layer respected.\n\n' +
        '## Context refs\n\n' +
        '- 7.13.2 — the contextual job whose delta (with child/sibling/parent ' +
        'target tags) this gate confirms + persists.\n' +
        '- 7.1.6 — the persist callback (`POST /api/internal/ai/plan-delta`) ' +
        'committing through `workItemsService`.\n' +
        '- 7.4.5 (stub) — the augment/expand/replan persist seam this mirrors ' +
        '(the same generate→approve→persist grammar, per item).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the create/update ' +
        'authority + its transaction boundary; `motir-core/lib/issues/' +
        'parentRules.ts` — the grammar the re-validation enforces.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['7.13.2'],
    },
    {
      id: '7.13.6',
      title:
        'Vitest — contextual planning scoped to an item + the confirm-before-write gate (no persist without approve)',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the contextual-planning loop with tests on both sides, with the ' +
        'always-confirm gate as the headline assertion. motir-core tests run ' +
        'over a real Postgres (the project convention; `tests/helpers/db.ts` ' +
        'truncates between tests; the only allowed `vi.mock` is `getSession()`). ' +
        'The motir-ai LLM call is stubbed at the SDK boundary with recorded ' +
        'fixture deltas (no live model in CI) — but the scoping, the delta ' +
        'schema, and the persist gate are exercised for real.\n\n' +
        '**motir-ai — contextual scoping (7.13.2):**\n\n' +
        '- A contextual turn for a work-item id dispatches the correct 7.4 job ' +
        'per intent: "expand" → `expand_item` on the item; "add a sibling" → ' +
        '`augment` over the PARENT subtree; "re-plan" → `replan` on the ' +
        'item/parent — each with a neighborhood context push (item + parent + ' +
        'siblings).\n' +
        '- The returned delta is the versioned tree-delta shape tagged with ' +
        'the change target (child / sibling / parent); a re-plan delta never ' +
        'proposes changing/removing a completed node (7.4.4 immutability, ' +
        'reused).\n' +
        '- No new `jobKind` is registered — it is the 7.4 jobs scoped.\n\n' +
        '**motir-core — the confirmation gate (7.13.5), the load-bearing ' +
        'cases:**\n\n' +
        '- **No approve → no write.** Submitting + streaming a contextual job ' +
        '(7.13.3) and NOT calling confirm leaves the DB unchanged (assert via ' +
        'a repository read — the allowed cross-layer test reach). There is no ' +
        'path that persists without confirm.\n' +
        '- **Approve persists exactly the approved (edited) delta** through ' +
        '`workItemsService` (no raw Prisma): for a CHILD expansion the children ' +
        'appear under the item; for a SIBLING augment the new node appears ' +
        'under the PARENT (not as a child of the anchored item); for a PARENT ' +
        're-plan the add/keep/remove resolves correctly and the completed node ' +
        'is untouched.\n' +
        '- **Edit-before-confirm:** a delta with a node excluded + one ' +
        're-titled persists exactly that set, not the original proposal.\n' +
        '- **Re-validation:** a malformed / illegal-edge / done-node-mutating ' +
        'delta is rejected with a 400 BEFORE any write (DB unchanged), ' +
        'independent of the planner self-check.\n' +
        '- **Permission breadth:** a parent/sibling confirm requires 6.4 ' +
        'permission on the parent subtree, not just the anchored item (a user ' +
        'who can view the item but not edit the parent is refused the parent ' +
        're-plan).\n' +
        '- **Atomicity:** a delta with one node forced to fail rolls the WHOLE ' +
        'confirm back (no partial change); an empty / all-excluded delta is a ' +
        'valid no-op.\n' +
        '- **Auth:** 401 without session; 404 on a cross-tenant issue key.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass on both sides; the motir-core suite runs over a ' +
        'real Postgres (no mocks beyond `getSession()`); the motir-ai suite ' +
        'stubs only the LLM SDK boundary.\n' +
        '- The "no approve → no write" case and the three target cases (child ' +
        '/ sibling / parent) each assert the DB state directly — proving the ' +
        'always-confirm gate and the no-scope-limit reach are real, not ' +
        'asserted.\n' +
        '- A malformed delta is rejected by BOTH the planner self-validation ' +
        '(motir-ai, reused from 7.4) AND the approve-side re-validation ' +
        '(motir-core 7.13.5) — defense in depth.\n' +
        '- New motir-core service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); no untested branch in the ' +
        'confirmation-gate service.\n\n' +
        '## Context refs\n\n' +
        '- 7.13.2 (the scoping under test), 7.13.3 (submit/stream/session), ' +
        '7.13.5 (the confirmation gate under test).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the persist ' +
        'authority asserted against; `motir-core/lib/issues/parentRules.ts` — ' +
        'the grammar both validators check.',
      dependsOn: ['7.13.3'],
    },
    {
      id: '7.13.7',
      title:
        'Playwright E2E — open an issue, chat "expand this story", review the diff, confirm → children appear (+ sibling/parent confirm)',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'End-to-end browser test ' +
        '(`tests/e2e/ai-contextual-planning.spec.ts`) closing the story from ' +
        "the user's seat: open an issue, plan from it, review the diff, confirm " +
        '— and the change appears; a sibling/parent edit also requires a ' +
        'confirm. To keep CI deterministic, the planner job is backed by a ' +
        'RECORDED fixture delta (the same boundary stub 7.13.6 uses — no live ' +
        'LLM in CI), so the test asserts the embedded-panel loop + the real ' +
        'persist + the always-confirm gate, not model quality.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` (the project manager) on the seeded ' +
        '`moooon`/`motir` tenant; open a STORY issue that has a parent epic + ' +
        'at least one sibling story (seed/fixture).\n' +
        '2. The issue-detail planning panel is present, scoped to the item ' +
        '(scoped header). Type "expand this story". Assert the streaming ' +
        '"Planning…" state (Panel 2) appears, then resolves to a ' +
        'proposed-change DIFF (Panel 3): children to be added UNDER this story, ' +
        'a clear "not created yet" treatment, the count rendered. Assert NO ' +
        'child appears on the issue yet (nothing persisted while reviewing).\n' +
        '3. Click **Approve & apply**. Assert the Panel-4 confirmation shows ' +
        "the applied count; the issue's child list now shows EXACTLY the " +
        'approved children, parented under this story.\n' +
        '4. **Sibling reach + confirm:** in the same panel, ask "the parent ' +
        'epic is missing a rate-limit story" → assert the diff proposes a ' +
        'SIBLING under the PARENT (drawn beside this item, not as its child); ' +
        'confirm → the sibling appears under the parent epic. (Re-uses the ' +
        'always-confirm path for a non-child target.)\n' +
        '5. **Nothing-before-confirm branch:** run another turn, then ' +
        '**Discard** — assert NO new items appeared (confirm is the only ' +
        'write, for every target).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e ai-contextual-planning` passes locally + in CI, ' +
        'backed by the recorded fixture delta (no live model).\n' +
        '- The spec uses the existing `signIn(page, email, password)` helper ' +
        '(no new auth plumbing) and the established peek/navigation patterns.\n' +
        '- The expand→diff→confirm flow persists the children under the item; ' +
        'the sibling turn proposes + (on confirm) persists a node under the ' +
        'PARENT, not the item — proving the no-scope-limit reach.\n' +
        '- The Discard branch writes nothing; no auto-apply path is reachable ' +
        'in the panel — confirm is the only write.\n' +
        '- Not flake-prone: explicit waits on the `aria-live` streaming region ' +
        'and on the post-confirm confirmation (no fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 7.13.4 (the panel under test), 7.13.3 / 7.13.5 (the submit/stream + ' +
        'confirm endpoints), 7.13.2 (the fixture-delta boundary the E2E stubs ' +
        'at).\n' +
        '- `motir-core/tests/e2e/ready.spec.ts` (7.0.8) — the E2E patterns ' +
        '(sign-in helper, peek, aria-live waits) to mirror.\n' +
        '- `motir-core/scripts/plan-seed/` — the seeded tenant + how to fixture ' +
        'the item neighborhood (parent epic + a sibling) + the recorded delta ' +
        'for the run.',
      dependsOn: ['7.13.4'],
    },
  ],
};
