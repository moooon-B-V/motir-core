import type { EpicMeta } from '../types';

/**
 * The 8 v1 epics (metadata only — stories are attached in `index.ts`).
 * Statuses: Epic 1 done · Epic 2 in progress · Epics 3–8 planned. Epic-direct
 * `items` carry standalone bugs parented to the epic (Jira shape).
 * Transcribed from prodect_plan/epic-*.html (frozen archive).
 */
export const EPICS: EpicMeta[] = [
  {
    id: '1',
    title: 'Foundation',
    status: 'done',
    descriptionMd:
      'The architectural floor every other epic stands on: **project bootstrap**, **design ' +
      'system & brand**, authentication, multi-tenant workspaces, projects, the work-item schema, ' +
      'the web app shell, and async job infrastructure. Boring, foundational, non-negotiable. If ' +
      "this isn't solid, every other epic builds on sand. Built — all 8 stories (1.0–1.6) shipped.",
  },
  {
    id: '2',
    title: 'Issue tracking core',
    status: 'done',
    descriptionMd:
      'The irreducible Jira core — the first epic of the PM substrate that makes Prodect a usable ' +
      "standalone product. Built directly on Story 1.4's `work_item` model: issue types " +
      '(epic / story / task / bug), the issue detail view, create / edit, customizable per-project ' +
      'status **workflows**, assignees, and the issue list. After this epic a team can track real ' +
      'work by hand, with zero AI involved. The AI Planning Layer (Epic 7) later *generates* these ' +
      'same issues — but the manual path is the foundation and must stand on its own.',
    items: [
      {
        id: 'bug-finding-47',
        kind: 'bug',
        title: 'Workflow settings page has no nav entry point — orphaned route',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Source:** Finding #47.\n\n' +
          'The `/settings/project/workflow` route (shipped in subtask 2.2.5) works — page + all ' +
          'six Server-Action writes — but **nothing links to it**. App navigation points only to ' +
          '`/settings/project` (which renders just the archive card) and `/settings/workspace`, so ' +
          'the workflow editor is reachable only by typing the URL (the Playwright spec reaches it ' +
          'via `page.goto`). Only discoverability is missing.\n\n' +
          '**Root cause / fix:** the `/settings/project` area has no settings sub-nav pattern (no ' +
          'tabs/sidebar) to hang a "Workflow" link on — a cross-cutting app-shell concern. ' +
          'Resolution: add a project-settings sub-nav (Workflow / Archive / …) so every settings ' +
          'sub-page has an entry point. **Links:** *discovered in* Story 2.2 (subtask 2.2.5); ' +
          '*fix belongs to* Story 1.5 (app-shell / settings-nav). Not nested under either — linked.\n\n' +
          '**Resolution (prodect-core `4bc4463`):** the `/settings/project` page now renders a ' +
          '**Workflow navigation card** linking to the editor — the minimal fix, reusing the ' +
          'existing Card grammar (a single `<Link>` wrapping the card, no new settings-nav chrome ' +
          'invented). E2E in `tests/e2e/workflow-settings.spec.ts` asserts the editor is reachable ' +
          'by clicking through from project settings (no `page.goto`). The fuller settings sub-nav ' +
          '(tabs / sidebar section across Workflow / Archive / …) remains a separate design ' +
          'decision, deferred — this fix only restores discoverability.',
      },
      {
        id: 'bug-tree-header-misalignment',
        kind: 'bug',
        title: 'Tree view: column values not aligned with their headers',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Discovered in:** Story 2.5 (issue list — Tree ' +
          'view) · **Status:** fixed (PR #124, merged)\n\n' +
          'On the project issue list at `/issues`, the **Tree view** renders misaligned: the column ' +
          '**values** in each row do not line up with the column **headers** above them — the ' +
          'header row and the data cells sit on different horizontal grids, so the layout reads as ' +
          '"off". First observed in the seeded `moooon` / `prodect` project after the plan was ' +
          'migrated into the seed (with a full backlog to render, the misalignment is obvious).\n\n' +
          '**Repro:** sign in as `info@moooon.net`, open the `moooon` / `prodect` project → ' +
          '`/issues`, switch to **Tree** view, and observe that the column headers do not sit ' +
          'above their values.\n\n' +
          '**Root cause (confirmed by browser repro, not code-reading).** The lazy + sortable ' +
          '`IssueTreeTable` (2.5.14) remaps the shared `buildIssueColumns` to wrap each header in a ' +
          'sort button but DROPPED each column’s fixed `width`. `TreeTable` then falls back to ' +
          '`max-content` for those tracks; because every row is its OWN CSS grid, `max-content` ' +
          'sizes each row to its own content, so the header row and the data rows land on different ' +
          'column grids → drift (measured up to ~73px). The static/filtered tree + the List never ' +
          'drifted because they forward `width`. (The original "virtualized body computes widths ' +
          'independently" guess was directionally right about "independent widths" but wrong on ' +
          'mechanism — there is no virtualization; it was the dropped `width`.)\n\n' +
          '**Fix.** Forward `width: col.width` in `IssueTreeTable`’s column remap, so the header + ' +
          'every data row share one fixed-width grid. Guarded by a regression test asserting the ' +
          'header and data rows carry the same fixed-px grid template (not `max-content`), plus a ' +
          'browser pixel-alignment measurement during the fix.',
      },
    ],
  },
  {
    id: '3',
    title: 'Boards',
    status: 'planned',
    descriptionMd:
      'The primary day-to-day surface for a working team: **Kanban and Scrum boards** that ' +
      'visualize issues as cards in columns mapped to the workflow statuses from Epic 2. Drag-drop ' +
      'to transition, swimlanes to group, WIP limits to enforce flow. This is where the PM core ' +
      'stops being a database and starts feeling like Jira / Linear.',
  },
  {
    id: '4',
    title: 'Agile planning',
    status: 'planned',
    descriptionMd:
      'Sprint-based delivery on top of the issue tracker: the **backlog**, **sprints** (create / ' +
      'start / complete), **story-point estimation**, and the velocity + burndown that make ' +
      'iteration measurable. Turns Prodect from an issue tracker into a full agile-planning tool — ' +
      'the Scrum half of the Jira feature set.',
  },
  {
    id: '5',
    title: 'Collaboration & fields',
    status: 'planned',
    descriptionMd:
      'The layer that turns an issue from a record into a team workspace: **comments**, ' +
      '**@mentions**, **attachments**, **custom fields**, labels / components, assignees / ' +
      'watchers, and a per-issue **activity history**. The collaboration depth users expect from ' +
      "Jira before they'll switch.",
  },
  {
    id: '6',
    title: 'Search, reporting & admin',
    status: 'planned',
    descriptionMd:
      'The tools that make the PM core enterprise-usable and complete the standalone Jira ' +
      'alternative: **search & filtering**, **dashboards & reports**, **roles & permissions**, ' +
      'project admin, and **automation rules**. After this epic, prodect-core is a feature-complete ' +
      'PM tool — ready for the AI Planning Layer (Epic 7) to sit on top.',
  },
  {
    id: '7',
    title: 'AI Planning Layer',
    status: 'planned',
    descriptionMd:
      'The headline differentiator — a feature layered on the now-complete PM core (Epics 1-6). A ' +
      'chat front door drafts discovery context, generates and augments the issue tree in the PM ' +
      'core (the former "pre-plan" + "build phase"), and an execution surface turns issues into ' +
      'agent-ready prompts dispatched to the user\'s own coding agent (the former "execution" ' +
      'epic). This is the closed `prodect-ai` layer the open core calls into over a documented ' +
      'HTTP API. A team that never opens the chat box still has a full Jira alternative; this epic ' +
      'makes Prodect AI-native on top of that.',
  },
  {
    id: '8',
    title: 'Launch readiness',
    status: 'planned',
    descriptionMd:
      'Everything between "feature complete" and "live, paid users." Stripe billing, marketing ' +
      'landing page, ToS + privacy policy, transactional email, basic analytics, production ' +
      'deploy, domain + SSL, onboarding, and day-1 admin tools. Most of this is human subtasks ' +
      "running through Prodect's own queue. (Formerly Epic 5.)",
  },
];
