/**
 * Typed errors for the platform tier (`docs/decisions/platform-staff-auth.md`).
 *
 * The domain-`errors.ts` convention from `CLAUDE.md`'s 4-layer rule: the gate
 * and the platform services throw these, and the surface above translates them.
 */

/**
 * The acting principal is not platform staff — or is staff below the required
 * degree, or is not signed in at all.
 *
 * ⚠️ ONE error for all three cases, deliberately (ADR §2). "No session",
 * "session but no `platformRole`" and "role below `minimum`" are
 * INDISTINGUISHABLE to every caller, because a caller that could tell them
 * apart could probe for the existence of the admin area — and every renderer of
 * this error answers with the ordinary 404 the tenant guard already returns for
 * an unknown id. Do NOT add a `reason` field, a discriminant subclass, or a
 * message that names `/admin`: the message below is what would end up in a log
 * line, and it names neither the route nor which of the three it was.
 */
export class NotPlatformStaffError extends Error {
  readonly code = 'NOT_PLATFORM_STAFF';

  constructor() {
    super('The acting principal has no platform standing');
    this.name = 'NotPlatformStaffError';
  }
}

/**
 * A platform action whose reason policy is `required` was recorded without one
 * (ADR §3b — enforced in the service, not by the column, because a READ
 * legitimately has no reason and the column must stay nullable for it).
 *
 * Carries the action, unlike `NotPlatformStaffError`: this one is only ever
 * raised for a principal who has ALREADY passed the gate, so there is nothing
 * left to leak, and the operator who forgot the field needs to know which
 * action refused them.
 */
export class MissingAuditReasonError extends Error {
  readonly code = 'MISSING_AUDIT_REASON';

  constructor(readonly action: string) {
    super(`The platform action "${action}" requires a stated reason`);
    this.name = 'MissingAuditReasonError';
  }
}
