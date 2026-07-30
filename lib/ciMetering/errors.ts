// Typed errors for the CI-minutes ENTITLEMENT (Story MOTIR-1775 · MOTIR-1901).
// Services throw these; the route / MCP layer maps the stable `code` to a status
// (per CLAUDE.md's 4-layer rule), so no caller ever branches on a raw HTTP status
// or an upstream JSON shape.

import type { CiEntitlementStateName } from './allowance';

/**
 * `docs/decisions/ci-minutes-allowance.md` §6.2–6.3 — the org's credit balance is
 * `≤ 0` while it is past its included CI pool, so the NEXT DISPATCH is refused.
 *
 * Deliberately mirrors the shipped `MotirAiOutOfCreditsError` (`lib/ai/errors.ts`):
 * a stable `code`, a browser-reachable and NON-retryable condition whose remedy is
 * to top up rather than retry, distinct from any transport failure. §6.2 rejected
 * the two alternatives explicitly — letting the PR open but SKIPPING CI silently
 * degrades the exact verification gate the agent loop leans on, and running on
 * into a negative balance funds unbounded compute for an org that has stopped
 * paying.
 *
 * It carries the whole entitlement state, not just a message, because §6.3
 * requires the surface to be able to say WHY ("1,240 of 1,000 minutes used;
 * balance 0") rather than render a generic failure. That is also why the refusal
 * sits on the DISPATCH path: it fails BEFORE the user waits on a run.
 *
 * ⚠️ This is the DISPATCH-side refusal only. It cannot by itself stop GitHub
 * billing Motir — a push, a fix-up commit or a repo-resident trigger reaches
 * Actions with no claim at all. Pausing Actions at the repository is MOTIR-1907's
 * job, and it drives that off the state this card exposes (see
 * `ciAllowanceService.getEntitlementState`).
 */
export class CiCreditsExhaustedError extends Error {
  readonly code = 'CI_CREDITS_EXHAUSTED' as const;

  constructor(
    readonly detail: {
      organizationId: string;
      state: CiEntitlementStateName;
      /** Linux-equivalent minutes consumed this period. */
      consumedMinutes: number;
      /** The org's included pool for the period (§1). */
      poolMinutes: number;
      /** The AI credit balance the refusal was decided on (`≤ 0`). */
      balance: number;
    },
  ) {
    super(
      `CI dispatch refused — out of credits: organization ${detail.organizationId} has used ` +
        `${detail.consumedMinutes} of ${detail.poolMinutes} included CI minutes this period and ` +
        `its credit balance is ${detail.balance}.`,
    );
    this.name = 'CiCreditsExhaustedError';
  }
}
