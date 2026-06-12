import type { PlanStory } from '../types';

/**
 * Summary-level (subtasks-deferred) stories: Epics 3–8 (Epic 2 is fully
 * expanded — 2.6 became data/story-2.6.ts). Each is `planned` with no leaf items
 * yet — they get expanded to full subtask depth (their own data/story-*.ts
 * module) when the ready set drains, per the async-expansion rule. Transcribed
 * from the epic-*.html cards.
 */
export const STUB_STORIES: PlanStory[] = [
  // ── Epic 3: Boards ─────────────────────────────────────────────────────────
  // Epic 3 is fully expanded — every story is a data/story-3.*.ts module
  // (3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 3.8), assembled in index.ts; no Epic-3 stubs
  // remain. The Scrum board (formerly Story 3.4) moved to Epic 4 as Story 4.5
  // per `notes.html` mistake #32 — see `data/story-4.5.ts`.

  // ── Epic 4: Agile planning ────────────────────────────────────────────────
  // 4.1 (Sprint + backlog data model), 4.2 (Backlog UI), 4.3 (Story-point
  // estimation), and 4.4 (Sprint lifecycle — start/complete) are fully expanded
  // — data/story-4.1.ts, data/story-4.2.ts, data/story-4.3.ts, data/story-4.4.ts.
  // 4.5 is the Scrum board (formerly Story 3.4) — fully expanded as
  // data/story-4.5.ts. Moved here from Epic 3 per `notes.html` mistake #32.
  // 4.6 (Velocity + burndown charts) is fully expanded as data/story-4.6.ts —
  // read-only over the 4.1 sprint / 4.3 points / 1.4.6 revision data (no new
  // write model); fills the chart seams Story 4.5 (scrum header) + Story 4.4.6
  // (sprint report) reserved, and introduces the reusable SVG chart primitive
  // Story 6.3 reuses.
  // 4.7 is the Epic-4 cross-cutting AT-SCALE test story (the Scrum analogue of
  // Story 3.5) — fully expanded as data/story-4.7.ts. Re-scoped on deepening to
  // its non-duplicative remainder (the per-story siblings 4.1.5/4.2.6/4.3.7/
  // 4.4.7/4.5.4 each own their surface in isolation): the combined Scrum journey
  // at scale on a large active sprint. See data/story-4.7.ts.

  // ── Epic 5: Collaboration & fields ────────────────────────────────────────
  // 5.1 (Comments + @mentions) is fully expanded — data/story-5.1.ts. Its
  // expansion also ADDED the 5.7 stub below (in-app notification center): Jira
  // notifies mentions in-app as well as by email, and no story owned that
  // surface (a no-V1-tier ownership gap, fixed at plan time); 5.1.6's job
  // events are channel-agnostic so 5.7 fans in off the same events.
  // 5.2 (Attachments) is fully expanded — data/story-5.2.ts. Reuses the 2.3.7
  // upload primitive per finding #52; adds the workItemId link, the panel UI,
  // the embeds-are-attachments link-on-write, and the orphan-GC job.
  // 5.3 (Custom fields) is fully expanded — data/story-5.3.ts. Five types
  // (text/number/date/select/user), typed-EAV values (the Jira storage shape)
  // carrying the documented Epic-6 predicate contract, Fields admin in project
  // settings, rail rendering with "Show more fields".
  // 5.4 (Labels, components, watchers) is fully expanded — data/story-5.4.ts.
  // Project-scoped label folksonomy (a recorded deviation from Jira's global
  // pool — the scoping its users ask for), company-managed-shaped components
  // w/ default-assignee-at-create + move-or-remove delete, watchers w/ the
  // eye control + auto-watch + watcher emails on comment/transition (mention-
  // deduped, actor excluded) riding the 5.1.6 events.
  // 5.5 (Activity history feed) is fully expanded — data/story-5.5.ts. NO new
  // write model: renders the existing 1.4.6 revision trail (a TOTAL diff-
  // renderer registry w/ fallback + explicit noise suppression), adds the
  // Jira-verified All/Comments/History tabs with the one cross-tab sort
  // toggle, and the bounded two-source All merge. Activates the History seam
  // 5.1 ships disabled.
  // 5.6 (Tests) is fully expanded — data/story-5.6.ts. Re-scoped on deepening
  // (the 3.5/4.7 precedent) to its non-duplicative remainder now that every
  // 5.x story carries its own closing test subtask: the combined cross-story
  // collaboration journey (the seams between stories) + the collaboration-
  // heavy loaded-issue fixture and its bounded-read/bounded-DOM at-scale
  // specs + the full-page strict a11y sweep. Epic 5 is now fully expanded
  // except the 5.7 stub below.
  {
    id: '5.7',
    title: 'In-app notifications (bell + unread feed)',
    status: 'planned',
    descriptionMd:
      'The in-app half of the notification surface (5.1.6 ships the email half): a bell in the ' +
      'shell header with an unread count, a notification feed (mentions first; watcher / ' +
      'assignment / transition events as Stories 5.4 + 6.6 land), mark-read / mark-all-read, ' +
      'deep links into issues, and per-user notification preferences (email vs in-app — the ' +
      'Jira personal-notification-settings shape). Consumes the SAME channel-agnostic job ' +
      'events 5.1.6 / 5.4 emit (`work-item/comment.created`, `work-item/mentioned`, …) — a ' +
      'notification persistence model fed by a job, never a second emit path. Added during the ' +
      '5.1 expansion: Jira notifies mentions in-app as well as by email, and no story owned ' +
      'that surface (the no-V1-tier rule: an unowned capability is a planning bug, not a scope ' +
      'cut).',
    items: [],
  },

  // ── Epic 6: Search, reporting & admin ─────────────────────────────────────
  // 6.4 (Roles & permissions) shipped early — data/story-6.4.ts, done.
  // 6.1 (Structured search + filter builder) is fully expanded —
  // data/story-6.1.ts. A flat Match-all/any builder delivering exactly the
  // operators Jira's basic search blacklists to JQL (negation, empty,
  // comparisons, OR) without a query language; a TOTAL per-field-type
  // operator registry compiling to parameterized-only WHERE fragments that
  // feed BOTH the List and the ancestor-retaining Tree; versioned ?filter=v1:
  // URL serialization (the substrate 6.2 saved filters persist); Epic-5
  // predicates via the 5.3.1/5.4.1 documented join contracts.
  // 6.7 (Tests) is fully expanded — data/story-6.7.ts. Re-scoped on deepening
  // (the 3.5/4.7/5.6 precedent) to the non-duplicative remainder — 6.1.6 owns
  // filter compilation + injection, 6.4.8 (done) owns the level × role
  // matrix, and the 6.2/6.3/6.5/6.6/6.8 expansions below each carry their own
  // closing test subtask (their cards must point the epic-wide journey at
  // 6.7, the 6.1.6 note as template). 6.7's remainder: the combined Epic-6
  // journey (build a filter → save it → back a widget → gate a viewer → fire
  // a rule, plus the unwind) + the reporting-shaped 10k time-spread corpus
  // with indexed-search / SQL-aggregation / exactly-once-rule-storm at-scale
  // specs + the combined admin-hub a11y sweep. Deps use story-level ids for
  // the unexpanded siblings (the 2.6.x precedent; retargetable on expansion).
  // 6.2 (Saved filters) is fully expanded — data/story-6.2.ts. A
  // project-contained `saved_filter` persisting the 6.1.1 versioned FilterAST
  // envelope (one codec, two carriers), with the Jira-verified Save/Save-as
  // ownership split, private/project visibility on the 6.4 roles (the
  // six-scope share model is the recorded deviation), starring + a filters
  // directory, preset-schedule email subscriptions on the 1.6 cron substrate,
  // built-in system filters, and the documented resolve-by-id data-source
  // contract + delete-dependents warning that 6.3 dashboards consume (boards
  // stay status-mapped — team-managed family, the 3.1/3.6 decision).
  // 6.3 (Dashboards & reports) is fully expanded — data/story-6.3.ts.
  // Workspace-level dashboards at the shipped /dashboard route (Jira-verified
  // site-level shape; named grids, access private|workspace, 1/2/3-column
  // layouts + dnd, 20-widget cap) whose widgets are backed by a 6.2 saved
  // filter or a project through the 6.2.1 resolve-by-id contract, behind a
  // TOTAL widget-type registry (filter-results ≤50/page / distribution /
  // created-vs-resolved); + the /reports hub (agile links + the two analysis
  // reports). Charts grow the 4.6.2 token-aware SVG layer (donut +
  // difference/area); "resolved" = the done-category transition derived from
  // the 1.4.6 trail (the 4.6.3 pattern); per-VIEWER 6.4 gating on every
  // widget read; 6.3.1 fills 6.2.1's reserved widget-dependents line.
  // 6.5 (Project admin surface) is fully expanded — data/story-6.5.ts. The
  // unified Jira-shaped settings AREA (verified: a grouped settings nav, not
  // a card hub; lands on Details, which owns identity + the danger zone): a
  // TOTAL settings-nav registry re-housing Workflow / Boards / Estimation /
  // Members / Fields / Components behind one chrome at the existing routes,
  // `/settings/project` becomes the read-only Details landing (+ re-homed
  // Archive danger zone) that Story 6.8 grows with editing + the key change;
  // 6.6 mounts via a reserved Automation slot. Features / Notifications /
  // Apps deviations recorded with justifications.
  // 6.6 (Automation rules) is fully expanded — data/story-6.6.ts. The
  // when/then engine, Jira-verified: trigger → flat 6.1-FilterAST condition
  // group → ordered actions through the SHIPPED services as the rule owner
  // (recorded actor deviation), async via the 1.6 pipeline, with the
  // Jira-default loop prevention (provenance-stamped events never re-fire
  // rules), the 90-day audit log, 10-consecutive-failure auto-disable +
  // owner error email, and bounded caps. Mounts in the 6.5 settings area's
  // reserved Automation slot; adds the `work-item/created` +
  // `work-item/field.changed` events the 5.7 stub anticipates.
  // 6.8 (Edit project details + change project key) is fully expanded —
  // data/story-6.8.ts. Grows the 6.5.3 read-only Details landing into the
  // editable surface (name, preset-icon+colour avatar, key); the key change
  // is one FOR-UPDATE-locked atomic tx (a single bulk identifier rewrite,
  // numbers preserved) + a NEW project_key_alias table giving the VERIFIED
  // Jira split: old issue URLs 308-redirect to canonical, old-key API calls
  // serve, old keys stay reserved with reclaim-by-revert + the Cloud-style
  // release-with-confirm. UI deps point backward at 6.5.1/6.5.3; the
  // backend (6.8.1/6.8.2) is independent. This is the capability the 8.7
  // rebrand cutover consumes — PROD-vs-NIF becomes a reversible setting.

  // ── Epic 7: AI Planning Layer ─────────────────────────────────────────────
  // 7.1 (Core ↔ AI API contract + motir-ai persistence foundation) is fully
  // expanded — data/story-7.1.ts. Added 2026-06-11 (the Epic-7 architecture
  // discussion with Yue). It fixes the locked boundary every 7.x story rides:
  // one-directional WRITES (AI proposes a tree-delta, motir-core persists via
  // workItemsService — write authority stays in core); a tool-use SESSION not
  // a one-shot call (motir-ai HOSTS the planning agent, emits read requests,
  // graph-traversal-not-RAG — the Rovo mirror); an ASYNC job model serving
  // BOTH the 7.2 chat and the headless MCP/CLI planners; and motir-ai as a
  // STATEFUL service with its OWN DB (headless ≠ stateless) — direction docs
  // (7.2), planning-mistakes (7.10), code graph (7.5/7.7) live there.
  {
    id: '7.2',
    title: 'Chat front door + stack/opinion discovery',
    status: 'planned',
    descriptionMd:
      'Streaming chat UI + the planner\'s "do you care?" pass (stack, deploy, design language) so ' +
      "it never assumes a default that doesn't fit. Drafts discovery context; read-react-revise " +
      'loop. (Former Epic 2.)\n\n' +
      '**Two project kinds (locked 2026-06-11):** Motir plans (1) **start-fresh** projects and ' +
      '(2) **existing projects migrating to Motir**. As a startup we ship (1) FIRST; (2) follows. ' +
      'The init chat for a fresh project produces **three direction docs — vision / discovery / ' +
      "feasibility** (this story owns their generation + schema + write). They are the project's " +
      'north star and important planning context, but they are NOT PM substrate, so per the ' +
      "open-core boundary they are **stored in motir-ai's own DB, NOT motir-core** (the 7.1 " +
      'stateful-motir-ai decision); motir-core RENDERS them by fetching over 7.1. This is ' +
      "motir-meta's own vision.html/discovery.html/feasibility.html, productized per project. " +
      'Generation rides the 7.1 async-job + the 7.3-family tool-use loop.',
    items: [],
  },
  {
    id: '7.3',
    title: 'Issue-tree generation (chat → real issues in the PM core)',
    status: 'planned',
    descriptionMd:
      'First plan pass: generate a comet-shaped epic/story/task tree as actual issues (Epic 2 ' +
      'model), not a parallel artifact. The differentiator that makes Motir AI-native. (Former ' +
      'Epic 3 §3.1.) Contract recorded by 7.9.9 (`motir plan`): generation must be invokable ' +
      'HEADLESSLY — an async server-side job + MCP tool surface (the 7.9 MCP-first rule), not ' +
      'only via the 7.2 web chat — and must accept an OPTIONAL code-context bundle (the ' +
      "CLI-gathered snapshot of the user's checkout, 7.9.9) alongside the chat-derived " +
      'discovery context.\n\n' +
      '**Architecture (locked 2026-06-11, rides 7.1):** generation is a **tool-use SESSION**, ' +
      'NOT a one-shot prompt — motir-ai HOSTS the planning agent (its context lives there: ' +
      'direction docs, mistakes, code graph), reasons step by step, and the produced tree is ' +
      'returned as a **delta** that motir-core persists via `workItemsService` (the AI never ' +
      'writes the tree directly). Generate→**human approve**→persist (Principle #3; the Rovo ' +
      '"customize and approve, then auto-create" mirror). `jobKind: generate_tree` replaces 7.1.7\'s ' +
      'noop handler with the real planner.',
    items: [],
  },
  {
    id: '7.4',
    title: 'Augmentation, expansion & completion-aware re-planning',
    status: 'planned',
    descriptionMd:
      'Augment an existing backlog from a prompt; on-demand + auto-suggested expansion of stubs; ' +
      're-plan that respects completed work as immutable. (Former Epic 3 §3.2-3.5.) Contract ' +
      'recorded by 7.9.8 (`motir auto --include-planning`): the expansion of a stub epic/story ' +
      'must be triggerable as an ASYNC server-side job (queue + status, returns immediately) and ' +
      'surfaced as an MCP tool (`expand_item`-style, per the 7.9 MCP-first rule) so the CLI loop ' +
      'can fire it and keep dispatching without waiting; 7.9.8 carries a story-level dep here — ' +
      'retarget it to the concrete subtask when this story expands. `motir plan` (7.9.9) drives ' +
      'augmentation ("plan <description>" on an existing backlog) and explicit expansion ' +
      '("plan <KEY>") through the SAME async-job + MCP-tool surface, optionally carrying the ' +
      '7.9.9 code-context bundle.\n\n' +
      '**Context-selection decision (locked 2026-06-11): the plan tree is NEVER serialized ' +
      "whole into a job.** Context is a function of the operation's blast radius, not the tree's " +
      'size: **expand** a stub and **re-plan** an epic are structurally bounded (push the ' +
      'neighborhood subtree, projected — same small slice at 10 or 10k issues); **augment** ' +
      '("add SSO") is unbounded, so the agent gets a cheap global SKELETON for breadth + ' +
      'on-demand graph-traversal RETRIEVAL (incl. comments + history) for depth. The whole tree ' +
      'is *reachable* every job, *transmitted* never. This makes 7.4 augmentation **depend on ' +
      '7.5 retrieval** (load-bearing, not incidental). Completed work is passed as ' +
      'locked/immutable.',
    items: [],
  },
  {
    id: '7.5',
    title: 'Shared-context retrieval + ready-set engine + tool surface',
    status: 'planned',
    descriptionMd:
      'The prompt-quality moat: inject referenced files into prompts; the ready-set query over the ' +
      'dependency DAG that powers "what\'s next"; the narrow single-artifact planner tools (no ' +
      'batching). (Former Epic 4 §4.0-4.0.7.) Locked contract (finding #42): the unit of dispatch ' +
      'is the ready leaf work item of ANY kind — a bug with no children dispatches directly; ' +
      'decomposition is never forced. "Ready" = all is_blocked_by links done; parent/child edges ' +
      'are rollup, not blocking.\n\n' +
      '**Front-half shipped ahead in Story 7.0** (the ready-set page + endpoints — `GET ' +
      '/api/ready` and `POST /api/ready/next` + the `/ready` sidebar surface — pulled forward ' +
      "as the AI dispatch contract for BYOK `motir run`). 7.5's remaining scope: " +
      '**shared-context retrieval** (the file-content injection into dispatch payloads — the ' +
      'prompt-quality moat itself) + **the broader planner tool surface** beyond `ready` (the ' +
      'narrow single-artifact tools an AI planner calls). The split is justified inline in ' +
      'story-7.0.ts; see also notes.html #32 (epic-ordering-follows-deps) — 7.0 has no ' +
      'forward-pointing deps, so the early ship is a clean deviation, not a planning bug.\n\n' +
      '**Retrieval is GRAPH-TRAVERSAL, not RAG (locked 2026-06-11; Rovo mirror).** Motir walks ' +
      'TWO explicit relational graphs over MCP — no embeddings, no vector store: (1) the **plan ' +
      'tree** (motir-core: parent/child rollup + is_blocked_by DAG + comments — already a graph; ' +
      'read tools `get_item(withComments,history)` / `get_subtree` / `walk_blocking` / ' +
      '`search(FilterAST 6.1.1)` / `skeleton`, riding the 7.8 read surface; these SUPERSEDE ' +
      "7.1.6's minimal skeleton read), and (2) the **code graph** (below). Rovo's Teamwork-Graph " +
      'lesson verified, not asserted (notes.html #33): explicit edges beat flattening to vectors.\n\n' +
      '**Code-graph store (locked 2026-06-11): adopt `colbymchenry/codegraph`, embedded as a ' +
      'library, behind a thin `CodeGraph` interface in motir-ai.** It is TypeScript/Node ' +
      '(matches motir-ai), MIT (usable in closed source), SQLite+FTS5 STRUCTURAL graph with NO ' +
      'embeddings (= our graph-traversal decision, arrived at independently), exposes MCP tools ' +
      '(`search`/`explore`/`callers`/`impact`), and indexes 20+ languages. The one friction is ' +
      'its "100% local / file-watcher" deployment model — so we use its **engine** (indexer + ' +
      'SQLite schema + query tools) and supply the cloud parts ourselves: **read from GitHub** ' +
      "(the 7.7 App installation token; we do NOT read the user's machine during planning), " +
      'index server-side in a motir-ai worker, **store the per-repo graph per-tenant in ' +
      "motir-ai's DB**, and **refresh incrementally via the 7.7 GitHub webhook** (NOT codegraph's " +
      'OS watcher). **A `type: spike` gates adoption** — validate server-side embedding + ' +
      'per-tenant SQLite at ~50 repos, and pin a version behind the interface (codegraph is ' +
      'pre-1.0). The planner thus becomes an **MCP client of two graphs** (plan tree + code ' +
      'graph) — one client pattern, no vectors.\n\n' +
      '**Code-access (locked 2026-06-11): GitHub App read is the PRIMARY (and startup-phase ' +
      'ONLY) source.** Both project kinds get indexed from GitHub server-side; start-fresh has no ' +
      'graph until its first dispatch cycle produces code, migrate-existing indexes on connect. ' +
      'Storing the code/graph is fine (start-fresh code is Motir-originated; both cases read the ' +
      'repo anyway) — the earlier "never persists the user\'s code" note is superseded. The ' +
      'CLI-pushed code-context bundle (7.9.9) is **demoted** to a later option for ' +
      'non-GitHub repos, not part of the core loop.',
    items: [],
  },
  {
    id: '7.6',
    title: 'Prompt generation + external-agent dispatch',
    status: 'planned',
    descriptionMd:
      'Per-issue prompt generation by type (coding/copy/design/…) and the dispatch surface: the ' +
      'user runs the prompt in their own agent. THE seam the future native AI-coding layer ' +
      "extends. (Former Epic 4 §4.1, §4.2.) Contract recorded by 7.9 (Motir CLI): the prompt's " +
      'GIT WORKFLOW block is a DISPATCH-TIME template parameter — TWO variants (per-item PR ' +
      'for `next` and `batch` (7.9.10 reuses it unchanged) / session-branch <name> for `auto`; ' +
      'an auto-merge-to-main variant was ' +
      'REJECTED as dangerous, main only moves through a human-merged PR), selected by the ' +
      'dispatch request; also a structured `targetRepo` field AND the inherited ' +
      '`sessionBranch` (7.8.11 — when an item is ready via an integrated-awaiting-review ' +
      'dep, the GIT WORKFLOW must instruct building on that recorded branch) on the ' +
      "dispatch payload (7.7's repo entity upgrades targetRepo later).",
    items: [],
  },
  {
    id: '7.7',
    title: 'GitHub integration + status sync + review loop',
    status: 'planned',
    descriptionMd:
      'GitHub OAuth, repo/branch/PR model, webhooks → issue status sync, Story-level verification ' +
      '+ Subtask CI feedback loop. (Former Epic 4 §4.3-4.6.) Shape decision (recorded ' +
      '2026-06-10): the integration ships as a **GitHub App installation** — per-repo selection, ' +
      'contents:read + metadata for the code-read path, write scopes only where the status-sync/' +
      'review loop needs them — the verified standard for hosted AI dev tools that read your ' +
      'repo from their cloud (CodeRabbit-style, per its GitHub-integration docs; ' +
      'OAuth identifies the USER, the App installation grants the REPO access — two separate ' +
      "grants). This App read path is ALSO the server-side code-access source for 7.5's " +
      'planning/dispatch context retrieval (see the 7.5 code-access decision).\n\n' +
      '**Code-graph build/refresh (locked 2026-06-11):** this story owns the server-side ' +
      'pipeline that turns the App read into the 7.5 code graph — on install, clone/fetch via ' +
      'the installation token → index with the embedded codegraph engine → store the per-repo ' +
      'graph in motir-ai; on a **push/PR webhook**, re-index changed files (incremental, ' +
      "replacing codegraph's local OS file-watcher). The richer write scopes here also drive the " +
      'status-sync / review loop.',
    items: [],
  },
  {
    id: '7.10',
    title: 'Planning-mistakes store + learning loop (the productized notes.html)',
    status: 'planned',
    descriptionMd:
      'The orphaned-deferral fix (no-V1-tier rule: an unowned capability is a planning bug). ' +
      'motir-ai needs a place to STORE accumulated planning mistakes/lessons — the product ' +
      "analog of motir-meta's `notes.html` — and to INJECT them into the planner at plan time so " +
      "it stops repeating them. This is the closed AI layer's durable moat and has no home in " +
      "the open PM substrate, so it lives in **motir-ai's own DB** (the 7.1 stateful-motir-ai " +
      'decision). Added 2026-06-11; surfaced during the Epic-7 architecture discussion when the ' +
      'three motir-ai stores (direction docs / mistakes / code graph) were enumerated and only ' +
      "this one owned no story. Scope: the mistakes schema + a curated base set (Motir's shipped " +
      'planning wisdom) + the injection at plan time (rides the 7.3/7.4 tool-use loop) + the ' +
      'feedback path that captures a correction into a new lesson (the loop that makes the ' +
      'planner improve). Likely per-tenant learned lessons layered on the global base set — ' +
      'verify the mirror (how Rovo/agentic planners persist learned preferences) at expansion.',
    items: [],
  },
  // 7.8 (Motir MCP server — agent tool surface over the PM core) is fully
  // expanded — data/story-7.8.ts. Added 2026-06-10 (the orphaned-deferral fix:
  // MCP existed only as notes.html/findings future-state prose with no owning
  // story). PAT substrate + settings UI (design-gated), /api/mcp streamable-
  // HTTP endpoint on the official SDK, read/dispatch tools wrapping the 7.0
  // /ready contract, write tools (create incl. bug logging / transition /
  // comment), sprint tools (list/create/update/delete, move sprint↔backlog,
  // start/complete — over the done Epic-4 services), FilterAST search riding
  // 6.1.1, the reseed-preserves-live-status loader flip, and the MOTIR.md
  // runbook rewrite.
  // 7.9 (Motir CLI — `motir next` / `motir auto` terminal dispatch) is fully
  // expanded — data/story-7.9.ts. Added 2026-06-10 on Yue's direction: the
  // productized `motir run` loop (auth/link/ready/status/next/run/done/
  // auto/batch/open/plan), built as an MCP CLIENT of the 7.8 server (one agent surface,
  // one PAT auth path), consuming 7.6's server-side prompt generation;
  // packages/cli workspace package, binary `motir`; npm publish is Epic-8
  // work (name securing gates it — no forward dep).

  // ── Epic 8: Launch readiness ──────────────────────────────────────────────
  {
    id: '8.1',
    title: 'Stripe billing + open-core tiering',
    status: 'planned',
    descriptionMd:
      'Subscriptions, the free-PM-core / paid-AI-layer split, usage gating at the core↔AI boundary.',
    items: [],
  },
  {
    id: '8.2',
    title: 'Onboarding + first-run',
    status: 'planned',
    descriptionMd:
      'New-team first-run that lands in a usable project; optional sample data; the AI-planning ' +
      'upsell moment.',
    items: [],
  },
  {
    id: '8.3',
    title: 'Marketing site + brand mark',
    status: 'planned',
    descriptionMd:
      'Landing page + the **Motir** wordmark/logomark (the name is decided — Prodect → Motir, ' +
      'Yue 2026-06-10, superseding the earlier nifer decision; see story 8.7). Also bakes in ' +
      'entity-signal SEO so search engines learn the brand fast: Organization/WebSite structured ' +
      'data, Google Search Console, and early directory listings (G2 / Product Hunt / GitHub).',
    items: [],
  },
  {
    id: '8.4',
    title: 'Legal — ToS + privacy',
    status: 'planned',
    descriptionMd:
      'Terms of service + privacy policy. Human/legal subtask routed through the queue.',
    items: [],
  },
  {
    id: '8.5',
    title: 'Production hardening + observability',
    status: 'planned',
    descriptionMd:
      'Deploy, domain + SSL (motir.co — REGISTERED 2026-06-10, subtask 8.7.1; the attach + SSL ' +
      'go-live happens here), transactional email backend, analytics, error monitoring, ' +
      'backups, rate limits, day-1 admin tools.',
    items: [],
  },
  {
    id: '8.6',
    title: 'Go-to-market strategy',
    status: 'planned',
    descriptionMd:
      'The launch *strategy* (distinct from 8.3, which builds the site artifact): positioning for ' +
      'the first audience — individuals + small companies; launch channels and the open-core ' +
      'growth loop (Product Hunt / Hacker News / GitHub stars → community); pricing strategy at ' +
      'the free-PM-core ↔ paid-AI-layer boundary; content/SEO and a pre-launch waitlist. Mostly ' +
      '`type: decision`/`manual` founder work routed through the queue.',
    items: [],
  },
  // 8.7 (Rebrand cutover: Prodect → Motir) is fully expanded — data/story-8.7.ts.
  // Expanded 2026-06-10 on the news that the securing prerequisite is DONE
  // (motir.co registered + the Motir trademark filed — subtask 8.7.1, done on
  // Yue's confirmation): rename subtasks across motir-core / motir-ai /
  // motir-meta / the plan seed, the GitHub/Vercel infra renames, the npm
  // name claim + `motir` package publish (the 7.9 CLI), and the post-rename
  // sweep. PROD key stays (6.8-verified). Runs early, gated on nothing else
  // in Epic 8.
];
