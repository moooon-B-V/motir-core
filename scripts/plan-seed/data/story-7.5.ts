import type { SeedStory } from '../types';

/**
 * Story 7.5 — Shared-context retrieval: plan-tree graph traversal + the
 * code-graph store. This is the **prompt-quality moat** of Epic 7 — the
 * thing that makes a generated plan (7.3) and an augment/re-plan (7.4) and a
 * dispatched prompt (7.6) actually GOOD, by feeding the planning agent rich,
 * on-demand context drawn from TWO explicit relational graphs walked over
 * tools.
 *
 * **The locked architecture (Epic-7 Principle #3, inherited — see story-7.1.ts
 * header for the full prose). Retrieval is GRAPH TRAVERSAL, NOT RAG.**
 *
 * 1. **No vector store anywhere.** There is no embedding index, no similarity
 *    search, no "flatten a graph into vectors because it's the default
 *    pattern." Context is reached by WALKING two relational graphs over typed
 *    read tools. This is the verified Atlassian-Rovo mirror: Rovo's Teamwork
 *    Graph does "a graph lookup instead of a vector dump" — when the data
 *    already has explicit relational structure (a PM tool's parent/child +
 *    blocking DAG; a codebase's call/import/inheritance edges), you query that
 *    structure directly rather than embedding it (MindStudio, "Atlassian Rovo
 *    Doubled Customer ARR Growth by Replacing RAG with a 20-Year-Old Knowledge
 *    Graph", 2026; Atlassian Engineering, "How Rovo Deep Research works",
 *    2026 — both VERIFIED via WebSearch this planning session, not asserted).
 *    Motir's plan is ALREADY such a graph (parent/child rollup + is_blocked_by
 *    DAG + comments), so it gets Rovo's model with no graph DB and no vectors.
 *
 * 2. **TWO graphs, one planner that is an MCP CLIENT of both.**
 *    - **The plan-tree graph** lives in motir-core. 7.1.6 shipped the cheap
 *      breadth read (the skeleton projection) + the persist callback. 7.5
 *      ENRICHES that read into a small family of graph-traversal tools the
 *      planning agent calls mid-job for DEPTH: `get_item` (with comments +
 *      history), `get_subtree`, `walk_blocking` (the is_blocked_by DAG),
 *      `skeleton`, and `search_work_items` (riding the SHIPPED 6.1.1 versioned
 *      FilterAST). All go through `workItemsService` read methods (4-layer),
 *      job-scoped-token-auth'd exactly like 7.1.6, never raw Prisma.
 *    - **The code graph** lives in motir-ai. It is `colbymchenry/codegraph`
 *      embedded AS A LIBRARY (SQLite + FTS5 structural graph — symbols + edges
 *      for calls/imports/inheritance; MCP tools search/explore/callers/callees/
 *      impact; 20+ languages; MIT; `npm i @colbymchenry/codegraph`, Node 22.5+
 *      `node:sqlite`; pre-1.0 at v0.9.9 — all VERIFIED against its GitHub
 *      README this session). 7.5 stands up the per-tenant store and indexes it
 *      from a **LOCAL FIXTURE repo** for dev/test; the live GitHub-read FEED
 *      (install + push/PR webhook → fetch → re-index) is explicitly 7.7's job,
 *      not 7.5's.
 *
 * 3. **A `spike` gates the codegraph adoption.** codegraph is pre-1.0
 *    (v0.9.9) and we are betting a core capability on it, so 7.5.3 is a
 *    `type: spike` (deps `[]`, `status: 'planned'`) that VALIDATES it
 *    server-side — embed as a library, index a repo, store per-tenant SQLite,
 *    query its tools at ~50-repo scale, and pin a version behind an interface
 *    we own — BEFORE 7.5.4 commits to the integration. If the spike fails the
 *    adoption test, 7.5.4's `CodeGraph` interface is the seam a different
 *    engine swaps in behind (no rewrite of the planner).
 *
 * 4. **Context scales by the operation's blast radius (Epic-7 Principle #2).**
 *    The whole graph is REACHABLE every job and TRANSMITTED never. The planner
 *    pulls the bounded neighborhood for expand/re-plan and uses skeleton +
 *    on-demand `search_work_items` / code-graph queries for unbounded augment.
 *    These tools ARE that on-demand retrieval surface.
 *
 * **What 7.5 is and is NOT.** 7.5 ships the RETRIEVAL surface both graphs
 * expose to the planner, and wires both into the 7.3.2 / 7.4 planning loop so
 * a planning job can call them mid-loop (the two-graph MCP-client shape). It
 * is NOT: the chat (7.2), the generation/augment ENGINES themselves (7.3/7.4 —
 * 7.5 enriches the context they already run on), per-type prompt generation
 * that INJECTS this context (7.6), or the GitHub App + webhook code-graph feed
 * (7.7). 7.4 deliberately does NOT hard-depend on 7.5 — augment runs on the
 * 7.1.6 skeleton + 6.1.1 search baseline and 7.5 enriches it later (the
 * resolved would-be forward dep, per the brief's dep map).
 *
 * **No user-facing UI → the design gate does not fire.** Every surface here is
 * a server-side read tool (motir-core internal endpoints) or an in-process
 * library call (motir-ai's embedded codegraph) consumed BY the planning agent,
 * never rendered to a browser. No `*.mock.html`, no `design/` subtask. (The
 * surfaces that DO render — the tree-review UI, the dispatch UI — are 7.3/7.6
 * and carry their own design cards.)
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** Every dep id is
 * same-epic backward/sideways: 7.1.6 (the read it enriches), 7.1.3 (motir-ai
 * DB the code-graph store hangs off), 7.3.2 (the planner loop 7.5.6 wires the
 * tools into), and the SHIPPED 6.1.1 FilterAST (`status: done`, story 6.1 <
 * 7.5 — satisfied). No forward-pointing dep: the GitHub feed that would point
 * at 7.7 is deliberately OUT of scope (7.5 indexes a local fixture). Status
 * rule: the spike (7.5.3, deps `[]`) is `'planned'`; everything chained behind
 * a not-yet-done 7.1.x / 7.3.2 / 7.5.x id is `'blocked'`.
 */
export const story_7_5: SeedStory = {
  id: '7.5',
  title: 'Shared-context retrieval (plan-tree graph + code graph)',
  status: 'planned',
  gitBranch: 'feat/PROD-7.5-shared-context-retrieval',
  descriptionMd:
    'The **shared-context retrieval layer** — the prompt-quality moat that ' +
    'makes generation (7.3), augment/expand/re-plan (7.4), and prompt ' +
    'dispatch (7.6) GOOD by feeding the planning agent rich, on-demand ' +
    'context from TWO explicit relational graphs walked over typed tools. ' +
    '**Retrieval is GRAPH TRAVERSAL, not RAG** — no vector store, no ' +
    'embeddings, no similarity search anywhere in Epic 7 (the verified ' +
    'Atlassian-Rovo Teamwork-Graph mirror: "a graph lookup instead of a ' +
    'vector dump"). Motir already HAS the graphs, so it gets Rovo\'s model ' +
    'with no graph DB and no vectors.\n\n' +
    '**The two graphs (locked, see the module header for the full ' +
    'rationale):**\n\n' +
    '- **The plan-tree graph** (motir-core) — 7.1.6 shipped the cheap ' +
    'skeleton read + the persist callback. 7.5 ENRICHES that into a family of ' +
    'graph-traversal read tools the planner calls mid-job for DEPTH: ' +
    '`get_item` (with comments + history), `get_subtree`, `walk_blocking` ' +
    '(the is_blocked_by DAG), `skeleton`, and `search_work_items` (riding the ' +
    'SHIPPED 6.1.1 versioned FilterAST). All go through `workItemsService` ' +
    "read methods (4-layer), job-scoped-token-auth'd like 7.1.6.\n" +
    '- **The code graph** (motir-ai) — `colbymchenry/codegraph` embedded AS A ' +
    'LIBRARY (SQLite + FTS5 structural graph: symbols + call/import/' +
    'inheritance edges; MCP tools search/explore/callers/callees/impact; 20+ ' +
    'languages; MIT; pre-1.0 at v0.9.9). 7.5 stands up the per-tenant store ' +
    'and indexes it from a **LOCAL FIXTURE repo** for dev/test; the live ' +
    "GitHub-read feed (webhook → fetch → re-index) is 7.7's job.\n\n" +
    'The planner becomes an **MCP client of BOTH graphs**: a planning job ' +
    '(7.3.2 generate_tree, 7.4 augment/expand/replan) calls plan-tree tools + ' +
    'code-graph tools mid-loop, pulling the bounded neighborhood for ' +
    'expand/re-plan and skeleton + on-demand search for unbounded augment ' +
    '(context scales by blast radius, Epic-7 Principle #2).\n\n' +
    '**Scope:** the plan-tree graph-traversal read tools (7.5.1); the ' +
    '`search_work_items` tool over 6.1.1 FilterAST (7.5.2); the codegraph ' +
    'adoption SPIKE (7.5.3); the `CodeGraph` interface + embedded codegraph ' +
    'indexed from a local fixture (7.5.4); the code-graph query tools exposed ' +
    'to the planner (7.5.5); wiring BOTH graphs into the planning loop ' +
    '(7.5.6); and the tests over the traversal tools + the fixture index ' +
    '(7.5.7).\n\n' +
    '**Out of scope (named so they land in their own stories, not here):** ' +
    'the chat (7.2); the generation/augment ENGINES (7.3/7.4 — 7.5 enriches ' +
    'the context they run on, it is not the engine); per-type prompt ' +
    'generation that INJECTS this retrieved context (7.6); the GitHub App + ' +
    'webhook code-graph FEED that replaces the local-fixture indexing with ' +
    'live repo reads (7.7); the planning-mistakes store (7.10). **7.4 does ' +
    'NOT hard-depend on 7.5** — augment runs on the 7.1.6 skeleton + 6.1.1 ' +
    'search baseline and 7.5 enriches it later (the resolved would-be forward ' +
    'dep).',
  verificationRecipeMd:
    '- Pull the Story branch; in `motir-core` run `pnpm install`, `pnpm ' +
    'prisma generate`, `pnpm db:seed`; in `motir-ai` run its install + ' +
    '`pnpm prisma generate` + `pnpm migrate` against the local docker ' +
    'Postgres (7.1.3).\n' +
    '- **Plan-tree traversal smoke (motir-core).** With a job-scoped token ' +
    'for the `PROD` project: `get_item` returns the item WITH its comments + ' +
    'status history; `get_subtree` returns an epic/story with its descendants ' +
    'bounded by a depth arg; `walk_blocking` returns the transitive ' +
    'is_blocked_by closure (and detects/handles a cycle without looping); ' +
    '`search_work_items` accepts a 6.1.1 FilterAST and returns matching keys. ' +
    "Every tool reads ONLY the token's project (404-not-403 cross-tenant, " +
    'finding #26) and goes through `workItemsService` (no raw Prisma in the ' +
    'route).\n' +
    '- **Code-graph smoke (motir-ai).** Index the checked-in LOCAL FIXTURE ' +
    'repo via the `CodeGraph` interface → a per-tenant SQLite graph is ' +
    'written under the motir-ai store; `search` finds a known symbol, ' +
    '`callers`/`callees` trace a known edge, `impact` returns the affected ' +
    'set, `explore` answers a structural question in one call. The pinned ' +
    'codegraph version is read from the interface, not scattered.\n' +
    '- **Two-graph planning loop (the integration keystone).** Submit a ' +
    'planning job (a 7.3.2 `generate_tree` over the fixture-backed project) → ' +
    'the job log shows the planner CALLED both plan-tree tools and ' +
    'code-graph tools mid-loop and folded their results into its context ' +
    'before emitting the tree-delta. No vector store is consulted (assert by ' +
    'absence — there is no embeddings table / similarity call anywhere).\n' +
    '- `pnpm test` (motir-core) + the motir-ai test suite — 7.5.7 covers the ' +
    'traversal tools (incl. the cycle case + the cross-tenant guard) over a ' +
    'real Postgres, and the codegraph index/query over the fixture.\n' +
    "- **Open-core boundary review (this Epic's recurring posture).** The " +
    'plan-tree tools live entirely in motir-core (no `motir-ai` import); the ' +
    'code graph lives entirely in motir-ai (motir-core never imports ' +
    'codegraph); browsers never call either; the planner reaches the plan ' +
    'tree ONLY through the job-scoped read-back, never a shared DB.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    "fails, comment with what didn't work and Motir will produce a follow-up " +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.5.1',
      title:
        'Plan-tree graph-traversal read tools — get_item / get_subtree / walk_blocking / skeleton (motir-core)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        "Enrich 7.1.6's minimal read-back into the plan-tree GRAPH-TRAVERSAL " +
        'tool family the planning agent walks for DEPTH. 7.1.6 shipped only ' +
        'the cheap breadth projection (the skeleton); 7.5.1 adds the depth ' +
        'reads a planner needs to actually understand a neighborhood, all ' +
        'over the SAME job-scoped-token auth + `workItemsService` (4-layer, ' +
        'read methods — never raw Prisma).\n\n' +
        'Add, under `app/api/internal/ai/*` (service-to-service, ' +
        "job-scoped-token-auth'd, never CORS-exposed):\n\n" +
        '- **`get_item`** — one work item by key, with optional ' +
        '`withComments` (the full comment thread) and `withHistory` (the ' +
        'status/field change log). Comments + history are the DEPTH signal a ' +
        'planner uses to understand WHY an item is shaped the way it is — the ' +
        'exact context 7.1.6 deliberately deferred to 7.5.\n' +
        '- **`get_subtree`** — an epic/story + its descendants, bounded by a ' +
        '`depth` arg (NO "load the whole tree" — bounded-neighborhood push, ' +
        'Epic-7 Principle #2). Returns the same skeleton-row shape per node ' +
        'so the planner can fold it into context cheaply.\n' +
        '- **`walk_blocking`** — the transitive `is_blocked_by` closure for ' +
        'an item (the DAG walk that powers "what must land before this"). ' +
        'MUST be cycle-safe (the DAG is enforced acyclic by the core, but the ' +
        'tool defends anyway — visited-set, never loops) and bounded by a ' +
        "max-depth/-node cap so a pathological graph can't exhaust the job.\n" +
        '- **`skeleton`** — the breadth projection 7.1.6 already returns, ' +
        'RE-EXPOSED here as a named tool in the same family so the planner ' +
        "has one coherent tool surface (7.1.6's endpoint stays; this is the " +
        'tool-shaped wrapper). No new query — it calls the same service read.\n\n' +
        '**4-layer.** Each tool is a thin route → a `workItemsService` read ' +
        'method (add `getItemWithContext`, `getSubtree`, `getBlockingClosure` ' +
        'as needed) → `workItemRepository` single-op reads (+ ' +
        '`commentRepository` / the history/activity repo for the depth ' +
        'reads). Reads only — no `tx`. Every read is tenant-gated by the ' +
        "token's project (404-not-403 on anything else, finding #26) and " +
        "permission-checked AS the token's user (the same posture 7.1.6 " +
        'established). Collections paginate / bound (a 10k-comment item or a ' +
        '500-node subtree must not be read whole — the scale check, finding ' +
        '#57): `withComments` is cursor-paginated, `get_subtree` is ' +
        'depth-bounded, `walk_blocking` is node-capped.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `get_item` returns the item; `withComments` adds the ' +
        '(cursor-paginated) comment thread; `withHistory` adds the change ' +
        'log — each via `workItemsService` read methods, no raw Prisma in the ' +
        'route.\n' +
        "- `get_subtree` returns an epic/story's descendants bounded by " +
        '`depth`; an unbounded request is rejected/clamped (no whole-tree ' +
        'read).\n' +
        '- `walk_blocking` returns the transitive is_blocked_by closure, is ' +
        'cycle-safe (a synthetic cycle terminates with a visited-set, never ' +
        'loops), and is node-capped.\n' +
        '- `skeleton` returns the 7.1.6 breadth projection unchanged, exposed ' +
        'as a named tool in the family.\n' +
        "- Every tool reads ONLY the token's project (cross-tenant → 404), " +
        'rejects a missing/expired/tampered token, and respects 6.4 ' +
        "permissions as the token's user.\n" +
        '- 4-layer respected throughout; the per-file coverage gate holds for ' +
        'new service/repo code.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/app/api/internal/ai/plan-tree/route.ts` + the 7.1.6 ' +
        'read-back — the minimal skeleton read this enriches (the same ' +
        'job-scoped-token auth + tenant guard).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the read authority ' +
        'these tools extend (add the context/subtree/closure read methods).\n' +
        '- `motir-core/lib/repositories/workItemRepository.ts` + the comment ' +
        '/ activity-history repositories — the single-op reads the depth ' +
        'tools compose.\n' +
        '- `motir-ai/docs/contract.md` (7.1.1) — the read-back tool envelope ' +
        'these new tools extend.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the 404-not-403 tenant guard.',
      dependsOn: ['7.1.6'],
    },
    {
      id: '7.5.2',
      title: '`search_work_items` planner read tool over the shipped 6.1.1 FilterAST (motir-core)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'The on-demand SEARCH tool the planner uses for unbounded augment — ' +
        '"find the work items related to X" without transmitting the whole ' +
        'tree. It rides the **SHIPPED 6.1.1 versioned FilterAST** (the same ' +
        'structured filter the 6.1 filter builder + saved filters consume), ' +
        'so the planner searches the plan with the EXACT predicate grammar ' +
        'the product already exposes to humans — one source of truth, no ' +
        'parallel query language invented for the AI.\n\n' +
        'Add `search_work_items` under `app/api/internal/ai/*` ' +
        "(job-scoped-token-auth'd, the 7.5.1 family). It accepts a 6.1.1 " +
        'FilterAST (validated against the versioned schema) + cursor ' +
        'pagination, resolves it through the shipped search service / ' +
        '`workItemsService` read path, and returns the matching work-item ' +
        'skeleton rows (the cheap projection — the planner pulls DEPTH via ' +
        "7.5.1's `get_item` only for the hits it cares about). Tenant-gated " +
        "to the token's project; permission-checked as the token's user.\n\n" +
        '**Why ride 6.1.1, not a new query path.** A bespoke AI search ' +
        'predicate would drift from what users can express and would need its ' +
        'own validation + pagination + tenant scoping. The 6.1.1 FilterAST is ' +
        'already versioned, already validated, already paginated, already ' +
        'tenant-safe. The planner is just another consumer of it — the same ' +
        'posture 7.0 took (the /ready endpoint vs. a parallel predicate). ' +
        '(6.1.1 is DONE/shipped, so its capability is available; but this ' +
        "card chains on 7.1.6's read-back surface + auth, which is NOT yet " +
        'done → `status: blocked`.)\n\n' +
        '## Acceptance criteria\n\n' +
        '- `search_work_items` accepts a versioned 6.1.1 FilterAST, validates ' +
        'it (a malformed/old-version AST → a typed taxonomy error), and ' +
        'returns matching skeleton rows, cursor-paginated.\n' +
        '- It resolves through the shipped 6.1.1 search path / ' +
        '`workItemsService` (no parallel query language; no raw Prisma in the ' +
        'route).\n' +
        "- Tenant-gated to the token's project (cross-tenant → 404); " +
        "permission-checked as the token's user; missing/expired token " +
        'rejected.\n' +
        '- Pagination is cursor-based (no "return all matches"); a large ' +
        'result set pages deterministically.\n' +
        '- 4-layer respected; the coverage gate holds for new code.\n\n' +
        '## Context refs\n\n' +
        '- The shipped 6.1.1 FilterAST + its search service (story 6.1, ' +
        '`status: done`) — the versioned predicate grammar this tool reuses.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the read path the ' +
        'filter resolves through.\n' +
        '- 7.5.1 — the sibling traversal tools sharing the same ' +
        'internal-route family + job-scoped-token auth.\n' +
        '- `motir-core/app/api/internal/ai/plan-tree/route.ts` (7.1.6) — the ' +
        'auth + tenant-guard pattern to mirror.',
      dependsOn: ['7.1.6'],
    },
    {
      id: '7.5.3',
      title:
        'Spike — validate `colbymchenry/codegraph` adoption (embed, index, store per-tenant, query at scale)',
      status: 'planned',
      type: 'spike',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        '**Type:** spike (a time-boxed adoption validation, NOT shippable ' +
        'product code — it produces a findings note + a go/no-go + a pinned ' +
        'version, and is thrown away or folded into 7.5.4). It GATES 7.5.4: ' +
        'we are betting a core Epic-7 capability (the code graph) on ' +
        '`colbymchenry/codegraph`, which is **pre-1.0 (v0.9.9 as observed on ' +
        'its GitHub README this planning session)**, so validate it BEFORE ' +
        'building the integration on it. `dependsOn: []`, `status: planned` — ' +
        'it can start immediately, in parallel with the plan-tree tools.\n\n' +
        '**What the README claims (VERIFIED this session, to confirm in ' +
        'code):** SQLite + FTS5 structural graph (symbols + edges for ' +
        'calls/imports/inheritance), MCP tools `search` / `explore` / ' +
        '`callers` / `callees` / `impact` / `node`, 20+ languages, MIT ' +
        'license, embeddable as a Node library via `npm i ' +
        '@colbymchenry/codegraph` (requires Node 22.5+ for the `node:sqlite` ' +
        'built-in), local-first store at `.codegraph/codegraph.db`.\n\n' +
        '**Validate, concretely:**\n\n' +
        '1. **Embed server-side as a LIBRARY** (not as a spawned MCP-server ' +
        'subprocess) — confirm the package exposes a programmatic API motir-ai ' +
        'can call in-process, and that the Node 22.5+ `node:sqlite` ' +
        'requirement is satisfiable on our motir-ai runtime (or pin the ' +
        'runtime / shim accordingly).\n' +
        '2. **Index a repo** — point it at a real checkout (the eventual ' +
        '7.5.4 fixture, or a small OSS repo) and confirm it produces the ' +
        'symbol+edge graph; spot-check `callers`/`impact` answers against ' +
        'hand-known truth.\n' +
        '3. **Store per-tenant SQLite** — confirm we can place the ' +
        "`.codegraph` DB per-repo/per-tenant under motir-ai's control (not a " +
        'single shared global DB) and re-open it for queries across process ' +
        'restarts.\n' +
        '4. **Query at ~50-repo scale** — index ~50 repos (or simulate the ' +
        'store footprint) and confirm query latency + disk footprint are ' +
        'acceptable for a multi-tenant service; note any per-repo memory/' +
        'handle ceiling.\n' +
        '5. **Pin a version behind an interface we own** — because it is ' +
        "pre-1.0, decide the EXACT version to pin and confirm 7.5.4's " +
        "`CodeGraph` interface fully hides codegraph's API so a future " +
        'breaking release (or a swap to a different engine) is a one-file ' +
        'change.\n\n' +
        'Record the outcome in `motir-ai/docs/spikes/codegraph-adoption.md`: ' +
        'go/no-go, the pinned version, the embedding mode, the per-tenant ' +
        'storage layout, the at-scale numbers, and any gotcha (the ' +
        '`node:sqlite` Node-version constraint, license confirmation, the ' +
        "MCP-tool surface we'll expose in 7.5.5). If NO-GO, the note names " +
        'the fallback engine the same `CodeGraph` interface would wrap ' +
        'instead.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/docs/spikes/codegraph-adoption.md` exists with a clear ' +
        'go/no-go, the pinned version, and the at-scale (~50-repo) ' +
        'observations.\n' +
        '- The embed-as-library path is proven (a throwaway script indexes a ' +
        'repo in-process and runs a `search` + `callers` + `impact` query) — ' +
        'or the note explains why not + names the fallback.\n' +
        '- Per-tenant SQLite storage is demonstrated (separate DBs, re-openable ' +
        'after restart), NOT a single shared global graph.\n' +
        '- The Node 22.5+ `node:sqlite` requirement + the MIT license are ' +
        'confirmed against the actual package; any runtime constraint is ' +
        "recorded as input to 7.1.3's runtime / 7.5.4.\n" +
        '- The note fixes the `CodeGraph` interface boundary 7.5.4 implements ' +
        '(so the pre-1.0 engine never leaks past it).\n\n' +
        '## Context refs\n\n' +
        '- `github.com/colbymchenry/codegraph` — the README (SQLite+FTS5 ' +
        'structural graph, MCP tools search/explore/callers/callees/impact, ' +
        '20+ langs, MIT, `npm i @colbymchenry/codegraph`, Node 22.5+ ' +
        '`node:sqlite`, pre-1.0 v0.9.9) — the engine under validation.\n' +
        '- This module header — the graph-traversal-not-RAG architecture the ' +
        'code graph must fit (no vector store).\n' +
        "- 7.1.3 — motir-ai's persistence foundation + runtime the embedded " +
        'engine runs inside.',
      dependsOn: [],
    },
    {
      id: '7.5.4',
      title:
        '`CodeGraph` interface + embed codegraph as a library, indexed from a LOCAL FIXTURE repo (motir-ai)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Stand up the code-graph STORE in motir-ai: a `CodeGraph` interface ' +
        'we own, implemented by `colbymchenry/codegraph` embedded as a ' +
        'library, with the per-tenant SQLite graph indexed from a **LOCAL ' +
        'FIXTURE repo** checked into the test corpus. This is the store that ' +
        "7.5.5's query tools read and that 7.7's GitHub feed later refreshes " +
        '— but 7.5 owns ONLY the local-fixture path (the live webhook feed is ' +
        'explicitly 7.7).\n\n' +
        '**The interface we own (the pre-1.0 seam from the 7.5.3 spike).** ' +
        'Define `lib/codegraph/CodeGraph.ts` — `indexRepo(aiProjectId, ' +
        'repoRef, srcDir)`, `search`, `explore`, `callers`, `callees`, ' +
        '`impact`, `node` (the MCP-tool surface codegraph exposes, projected ' +
        'into our types). The codegraph package is imported ONLY by the one ' +
        'adapter behind this interface (`lib/codegraph/codegraphAdapter.ts`), ' +
        'pinned to the EXACT version the spike chose; nothing else in motir-ai ' +
        'imports codegraph. A future engine swap or a codegraph breaking ' +
        "release is then a one-file change (the spike's explicit " +
        'requirement).\n\n' +
        '**Per-tenant storage.** Each indexed repo gets its OWN SQLite graph ' +
        'keyed by `(aiProjectId, repoRef)` — stored under a motir-ai-owned ' +
        "path (or as a `CodeRepo` row in motir-ai's Prisma DB from 7.1.3 " +
        'pointing at the SQLite file location), NOT a single shared global ' +
        'graph. Add a thin `CodeRepo` model `{ id, aiProjectId, repoRef, ' +
        'graphPath, indexedAt, codegraphVersion }` (the spine the 7.7 feed ' +
        "updates), with a repository + service mirroring motir-ai's " +
        'lightweight 4-layer (7.1.3).\n\n' +
        '**Local fixture.** Check a SMALL representative source tree into the ' +
        'test corpus (`motir-ai/tests/fixtures/codegraph-fixture/` — a handful ' +
        'of files with known symbols, calls, imports, and an inheritance edge ' +
        'across 2-3 languages codegraph supports). `indexRepo` over the ' +
        'fixture produces a queryable graph; this is the dev/test substitute ' +
        'for the real GitHub-fed index until 7.7. No network in this card — ' +
        'the fixture is on disk.\n\n' +
        '**Graph-traversal, not RAG.** This store holds a STRUCTURAL graph ' +
        '(symbols + call/import/inheritance edges in SQLite+FTS5). There is ' +
        'NO embedding step, NO vector column — consistent with the Epic-7 ' +
        'no-vector-store invariant.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lib/codegraph/CodeGraph.ts` defines the interface; ' +
        '`codegraphAdapter.ts` is the ONLY file importing ' +
        "`@colbymchenry/codegraph`, pinned to the spike's exact version.\n" +
        '- `indexRepo` over the checked-in fixture produces a per-tenant ' +
        'SQLite graph keyed by `(aiProjectId, repoRef)`; re-indexing replaces ' +
        'it idempotently.\n' +
        '- A `CodeRepo` model + repository + service (motir-ai 4-layer, 7.1.3 ' +
        'spirit) records the graph location + indexedAt + pinned version; the ' +
        'store is per-tenant, never a shared global graph.\n' +
        '- No vector store / embedding column anywhere — the graph is purely ' +
        'structural (the no-RAG invariant).\n' +
        '- No network in this card (the fixture is on disk); the live GitHub ' +
        'feed is deferred to 7.7 with a clear seam (the `CodeRepo` row + a ' +
        '`refresh` entry point the 7.7 webhook will drive).\n\n' +
        '## Context refs\n\n' +
        '- 7.5.3 — the adoption spike (the pinned version, embed mode, ' +
        'per-tenant layout, and `CodeGraph` interface boundary it fixes).\n' +
        "- 7.1.3 — motir-ai's Prisma foundation + `AiProject` spine the " +
        '`CodeRepo` rows hang off.\n' +
        '- `github.com/colbymchenry/codegraph` README — the library API + ' +
        'storage shape (`.codegraph/codegraph.db`, SQLite+FTS5).\n' +
        '- Story 7.7 (stub) — the GitHub-read FEED that will refresh this ' +
        'store on install + push/PR webhook (the seam 7.5.4 leaves).',
      dependsOn: ['7.5.3', '7.1.3'],
    },
    {
      id: '7.5.5',
      title:
        'Code-graph query tools (search / explore / callers / impact) exposed to the planner (motir-ai)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Expose the code graph as a TOOL surface the planning agent can call ' +
        "mid-job — the code-side analogue of 7.5.1's plan-tree tools. These " +
        "are in-process calls into 7.5.4's `CodeGraph` interface, wrapped as " +
        'planner tools with typed args/results and bounded output (the ' +
        'planner pulls structure on demand, never a whole-repo dump).\n\n' +
        "Expose codegraph's MCP-tool surface through our interface as planner " +
        'tools:\n\n' +
        '- **`code_search`** — find symbols by name (FTS5-backed).\n' +
        "- **`code_explore`** — codegraph's primary tool: answer a " +
        'structural question about the codebase in ONE call (the ' +
        'token-efficient entry point — prefer it over many small calls).\n' +
        '- **`code_callers` / `code_callees`** — trace the call graph in/out ' +
        'of a symbol (the is-blocked-by analogue for code: "what depends on ' +
        'this", "what does this depend on").\n' +
        '- **`code_impact`** — the affected set for a change (what a planner ' +
        'uses to scope a re-plan or size a story against the real code).\n\n' +
        '**Tenant + repo resolution.** Each tool takes the `aiProjectId` (+ ' +
        'optional `repoRef`) from the job context and resolves the right ' +
        'per-tenant SQLite graph via the 7.5.4 `CodeRepo` store — a job NEVER ' +
        "queries another tenant's graph. If no graph is indexed yet (a " +
        'start-fresh project before its first code lands), the tools return a ' +
        'clean "no code graph yet" result, not an error (the code graph ' +
        'activates once code exists — the two-project-kinds rule).\n\n' +
        '**Bounded output.** Results are capped/paginated (a 10k-symbol ' +
        "search or a huge impact set must not blow the planner's context — " +
        'the scale check). `explore` is the preferred single-call entry; the ' +
        'narrower tools page.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `code_search` / `code_explore` / `code_callers` / `code_callees` / ' +
        '`code_impact` are exposed as planner tools over the 7.5.4 ' +
        '`CodeGraph` interface, with typed args + bounded results.\n' +
        "- Each tool resolves the per-tenant graph from the job's " +
        '`aiProjectId` via the `CodeRepo` store; a job cannot reach another ' +
        "tenant's graph.\n" +
        '- An un-indexed project returns a clean "no code graph yet" result ' +
        '(not an error) — the start-fresh-before-code case.\n' +
        '- Output is capped/paginated; `explore` is documented as the ' +
        'preferred single-call entry point.\n' +
        '- No codegraph import leaks past the 7.5.4 adapter (these tools call ' +
        'the interface, not the package).\n\n' +
        '## Context refs\n\n' +
        '- 7.5.4 — the `CodeGraph` interface + per-tenant `CodeRepo` store ' +
        'these tools query.\n' +
        '- `github.com/colbymchenry/codegraph` README — the tool semantics ' +
        '(`explore` = one-call structural Q&A; `callers`/`callees`/`impact` = ' +
        'graph traversal) to mirror faithfully.\n' +
        '- 7.5.1 — the plan-tree tool family these mirror on the code side ' +
        '(same bounded-on-demand posture).',
      dependsOn: ['7.5.4'],
    },
    {
      id: '7.5.6',
      title:
        'Wire BOTH graphs into the planning loop — the planner as a two-graph MCP client (motir-ai)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The integration keystone: make the planning agent an MCP CLIENT of ' +
        'BOTH graphs, so a planning job (7.3.2 `generate_tree`, and the 7.4 ' +
        '`augment`/`expand_item`/`replan` jobs) can call plan-tree tools ' +
        '(7.5.1/7.5.2, over the 7.1.6 read-back) AND code-graph tools (7.5.5, ' +
        'in-process) mid-loop, folding the retrieved context into its ' +
        'reasoning before it emits a tree-delta.\n\n' +
        "Register the two tool families into the planning agent's tool " +
        'surface (the tool-use loop 7.3.2 established): the plan-tree tools as ' +
        'remote calls over the 7.1.6 read-back boundary (job-scoped token), ' +
        "the code-graph tools as in-process `CodeGraph` calls. The planner's " +
        'system framing tells it WHEN to reach for each (skeleton + ' +
        '`search_work_items` for breadth/unbounded augment; `get_item`/' +
        '`get_subtree`/`walk_blocking` for the bounded neighborhood; ' +
        '`code_explore`/`code_impact` to ground a plan against the real ' +
        "codebase) — context scales by the operation's blast radius " +
        '(Epic-7 Principle #2). The whole graph stays REACHABLE every job, ' +
        'TRANSMITTED never.\n\n' +
        '**No vector store — assert by construction.** This wiring adds tool ' +
        'calls into two relational graphs; there is NO embedding step, NO ' +
        'similarity retrieval anywhere in the loop. This is the architectural ' +
        'commitment the whole story exists to keep (the Rovo ' +
        'graph-traversal-not-RAG mirror).\n\n' +
        '**Bounded + observable.** A per-job budget caps tool-call count / ' +
        "depth so a job can't walk forever; the job stream emits which tools " +
        'the planner called (the 7.1.4 progress events) so a run is auditable ' +
        '(and so the verification recipe can ASSERT both graphs were ' +
        'consulted). This card WIRES the tools into the existing 7.3.2 loop; ' +
        'it does not change the generation strategy (7.3.3) or the augment ' +
        'engines (7.4) — it enriches the context they run on.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The 7.3.2 / 7.4 planning jobs can call the plan-tree tools (remote, ' +
        'job-scoped token) AND the code-graph tools (in-process) mid-loop; a ' +
        'job log shows both families exercised.\n' +
        "- The planner's framing routes breadth vs. depth vs. code-grounding " +
        'to the right tool (context scales by blast radius); the whole graph ' +
        'is reachable, never transmitted whole.\n' +
        '- A per-job tool-call/depth budget bounds the loop; the job stream ' +
        'emits the tools called (auditable).\n' +
        '- No vector store / embedding / similarity call anywhere in the loop ' +
        '(asserted by absence).\n' +
        '- This card does not alter the 7.3.3 generation strategy or the 7.4 ' +
        'engines — it adds the retrieval tool surface they consume.\n\n' +
        '## Context refs\n\n' +
        "- 7.3.2 — the planning agent's tool-use loop these tools register " +
        'into.\n' +
        '- 7.5.1 / 7.5.2 — the plan-tree tools (remote, over the 7.1.6 ' +
        'read-back).\n' +
        '- 7.5.5 — the code-graph tools (in-process, over the 7.5.4 ' +
        'interface).\n' +
        '- 7.1.4 — the job-stream progress events the tool-call audit rides.\n' +
        '- This module header — the two-graph MCP-client shape + the no-RAG ' +
        'invariant.',
      dependsOn: ['7.5.1', '7.5.5', '7.3.2'],
    },
    {
      id: '7.5.7',
      title: 'Vitest — plan-tree traversal tools + codegraph index/query over the fixture',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Lock the retrieval surface against regression on BOTH sides — the ' +
        'plan-tree traversal tools (motir-core, real Postgres) and the ' +
        'code-graph index/query over the local fixture (motir-ai). NOT browser ' +
        'E2E (there is no UI in 7.5).\n\n' +
        '**Plan-tree traversal tests** (motir-core, real Postgres per the ' +
        'test convention — `tests/helpers/db.ts` truncates between tests):\n\n' +
        '- `get_item` returns the item; `withComments` returns the ' +
        '(cursor-paginated) thread; `withHistory` returns the change log.\n' +
        '- `get_subtree` returns descendants bounded by `depth`; an ' +
        'over-deep/unbounded request is clamped/rejected (no whole-tree read).\n' +
        '- `walk_blocking` returns the transitive is_blocked_by closure; a ' +
        'SYNTHETIC cycle terminates via the visited-set (the explicit ' +
        'cycle-safety test) and the node cap holds.\n' +
        '- `search_work_items` resolves a valid 6.1.1 FilterAST to matching ' +
        'keys; a malformed/old-version AST → a typed taxonomy error.\n' +
        '- Tenant guard: a job-scoped token for project A cannot read project ' +
        'B via ANY tool (404-not-403); an expired/tampered token → 401.\n\n' +
        '**Code-graph tests** (motir-ai, over the checked-in fixture):\n\n' +
        '- `indexRepo` over the fixture produces a per-tenant SQLite graph; ' +
        're-index is idempotent (replaces, no duplication).\n' +
        '- `code_search` finds a known fixture symbol; `code_callers`/' +
        '`code_callees` trace a known call edge; `code_impact` returns the ' +
        'expected affected set; `code_explore` answers a known structural ' +
        'question — each asserted against hand-known fixture truth.\n' +
        "- Per-tenant isolation: a query for tenant A's repo never returns " +
        "tenant B's symbols.\n" +
        '- An un-indexed project returns the clean "no code graph yet" result, ' +
        'not an error.\n' +
        '- The codegraph package is imported ONLY by the 7.5.4 adapter (a ' +
        'grep/lint assertion that no test or other module imports it ' +
        'directly).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The motir-core specs pass over a real Postgres; no mocks except the ' +
        'allowed `getSession()` exception (`motir-core/CLAUDE.md`).\n' +
        '- The motir-ai specs index + query the fixture and assert against ' +
        'hand-known truth, incl. per-tenant isolation + the un-indexed case.\n' +
        '- The cycle-safety case and the cross-tenant guard each have an ' +
        'explicit failing-without-the-fix test.\n' +
        '- The per-file coverage gate holds for the new motir-core ' +
        'service/repo code (`motir-core/CLAUDE.md` § coverage).\n\n' +
        '## Context refs\n\n' +
        '- 7.5.1 / 7.5.2 (the plan-tree tools under test) + 7.5.4 / 7.5.5 ' +
        '(the code-graph store + tools under test).\n' +
        '- `motir-ai/tests/fixtures/codegraph-fixture/` — the checked-in ' +
        'fixture repo (7.5.4) the codegraph tests index.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + the coverage ' +
        'gate.',
      dependsOn: ['7.5.1', '7.5.4'],
    },
  ],
};
