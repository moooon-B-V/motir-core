import type { PlanStory } from '../types';

/**
 * Story 2.3 — Issue create / edit (form + server actions).
 * Faithful transcription of prodect_plan/story-2.3-issue-create-edit.html (frozen archive).
 */
export const story_2_3: PlanStory = {
  id: '2.3',
  title: 'Issue create / edit (form + server actions)',
  status: 'done',
  descriptionMd:
    'The issue-mutation surface: a create-issue modal + a full edit form route, both following the\n' +
    '4-layer architecture (Server Action → service → repository → Prisma). Type + parent picker\n' +
    "that surfaces 2.1.2's `assertValidParent` rule inline as a filtered combobox\n" +
    "(illegal selections aren't constructible, not flagged after submit). A reusable\n" +
    '`MarkdownEditor` primitive on top of the `descriptionMd` field 1.4 already\n' +
    'ships, with paste/drop image upload via Vercel Blob. The edit form also **resolves\n' +
    "finding #46** by routing every status change through 2.2.4's gated\n" +
    '`updateStatus` and removing the ungated `status` patch on\n' +
    '`updateWorkItem`. Story also includes the previously-relocated\n' +
    '**delete-with-reassign** flow for in-use statuses (2.3.1, with its own E2E in 2.3.2)\n' +
    '— kept here because its E2E spans both the workflow-settings surface AND the work-item mutation\n' +
    "pipeline, which is exactly this Story's seam.\n\n" +
    '**Prerequisites:** Story 1.4 already ships\n' +
    '`workItemsService.createWorkItem` (atomic key allocation via the project counter,\n' +
    "parentage gate via 2.1.2's `assertValidParent`, audit revisions) and\n" +
    '`updateWorkItem` (patch-style updates for non-status fields). Story 2.1 ships the\n' +
    'issue-type metadata (`lib/issues/issueTypes.ts`) + parent rules\n' +
    '(`lib/issues/parentRules.ts`) the type+parent picker reads from. Story 2.2 ships\n' +
    'transition validation on `workItemsService.updateStatus` (2.2.4) — the SINGLE gated\n' +
    'path every status change in this Story routes through — plus initial-status seeding on create\n' +
    '(also 2.2.4 + 2.2.2) and the workflow-management UI 2.3.1 extends. Issue-key assignment is\n' +
    'NOT re-built here — Story 2.1.3 already verified the atomic monotonic-counter path; this Story\n' +
    'just consumes `createWorkItem` as-is. All work follows\n' +
    "`prodect-core/CLAUDE.md`'s 4-layer architecture (Route/Server-Action → Service →\n" +
    'Repository → Prisma). Per finding #26, every new route + Server Action carries an explicit\n' +
    '`workspaceId` gate at the application layer — RLS is defense-in-depth, not the sole\n' +
    'gate (the dev/CI superuser bypasses RLS until the Epic-8 runtime cutover).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install && pnpm prisma generate && pnpm prisma migrate dev`' +
    ' against a fresh local DB.\n' +
    '- `pnpm test` — Vitest covers: 2.3.1 delete-with-reassign matrix; 2.3.3 createIssue Server' +
    ' Action; 2.3.4 candidate-parents service + picker; 2.3.5 MarkdownEditor round-trip + render' +
    ' guard; 2.3.6 edit form + the **finding #46 grep guard** (no `status` in' +
    ' `UpdateWorkItemInput`) + stale-edit; 2.3.7 attachment service gates.\n' +
    '- `pnpm test:e2e` — both E2E suites: 2.3.2 `workflow-delete-reassign` + 2.3.8' +
    ' `issue-create-edit-flow`.\n' +
    '- **Manual UX check — create:** sign in, project page, press "C", create a Story with title +' +
    ' Markdown description + a pasted image; assert the toast shows the PROD-N identifier, the' +
    ' linked detail/edit page renders the description with the image rendered inline.\n' +
    '- **Manual UX check — type+parent inline validation:** open create modal; for every type, open' +
    " the parent picker and confirm the candidate list matches 2.1.2's matrix (Epic→none," +
    ' Story→Epic, Task→Story/Epic, Bug→Story/Task/Epic, Subtask→Story/Task/Bug); changing type' +
    ' after picking a parent clears the parent with the documented notice.\n' +
    '- **Manual UX check — edit + finding #46:** open `/projects/[key]/issues/[key]/edit`; change' +
    ' title + status in one form, save; both succeed; activity tab shows two revisions; assert that' +
    ' mutating the row externally between page load + save surfaces the stale-edit banner.\n' +
    '- **Manual UX check — delete-with-reassign (2.3.1):** as project admin, create a custom' +
    ' status, change 2–3 issues into it, delete it from `/settings/project/[key]/workflow`, confirm' +
    ' reassign modal + per-item migration + status row removal + per-item revision.\n' +
    '- **Cross-workspace check:** sign in as a user with only workspace-A; visit a workspace-B' +
    ' issue URL → 404 (no leak of title/existence/key).\n' +
    '- **Findings-log update:** append `> Resolved: 2.3.6` to finding #46 in' +
    ' `prodect_plan/PRODECT_FINDINGS.md`.',
  items: [
    {
      id: '2.3.1',
      title:
        "Delete a status that's in use — reassign referencing work items (finding #48 · option b)",
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.2.4', '2.2.5'],
      descriptionMd:
        'Resolves **finding #48** (Yue chose option b). Today (2.2.5)\n' +
        '`deleteStatus` REFUSES with `StatusInUseError` when any work item\n' +
        'references the status. This Subtask makes an in-use status deletable via the Jira-style\n' +
        '**delete-with-reassign** flow: the admin picks a TARGET status, every\n' +
        'referencing work item is migrated to it, and only then is the status removed — all in one\n' +
        'transaction. **Why this shape is forced:** `work_item.status` is a\n' +
        'free-form `String` with no FK to `workflow_status` (2.2.1), so a\n' +
        "delete can't cascade; the service MUST reassign the referencing rows or they'd dangle.\n\n" +
        '**Why this Subtask sits in Story 2.3, not Story 2.2:** the flow spans two\n' +
        "surfaces — the workflow-settings page (Story 2.2's `WorkflowEditor`) AND the\n" +
        "work-item mutation pipeline (this Story's domain) — and its E2E only makes sense once a\n" +
        'real issue mutation runs through it. Story 2.2 stays scoped to the workflow primitive;\n' +
        'Story 2.3 owns the issue-mutation flows that *consume* the primitive.\n\n' +
        '**Service.** Extend the delete path with an optional target:\n' +
        '`deleteStatus({ userId, workspaceId, statusId, reassignToStatusId? })` (or a\n' +
        'sibling `reassignAndDeleteStatus`). Admin-gated (same `assertProjectAdmin`).\n' +
        'In one transaction:\n' +
        '(1) the existing protections still fire FIRST and unconditionally — `CANNOT_DELETE_INITIAL_STATUS`\n' +
        'and `CANNOT_DELETE_LAST_TERMINAL_STATUS` (reassignment does NOT let you delete the\n' +
        'initial or the last terminal status);\n' +
        '(2) if the status is in use and `reassignToStatusId` is absent →\n' +
        '`StatusInUseError` as today (the UI then prompts for a target);\n' +
        "(3) validate the target: it exists in the SAME project and isn't the status being deleted\n" +
        '(else `InvalidReassignTargetError` → 422);\n' +
        '(4) migrate every `work_item` in the project whose `status` = the\n' +
        "deleted status's `key` to the target's `key`, recording a\n" +
        "status-change revision per item (reusing 2.2.4's revision pipeline — diff\n" +
        "`{ status: { from, to } }`, `changeKind: 'updated'`);\n" +
        "(5) delete the status's transitions + the status (2.2.5's cascade).\n\n" +
        '**UI.** In `WorkflowEditor`, clicking delete on an in-use status\n' +
        'opens a confirm modal that says "N issues use this status — move them to:" with a\n' +
        "status-picker (the project's other statuses); confirming calls the reassign path. Deleting\n" +
        'an unused status keeps the current one-click delete (no target needed). Optimistic + toast.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Deleting an in-use status WITH a valid `reassignToStatusId`: all referencing work items' +
        ' migrate to the target (status string updated), one status-change revision is written per' +
        ' migrated item, the status + its transitions are removed — all atomically (a forced failure' +
        ' rolls back the whole thing, items included).\n' +
        "- Deleting an in-use status WITHOUT a target still throws `StatusInUseError` (the UI's cue" +
        ' to prompt for a target).\n' +
        '- Target validation: a target in another project, a non-existent target, or the' +
        ' status-being-deleted as its own target → `InvalidReassignTargetError` (422); nothing is' +
        ' migrated or deleted.\n' +
        '- The initial-status and last-terminal-status protections STILL fire even when a target is' +
        " supplied — you can't reassign your way past them.\n" +
        '- Admin-gated (`NotProjectAdminError` for a non-owner); workspace-scoped (a cross-workspace' +
        ' status/target 404s).\n' +
        '- UI: in-use delete opens the reassign modal with a status picker + the affected-count;' +
        ' unused delete stays one-click; success toast + revalidate.\n' +
        '- Vitest (real Postgres): migrate-N-items-then-delete happy path (items + revisions +' +
        ' removal); StatusInUse without target; invalid-target rejection; initial/last-terminal still' +
        ' blocked with a target; idempotent/rollback check. Quality gates green.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workflowsService.ts` (2.2.5) — the current `deleteStatus` + protections +' +
        ' `assertProjectAdmin` to extend\n' +
        '- `lib/services/workItemsService.ts` + `workItemRevisionsService` (2.2.4) — the' +
        ' status-change + revision pipeline to reuse for the per-item migration\n' +
        '- `lib/repositories/workItemRepository.ts` — `countByProjectAndStatusKey` (2.2.5) + a new' +
        ' bulk `reassignStatusKey(projectId, fromKey, toKey, tx)` / per-item find for the revisions\n' +
        '- `app/(authed)/settings/project/workflow/_components/WorkflowEditor.tsx` + `actions.ts`' +
        ' (2.2.5) — the delete affordance + Server Action to extend with the reassign modal\n' +
        '- `lib/workflows/errors.ts` — add `InvalidReassignTargetError` beside the 2.2.5 errors',
    },
    {
      id: '2.3.2',
      title: 'E2E — delete-with-reassign flow end-to-end (Playwright)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['2.3.1'],
      descriptionMd:
        "Playwright suite that exercises 2.3.1's delete-with-reassign flow against the real stack\n" +
        '— the settings page, the Server Action, the service transaction, the revisions pipeline,\n' +
        'and the post-mutation revalidate are all on the wire. Lives at\n' +
        '`tests/e2e/workflow-delete-reassign.spec.ts` beside the existing\n' +
        "`workflow-flow` suite from Story 2.2's 2.2.7.\n\n" +
        "**Why this is a separate Subtask, not folded into 2.3.1's AC:** the\n" +
        'Vitest in 2.3.1 hits the service layer with real Postgres; the E2E proves the UI + Server\n' +
        "Action + revalidation seams. Different infra, different failure modes — one shouldn't\n" +
        'gate the other in the PR queue. The two-card split also lets the E2E iterate\n' +
        'independently (selectors, flakiness fixes) without re-opening the service-layer Subtask.\n\n' +
        "**Deliberately decoupled from 2.3.3.** This spec must NOT use Story 2.3's\n" +
        'new create-issue modal (2.3.3) or edit form (2.3.6) for issue setup — the existing\n' +
        '`tests/e2e/_helpers/workflow.ts` from 2.2.7 already drives work-item creation +\n' +
        'status changes through the `/api/_test/work-items` harness route (which calls\n' +
        'the gated service methods directly). Reusing that harness means 2.3.2 has NO ordering\n' +
        'dependency on 2.3.3, so the two parallel halves of Story 2.3 (delete-with-reassign vs.\n' +
        'create/edit form) can dispatch and merge independently. This mirrors how 2.2.7 itself\n' +
        'worked around the not-yet-shipped issue detail page.\n\n' +
        '**Scenario (single happy-path spec, three assertions):**\n\n' +
        '- **Setup (all via the 2.2.7 `_test` harness):** sign in as a project admin; create a' +
        ' project (default workflow seeds itself per 2.2.2); use the workflow settings UI to add a' +
        " custom status `'triage'` (this is part of the delete-with-reassign feature under test —" +
        " 2.2.5's UI, NOT 2.3.3); create N=3 work items via `createItem(helpers, {status:" +
        " 'triage'})` from `_helpers/workflow.ts` (the harness POST accepts an initial status," +
        ' gated through `workItemsService.createWorkItem` + `updateStatus`).\n' +
        '- **Act:** navigate to `/settings/project/[key]/workflow`, click delete on the `triage`' +
        ' status row, the reassign modal opens showing "3 issues use this status — move them to:",' +
        ' pick `todo`, confirm.\n' +
        '- **Assert:** (1) toast confirms success; (2) the `triage` row disappears from the editor;' +
        ' (3) for each of the 3 work items, a service-layer read via the `_test` harness GET (NOT' +
        " the not-yet-shipped detail page, NOT 2.3.6's edit form) confirms `status: 'todo'` AND the" +
        ' revisions table contains one status-change row per item with `from: triage`, `to: todo`.\n\n' +
        '**Negative path (second spec):** attempt to delete the initial status\n' +
        "(e.g. `todo`) with a target supplied — the reassign modal's confirm button is\n" +
        "disabled OR (if it's clickable) the toast surfaces `CANNOT_DELETE_INITIAL_STATUS`,\n" +
        "the status row remains. Proves 2.3.1's protection still fires through the UI seam.\n\n" +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e --grep workflow-delete-reassign` passes locally and in CI against a' +
        ' fresh-DB Playwright run.\n' +
        '- Happy-path spec asserts all three observations above (toast + editor row gone + per-item' +
        ' status + per-item revision).\n' +
        '- Negative-path spec asserts the initial-status protection is honored through the UI.\n' +
        '- Uses **only** the auth + 2.2.7 `_test` harness helpers (`tests/e2e/_helpers/workflow.ts`' +
        " · `createItem` / `transition`) to set up issues — does NOT import or drive 2.3.3's create" +
        " modal, 2.3.6's edit form, or any future issue detail page. This keeps 2.3.2's" +
        ' `depends_on` at `[2.3.1]` only; no cross-flow ordering with the create/edit half of the' +
        ' Story.\n' +
        '- If `createItem` needs a new option (e.g. accept `{initialStatus}` to drop the issue' +
        ' straight into the custom status without a follow-up transition call), extend the existing' +
        ' helper — do NOT add a parallel one.\n' +
        '- Selectors target stable `data-testid` hooks added in 2.3.1 (if any are missing, add them' +
        ' in this Subtask under the 2.3.1 components — do NOT add brittle text/role-only selectors).\n' +
        '- No flake under 10 consecutive runs in CI mode.\n\n' +
        '## Context refs\n\n' +
        "- `tests/e2e/workflow-flow.spec.ts` + `tests/e2e/_helpers/workflow.ts` (Story 2.2's 2.2.7)" +
        ' — the existing E2E + helper this spec sits beside and consumes; `createItem` / `transition`' +
        ' already exist and drive the gated service methods via `/api/_test/work-items`\n' +
        '- `tests/e2e/_helpers/shell-session.ts` (1.5.6) — sign-in + createWorkspace +' +
        ' createProject helpers\n' +
        '- `app/(authed)/settings/project/workflow/_components/WorkflowEditor.tsx` + reassign modal' +
        ' from 2.3.1 — the components the spec drives\n' +
        '- `app/api/_test/work-items/route.ts` — the harness route 2.2.7 extended; check its GET' +
        " surface (or extend it) for the per-item assertions; **do NOT** reach for 2.3.6's edit form" +
        ' or any not-yet-shipped detail page\n' +
        '- Playwright config + CI matrix from `playwright.config.ts`',
    },
    {
      id: '2.3.3',
      title: '`createIssue` Server Action + create-issue modal',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      descriptionMd:
        "The Story's entry-point write surface. A **thin Server Action**\n" +
        '`createIssue` at `app/(authed)/projects/[key]/_actions/createIssue.ts`\n' +
        'calls the shipped `workItemsService.createWorkItem` (Story 1.4) — which already\n' +
        'owns key allocation (via `projectRepository.allocateWorkItemNumber`), initial-status\n' +
        "seeding (per 2.2.4, reads the project's `workflow_status` with `isInitial=true`),\n" +
        "parentage gate (via 2.1.2's `assertValidParent`), and the create-revision audit row.\n" +
        '**This Subtask does not extend the service** — it builds the Server Action wrapper\n' +
        '+ the UI on top.\n\n' +
        '**Modal UI.** Reusable `CreateIssueModal` client component, opened\n' +
        'three ways: (1) the existing top-nav "+" button from Story 1.5.3\'s shell slot, (2) global' +
        ' "C" keyboard shortcut wired into `lib/shortcuts.ts` (the cheatsheet from 1.5.4 picks\n' +
        'it up automatically), (3) ⌘K palette command "Create issue" (1.5.4\'s\n' +
        '`AppCommandPalette`). Modal is a Radix Dialog with form fields in this order:\n' +
        '**Type** (defaults to `task`; the picker is the filtered combobox\n' +
        "from 2.3.4), **Parent** (optional; same combobox, filtered by 2.1.2's\n" +
        '`canParent(parentKind, selectedType)`), **Title** (required, single\n' +
        'line, max 200 chars per existing Story 1.4 validation), **Description**\n' +
        '(optional, the `MarkdownEditor` primitive from 2.3.5, compact "min" mode = textarea\n' +
        "+ preview tab, NO image upload affordance in the modal — that's edit-form territory),\n" +
        '**Assignee** (optional; a workspace-member combobox), **Priority**\n' +
        '(defaults to `medium` per the schema). **Reporter** is NEVER a form\n' +
        'field — always the current session user (the schema requires non-null reporter; defaulting\n' +
        "server-side keeps the form lean and matches Jira/Linear's standard shape).\n\n" +
        '**Submit flow.** Optimistic UX is OFF for create (the new key is server-generated\n' +
        "via the project counter — there's no value to optimistic-render). On submit: form" +
        ' validation\n' +
        "(zod schema matching the service's expected DTO) → call `createIssue` Server Action\n" +
        '→ service throws either `IllegalParentTypeError` (422),\n' +
        '`ProjectNotFoundError` (404, cross-workspace defense), or\n' +
        '`WorkspaceContextMissingError` (500, infra bug); these map to inline form errors\n' +
        '(parent field) or a toast (project/workspace). On success the modal closes, a toast surfaces\n' +
        'the new identifier (e.g. "PROD-42 created" with the identifier as a link to the future detail\n' +
        'page — for now it links to `/projects/[key]/issues/[key]/edit` from 2.3.6), and\n' +
        '`revalidatePath` refreshes the active list view.\n\n' +
        '**What this Subtask does NOT do:** rich-text image upload (2.3.7), full\n' +
        'edit form (2.3.6), the filtered type+parent combobox internals (2.3.4 — this Subtask\n' +
        'imports it), the `MarkdownEditor` primitive internals (2.3.5 — imports it). If\n' +
        "2.3.4 or 2.3.5 haven't landed by the time this runs, the modal uses temporary stubs (a\n" +
        'plain `<select>` for type + a basic textarea for description) and swaps\n' +
        'to the real components when those land — a comment marks each stub.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Server Action `createIssue` at the documented path; pure 4-layer thin wrapper (parse' +
        ' input → resolve workspaceId from session → call `workItemsService.createWorkItem` →' +
        ' return DTO or typed error). No business logic.\n' +
        '- Modal opens via "+" nav button, global "C" shortcut, AND ⌘K command — all three entry' +
        ' points wired and verified in dev.\n' +
        '- Required fields: Type (default `task`), Title (max 200 chars). Title-empty +' +
        ' Title-overflow surface inline form errors before submit.\n' +
        '- Successful create: toast with the new identifier links to' +
        ' `/projects/[key]/issues/[key]/edit`; list view revalidates; modal closes.\n' +
        '- `IllegalParentTypeError` from the service surfaces as an inline error on the Parent field' +
        ' (not a toast); cross-workspace project rejection 404s the action.\n' +
        '- Reporter is never a form field; the session user is set server-side. A spec asserts a' +
        " forged client payload with a `reporterId` attribute is IGNORED (the Server Action doesn't" +
        ' read it).\n' +
        '- New `tests/issues/createIssueAction.test.ts`: the action calls the service with the' +
        ' expected DTO, propagates typed errors, ignores client-supplied reporter, returns the' +
        ' created DTO. **Service tests are NOT re-run here** — 1.4.x already covers' +
        ' `createWorkItem`.\n' +
        '- Modal-side React-Testing-Library spec under `tests/components/CreateIssueModal.test.tsx`:' +
        ' the three entry points open it; required-field validation; submit calls the action with the' +
        " form's values.\n" +
        "- STRICT shell-a11y sweep (1.5.5's `shell-a11y.spec.ts`) extended to render the modal in" +
        ' its default-open state — zero axe violations.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workItemsService.ts` (Story 1.4) — `createWorkItem` signature + the typed' +
        ' errors it throws\n' +
        "- `lib/issues/parentRules.ts` (2.1.2) — `canParent`, consumed by 2.3.4's picker but" +
        ' referenced here for the error path\n' +
        '- `lib/shortcuts.ts` (1.5.4) — register "C" alongside the existing shortcuts; the' +
        ' cheatsheet auto-picks it up\n' +
        '- `components/ui/CommandPalette.tsx` + `AppCommandPalette` (1.5.4) — register the "Create' +
        ' issue" command\n' +
        '- Top-nav "+" slot from 1.5.3\'s shell — wire to open the modal\n' +
        '- Existing Story-1.5.5 axe sweep — extend, do not duplicate\n' +
        '- `prodect-core/CLAUDE.md` — Server Action / 4-layer rules',
    },
    {
      id: '2.3.4',
      title: 'Filtered type + parent picker — inline type-parent validation surface',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      descriptionMd:
        "The reusable picker that surfaces 2.1.2's `assertValidParent` rule\n" +
        '**inline as constructibility, not as post-submit error**. This is the durable\n' +
        "shape — illegal parent selections are not present in the option list, so the user can't\n" +
        'construct them. The post-submit error remains as a defense-in-depth backstop (the\n' +
        'Server Action still calls the service, which still throws on bypass), but in normal UI\n' +
        'flow it never fires.\n\n' +
        '**Two components, sharing a Combobox primitive:**\n\n' +
        '- `components/issues/TypePicker.tsx`: simple Radix Select / Combobox over\n' +
        "the 5 types from 2.1.1's `WORK_ITEM_TYPE_METADATA` (epic/story/task/bug/subtask),\n" +
        'with each option showing the type icon + label.\n' +
        '- `components/issues/ParentPicker.tsx`: **async combobox**\n' +
        'taking `childType: WorkItemKind` as a prop. On mount, fetches candidate\n' +
        'parents via a new server action `listCandidateParents(projectId, childType)`\n' +
        'that calls a new `workItemsService.listCandidateParents(projectId, childType,\n' +
        'workspaceId)` (single-op repo read filtering by `kind IN\n' +
        "allowedParentKinds(childType)` — derived from 2.1.2's `parentRules`\n" +
        'inverted — and `archivedAt IS NULL`). Type-ahead filter is client-side over\n' +
        'the returned list (up to ~500 items per project at v1 scale; pagination is deferred per\n' +
        'Epic-6 search). Each row shows `[PROD-N]` + title + kind icon. "No parent"\n' +
        'is the first option.\n\n' +
        'The PARENT picker re-fetches whenever `childType` changes (the parent slot\n' +
        'for an Epic differs from the parent slot for a Subtask). Selecting a parent in the picker\n' +
        'can NEVER produce an illegal pair — the list is pre-filtered. If a child-type change\n' +
        'would invalidate the current parent selection, the parent field is cleared with a one-line\n' +
        'notice ("Parent cleared — <parent> can\'t hold a <new-child-type>"). This is\n' +
        "the user-facing materialization of 2.1.2's matrix.\n\n" +
        "**Why a new service method.** 1.4's `workItemsService` currently\n" +
        'exposes `listChildren` + `getWorkItem` but no "candidates" query.\n' +
        "A bespoke method keeps the picker's filter logic in the service layer (CLAUDE.md\n" +
        "single-source-of-truth rule) and lets Epic 7's planning layer reuse it.\n\n" +
        '## Acceptance criteria\n\n' +
        '- Both components exported from `components/issues/`; both consumed by 2.3.3 (modal) and' +
        ' 2.3.6 (edit form).\n' +
        '- New `workItemsService.listCandidateParents` + `workItemRepository.findByProjectAndKinds`;' +
        ' explicit `workspaceId` WHERE clause per finding #26.\n' +
        '- Vitest: the service returns ONLY items whose kind is in `allowedParentKinds(childType)`' +
        ' for every (childType, projectFixture) cell; excludes archived; cross-workspace returns [];' +
        " reuses 2.1.2's `parentRules` matrix without re-encoding it.\n" +
        '- Component spec (RTL): selecting type=Story shows only Epic candidates in the parent list;' +
        ' switching type=Subtask re-fetches and shows Story/Task/Bug; switching type clears an' +
        ' invalidated parent with the documented inline notice.\n' +
        '- Illegal parent IDs from a forged client payload are still rejected by the service' +
        ' (defense-in-depth) — proved by a server-side test, not just a UI assertion.\n' +
        '- Picker is keyboard-navigable + screen-reader labeled; the STRICT shell-a11y sweep' +
        ' extended to a story page that renders both pickers — zero violations.\n\n' +
        '## Context refs\n\n' +
        '- `lib/issues/issueTypes.ts` (2.1.1) — the 5-type metadata + icons\n' +
        '- `lib/issues/parentRules.ts` (2.1.2) — `canParent`, `allowedChildTypes`; this Subtask' +
        ' uses the inverse: derive `allowedParentKinds(childType)` by inverting the matrix\n' +
        '- `lib/services/workItemsService.ts` + `lib/repositories/workItemRepository.ts` (1.4) —' +
        ' the entity-naming pattern, the workspaceId-filter convention\n' +
        '- `components/ui/Combobox.tsx` or equivalent (1.0.5 design system) — the primitive to' +
        ' compose\n' +
        '- `prodect-core/CLAUDE.md` — 4-layer, entity-naming, workspaceId-filter rules',
    },
    {
      id: '2.3.5',
      title: '`MarkdownEditor` primitive — rich-text description over `descriptionMd`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      descriptionMd:
        'Story 1.4 fixed the durable storage shape — **Markdown source in\n' +
        '`descriptionMd`**, rendered via `react-markdown` +\n' +
        '`remark-gfm` + `rehype-sanitize` + `rehype-highlight`. This Subtask ships the EDITOR\n' +
        'over that source. The shape decision is made and recorded\n' +
        '(decision-authority ladder rung 2 — storage is shipped reality):\n\n' +
        '- **Source of truth:** Markdown text. NOT a CRDT, NOT ProseMirror JSON, NOT HTML.\n' +
        "Concurrent multi-user editing is out of v1 scope (last-write-wins per Linear's v1, surfaced\n" +
        "with optimistic-concurrency rejection in 2.3.6's edit form).\n" +
        '- **Editor library:** `@uiw/react-md-editor` — most-downloaded\n' +
        'React Markdown editor (MIT), pairs natively with our existing\n' +
        '`react-markdown`+`remark-gfm` render path, dark-theme aware,\n' +
        'customizable toolbar. **Why not Tiptap-with-Markdown-mode:** Tiptap stores\n' +
        'ProseMirror JSON and serializes-to-Markdown lossily, which breaks the "source = Markdown"\n' +
        'invariant. **Why not raw textarea + preview only:** we ship a real PM tool;\n' +
        'users expect a toolbar (bold, italic, headings, lists, code, link, image), keyboard\n' +
        'shortcuts (⌘B, ⌘I, ⌘K-link), and slash-style insertions.\n\n' +
        '**Component shape.** `components/ui/MarkdownEditor.tsx` wraps\n' +
        '`@uiw/react-md-editor` with two size variants — `min` (textarea +\n' +
        'preview tab, ~6 lines, for the create modal) and `full` (live split-pane,\n' +
        'toolbar + edit tab + preview tab, ~16+ lines, for the edit form). Both expose a controlled\n' +
        '`value: string` / `onChange(string)` over the raw Markdown.\n' +
        'Image upload is wired as a callback prop `onImageUpload?: (file: File) =>\n' +
        'Promise<string>` (returns the URL to splice into the markdown) — this Subtask\n' +
        'ships the prop wired to a placeholder that throws "image upload not yet enabled"; 2.3.7\n' +
        'plugs in the real Vercel Blob handler. Paste/drop handlers exist; if no\n' +
        '`onImageUpload` handler is provided OR the handler throws, the editor surfaces\n' +
        'a polite inline notice and ignores the image (NEVER silently drops without telling the\n' +
        'user — finding #46-style "no silent failures" rule).\n\n' +
        '**Theming + a11y.** The editor picks up the 1.0.5 theme tokens via CSS-vars\n' +
        'override (the library accepts `data-color-mode` from the existing ThemeProvider\n' +
        '— the wrapper sets it). All buttons get visible focus rings; the preview tab is reachable\n' +
        "via Tab + Enter; the editor's contenteditable surface has `aria-label` from a\n" +
        'required `label` prop on the wrapper.\n\n' +
        '**Render side.** A sibling `components/ui/MarkdownView.tsx` ships\n' +
        "the read-only render path used by the edit form's preview, the future detail page, and any\n" +
        'list-view description preview. Uses the same render chain Story 1.4 already configured.\n' +
        '**The two components share the renderer config** — there is exactly ONE\n' +
        'remark/rehype pipeline in the codebase after this Subtask.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Both components exported from `components/ui/`; both consumed by 2.3.3 (modal, `min`)\n' +
        '  and 2.3.6 (edit form, `full`).\n' +
        '- `@uiw/react-md-editor` added to `package.json`; the wrapper exposes ONLY `value`,' +
        " `onChange`, `label`, `size: 'min' | 'full'`, `onImageUpload?`, `readOnly?`.\n" +
        '- Storage round-trip: a value written through the editor and read back via `MarkdownView`' +
        ' renders identically (Vitest snapshot).\n' +
        '- Render pipeline (`react-markdown` + GFM + sanitize + highlight) is exported from ONE' +
        ' module (`lib/markdown/renderer.tsx`); both editor preview and `MarkdownView` import it.' +
        ' A grep guard in the test suite asserts no other file imports `react-markdown` directly.\n' +
        '- Image-upload callback contract: if `onImageUpload` is absent, paste/drop shows the inline' +
        ' notice "Image uploads aren\'t enabled here" and the image is NOT inserted. If the handler' +
        ' throws, the same notice surfaces and the editor reverts. **NEVER silently drops.**\n' +
        '- Spec under `tests/components/MarkdownEditor.test.tsx` covers: controlled `value`/' +
        '`onChange`; size variants render the expected toolbar set; paste-image-without-handler shows' +
        ' the notice; `readOnly` hides the toolbar + tabs.\n' +
        '- `/tokens` route (or a new `/tokens/markdown-editor` sub-route) renders both components in' +
        ' a specimen state for visual review — added to the STRICT axe sweep, zero violations.\n' +
        '- SSR-safe: the editor library is loaded via `next/dynamic` with `ssr: false` if it touches' +
        ' the DOM at module load; the wrapper handles the loading state gracefully.\n\n' +
        '## Context refs\n\n' +
        '- Existing Story-1.4 description render path (look for current `react-markdown` usage —' +
        ' there may already be a `MarkdownView`-like component to consolidate)\n' +
        "- 1.0.5's `ThemeProvider` + `data-color-mode` contract — how the editor picks up light/dark\n" +
        "- 1.5.5's STRICT axe sweep + Pill-tone fixes — the editor's buttons must use AA-safe tones\n" +
        '- `prodect-core/CLAUDE.md` — DTOs stay shipped reality (no leaked `@uiw/*` types in the' +
        " wrapper's public surface)\n" +
        '- `@uiw/react-md-editor` README — confirm the SSR + dark-mode + image-paste hooks before' +
        ' committing to the wiring',
    },
    {
      id: '2.3.6',
      title: 'Full edit form at `/projects/[key]/issues/[key]/edit` · closes finding #46',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['2.3.3', '2.3.4', '2.3.5'],
      descriptionMd:
        'The full edit form — a dedicated route, not a modal. Lives at\n' +
        '`app/(authed)/projects/[key]/issues/[key]/edit/page.tsx` as a Server Component\n' +
        "that reads the work item via `workItemsService.getWorkItem` + the project's\n" +
        "workflow statuses + the current user's permissions, and renders a client\n" +
        '`EditIssueForm` with two Server Actions:\n' +
        '`updateIssueAction` (everything except status) and `changeStatusAction`\n' +
        '(status only). **The status edit cannot share a code path with the non-status edits**\n' +
        '— this is what closes finding #46.\n\n' +
        "**Finding #46 — resolved here.** Story 1.4's `updateWorkItem`\n" +
        "currently accepts a free-form `status` patch that bypasses 2.2.4's transition\n" +
        'validation. This Subtask:\n\n' +
        "- **Removes** the `status` field from `updateWorkItem`'s\n" +
        '  patch DTO (`UpdateWorkItemInput`) at the service layer.\n' +
        '- **Removes** the `status` handling in the service body.\n' +
        '- **Updates** the 1.4 test that exercised the ungated path so it now drives\n' +
        '  `workItemsService.updateStatus` (the 2.2.4 gated path). Any other caller is\n' +
        '  scanned + redirected.\n' +
        '- **Adds** a guard test asserting `UpdateWorkItemInput` has no\n' +
        '  `status` key (TypeScript compile-time + a runtime grep guard).\n' +
        '- **Edit form** wires the status field to `changeStatusAction`\n' +
        '  (which calls `updateStatus`) — all other fields go through\n' +
        '  `updateIssueAction` (which calls the now-status-free `updateWorkItem`).\n' +
        '  In the UI both controls live on the same form, but the submit handler routes the patch\n' +
        '  through two server roundtrips when both status + non-status fields changed in the same\n' +
        "  edit. Atomic-cross-field semantics are NOT required for v1 (finding #46's whole point is\n" +
        '  that status changes are a separate gated operation; coupling them back to the patch is\n' +
        '  the wrong shape).\n\n' +
        '**Form fields.** Every editable column on `work_item`: Title,\n' +
        'Description (`MarkdownEditor` from 2.3.5, `full` size, with the real\n' +
        'image-upload handler from 2.3.7 wired through if 2.3.7 landed — else the placeholder),' +
        ' Type\n' +
        '+ Parent (2.3.4 pickers — type changes that invalidate the parent clear the parent with the\n' +
        "documented notice), Status (status picker over the project's workflow), Priority, Assignee,\n" +
        'Due date, Estimate (minutes). **Explanation** (`explanationMd`) is\n' +
        'rendered read-only here with an "AI-drafted" badge when `explanationSource ==\n' +
        'ai_draft`; editing the explanation goes to a separate Subtask in a later Story (the\n' +
        'AI-draft regeneration loop is Epic 7). **Reporter** is read-only (set on create,\n' +
        "immutable per Jira/Linear's standard shape).\n\n" +
        "**Optimistic-concurrency check.** The form reads the work item's\n" +
        '`updatedAt` on render and submits it as a hidden field. The Server Action passes\n' +
        'it to `updateWorkItem`, which (this Subtask extends the service to accept) checks\n' +
        'inside the transaction that `updatedAt` matches; mismatch → a typed\n' +
        '`StaleWorkItemError` 409 surfaces as "This issue was edited by someone else —\n' +
        'refresh and retry" with a refresh button. Last-write-wins is the shipped behavior, but the\n' +
        'user sees it instead of silently losing edits.\n\n' +
        '**Revisions.** Every field-level diff lands in the existing 1.4.6 revision\n' +
        "pipeline. The status change flows through 2.2.4's revision path (already in place); the\n" +
        "non-status diff flows through 1.4.6's `updateWorkItem` revision path. After this\n" +
        'Subtask the audit trail is complete for every field on the form.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Route renders for an existing issue; 404 for cross-workspace; redirect to sign-in when' +
        ' unauthenticated; permission gate uses the Story-1.2 membership pattern.\n' +
        '- All listed editable fields are in the form; reporter is read-only; explanation is' +
        ' read-only with the "AI-drafted" badge when applicable.\n' +
        '- `updateIssueAction` calls `updateWorkItem` which NO LONGER accepts `status`.' +
        ' **Grep guard test asserts no `status` key in `UpdateWorkItemInput` nor in the service' +
        ' method body.**\n' +
        '- `changeStatusAction` calls `updateStatus` (2.2.4); illegal-transition surfaces as the' +
        ' inline status-picker error.\n' +
        '- The Story-1.4 test that drove a status change through `updateWorkItem` is updated to' +
        ' drive `updateStatus` instead; all 1.4 tests stay green.\n' +
        '- Stale-edit detection: a Vitest scenario that mutates the row between read + submit' +
        ' produces `StaleWorkItemError` 409; the UI surfaces the refresh banner.\n' +
        '- Mixed-edit (status + non-status fields) is submitted via TWO Server Action calls; both' +
        " succeed or one fails — there's no all-or-nothing requirement (documented in the AC).\n" +
        '- Revisions: a Vitest exercise asserts an edit of title + status produces TWO revision rows' +
        ' (one per action call), each with the right `changeKind` + diff.\n' +
        '- STRICT shell-a11y sweep extends to the edit route; zero violations.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workItemsService.ts` (1.4 + 2.2.4) — `updateWorkItem` (the ungated' +
        ' `status` patch to REMOVE), `updateStatus` (the gated path to route status edits through)\n' +
        '- `lib/workItems/errors.ts` — add `StaleWorkItemError` beside the existing errors; route' +
        ' mapping → 409\n' +
        "- 1.4.6's revision pipeline + 2.2.4's status-revision path — both keep working unchanged\n" +
        '- 2.3.3/2.3.4/2.3.5 components — imported, not re-built\n' +
        '- `app/(authed)/projects/[key]/_components/` — if any pattern exists, mirror it; else' +
        ' establish the per-issue route shape here\n' +
        '- Story 1.2 membership-gating helpers + Story 1.5 layout — the route renders inside the' +
        ' authed shell\n' +
        '- `PRODECT_FINDINGS.md` entry #46 — append `> Resolved: 2.3.6` on completion',
    },
    {
      id: '2.3.7',
      title:
        'Description file upload — Vercel Blob + paste/drop (images inline, other files as links)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.3.5', '2.3.9'],
      descriptionMd:
        'Plugs a real file-upload pipeline into the description editor so paste/drop actually\n' +
        'persists. **GitHub-comment model** (finding #52, decision-authority rung 1 —\n' +
        'Prodect is a dev-oriented Markdown tool): paste/drop **any allowed file**;\n' +
        'an **image embeds inline** (`![alt](url)`, it renders in the\n' +
        'Markdown body), any **other file inserts as a link**\n' +
        '(`[filename](url)`) — because Markdown only renders images inline, a non-image\n' +
        'can only be a link, never a broken embed. This is NOT a general "attachments panel" (a\n' +
        'managed, work_item-linked list with download/delete) — that stays a first-class\n' +
        '**Epic 5** feature and REUSES this same upload service/route/table. v1\n' +
        'storage = **Vercel Blob** via the `@vercel/blob` SDK and the\n' +
        'standard `handleUpload` client-direct-upload pattern (the file goes browser →\n' +
        'Blob directly; the server-side endpoint signs the upload URL and records the metadata).\n\n' +
        '**Prerequisite (manual/human): Subtask 2.3.9** — the\n' +
        'Vercel Blob store + `BLOB_READ_WRITE_TOKEN` must be provisioned for live uploads\n' +
        "(Yue, dashboard). 2.3.7's CODE ships first behind a placeholder token (build green, the\n" +
        'Blob SDK mocked in tests); the feature goes live once 2.3.9 is done. This prerequisite is\n' +
        'now an explicit planned subtask per notes.html mistake #30 (plan ALL subtask types, not\n' +
        'just code).\n\n' +
        '**Why Vercel Blob, not S3.** Decision-authority ladder rung 1 (the\n' +
        "mirror product context): we're already on Vercel + Neon (PRODECT.md lines 549–574); adding\n" +
        'an S3 bucket means a new IAM principal, a new env-var matrix, and a separate per-PR\n' +
        'preview-cleanup story. Blob is in the same Vercel-managed lifecycle as the rest of the\n' +
        'stack — provisioned via the Marketplace, env vars auto-wired, per-preview-deploy cleanup\n' +
        'handled by the same lifecycle hook 1.1.10 set up. **Justified deviation:**\n' +
        'if/when an enterprise customer needs S3 for compliance, the storage adapter behind\n' +
        '`lib/blob/uploader.ts` is the single swap point.\n\n' +
        '**Endpoint.** `POST /api/upload/issue-attachment` using the\n' +
        '`@vercel/blob/client` `handleUpload` helper. Returns the public Blob\n' +
        'URL + the resolved MIME on success (the client needs the MIME to choose\n' +
        '`![]` vs `[]`). **Gate:** session-required; workspaceId\n' +
        'resolved from the session (NOT from the client payload); rate-limited per user (~10\n' +
        'uploads / minute v1, a simple in-memory counter is fine pre-Epic-8); max file size 10 MB.\n' +
        '**Allowed MIME = a general allowlist** (NOT image-only): images\n' +
        '(`image/png|jpeg|gif|webp|svg+xml`), `application/pdf`, plain text /\n' +
        'logs (`text/plain`, `text/csv`, `text/markdown`),\n' +
        '`application/zip`, and common office docs — the allowlist lives in\n' +
        "`lib/blob/allowlist.ts` as a single exported set so Epic 5's attachments panel\n" +
        'reuses the exact policy. Reject everything else (executables/unknown). Rejections return\n' +
        'typed errors: `FileTooLargeError` 413, `UnsupportedFileTypeError`\n' +
        '415, `RateLimitError` 429.\n\n' +
        '**Service + repository.** Per CLAUDE.md 4-layer: the route calls\n' +
        '`attachmentsService.uploadAttachment(file, ctx)` — a GENERAL method, not\n' +
        "image-specific (the rename from the original card's `uploadIssueImage` is the\n" +
        "point of finding #52: one upload primitive serves the inline-image case AND Epic 5's\n" +
        'attachments). The service handles the gates and calls the Blob SDK + writes an\n' +
        '`attachment` row recording the uploader, workspaceId, blob URL, MIME, size, and\n' +
        'original filename. **Schema addition:** new `attachment` table —\n' +
        '`id / workspaceId / uploaderUserId / blobUrl / mimeType / sizeBytes / originalFilename /\n' +
        'createdAt`, with RLS scoped to workspace (mirrors the\n' +
        '`workflow_status` pattern from 2.2.1 — pure workspace gate, no system-admin\n' +
        'hatch, no nullable workspaceId, see finding #44). NOT linked to a specific work_item v1\n' +
        '(the markdown image just references the URL — the row is a billing/audit trail). Linking\n' +
        'attachments to work_items is Epic 5 (file attachments as a first-class issue feature).\n\n' +
        "**Editor wiring.** 2.3.5's `MarkdownEditor` upload hook\n" +
        'generalizes from `onImageUpload` → `onFileUpload` (and the drop/paste\n' +
        'handler stops filtering to images so any allowed file is accepted); the wrapper gains a\n' +
        "default implementation when consumers don't pass one — the edit form (2.3.6) and the\n" +
        'create modal (2.3.3) both pick it up. The handler uploads, then splices by MIME:\n' +
        '**image → `![alt](url)`** (inline), **other →\n' +
        '`[filename](url)`** (link), at the cursor position. Upload-in-flight\n' +
        'surfaces a progress placeholder (`![Uploading…](pending)` /\n' +
        "`[Uploading…](pending)`) that's replaced on resolve; failure surfaces the typed\n" +
        'error message via toast AND leaves the placeholder reverted. **Knock-on:**\n' +
        "rename touches 2.3.5's shipped `onImageUpload` prop — a small refactor (2.3.3 /\n" +
        "2.3.6 currently rely on the default, don't pass it), update 2.3.5's component test.\n\n" +
        '## Acceptance criteria\n\n' +
        '- New migration `add_attachment_and_rls` creates the `attachment` table with the documented' +
        ' columns + forced RLS (pure workspace gate per finding #44).\n' +
        '- `@vercel/blob` added to `package.json`; `BLOB_READ_WRITE_TOKEN` documented in' +
        ' `.env.example` + the CI workflow (placeholder value sufficient for build).\n' +
        '- Endpoint `POST /api/upload/issue-attachment`: thin route, session-required, calls' +
        ' `attachmentsService.uploadAttachment`; returns blob URL + MIME; typed errors → 413/415/429' +
        ' mapping.\n' +
        '- `attachmentsService.uploadAttachment` (GENERAL, not image-only — finding #52) +' +
        ' `attachmentRepository` follow the 4-layer; repo write requires `tx`; service owns the' +
        ' rate-limit + size + MIME gates; the MIME allowlist is the single shared' +
        ' `lib/blob/allowlist.ts` set (reused by Epic 5).\n' +
        '- Vitest: happy path writes the row + returns {url, mime}; oversize → 413, disallowed MIME' +
        ' → 415 (assert a non-image allowed type e.g. `application/pdf` SUCCEEDS, and an executable' +
        ' FAILS), rate-limit fires after threshold; cross-workspace uploader is impossible' +
        ' (workspaceId comes from session).\n' +
        '- Editor integration test — BOTH branches: paste an **image** → resolves to' +
        ' `![filename](…)` (inline); drop a **non-image** (e.g. a .pdf) → resolves to' +
        ' `[filename](…)` (link); each shows the progress placeholder; the failure path reverts +' +
        ' surfaces the typed message.\n' +
        "- Rendering snapshot in `MarkdownView` (2.3.5's render path): the image renders as an" +
        ' `<img>`, the file link as an `<a>`.\n' +
        "- 2.3.5's `MarkdownEditor` prop rename `onImageUpload` → `onFileUpload` applied; its" +
        ' component test updated; 2.3.3 / 2.3.6 unaffected (they use the default).\n' +
        '- Existing per-PR cleanup workflow (`cleanup-preview-deployments.yml` from 1.1.10) is' +
        " updated to also delete the preview's Blob store; documented in the PR body if Vercel's" +
        " auto-lifecycle doesn't cover it (verify against the Vercel Blob docs at execution time).\n" +
        '- STRICT shell-a11y sweep extended to a story page that opens the editor — paste/drop' +
        ' affordances are AA-contrast + keyboard-reachable.\n\n' +
        '## Context refs\n\n' +
        '- `components/ui/MarkdownEditor.tsx` (2.3.5) — the upload hook to fulfill + generalize' +
        ' (`onImageUpload` → `onFileUpload`); drop/paste handler currently image-filtered\n' +
        "- Finding #44 (2.2.1's RLS-policy precedent) — pure workspace gate, no system-admin hatch\n" +
        '- `prisma/migrations/.../workflow_status` (2.2.1) — the migration shape to mirror for the' +
        ' new table\n' +
        '- `@vercel/blob` client-direct-upload docs — verify the exact `handleUpload` shape at' +
        ' execution time (the API is stable but evolves)\n' +
        "- 1.1.10's `cleanup-preview-deployments.yml` — the per-PR cleanup workflow to extend\n" +
        '- `prodect-core/CLAUDE.md` — 4-layer + entity-naming + tx-required-on-writes',
    },
    {
      id: '2.3.8',
      title: 'Story E2E — create → edit → status-change lifecycle (Playwright)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['2.3.3', '2.3.6'],
      descriptionMd:
        'The Story-closing Playwright suite at\n' +
        '`tests/e2e/issue-create-edit-flow.spec.ts`, driving the real stack end-to-end\n' +
        "and surfacing any UI ↔ service-layer seam bugs that unit tests structurally can't catch\n" +
        '(the 1.6.6 pattern — real-stack E2E found two production bugs the unit tests masked).\n' +
        "Sibling to 2.3.2's delete-with-reassign E2E.\n\n" +
        '**Scenarios (all single specs against the real Next.js dev server + Postgres):**\n\n' +
        '- **Happy-path create:** sign in, navigate to a project, press "C", fill\n' +
        'type=Story / title="My story" / description-with-bold-and-image-paste, submit; toast\n' +
        'surfaces the PROD-N identifier; navigate via the toast link to the edit route; verify\n' +
        'every field round-tripped including the rendered image.\n' +
        '- **Type-parent validation surfaced inline:** open create modal, set\n' +
        'type=Subtask, open parent picker → assert only Story/Task/Bug options appear (no Epics,\n' +
        'no other Subtasks); switch type=Epic → assert the parent picker now shows no candidates\n' +
        '("No parent" only).\n' +
        '- **Edit non-status fields:** navigate to `/.../edit` for an\n' +
        'existing issue, change title + priority, submit; verify the update + a single revision\n' +
        'row of changeKind=updated.\n' +
        '- **Status edit goes through the gated path:** on the same edit form,\n' +
        'change status from `todo` → `in_progress` (legal); verify success.\n' +
        'Then try changing to a custom status with NO transition row (illegal restricted-mode);\n' +
        'verify the inline picker error fires AND no revision row was written.\n' +
        "- **Stale-edit detection:** open the edit form, externally bump the row's\n" +
        '`updatedAt` via the `_test` harness, submit; verify the\n' +
        '`StaleWorkItemError` 409 surfaces as the refresh banner.\n' +
        '- **Cross-workspace isolation:** sign in as user-A in workspace-A, navigate\n' +
        "to a URL with workspace-B's issue key → 404 (does not leak title/existence).\n\n" +
        "**Reusable helpers** lifted from 2.2.7's\n" +
        "`tests/e2e/_helpers/workflow.ts` + 1.5.6's\n" +
        '`tests/e2e/_helpers/shell-session.ts`. Any new helper goes under\n' +
        '`tests/e2e/_helpers/issues.ts` (createIssue, openEditForm, submitEditForm).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e --grep issue-create-edit-flow` passes locally + in CI against a fresh-DB' +
        ' run.\n' +
        '- All six scenarios above present as separate specs with the documented assertions.\n' +
        '- Uses stable `data-testid` hooks added in 2.3.3 / 2.3.6 if any are missing — no brittle' +
        ' text/role-only selectors.\n' +
        '- Image-paste scenario uses the Playwright clipboard / file-paste API; if the image-upload' +
        " Subtask 2.3.7 hasn't landed at the time 2.3.8 runs, that single assertion drops to" +
        ' verifying the "image uploads aren\'t enabled" notice instead (the Subtask\'s spec must' +
        ' handle both states cleanly — gated by an env var or a runtime feature-flag read).\n' +
        '- No flake under 10 consecutive runs in CI mode.\n' +
        "- The new `/.../edit` route joins the STRICT shell-a11y sweep (if it didn't already in" +
        ' 2.3.6).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/_helpers/workflow.ts` (2.2.7) — createItem / transition helpers\n' +
        '- `tests/e2e/_helpers/shell-session.ts` (1.5.6) — sign-in + createWorkspace +' +
        ' createProject helpers\n' +
        '- `tests/e2e/workflow-delete-reassign.spec.ts` (2.3.2 — sibling) — the existing Story 2.3' +
        ' E2E to mirror conventions with\n' +
        '- `app/api/_test/work-items/route.ts` — the test harness for forging row state (used for' +
        ' stale-edit)\n' +
        '- `playwright.config.ts` — webServer block',
    },
    {
      id: '2.3.9',
      title: 'Provision Vercel Blob storage + `BLOB_READ_WRITE_TOKEN` (manual/human)',
      status: 'done',
      type: 'manual',
      executor: 'human',
      descriptionMd:
        "The non-code prerequisite 2.3.7's *live* upload path needs — a coding agent can't\n" +
        'do dashboard / SaaS provisioning (mirrors **1.6.7**, the Inngest-cloud +\n' +
        'Vercel wiring). Logged proactively at plan time per notes.html\n' +
        'mistake #30 (Prodect must plan ALL subtask types, not just code).\n\n' +
        '**Steps (Yue, in the Vercel dashboard):** Storage → create a **Blob**\n' +
        'store via the Marketplace; connect it to the `prodect-core` project so\n' +
        '`BLOB_READ_WRITE_TOKEN` is auto-wired into Production + Preview env; confirm the\n' +
        'token reaches the CI workflow (a real value for the preview, placeholder OK for build-only).\n' +
        "Verify per-preview-deploy cleanup is handled by Vercel's lifecycle (else 2.3.7's\n" +
        '`cleanup-preview-deployments.yml` extension covers it).\n\n' +
        "**Ordering:** 2.3.7's CODE can ship first behind a placeholder token (build\n" +
        'green, Blob SDK mocked in tests) — but the feature only works *live* once this is\n' +
        "done. Marked done on Yue's confirmation, no PR (it's secret/dashboard config, no code).\n\n" +
        'Done: Yue provisioned the Blob store 2026-06-03 (BLOB_READ_WRITE_TOKEN + BLOB_STORE_ID +' +
        ' BLOB_WEBHOOK_PUBLIC_KEY auto-wired to prodect-core Prod/Preview/Dev). Live-upload AC' +
        ' verifies once 2.3.7 ships.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A Vercel Blob store exists + is connected to `prodect-core`; `BLOB_READ_WRITE_TOKEN`' +
        ' present in Production + Preview env.\n' +
        '- An image pasted into a description on the Vercel *preview* uploads + renders inline (the' +
        ' 2.3.7 path works end to end).\n' +
        '- Per-PR Blob cleanup confirmed (no orphaned blobs accumulate per preview).',
    },
    {
      id: '2.3.10',
      title:
        'WYSIWYG Markdown editing — edit the rendered view inline, drop the split source/preview' +
        ' (Yue feedback · finding #53)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['2.3.5', '2.3.7'],
      descriptionMd:
        '**Yue feedback (finding #53):** the description editor is a side-by-side\n' +
        '*source* + *preview* split — you type raw Markdown (`**bold**`) on\n' +
        "the left and watch a rendered pane on the right. That's wrong for the product: the user\n" +
        'should **edit the rendered view directly** and see formatting appear inline as\n' +
        'they type (the Linear / Notion / GitHub-comment experience), with NO raw-syntax pane.\n\n' +
        'This **supersedes 2.3.5\'s "source editor, not WYSIWYG" decision.** 2.3.5\n' +
        'chose `@uiw/react-md-editor` and explicitly rejected WYSIWYG on the grounds that\n' +
        'rich editors store ProseMirror JSON and serialize-to-Markdown lossily — which would break\n' +
        "Story 1.4's hard invariant (**source of truth = Markdown text in\n" +
        '`descriptionMd`**). The resolution that satisfies BOTH the UX ask and the\n' +
        'invariant is a **remark-native WYSIWYG** editor — one whose canonical document\n' +
        'model IS Markdown (parsed/serialized by remark), so editing the rendered view round-trips\n' +
        'to Markdown losslessly. **Recommended: `Milkdown`** (ProseMirror +\n' +
        'remark, purpose-built "WYSIWYG markdown" — Markdown is the document model, not a lossy\n' +
        'export); acceptable alternative: `Tiptap` + `tiptap-markdown` (more\n' +
        'popular, but Markdown is a serialization layer over PM JSON — accept ONLY if a round-trip\n' +
        'test proves no drift on our content set). The executor confirms the library at build time\n' +
        'against the round-trip-fidelity criterion; the storage shape does not change.\n\n' +
        '**What stays fixed (the seams 2.3.5/2.3.6 already established):**\n\n' +
        '- **Storage:** still Markdown in `descriptionMd` — no schema\n' +
        "  change, no new column, no JSON blob. The editor's `onChange` still emits a\n" +
        '  Markdown string.\n' +
        '- **Public surface:** the `MarkdownEditor` prop contract is\n' +
        '  UNCHANGED — `value` / `onChange` / `label` /\n' +
        "  `size: 'min' | 'full'` / `onImageUpload?` / `readOnly?` —\n" +
        '  so the two consumers (2.3.3 create modal, 2.3.6 edit form) need ZERO changes. This' +
        ' Subtask\n' +
        '  swaps the editor INTERNALS, not the interface.\n' +
        '- **Read path:** `MarkdownView` / `renderMarkdown`\n' +
        '  (the ONE remark+rehype-sanitize+highlight module) stays the display surface everywhere\n' +
        "  else (detail page 2.4, list previews). The editor's inline rendering is sanitized too" +
        ' (no\n' +
        '  raw-HTML injection through the WYSIWYG).\n' +
        '- **Carried-over behaviour:** image paste/drop via `onImageUpload`\n' +
        '  (placeholder→URL, polite notice on absent/failed — never silent-drop); theme via the\n' +
        '  1.0.5 ThemeProvider (`useOptionalTheme` / dark mode); SSR-safe via\n' +
        '  `next/dynamic({ ssr: false })`; `readOnly` renders the content with\n' +
        '  no editing affordances.\n\n' +
        '**Size variants reinterpreted:** `min` (create modal) = a compact\n' +
        'inline-edit surface (toolbar minimal or a selection bubble-menu, ~6 lines); `full`\n' +
        '(edit form) = the full inline-edit surface with a formatting toolbar (~16+ lines). Neither\n' +
        'shows a raw-source pane. `@uiw/react-md-editor` is removed from\n' +
        '`package.json` once no code imports it.\n\n' +
        '**Full-width editing surface (Yue feedback).** The `full` editor\n' +
        'must use the available screen width for a comfortable writing canvas — the edit-form route\n' +
        '(2.3.6) currently constrains content to a narrow `max-w-[42rem]` column, which\n' +
        'cramps the editor. Widen the edit surface: the editor (and the title/description editing\n' +
        'region of the edit form) should span a wide content container (e.g. `max-w-[64rem]`\n' +
        "/ the page's comfortable reading-plus-editing width, responsive — full width on smaller\n" +
        'viewports), and the editor itself is `width: 100%` of that container. The narrow\n' +
        'column was fine for a read view; an EDIT canvas wants room. (The `min` editor in\n' +
        'the create modal stays bounded by the modal width — the width ask is about the full editor.)\n\n' +
        'Post-build (Yue feedback): (1) E2E create→edit round-trip now types PLAIN PROSE — a WYSIWYG' +
        ' stores typed syntax as literal text + serializes it back escaped, so' +
        ' raw-Markdown-in-textarea round-trip is N/A; fidelity stays gated by the headless round-trip' +
        ' unit test. (2) Edit form widened to full content width (dropped the max-w-64rem cap;' +
        ' metadata grid → lg:grid-cols-3). (3) Removed the duplicate "Description" label at both the' +
        ' edit form + create modal (the editor owns its own label/aria-label).\n\n' +
        "Library shipped: **Tiptap v3 + tiptap-markdown** (over the card's Milkdown rec;" +
        ' round-trip-fidelity gate green). Scope trim: tables out of v1 (lossy round-trip).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Editing happens on the RENDERED view: typing `**bold**`-style content shows **bold**' +
        ' inline (or via toolbar/shortcut), with no separate raw-syntax pane and no side-by-side' +
        ' preview.\n' +
        '- **Full-width canvas (Yue feedback):** the `full` editor uses the available screen width' +
        ' — the edit-form route/page widens from the narrow `max-w-[42rem]` column to a wide editing' +
        ' container (e.g. `max-w-[64rem]`, responsive: full width on smaller viewports), and the' +
        ' editor is `width: 100%` of it. Verified at desktop + a narrow breakpoint (no horizontal' +
        ' overflow). The `min` create-modal editor stays bounded by the modal.\n' +
        '- `descriptionMd` stays Markdown text (no schema/column change); `onChange` emits Markdown.' +
        ' A **round-trip test** proves a representative document (headings, bold/italic, links, lists,' +
        ' task lists, code block, table) survives load → render → edit-noop → serialize with NO drift' +
        ' (this is the gate that justifies the chosen library).\n' +
        "- The `MarkdownEditor` public props are byte-identical to 2.3.5; 2.3.3's create modal is" +
        " unchanged and 2.3.6's edit form changes ONLY its layout-container width (the full-width" +
        ' canvas above) — no prop/logic edits to either consumer. Existing 2.3.3/2.3.5/2.3.6' +
        ' component tests pass or are updated only where they asserted the OLD split-pane internals' +
        ' or the old narrow width.\n' +
        '- Image paste/drop still works (placeholder→URL, polite notice on absent/failed handler,' +
        ' never silent-drop); theme dark/light still applies; `readOnly` shows content with no' +
        ' editing affordances.\n' +
        '- The rendered/edited HTML is sanitized (no raw-HTML/script injection via the WYSIWYG' +
        ' surface).\n' +
        '- `@uiw/react-md-editor` removed from `package.json` once unused; the single-render-module' +
        ' grep guard (2.3.5) still holds (only `lib/markdown/render.tsx` imports `react-markdown`).\n' +
        '- The `/tokens/markdown-editor` specimen + the STRICT shell-a11y sweep stay green: editor' +
        ' is keyboard-operable, the surface is labelled (the `label` prop), toolbar/bubble buttons' +
        ' carry accessible names; third-party editor chrome may keep the documented narrow exclusions' +
        ' (color-contrast / per-svg titles) as in 2.3.5.\n\n' +
        '## Context refs\n\n' +
        '- `components/ui/MarkdownEditor.tsx` (2.3.5) — the prop surface to PRESERVE + the' +
        ' image-paste/theme/SSR behaviour to carry over; `editorConfigFor` is replaced\n' +
        '- `components/ui/MarkdownView.tsx` + `lib/markdown/render.tsx` — the read path + the' +
        ' sanitize/highlight chain to keep as display SoT\n' +
        '- Story 1.4 storage invariant (`descriptionMd` = Markdown source) + the AI-storage boundary' +
        ' note — the constraint that picks a remark-native editor\n' +
        '- 2.3.3 `CreateIssueModal` + 2.3.6 `EditIssueForm` — the two consumers that must NOT need' +
        ' changes\n' +
        '- `Milkdown` (recommended) / `Tiptap`+`tiptap-markdown` docs — confirm SSR + dark-mode +' +
        ' image hooks + Markdown round-trip fidelity before committing\n' +
        '- 1.5.5 STRICT axe sweep + finding #35 AA-tone rules',
    },
    {
      id: '2.3.11',
      title: 'Design — Due date field in the create modal (mirror Jira; finding #56)',
      status: 'done',
      type: 'design',
      executor: 'human',
      dependsOn: ['2.4.11'],
      descriptionMd:
        'Resolves **finding #56** (Yue: "yes, mirror Jira"). Jira\'s create-issue dialog\n' +
        "collects a **Due date**; Prodect's create modal (2.3.3) does not, and its design\n" +
        '(`create.pen`) **omits** a Due-date field — so adding one is UI the\n' +
        "create-modal design doesn't specify. The planning-time **design gate** therefore\n" +
        'requires this design pass BEFORE the code (2.3.12); 2.3.12 is blocked on it.\n\n' +
        'Extend the create-modal design under `design/work-items/` — a\n' +
        '`create.mock.html` (HTML mockup from the live design system, preferred) OR an updated\n' +
        '`create.pen` + a `design-notes.md` entry — adding a **Due date field\n' +
        'row** that composes the shipped `DatePicker` primitive (2.4.11 design /\n' +
        "2.4.12 code) with the create modal's existing label+control row grammar. Placement: **after\n" +
        "Priority**, matching the shipped edit form's field order (Priority → Due date) and Jira.\n" +
        'Due date is **nullable** (placeholder "Select a date", no value by default). Colour\n' +
        'only through `--el-*`; AA-safe.\n\n' +
        '**Scope guard:** Due date only. `create.pen` also designs an\n' +
        '**Assignee** field that was never built (finding #51) — that reconciliation is NOT\n' +
        'in scope here; do not add Assignee.\n\n' +
        'Done: PR #106 merged 2026-06-05, merge commit `8de9cba` — design APPROVED (Yue merged ⇒' +
        ' build 2.3.12 to THIS mockup). `design/work-items/create.mock.html` (HTML mockup from the' +
        ' live `--el-*` tokens) + `design-notes.md` section + surface-table row shipped: the create' +
        ' modal with a NEW **Due date row placed AFTER Priority**, composing the already-shipped' +
        " `DatePicker` (2.4.11/2.4.12) — no new component, only placement + label, mirroring Jira's" +
        " create dialog + the shipped edit form's Priority→Due date order. Two panels: Due date empty" +
        ' (placeholder) · filled with the calendar open. Nullable default;' +
        ' collect-in-form-state→write-on-create documented for 2.3.12. **Render-checklist applied**' +
        ' (icon viewBox, field-as-container/Clear-as-sibling, prettier, both panels, light+dark).' +
        ' Assignee (in `create.pen`, never built — finding #51) explicitly left out of scope. Gates' +
        ' 2.3.12 (now ready).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A create-modal design asset (`create.mock.html` or updated `create.pen`)\n' +
        '+ a `design-notes.md` entry show the Due date field — the `DatePicker` trigger,\n' +
        'its "Due date" label, placement after Priority, and the empty/nullable default.\n' +
        "- Mirrors Jira's create-dialog Due date + the shipped edit-form field order; colour via\n" +
        '`--el-*`; AA-safe.\n' +
        '- Assignee is explicitly left out (finding #51, separate).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/create.pen` — the create-modal surface to extend (Priority + Assignee' +
        ' designed; no Due date)\n' +
        '- `design/work-items/datepicker.mock.html` + `design-notes.md` (2.4.11) — the DatePicker' +
        ' primitive to compose\n' +
        "- The shipped edit form's Priority → Due date → Estimate row order (2.3.6," +
        ' `EditIssueForm`) — the field grammar to mirror',
    },
    {
      id: '2.3.12',
      title: 'Collect a Due date in the create modal (mirror Jira; finding #56)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['2.3.11', '2.4.12'],
      descriptionMd:
        'Add a **Due date** field to `CreateIssueModal` (2.3.3) using the shipped\n' +
        '`DatePicker` (2.4.12), placed per the 2.3.11 design (after Priority). Collect the ISO\n' +
        "`YYYY-MM-DD` in the modal's form state and pass it through\n" +
        '`createIssueAction` → `createWorkItem` so a new issue persists its due date.\n' +
        'Mirror Jira: Due date is **optional/nullable** at create.\n\n' +
        '**Through the 4-layer path:** confirm `CreateWorkItemInput` /\n' +
        '`createWorkItem` accept `dueDate`; if not, thread it through (DTO → service →\n' +
        'repository) — the work_item already HAS a `dueDate` column (the edit form writes it), so\n' +
        'this is wiring the create path to the existing field, no schema change. UTC-safe conversion' +
        ' (the\n' +
        'same `${date}T00:00:00.000Z` the edit form + detail rail use). Resolves\n' +
        '**finding #56**.\n\n' +
        'Done: PR #107 merged 2026-06-05, merge commit `68a34b1` — RE-CLOSES Story 2.3. Resolves' +
        ' finding #56 ("mirror Jira"): the create modal now collects an optional **Due date** via' +
        ' the shipped `DatePicker`, placed AFTER Priority per the 2.3.11 design. Held as the' +
        " picker's `YYYY-MM-DD` value → converted to a UTC ISO string on submit (the same" +
        ' `${date}T00:00:00.000Z` the edit form uses) → sent ONLY when set (plain-create payload' +
        " unchanged, so the exact-match test stays green). `createIssueAction`'s" +
        ' `CreateIssueInput` gained `dueDate?`, threaded to `createWorkItem`. **Pure create-path' +
        ' wiring** — the service/DTO/`work_item.dueDate` column already accepted dueDate (the edit' +
        ' form writes it; `service-edge-cases.test.ts` already covers create-with-dueDate at the' +
        ' service layer), so no schema/service/repo change (4-layer contract intact). New component' +
        ' test: choose Today → UTC ISO threaded; no-date create omits the key (Radix-Popover' +
        ' happy-dom polyfills). Assignee at create (in `create.pen`, never built — finding #51)' +
        ' left untouched. tsc/eslint/prettier clean, 112/112 component tests; real-PG' +
        ' create-with-dueDate covered in CI.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The create modal shows a Due date field (`DatePicker`, after Priority) matching the\n' +
        '2.3.11 design; selecting a date is optional.\n' +
        '- Creating an issue WITH a due date persists it (visible on the detail rail / edit form);\n' +
        'creating WITHOUT one stores `null` — no off-by-one (UTC-safe).\n' +
        '- `createWorkItem` accepts `dueDate` through the Route/Action → Service →\n' +
        'Repository path (added if missing); no raw-Prisma shortcut.\n' +
        '- Component test: create-with-due-date + create-without; existing create-modal tests stay' +
        ' green.\n' +
        'tsc / eslint / prettier clean; next build compiles.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/_components/CreateIssueModal.tsx` — the modal to extend' +
        ' (type/parent/title/description/priority today)\n' +
        '- `app/(authed)/issues/actions.ts` `createIssueAction` + `createWorkItem` service +' +
        ' `CreateWorkItemInput` DTO — the create path to thread `dueDate` through\n' +
        '- `components/ui/DatePicker` (2.4.12) + how `EditIssueForm` (2.3.6) holds/converts' +
        ' `dueDate`\n' +
        '- The 2.3.11 design asset (create-modal Due date) — the layout authority',
    },
  ],
};
