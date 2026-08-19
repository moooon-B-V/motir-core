import { getFormatter } from 'next-intl/server';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PlanDto } from '@/lib/dto/plans';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { userRepository } from '@/lib/repositories/userRepository';

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
 *  the whole list.
 *
 *  ⚠️ `computePlanStaleness` OWNS that rule (MOTIR-3165) and returns all-clear
 *  for a decided plan on its own. This guard is kept as an OPTIMISATION — the
 *  row already holds a `PlanDto`, so it spares a plan read each — not as a
 *  second source of truth; deleting it would change cost, never behaviour. */
async function staleCountFor(plan: PlanDto, ctx: ServiceContext): Promise<number> {
  if (plan.status !== 'planned') return 0;
  try {
    const verdict = await planStalenessService.computePlanStaleness(plan.id, ctx);
    return verdict.items.filter((item) => item.stale).length;
  } catch {
    return 0;
  }
}

/**
 * The REQUESTERS of a page of plans, as `id → display name` (MOTIR-2991).
 *
 * ONE query for the whole page, over the DISTINCT ids — never a lookup per row.
 * The list is paginated and a per-row read would make the plans page's cost grow
 * with the page size for a field that is one join away; `userRepository.findByIds`
 * already exists for exactly this shape.
 *
 * A missing id resolves to `null` rather than throwing: `createdById` is
 * `ON DELETE SET NULL`, so the only way to hold an id with no user is a race with
 * a deletion, and an unattributable plan is a correct reading of that.
 */
async function requesterNames(plans: PlanDto[]): Promise<Map<string, string>> {
  const ids = [...new Set(plans.map((plan) => plan.createdById).filter((id) => id != null))];
  if (ids.length === 0) return new Map();
  const users = await userRepository.findByIds(ids);
  return new Map(users.map((user) => [user.id, user.name]));
}

export async function buildPlanRowViews(
  plans: PlanDto[],
  ctx: ServiceContext,
): Promise<PlanRowView[]> {
  const format = await getFormatter();

  // Per-plan staleness is independent — fan out (bounded by the page size).
  const staleCounts = await Promise.all(plans.map((plan) => staleCountFor(plan, ctx)));
  const names = await requesterNames(plans);

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
      // The three-party attribution (MOTIR-2991, `design-notes.md` Part III).
      // Resolved HERE so the row component stays presentational, exactly as the
      // relative time and the staleness count already are.
      origin: plan.origin,
      sourceJobId: plan.sourceJobId,
      createdByName: plan.createdById ? (names.get(plan.createdById) ?? null) : null,
      authorSource: plan.authorSource,
      authorHarness: plan.authorHarness,
    };
  });
}
