import type { PlanStory } from '../types';

/**
 * Summary-level (subtasks-deferred) stories: Epics 3–8 (Epic 2 is fully
 * expanded — 2.6 became data/story-2.6.ts). Each is `planned` with no leaf items
 * yet — they get expanded to full subtask depth (their own data/story-*.ts
 * module) when the ready set drains, per the async-expansion rule. Transcribed
 * from the epic-*.html cards.
 */
export const STUB_STORIES: PlanStory[] = [
  // ── Epic 2: Issue tracking core ──────────────────────────────────────────
  // Epic 2 was fully expanded + done; RE-OPENED 2026-06-12 with one new story:
  // 2.7 (Work-item type + executor) — data/story-2.7.ts. Adds the structural
  // `work_item.type` (code/design/test/…) + `executor` fields the AI layer
  // generates (7.3) and routes prompts by (7.6); today they're only prose in
  // the description. A Principle-#11 justified deviation from Jira (whose only
  // type axis is `kind`). Placed in Epic 2 (core attribute) so every AI
  // consumer is a clean backward dep.

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
  // 5.7 (In-app notifications — bell + unread feed) is fully expanded —
  // data/story-5.7.ts. Added 2026-06-12. The IN-APP channel: a Notification
  // model fed by a SECOND consumer of 5.1.6's shipped channel-agnostic events
  // (no new emit path), the shell-header bell + drawer, mark-read/mark-all,
  // and a per-user × event-type × channel (email|in_app) preference matrix
  // both the in-app consumer and the done 5.1.6 email job honor. Epic 5 is now
  // fully expanded.

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

  // 6.10 (Organization root-account tier + org admin) — data/story-6.10.ts.
  // Added 2026-06-12. `Organization` (≠ Better-Auth `Account`) above Workspace,
  // the BILLING ENTITY credits/usage roll up to; org membership + admin.
  // 6.11 (Triage inbox — bug/feature intake → promote) — data/story-6.11.ts.
  // Added 2026-06-12. A work_item in a `triage` state EXCLUDED from every
  // normal tree/board/list read; intake (in-app + portal) → promote to
  // backlog/sprint/epic/story (the Linear Triage mirror).

  // 6.12 (Public projects — "open project management") — data/story-6.12.ts.
  // Added 2026-06-12. A 4th `ProjectAccessLevel` = `public`: any signed-in
  // Motir account reads the project cross-org, read-only; the only write is
  // submit-to-triage (6.11) + upvote + comment + dedupe (the Canny shape) +
  // a public roadmap. Extends 6.4's access model.
  // 6.13 (Project square — system-level public project directory) —
  // data/story-6.13.ts. Added 2026-06-12. The cross-org discovery gallery of
  // ALL public projects (cards + search + category/tag filters + trending/
  // popular/recent rank tabs, paginated), each linking to its 6.12 public
  // view. Mirror: GitHub/GitLab Explore.

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
  // 7.2 (Chat front door + discovery + direction docs) — data/story-7.2.ts.
  // 7.3 (Issue-tree generation: chat → real issues) — data/story-7.3.ts.
  // 7.4 (Augmentation, expansion & completion-aware re-planning) — data/story-7.4.ts.
  // 7.5 (Shared-context retrieval: plan-tree graph + code graph) — data/story-7.5.ts.
  // 7.6 (Prompt generation + external-agent dispatch) — data/story-7.6.ts.
  // 7.7 (GitHub integration + status sync + review loop + code-graph feed) — data/story-7.7.ts.
  // 7.10 (Planning-mistakes store + learning loop) — data/story-7.10.ts.
  // All seven expanded 2026-06-11 (the Epic-7 full expansion). Epic 7 now has
  // NO stubs — every story (7.0–7.10) is a data/story-*.ts module.
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
  // 7.11 (Cadence — auto-planning trigger + AI sprint planning + AI project
  // settings) — data/story-7.11.ts. Added 2026-06-12. Auto-expand when the
  // ready set drains (rides the 1.6 cron); AI packs ready items into SHORT
  // 2–3 day sprints (coding-agent cadence) via Epic-4 services; settings are
  // Project columns surfaced in an AI-settings panel.
  // 7.12 (Planning metering + token accounting + credit ledger) —
  // data/story-7.12.ts. Added 2026-06-12. Per-model token metering + an
  // internal credit unit (tokens × per-model rate × margin) in motir-ai's DB;
  // out-of-credits refuses planning. Pricing/checkout UI defers to Epic 8; the
  // ledger/tier/rate DATA lands now.
  // 7.13 (Contextual planning from each work item) — data/story-7.13.ts. Added
  // 2026-06-12. A planning chat embedded in the issue detail, scoped to the
  // item but able to touch it / siblings / parent — confirmation ALWAYS
  // required before any tree write. Reuses the 7.4 jobs + 7.2 chat.
  // (Also 2026-06-12: 7.3.8 added an opt-in explanation-generation toggle.)

  // 7.14 (Coding convention + code-health audit) — data/story-7.14.ts. Added
  // 2026-06-12. motir-ai's 4th store: a per-project coding convention (proposed
  // from existing code + clean-code rules → standard on user approval) + a
  // code-issues audit report; the standard convention injects into 7.6 prompt
  // generation (the productized CLAUDE.md). Audit half is migrate-only.
  // 7.15 (Start-fresh onboarding flow) — data/story-7.15.ts. Added 2026-06-12.
  // The guided wizard for a NEW project: discovery (7.2) → convention from
  // stack (7.14) → generate (7.3) → review/approve → dispatch setup.
  // 7.16 (Migrate-existing-codebase onboarding flow) — data/story-7.16.ts.
  // Added 2026-06-12. The guided wizard for an EXISTING repo: connect (7.7) →
  // index (7.5) → AUDIT + convention approve (7.14, a hard gate) → discovery
  // (7.2) → code-aware generate (7.3+7.5.6) → review/approve.

  // 7.17 (Issue importer — Jira/Linear/GitHub/CSV → work items) — data/story-7.17.ts.
  // 7.18 (WF3: BYOK + codebase + import) — data/story-7.18.ts.
  // 9.3 (Hosted execution layer — repo provisioning + scaffold + starter library +
  //   GitHub handoff) — data/story-9.3.ts.
  // 9.4 (WF4: hosted + fresh) / 9.5 (WF5: hosted + codebase) / 9.6 (WF6: hosted +
  //   codebase + import) — data/story-9.4.ts / 9.5.ts / 9.6.ts. Added 2026-06-12:
  //   the 6-workflow matrix (3 planning states × BYOK[Epic 7] / hosted[Epic 9]).
  //   7.17 + 9.3 are the two new capability clusters; the WF stories are thin
  //   orchestration + a manual-test each. Defaults: scaffold-then-build, curated
  //   promote-to-starter, Motir-owned repo with transfer-on-request.

  // 7.19 (Design system selection — palette/typography/shape → project design
  //   tokens, recorded in motir-ai) — data/story-7.19.ts. Added 2026-06-12. The
  //   PRE-PLANNING step for all 6 workflows: the user picks palette + shape
  //   (from getdesign.md) + typography (curated) → the project's `--el-*` +
  //   `[data-display-style]` tokens, confirmed on a /tokens-style page. The 5th
  //   motir-ai store (the designer's contract, sibling to 7.14's coding
  //   convention); injected into ALL later design-subtask planning.

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
