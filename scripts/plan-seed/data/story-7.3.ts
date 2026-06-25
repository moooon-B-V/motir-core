import type { SeedStory } from '../types';

/**
 * Story 7.3 — Issue-tree generation (chat → real issues in the PM core). The
 * FIRST story where motir-ai produces actual plan content: the chat-discovered
 * direction (7.2) becomes a real epic→story→task tree committed into motir-core.
 * This is the planner-intelligence keystone — every later AI story (7.4 augment/
 * expand/re-plan, 7.5 retrieval enrichment, 7.6 prompt gen, 7.10 lessons) feeds
 * into or sharpens the generation loop 7.3 stands up.
 *
 * **What 7.3 is.** The `generate_tree` job: a tool-use planning SESSION hosted in
 * motir-ai that CONSUMES the 7.2 direction docs (vision / discovery /
 * feasibility) + the 7.1.6 skeleton read of the existing tree, REASONS in the
 * Motir issue grammar (the comet shape — a few epics, each fanning to stories,
 * each to tasks/subtasks), and EMITS a structured tree-DELTA. motir-core renders
 * that delta as a REVIEW surface (preview → edit → approve), and ON APPROVE
 * persists it through the shipped `workItemsService` via the 7.1.6 persist
 * callback. 7.3 is the engine + the review/approve surface that turns a
 * conversation into the project backlog.
 *
 * **The locked Epic-7 architecture this story inherits (full prose in
 * story-7.1.ts's header; restated here as it bears directly on generation):**
 *
 * 1. **One-directional writes — generate → human-approve → persist.** The AI
 *    NEVER writes the tree. motir-ai's `generate_tree` handler returns a delta
 *    as DATA; motir-core renders it, the human edits/approves it, and ONLY THEN
 *    does motir-core commit it through `workItemsService` (the 7.1.6 persist
 *    callback — every 6.4 permission + the 404-not-403 tenant guard applies
 *    unchanged). This is exactly the Atlassian-Rovo **AI Work Breakdown** mirror,
 *    VERIFIED (not asserted): Rovo "generates a number of suggested work items
 *    that you can edit and create"; you can "click on an issue before it's
 *    created and edit the fields" (incl. changing the work-item TYPE via the
 *    dropdown next to the type icon) and refine the whole set with a custom
 *    prompt; the issues only become real on approve. Motir ships that
 *    generate→customize→approve→auto-create loop as a first-class surface.
 *
 * 2. **A tool-use SESSION, not a one-shot completion.** Generation is a
 *    multi-step loop: read the direction docs, read the skeleton, draft a tree,
 *    self-validate against the grammar, revise. It runs as a 7.1.4 async job
 *    (`POST /v1/jobs` → `202 {jobId}`; status/stream), so progress streams into
 *    the 7.2 chat AND a headless planner can drive the same job. The handler
 *    interface `(job, ctx) => Promise<Result>` from 7.1.4 is the extension point;
 *    `generate_tree` REPLACES 7.1.7's `noop` middle with real planning while the
 *    rails (submit → worker → read tree → persist → succeeded) stay identical.
 *
 * 3. **Fresh-project scope — NO retrieval / code graph needed here.** 7.3
 *    generates the INITIAL tree for a project that, in the start-fresh case, has
 *    no code yet (the code graph activates only after the first dispatch produces
 *    code — 7.5/7.7). So `generate_tree` reads ONLY the 7.1.6 skeleton (breadth)
 *    + the 7.2 direction docs; it does NOT depend on the rich graph-traversal
 *    retrieval (7.5) or the FilterAST search (which 7.4 augment uses to avoid
 *    duplication). Those enrich generation LATER without re-shaping 7.3's
 *    contract — 7.5 wires its tools into the already-built `generate_tree` job.
 *
 * **What 7.3 is NOT (named so each lands in its own story, not here):**
 * - **Augment / expand-a-stub / completion-aware re-plan** (7.4) — placing NEW
 *   work into an EXISTING tree without duplicating, and re-planning around done
 *   work, are 7.4's jobs (`augment` / `expand_item` / `replan`), built ON 7.3.2.
 *   7.3 is whole-tree GENERATION from a direction; 7.4 is incremental editing.
 * - **Shared-context retrieval + code graph** (7.5) — comments/history graph
 *   traversal + the codegraph store enrich generation later; not needed for a
 *   fresh tree.
 * - **The planning-mistakes / lessons injection** (7.10) — the loop 7.3.2 builds
 *   is where 7.10 later injects learned lessons; 7.3 does not hard-depend on it.
 * - **Per-issue prompt generation + dispatch** (7.6) — generation produces the
 *   ISSUES; turning a ready issue into an agent prompt is 7.6.
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** Every 7.3 leaf depends only
 * on backward/sideways same-epic ids — 7.2.5 (the discovery job that writes the
 * direction docs generation reads), 7.1.5 (the core→ai client), 7.1.6 (the
 * read-back + persist callback), 7.1.7 (the noop whose handler `generate_tree`
 * replaces) — plus the design gate (7.3.1) it ships itself. No forward-pointing
 * dep on 7.4/7.5/7.6/7.10. Statuses follow the rule: the design subtask
 * (`dependsOn: []`) is `planned`; everything chained behind it or behind any
 * not-yet-done 7.1.x/7.2.x id is `blocked`.
 *
 * **The design gate fires (Principle #13).** 7.3 ships a real user-facing
 * surface — the generated-tree REVIEW/approve view. So the FIRST subtask (7.3.1)
 * is a `design` card producing `design/ai-planning/*.mock.html` +
 * `design-notes.md`, and EVERY UI-touching code subtask (7.3.5) depends on it and
 * is `blocked` behind it.
 */
export const story_7_3: SeedStory = {
  id: '7.3',
  title: 'Issue-tree generation (chat → real issues)',
  status: 'planned',
  gitBranch: 'feat/PROD-7.3-issue-tree-generation',
  descriptionMd:
    'Turn a chat-discovered direction into a REAL backlog: the planner agent ' +
    'reads the 7.2 direction docs + the existing tree skeleton, GENERATES a ' +
    'comet epic→story→task tree, and — after a human reviews, edits, and ' +
    'approves it — motir-core PERSISTS it as actual work items through the ' +
    'shipped `workItemsService`. This is the planner intelligence Story 7.1 ' +
    'built the rails for and Story 7.2 fed the direction into.\n\n' +
    '**The loop (locked — see the module header for the full rationale):**\n\n' +
    '- **generate** — motir-core submits a `generate_tree` job (the 7.1.4 ' +
    "async substrate; `generate_tree` replaces 7.1.7's `noop` handler). " +
    'motir-ai HOSTS the planning agent: it reads the direction docs (7.2) ' +
    '+ the 7.1.6 skeleton, drafts a tree in the Motir issue grammar, ' +
    'self-validates, and returns a structured tree-DELTA as data. Progress ' +
    'streams over the job stream into the chat.\n' +
    '- **review + edit** — motir-core renders the proposed delta as a ' +
    'previewable, EDITABLE tree (re-title, re-parent, change type, drop a ' +
    'node, refine the whole set with a follow-up prompt) BEFORE anything is ' +
    'written — the Rovo AI Work Breakdown shape (generate → customize).\n' +
    '- **approve → persist** — on approve, motir-core commits the (possibly ' +
    'edited) delta through the 7.1.6 persist callback → `workItemsService`. ' +
    '**The AI never writes the tree directly; write authority stays in ' +
    'core**, behind a human approve.\n\n' +
    '**Scope:** the review/approve surface design (7.3.1); the `generate_tree` ' +
    'job handler + structured tree-delta schema (7.3.2); the generation ' +
    'strategy/prompt — comet shape, the kind-parent grammar, self-validation ' +
    '(7.3.3); the motir-core generation API + generate-and-persist service ' +
    '(7.3.4); the tree-review UI (7.3.5); vitest (7.3.6); and the ' +
    'chat→generate→review→approve→issues E2E (7.3.7).\n\n' +
    '**Out of scope (named so they land in their own stories, not here):** ' +
    'augment / expand-a-stub / completion-aware re-plan (7.4, built on 7.3.2); ' +
    'rich graph-traversal retrieval + the code-graph store (7.5 — a fresh tree ' +
    'needs only the skeleton + direction docs); planning-mistakes injection ' +
    '(7.10); per-issue prompt generation + dispatch (7.6).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services locally (motir-core on ' +
    '`:3000`, motir-ai on its dev port, each pointed at the other), with the ' +
    '7.2 chat able to produce direction docs for the `PROD` project.\n' +
    '- **End-to-end happy path (the story).** From the chat front door, run a ' +
    'discovery pass so the three direction docs exist; trigger **Generate ' +
    'plan**. The `generate_tree` job drives `queued → running → succeeded`; ' +
    'progress streams in the chat. A proposed tree appears in the REVIEW ' +
    'surface — a comet shape (a handful of epics, each fanning to stories, ' +
    'each to tasks/subtasks) in the Motir grammar (epic root, story → epic, ' +
    'task/subtask under story). Edit one node (re-title it), change one ' +
    "node's type, delete one node, then **Approve**. The edited tree is " +
    'persisted; navigate to /issues and confirm the exact (edited) set of ' +
    'work items now exists, parented per the grammar, with NO node you ' +
    'deleted and the re-title applied.\n' +
    '- **Write authority stays in core.** Confirm the persist went through ' +
    '`workItemsService` (the 7.1.6 callback), NOT raw Prisma, and honored 6.4 ' +
    'permissions as the requesting user; a foreign-project job-scoped token is ' +
    '404, an expired one 401 (the 7.1.6 contract, re-exercised by generation). ' +
    'NOTHING is written before Approve — a generate-then-cancel run leaves ' +
    'zero new work items.\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.3.6 covers: the ' +
    '`generate_tree` handler over a fixture direction-doc set returns a ' +
    'grammar-valid delta; the delta self-validation rejects an illegal ' +
    'kind-parent edge; the generate-and-persist service commits an approved ' +
    'delta via `workItemsService` and a no-op (all-deleted) approval writes ' +
    'nothing; the edit-before-approve path persists the EDITED tree, not the ' +
    'original.\n' +
    '- **Grammar conformance.** The generated delta is checked against the ' +
    'kind-parent matrix (`prisma/sql/work_item_triggers.sql` / ' +
    '`lib/issues/parentRules.ts`): no story without an epic parent, no ' +
    'task/subtask orphaned, depth ≤ the 4-level cap. A deliberately malformed ' +
    "delta is rejected by the service BEFORE persist (it can't corrupt the " +
    'tree).\n' +
    "- **Open-core boundary review (this Epic's recurring posture).** No " +
    '`motir-ai` import in `motir-core` (HTTP only); motir-ai holds no ' +
    "connection to core's DB — it reaches the tree ONLY via 7.1.6; browsers " +
    'never call motir-ai. The planner LLM key (7.2.3) lives only on the ' +
    'motir-ai side.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    "fails, comment with what didn't work and Motir will produce a follow-up " +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.3.1',
      title:
        'Design — the generated-tree review/approve surface (preview → edit → approve→persist)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The tree-review UI (7.3.5) depends on this ' +
        'card; without it the review/approve surface would be improvised, ' +
        'which is forbidden (notes.html #31).\n\n' +
        'Produce the design asset for the **generated-tree review/approve** ' +
        'surface under `motir-core/design/ai-planning/`. Author it as a ' +
        '**`*.mock.html` mockup** built from the real design system (the ' +
        'shipped `components/ui/*` primitives + the `--el-*` colour tokens + ' +
        'the `[data-display-style]` shape tokens) — NOT a `.pen`. The HTML ' +
        'route is preferred when a coding agent produces the design (no ' +
        'translation gap; the reviewer sees the actual tokens). A PNG export ' +
        'is optional; the `.mock.html` is the source of truth (MOTIR.md ' +
        '§ Design-reference rule).\n\n' +
        '**Mirror (VERIFIED — Atlassian Rovo AI Work Breakdown).** Rovo ' +
        '"generates a number of suggested work items that you can edit and ' +
        'create"; before creation you can "click on an issue and edit the ' +
        'fields" and change a work item\'s TYPE via the dropdown next to the ' +
        'type icon, and refine the whole set with a custom prompt; the issues ' +
        "only become real on approve. Draw THAT loop, in Motir's comet-tree " +
        'grammar (Rovo breaks ONE item into a flat child list; Motir generates ' +
        'a multi-level epic→story→task TREE, so the review surface must render ' +
        'and let the user edit the HIERARCHY, not just a flat list).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the proposed tree (populated review state).** The ' +
        'generated delta rendered as an indented tree: epic → story → ' +
        'task/subtask, each row carrying an `IssueTypeIcon` (hued via ' +
        '`--el-type-*`), the proposed title, and a kind affordance. Make it ' +
        'unmistakable these are PROPOSED, not yet real (a "draft"/"not created ' +
        'yet" treatment via `--el-*` tints + copy — NOT a page-level tinted ' +
        'surface, finding #35). Show counts ("3 epics · 11 stories · 28 ' +
        'tasks").\n' +
        '- **Panel 2 — editing a node inline.** A node selected for edit: ' +
        're-title (an input on `--radius-input`), CHANGE TYPE (a dropdown next ' +
        'to the type icon — the Rovo affordance, constrained to grammar-legal ' +
        'kinds for that parent), re-parent, and a per-node DELETE (exclude ' +
        'from the approved set). Show the "add a node" affordance too (the ' +
        'human can insert a story the AI missed).\n' +
        '- **Panel 3 — the refine-with-a-prompt entry.** A prompt box ("Make ' +
        'the auth epic more granular", "drop the mobile work for now") that ' +
        're-runs `generate_tree` with the current tree + the instruction as ' +
        'context and returns a revised delta (generate → customize, the Rovo ' +
        'custom-prompt step). Show the streaming/working state while it ' +
        'regenerates.\n' +
        '- **Panel 4 — the approve bar + confirmation.** The footer action ' +
        '("Approve & create N issues") with the live count, a secondary ' +
        '"Discard", and the post-approve confirmation (toast / inline ' +
        '"Created 42 issues" with a link into /issues). Make explicit that ' +
        'approve is the ONLY thing that writes.\n' +
        '- **Panel 5 — generating (in-flight) + empty/error states.** The ' +
        'streaming "Generating your plan…" state (progress from the job ' +
        'stream), the empty state (no direction docs yet → link to the 7.2 ' +
        'chat), and the failed-job state (a clear retry, NOT a half-written ' +
        'tree).\n\n' +
        'Also write **`design/ai-planning/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings, the placement ' +
        'decisions, the per-`--el-*` colour role for each element (incl. the ' +
        '"proposed/draft" tint role and the per-kind `--el-type-*` hues), and ' +
        'a "primitives composed (no hand-rolling)" checklist (the ' +
        '`design-notes.md` convention 1.3.3 / 1.5.1 / 7.0.1 established).\n\n' +
        '**Branch.** `design/PROD-7.3.1-tree-review-surface`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits `design/ai-planning/**`, ' +
        'no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/ai-planning/tree-review.mock.html` exists, ' +
        'renders the five panels above, and references ONLY `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- `motir-core/design/ai-planning/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` ' +
        'role (incl. the proposed-vs-real treatment and the per-kind hues).\n' +
        '- The hierarchy (epic→story→task) is editable in the mock, not just a ' +
        'flat list — the type-change dropdown is constrained to grammar-legal ' +
        'kinds, and per-node delete + the refine-prompt entry are both drawn.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`IssueTypeIcon`, `Button`, `Combobox`/`DropdownMenu`, `EmptyState`, ' +
        'the toast) — if a genuinely new primitive is needed, that is a NEW ' +
        '`design/` subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ready/` (7.0.1) + `motir-core/design/work-items/` ' +
        '— the closest existing design areas; mirror their layout + ' +
        '`design-notes.md` shape.\n' +
        '- `motir-core/components/issues/IssueTypeIcon.tsx` — per-kind icon + ' +
        'hue (the `--el-type-*` mapping the tree rows use).\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx`, the `DropdownMenu`/`Combobox` primitive — the ' +
        'composable surface.\n' +
        '- `motir-core/lib/issues/parentRules.ts` — the kind-parent matrix the ' +
        'type-change dropdown must respect.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (the swap layer the mock ' +
        'references).',
      dependsOn: [],
    },
    {
      id: '7.3.2',
      title: 'The `generate_tree` job handler (motir-ai) + the structured tree-delta schema',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Implement the `generate_tree` job handler in motir-ai — the planner ' +
        "intelligence that REPLACES 7.1.7's `noop` middle with real " +
        'generation, keeping the same rails (submit → worker → read tree → ' +
        'return delta → core persists). Registered against the 7.1.4 handler ' +
        'interface `(job, ctx) => Promise<Result>` for `kind: generate_tree` ' +
        "(reserved in 7.1.1's `jobKind` enum).\n\n" +
        '**The handler is a tool-use SESSION (Principle #2), not a one-shot ' +
        "completion.** On run it: (1) reads the project's **direction docs** " +
        "(vision / discovery / feasibility) from motir-ai's own store (7.2.4, " +
        'written by the 7.2.5 discovery job); (2) reads the existing-tree ' +
        '**skeleton** via the 7.1.6 read-back `GET /api/internal/ai/plan-tree` ' +
        '(job-scoped token) — for a fresh project this is empty/near-empty, ' +
        'which the handler treats as "generate from scratch"; (3) drafts a ' +
        'tree in the Motir grammar; (4) self-validates the draft against the ' +
        'grammar (7.3.3 owns the strategy/prompt + the validator); (5) returns ' +
        'the **tree-DELTA** as the job result. It does NOT persist — persist is ' +
        'core-side behind a human approve (7.3.4).\n\n' +
        '**The structured tree-delta schema (the load-bearing contract).** ' +
        'Define the delta as a versioned, structured-output shape the LLM must ' +
        'emit and core can persist directly — a list of proposed nodes, each ' +
        '`{ tempId, kind (epic|story|task|subtask|bug), title, descriptionMd, ' +
        'parentTempId | null, priority?, contextRefs? }`, plus top-level ' +
        '`deltaVersion`. `tempId`/`parentTempId` model the NEW hierarchy ' +
        'before real keys exist (core resolves temp ids → real keys at ' +
        'persist). It carries NO write authority — it is data core chooses to ' +
        "commit. (This is the same delta shape 7.4's augment/expand/replan " +
        'jobs reuse — design it as the shared output contract, not ' +
        'generation-specific glue.)\n\n' +
        '**Structured output, not free text.** The handler uses the Anthropic ' +
        'SDK + the planner model fixed by 7.2.2, with tool-use / structured ' +
        'output so the model returns the delta as DATA conforming to the ' +
        'schema (no markdown-scraping). Stream progress events over the 7.1.4 ' +
        'job stream (the chat consumes them: "Drafting epics…", "Breaking down ' +
        'the auth epic…").\n\n' +
        '**Fresh-project scope.** Reads ONLY the direction docs + the skeleton ' +
        '— NO 7.5 retrieval, NO code graph (the start-fresh project has no ' +
        'code yet; the graph activates after the first dispatch). 7.5 later ' +
        'wires richer tools INTO this handler without changing its contract.\n\n' +
        "**Layering.** motir-ai mirrors core's layering lightly (7.1.3): the " +
        'handler orchestrates a direction-docs repository read (7.2.4) + the ' +
        'core read-back client + the LLM call; no business logic inlined in the ' +
        'job-dispatch glue.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `generate_tree` handler is registered for `kind: generate_tree` ' +
        'and replaces the `noop` stub in the registry; submitting a ' +
        '`generate_tree` job drives `queued → running → succeeded` with the ' +
        'delta in the result.\n' +
        "- The handler reads the project's direction docs (7.2.4) + the 7.1.6 " +
        'skeleton (job-scoped token) before drafting; a missing direction-doc ' +
        'set fails the job cleanly with a taxonomy error (not a hallucinated ' +
        'tree).\n' +
        '- The returned delta conforms to the versioned tree-delta schema ' +
        '(`tempId`/`parentTempId` hierarchy, kind ∈ the grammar, ' +
        '`deltaVersion`), and is emitted via structured output / tool-use — ' +
        'never scraped from prose.\n' +
        '- Progress events stream over the 7.1.4 job stream during the run.\n' +
        '- No 7.5 retrieval / code-graph dependency is introduced; the handler ' +
        'reads only direction docs + skeleton.\n' +
        '- No persist happens in the handler — it returns the delta as data ' +
        '(persist is 7.3.4, behind human approve).\n\n' +
        '## Context refs\n\n' +
        '- 7.1.4 — the job substrate + handler registry + job stream (the ' +
        'extension point).\n' +
        '- 7.1.7 — the `noop` handler this replaces (same rails).\n' +
        '- 7.1.6 — the read-back `GET /api/internal/ai/plan-tree` skeleton ' +
        'projection the handler reads.\n' +
        '- 7.2.4 / 7.2.5 — the `DirectionDoc` store + the discovery job that ' +
        'writes vision/discovery/feasibility (the generation input).\n' +
        '- 7.2.2 / 7.2.3 — the planner model decision + the provisioned ' +
        'Anthropic key the handler authenticates with.\n' +
        '- 7.3.3 — the generation strategy/prompt + the delta self-validator ' +
        'this handler invokes.\n' +
        '- `motir-ai/docs/contract.md` (7.1.1/7.1.9) — the envelope + the ' +
        'tree-delta result shape.',
      dependsOn: ['7.2.5', '7.1.7', '2.7.3'],
    },
    {
      id: '7.3.3',
      title: 'Generation strategy + prompt — comet shape, the Motir issue grammar, self-validation',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The brains of `generate_tree`: the prompt/strategy that makes the ' +
        'planner produce a GOOD tree in the right shape, plus the deterministic ' +
        'self-validator that guarantees the emitted delta is grammar-legal ' +
        'before it ever reaches core. Split from 7.3.2 (the handler/plumbing) ' +
        'because the strategy is where the planning QUALITY lives and is the ' +
        'piece 7.10 later injects lessons into.\n\n' +
        '**The comet shape.** The system/strategy prompt instructs the planner ' +
        'to produce a tree that is broad-then-deep like a comet — a SMALL head ' +
        'of epics, each fanning to stories, each to tasks/subtasks — NOT a flat ' +
        'list and NOT one mega-epic. It plans to real-product COMPLETENESS ' +
        '(durable shape, not a demoable happy path — finding #57: "how would ' +
        'the mirror product scope this?") while narrowing SCOPE ruthlessly per ' +
        'the direction docs. It must NEVER assume an unfit default the ' +
        'discovery (7.2) explicitly settled.\n\n' +
        '**The Motir issue grammar (the kind-parent matrix).** The prompt ' +
        'encodes the legal hierarchy — epic = root; story → epic; ' +
        'task/subtask → {story, task, bug}; depth ≤ the 4-level cap — sourced ' +
        'from the SAME rules core enforces (`lib/issues/parentRules.ts` / ' +
        '`prisma/sql/work_item_triggers.sql`), so the planner draws inside the ' +
        'lines core will enforce at persist. Each node gets a real title + a ' +
        'descriptionMd in the house style (the seed cards are the few-shot ' +
        'exemplar: description + acceptance-criteria shape).\n\n' +
        '**Self-validation (deterministic, NOT another LLM call).** A pure ' +
        'validator runs over the emitted delta and REJECTS / asks the model to ' +
        'revise on: an illegal kind-parent edge, an orphaned non-epic, a depth ' +
        'over the cap, a dangling `parentTempId`, a duplicate `tempId`, an ' +
        'empty title. The loop re-prompts on a validation failure (bounded ' +
        'retries) so a malformed draft never becomes the job result. This is ' +
        "the planner's OWN gate; core re-validates independently at persist " +
        '(7.3.4) — defense in depth, the AI is never trusted to be ' +
        'well-formed.\n\n' +
        '**Refine-with-a-prompt.** The strategy also handles the 7.3.1 Panel-3 ' +
        'case: given the CURRENT tree + a human instruction ("make the auth ' +
        'epic more granular"), produce a revised delta — the Rovo custom-prompt ' +
        'refinement step. Same validator gates the revision.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The strategy prompt produces a comet-shaped tree (epics → stories → ' +
        'tasks/subtasks) grounded in the direction docs, not a flat list or a ' +
        'single mega-node — demonstrated over a fixture direction-doc set.\n' +
        '- The kind-parent grammar in the prompt matches ' +
        '`lib/issues/parentRules.ts` exactly (single source — referenced, not ' +
        're-stated divergently); depth ≤ the cap.\n' +
        '- The deterministic self-validator rejects every illegal-edge / ' +
        'orphan / over-depth / dangling-parent / duplicate-tempId / ' +
        'empty-title case and triggers a bounded re-prompt; a delta that still ' +
        'fails after retries fails the job cleanly (never returns a malformed ' +
        'delta).\n' +
        '- The refine path takes the current tree + an instruction and returns ' +
        'a revised, re-validated delta.\n' +
        '- The strategy is a discrete, testable module (prompt + validator) ' +
        'the 7.3.6 suite drives directly and 7.10 can later inject lessons ' +
        'into.\n\n' +
        '## Context refs\n\n' +
        '- 7.3.2 — the handler that invokes this strategy + the tree-delta ' +
        'schema it validates against.\n' +
        '- `motir-core/lib/issues/parentRules.ts` + ' +
        '`motir-core/prisma/sql/work_item_triggers.sql` — the kind-parent ' +
        'matrix + the 4-level cap (the grammar source of truth).\n' +
        '- `motir-core/scripts/plan-seed/data/story-7.0.ts` / `story-7.1.ts` — ' +
        'the house card style the node descriptions emulate.\n' +
        "- The repo's claude-api guidance — the Anthropic SDK structured-output " +
        '/ tool-use pattern the strategy emits through.\n' +
        '- Story 7.10 (stub) — the lessons store that later injects learned ' +
        "planning lessons into this strategy's system context.",
      dependsOn: ['7.3.2'],
    },
    {
      id: '7.3.4',
      title:
        'Generation API + generate-and-persist service (motir-core) — submit, stream, approve→persist',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The motir-core side of generation: the API + service that SUBMIT a ' +
        '`generate_tree` job, STREAM its progress to the chat/UI, and — on a ' +
        'human approve — PERSIST the (possibly edited) delta through the 7.1.6 ' +
        'callback → `workItemsService`. This is the generate → human-approve → ' +
        'persist seam (Principle #1; the Rovo "customize and approve, then ' +
        'auto-create" mirror).\n\n' +
        '**4-layer (motir-core/CLAUDE.md).** Routes parse + call ONE service ' +
        'method; the service owns the orchestration; writes go through ' +
        '`workItemsService` (never raw Prisma in a route).\n\n' +
        '- **`POST /api/ai/plan/generate`** (session auth, tenant-gated) — ' +
        'resolves the active project, submits a `generate_tree` job via the ' +
        '7.1.5 client (minting the job-scoped read-back token), returns the ' +
        '`{ jobId }`. The job is the unit the UI polls/streams.\n' +
        '- **`GET /api/ai/plan/generate/:jobId/stream`** — proxies the 7.1.4 ' +
        'job stream (SSE) to the browser so the review surface shows live ' +
        'progress; on terminal, the proposed delta is available via the job ' +
        'result. (Browsers stream from CORE, never from motir-ai — the ' +
        'open-core invariant.)\n' +
        '- **`POST /api/ai/plan/approve`** — body carries the APPROVED delta ' +
        '(the human-edited tree from 7.3.5, which MAY differ from what the ' +
        'model proposed: re-titled, re-typed, nodes removed/added). The service ' +
        '**re-validates** the delta against the kind-parent grammar ' +
        "INDEPENDENTLY of the planner's self-check (defense in depth — the " +
        'client-submitted delta is never trusted), then commits it through the ' +
        '7.1.6 persist callback → `workItemsService`, resolving `tempId`s → ' +
        'real keys + linking parents per the grammar, applying every 6.4 ' +
        'permission + the 404-not-403 tenant guard as the session user. ' +
        'Returns the created keys. An all-deleted / empty delta is a valid ' +
        'no-op (writes nothing).\n\n' +
        "**Re-validate on approve, don't re-generate.** Approve persists " +
        'EXACTLY the human-approved tree — it does NOT re-call the planner ' +
        '(that would discard the human edits). The only generation re-entry is ' +
        'the explicit refine-with-a-prompt action (7.3.1 Panel 3 / 7.3.3), ' +
        'which is a fresh `generate_tree` submit, not part of approve.\n\n' +
        '**Atomicity.** The whole approved delta persists in ONE transaction ' +
        "(via `workItemsService`'s own transaction boundary) — a partial tree " +
        'is never committed; on any node failure the whole approve rolls back ' +
        'and surfaces a typed error.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `POST /api/ai/plan/generate` submits a `generate_tree` job (with a ' +
        'freshly minted job-scoped token) and returns `{ jobId }`; ' +
        '`…/:jobId/stream` proxies job progress to the browser.\n' +
        '- `POST /api/ai/plan/approve` re-validates the submitted delta against ' +
        'the grammar (rejecting a malformed/illegal-edge delta with a typed ' +
        '400 BEFORE any write), then persists via `workItemsService` ' +
        '(verified: no raw Prisma in the route), resolving temp ids → keys + ' +
        'parent links, and returns the created keys.\n' +
        '- The approved (human-edited) delta is what persists — re-titled / ' +
        're-typed / node-removed edits are honored; approve does NOT re-call ' +
        'the planner.\n' +
        '- The whole approve is atomic (one transaction); a node-level failure ' +
        'rolls the whole thing back, writing nothing.\n' +
        '- An empty / all-deleted delta is a valid no-op (returns `[]`, writes ' +
        'nothing) — same no-op contract 7.1.6/7.1.7 established.\n' +
        '- Session + tenant gate on all three routes (401 no session; ' +
        '404-not-403 cross-tenant); 6.4 permissions honored as the session ' +
        'user; 4-layer respected throughout.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.5 — the core→ai client + the job-scoped token mint.\n' +
        '- 7.1.6 — the persist callback (`POST /api/internal/ai/plan-delta`) ' +
        'committing through `workItemsService`; the read-back skeleton.\n' +
        '- 7.3.2 — the `generate_tree` job + the tree-delta schema this ' +
        'submits/persists.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the create/update ' +
        'authority + its transaction boundary the delta commits through.\n' +
        '- `motir-core/lib/issues/parentRules.ts` — the grammar the ' +
        'approve-side re-validation enforces.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['7.1.5', '7.1.6'],
    },
    {
      id: '7.3.5',
      title: 'Tree-review UI (motir-core) — preview the delta, edit, approve→persist',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the review/approve surface EXACTLY as 7.3.1 specifies — the ' +
        'human-in-the-loop step where a generated tree becomes (after edits + ' +
        'approve) the real backlog. This is the Rovo AI Work Breakdown moment ' +
        "rendered in Motir's comet-tree grammar.\n\n" +
        '**Generate + stream.** From the chat / a "Generate plan" entry, kick ' +
        '`POST /api/ai/plan/generate` and subscribe to `…/:jobId/stream`, ' +
        'showing the in-flight "Generating your plan…" state (7.3.1 Panel 5) ' +
        'with live progress from the job stream. On terminal, render the ' +
        'proposed delta as the editable tree (Panel 1).\n\n' +
        '**Edit the hierarchy (NOT a flat list).** Render the delta as an ' +
        'indented epic→story→task tree (reuse the shipped tree-view primitives ' +
        'where they fit; do NOT re-invent the tree widget). Per node: re-title ' +
        '(inline input), change TYPE (a dropdown constrained to grammar-legal ' +
        "kinds for that node's parent — the Rovo type-change affordance), " +
        're-parent, DELETE (exclude from the approved set), and ADD a node the ' +
        'AI missed. The edited tree is held in client state until approve — ' +
        'NOTHING is written while editing.\n\n' +
        '**Refine with a prompt (Panel 3).** A prompt box that submits a fresh ' +
        '`generate_tree` (current tree + instruction) and replaces the ' +
        'proposed tree with the revised delta — the Rovo custom-prompt step.\n\n' +
        '**Approve (Panel 4).** "Approve & create N issues" posts the ' +
        'human-edited delta to `POST /api/ai/plan/approve`; on success, the ' +
        'confirmation ("Created 42 issues" + a link into /issues) and the ' +
        'surface clears. **Approve is the only thing that writes** — the copy ' +
        'makes that explicit so the user is never surprised.\n\n' +
        '**Tokens + a11y.** References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 utilities — the ' +
        '`motir-core/CLAUDE.md` colour/shape rules); per-kind icons via ' +
        '`IssueTypeIcon` (`--el-type-*`); the "proposed/draft" treatment via ' +
        '`--el-*` tints (NOT a page-level tinted surface, finding #35). Keyboard ' +
        'reachable; the type-change dropdown + per-node delete have aria-labels; ' +
        'the streaming region is an `aria-live` polite area. **i18n:** new ' +
        '`aiPlanning` namespace for all copy (the same locale set the app ' +
        'ships).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The surface kicks generation, streams progress (Panel 5), then ' +
        'renders the proposed delta as an editable epic→story→task TREE (Panel ' +
        '1) — composed of the named 7.3.1 primitives, `--el-*` tokens only.\n' +
        '- Per node: re-title, change-type (grammar-constrained dropdown), ' +
        're-parent, delete, and add-a-node all work and mutate ONLY client ' +
        'state — nothing is persisted before approve.\n' +
        '- The refine prompt (Panel 3) re-runs generation and swaps in the ' +
        'revised tree.\n' +
        '- "Approve & create" posts the EDITED delta to ' +
        '`/api/ai/plan/approve`; on success the Panel-4 confirmation shows the ' +
        'created count + a link to /issues, and a generate-then-discard run ' +
        'persists nothing.\n' +
        '- Empty state (no direction docs) links to the 7.2 chat; the ' +
        'failed-job state offers retry, never a half-written tree.\n' +
        '- A11y: keyboard-reachable controls, aria-labelled type/delete ' +
        'affordances, an `aria-live` streaming region; no client component ' +
        'touches the service layer directly (it calls the 7.3.4 endpoints).\n\n' +
        '## Context refs\n\n' +
        '- 7.3.1 — the design asset (the five panels this implements ' +
        'verbatim).\n' +
        '- 7.3.4 — the generate / stream / approve endpoints this consumes.\n' +
        '- `motir-core/components/issues/IssueTypeIcon.tsx` — per-kind icon + ' +
        'hue.\n' +
        '- The shipped tree-view / `useRowWindow` primitives (the issues tree ' +
        '/ 7.0.6 list) — the tree widget to reuse, not re-invent.\n' +
        '- `motir-core/lib/issues/parentRules.ts` — the grammar the ' +
        'type-change dropdown constrains to.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + shape tokens.',
      dependsOn: ['7.3.1', '7.3.4'],
    },
    {
      id: '7.3.6',
      title: 'Vitest — generation job + delta validation + approve/persist path',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the generation loop with tests on both sides. motir-core tests ' +
        'run over a real Postgres (the project convention; `tests/helpers/db.ts` ' +
        'truncates between tests; the only allowed `vi.mock` is `getSession()`). ' +
        'The motir-ai LLM call is stubbed at the SDK boundary with recorded ' +
        'fixture deltas (no live model in CI) — but the delta SCHEMA, the ' +
        'self-validator, and the persist path are exercised for real.\n\n' +
        '**motir-ai — `generate_tree` handler + strategy:**\n\n' +
        '- Over a fixture direction-doc set + a fixture/empty skeleton, the ' +
        'handler returns a delta conforming to the versioned tree-delta schema ' +
        '(`tempId`/`parentTempId` hierarchy, grammar-legal kinds).\n' +
        '- The deterministic self-validator (7.3.3) REJECTS each malformed ' +
        'case — illegal kind-parent edge, orphaned non-epic, over-depth, ' +
        'dangling `parentTempId`, duplicate `tempId`, empty title — and the ' +
        'bounded re-prompt fires; an un-fixable draft fails the job cleanly ' +
        '(never returns a malformed delta).\n' +
        '- A missing direction-doc set fails the job with a taxonomy error (no ' +
        'hallucinated tree).\n' +
        '- The refine path takes a current tree + an instruction and returns a ' +
        're-validated revised delta.\n\n' +
        '**motir-core — generate-and-persist service + endpoints:**\n\n' +
        '- `POST /api/ai/plan/approve` persists an approved fixture delta ' +
        'through `workItemsService` (assert via a repository read — the allowed ' +
        'cross-layer test reach): the right work items exist, parented per the ' +
        'grammar, temp ids resolved to keys.\n' +
        '- The approve-side re-validation rejects a malformed / illegal-edge ' +
        'delta with a 400 BEFORE any write (DB unchanged) — independent of the ' +
        "planner's self-check.\n" +
        '- The EDITED delta persists, not the original: a delta with a node ' +
        'removed + one re-titled + one re-typed yields exactly that set.\n' +
        '- An empty / all-deleted delta is a valid no-op (writes nothing, ' +
        'returns `[]`).\n' +
        '- Atomicity: a delta with one node forced to fail rolls the WHOLE ' +
        'approve back (no partial tree).\n' +
        '- Auth: 401 without session; 404 on a cross-tenant project; 6.4 ' +
        'permissions honored.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass on both sides; the motir-core suite runs over a ' +
        'real Postgres (no mocks beyond `getSession()`); the motir-ai suite ' +
        'stubs only the LLM SDK boundary.\n' +
        '- A deliberately malformed delta is rejected by BOTH the planner ' +
        'self-validator (motir-ai) AND the approve-side re-validation ' +
        '(motir-core) — proving defense-in-depth is real, not asserted.\n' +
        '- New motir-core service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); no untested branch in the ' +
        'generate-and-persist service.\n\n' +
        '## Context refs\n\n' +
        '- 7.3.2 / 7.3.3 (the handler + strategy + validator under test), 7.3.4 ' +
        '(the service + endpoints under test).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the persist ' +
        'authority asserted against.\n' +
        '- `motir-core/lib/issues/parentRules.ts` — the grammar both ' +
        'validators check.',
      dependsOn: ['7.3.4'],
    },
    {
      id: '7.3.7',
      title: 'Playwright E2E — chat → generate → review → approve → real issues appear',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/ai-plan-generation.spec.ts`) ' +
        "closing the story from the user's seat: a chat-discovered direction " +
        'becomes real, reviewed-and-approved issues in the PM core. To keep CI ' +
        'deterministic, the planner job is backed by a RECORDED fixture delta ' +
        '(the same boundary stub 7.3.6 uses — no live LLM in CI), so the test ' +
        'asserts the UI loop + the real persist, not model quality.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` (the project manager) on the seeded ' +
        '`moooon`/`motir` tenant; ensure the `PROD` project has its three 7.2 ' +
        'direction docs present (seed/fixture).\n' +
        '2. Trigger **Generate plan**. Assert the streaming "Generating your ' +
        'plan…" state (Panel 5) appears, then resolves to the proposed tree ' +
        '(Panel 1) — a comet shape with epics → stories → tasks, the counts ' +
        'header rendered, and a clear "not created yet" treatment.\n' +
        "3. EDIT the tree: re-title one node, change one node's TYPE via the " +
        'dropdown (assert it offers only grammar-legal kinds), and DELETE one ' +
        'node. Assert no /issues change yet (nothing persisted while ' +
        'editing).\n' +
        '4. Click **Approve & create**. Assert the Panel-4 confirmation shows ' +
        'the created count and a link into /issues.\n' +
        '5. Navigate to /issues; assert the EXACT edited set now exists: the ' +
        're-titled node carries the new title, the re-typed node the new kind, ' +
        'the deleted node is ABSENT, and the hierarchy is parented per the ' +
        'grammar (epic→story→task).\n' +
        '6. **Nothing-before-approve branch:** run a second generation, edit, ' +
        'then **Discard** — return to /issues and assert NO new items appeared ' +
        '(approve is the only write).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e ai-plan-generation` passes locally + in CI, backed by ' +
        'the recorded fixture delta (no live model).\n' +
        '- The spec uses the existing `signIn(page, email, password)` helper ' +
        '(no new auth plumbing) and the established peek/navigation patterns.\n' +
        '- The streaming, edit (re-title / change-type / delete), approve, and ' +
        'discard steps all assert correctly; the type-change dropdown is shown ' +
        'to offer only grammar-legal kinds.\n' +
        '- After approve, the exact edited tree exists in /issues; after ' +
        'discard, nothing was written.\n' +
        '- Not flake-prone: explicit waits on the `aria-live` streaming region ' +
        'and on the post-approve confirmation (no fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 7.3.5 (the UI under test), 7.3.4 (the endpoints), 7.3.2 (the job + ' +
        'the fixture-delta boundary the E2E stubs at).\n' +
        '- `motir-core/tests/e2e/ready.spec.ts` (7.0.8) — the E2E patterns ' +
        '(sign-in helper, peek, aria-live waits) to mirror.\n' +
        '- `motir-core/scripts/plan-seed/` — the seeded tenant + how to ' +
        'fixture the direction docs for the run.',
      dependsOn: ['7.3.5'],
    },
    {
      id: '7.3.8',
      title: 'Explanation generation — opt-in project setting honored by the generator',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        'Make AI-drafted **explanations** an opt-in project setting (the ' +
        'user-confirmed feature 6). The `work_item.explanationMd` field + the ' +
        '`explanationSource` enum (`user_authored | ai_draft | user_edited`) ' +
        'ALREADY exist (Story 1.4 / the AI-draft seam) — this subtask adds the ' +
        'toggle + makes the generator honor it. **Default OFF**: generation ' +
        'leaves `explanationMd` null. **When ON**: every generated work item ' +
        'also drafts its `explanationMd` (the "why this matters" prose) with ' +
        '`explanationSource: ai_draft`, so the user can later edit it ' +
        '(→ `user_edited`).\n\n' +
        'Add a `Project.aiGenerateExplanations` boolean column (default ' +
        '`false`) + migration HERE — owning the column in 7.3 keeps it ≤ the ' +
        'generation that reads it (no forward dep on Story 7.11, which only ' +
        'SURFACES this toggle in the AI-settings panel, 7.11.6). The ' +
        '`generate_tree` handler (7.3.2) reads the flag through the job ' +
        'envelope and conditionally emits the explanation per node; the ' +
        '7.3.4 persist maps it onto each created item with the `ai_draft` ' +
        'source.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `Project.aiGenerateExplanations` boolean column (default `false`) ' +
        '+ migration, modelled per `motir-core/CLAUDE.md`.\n' +
        '- With the flag OFF (default), a generated tree carries NO ' +
        'explanations (`explanationMd` null on every node).\n' +
        '- With the flag ON, every generated node carries an `explanationMd` ' +
        'with `explanationSource: ai_draft`; a later human edit flips it to ' +
        '`user_edited` (existing behavior, unchanged).\n' +
        '- The flag crosses the 7.1 boundary in the generate job envelope ' +
        '(motir-ai never reads motir-core config directly); 4-layer respected.\n' +
        '- A unit test covers both flag states; the column default backfills ' +
        'every existing project to OFF.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/prisma/schema.prisma` — `work_item.explanationMd` + ' +
        '`WorkItemExplanationSource` (the existing field this honors) + ' +
        '`model Project` (where the toggle column lands, beside ' +
        '`estimationStatistic`).\n' +
        '- 7.3.2 / 7.3.4 — the generate handler + persist this flag gates.\n' +
        '- Story 7.11 (7.11.6) — the AI-settings panel that surfaces this ' +
        'toggle (backward consumer; not a dep of this card).',
      dependsOn: ['7.3.4'],
    },
  ],
};
