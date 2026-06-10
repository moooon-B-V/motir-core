/**
 * Board-shaped large seed (Subtask 3.5.1) — the at-scale fixture the Epic-3
 * cross-cutting board journey (Stories 3.5.2 / 3.5.3) runs against.
 *
 * `scripts/seed-large.ts` (Subtask 2.5.16, finding #57) builds a TREE/LIST-shaped
 * tenant to make List pagination + Tree lazy-load visible. Its issues are NOT
 * spread across the board's statuses, assignees, priorities, or epics, so a board
 * over it piles every card into one column with no lanes. This module is the
 * board-shaped variant: it populates a project so its default Kanban board shows
 * the real-team scale every board surface needs to be exercised at —
 *
 *   - every workflow **status** populated (so each board **column** has cards),
 *     with one **tall** column far past the row-window for virtualization;
 *   - many distinct **assignees** + an unassigned bucket (so group-by Assignee
 *     produces many lanes + the catch-all);
 *   - several **epics** with stories under them + root stories under none (so
 *     group-by Epic produces many lanes + the catch-all);
 *   - every **priority** (so group-by Priority produces all five lanes);
 *   - a **Done-age spread** in the terminal columns — some cards touched inside
 *     the Done-age window, some backdated well outside it — so the age-based
 *     trim (3.8.2) is observable.
 *
 * It is service-routed and idempotent-friendly like the original (every card is
 * created through the shipped allocate-key + `workItemRepository.create` path
 * inside a transaction — NO raw inserts that would skip the kind-parent triggers).
 * The ONE raw statement is an `UPDATE ... "updatedAt"` to backdate the aged-out
 * terminal cards: `updatedAt` is `@updatedAt`-managed, so the Done-age window
 * (which keys off it, lacking a `completedAt` column — see boardsService) can
 * only be reached by a direct timestamp write. This mirrors the exact pattern the
 * 3.8.2 unit + E2E load tests already use (`tests/boards/projection.test.ts`,
 * `tests/e2e/board-load.spec.ts`).
 *
 * Pure of the script's tenant bootstrap: it takes an already-created
 * workspace/project/owner + the assignee pool, so the distribution vitest can
 * drive it against a small test tenant while `seed-large.ts` drives it at full
 * size. It returns a {@link SeedLargeBoardManifest} describing exactly what it
 * created, so callers (and the test) can assert the distribution without
 * re-deriving it.
 */
import { BoardType, Prisma, type WorkItemKind, type WorkItemPriority } from '@prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { keyForAppend } from '@/lib/workItems/positioning';

/** The five priority enum values, lowest→highest (the group-by Priority lanes). */
const PRIORITIES: WorkItemPriority[] = ['lowest', 'low', 'medium', 'high', 'highest'];

/** The board-seed tenant owner's credentials — exported (no side effects) so the
 *  at-scale E2E specs/helpers can sign in as the owner `db:seed:large` creates.
 *  `seed-large.ts` consumes these too, so there is one source of truth. */
export const SEED_LARGE_OWNER_EMAIL = 'seed-large@prodect.dev';
export const SEED_LARGE_OWNER_PASSWORD = 'hunter2hunter2'; // satisfies the credential-strength rule

export interface SeedLargeBoardParams {
  workspaceId: string;
  projectId: string;
  /** The project's identifier prefix (e.g. `BIG`) for the denormalized `identifier`. */
  projectIdentifier: string;
  /** The reporter for every seeded card (the tenant owner). */
  ownerId: string;
  /** The assignee pool — workspace members the cards round-robin across; a
   *  fraction is left unassigned for the catch-all lane. Empty → all unassigned. */
  memberIds: string[];
}

export interface SeedLargeBoardOptions {
  /** Epic lanes — one epic card each, with `storiesPerEpic` stories under it. */
  epics: number;
  /** Stories created under EACH epic (these carry the spread of status/priority/assignee). */
  storiesPerEpic: number;
  /** Root stories with NO epic ancestor → the epic catch-all lane. */
  rootStories: number;
  /** Extra cards piled into the tall status (for virtualization). */
  tallColumnExtra: number;
  /** Every Nth assignable card is left unassigned → the assignee catch-all (0 = none unassigned). */
  unassignedEvery: number;
  /** Every Nth terminal (done/cancelled) card is backdated OUTSIDE the Done-age window. */
  doneAgedOutEvery: number;
}

/** Full-size board-mode defaults (~2,000 cards) — overridden small in tests. */
export const SEED_LARGE_BOARD_DEFAULTS: SeedLargeBoardOptions = {
  epics: 6,
  storiesPerEpic: 280,
  rootStories: 200,
  tallColumnExtra: 200,
  unassignedEvery: 5,
  doneAgedOutEvery: 2,
};

export interface SeedLargeBoardManifest {
  /** Total cards created (epics + their stories + root stories + tall-column extras). */
  created: number;
  /** The project's workflow status keys, in board-column order. */
  statusKeys: string[];
  /** The terminal (category `done`) status keys (Done / Cancelled columns). */
  terminalStatusKeys: string[];
  /** The status given the tall column (most cards) for virtualization. */
  tallStatusKey: string;
  /** Card count per status key — every key is present and > 0. */
  perStatus: Record<string, number>;
  /** Distinct assignees actually used (≤ memberIds.length). */
  assigneeCount: number;
  /** Cards left unassigned (the assignee catch-all population). */
  unassignedCount: number;
  /** Epic lanes created (each an epic with stories under it). */
  epicLaneCount: number;
  /** Cards with no epic ancestor (epics themselves + root stories) — the epic catch-all. */
  noEpicCount: number;
  /** The priority enum values used (all five). */
  priorities: WorkItemPriority[];
  /** Terminal cards backdated OUTSIDE the Done-age window (trimmed from the column). */
  terminalAgedOut: number;
  /** Terminal cards left INSIDE the Done-age window (still rendered). */
  terminalInWindow: number;
}

export async function seedLargeBoard(
  params: SeedLargeBoardParams,
  options: Partial<SeedLargeBoardOptions> = {},
): Promise<SeedLargeBoardManifest> {
  const opts: SeedLargeBoardOptions = { ...SEED_LARGE_BOARD_DEFAULTS, ...options };
  const { workspaceId, projectId, projectIdentifier, ownerId, memberIds } = params;

  // The board columns ARE the project's workflow statuses (3.1.2). Read them
  // through the service so the spread tracks whatever workflow the project has,
  // not a hardcoded list, and so terminal detection uses the real categories.
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  const statusKeys = [...statuses]
    .sort((a, b) => a.position.localeCompare(b.position))
    .map((s) => s.key);
  if (statusKeys.length === 0) {
    throw new Error('seedLargeBoard: project has no workflow statuses — cannot seed a board.');
  }
  const terminalStatusKeys = statuses.filter((s) => s.category === 'done').map((s) => s.key);
  const nonTerminalKeys = statusKeys.filter((k) => !terminalStatusKeys.includes(k));
  // The tall column: prefer `in_progress`, else the first non-terminal status,
  // else the first status — the column piled past the row-window for virtualization.
  const tallStatusKey =
    statusKeys.find((k) => k === 'in_progress') ?? nonTerminalKeys[0] ?? statusKeys[0]!;

  const perStatus: Record<string, number> = Object.fromEntries(statusKeys.map((k) => [k, 0]));
  const usedAssignees = new Set<string>();
  let created = 0;
  let assignableIdx = 0; // drives the assignee + unassigned round-robin
  let unassignedCount = 0;
  let noEpicCount = 0;
  const terminalIds: string[] = [];

  // `position` MUST be a valid fractional-indexing key (the `keyForAppend` /
  // `keyBetween` form the app mints), NOT a zero-padded number: a board MOVE
  // recomputes the dropped card's key via `generateKeyBetween` against its new
  // neighbours' positions, and that library REJECTS keys like "00000001"
  // ("invalid order key head: 0"). A plain numeric pad sorts fine — so the board
  // RENDERS in order — but every drag 500s, which is exactly the at-scale
  // interaction journey (3.5.2/3.5.3) this fixture exists to support. So mint a
  // monotonically-appended valid key per card (creation order = board order),
  // the same path `workItemsService.create` uses.
  let positionCursor: string | null = null;
  const nextPosition = (): string => (positionCursor = keyForAppend(positionCursor));

  async function createOne(args: {
    kind: WorkItemKind;
    title: string;
    parentId: string | null;
    status: string;
    priority: WorkItemPriority;
    assigneeId: string | null;
  }): Promise<string> {
    const id = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const key = await projectRepository.allocateWorkItemNumber(projectId, tx);
      const row = await workItemRepository.create(
        {
          workspaceId,
          projectId,
          parentId: args.parentId,
          kind: args.kind,
          key,
          identifier: `${projectIdentifier}-${key}`,
          title: args.title,
          reporterId: ownerId,
          status: args.status,
          priority: args.priority,
          assigneeId: args.assigneeId,
          position: nextPosition(),
        },
        tx,
      );
      return row.id;
    });
    created++;
    perStatus[args.status] = (perStatus[args.status] ?? 0) + 1;
    if (terminalStatusKeys.includes(args.status)) terminalIds.push(id);
    if (args.assigneeId === null) unassignedCount++;
    else usedAssignees.add(args.assigneeId);
    return id;
  }

  // Round-robin assignee: cycle the member pool, dropping every `unassignedEvery`-th
  // card to the unassigned catch-all. The member cursor (`memberRot`) advances ONLY
  // on assigned cards — decoupled from the unassigned cadence so EVERY member is
  // used even when `unassignedEvery` equals the pool size (else the `i % N == 0`
  // slot would always steal member 0).
  let memberRot = 0;
  function nextAssignee(): string | null {
    const i = assignableIdx++;
    if (memberIds.length === 0) return null;
    if (opts.unassignedEvery > 0 && i % opts.unassignedEvery === 0) return null;
    return memberIds[memberRot++ % memberIds.length]!;
  }

  // A monotonic counter across ALL spread cards so status (round-robin over the
  // FULL status list, so every column is populated) + priority cycle independently
  // of the epic/story nesting.
  let spreadIdx = 0;
  function nextStatus(): string {
    return statusKeys[spreadIdx % statusKeys.length]!;
  }
  function nextPriority(): WorkItemPriority {
    return PRIORITIES[spreadIdx % PRIORITIES.length]!;
  }

  async function createSpreadCard(
    kind: WorkItemKind,
    title: string,
    parentId: string | null,
  ): Promise<string> {
    const id = await createOne({
      kind,
      title,
      parentId,
      status: nextStatus(),
      priority: nextPriority(),
      assigneeId: nextAssignee(),
    });
    spreadIdx++;
    return id;
  }

  // ── Epics + their stories (the epic lanes) ─────────────────────────────────
  for (let e = 0; e < opts.epics; e++) {
    // The epic card itself: spread like any card, but it has no ancestor epic →
    // it lands in the epic catch-all lane.
    const epicId = await createSpreadCard('epic', `Board epic ${e + 1}`, null);
    noEpicCount++;
    for (let s = 0; s < opts.storiesPerEpic; s++) {
      await createSpreadCard('story', `Story ${e + 1}.${s + 1}`, epicId);
    }
  }

  // ── Root stories under no epic (the epic catch-all population) ──────────────
  for (let r = 0; r < opts.rootStories; r++) {
    await createSpreadCard('story', `Loose story ${r + 1}`, null);
    noEpicCount++;
  }

  // ── Tall column: pile extras into the tall status (virtualization) ─────────
  // These keep the assignee/priority spread but are pinned to the tall status so
  // it dwarfs the others — round-robin over the FULL list never makes one column
  // tall on its own.
  for (let t = 0; t < opts.tallColumnExtra; t++) {
    const id = await createOne({
      kind: 'task',
      title: `Tall-column task ${t + 1}`,
      parentId: null,
      status: tallStatusKey,
      priority: PRIORITIES[t % PRIORITIES.length]!,
      assigneeId: nextAssignee(),
    });
    noEpicCount++; // a root task has no epic ancestor
    void id;
  }

  // ── Done-age spread: backdate a fraction of terminal cards outside the window ─
  // The ONLY raw write — `updatedAt` is @updatedAt-managed, so the age-based
  // window (3.8.2) is reachable only by a direct timestamp. Same pattern as
  // tests/boards/projection.test.ts. Backdate well past any plausible window.
  const agedOutIds = terminalIds.filter(
    (_, i) => opts.doneAgedOutEvery > 0 && i % opts.doneAgedOutEvery === 0,
  );
  if (agedOutIds.length > 0) {
    await db.$executeRaw`
      UPDATE "work_item"
         SET "updatedAt" = now() - interval '400 days'
       WHERE id IN (${Prisma.join(agedOutIds)})`;
  }

  return {
    created,
    statusKeys,
    terminalStatusKeys,
    tallStatusKey,
    perStatus,
    assigneeCount: usedAssignees.size,
    unassignedCount,
    epicLaneCount: opts.epics,
    noEpicCount,
    priorities: PRIORITIES,
    terminalAgedOut: agedOutIds.length,
    terminalInWindow: terminalIds.length - agedOutIds.length,
  };
}

// ── Sprint-shaped large seed (Subtask 4.7.1) ────────────────────────────────
// The at-scale SCRUM fixture the Epic-4 cross-cutting Scrum journey (Stories
// 4.7.2 / 4.7.3) runs against — the Scrum analogue of {@link seedLargeBoard}.
//
// `seedLargeBoard` spreads issues across every column / assignee / priority /
// epic + a Done-age spread, but its issues are NOT associated with a sprint, so
// the scrum projection (4.5.2) returns `sprint: null` over it (empty board, "no
// active sprint"). This sibling COMPOSES that board-shaped distribution and adds
// the SPRINT dimension on top:
//
//   (a) flips the project's default board to `scrum` (so `getBoard` takes the
//       4.5.2 sprint-scoped path);
//   (b) creates an `active` sprint (state-set directly, the way the 4.5.x
//       projection tests do — the lifecycle UI is Story 4.4, not depended on
//       here) plus a `planned` carry-over TARGET sprint (the 4.7.3
//       complete-with-carry-over journey needs a non-backlog target);
//   (c) associates a large bounded set of the board-shaped issues with the
//       active sprint, leaving a slice OUTSIDE it (still in the backlog) so a
//       scope test can assert those are absent from the scrum board;
//   (d) gives the sprint issues a story-point spread (some estimated, some NULL)
//       so the header committed/completed/remaining + per-column point pills are
//       at scale and the unestimated-→0 path is covered.
//
// The sprint association + the point spread are applied with RAW `UPDATE`s, NOT
// `db.workItem.update`, ON PURPOSE: `updatedAt` is `@updatedAt`-managed, and
// `seedLargeBoard` has already backdated a fraction of terminal cards' updatedAt
// to age them OUT of the Done-age window. A Prisma client update would bump
// updatedAt and silently un-age them, collapsing the Done-age spread; a raw SQL
// UPDATE leaves updatedAt untouched. This is the same reason `seedLargeBoard`
// itself backdates via raw SQL.

/** The default story-point values cycled across the estimated sprint issues
 *  (Jira's Fibonacci-ish deck) — wide enough that the header point totals are at
 *  scale and a single 40-card page sum never approximates the sprint total. */
const SCRUM_POINT_DECK = [1, 2, 3, 5, 8, 13] as const;

export interface SeedLargeScrumSprintOptions extends Partial<SeedLargeBoardOptions> {
  /** Of the board-shaped issues (creation order), every Nth is left OUTSIDE the
   *  active sprint (stays in the backlog) — the scope catch-all. Must be ≥ 2 so
   *  the sprint still holds the bulk of the set. Default 7. */
  backlogSliceEvery?: number;
  /** Of the IN-sprint issues, every Nth is left UNESTIMATED (`storyPoints` NULL)
   *  so the contributes-0 path is covered. Default 4. */
  unestimatedEvery?: number;
  /** The active sprint's window: it started `startedDaysAgo` ago and ends
   *  `endsInDays` from now (a live, non-overdue sprint). Defaults 3 / 11. */
  startedDaysAgo?: number;
  endsInDays?: number;
}

export interface SeedLargeScrumSprintManifest extends SeedLargeBoardManifest {
  /** The active sprint the scrum board scopes to. */
  activeSprintId: string;
  activeSprintName: string;
  /** The `planned` carry-over target sprint (the 4.7.3 complete journey's target). */
  targetSprintId: string;
  targetSprintName: string;
  /** Issues associated with the active sprint (on the scrum board). */
  sprintIssueCount: number;
  /** Issues left OUTSIDE the sprint, in the backlog (absent from the scrum board). */
  backlogIssueCount: number;
  /** In-sprint issues given a non-NULL story-point estimate. */
  estimatedSprintIssueCount: number;
  /** SUM of the estimated in-sprint issues' story points (the header "committed"). */
  committedPoints: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Chunk `ids` and raw-UPDATE each chunk to keep the `IN (...)` parameter list
 *  well under Postgres' bind limit even at full seed size. */
async function rawUpdateIn(ids: string[], assign: Prisma.Sql): Promise<void> {
  const CHUNK = 1000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    await db.$executeRaw`UPDATE "work_item" SET ${assign} WHERE id IN (${Prisma.join(slice)})`;
  }
}

export async function seedLargeScrumSprint(
  params: SeedLargeScrumSprintParams,
  options: SeedLargeScrumSprintOptions = {},
): Promise<SeedLargeScrumSprintManifest> {
  const backlogSliceEvery = Math.max(2, options.backlogSliceEvery ?? 7);
  const unestimatedEvery = Math.max(2, options.unestimatedEvery ?? 4);
  const startedDaysAgo = options.startedDaysAgo ?? 3;
  const endsInDays = options.endsInDays ?? 11;
  const { workspaceId, projectId } = params;

  // 1. Build the board-shaped distribution (every column / lane / priority +
  //    Done-age spread) — reused unchanged. `options` is passed straight through:
  //    the board keys a caller set are honoured, the ones it OMITS fall back to
  //    SEED_LARGE_BOARD_DEFAULTS (so the Done-age spread etc. survive), and the
  //    scrum-only keys (backlogSliceEvery / unestimatedEvery / window) are extra
  //    props seedLargeBoard ignores. (Do NOT re-pick the board keys explicitly —
  //    that would pass `doneAgedOutEvery: undefined`, which spreads OVER and
  //    clobbers the default, silently dropping the Done-age spread.)
  const boardManifest = await seedLargeBoard(params, options);

  // 2. Flip the project's seeded default board (kanban, 3.1.2) to scrum so
  //    `getBoard` takes the 4.5.2 sprint-scoped path. The columns + mappings are
  //    untouched (only the kind changes), exactly as the projection tests do.
  await db.board.updateMany({ where: { projectId }, data: { type: BoardType.scrum } });

  // 3. The active sprint + the planned carry-over target. State + window set
  //    directly (the 4.4 lifecycle UI is not depended on by 4.7.1) — the same
  //    direct-create the scrum-projection tests use. Sequences are explicit (the
  //    project has no other sprints from the seed).
  const todayUtcMidnight = (() => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  })();
  const activeSprintName = 'At-scale sprint';
  const active = await db.sprint.create({
    data: {
      workspaceId,
      projectId,
      name: activeSprintName,
      goal: 'Exercise the Scrum board at real-team scale',
      state: 'active',
      startDate: new Date(todayUtcMidnight - startedDaysAgo * DAY_MS),
      endDate: new Date(todayUtcMidnight + endsInDays * DAY_MS),
      sequence: 1,
    },
  });
  const targetSprintName = 'Carry-over target';
  const target = await db.sprint.create({
    data: {
      workspaceId,
      projectId,
      name: targetSprintName,
      goal: 'Receives the unfinished issues on complete-sprint',
      state: 'planned',
      sequence: 2,
    },
  });

  // 4. Partition the board-shaped issues (creation order = board order) into the
  //    active sprint vs. a backlog slice. Every `backlogSliceEvery`-th issue
  //    stays in the backlog; the rest join the sprint — so the sprint inherits
  //    the full column / lane / priority / Done-age spread, while a representative
  //    slice is provably out of scope.
  const rows = await db.workItem.findMany({
    where: { projectId, workspaceId },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const sprintIds: string[] = [];
  const backlogIds: string[] = [];
  rows.forEach((r, i) => (i % backlogSliceEvery === 0 ? backlogIds : sprintIds).push(r.id));

  // Associate the in-sprint set (raw UPDATE — preserves the Done-age backdating).
  await rawUpdateIn(sprintIds, Prisma.sql`"sprintId" = ${active.id}`);

  // 5. Story-point spread over the in-sprint issues: every `unestimatedEvery`-th
  //    is left NULL (the contributes-0 path); the rest cycle the deck. Bucket by
  //    value so it's a handful of raw UPDATEs, not one-per-issue.
  const buckets = new Map<number, string[]>();
  let estimatedSprintIssueCount = 0;
  let committedPoints = 0;
  sprintIds.forEach((id, j) => {
    if (j % unestimatedEvery === 0) return; // unestimated → NULL
    const value = SCRUM_POINT_DECK[j % SCRUM_POINT_DECK.length]!;
    const bucket = buckets.get(value) ?? [];
    bucket.push(id);
    buckets.set(value, bucket);
    estimatedSprintIssueCount++;
    committedPoints += value;
  });
  for (const [value, ids] of buckets) {
    await rawUpdateIn(ids, Prisma.sql`"storyPoints" = ${value}::numeric`);
  }

  return {
    ...boardManifest,
    activeSprintId: active.id,
    activeSprintName,
    targetSprintId: target.id,
    targetSprintName,
    sprintIssueCount: sprintIds.length,
    backlogIssueCount: backlogIds.length,
    estimatedSprintIssueCount,
    committedPoints,
  };
}

/** Same tenant inputs as {@link SeedLargeBoardParams} — the sprint seed composes
 *  the board seed, so it needs nothing more. (Named separately for symmetry +
 *  forward room.) */
export type SeedLargeScrumSprintParams = SeedLargeBoardParams;
