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
  {
    id: '7.1',
    title: 'Core ↔ AI API contract (prodect-core ↔ prodect-ai)',
    status: 'planned',
    descriptionMd:
      'The documented HTTP boundary the open core calls into. All later stories ride this ' +
      'contract. Designed so a future native AI-coding executor plugs in behind the same dispatch ' +
      'shape.',
    items: [],
  },
  {
    id: '7.2',
    title: 'Chat front door + stack/opinion discovery',
    status: 'planned',
    descriptionMd:
      'Streaming chat UI + the planner\'s "do you care?" pass (stack, deploy, design language) so ' +
      "it never assumes a default that doesn't fit. Drafts discovery context; read-react-revise " +
      'loop. (Former Epic 2.)',
    items: [],
  },
  {
    id: '7.3',
    title: 'Issue-tree generation (chat → real issues in the PM core)',
    status: 'planned',
    descriptionMd:
      'First plan pass: generate a comet-shaped epic/story/task tree as actual issues (Epic 2 ' +
      'model), not a parallel artifact. The differentiator that makes Prodect AI-native. (Former ' +
      'Epic 3 §3.1.)',
    items: [],
  },
  {
    id: '7.4',
    title: 'Augmentation, expansion & completion-aware re-planning',
    status: 'planned',
    descriptionMd:
      'Augment an existing backlog from a prompt; on-demand + auto-suggested expansion of stubs; ' +
      're-plan that respects completed work as immutable. (Former Epic 3 §3.2-3.5.)',
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
      "as the AI dispatch contract for BYOK `prodect run`). 7.5's remaining scope: " +
      '**shared-context retrieval** (the file-content injection into dispatch payloads — the ' +
      'prompt-quality moat itself) + **the broader planner tool surface** beyond `ready` (the ' +
      'narrow single-artifact tools an AI planner calls). The split is justified inline in ' +
      'story-7.0.ts; see also notes.html #32 (epic-ordering-follows-deps) — 7.0 has no ' +
      'forward-pointing deps, so the early ship is a clean deviation, not a planning bug.',
    items: [],
  },
  {
    id: '7.6',
    title: 'Prompt generation + external-agent dispatch',
    status: 'planned',
    descriptionMd:
      'Per-issue prompt generation by type (coding/copy/design/…) and the dispatch surface: the ' +
      'user runs the prompt in their own agent. THE seam the future native AI-coding layer ' +
      'extends. (Former Epic 4 §4.1, §4.2.)',
    items: [],
  },
  {
    id: '7.7',
    title: 'GitHub integration + status sync + review loop',
    status: 'planned',
    descriptionMd:
      'GitHub OAuth, repo/branch/PR model, webhooks → issue status sync, Story-level verification ' +
      '+ Subtask CI feedback loop. (Former Epic 4 §4.3-4.6.)',
    items: [],
  },

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
      'Landing page + the **nifer** wordmark/logomark (the name is now decided — the product was ' +
      'renamed Prodect → nifer; see notes.html mistake #34 and story 8.7). Also bakes in ' +
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
      'Deploy, domain + SSL (the nifer.co domain is already registered), transactional email ' +
      'backend, analytics, error monitoring, backups, rate limits, day-1 admin tools.',
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
  {
    id: '8.7',
    title: 'Rebrand cutover: Prodect → nifer',
    status: 'planned',
    descriptionMd:
      'One-time cross-repo rename now that the name is decided + secured (nifer.co registered, ' +
      'EUIPO trademark filed; see notes.html mistake #34). NOT a blind find-replace — touches ' +
      'prodect-core (UI copy, package names, app/SEO metadata, email templates/chrome), ' +
      'prodect-ai, prodect-meta (PRODECT.md → NIFER.md), the plan seed (@prodect.co users → ' +
      '@nifer.co, tenant naming), domain/Vercel/email config, and README + license headers. Open ' +
      'decision: the `PROD` issue key — keep PROD-N or switch to NIF-N (switching rewrites every ' +
      'key; lean keep-PROD unless taking the clean break now while there is no real data). ' +
      'Run-early, NOT gated on other Epic-8 work — cheapest before launch/traction. Also confirm ' +
      'the EUTM covers Nice classes 9 & 42 (+ USPTO if launching in the US).',
    items: [],
  },
];
