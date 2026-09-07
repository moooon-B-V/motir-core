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

/**
 * The account an operator asked for does not exist (MOTIR-1167).
 *
 * Carries the id, like `MissingAuditReasonError` and unlike
 * `NotPlatformStaffError`: this one is only ever raised for a principal who has
 * already passed the gate, so there is nothing left to leak. The operator typed
 * or followed a stale id and needs to know which one missed.
 *
 * ⚠️ It is NOT the 404 posture. The gate's 404 says "this route does not
 * exist"; this says "this ACCOUNT does not exist", to somebody already inside
 * the console. Rendering it as the app's `notFound()` is correct and is what the
 * drill-down does — the two answers coincide on the screen and mean different
 * things, which is why they are different types here.
 */
export class PlatformUserNotFoundError extends Error {
  readonly code = 'PLATFORM_USER_NOT_FOUND';

  constructor(readonly userId: string) {
    super(`No account with id "${userId}"`);
    this.name = 'PlatformUserNotFoundError';
  }
}

/**
 * A suspend was asked for on an already-suspended account, or an unsuspend on
 * one that is not suspended (MOTIR-1167).
 *
 * The state is read and re-checked INSIDE the write transaction under a row
 * lock, so this is a genuine lost race between two operators rather than a
 * stale-page nuisance: without the lock, two concurrent suspends would each
 * read "open", each write, and the audit log would carry two suspensions of one
 * account with the second one's reason silently winning the column.
 */
export class PlatformSuspensionStateError extends Error {
  readonly code = 'PLATFORM_SUSPENSION_STATE';

  constructor(readonly suspended: boolean) {
    super(
      suspended ? 'That account is already suspended' : 'That account is not currently suspended',
    );
    this.name = 'PlatformSuspensionStateError';
  }
}

/**
 * The organization an operator asked for does not exist (MOTIR-4565).
 *
 * The org twin of `PlatformUserNotFoundError`, and it carries the id for the
 * same reason: it is only ever raised for a principal who has already passed the
 * gate, so there is nothing left to leak.
 *
 * ⚠️ AND IT IS NOT THE SAME ANSWER AS AN UNARMED READ. Before
 * `20260905120000_organization_internal_billing`, a cross-tenant read of
 * `organization` returned zero rows because no policy admitted it — which
 * produces this error while meaning something entirely different. The arms are
 * what make "no rows" mean "no such organization"; if this ever starts firing
 * for an org that plainly exists, read the policy set before reading the id.
 */
export class PlatformOrganizationNotFoundError extends Error {
  readonly code = 'PLATFORM_ORGANIZATION_NOT_FOUND';

  constructor(readonly organizationId: string) {
    super(`No organization with id "${organizationId}"`);
    this.name = 'PlatformOrganizationNotFoundError';
  }
}

/**
 * A classify was asked for on an already-internal org, or an unclassify on one
 * that is not classified (MOTIR-4565).
 *
 * The org twin of `PlatformSuspensionStateError`, and the same genuine race
 * rather than a stale-page nuisance: the state is read and re-checked INSIDE the
 * write transaction under a row lock, so this fires when two operators acted on
 * one org at once. Without the lock both would read "not classified", both would
 * write, and the audit log would carry two classifications of one org while only
 * one of them describes a change that happened.
 */
export class PlatformClassificationStateError extends Error {
  readonly code = 'PLATFORM_CLASSIFICATION_STATE';

  constructor(readonly internalBilling: boolean) {
    super(
      internalBilling
        ? 'That organization is already classified as internal billing'
        : 'That organization is not currently classified as internal billing',
    );
    this.name = 'PlatformClassificationStateError';
  }
}
