/**
 * The platform audit vocabulary — `docs/decisions/platform-staff-auth.md` §3b.
 *
 * `platform_audit_log.action` is a `String` in the database and a CLOSED UNION
 * here. That split is the decision, not an oversight: an audit vocabulary is
 * open-ended by nature (four cards across two epics each add verbs), and a
 * Postgres enum would need an `ALTER TYPE` migration for every one of them. The
 * closedness that actually matters — catching a typo at the call site — is
 * bought in code, exactly as `lib/permissions/catalog.ts` owns the permission
 * keys rather than the schema.
 *
 * ⚠️ THIS TABLE IS MEANT TO GROW, and each consumer extends it. MOTIR-2896
 * seeds it with the actions the foundation itself performs; MOTIR-730's
 * cross-tenant reads, MOTIR-1167's two day-1 support writes and Story 10.3's
 * governance actions each add their own. **The ADR's §7 table is the
 * allocation** — which card owns which action, at which minimum role, and
 * whether a reason is required — and it is the thing to read before adding a
 * member here.
 *
 * Naming: `<domain>.<verb>`, lowercase, dot-separated. The domain is the
 * SUBJECT of the action, not the screen it was performed from.
 */
export const PLATFORM_AUDIT_ACTIONS = {
  /**
   * A platform-staff principal opened the operator console. The one action the
   * foundation itself performs — a cross-tenant surface being ENTERED, which is
   * the first thing a SOC-2-style reviewer asks the log for ("who was in the
   * console, and when?").
   */
  'console.open': { reason: 'never' },
  /**
   * A read across the tenant boundary, named by its target. MOTIR-730's
   * `platformReadService` is the first writer; the entry it passes carries the
   * tenant it resolved, so this one member covers org / workspace / project /
   * user reads without a member per tier.
   */
  'estate.read': { reason: 'never' },
  /**
   * The day-1 system-health glance was read (MOTIR-1167, design Panel 8).
   *
   * Its own member rather than `estate.read`, because it reads no tenant row at
   * all — the six signals come from the job ledger, the dead-letter set and the
   * deployment's own configuration. A trail that called this "a read of the
   * estate" would answer "which tenants did this operator look at?" with a page
   * view that looked at none.
   */
  'health.read': { reason: 'never' },
  /**
   * One account was opened in the operator drill-down (MOTIR-1167, design
   * Panel 9) — the read the design's `--el-info` banner tells the operator, in
   * the surface itself, is being recorded.
   */
  'user.read': { reason: 'never' },
  /**
   * A password-reset link was sent to an account's own address at an operator's
   * request. The FIRST `required`-reason member (ADR §7): a write, and one whose
   * whole justification lives outside Motir — somebody wrote in and said they
   * could not get back into their account.
   *
   * It does not set a password and it does not read one: it triggers the shipped
   * `requestPasswordReset` flow, so the link goes to the account holder and the
   * operator never holds a credential.
   */
  'user.password_reset_sent': { reason: 'required' },
  /** An account was suspended — every session revoked, no new one issuable. */
  'user.suspend': { reason: 'required' },
  /**
   * A suspension was lifted. `required` like its twin, and for a reason worth
   * saying out loud: the trail has to answer "why is this account open again?"
   * as readably as it answers why it was closed, and an unsuspend with no
   * reason is the half of the pair somebody would be tempted to leave blank.
   */
  'user.unsuspend': { reason: 'required' },
  /**
   * An organization was classified INTERNAL BILLING (MOTIR-4565) — from now on
   * every debit it incurs is paired, in the same transaction, with an
   * offsetting credit, so it is charged exactly like a customer and made whole
   * (`docs/decisions/internal-billing-classification.md` §2).
   *
   * `required`, and joining ADR §7's allocation table at the `superadmin`
   * degree. The domain is `org` rather than `billing` because the SUBJECT of
   * the action is the organization, not the screen it was performed from —
   * this file's own naming rule.
   */
  'org.internal_billing_set': { reason: 'required' },
  /**
   * The classification was removed. `required` like its twin, and for the
   * reason `user.unsuspend` gives: the trail has to answer "why is this org
   * being billed again?" as readably as it answers why it stopped, and the
   * unset is the half of the pair somebody would be tempted to leave blank.
   *
   * Removing it leaves every ledger row exactly where it is — the debits and
   * their offsets are history, not state.
   */
  'org.internal_billing_unset': { reason: 'required' },
} as const satisfies Record<string, { reason: PlatformAuditReasonPolicy }>;

/**
 * Whether an action must carry an operator's stated reason.
 *
 * `never` for a READ — a read legitimately has none, which is why the column is
 * nullable and the rule lives here rather than in the schema. `required` for
 * every WRITE, per the ADR's §7 table.
 *
 * ⚠️ THE FIRST `required` MEMBERS ARRIVED WITH MOTIR-1167, exactly as MOTIR-2896
 * predicted here: `user.password_reset_sent`, `user.suspend` and
 * `user.unsuspend`, each of which the design puts behind a confirm dialog with a
 * mandatory reason. The enforcement shipped with the mechanism it guards, one
 * card early, so this card added three rows to the table above and inherited the
 * check rather than re-deriving it — which is the whole argument for building a
 * rule's unexercised arm alongside the rule.
 */
export type PlatformAuditReasonPolicy = 'never' | 'required';

/** A member of the platform audit vocabulary. */
export type PlatformAuditAction = keyof typeof PLATFORM_AUDIT_ACTIONS;

/** Every action, as an array — for iteration and for tests. */
export const PLATFORM_AUDIT_ACTION_KEYS = Object.keys(
  PLATFORM_AUDIT_ACTIONS,
) as readonly PlatformAuditAction[];

/**
 * A narrowing guard for the one place the union cannot reach: a value read BACK
 * out of the database. The column is a `String`, so a row written by an older
 * deploy can carry a member this build does not know.
 */
export function isPlatformAuditAction(value: string): value is PlatformAuditAction {
  return Object.hasOwn(PLATFORM_AUDIT_ACTIONS, value);
}

/** The reason policy for one action. */
export function reasonPolicyFor(action: PlatformAuditAction): PlatformAuditReasonPolicy {
  return PLATFORM_AUDIT_ACTIONS[action].reason;
}

/**
 * The rule itself, as a pure function of (policy, reason).
 *
 * Split out from the action lookup deliberately, so BOTH arms are reachable by
 * a test. It was written when no action carried `required`, so that the rule's
 * load-bearing half was not shipped unexecuted; MOTIR-1167's three writes are
 * now the first callers to take that arm through the action lookup.
 *
 * A blank / whitespace-only reason does NOT satisfy `required`: the design puts
 * the reason behind a confirm dialog precisely so somebody has to type one, and
 * a space would defeat that while looking like compliance in the log.
 */
export function reasonSatisfied(
  policy: PlatformAuditReasonPolicy,
  reason: string | null | undefined,
): boolean {
  if (policy !== 'required') return true;
  return typeof reason === 'string' && reason.trim().length > 0;
}
