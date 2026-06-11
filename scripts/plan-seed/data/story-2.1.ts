import type { PlanStory } from '../types';

/**
 * Story 2.1 — Issue types + the type-parent rule layer.
 * Faithful transcription of prodect_plan/story-2.1-issue-types.html (frozen archive).
 */
export const story_2_1: PlanStory = {
  id: '2.1',
  title: 'Issue types + the type-parent rule layer',
  status: 'done',
  descriptionMd:
    'The first story of the PM core. Establishes the five user-facing issue **types** ' +
    "(epic / story / task / bug / subtask) on top of Story 1.4's `work_item` model, the " +
    'service-layer enforcement of the kind-parent rules, and the type metadata (icon, color, ' +
    'allowed children) every later issue-tracking surface reads. After this story, the rest of ' +
    'Epic 2 (create/edit, detail, list) and Epic 3 (boards) have a typed, validated issue ' +
    'primitive to build on.\n\n' +
    '**Prerequisites:** Story 1.4 ships the `work_item` table with `kind` ' +
    '(epic/story/task/bug/subtask), `parent_id`, `status`, and the DB-level kind-parent ' +
    'constraints + depth limit. Story 1.3 ships projects + the per-project work-item-key counter. ' +
    'This Story does NOT re-create the schema — it adds the *product* layer (type metadata + ' +
    'service-layer rules + issue-key assignment) on top. All work follows ' +
    "`motir-core/CLAUDE.md`'s 4-layer architecture (Route → Service → Repository → Prisma).",
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install && pnpm prisma generate`.\n' +
    '- `pnpm test` — the 2.1.4 integration suite proves type metadata, validation (both layers), ' +
    'and key concurrency.\n' +
    '- From a REPL or a scratch route, create an epic → story → task → bug and confirm sequential ' +
    'keys; attempt an illegal parent (task → epic) and confirm a clean 422 `INVALID_PARENT_TYPE`.',
  items: [
    {
      id: '2.1.1',
      title: 'Issue-type metadata + the kind→type mapping',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['1.4.2'],
      descriptionMd:
        "Story 1.4's `work_item.kind` column already holds `epic/story/task/bug/subtask`. This " +
        'Subtask adds the **product-facing type layer**: a single source of truth (a typed module, ' +
        'e.g. `lib/issues/issueTypes.ts`) mapping each user-facing issue type to its metadata — ' +
        'display label, icon, color token, and the set of *allowed child types*. The five v1 issue ' +
        'types are **epic**, **story**, **task**, **bug**, **subtask** — the same five Jira ships by ' +
        "default, and exactly the five values Story 1.4's `WorkItemKind` enum + DB triggers already " +
        'enforce, so the metadata map stays *total* over the kind enum (a `subtask` row is a legal ' +
        'DB state, so any picker/icon/validation lookup must resolve for it). *(Amended after ' +
        'Subtask 2.1.1 review — the original card under-scoped this to four and excluded `subtask`; ' +
        'corrected to five.)* (The planning-side `type` column — code/design/copy/legal — is a ' +
        'separate axis owned by the AI layer and is NOT what this Subtask touches.)\n\n' +
        '**Why a metadata module, not a DB table:** the type set is small, fixed for v1, and read ' +
        'on nearly every render (icons, pickers, validation). A typed in-code map gives compile-time ' +
        'safety and zero query cost. If per-project custom issue types become a requirement later, ' +
        'this module is the single place that grows into a table-backed lookup — but YAGNI for v1 ' +
        '(durable shape: a typed constant, not a premature config table).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A typed module exports the five issue types with: label, icon (lucide component ref), ' +
        'color token (from the design system), and `allowedChildTypes`.\n' +
        '- The allowed-children map encodes: epic → [story, task, bug]; story → [task, bug, ' +
        "subtask]; task → [bug, subtask]; bug → [subtask]; subtask → []. (Inverts Story 1.4's " +
        '`kind`-parent constraint incl. `subtask.parent ∈ {story, task, bug}`; this is the ' +
        'product-readable form of it. Note bug is NOT a leaf — subtask is the single leaf.)\n' +
        '- A helper `canParent(parentType, childType): boolean` the service layer uses for ' +
        'validation.\n' +
        '- Unit tests over `canParent` for every legal + illegal pair.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — the `work_item` model + `kind` enum from Story 1.4\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule\n' +
        '- Design-system color tokens + icon set (Story 1.0.5)',
    },
    {
      id: '2.1.2',
      title: 'Service-layer type-parent validation',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 15,
      dependsOn: ['2.1.1'],
      descriptionMd:
        "Add an `issuesService` (and a thin `workItemRepository` if Story 1.4 didn't already ship " +
        'one) enforcing the type-parent rules at the application layer *before* any write, so the ' +
        'API returns a clean typed error rather than relying on the DB constraint to reject with a ' +
        'raw Postgres error. The DB constraint from 1.4 stays as the structural backstop (defense ' +
        'in depth); this layer is the friendly gate.\n\n' +
        '**Why both layers:** the 1.4 DB constraint guarantees integrity even against direct ' +
        'writes, but a 500 from a constraint violation is a poor API contract. The service ' +
        'validates first and throws `InvalidParentTypeError` (→ 422) with a message naming the ' +
        'offending pair. Same pattern as the workspace invite errors from 1.2.5.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `issuesService.assertValidParent(parentType, childType)` throws a typed ' +
        '`InvalidParentTypeError` (code `INVALID_PARENT_TYPE`) on illegal pairs.\n' +
        '- The create/move paths (built in 2.1.3 and later Stories) call it before writing.\n' +
        '- Depth rule honored: a subtask/bug at the leaf cannot parent anything (delegates to ' +
        '`canParent` from 2.1.1).\n' +
        '- Vitest (real Postgres) proving the service rejects an illegal pair AND that the DB ' +
        'constraint still rejects a direct illegal write (both layers verified).\n\n' +
        '## Context refs\n\n' +
        '- `lib/issues/issueTypes.ts` from 2.1.1\n' +
        '- `lib/services/*` + `lib/repositories/*` patterns + `lib/workspaces/errors.ts` ' +
        '(typed-error precedent from 1.2.5)\n' +
        "- Story 1.4's DB constraint definition",
    },
    {
      id: '2.1.3',
      title: 'Issue-key assignment on create (PROJ-123)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.1.2', '1.3.1'],
      descriptionMd:
        'Wire issue creation in `issuesService.createIssue(...)` to assign a human-readable key ' +
        "(`{PROJECT_KEY}-{n}`, e.g. `PROD-123`) using Story 1.3's per-project key counter, " +
        'atomically with the issue insert. The counter increment + issue insert happen in one ' +
        "`$transaction` so two concurrent creates can't collide on the same number.\n\n" +
        '**Why atomic:** the key counter is contended — every create in a project reads-then-' +
        'increments it. Without a transaction + row lock (`SELECT … FOR UPDATE` on the project ' +
        "counter row, per CLAUDE.md's transaction rules), two simultaneous creates could both read " +
        '`n` and both mint `PROD-n`. Lock the counter row, increment, insert, commit.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `createIssue` assigns `{projectKey}-{n}` using 1.3's counter, atomic with the insert, " +
        'inside one transaction with a FOR UPDATE lock on the counter row.\n' +
        '- Validates parent type via 2.1.2 before writing.\n' +
        '- Keys are unique within a project and monotonically increasing; deleting an issue does ' +
        'not recycle its key.\n' +
        '- Vitest concurrency test: N parallel creates yield N distinct sequential keys (no ' +
        'duplicates, no gaps from the lock path).\n\n' +
        '## Context refs\n\n' +
        "- Story 1.3's identifier generator / key counter\n" +
        '- `workspacesService.createWorkspace` — the existing atomic-multi-write + collision ' +
        'pattern to mirror\n' +
        '- `motir-core/CLAUDE.md` — transaction + FOR UPDATE rules',
    },
    {
      id: '2.1.4',
      title: 'Tests — type metadata, validation, key concurrency',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['2.1.1', '2.1.2', '2.1.3'],
      descriptionMd:
        'Consolidated test coverage for the type layer: the `canParent` matrix, service-layer ' +
        'rejection of illegal parents (+ the DB-constraint backstop), and the key-assignment ' +
        'concurrency guarantee. Most assertions live with their Subtasks; this Subtask owns the ' +
        'cross-cutting integration test that exercises create → validate → key end to end against ' +
        "real Postgres, and is the Story's CI gate.\n\n" +
        '## Acceptance criteria\n\n' +
        '- Integration test: create an epic, a child story, a child task, a bug — all succeed and ' +
        'get sequential keys.\n' +
        '- Illegal parents rejected at the service (422) AND the DB (constraint) layer.\n' +
        '- Concurrency: parallel creates yield distinct keys.\n' +
        '- All 4 quality gates green; suite green.\n\n' +
        '## Context refs\n\n' +
        '- `tests/helpers/db.ts` truncate helper\n' +
        '- The 2.1.1–2.1.3 implementations',
    },
  ],
};
