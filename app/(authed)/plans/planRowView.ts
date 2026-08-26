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
    // ⚠️ `stale` READS `plannedAt` AND KEEPS ITS VERB — *"planned 2 hours ago"*
    // (MOTIR-3578, `design/ai-planning/design-notes.md` Part XI §3). That is
    // still the true and useful fact in a scanned list: it is the plan's own
    // moment, and the status pill beside it already says what happened since.
    // No `Plan` column carries WHEN the drift landed, and the row does not need
    // one — the rail is where that question is asked, and Part XI §3 hands the
    // `staleAt` decision to the transitions card rather than assuming it here.
    //
    // ⚠️ AND IT IS AN EXPLICIT ARM, not the `default:` below. That arm answers
    // `createdAt` — right for `generating`, silently wrong for a fifth value,
    // and NOT a type error, which is why Part XI §7 lists it among the four
    // sites the compiler cannot find.
    case 'stale':
      return { key: 'plannedAt', iso: plan.plannedAt ?? plan.createdAt };
    default:
      // `generating` (and any future status) reads the creation time.
      return { key: 'createdAt', iso: plan.createdAt };
  }
}

/** How many of an UNDECIDED plan's proposed items have drifted out of date.
 *  A decided plan short-circuits to 0. A staleness read failure degrades
 *  gracefully (the row just omits the flag) rather than failing the whole list.
 *
 *  ⚠️ `computePlanStaleness` OWNS that rule (MOTIR-3165) and returns all-clear
 *  for a decided plan on its own. This guard is kept as an OPTIMISATION — the
 *  row already holds a `PlanDto`, so it spares a plan read each — not as a
 *  second source of truth; deleting it would change cost, never behaviour.
 *
 *  ⚠️ IT ADMITS `stale` TOO, and that is the whole point of the widening
 *  (MOTIR-3578, AMENDMENT 9 D3). This used to read `!== 'planned'`, which would
 *  have returned 0 for the fifth status — silencing the advisory count on the
 *  row MOST likely to carry one, and doing it at the moment a reviewer needs it
 *  most. It mirrors the service's own guard exactly; the two are asserted to
 *  agree in `tests/integration/plans/planStatusStale.test.ts`. */
async function staleCountFor(plan: PlanDto, ctx: ServiceContext): Promise<number> {
  if (plan.status !== 'planned' && plan.status !== 'stale') return 0;
  try {
    const verdict = await planStalenessService.computePlanStaleness(plan.id, ctx);
    return verdict.items.filter((item) => item.stale).length;
  } catch {
    return 0;
  }
}

/**
 * The PEOPLE named by a page of plans, as `id → display name` (MOTIR-2991;
 * widened to the DECIDER by MOTIR-3238).
 *
 * ONE query for the whole page, over the DISTINCT ids of BOTH parties — never a
 * lookup per row, and never a second query for the second party. The list is
 * paginated and a per-row read would make the plans page's cost grow with the
 * page size for a field that is one join away; `userRepository.findByIds`
 * already exists for exactly this shape, and the union is what keeps the count
 * at one however many roles the row grows.
 *
 * The two ids also OVERLAP constantly in practice — the person who asked for a
 * plan is very often the person who approved it — so a set over the union is
 * cheaper than two reads even before the round trip is counted.
 *
 * A missing id resolves to `null` rather than throwing: both `createdById` and
 * `decidedById` are `ON DELETE SET NULL`, so the only way to hold an id with no
 * user is a race with a deletion, and an unattributable plan is a correct
 * reading of that.
 */
async function partyNames(plans: PlanDto[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      plans.flatMap((plan) => [plan.createdById, plan.decidedById]).filter((id) => id != null),
    ),
  ];
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
  const names = await partyNames(plans);

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
      createdByName: plan.createdById ? (names.get(plan.createdById) ?? null) : null,
      // WHO DECIDED it (MOTIR-3238). Null on an undecided plan, on a plan
      // predating the column, and — the case that matters — on an ABANDONED one,
      // where `decidedById` is deliberately null because nobody decided it
      // (MOTIR-3189). The row renders that absence rather than a placeholder.
      decidedByName: plan.decidedById ? (names.get(plan.decidedById) ?? null) : null,
      authorSource: plan.authorSource,
      authorHarness: plan.authorHarness,
    };
  });
}
