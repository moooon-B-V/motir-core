import type { PlanStory } from '../types';

/**
 * Story 7.4 — Augmentation, expansion & completion-aware re-planning. The
 * three EDIT operations over an already-generated plan tree, each a new
 * `jobKind` over the 7.1 boundary: place NEW work without duplicating
 * (`augment`), grow a stub into children (`expand_item`), and re-shape an
 * epic/story while treating finished work as immutable (`replan`). Where 7.3
 * is "blank project → first tree", 7.4 is every subsequent change a real
 * project needs — and where the planner stops being a one-shot generator and
 * becomes a steward of a tree that is already partly built and partly DONE.
 *
 * **Rides the locked Epic-7 architecture (see story-7.1.ts header for the full
 * prose). The 7.4-specific shape:**
 *
 * 1. **Three jobKinds, one boundary.** `augment` / `expand_item` / `replan`
 *    each register a real handler in the 7.1.4 registry (replacing 7.1.7's
 *    `noop`), and each runs the 7.3.2 planning agent (tool-use loop) with a
 *    DIFFERENT context-assembly strategy and a different validation. They all
 *    produce a tree-DELTA as structured data; none writes the tree. The delta
 *    is reviewed by a human, then persisted by motir-core through the shipped
 *    `workItemsService` via the 7.1.6 persist callback — generate → **human
 *    approve** → persist (Principle #3). This is the verified Rovo posture:
 *    AI work breakdown "generates a list of suggested child work items… when
 *    you accept a suggestion, a new child work item is created and linked"
 *    (Atlassian support), and "approved agent updates are captured alongside
 *    the rest of the work item history" — the human stays in the loop and
 *    every change lands through the normal write path, never a parallel one.
 *
 * 2. **Context scales by blast radius (Principle #2).** The three operations
 *    have different reach, so they push different context:
 *      - `expand_item` is BOUNDED — one stub and its neighborhood. Push the
 *        target subtree + its parent chain + its blocking edges; no global
 *        retrieval needed. (The Rovo "suggest child work items" surface, which
 *        breaks ONE work item into children.)
 *      - `augment` is UNBOUNDED — "add this whole capability somewhere in the
 *        tree". It can't enclose the tree, so it runs on the 7.1.6 SKELETON
 *        (breadth — every key/kind/title/status/parent) PLUS on-demand search
 *        to find the right insertion neighborhoods. (The Rovo "add to backlog"
 *        / inline-create surface.)
 *      - `replan` is bounded-but-mutating — one epic/story re-shaped, with the
 *        rest of the tree as read-only context and its OWN completed leaves
 *        pinned (see #4).
 *
 * 3. **Duplicate-avoidance is the augment moat, and it rides SHIPPED search.**
 *    The single hardest thing about adding work to a live tree is NOT
 *    generating tasks — it is generating tasks that don't restate work the
 *    tree already contains. Verified mirror: Rovo's AI work breakdown "uses
 *    the summary and description from the work item you're breaking down AS
 *    WELL AS any existing child work items to provide suggestions" — i.e. it
 *    reads what's already there to avoid repeating it. Motir's augment does
 *    the same with a STRONGER instrument: before proposing, the planner
 *    queries the project through the **shipped 6.1.1 versioned FilterAST**
 *    (`lib/filters/ast.ts` → the repository WHERE compiler) for items related
 *    to each candidate, and folds the hits into context so it places NEW work
 *    into existing neighborhoods instead of cloning them. This is why 7.4 does
 *    NOT hard-depend on 7.5: augment's "find related" baseline is skeleton +
 *    the already-shipped structured search; 7.5's graph-traversal/code-graph
 *    retrieval ENRICHES this later (it wires into the 7.4 jobs, per the dep
 *    map), but 7.4 ships complete on the search baseline. (The resolved
 *    would-be forward dep — finding/dep-audit.)
 *
 * 4. **Completed work is IMMUTABLE context for re-plan.** The re-plan
 *    operation is the one that earns "completion-aware". A done leaf is a fact
 *    about the world — code merged, a decision made — not a proposal the
 *    planner may rewrite. So `replan` LOCKS every terminal-category descendant
 *    of the target: they enter the job as read-only context the new plan must
 *    build AROUND, and the delta is rejected if it would modify or delete one.
 *    The planner re-plans only what is NOT yet done; finished work is the
 *    fixed foundation, exactly as a human re-planning a half-finished epic
 *    keeps the shipped half. (Rovo mirror: agents "operate inside Jira's
 *    existing structures… approved agent updates are captured alongside the
 *    rest of the work item history" — the AI edits forward, it doesn't rewrite
 *    history.)
 *
 * 5. **Auto-suggested expansion productizes the ready-set drain.** When the
 *    7.0 ready set runs low because the remaining work is all coarse stubs,
 *    the system SUGGESTS expanding the next stub rather than leaving the human
 *    to notice (Principle #17 — "the plan should keep itself runnable"). This
 *    is a thin surface over `expand_item`, not a new engine: detect the drain,
 *    nominate stubs, one-click into the same expand→review→approve flow.
 *
 * **The design gate fires (this Story adds UI).** 7.4 introduces three new
 * affordances (expand-a-stub, augment-from-prompt, re-plan) and a DIFF review
 * surface where completed work shows as locked. Those need a design asset
 * BEFORE any UI code — 7.4.1 produces it under `design/ai-planning/` (the area
 * 7.3 established; new affordances get their own panels). Every UI code
 * subtask (7.4.6, 7.4.7) is `blocked` on 7.4.1.
 *
 * **What 7.4 is NOT.** Not the first-tree generator (7.3 — 7.4 edits an
 * existing tree). Not the rich retrieval layer (7.5 — augment runs on the
 * search baseline; 7.5 enriches the same jobs later). Not prompt generation /
 * dispatch (7.6). Not the mistakes store (7.10). It is the planner's EDIT
 * verbs over the tree 7.3 first created.
 *
 * **Cross-story dep audit (PASSES, backward/sideways only).** Every 7.4 leaf
 * depends on same-or-earlier Epic-7 ids — 7.3.2/7.3.4 (the generation engine +
 * its core-side service), 7.1.6 (skeleton read + persist), 7.1.4/7.1.5 (jobs +
 * client) — plus the SHIPPED 6.1.1 FilterAST (already done; its dep is
 * satisfied). No dep on 7.5+. The job handlers are the EXTENSION points 7.5
 * later wires retrieval into; 7.4 does not reach forward to do so.
 */
export const story_7_4: PlanStory = {
  id: '7.4',
  title: 'Augmentation, expansion & completion-aware re-planning',
  status: 'planned',
  gitBranch: 'feat/PROD-7.4-augment-expand-replan',
  descriptionMd:
    'The planner’s three EDIT operations over an already-generated plan tree, ' +
    'each a new `jobKind` over the 7.1 boundary and each running the 7.3.2 ' +
    'planning agent with its own context strategy:\n\n' +
    '- **`augment`** — "add this capability to the backlog". Places NEW work ' +
    'into the existing tree WITHOUT duplicating, using the 7.1.6 skeleton for ' +
    'breadth + the SHIPPED 6.1.1 FilterAST search to find related items and ' +
    'pick the right insertion neighborhoods. The Rovo "add to backlog" / ' +
    'inline-create mirror.\n' +
    '- **`expand_item`** — "break this stub down". Expands a stub epic/story ' +
    'into children with a bounded-neighborhood context push (the target ' +
    'subtree + parent chain + blocking edges). The Rovo "suggest child work ' +
    'items" mirror.\n' +
    '- **`replan`** — "re-shape this epic/story". Re-plans the not-yet-done ' +
    'portion while treating every COMPLETED descendant as immutable, ' +
    'read-only context the new plan must build around. The completion-aware ' +
    'operation.\n\n' +
    'All three produce a tree-DELTA as data, surface it in a **diff review** ' +
    'where completed work shows as locked, and on human approve persist via ' +
    'the 7.1.6 callback through `workItemsService` — generate → approve → ' +
    'persist, the AI never writes the tree directly.\n\n' +
    '**Plus the ready-set-drain productization:** when the 7.0 ready set runs ' +
    'low because the remaining work is coarse stubs, the system suggests ' +
    'expanding the next stub (Principle #17) — a thin surface over ' +
    '`expand_item`, one-click into the same expand→review→approve flow.\n\n' +
    '**Scope:** the design asset for the three affordances + the ' +
    'locked-completed-work diff view (7.4.1); the `augment` job with ' +
    'skeleton+FilterAST duplicate-avoidance (7.4.2); the `expand_item` job ' +
    '(7.4.3); the completion-aware `replan` job (7.4.4); the motir-core ' +
    'APIs/services that submit + diff-review + persist the three (7.4.5); the ' +
    'diff-review UI (7.4.6); auto-suggested expansion on ready-set drain ' +
    '(7.4.7); the test suite incl. the immutability proof (7.4.8); and the ' +
    'end-to-end E2E across all three (7.4.9).\n\n' +
    '**Out of scope (named so they stay in their owning stories):** the ' +
    'first-tree generator (7.3); the rich graph-traversal / code-graph ' +
    'retrieval that ENRICHES these same jobs later (7.5 — augment ships on ' +
    'the search baseline); per-type prompt generation + dispatch (7.6); the ' +
    'planning-mistakes store (7.10).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services locally (`motir-ai` on ' +
    'its dev port, `motir-core` on `:3000`, each pointed at the other via ' +
    'env); `pnpm prisma generate` + `pnpm db:seed` for core; run the motir-ai ' +
    'migrations.\n' +
    '- **Augment (the duplicate-avoidance moat).** On a project that already ' +
    'has a tree, submit an `augment` job from a prompt that overlaps existing ' +
    'work ("add user-facing audit logging" when an audit story already ' +
    'exists). The diff-review surface should propose placing the new work ' +
    'UNDER / next to the existing neighborhood — NOT a duplicate parallel ' +
    'story. Inspect the job result: it shows the FilterAST search hits the ' +
    'planner consulted. Approve → the delta persists through ' +
    '`workItemsService`; the new items appear linked into the right parent.\n' +
    '- **Expand a stub.** Pick a childless stub epic/story; submit ' +
    '`expand_item`; review the proposed children (comet shape, the Epic-2 ' +
    'grammar); approve → they persist as children of the stub.\n' +
    '- **Re-plan respecting done work (the completion-aware proof).** On an ' +
    'epic with SOME completed leaves and some not, submit `replan`. The diff ' +
    'must show every terminal-category descendant as LOCKED (greyed, ' +
    'un-editable) and propose changes only to the not-done portion. Try to ' +
    'approve a (hand-tampered) delta that edits a done leaf → it is REJECTED ' +
    'with a typed error. A clean re-plan approves and persists, leaving every ' +
    'done leaf byte-identical.\n' +
    '- **Auto-suggested expansion.** Drain the ready set down to coarse stubs ' +
    '(mark the fine-grained ready items done); confirm the system surfaces a ' +
    '"expand the next stub" suggestion that opens the same expand→review flow ' +
    '(NOT auto-expanding without review).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.4.8 covers the three ' +
    'jobs, the augment no-duplicate behavior over a fixture tree, and the ' +
    'replan immutability rejection. `pnpm test:e2e` — 7.4.9 walks ' +
    'augment+expand+replan each reviewed and approved.\n' +
    '- **Open-core boundary review (the Epic’s recurring posture).** Confirm ' +
    'no `motir-ai` import appears in `motir-core`; the three jobs read the ' +
    'tree ONLY via the 7.1.6 read-back, persist ONLY via the 7.1.6 callback ' +
    'through `workItemsService`; browsers never call motir-ai. Confirm the ' +
    'FilterAST search the augment job uses runs in motir-core (the planner ' +
    'requests it over the boundary; the SQL compile stays core-side).\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    'fails, comment with what didn’t work and Motir will produce a follow-up ' +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.4.1',
      title:
        'Design — augment / expand / re-plan affordances + the completed-work-locked diff view',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** design (planning-time design gate — every UI-touching ' +
        'subtask in this Story depends on this one; without it the augment / ' +
        'expand / re-plan surfaces would be improvised, which is forbidden). ' +
        'This Story adds three NEW affordances and a diff surface, so the gate ' +
        'fires even though 7.3 already designed the generation/review area — ' +
        'new affordances get their own panels (they reuse 7.3’s area + ' +
        'primitives, they do not reuse its panels).\n\n' +
        'Produce the design asset under `motir-core/design/ai-planning/` (the ' +
        'area 7.3 established — extend it, do not fork a new area). Author a ' +
        '**`*.mock.html` mockup** built from the real design system (shipped ' +
        '`components/ui/*` primitives + `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. Render a PNG ' +
        'export if useful, but the `.mock.html` is the source of truth.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel):\n\n' +
        '- **Panel 1 — the three entry points.** Where augment / expand / ' +
        're-plan are invoked. (a) An **"Augment from prompt"** entry (a ' +
        'prompt box reachable from the backlog / tree header — "describe work ' +
        'to add"); (b) an **"Expand"** button on a stub epic/story row (only ' +
        'shown on a childless container); (c) a **"Re-plan"** action on an ' +
        'epic/story (its overflow menu). Draw each in its real context on the ' +
        'existing tree/issue surfaces.\n' +
        '- **Panel 2 — the augment diff review.** The proposed NEW items shown ' +
        'as additions placed INTO existing neighborhoods (the duplicate-' +
        'avoidance story made visible: "adding under PROD-42 (related)" not a ' +
        'new parallel story). Show the related-items the planner found ' +
        '(provenance), the comet add tree, and accept / edit / remove per ' +
        'proposed item (the Rovo accept-edit-remove review shape) + an ' +
        'approve-all.\n' +
        '- **Panel 3 — the expand diff review.** The stub at top, its proposed ' +
        'children below as additions, the same per-item accept/edit/remove + ' +
        'approve.\n' +
        '- **Panel 4 — the re-plan diff with COMPLETED WORK LOCKED.** The ' +
        'keystone. A three-tone diff over the epic/story’s subtree: ' +
        '**locked** done leaves (rendered non-editable — a lock affordance + a ' +
        '`--el-muted` surface, NOT a destructive tone; they’re foundation, not ' +
        'removed), **added** proposed items, **changed** not-done items. The ' +
        'locked rows must read as "kept / immutable", visibly distinct from ' +
        'added/changed. Include the empty/clean states and the rejected state ' +
        '(what the user sees if a delta tried to touch a locked item).\n' +
        '- **Panel 5 — auto-suggested-expansion nudge.** The ready-set-drain ' +
        'suggestion (a dismissible banner / card on /ready or the tree: "the ' +
        'ready set is running low — expand PROD-12?") that opens Panel 3’s ' +
        'flow. Drawn in context; NOT a modal that auto-expands.\n\n' +
        'Also write **`design/ai-planning/augment-replan-notes.md`** (or ' +
        'extend the 7.3 area’s `design-notes.md`) naming the exact primitives ' +
        'per surface, the exact copy strings (entry labels, the three diff ' +
        'tone meanings, the locked-row tooltip, the rejected-state message, ' +
        'the drain-nudge copy), the placement decisions, the per-`--el-*` ' +
        'colour role for each element (locked = `--el-muted` + ' +
        '`--el-text-muted`; added = `--el-success` family; changed = ' +
        '`--el-info` / `--el-warning`), and a "primitives composed (no ' +
        'hand-rolling)" checklist.\n\n' +
        '**Branch.** `design/PROD-7.4.1-augment-replan-surface`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy — this PR only ' +
        'edits `design/ai-planning/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/ai-planning/augment-replan.mock.html` exists, ' +
        'renders the five panels above, references ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` colour/shape rules).\n' +
        '- The re-plan diff (Panel 4) renders completed work as a VISIBLY ' +
        'LOCKED, non-destructive tone (kept-foundation, not removed), clearly ' +
        'distinct from added/changed rows.\n' +
        '- The design-notes file names every primitive composed + every copy ' +
        'string + the per-element `--el-*` role for the three diff tones + the ' +
        'locked state.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`IssueTypeIcon`, `Button`, `EmptyState`, the existing diff/tree row ' +
        'primitives) — any genuinely new primitive is a NEW `design/` subtask, ' +
        'not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ai-planning/` — the area 7.3 established (the ' +
        'generated-tree review surface); mirror its layout + design-notes ' +
        'shape, extend it with the 7.4 panels.\n' +
        '- `motir-core/design/ready/` — the /ready surface the drain-nudge ' +
        '(Panel 5) lives on (7.0.1).\n' +
        '- `motir-core/components/ui/Pill.tsx`, ' +
        '`motir-core/components/issues/IssueTypeIcon.tsx`, ' +
        '`motir-core/components/ui/EmptyState.tsx` — the primitives composed.\n' +
        '- `motir-core/app/globals.css` — `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (the swap layer the mockup must ' +
        'reference).\n' +
        '- Story 7.3 design (the comet tree-review surface) — the visual ' +
        'grammar the diff tones extend.',
      dependsOn: [],
    },
    {
      id: '7.4.2',
      title:
        '`augment` job — place new work without duplicating (skeleton + 6.1.1 FilterAST search)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Implement the `augment` job handler in motir-ai: given a free-text ' +
        '"add this work" prompt + a target project, place NEW work items into ' +
        'the EXISTING tree without duplicating what’s already there, and ' +
        'return the proposed tree-DELTA (additions, each anchored under a real ' +
        'existing parent). Registers in the 7.1.4 handler registry as ' +
        '`kind: augment`, replacing the `noop` stub for that kind; reuses the ' +
        '7.3.2 planning agent (the tool-use loop) with an augment-specific ' +
        'context strategy + system prompt.\n\n' +
        '**Context strategy (unbounded blast radius → skeleton + search).** ' +
        'Augment can’t enclose the tree, so:\n\n' +
        '1. **Breadth via the 7.1.6 skeleton** — the planner first reads the ' +
        'cheap global projection (`{ key, kind, title, status, parentKey }[]`) ' +
        'so it knows the tree’s overall shape and where capabilities live.\n' +
        '2. **Find-related via the SHIPPED 6.1.1 FilterAST search** — the ' +
        'planner derives candidate terms/fields from the prompt and issues a ' +
        'structured search over the project (text/kind/label/status ' +
        'predicates), getting back the items most related to the requested ' +
        'work. The search runs in motir-core (the planner requests it over the ' +
        'boundary — a read tool that compiles the FilterAST to the ' +
        'parameterized WHERE in `workItemRepository`); the SQL never leaves ' +
        'core. **This is the duplicate-avoidance instrument** — the planner ' +
        'folds the hits into context and is instructed to EXTEND an existing ' +
        'neighborhood rather than restate it (the verified Rovo behavior: AI ' +
        'work breakdown reads "the summary and description… as well as any ' +
        'existing child work items… to provide suggestions").\n' +
        '3. **Generate the delta** — additions only, each with a concrete ' +
        'existing `parentKey` (or a small new sub-tree anchored under one), in ' +
        'the comet shape / Epic-2 grammar (7.3.3’s kind-parent matrix), with ' +
        'structured-output self-validation (legal parents, no dangling ' +
        'refs).\n\n' +
        'The job RESULT carries the related-items the planner found (the ' +
        'provenance the diff surface renders) alongside the delta. No write ' +
        'happens here — motir-core persists on approval via 7.1.6. **7.4 does ' +
        'NOT depend on 7.5**: this is the skeleton+search baseline; 7.5’s ' +
        'graph-traversal/code-graph retrieval wires into THIS handler later to ' +
        'enrich "find related", but augment is complete without it.\n\n' +
        'The "search the tree" read tool this needs (a planner-facing ' +
        '`search_work_items` over the 6.1.1 FilterAST) is the SAME tool 7.5.2 ' +
        'later formalizes for the broader retrieval set — here 7.4 introduces ' +
        'the minimal version it needs over the already-shipped FilterAST ' +
        'compiler; 7.5.2 generalizes it. (Recorded so the overlap is honest, ' +
        'not a hidden dep — 7.5.2 is forward, so augment ships its own minimal ' +
        'search read now.)\n\n' +
        '## Acceptance criteria\n\n' +
        '- `kind: augment` is registered and runs the planning agent with the ' +
        'augment context strategy; an `augment` job over a fixture tree ' +
        'returns an additions-only delta whose every item names a legal ' +
        'existing `parentKey` (or a legal new anchored sub-tree).\n' +
        '- The planner consults the 6.1.1 FilterAST search before proposing; ' +
        'the job result records the related items it found (provenance).\n' +
        '- **No-duplicate behavior:** given a prompt that overlaps an existing ' +
        'story, the delta EXTENDS that neighborhood (children under / siblings ' +
        'beside it) rather than creating a parallel duplicate (asserted in ' +
        '7.4.8 over a fixture).\n' +
        '- The delta self-validates against the kind-parent matrix; no ' +
        'dangling parent refs; an illegal placement fails the job cleanly with ' +
        'a taxonomy error.\n' +
        '- The search read runs in motir-core via the FilterAST→WHERE ' +
        'compiler; no raw SQL or motir-core DB connection in motir-ai.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/lib/filters/ast.ts` — the SHIPPED 6.1.1 versioned ' +
        'FilterAST (the search interchange shape) + ' +
        '`motir-core/lib/filters/registry.ts` (the operator/field registry) + ' +
        'the repository WHERE compiler in ' +
        '`motir-core/lib/repositories/workItemRepository.ts`.\n' +
        '- 7.3.2 (the planning agent / tool-use loop this reuses) + 7.3.3 (the ' +
        'comet shape + kind-parent matrix the delta must satisfy).\n' +
        '- 7.1.6 — the skeleton read-back (breadth) + the persist callback the ' +
        'approved delta later commits through.\n' +
        '- 7.1.4 — the handler registry the `augment` kind registers in.\n' +
        '- Story 7.5 (stub) — the graph-traversal/code-graph retrieval that ' +
        'ENRICHES this handler later (augment is the search-baseline floor it ' +
        'grows from).',
      dependsOn: ['7.3.2', '7.1.6'],
    },
    {
      id: '7.4.3',
      title: '`expand_item` job — expand a stub epic/story to children (bounded-neighborhood push)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Implement the `expand_item` job handler in motir-ai: given a target ' +
        'stub (an epic/story with no — or few — children), generate its ' +
        'children and return the proposed tree-DELTA (additions parented to ' +
        'the target). Registers in the 7.1.4 registry as `kind: expand_item`; ' +
        'reuses the 7.3.2 planning agent with an expand-specific strategy. The ' +
        'Rovo "suggest child work items" mirror — break ONE work item down, ' +
        'human reviews, accepted suggestions become linked children.\n\n' +
        '**Context strategy (BOUNDED blast radius → push the neighborhood).** ' +
        'Unlike augment, expand’s reach is one item, so the context is pushed ' +
        'in full rather than retrieved: the target item’s own ' +
        'summary/description, its EXISTING children if any (so the planner ' +
        'extends, never restates them — the same read-existing-children ' +
        'duplicate-avoidance Rovo uses), its parent chain (for goal context), ' +
        'and its blocking edges (so children don’t contradict the DAG). No ' +
        'global skeleton sweep, no broad search — the bounded neighborhood is ' +
        'enough, and pushing it keeps the job cheap and deterministic.\n\n' +
        'The planner emits children in the comet shape / Epic-2 grammar ' +
        '(7.3.3’s kind-parent matrix — a story’s children are subtasks/tasks/' +
        'bugs per the matrix), with structured-output self-validation. No ' +
        'write here; motir-core persists on approval via 7.1.6.\n\n' +
        'This handler is the engine the auto-suggested-expansion surface ' +
        '(7.4.7) and the manual "Expand" affordance (7.4.6) both drive — one ' +
        'job, two entry points.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `kind: expand_item` is registered; an `expand_item` job over a ' +
        'fixture stub returns an additions-only delta whose every child names ' +
        'the target as `parentKey` and is a legal child kind per the matrix.\n' +
        '- When the target already has some children, the proposed children ' +
        'EXTEND them (no restatement of an existing child).\n' +
        '- The bounded context (target + existing children + parent chain + ' +
        'blocking edges) is what’s pushed — no global skeleton sweep needed ' +
        'for this kind (asserted by the job’s read trace).\n' +
        '- Children self-validate against the kind-parent matrix; an illegal ' +
        'child kind fails the job cleanly with a taxonomy error.\n' +
        '- Expanding a target that is NOT a legal container (e.g. a subtask) ' +
        'is rejected with a clear typed error.\n\n' +
        '## Context refs\n\n' +
        '- 7.3.2 (the planning agent this reuses) + 7.3.3 (the comet shape + ' +
        'kind-parent matrix the children must satisfy).\n' +
        '- 7.1.6 — the read-back (for the target subtree + parent chain) + the ' +
        'persist callback.\n' +
        '- 7.1.4 — the handler registry.\n' +
        '- `motir-core/lib/issues/parentRules.ts` — the kind-parent matrix the ' +
        'children obey (which kinds a container may parent).\n' +
        '- 7.4.7 (auto-suggested expansion) — the second entry point this ' +
        'handler serves.',
      dependsOn: ['7.3.2', '7.1.6'],
    },
    {
      id: '7.4.4',
      title: '`replan` job — re-plan an epic/story treating completed work as IMMUTABLE',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Implement the `replan` job handler in motir-ai: given a target ' +
        'epic/story, re-plan its NOT-yet-done portion while treating every ' +
        'COMPLETED descendant as immutable, read-only context the new plan ' +
        'must build around. Registers in the 7.1.4 registry as `kind: ' +
        'replan`; reuses the 7.3.2 planning agent. This is the ' +
        'completion-aware operation — the one that makes the planner a steward ' +
        'of a partly-finished tree rather than a generator that rewrites ' +
        'history.\n\n' +
        '**Completed work is IMMUTABLE (the keystone).** A done leaf is a fact ' +
        'about the world (code merged, a decision made), not a proposal the ' +
        'planner may rewrite. So:\n\n' +
        '1. **Partition the subtree.** Read the target’s subtree via 7.1.6 and ' +
        'split it into LOCKED (every descendant whose status is in its own ' +
        'project’s `done` category — the per-project terminal classification ' +
        'finding #21 uses) and MUTABLE (everything else).\n' +
        '2. **Lock the done set into context.** The locked items enter the job ' +
        'as read-only context — their titles/outcomes inform the re-plan (the ' +
        'planner must build AROUND what shipped) but they are NOT candidates ' +
        'for change or deletion. The new plan re-shapes only the mutable ' +
        'portion.\n' +
        '3. **Enforce immutability on the delta.** The delta is VALIDATED ' +
        'before it leaves the job: any operation that would modify, re-parent, ' +
        'or delete a locked (terminal) item is REJECTED with a typed taxonomy ' +
        'error — both as a planner instruction AND as a hard post-check (the ' +
        'instruction reduces it; the post-check guarantees it). The persist ' +
        'side (7.4.5 / 7.1.6) re-asserts the same invariant as defense in ' +
        'depth — a done item is never mutated by a re-plan, even a buggy ' +
        'one.\n\n' +
        'Mirror: Rovo agents "operate inside Jira’s existing structures… ' +
        'approved agent updates are captured alongside the rest of the work ' +
        'item history" — the AI edits forward, it does not rewrite the shipped ' +
        'past. Re-plan depends on `augment` (7.4.2): it reuses augment’s ' +
        'tree-read + insertion machinery (a re-plan that ADDS work to the ' +
        'mutable portion is augment constrained to one subtree with the done ' +
        'set locked), so it builds on that handler rather than duplicating ' +
        'it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `kind: replan` is registered; a `replan` job over a fixture epic ' +
        'with some done + some not-done leaves returns a delta that changes ' +
        'ONLY the not-done portion and leaves every terminal-category ' +
        'descendant untouched.\n' +
        '- The subtree partition uses the per-project terminal classification ' +
        '(same source as readiness / finding #21), not a hard-coded status ' +
        'name.\n' +
        '- The delta is post-checked in the job: a (forced) delta that ' +
        'modifies/re-parents/deletes a locked item is REJECTED with a typed ' +
        'taxonomy error before it leaves motir-ai.\n' +
        '- The locked done items inform the re-plan (they’re in the planner’s ' +
        'context) but are never proposed for change.\n' +
        '- No write here; the approved delta persists via 7.1.6 (which ' +
        're-asserts the immutability invariant — 7.4.5).\n\n' +
        '## Context refs\n\n' +
        '- 7.4.2 (`augment`) — the tree-read + insertion machinery re-plan ' +
        'reuses (re-plan = augment constrained to one subtree + the done set ' +
        'locked).\n' +
        '- 7.3.2 (the planning agent) + 7.1.6 (the subtree read-back + persist ' +
        'callback) + 7.1.4 (the registry).\n' +
        '- `motir-core/lib/services/workItemsService.ts` + ' +
        '`workflowsService.getTerminalStatusKeysByProjects` — the per-project ' +
        'terminal classification that defines "done / locked" (finding #21).\n' +
        '- Story 7.0 (the readiness predicate uses the same terminal ' +
        'classification — re-plan’s lock set is the same notion of "done").',
      dependsOn: ['7.4.2'],
    },
    {
      id: '7.4.5',
      title:
        'motir-core augment / expand / re-plan APIs + services (submit, diff-review, persist via 7.1.6)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The motir-core side of the three operations: the routes + services ' +
        'that submit an `augment` / `expand_item` / `replan` job via the 7.1.5 ' +
        'client, surface its proposed delta for diff-review, and — on human ' +
        'approve — persist it through the 7.1.6 callback (which commits via ' +
        '`workItemsService`). 4-layer throughout (Route → Service → Repository ' +
        '→ Prisma; the cross-service hops go through the 7.1.5 client + the ' +
        '7.1.6 persist callback, never raw Prisma in a route).\n\n' +
        '- **`POST /api/ai/augment`** — body `{ projectKey, prompt }`; ' +
        'resolves the project, submits the `augment` job, returns `{ jobId }`; ' +
        'status/result fetched via the existing job-status surface (7.1.4 ' +
        '`GET /v1/jobs/:id` proxied through the 7.1.5 client). The service ' +
        'mints the job-scoped read-back token (7.1.5) so the planner’s tree ' +
        'read + FilterAST search run AS the requesting user.\n' +
        '- **`POST /api/ai/expand`** — body `{ projectKey, itemKey }`; submits ' +
        '`expand_item` for the target stub. Rejects a non-container target ' +
        '(404/422 per the matrix) before submitting.\n' +
        '- **`POST /api/ai/replan`** — body `{ projectKey, itemKey }`; submits ' +
        '`replan` for the target epic/story.\n' +
        '- **`POST /api/ai/plan-delta/approve`** — body `{ jobId, ' +
        'editedDelta? }`; persists the (optionally human-edited) delta through ' +
        'the 7.1.6 callback → `workItemsService`, honoring every 6.4 ' +
        'permission + the 404-not-403 tenant guard. **Re-asserts the re-plan ' +
        'immutability invariant** as defense in depth: a delta that would ' +
        'mutate/delete a terminal-category item is rejected here too (not just ' +
        'in the job), with a typed error → 422. Returns the created/updated/' +
        'unchanged keys for the diff surface to confirm.\n\n' +
        'A single `aiPlanEditsService` owns the submit + approve logic for all ' +
        'three kinds (they differ only in the job kind + the pre-submit ' +
        'validation); the diff/delta shape is shared (the 7.1.1 tree-delta ' +
        'envelope). No new write path — every mutation lands through the ' +
        'shipped `workItemsService`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The three submit routes each validate their body (zod), resolve the ' +
        'project (404-not-403 on cross-tenant), mint the job-scoped token, and ' +
        'return `{ jobId }`; `expand`/`replan` reject an illegal target before ' +
        'submitting.\n' +
        '- `approve` persists the delta through 7.1.6 → `workItemsService` ' +
        '(verified: no raw Prisma in the route; the same service the UI ' +
        'writes through), honoring 6.4 permissions, and returns the resulting ' +
        'keys.\n' +
        '- **Immutability re-asserted at persist:** an approve whose delta ' +
        'touches a terminal-category item → 422 typed error, nothing ' +
        'persisted.\n' +
        '- An empty/all-rejected delta is a valid no-op approve (persists ' +
        'nothing).\n' +
        '- 4-layer respected; the cross-service calls go through the 7.1.5 ' +
        'client; every route delegates to `aiPlanEditsService`.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.5 (the motir-core → motir-ai client + the job-scoped token it ' +
        'mints) + 7.1.6 (the persist callback through `workItemsService`).\n' +
        '- 7.3.4 — the generate-and-persist service this mirrors (submit job → ' +
        'stream → approve → persist); reuse its delta-review + approve ' +
        'plumbing.\n' +
        '- 7.4.2 / 7.4.3 / 7.4.4 — the three jobs these routes submit.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the persist ' +
        'authority + the terminal classification the immutability re-check ' +
        'reads.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['7.3.4'],
    },
    {
      id: '7.4.6',
      title:
        'Augment / expand / re-plan UI — the diff-review surface (locked completed work, approve)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the UI for the three operations EXACTLY as 7.4.1 specifies: the ' +
        'three entry points + the diff-review surface where the proposed delta ' +
        'is reviewed, per-item accepted/edited/removed, and approved (the Rovo ' +
        'accept-edit-remove-then-create review shape). Client components that ' +
        'call the 7.4.5 routes; never the service layer directly (the ' +
        'Server-Component / route split).\n\n' +
        '- **Entry points** (Panel 1): the "Augment from prompt" entry on the ' +
        'backlog/tree header, the "Expand" button on a childless stub row, the ' +
        '"Re-plan" overflow action on an epic/story. Each opens the review ' +
        'surface once its job result arrives (stream/poll the job via the ' +
        'existing status surface).\n' +
        '- **The diff-review surface** (Panels 2–4): renders the proposed ' +
        'delta as a diff — **added** items (with augment’s related-items ' +
        'provenance shown), **changed** items, and for re-plan the **locked** ' +
        'completed items in the kept-foundation tone (non-editable, the lock ' +
        'affordance from 7.4.1). Per-item accept / edit / remove; an ' +
        'approve-all. On approve, POST the (edited) delta to ' +
        '`/api/ai/plan-delta/approve`; on the 422 immutability rejection, ' +
        'surface the rejected-state message from 7.4.1 (a locked item can’t be ' +
        'changed — the UI should not have let it, but the message is the ' +
        'backstop).\n' +
        '- **i18n:** add the entry labels, the three diff-tone labels, the ' +
        'locked-row tooltip, the approve/reject copy, and the rejected-state ' +
        'message to an `aiPlanning` namespace (or extend 7.3’s). Locale = the ' +
        'app’s shipped set.\n\n' +
        'All colour through `--el-*` (locked = `--el-muted` + ' +
        '`--el-text-muted`; added = `--el-success` family; changed = ' +
        '`--el-info`/`--el-warning`), all shape through ' +
        '`[data-display-style]` tokens — no Tier-0 utilities (the ' +
        '`motir-core/CLAUDE.md` colour/shape rules). Compose ONLY the shipped ' +
        'primitives 7.4.1 named.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The three entry points appear exactly where 7.4.1 places them; ' +
        '"Expand" shows only on a childless container; "Re-plan" on an ' +
        'epic/story.\n' +
        '- The diff surface renders added / changed / locked with the three ' +
        '7.4.1 tones; locked (re-plan) rows are non-editable and read as ' +
        'kept-foundation, not destructive.\n' +
        '- Augment’s related-items provenance is shown on the proposed ' +
        'additions (the duplicate-avoidance story is visible).\n' +
        '- Per-item accept/edit/remove + approve-all work; approve persists ' +
        'via 7.4.5 and the surface confirms with the resulting keys.\n' +
        '- The 422 immutability rejection surfaces the 7.4.1 rejected-state ' +
        'message; no client component touches the service layer directly.\n' +
        '- Colour via `--el-*`, shape via `[data-display-style]` — no Tier-0 ' +
        'utilities; only shipped primitives composed.\n\n' +
        '## Context refs\n\n' +
        '- 7.4.1 — the design asset this implements (every panel).\n' +
        '- 7.4.5 — the routes this calls (submit + approve).\n' +
        '- 7.3.5 — the tree-review UI (preview/edit/approve) this extends; ' +
        'reuse its diff/preview primitives.\n' +
        '- `motir-core/app/globals.css` (the `--el-*` + `[data-display-style]` ' +
        'tokens) + `motir-core/CLAUDE.md` § colour / shape.',
      dependsOn: ['7.4.1', '7.4.5'],
    },
    {
      id: '7.4.7',
      title:
        'Auto-suggested expansion — nudge to expand stubs when the ready set drains (Principle #17)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Productize the ready-set-drain heuristic (Principle #17 — "the plan ' +
        'should keep itself runnable"): when the 7.0 ready set runs low ' +
        'because the remaining work is all coarse, un-decomposed stubs, ' +
        'SUGGEST expanding the next stub rather than leaving the human to ' +
        'notice the backlog has gone un-runnable. A thin surface over the ' +
        '`expand_item` job (7.4.3) — detect, nominate, one-click into the same ' +
        'expand→review→approve flow. NOT auto-expansion: the human still ' +
        'reviews and approves (generate → approve → persist holds; no plan ' +
        'mutation without review).\n\n' +
        '- **Detection (4-layer, read-only).** A service method that, for the ' +
        'active project, computes the ready-set size (reuse the shipped ' +
        '`workItemsService` readiness/`countReady` from 7.0 — do NOT re-derive ' +
        'readiness) and identifies expandable STUBS: childless epics/stories ' +
        'that are NOT themselves ready leaves (a container whose decomposition ' +
        'would replenish the ready set). The "low" threshold is a documented ' +
        'constant, not magic — and the nudge is suppressed when there’s ' +
        'nothing expandable (no false nag).\n' +
        '- **The nudge surface** (Panel 5 of 7.4.1): a dismissible banner/card ' +
        'on /ready (and/or the tree) — "the ready set is running low — expand ' +
        'PROD-12?" — that opens 7.4.6’s expand review for the nominated stub. ' +
        'Dismissal is respected (per-session / until the set changes); the ' +
        'nudge never blocks the page.\n\n' +
        '**Why a suggestion, not an automation.** Auto-expanding a stub the ' +
        'moment the ready set drains would mutate the plan without review — ' +
        'forbidden by Principle #3 (human approve before persist). The ' +
        'durable shape is: the system NOTICES and nominates; the human ' +
        'decides. (Same posture as Rovo: agents suggest, humans accept.)\n\n' +
        '## Acceptance criteria\n\n' +
        '- A service computes ready-set size via the shipped 7.0 readiness ' +
        '(no re-derivation) and nominates childless expandable stubs when the ' +
        'set is below the documented threshold.\n' +
        '- The nudge appears only when the set is low AND an expandable stub ' +
        'exists; it is suppressed (no false nag) otherwise.\n' +
        '- Clicking the nudge opens 7.4.6’s `expand_item` review for the ' +
        'nominated stub — it does NOT auto-create children (review + approve ' +
        'required).\n' +
        '- The nudge is dismissible and never blocks the page; dismissal is ' +
        'respected until the ready set changes.\n' +
        '- 4-layer: detection is a read-only service over the existing ' +
        'readiness; no Prisma in the route/component.\n\n' +
        '## Context refs\n\n' +
        '- 7.4.3 (`expand_item`) — the job the nudge drives.\n' +
        '- 7.4.5 — the expand submit route the nudge calls; 7.4.6 — the review ' +
        'surface it opens.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the shipped ' +
        'readiness / `countReady` (7.0) the detection reuses.\n' +
        '- `motir-core/design/ready/` + Story 7.0 (the /ready surface the ' +
        'nudge lives on) + 7.4.1 Panel 5 (the nudge design).',
      dependsOn: ['7.4.3', '7.4.5'],
    },
    {
      id: '7.4.8',
      title: 'Vitest — the three jobs + augment no-duplicate + re-plan immutability of done work',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Lock the three operations’ behavior — especially the two invariants ' +
        'that are easy to regress: augment NOT duplicating, and re-plan NOT ' +
        'touching done work. Vitest over a real Postgres on each side (the ' +
        'test convention — `tests/helpers/db.ts` truncates between tests; ' +
        'mirror it in motir-ai), no mocks beyond the single allowed ' +
        '`getSession()`.\n\n' +
        '**Job-handler tests (motir-ai), over a seeded fixture tree:**\n\n' +
        '- `augment` returns an additions-only delta whose every item names a ' +
        'legal existing `parentKey`; the delta self-validates against the ' +
        'kind-parent matrix; an illegal placement fails cleanly.\n' +
        '- **Augment no-duplicate:** a prompt that overlaps an existing story ' +
        'yields a delta that EXTENDS that neighborhood (children/siblings of ' +
        'the related item) — assert it does NOT create a parallel duplicate ' +
        'story; assert the planner consulted the FilterAST search (the result ' +
        'records the related hits).\n' +
        '- `expand_item` returns children all parented to the target, all ' +
        'legal child kinds; expanding a non-container is rejected; existing ' +
        'children are extended, not restated.\n' +
        '- **Re-plan immutability (the keystone):** over a fixture epic with ' +
        'done + not-done leaves, `replan` returns a delta touching ONLY the ' +
        'not-done portion; assert NO locked (terminal-category) item is ' +
        'modified/re-parented/deleted. A FORCED delta that targets a locked ' +
        'item is rejected by the job’s post-check with a typed taxonomy ' +
        'error.\n' +
        '- The partition uses the per-project terminal classification (a ' +
        'blocker that is terminal in ANOTHER project counts as done — the ' +
        'finding #21 cross-project case).\n\n' +
        '**Persist-side tests (motir-core, via 7.4.5):**\n\n' +
        '- `approve` commits the delta through `workItemsService` (assert via ' +
        'a repository read — the allowed cross-layer test reach), honors 6.4 ' +
        'permissions, returns the keys.\n' +
        '- **Immutability re-asserted at persist:** an approve whose delta ' +
        'touches a terminal item → 422, nothing persisted (defense in depth ' +
        'independent of the job check).\n' +
        '- Cross-tenant `projectKey` on any submit/approve route → 404 (not ' +
        '403).\n' +
        '- An empty/all-rejected delta approve is a valid no-op.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` (core) + the motir-ai suite run the above green over a ' +
        'real Postgres on each side; no mocks except `getSession()`.\n' +
        '- The augment no-duplicate case and the re-plan immutability case ' +
        'BOTH have a positive assertion (the invariant holds) AND a negative ' +
        '(a forced violation is rejected) — proving the guards actually fire.\n' +
        '- New core service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage).\n\n' +
        '## Context refs\n\n' +
        '- 7.4.2 / 7.4.3 / 7.4.4 (the jobs) + 7.4.5 (the persist side) — ' +
        'everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate.\n' +
        '- `workflowsService.getTerminalStatusKeysByProjects` — the terminal ' +
        'classification the immutability partition is asserted against.',
      dependsOn: ['7.4.5'],
    },
    {
      id: '7.4.9',
      title:
        'Playwright E2E — augment a backlog + expand a stub + re-plan, each reviewed & approved',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/ai-augment-replan.spec.ts`) over ' +
        'the seeded tenant with both services running (the dev-mode boundary, ' +
        'mirror the 7.3 E2E harness). Closes the three-operation promise from ' +
        'the user’s seat: each operation is submitted, REVIEWED in the diff ' +
        'surface, and APPROVED, and the tree changes correctly.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as the project manager (`zhuyue@motir.co`). Open a project ' +
        'that already has a generated tree.\n' +
        '2. **Augment.** Use "Augment from prompt" with a prompt that overlaps ' +
        'existing work. Wait for the job; the diff-review surface opens. ' +
        'Assert the proposed additions are placed UNDER / beside the related ' +
        'neighborhood (the provenance is shown) — not a duplicate parallel ' +
        'story. Approve → the new items appear linked into the right parent in ' +
        'the tree.\n' +
        '3. **Expand.** On a childless stub epic/story, click "Expand". Review ' +
        'the proposed children; approve → they appear as children of the ' +
        'stub.\n' +
        '4. **Re-plan (the completion-aware case).** On an epic with SOME done ' +
        'leaves, trigger "Re-plan". Assert the diff shows the done leaves as ' +
        'LOCKED (non-editable, kept-foundation tone) and proposes changes only ' +
        'to the not-done portion. Approve → the not-done portion changes; ' +
        'every done leaf is byte-identical afterward (assert the locked items ' +
        'are unchanged in the tree).\n' +
        '5. **Auto-suggested expansion (smoke).** Drive the ready set low (or ' +
        'use a seeded near-drained project); confirm the "expand the next ' +
        'stub" nudge appears and opens the expand review (step-3 flow) — ' +
        'without auto-creating children.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e ai-augment-replan` passes locally + in CI (the ' +
        'two-service dev harness reused from 7.3, not reinvented).\n' +
        '- Each of augment / expand / re-plan is submitted, reviewed in the ' +
        'diff surface, and approved; the tree reflects each change.\n' +
        '- The re-plan step asserts the locked done leaves are present, ' +
        'non-editable, and byte-identical after approve (the visible ' +
        'completion-aware guarantee).\n' +
        '- The augment step asserts non-duplication (placed into the related ' +
        'neighborhood with provenance shown).\n' +
        '- Uses the existing `signIn` helper + the existing job-status / ' +
        'streaming waits; not flake-prone (explicit waits on the job-complete ' +
        'and the diff-surface render).\n\n' +
        '## Context refs\n\n' +
        '- 7.4.6 (the diff-review UI) + 7.4.7 (the nudge) — the surfaces under ' +
        'test.\n' +
        '- Story 7.3 E2E (chat → generate → review → approve) — the harness + ' +
        'the two-service dev setup this mirrors.\n' +
        '- `motir-core/tests/e2e/` — the `signIn` helper + the established ' +
        'E2E patterns.',
      dependsOn: ['7.4.6'],
    },
  ],
};
