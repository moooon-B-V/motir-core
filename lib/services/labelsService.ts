import { Prisma, type Label, type WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { workItemLabelRepository } from '@/lib/repositories/workItemLabelRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { toLabelDto } from '@/lib/mappers/labelMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  InvalidLabelNameError,
  LabelLimitExceededError,
  LabelNameTooLongError,
} from '@/lib/labels/errors';
import type { LabelDto } from '@/lib/dto/labels';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Labels service (Story 5.4 · Subtask 5.4.2) — the folksonomy mechanics over
// the 5.4.1 repositories. Owns validation (the verified Jira rules), the
// case-insensitive find-or-create, the delete-on-last-use lifecycle, the
// permission gates, transactions, revision diffs, and DTO mapping. Routes are
// HTTP-only (CLAUDE.md).
//
// The folksonomy contract (mirror-verified in the Story 5.4 description):
//   * created by TYPING — `addLabel`/`setLabels` find-or-create by `nameLower`
//     within the project (the JRACLOUD-24907 wart-fix: 'PERF-Q3' matches
//     'perf-q3'); a miss creates the row with the first-typed display casing,
//     in the SAME transaction as the join write.
//   * NO admin UI, NO rename/merge (Jira's documented gap; the Epic-6
//     extension slot). A label exists only while used: removing its last join
//     row deletes the label row. The delete-at-zero count is read AFTER a
//     `FOR UPDATE` lock on the label row (the lock-before-read-derived-update
//     rule), so two concurrent removals serialize and exactly one observes
//     zero — never a stale count, never a double delete.
//   * names are single tokens: NO whitespace (hyphens — the Jira rule),
//     trimmed, ≤ LABEL_NAME_MAX_LENGTH chars, ≤ LABELS_PER_ISSUE_LIMIT per
//     issue (a recorded sanity guard; Jira documents no per-issue cap).
//
// Permission matrix: every WRITE is edit-gated (`viewer` → 403 read-only); a
// missing / cross-workspace / non-BROWSABLE issue reads as
// WorkItemNotFoundError (404, finding #44 — "you can't see it" is
// indistinguishable from "it doesn't exist"). The autocomplete read is
// view-gated the same way at project level.
//
// Revision trail: every effective change writes one revision on the issue
// with the diff `{ labels: { added: [name…], removed: [name…] } }` (the
// links-diff precedent). No-op writes (re-adding an attached label, removing
// a label the issue doesn't carry) write NOTHING.

// The recorded limits live in the Prisma-free `lib/labels/constants` (the
// 5.4.8 rail card consumes them client-side); re-exported here so existing
// server-side importers keep their path.
import {
  LABEL_NAME_MAX_LENGTH,
  LABELS_PER_ISSUE_LIMIT,
  LABEL_SEARCH_LIMIT,
} from '@/lib/labels/constants';

export { LABEL_NAME_MAX_LENGTH, LABELS_PER_ISSUE_LIMIT, LABEL_SEARCH_LIMIT };

/**
 * Validate + normalize one incoming label name per the verified Jira rules:
 * trimmed, non-empty, single token (no whitespace anywhere — the message
 * names the hyphen convention), length-capped.
 */
function normalizeLabelName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new InvalidLabelNameError(raw);
  if (/\s/.test(name)) throw new InvalidLabelNameError(name);
  if (name.length > LABEL_NAME_MAX_LENGTH)
    throw new LabelNameTooLongError(name, LABEL_NAME_MAX_LENGTH);
  return name;
}

/**
 * Resolve a work item under the hide-gates and assert the actor may EDIT it.
 * Missing / cross-workspace / non-browsable → WorkItemNotFoundError (404 —
 * finding #44, no existence leak); a browser without edit rights keeps the
 * typed ProjectAccessDeniedError('edit') (→ 403, read-only viewer).
 */
async function resolveEditableWorkItem(
  workItemId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
  try {
    await projectAccessService.assertCanEdit(item.projectId, ctx, tx);
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
      throw new WorkItemNotFoundError(workItemId);
    }
    throw err;
  }
  return item;
}

/**
 * Find-or-create one label case-insensitively within the project, inside the
 * caller's transaction (the create half carries the first-typed display
 * casing). The `@@unique([projectId, nameLower])` constraint backstops the
 * concurrent-create race; see `retryOnceOnUniqueRace` for how the loser
 * recovers.
 */
async function findOrCreateLabel(
  item: Pick<WorkItem, 'workspaceId' | 'projectId'>,
  name: string,
  tx: Prisma.TransactionClient,
): Promise<Label> {
  const existing = await labelRepository.findByNameLower(item.projectId, name.toLowerCase(), tx);
  if (existing) return existing;
  return labelRepository.create(
    {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      name,
      nameLower: name.toLowerCase(),
    },
    tx,
  );
}

/**
 * Detach one label from one issue and run the delete-on-last-use rule, inside
 * the caller's transaction. Lock FIRST (`FOR UPDATE` on the label row — the
 * lock-before-read-derived-update rule), so the use-count read after the join
 * delete cannot go stale under a concurrent removal: the transactions
 * serialize on the row and exactly one observes zero. A label already deleted
 * by the concurrent winner (lock returns null) is a no-op — its join rows
 * died with it (Cascade).
 */
async function detachLabel(
  workItemId: string,
  label: Pick<Label, 'id'>,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const locked = await labelRepository.lockById(label.id, tx);
  if (!locked) return;
  await workItemLabelRepository.remove(workItemId, label.id, tx);
  const remainingUses = await workItemLabelRepository.countByLabel(label.id, tx);
  if (remainingUses === 0) await labelRepository.delete(label.id, tx);
}

/**
 * Run a label write once, retrying exactly once on a unique-constraint race
 * (P2002): two concurrent transactions find-or-creating the SAME new label
 * both miss the read, and the loser's create aborts its (already-poisoned)
 * transaction. The retry re-runs the whole flow in a fresh transaction, where
 * the find half now hits. Any second P2002 (or any other error) propagates.
 */
async function retryOnceOnUniqueRace<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return run();
    }
    throw err;
  }
}

/** Record one `{ labels: { added/removed } }` revision (the links-diff precedent). */
async function recordLabelsRevision(
  workItemId: string,
  userId: string,
  added: string[],
  removed: string[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  const diff: { labels: { added?: string[]; removed?: string[] } } = { labels: {} };
  if (added.length > 0) diff.labels.added = added;
  if (removed.length > 0) diff.labels.removed = removed;
  await workItemRevisionsService.recordRevision(
    { workItemId, changedById: userId, changeKind: 'updated', diff },
    tx,
  );
}

export const labelsService = {
  /**
   * Replace the issue's label set with `names` (the picker's bulk form).
   * Validates + dedupes case-insensitively (first casing wins), caps at
   * {@link LABELS_PER_ISSUE_LIMIT}, then — in ONE transaction — find-or-creates
   * the additions, detaches the removals under the delete-on-last-use rule,
   * and records a single `{ labels: { added, removed } }` revision when
   * anything changed. Returns the resulting set, name-ordered. Idempotent: a
   * no-change set writes nothing.
   */
  async setLabels(workItemId: string, names: string[], ctx: ServiceContext): Promise<LabelDto[]> {
    const byLower = new Map<string, string>();
    for (const raw of names) {
      const name = normalizeLabelName(raw);
      if (!byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), name);
    }
    if (byLower.size > LABELS_PER_ISSUE_LIMIT) {
      throw new LabelLimitExceededError(LABELS_PER_ISSUE_LIMIT);
    }

    return retryOnceOnUniqueRace(() =>
      db.$transaction(async (tx) => {
        const item = await resolveEditableWorkItem(workItemId, ctx, tx);
        const current = await labelRepository.listByWorkItem(workItemId, tx);
        const currentByLower = new Map(current.map((l) => [l.nameLower, l]));

        const toRemove = current.filter((l) => !byLower.has(l.nameLower));
        const toAddNames = [...byLower.entries()]
          .filter(([lower]) => !currentByLower.has(lower))
          .map(([, name]) => name);

        const addedLabels: Label[] = [];
        for (const name of toAddNames) {
          addedLabels.push(await findOrCreateLabel(item, name, tx));
        }
        await workItemLabelRepository.createMany(
          addedLabels.map((l) => ({ workItemId, labelId: l.id })),
          tx,
        );
        for (const label of toRemove) {
          await detachLabel(workItemId, label, tx);
        }

        if (addedLabels.length > 0 || toRemove.length > 0) {
          await recordLabelsRevision(
            workItemId,
            ctx.userId,
            addedLabels.map((l) => l.name),
            toRemove.map((l) => l.name),
            tx,
          );
        }

        const rows = await labelRepository.listByWorkItem(workItemId, tx);
        return rows.map(toLabelDto);
      }),
    );
  },

  /**
   * Attach one label by name — the picker's type-to-create path. Validates,
   * then in ONE transaction find-or-creates the label case-insensitively and
   * writes the join + the `{ labels: { added } }` revision. Re-adding a label
   * the issue already carries is an idempotent no-op (no revision); the
   * per-issue cap rejects only a NEW attachment. Returns the resulting set.
   */
  async addLabel(workItemId: string, rawName: string, ctx: ServiceContext): Promise<LabelDto[]> {
    const name = normalizeLabelName(rawName);

    return retryOnceOnUniqueRace(() =>
      db.$transaction(async (tx) => {
        const item = await resolveEditableWorkItem(workItemId, ctx, tx);
        const current = await labelRepository.listByWorkItem(workItemId, tx);
        const existing = current.find((l) => l.nameLower === name.toLowerCase());
        if (existing) return current.map(toLabelDto);

        if (current.length >= LABELS_PER_ISSUE_LIMIT) {
          throw new LabelLimitExceededError(LABELS_PER_ISSUE_LIMIT);
        }

        const label = await findOrCreateLabel(item, name, tx);
        await workItemLabelRepository.create({ workItemId, labelId: label.id }, tx);
        await recordLabelsRevision(workItemId, ctx.userId, [label.name], [], tx);

        const rows = await labelRepository.listByWorkItem(workItemId, tx);
        return rows.map(toLabelDto);
      }),
    );
  },

  /**
   * Detach one label by id, under the delete-on-last-use rule (lock → join
   * delete → locked count → delete-at-zero). Removing a label the issue does
   * not carry — including a label id from another project, which can never be
   * attached here — is an idempotent no-op (no revision). Returns the
   * resulting set.
   */
  async removeLabel(workItemId: string, labelId: string, ctx: ServiceContext): Promise<LabelDto[]> {
    return db.$transaction(async (tx) => {
      await resolveEditableWorkItem(workItemId, ctx, tx);
      const current = await labelRepository.listByWorkItem(workItemId, tx);
      const target = current.find((l) => l.id === labelId);
      if (!target) return current.map(toLabelDto);

      await detachLabel(workItemId, target, tx);
      await recordLabelsRevision(workItemId, ctx.userId, [], [target.name], tx);

      return current.filter((l) => l.id !== labelId).map(toLabelDto);
    });
  },

  /**
   * The autocomplete read: a case-insensitive PREFIX match over the project's
   * labels, bounded to {@link LABEL_SEARCH_LIMIT} (finding #57 — never a
   * load-all), returning display names in name order. An empty `q` lists the
   * first window (opening the picker before typing — the Jira field's
   * behaviour). View-gated: a cross-tenant key OR a non-browsable project
   * reads as ProjectNotFoundError (404, no existence leak).
   */
  async searchLabels(projectKey: string, q: string, ctx: ServiceContext): Promise<LabelDto[]> {
    const project = await projectRepository.findByIdentifier(
      ctx.workspaceId,
      projectKey.trim().toUpperCase(),
    );
    if (!project) throw new ProjectNotFoundError(projectKey);
    try {
      await projectAccessService.assertCanBrowse(project.id, ctx);
    } catch (err) {
      if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
        throw new ProjectNotFoundError(projectKey);
      }
      throw err;
    }
    const rows = await labelRepository.searchByPrefix(project.id, q.trim(), LABEL_SEARCH_LIMIT);
    return rows.map(toLabelDto);
  },
};
