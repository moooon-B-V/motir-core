// =================================================================
// Activity read service (Story 5.5 · Subtask 5.5.1) — the READ-ONLY mapping
// layer over the append-only `work_item_revision` trail (1.4.6): one issue's
// History feed, paged and human-renderable. This service owns NO writes and
// no transaction — the trail is append-only for everyone (the verified Jira
// rule: history has no edit/delete surface, admins included), so no mutation
// method exists here, in the repository extensions, or in any route.
//
// Shape of a read (finding #57 — bounded, never load-all):
//   1. View-gate: the work item must exist in the caller's workspace, else
//      WorkItemNotFoundError → 404 (no cross-workspace existence leak,
//      finding #44).
//   2. Page the trail via the EXISTING 1.4.6 cursor read (both orders walk
//      the same (workItemId, changedAt) index), filtering out the revisions
//      the registry's noise policy suppresses (pure position/backlogRank
//      reorders, denormalised key/identifier writes). The scan is bounded:
//      at most MAX_SCANNED_ROWS rows per call — a noise-heavy stretch may
//      return a short page with a non-null cursor, and "Show more" continues.
//   3. Resolve every referenced display value in ONE batched lookup set per
//      page (users, the project's status labels, sprint names, linked-issue
//      identifiers) — no per-entry queries. Deleted referents degrade to a
//      stored-id fallback value, never a crash.
//   4. Map rows → ActivityEntryDto via the TOTAL renderer registry
//      (lib/activity/renderers.ts): every audited diff key has an explicit
//      disposition, unknown keys render the generic entry (mistake #29).

import type { Sprint, User, WorkItem, WorkflowStatus, WorkItemRevision } from '@prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { toActivityEntryDto } from '@/lib/mappers/activityMappers';
import {
  collectDiffRefs,
  emptyDiffRefs,
  isDisplayableRevision,
  SUPPRESSED_DIFF_KEYS,
  type ActivityUserValue,
  type DisplayResolvers,
} from '@/lib/activity/renderers';
import type {
  ActivityHistoryPageDto,
  ActivityListOptions,
  ActivityValueDto,
} from '@/lib/dto/activity';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/** Displayable entries per page — the History tab's "Show more" stride. */
export const ACTIVITY_PAGE_SIZE = 20;
/** Rows fetched per repository read while skipping suppressed noise. */
const SCAN_BATCH_SIZE = 20;
/** Hard per-call bound on scanned rows (finding #57) — 5 batches. */
const MAX_SCANNED_ROWS = 100;

interface ScanResult {
  rows: WorkItemRevision[];
  nextCursor: string | null;
}

/**
 * Walk the trail from `cursor` collecting up to ACTIVITY_PAGE_SIZE displayable
 * revisions, reading at most MAX_SCANNED_ROWS rows in SCAN_BATCH_SIZE chunks.
 * `nextCursor` is the last row CONSUMED (displayable or not) whenever more
 * rows may remain — so a follow-up call never re-reads a skipped stretch.
 */
async function scanDisplayable(
  workItemId: string,
  cursor: string | undefined,
  order: 'asc' | 'desc',
): Promise<ScanResult> {
  const rows: WorkItemRevision[] = [];
  let scanned = 0;
  let lastConsumedId: string | null = null;
  let batchCursor = cursor;
  let moreMayRemain = true;

  while (moreMayRemain && rows.length < ACTIVITY_PAGE_SIZE && scanned < MAX_SCANNED_ROWS) {
    const batch = await workItemRevisionRepository.listByWorkItem(workItemId, {
      take: SCAN_BATCH_SIZE,
      cursor: batchCursor,
      order,
    });
    if (batch.length === 0) {
      moreMayRemain = false;
      break;
    }

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i] as WorkItemRevision;
      scanned += 1;
      lastConsumedId = row.id;
      if (isDisplayableRevision(row.changeKind, row.diff)) rows.push(row);
      if (rows.length === ACTIVITY_PAGE_SIZE || scanned === MAX_SCANNED_ROWS) {
        // Stopped mid-stream: rows may remain after the one just consumed —
        // later in this batch, or beyond a full batch. Hand back the
        // consumption point; an exactly-at-the-end cursor just yields one
        // empty final page.
        moreMayRemain = i < batch.length - 1 || batch.length === SCAN_BATCH_SIZE;
        break;
      }
    }
    if (rows.length === ACTIVITY_PAGE_SIZE || scanned === MAX_SCANNED_ROWS) break;

    if (batch.length < SCAN_BATCH_SIZE) {
      moreMayRemain = false;
      break;
    }
    batchCursor = (batch[batch.length - 1] as WorkItemRevision).id;
  }

  return { rows, nextCursor: moreMayRemain ? lastConsumedId : null };
}

/**
 * Build the page's DisplayResolvers from ONE batched lookup set: gather every
 * id the page references (actors + diff refs), then at most one read per
 * source. Missing referents resolve to the stored-id fallback form.
 */
async function buildResolvers(
  rows: WorkItemRevision[],
  item: WorkItem,
  ctx: ServiceContext,
): Promise<DisplayResolvers> {
  const refs = emptyDiffRefs();
  for (const row of rows) {
    refs.users.add(row.changedById);
    collectDiffRefs(row.changeKind, row.diff, refs);
  }

  const [users, statuses, sprints, issues] = await Promise.all([
    refs.users.size > 0 ? userRepository.findByIds([...refs.users]) : ([] as User[]),
    refs.statuses.size > 0
      ? workflowsRepository.findStatuses(item.projectId, ctx.workspaceId)
      : ([] as WorkflowStatus[]),
    refs.sprints.size > 0
      ? sprintRepository.findByIds([...refs.sprints], ctx.workspaceId)
      : ([] as Sprint[]),
    refs.issues.size > 0 ? workItemRepository.findByIds([...refs.issues]) : ([] as WorkItem[]),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const statusByKey = new Map(statuses.map((s) => [s.key, s]));
  const sprintById = new Map(sprints.map((s) => [s.id, s]));
  // Identifiers stay workspace-gated even through old diffs (finding #44):
  // a foreign-workspace id — impossible today, but cheap to refuse — renders
  // as the not-found fallback rather than leaking its identifier.
  const issueById = new Map(
    issues.filter((w) => w.workspaceId === ctx.workspaceId).map((w) => [w.id, w]),
  );

  return {
    user(id: string): ActivityUserValue {
      const u = userById.get(id);
      return { type: 'user', userId: id, name: u?.name ?? null, image: u?.image ?? null };
    },
    status(key: string): ActivityValueDto {
      return { type: 'status', key, label: statusByKey.get(key)?.label ?? null };
    },
    sprint(id: string): ActivityValueDto {
      return { type: 'sprint', sprintId: id, name: sprintById.get(id)?.name ?? null };
    },
    issue(id: string): ActivityValueDto {
      return { type: 'issue', workItemId: id, identifier: issueById.get(id)?.identifier ?? null };
    },
  };
}

export const activityService = {
  /**
   * One page of an issue's History feed: displayable revisions in
   * `(changedAt, id)` order (newest-first by default; `asc` for the
   * section's oldest-first toggle), each rendered to typed parts, plus the
   * displayable `totalCount` and the continuation cursor. View-gated; 404 on
   * unknown / cross-workspace ids.
   */
  async listHistory(
    workItemId: string,
    options: ActivityListOptions,
    ctx: ServiceContext,
  ): Promise<ActivityHistoryPageDto> {
    const order = options.order ?? 'desc';
    const item = await workItemRepository.findById(workItemId);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(workItemId);
    }

    const [totalCount, scan] = await Promise.all([
      workItemRevisionRepository.countDisplayableByWorkItem(workItemId, [...SUPPRESSED_DIFF_KEYS]),
      scanDisplayable(workItemId, options.cursor, order),
    ]);

    const resolvers = await buildResolvers(scan.rows, item, ctx);
    return {
      entries: scan.rows.map((row) => toActivityEntryDto(row, resolvers)),
      nextCursor: scan.nextCursor,
      totalCount,
    };
  },
};
