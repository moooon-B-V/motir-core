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
import { Prisma, type WorkItemKind, type WorkItemPriority } from '@prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsService } from '@/lib/services/workflowsService';

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
          position: String(key).padStart(8, '0'),
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
