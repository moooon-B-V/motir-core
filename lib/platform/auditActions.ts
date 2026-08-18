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
} as const satisfies Record<string, { reason: PlatformAuditReasonPolicy }>;

/**
 * Whether an action must carry an operator's stated reason.
 *
 * `never` for a READ — a read legitimately has none, which is why the column is
 * nullable and the rule lives here rather than in the schema. `required` for
 * every WRITE, per the ADR's §7 table.
 *
 * ⚠️ NO ACTION IN THIS BUILD IS `required`, and that is a statement about
 * ALLOCATION rather than about the rule. MOTIR-2896 ships no write against a
 * tenant; the first `required` members are MOTIR-1167's `send password reset`
 * and `suspend / unsuspend an account`, each of which the design puts behind a
 * confirm dialog with a mandatory reason. The enforcement is shipped now, with
 * the mechanism it guards, so that card adds a row to this table and inherits
 * the check rather than re-deriving it.
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
 * a test. No action in this build carries `required` — that arrives with
 * MOTIR-1167's two writes — so a rule expressed only over
 * `PLATFORM_AUDIT_ACTIONS` would ship with its load-bearing half unexecuted,
 * and the first card to add a `required` action would be the first to find out
 * whether it works.
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
