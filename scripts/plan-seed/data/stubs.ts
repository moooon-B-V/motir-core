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
  // 3.1, 3.2, 3.3, 3.6 are fully expanded → data/story-3.1.ts … data/story-3.6.ts
  // (assembled in index.ts). The Scrum board (formerly Story 3.4) moved to
  // Epic 4 as Story 4.5 per `notes.html` mistake #32 — see `data/story-4.5.ts`.
  {
    id: '3.5',
    title: 'Tests — board projection, drag transitions, WIP',
    status: 'planned',
    descriptionMd:
      'Vitest over the projection + transition validation; Playwright over drag-drop happy path + ' +
      'illegal-move snapback + WIP warning. The cross-cutting AT-SCALE journey that 3.2.7 / 3.3.7 ' +
      'defer here MUST reflect the Story-3.8 load model — NO per-column "Load more"; the board loads ' +
      'the filtered set + virtualizes + shows the over-cap "refine filter" warning + the Done-age ' +
      'window (not the retired cursor paging).',
    items: [],
  },

  // ── Epic 4: Agile planning ────────────────────────────────────────────────
  {
    id: '4.1',
    title: 'Sprint + backlog data model',
    status: 'planned',
    descriptionMd:
      'Sprint entity (goal, start/end, state: planned/active/complete) + issue→sprint association ' +
      '+ backlog rank ordering. State-machine rules for start/complete in the service layer.',
    items: [],
  },
  {
    id: '4.2',
    title: 'Backlog UI (groom + rank + assign to sprint)',
    status: 'planned',
    descriptionMd:
      'Ranked backlog list, drag-to-reorder, drag-into-sprint, inline estimate. Sprint planning ' +
      'view showing committed points vs. team velocity.',
    items: [],
  },
  {
    id: '4.3',
    title: 'Story-point estimation',
    status: 'planned',
    descriptionMd:
      'Points field on issues; estimation UI (scale configurable per project); roll-ups to sprint ' +
      '+ epic level.',
    items: [],
  },
  {
    id: '4.4',
    title: 'Sprint lifecycle (start / complete)',
    status: 'planned',
    descriptionMd:
      'Start a sprint (scope lock, board opens); complete a sprint (carry-over handling); guard ' +
      'rails (one active sprint per board). Sprint report on completion.',
    items: [],
  },
  // 4.5 is the Scrum board (formerly Story 3.4) — fully expanded as
  // data/story-4.5.ts. Moved here from Epic 3 per `notes.html` mistake #32.
  {
    id: '4.6',
    title: 'Velocity + burndown charts',
    status: 'planned',
    descriptionMd:
      'Velocity (completed points/sprint history) and in-sprint burndown (remaining points vs. ' +
      'days). Reads the sprint + points data; no new write model. Wires the in-sprint burndown ' +
      "into the Story 4.5 sprint header's documented chart seam (Story 4.5 shows numeric " +
      'remaining only and leaves the chart slot for this story).',
    items: [],
  },
  {
    id: '4.7',
    title: 'Tests — sprint lifecycle, estimation roll-ups, charts, at-scale Scrum journey',
    status: 'planned',
    descriptionMd:
      'Vitest over the sprint state machine + point roll-ups + carry-over; Playwright over plan → ' +
      'start → move cards → complete. Also owns the **at-scale combined Scrum journey** Story 4.5 ' +
      'defers (the Scrum analogue of Story 3.5 for Kanban): drag + WIP + swimlanes + sprint-scope ' +
      'on a large-active-sprint board with virtualization, exercising the bounded projection ' +
      '(finding #57) end-to-end.',
    items: [],
  },

  // ── Epic 5: Collaboration & fields ────────────────────────────────────────
  {
    id: '5.1',
    title: 'Comments + @mentions',
    status: 'planned',
    descriptionMd:
      'Comment model + rich-text composer + mention autocomplete over workspace members. Mention ' +
      '→ notification hook (via Story 1.6 jobs).',
    items: [],
  },
  {
    id: '5.2',
    title: 'Attachments',
    status: 'planned',
    descriptionMd:
      'First-class attachments: a per-issue attachment list (download/delete), image preview, ' +
      "size/type guards, workspace-scoped access. REUSES Story 2.3.7's upload primitive (finding " +
      '#52) — the `attachmentsService.uploadAttachment` service, `POST ' +
      '/api/upload/issue-attachment` route, shared `lib/blob/allowlist.ts`, and the `attachment` ' +
      "table; this Story adds the `attachment.workItemId` link + the management UI (2.3.7's rows " +
      "are intentionally work_item-unlinked). Don't rebuild the uploader.",
    items: [],
  },
  {
    id: '5.3',
    title: 'Custom fields (per-project definitions)',
    status: 'planned',
    descriptionMd:
      'Field-definition model (type + config) per project; render + edit on issue detail; values ' +
      'stored against issues. The extensible-schema piece — design carefully so Epic 6 search can ' +
      'filter on them.',
    items: [],
  },
  {
    id: '5.4',
    title: 'Labels, components, watchers',
    status: 'planned',
    descriptionMd:
      'Label + component taxonomies (project-scoped), assignment UI on issues, watcher ' +
      'follow/unfollow. All filterable in Epic 6.',
    items: [],
  },
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
      'are rollup, not blocking.',
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
      'Landing page + the deferred wordmark/logomark decision (per the brand-mark-deferral ' +
      'principle — see PRODECT.md "Current state").',
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
      'Deploy, domain + SSL, transactional email backend, analytics, error monitoring, backups, ' +
      'rate limits, day-1 admin tools.',
    items: [],
  },
];
