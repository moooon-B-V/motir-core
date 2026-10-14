import type { Prisma } from '@/generated/prisma/client';
import type { ResumeReshapePlanDto } from '@/lib/dto/home';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import {
  workItemRepository,
  type HomeProjectScope,
  type HomeWorkItemRow,
} from '@/lib/repositories/workItemRepository';

// WHAT A GATED SCOPE RUN WOULD CARRY NOW (Bug MOTIR-8458; `design/workbench/design-notes.md`
// § 39). A To resume entry used to list only the cards whose own latest run is the gated
// run — a snapshot of what the run touched before it stopped. A continue over a scope run
// reads the scope container's LIVE children instead, so once a plan re-shapes the story
// the entry and the resume disagree: new children never appear, re-scoped ones carry no
// sign, and nothing says the story moved.
//
// This reads, per gated SCOPE run on the page:
//   · the scope's live, not-finished children — the members a resume would carry;
//   · which cards the run had a leg for — a member with none is one it never touched;
//   · every plan approved AFTER the run stopped that added, changed or removed work in
//     the scope — the banner — and which touched members those plans changed.
//
// ⚠️ `resumeRunId` stays the per-card column the tab lists by. Nothing here changes which
// runs have an entry, or the count; it composes the entry's members and its banner.

/** One gated run on the page, as `findScopesByIds` reads it. */
export interface GatedRunScope {
  id: string;
  scopeWorkItemId: string | null;
  endedAt: Date | null;
}

/** What one gated scope run's entry draws beyond its keyed members. */
export interface ResumeScopeDetail {
  /** The scope's live, not-finished children, in the tab's member order. */
  children: HomeWorkItemRow[];
  /** The cards the run had a leg for. */
  touched: ReadonlySet<string>;
  /** Touched cards a plan approved after the stop changed (`modify`). */
  rescoped: ReadonlySet<string>;
  /** The plans approved after the stop that re-shaped the scope, oldest first. */
  reshapedBy: ResumeReshapePlanDto[];
}

/**
 * Fold one run's post-stop proposals into the banner's per-plan lines (§ 39.3). A plan
 * whose counts are all zero does not count as re-shaping and is left out.
 */
export function toReshapePlans(
  rows: readonly {
    id: string;
    op: 'add' | 'modify' | 'remove';
    plan: { id: string; title: string | null; decidedAt: Date | null };
  }[],
): ResumeReshapePlanDto[] {
  const byPlan = new Map<string, ResumeReshapePlanDto>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id) || row.plan.decidedAt === null) continue;
    seen.add(row.id);
    let line = byPlan.get(row.plan.id);
    if (!line) {
      line = {
        planId: row.plan.id,
        title: row.plan.title,
        approvedAt: row.plan.decidedAt.toISOString(),
        added: 0,
        changed: 0,
        removed: 0,
      };
      byPlan.set(row.plan.id, line);
    }
    if (row.op === 'add') line.added += 1;
    else if (row.op === 'modify') line.changed += 1;
    else line.removed += 1;
  }
  return [...byPlan.values()]
    .filter((line) => line.added + line.changed + line.removed > 0)
    .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
}

/**
 * The scope detail of every gated SCOPE run among `runs`, keyed by run id. A scope-less
 * run (a `batch`) has no container to read and gets no entry here. Read inside the
 * caller's transaction; sequential, since one transaction's client runs one query at a
 * time anyway.
 */
export async function readResumeScopes(
  workspaceId: string,
  projectScopes: readonly HomeProjectScope[],
  runs: readonly GatedRunScope[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, ResumeScopeDetail>> {
  const scoped = runs.filter(
    (run): run is GatedRunScope & { scopeWorkItemId: string } => run.scopeWorkItemId !== null,
  );
  const out = new Map<string, ResumeScopeDetail>();
  if (scoped.length === 0) return out;
  const scopeIds = [...new Set(scoped.map((run) => run.scopeWorkItemId))];
  const projectIds = projectScopes.map((scope) => scope.projectId);

  const children = await workItemRepository.findResumeScopeChildren(
    workspaceId,
    projectScopes,
    scopeIds,
    tx,
  );
  const everyChild = await workItemRepository.findChildIdsByParents(scopeIds, tx);
  const legs = await dispatchRunCardRepository.listWorkItemIdsByRuns(
    scoped.map((run) => run.id),
    tx,
  );
  // A run over an EPIC touches its stories through their subtasks, so a child whose own
  // child had a leg was touched too — one level down, the depth a scope run drains.
  const grandchildren = await workItemRepository.findChildIdsByParents(
    everyChild.map((c) => c.id),
    tx,
  );

  for (const run of scoped) {
    const scopeId = run.scopeWorkItemId;
    const touched = new Set(
      legs.flatMap((leg) =>
        leg.dispatchRunId === run.id && leg.workItemId ? [leg.workItemId] : [],
      ),
    );
    for (const g of grandchildren) {
      if (g.parentId && touched.has(g.id)) touched.add(g.parentId);
    }
    const childIds = everyChild.filter((c) => c.parentId === scopeId).map((c) => c.id);
    // A run that never closed has no stop to measure from, so nothing re-shaped it.
    const rows = run.endedAt
      ? await planItemRepository.findApprovedAfterTouching(
          workspaceId,
          projectIds,
          [scopeId, ...childIds],
          [scopeId],
          run.endedAt,
          tx,
        )
      : [];
    const rescoped = new Set(
      rows.flatMap((row) =>
        row.op === 'modify' && row.workItemId && touched.has(row.workItemId)
          ? [row.workItemId]
          : [],
      ),
    );
    out.set(run.id, {
      children: children.filter((child) => child.parentId === scopeId),
      touched,
      rescoped,
      reshapedBy: toReshapePlans(rows),
    });
  }
  return out;
}
