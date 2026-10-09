import type { Prisma } from '@/generated/prisma/client';
import { planRepository, type RevisionHoldScope } from '@/lib/repositories/planRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import {
  PLAN_REVISION_LEASE_MS,
  revisionLeaseOf,
  type RevisionLeaseRow,
} from '@/lib/planChange/revisionLease';

// WHICH PLANS A REVISION HOLDS RIGHT NOW (Bug MOTIR-7988) — the one read the
// Workbench's two plan lists ask of the revision lease.
//
// A plan a person asked to change is being PLANNED again: nothing waits on them
// while the planner rewrites it. So a `planned` plan whose revision lease is held
// leaves Waiting on you (its `plan_approval` gate stays `awaiting` and HELD — the
// decide door still refuses it with `PLAN_REVISION_IN_FLIGHT`) and is listed under
// Planning, and it comes back the moment the lease ends: a `revision_ended`, or the
// window running out on a revision that died. The plan's STATUS never moves — this
// is a listing rule over the lease, not a new status.
//
// ⚠️ THE LEASE LIVES ON THE TRAIL, NOT IN A COLUMN (`revisionLease.ts`), so no
// `where` clause can say it. The read is two steps and the second is exact:
// `planRepository.findPlannedIdsWithTrailSince` narrows to the plans that wrote
// anything inside the window (a held lease's latest row is, by definition), and
// `revisionLeaseOf` — the SAME predicate the decide door refuses on — rules on each
// candidate's trail. The resulting ids then ride INTO the lists' own predicates,
// so a count and its rows still read one `where` and cannot disagree.

export const planRevisionHoldService = {
  /** The ids of the `planned` plans in `scope` whose revision lease is held at `now`. */
  async heldPlanIds(
    scope: RevisionHoldScope,
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<string[]> {
    const candidates = await planRepository.findPlannedIdsWithTrailSince(
      scope,
      new Date(now.getTime() - PLAN_REVISION_LEASE_MS),
      tx,
    );
    if (candidates.length === 0) return [];
    const trails = new Map<string, RevisionLeaseRow[]>();
    for (const row of await planRevisionRepository.listLeaseRowsByPlans(candidates, tx)) {
      const trail = trails.get(row.planId);
      if (trail) trail.push(row);
      else trails.set(row.planId, [row]);
    }
    return candidates.filter((id) => revisionLeaseOf(trails.get(id) ?? [], now) !== null);
  },
};
