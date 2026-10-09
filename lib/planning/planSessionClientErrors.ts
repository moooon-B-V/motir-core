import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

// THE SESSION SUBMIT'S TYPED REFUSALS (Story MOTIR-7928 · MOTIR-7932) — the codes the
// overlay FOLLOWS rather than shows (MOTIR-7930's decided carry, MOTIR-7945's stale
// outcome and Plan it again). Their own module, beside `planChangeClient`'s calls, so
// a test that stubs the calls keeps the classes the hook narrows on.

/** A finished work item a STALE plan names (MOTIR-7945's `finishedCards`). */
export interface StalePlanFinishedCard {
  id: string;
  key: string;
  title: string;
  status: string;
  statusLabel: string;
}

/** A turn over a STALE plan (MOTIR-7945): nothing was revised or spent, and the
 *  plan's finished work items are named. Rendered as the stale notice, never as
 *  an error. */
export class PlanSessionPlanStaleClientError extends PlanEditsClientError {
  constructor(
    status: number,
    body: unknown,
    readonly planId: string,
    readonly finishedCards: StalePlanFinishedCard[],
  ) {
    super(status, 'PLAN_SESSION_PLAN_STALE', body);
  }
}

/** A Plan it again the server would not open — another press already did, or a
 *  newer plan exists (`latestPlanId`, followed silently). */
export class PlanAgainNotAvailableClientError extends PlanEditsClientError {
  constructor(
    status: number,
    body: unknown,
    readonly reason: string,
    readonly latestPlanId: string | null,
  ) {
    super(status, 'PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE', body);
  }
}

/** The plan was DECIDED before the send reached it (MOTIR-7930 / MOTIR-7945). */
export class PlanSessionPlanDecidedClientError extends PlanEditsClientError {
  constructor(
    status: number,
    body: unknown,
    readonly planId: string | null,
    readonly planStatus: string | null,
  ) {
    super(status, 'PLAN_SESSION_PLAN_DECIDED', body);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The `finishedCards` of a stale refusal's body, read defensively. */
export function finishedCardsOf(v: unknown): StalePlanFinishedCard[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c: unknown) => {
    const r = (c ?? {}) as Record<string, unknown>;
    const id = str(r.id);
    const key = str(r.key);
    if (!id || !key) return [];
    return [
      {
        id,
        key,
        title: str(r.title) ?? '',
        status: str(r.status) ?? '',
        statusLabel: str(r.statusLabel) ?? '',
      },
    ];
  });
}
