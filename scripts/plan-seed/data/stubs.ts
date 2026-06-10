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
  {
    id: '5.5',
    title: 'Activity history feed',
    status: 'planned',
    descriptionMd:
      "Per-issue append-only activity (field changes, transitions, comments). Reuse Story 1.4's " +
      'work_item_revision model where it fits; render a chronological feed on the detail view.',
    items: [],
  },
  {
    id: '5.6',
    title: 'Tests — comments, mentions, custom-field values, activity',
    status: 'planned',
    descriptionMd:
      'Vitest over comment/field/activity services; Playwright over comment+mention, attach a ' +
      'file, set a custom field, read the activity feed.',
    items: [],
  },
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
  {
    id: '6.1',
    title: 'Structured search + filter builder',
    status: 'planned',
    descriptionMd:
      'Filter-builder UI (field/operator/value rows + AND/OR) compiling to a safe parameterized ' +
      'query over issues, including custom-field values from Epic 5. Free-text match on ' +
      'title/description. NO query-language parser.',
    items: [],
  },
  {
    id: '6.2',
    title: 'Saved filters',
    status: 'planned',
    descriptionMd:
      'Persist named filters at project/workspace scope; reuse as data sources for boards, ' +
      'dashboards, and reports.',
    items: [],
  },
  {
    id: '6.3',
    title: 'Dashboards & reports',
    status: 'planned',
    descriptionMd:
      'Configurable dashboard of widgets backed by saved filters; built-in reports ' +
      '(created-vs-resolved, status distribution). Charts reuse the viz from Epic 4.',
    items: [],
  },
  {
    id: '6.5',
    title: 'Project admin surface',
    status: 'planned',
    descriptionMd:
      'A settings hub composing workflow editing (Epic 2), custom fields/labels/components (Epic ' +
      '5), and members/roles (6.4) into one admin area per project.',
    items: [],
  },
  {
    id: '6.6',
    title: 'Automation rules',
    status: 'planned',
    descriptionMd:
      'When/then rule engine scoped per project, triggered by transition/activity events (Epics ' +
      '2+5), executed via Story 1.6 jobs. A small built-in action set for v1 (set field, add ' +
      'watcher, transition).',
    items: [],
  },
  {
    id: '6.7',
    title: 'Tests — filter compilation, permissions, automation firing',
    status: 'planned',
    descriptionMd:
      'Vitest over filter→query compilation (incl. injection safety), permission checks, ' +
      'automation trigger/action; Playwright over build-a-filter, save it, gate a viewer, fire a ' +
      'rule.',
    items: [],
  },
  {
    id: '6.8',
    title: 'Edit project details + change project key (with old-key redirects)',
    status: 'planned',
    descriptionMd:
      'Project-admin editing of project details (name, key, avatar) in the project settings area ' +
      '(sits alongside 6.5). The load-bearing piece is **changing the project key mid-project, ' +
      'Jira-faithfully** (decision-ladder rung 1 — Atlassian "Editing a project key"): on a key ' +
      'change, re-render every issue identifier (`project.identifier` PROD → NIF; the per-project ' +
      '`work_item.key` numbers are preserved, so PROD-42 → NIF-42) and **keep the old key working ' +
      'as a permanent redirect** — old links, REST calls, and JQL/saved filters that reference the ' +
      'old key all still resolve to the new one. Implementation notes: the current schema stores a ' +
      'denormalized `work_item.identifier` ("PROD-42") per row, so a key change is a bulk re-write ' +
      'of that column + a search re-index (Jira\'s "background re-index"); and it needs a NEW ' +
      '`project_key_alias` (key-history) table — which the schema lacks today — so historical keys ' +
      'redirect. Guards: key format + cross-project uniqueness (incl. against existing aliases), ' +
      'admin-only, atomic rename in one transaction. This is the capability the 8.7 rebrand uses, ' +
      'and it turns the PROD-vs-NIF question into a reversible setting rather than a migration.',
    items: [],
  },

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
