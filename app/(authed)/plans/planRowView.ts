import { getFormatter } from 'next-intl/server';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PlanDto } from '@/lib/dto/plans';
import { planStalenessService } from '@/lib/services/planStalenessService';

import type { PlanRowView, PlanWhenKey } from './_components/types';

// Server-side view-model builder for the Plans LIST (Subtask 7.21.1 / MOTIR-1338).
// Shared by the page's first server render AND the load-more server action, so a
// streamed page renders identically to the initial one. It enriches each
// `PlanDto` with (a) a pre-formatted relative time (against the request's shared
// `now`, so the client hydrates without a mismatch) and (b) the count of drifted
// proposed items (MOTIR-1340) — the only two things the row needs that the DTO
// itself doesn't carry. The client row components stay presentational.

/** The lifecycle timestamp a row reads + the verb it labels it with. */
function whenFor(plan: PlanDto): { key: PlanWhenKey; iso: string } {
  switch (plan.status) {
    case 'approved':
      return { key: 'approvedAt', iso: plan.decidedAt ?? plan.createdAt };
    case 'declined':
      return { key: 'declinedAt', iso: plan.decidedAt ?? plan.createdAt };
    case 'planned':
      return { key: 'plannedAt', iso: plan.plannedAt ?? plan.createdAt };
    default:
      // `generating` (and any future status) reads the creation time.
      return { key: 'createdAt', iso: plan.createdAt };
  }
}

/** How many of a `planned` plan's proposed items have drifted out of date. Only
 *  a `planned` plan can be stale; others short-circuit to 0. A staleness read
 *  failure degrades gracefully (the row just omits the flag) rather than failing
 *  the whole list. */
async function staleCountFor(plan: PlanDto, ctx: ServiceContext): Promise<number> {
  if (plan.status !== 'planned') return 0;
  try {
    const verdict = await planStalenessService.computePlanStaleness(plan.id, ctx);
    return verdict.items.filter((item) => item.stale).length;
  } catch {
    return 0;
  }
}

export async function buildPlanRowViews(
  plans: PlanDto[],
  ctx: ServiceContext,
): Promise<PlanRowView[]> {
  const format = await getFormatter();

  // Per-plan staleness is independent — fan out (bounded by the page size).
  const staleCounts = await Promise.all(plans.map((plan) => staleCountFor(plan, ctx)));

  return plans.map((plan, i) => {
    const { key, iso } = whenFor(plan);
    return {
      id: plan.id,
      status: plan.status,
      title: plan.summary?.trim() || plan.title?.trim() || '',
      itemCount: plan.itemCount,
      staleCount: staleCounts[i] ?? 0,
      whenKey: key,
      whenLabel: format.relativeTime(new Date(iso)),
    };
  });
}
