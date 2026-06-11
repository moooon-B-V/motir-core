import type { PlanStory } from '../types';

/**
 * Story 6.5 — Project admin surface.
 *
 * The unifying composition story the earlier admin pages have been pointing
 * at (5.3: "6.5's settings-hub composition"; 6.4: "the unified project-admin
 * area (Story 6.5 folds Members/Access in)"). It turns the flat card hub at
 * `settings/project` into the **Jira-shaped project-settings AREA**: a
 * grouped settings navigation wrapping every per-project admin page behind
 * ONE chrome, landing on a **Details** page, driven by a **TOTAL settings-nav
 * registry** that later admin stories (6.6 automation, 6.8 details editing)
 * mount into by adding an entry.
 *
 * 📦 Composition, not invention: every section already exists or is owned by
 * its own story — Workflow (2.2.5), Board config (3.6 + 3.7 per-board),
 * Estimation (4.3.5), Members & Access (6.4.5, done), Fields (5.3.6) and
 * Components (5.4.10) from in-flight Epic 5. 6.5 ships the area shell, the
 * registry, and the Details landing; it re-houses, it does not rebuild.
 * Deps point backward only (Epic 5 ships before 6 — the audit is clean).
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against the
 * Atlassian project-settings-sidebar + team-managed docs at plan time,
 * 2026-06-10):
 *   • **Project settings is a dedicated sidebar AREA, not a card hub.**
 *     Jira enters it from the project nav and presents a grouped left nav
 *     of settings pages with a way back to the project; pages can be
 *     grouped into sections. Our shipped shape (a flat card list + per-page
 *     back-crumbs, each page standalone in the app shell) predates the
 *     area; 6.5 adopts the verified shape.
 *   • **Team-managed sections**: Details, Access, Notifications, Automation,
 *     Features, Work types, Apps. **Details owns name / key / category /
 *     avatar** — and the project danger zone (trash/delete) lives with it.
 *     Jira LANDS on Details when settings opens.
 *   • **Recorded deviations (justified — no complexity for nothing):** no
 *     **Features** toggle page (Jira's kanban-vs-scrum/feature flags axis is
 *     owned in Motir by board TYPE — 3.7 multi-board CRUD + 4.5 Scrum
 *     board — a per-project toggle would duplicate it); no project-level
 *     **Notifications** admin (notification preferences are per-USER in our
 *     event-driven model — the 5.7 surface; no stated use case for an
 *     admin-owned scheme); no **Apps** page (no marketplace). The 5.3
 *     work-type-layout admin stays the documented extension this story's
 *     registry reserves a slot for, per 5.3's note.
 *
 * Architecture (the load-bearing piece): a typed **settings-nav registry** —
 * one entry per project-settings page: `{ id, group, href, icon, labelKey,
 * access }` — drives the area nav, the command-palette entries, AND the
 * totality test (a `settings/project/**` route without exactly one registry
 * entry fails the suite — mistake #29's totality guard). Access predicates
 * ride the SHIPPED 6.4.3 policy (`lib/projects/access.ts` +
 * `projectAccessService`): project admin manages, member gets the read-only
 * states the pages already ship (rung 2), no-access roles see neither the
 * nav entry nor the page (the 6.4.4 no-access state on direct nav). Every
 * page KEEPS its shipped route (`settings/project/*` — zero link breakage);
 * `/settings/project` itself BECOMES the Details landing (the mirror rule),
 * and the card hub retires.
 *
 * ⚠️ Design gate (planning-time). The unified area is undesigned —
 * `design/projects/` covers only Members + Access (6.4.1); the workspace
 * `settings.pen` is the workspace page; the estimation/board notes designed
 * their panels + hub cards against the RETIRING card-hub grammar → subtask
 * **6.5.1** is the `type: design` subtask (`design/projects/
 * settings-area.mock.html`); the UI code subtasks (6.5.2 / 6.5.3) carry it
 * in `dependsOn` and seed `'blocked'` (Principle #13).
 *
 * Expanded from its `stubs.ts` entry per `motir plan 6.5`, on the standing
 * `seed/epic-5-plan` branch (Epic-5/6 planning). Matches the canonical style
 * of 5.1–5.6 / 6.1.
 */
export const story_6_5: PlanStory = {
  id: '6.5',
  title: 'Project admin surface',
  status: 'planned',
  descriptionMd:
    'The unified **project-settings area**: one grouped settings navigation wrapping every ' +
    'per-project admin page — **Details** (this story; 6.8 makes it editable), **Members & ' +
    'Access** (6.4), **Workflow** (2.2.5), **Boards** (3.6/3.7), **Estimation** (4.3), ' +
    '**Fields** (5.3), **Components** (5.4) — behind one chrome, replacing the flat card hub ' +
    'and the per-page back-crumbs. Later admin stories (6.6 Automation, 6.8 Details editing + ' +
    'key change) mount by adding a registry entry.\n\n' +
    '**The verified mirror shape (and where we deviate, recorded).** Jira project settings is ' +
    'a dedicated sidebar AREA entered from the project nav: a grouped left nav of settings ' +
    'pages with a way back to the project, LANDING on **Details** — which owns project ' +
    'name/key/avatar and the danger zone. Adopted 1:1. Deviations, each justified: no Features ' +
    'toggle page (board TYPE — 3.7 multi-board + 4.5 Scrum — owns that axis in Motir); no ' +
    'project-level Notifications admin (per-user preferences are the 5.7 surface; an ' +
    'admin-owned scheme has no stated use case); no Apps page (no marketplace). The 5.3 ' +
    'work-type-layout admin remains a documented extension with a reserved registry slot.\n\n' +
    '**The settings-nav registry (the load-bearing piece).** One typed entry per page — ' +
    '`{ id, group, href, icon, labelKey, access }` — drives the area nav, the command-palette ' +
    'deep links, and the **totality test**: every `settings/project/**` route has exactly one ' +
    'entry, enforced by a suite that fails on drift (the 6.1 totality-guard pattern; mistake ' +
    '#29). Access predicates ride the SHIPPED 6.4.3 policy: admin manages; member gets the ' +
    'read-only states the pages already ship (rung 2 — 5.4/6.4 set that precedent); a role ' +
    'without browse access sees neither nav entry nor page (the 6.4.4 no-access state). ' +
    'Groups: **General** (Details), **Access** (Members & access), **Work** (Workflow, ' +
    'Boards, Estimation, Fields, Components), **Automation** (the 6.6 slot).\n\n' +
    '**Routes are preserved; the landing moves.** Every existing page keeps its URL ' +
    '(`settings/project/workflow|board|estimation|members` + the Epic-5 `fields`/`components` ' +
    '— zero deep-link breakage, no redirects needed); `/settings/project` itself becomes the ' +
    '**Details** page (read-only identity — name, key, avatar, workspace, created — plus the ' +
    're-homed Archive danger zone, mirroring Details-owns-the-danger-zone), and the card hub ' +
    'retires. Story 6.8 grows THIS page with editing + the key-change machinery.\n\n' +
    '**Real-product completeness (finding #57 axes).** The nav is bounded (≤ ~10 entries — ' +
    'no scale surface; each page owns its own bounded reads); states: no-active-project ' +
    'empty state (kept), per-role nav filtering, the no-access direct-nav state, narrow- ' +
    'viewport nav behaviour (designed, not improvised); a11y: the nav is a labelled ' +
    'navigation landmark with `aria-current`, fully keyboard-operable, strict-axe-clean; ' +
    'all strings via next-intl (en byte-identical, zh).\n\n' +
    '**Out of scope (documented extension slots, each justified):** Details editing + ' +
    'project-key change with old-key redirects (**Story 6.8** — it grows the 6.5.3 page); ' +
    'Automation rules (**Story 6.6** — the reserved Automation slot); workspace/account ' +
    'settings unification (separate scopes — Jira likewise separates site admin from ' +
    'project settings; they keep their own pages); per-work-type field layouts (the 5.3 ' +
    'extension, slot reserved); a settings search box (Jira ships one at site-admin scale; ' +
    '~10 entries do not earn it).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm db:seed`, `pnpm dev` (no migration — ' +
    'this story adds no schema).\n' +
    '- `pnpm test:coverage` — the registry totality + access-matrix suites green; all 6.5 ' +
    'files ≥90% branch/fn/line.\n' +
    '- **The area:** sign in as `zhuyue@motir.co` / `!QAZ1qaz` → the app sidebar Settings ' +
    'item → lands on **Details** at `/settings/project` (name, key PROD, avatar, workspace, ' +
    'created — read-only, with the "editing arrives with project-details editing" seam — ' +
    'plus the Archive danger zone), inside the grouped settings nav matching ' +
    '`design/projects/settings-area.mock.html` (General / Access / Work groups; active ' +
    'state on Details).\n' +
    '- **Walk every section:** Members & access, Workflow, Boards (incl. switching boards ' +
    'via `?board=`), Estimation, Fields, Components — each renders its existing page inside ' +
    'the area chrome, nav active-state tracks, the old back-crumbs are gone, and the page ' +
    'URLs are unchanged (open `/settings/project/workflow` directly in a new tab → same ' +
    'page, area chrome present).\n' +
    '- **Roles:** as a non-admin member (`bophilips@motir.co`) the nav shows the ' +
    'sections their role can open and admin-managed pages render their shipped read-only ' +
    'states; a user without browse access on a private project hits the 6.4.4 no-access ' +
    'state on direct nav (no settings nav leak).\n' +
    '- **Command palette:** ⌘K lists the settings sections (from the registry); picking ' +
    'one deep-links into the area.\n' +
    '- **Narrow viewport:** at mobile width the settings nav collapses per the design ' +
    '(reachable, not clipped); spot-check drag-free keyboard traversal of the whole nav.\n' +
    '- `pnpm test:e2e --grep settings-area` — the Playwright journey passes.\n' +
    '- **a11y check:** the strict axe sweep over the area chrome + Details page reports ' +
    'zero violations; nav is a labelled landmark with `aria-current`; colour via `--el-*`, ' +
    'shape via element tokens.',
  items: [
    {
      id: '6.5.1',
      title:
        'Design — the project-settings area (`design/projects/settings-area.mock.html`: grouped nav, area chrome, Details landing, role + responsive states)',
      status: 'in_progress',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 38,
      dependsOn: [],
      descriptionMd:
        'The design asset for the unified area. `design/projects/` covers only Members + ' +
        'Access (6.4.1); the estimation/board notes designed hub CARDS against the retiring ' +
        'card-hub grammar — the area shell, the grouped nav, and the Details landing are ' +
        'undesigned (the design-gate NONE-exists case). Output: ' +
        '**`design/projects/settings-area.mock.html`** + PNG + a design-notes section. ' +
        'Render checklist + AA + dark parity. Mirror: the verified Jira project-settings ' +
        'sidebar shape (grouped pages, Details landing, way back to the project).\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Entry + the area chrome** — the app-sidebar Settings item opens the area; how ' +
        'the settings nav sits relative to the app shell (replaces vs. nests beside the ' +
        '2.2-era sidebar — pick one and draw it), the project identity header (avatar + ' +
        'name + key), and the explicit way back to the project.\n' +
        '- **The grouped nav** — General (Details) / Access (Members & access) / Work ' +
        '(Workflow, Boards, Estimation, Fields, Components) / Automation (the 6.6 slot, ' +
        'drawn as a designed-for entry, not rendered until it ships); active state, hover, ' +
        'iconography (reuse the shipped `components/ui/Sidebar.tsx` vocabulary — no ' +
        'hand-rolled nav rows).\n' +
        '- **A re-housed page** — one existing section (Workflow as the exemplar) inside ' +
        'the area chrome: the serif-title page grammar KEPT, the per-page back-crumb ' +
        'DROPPED (the nav owns orientation now).\n' +
        '- **The Details landing** — read-only identity rows (avatar, name, key, ' +
        'workspace, created) with the "editing arrives with 6.8" presentation, and the ' +
        're-homed Archive danger zone (Details owns the danger zone — the mirror rule).\n' +
        '- **Role states** — the member (non-admin) view: which entries show, the ' +
        'read-only page presentation (the shipped 5.4/6.4 grammar, referenced not ' +
        'redrawn); the no-access direct-nav state (6.4.4, referenced).\n' +
        '- **Narrow viewport** — the nav at mobile width (collapse/disclosure behaviour, ' +
        'not clipped), and the no-active-project empty state (kept from the hub).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composed from shipped primitives ' +
        '(`Sidebar` vocabulary, `Card`, the settings-page grammar) + token tiers; render ' +
        'checklist + AA + dark parity pass.\n' +
        '- Panels cover: entry + chrome + back, the grouped nav (incl. the Automation ' +
        'slot), a re-housed exemplar page, the Details landing + danger zone, member ' +
        'read-only + no-access states, narrow viewport + empty state.\n' +
        '- `design-notes.md` names the nav-entry ↔ registry mapping (the 6.5.2 UI ' +
        'contract), the groups, the landing rule (`/settings/project` IS Details), and ' +
        'records the Features/Notifications/Apps deviations + the layout-admin extension ' +
        'slot.\n' +
        '- No improvised primitive; token needs recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/access-members.mock.html` + design-notes (6.4.1) — the ' +
        'settings-page grammar; `design/estimation/design-notes.md` (the hub-card section ' +
        'this supersedes — note the supersession)\n' +
        '- `app/(authed)/settings/project/page.tsx` (the retiring hub) + the four shipped ' +
        'detail pages; `components/ui/Sidebar.tsx`\n' +
        '- The verified Jira project-settings-sidebar shape + deviations in the Story 6.5 ' +
        'description\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '6.5.2',
      title:
        'Settings-nav registry + area layout — re-house Workflow / Boards / Estimation / Members / Fields / Components under one chrome',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['6.5.1', '5.3.6', '5.4.10'],
      descriptionMd:
        'The registry and the area shell, per the 6.5.1 design.\n\n' +
        '**`lib/settings/projectSettingsNav.ts`** — the typed registry: one entry per ' +
        'project-settings page (`{ id, group, href, icon, labelKey, access }`), groups ' +
        'per the design (General / Access / Work / Automation-slot). Access predicates ' +
        'consume the SHIPPED 6.4.3 policy DTO (`lib/projects/access.ts` + ' +
        '`projectAccessService`) — never a second role check. **TOTAL** (mistake #29): a ' +
        'unit test enumerates `app/(authed)/settings/project/**/page.tsx` routes and ' +
        'fails unless each has exactly one registry entry (and vice versa).\n\n' +
        '**`app/(authed)/settings/project/layout.tsx`** — the area chrome: the grouped ' +
        'nav rendered FROM the registry (filtered by the access predicate), project ' +
        'identity header, back-to-project, active state via the route, the designed ' +
        'narrow-viewport behaviour, the no-active-project empty state preserved. ' +
        '**Re-house the existing pages** — Workflow, Board (incl. `?board=` per-board ' +
        'targeting, unchanged), Estimation, Members & access, and the Epic-5 Fields + ' +
        'Components pages: keep every route, drop the per-page back-crumbs, fit the ' +
        'chrome; **retire the hub cards** (`WorkflowSettingsCard` etc. — absorbed by the ' +
        'nav; the Archive card moves in 6.5.3). **Entry points:** the `SidebarNav` ' +
        'settings deep-link is unchanged; `AppCommandPalette` grows per-section entries ' +
        'generated FROM the registry (no hand-kept list). Strings via next-intl (en ' +
        'byte-identical pattern; zh).\n\n' +
        '**A11y:** the nav is a labelled `navigation` landmark, `aria-current="page"` on ' +
        'the active entry, fully keyboard-operable.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The area matches the design panel-for-panel; every existing settings URL ' +
        'resolves unchanged inside the chrome (direct-nav spot checks); the hub cards are ' +
        'gone; `?board=` still targets boards.\n' +
        '- The nav renders from the registry: an entry added in a test renders with zero ' +
        'layout changes; entries filter by the 6.4.3 policy (admin / member / no-access ' +
        'matrix asserted); the totality test fails on a route↔registry drift.\n' +
        '- Command-palette settings entries come from the registry and deep-link ' +
        'correctly.\n' +
        '- Axe-clean; token tiers only (colour `--el-*`, shape element tokens); ' +
        'next-intl threaded; `pnpm test:coverage` ≥90% on the new files.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/settings-area.mock.html` + notes (6.5.1) — THE authority\n' +
        '- `lib/projects/access.ts` + `lib/services/projectAccessService.ts` (6.4.3 — ' +
        'the policy the predicates ride); `app/(authed)/_components/SidebarNav.tsx` + ' +
        '`AppCommandPalette.tsx` (the entry points)\n' +
        '- `app/(authed)/settings/project/page.tsx` + the detail pages (the surfaces ' +
        're-housed); `components/ui/Sidebar.tsx`\n' +
        '- The i18n threading pattern; the 6.1 totality-guard pattern',
    },
    {
      id: '6.5.3',
      title:
        'Details landing at `/settings/project` — read-only project identity + the re-homed Archive danger zone (the 6.8 seam)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['6.5.1', '6.5.2'],
      descriptionMd:
        'The Details page the area lands on (the verified mirror rule: settings opens on ' +
        'Details; Details owns identity + the danger zone), per the 6.5.1 design.\n\n' +
        '**Build:** `/settings/project` (the retired hub route) becomes the Details ' +
        'page: read-only identity rows — avatar, name, key (PROD), workspace, created — ' +
        'rendered with the designed "editing arrives with project-details editing" ' +
        'presentation (the 6.8 seam: 6.8 swaps these rows for its edit forms + the ' +
        'key-change flow; no edit affordances are improvised here); the ' +
        '`ArchiveProjectCard` re-homed as the page’s danger zone (its modal + ' +
        'behaviour unchanged — a move, not a rebuild); the registry’s `details` ' +
        'entry active in the nav. No new schema, no new service writes — the page reads ' +
        'the active-project context the hub already read.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `/settings/project` renders Details inside the area chrome per the design: ' +
        'identity rows read-only, the 6.8 seam presentation, the danger zone with the ' +
        'existing archive flow working end-to-end (archive → the shipped post-archive ' +
        'behaviour).\n' +
        '- Entering settings from the app sidebar lands here with the Details nav entry ' +
        'active; the no-active-project empty state still renders on the route.\n' +
        '- Non-admin members see Details read-only WITHOUT the danger zone (archive is ' +
        'admin-gated — the shipped 1.3.4 rule); axe-clean; token tiers; next-intl.\n' +
        '- Integration tests over the role split + archive flow; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/settings-area.mock.html` (the Details panel) — THE ' +
        'authority\n' +
        '- `app/(authed)/settings/project/_components/ArchiveProjectCard.tsx` + ' +
        '`ArchiveProjectModal.tsx` (re-homed, not rebuilt); `lib/projects` ' +
        'active-project context\n' +
        '- The 6.8 stub (`stubs.ts`) — the story that grows this page (edit + key ' +
        'change); keep the seam aligned with its description\n' +
        '- 6.5.2 (the chrome + registry this page mounts into)',
    },
    {
      id: '6.5.4',
      title:
        'Story tests — registry totality + role-gating matrix + the settings-area E2E journey + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['6.5.2', '6.5.3'],
      descriptionMd:
        'The story-closing verification (Principle #18; the epic-wide journey stays ' +
        'Story 6.7).\n\n' +
        '**Vitest (integration, real Postgres):** the **registry totality suite** ' +
        '(filesystem routes ↔ registry entries, both directions — a new settings page ' +
        'without an entry fails); the **access matrix** — every registry entry × ' +
        '(workspace owner, project admin, member, viewer/no-access) against seeded 6.4 ' +
        'role fixtures, asserting nav visibility AND page-level behaviour agree with ' +
        'the 6.4.3 policy (no nav leak, no orphan page).\n\n' +
        '**Playwright E2E (`tests/e2e/settings-area.spec.ts`):** the recipe journey — ' +
        'enter from the app sidebar → land on Details (identity + danger zone) → walk ' +
        'every section via the nav asserting active states + unchanged URLs → open ' +
        '`/settings/project/workflow` directly in a fresh context (chrome present) → ' +
        'as `bophilips@motir.co` assert the member view (filtered nav + read-only ' +
        'pages, no danger zone) → command-palette deep-link into a section → the ' +
        'narrow-viewport nav behaviour. **a11y:** the strict axe sweep over the area ' +
        'chrome + Details + one re-housed page; keyboard-only traversal of the full ' +
        'nav.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Totality + matrix suites green and DRIVEN from the registry (a registry ' +
        'change without a matrix case fails — the totality-guard pattern).\n' +
        "- The E2E journey passes green in CI's Playwright lane; the sweep reports " +
        'zero violations.\n' +
        '- The Story 6.5 verification recipe runs clean top to bottom; ' +
        '`pnpm test:coverage` keeps all 6.5 files ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- The 6.1.6/5.5 totality-guard pattern; the 6.4.7 seeded role fixtures\n' +
        '- `tests/integration/` + `tests/e2e/` conventions; the harness/selector ' +
        'memories\n' +
        '- The Story 6.5 verification recipe — the checklist this automates\n' +
        '- Story 6.7 (the epic-wide remainder — do not duplicate)',
    },
  ],
};
