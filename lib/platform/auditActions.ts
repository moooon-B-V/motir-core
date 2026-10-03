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
  'console.open': { kind: 'read', reason: 'never' },
  /**
   * A read across the tenant boundary, named by its target. MOTIR-730's
   * `platformReadService` is the first writer; the entry it passes carries the
   * tenant it resolved, so this one member covers org / workspace / project /
   * user reads without a member per tier.
   */
  'estate.read': { kind: 'read', reason: 'never' },
  /**
   * The day-1 system-health glance was read (MOTIR-1167, design Panel 8).
   *
   * Its own member rather than `estate.read`, because it reads no tenant row at
   * all — the six signals come from the job ledger, the dead-letter set and the
   * deployment's own configuration. A trail that called this "a read of the
   * estate" would answer "which tenants did this operator look at?" with a page
   * view that looked at none.
   */
  'health.read': { kind: 'read', reason: 'never' },
  /**
   * One account was opened in the operator drill-down (MOTIR-1167, design
   * Panel 9) — the read the design's `--el-info` banner tells the operator, in
   * the surface itself, is being recorded.
   */
  'user.read': { kind: 'read', reason: 'never' },
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
  'user.password_reset_sent': { kind: 'write', reason: 'required' },
  /** An account was suspended — every session revoked, no new one issuable. */
  'user.suspend': { kind: 'write', reason: 'required' },
  /**
   * A suspension was lifted. `required` like its twin, and for a reason worth
   * saying out loud: the trail has to answer "why is this account open again?"
   * as readably as it answers why it was closed, and an unsuspend with no
   * reason is the half of the pair somebody would be tempted to leave blank.
   */
  'user.unsuspend': { kind: 'write', reason: 'required' },
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
  'org.internal_billing_set': { kind: 'write', reason: 'required' },
  /**
   * The classification was removed. `required` like its twin, and for the
   * reason `user.unsuspend` gives: the trail has to answer "why is this org
   * being billed again?" as readably as it answers why it stopped, and the
   * unset is the half of the pair somebody would be tempted to leave blank.
   *
   * Removing it leaves every ledger row exactly where it is — the debits and
   * their offsets are history, not state.
   */
  'org.internal_billing_unset': { kind: 'write', reason: 'required' },
  /**
   * The platform PLANNING MODEL for one audience was changed (Story MOTIR-7220 ·
   * MOTIR-7227) — which model plans for every customer org, the meta org or the
   * internal orgs, from the next planning job on.
   *
   * `required`, at the `superadmin` degree of ADR §7: it changes what every
   * organization in the audience is planned WITH, and so what each is charged
   * per turn. Target is `platform` with the audience as `targetId`, because the
   * setting belongs to no single tenant; `metadata` carries
   * `{ audience, fromModel, toModel }`. The domain is `ai` — the SUBJECT is the
   * planner, not the console screen.
   */
  'ai.planner_model.set': { kind: 'write', reason: 'required' },
  /**
   * Credits were GRANTED to an organization (MOTIR-747 · 10.3.2, design Panel
   * 2a/2b) — a positive `grant` row appended to its motir-ai ledger, the
   * support / goodwill path. Never a `top_up` (that is the customer's checkout,
   * Epic 8) and never a Stripe object.
   *
   * `required`, at the `superadmin` degree of ADR §7's "credit grants" row.
   * `metadata` carries `{ requestId, credits, balanceBefore, balanceAfter }` —
   * the two balances as the operator SAW them when the action was taken, the
   * planner-model row's from/to convention; `requestId` is motir-ai's idempotency
   * key and joins this row to the ledger row's `externalRef`
   * (`grant:staff:<requestId>`).
   */
  'org.credit_grant': { kind: 'write', reason: 'required' },
  /**
   * An organization's balance was CORRECTED by a signed `adjustment` row
   * (MOTIR-747, design Panel 2c) — a billing mistake, not goodwill. Same degree,
   * same metadata shape as `org.credit_grant`; `credits` is signed.
   */
  'org.credit_adjust': { kind: 'write', reason: 'required' },
  /**
   * An organization's AI PLAN TIER was assigned by an operator (MOTIR-747, design
   * Panel 2d). `metadata` carries `{ requestId, fromTierKey, toTierKey }`, the
   * from-tier as the operator saw it. It grants nothing and changes no Stripe
   * subscription — a paid org's next subscription event still sets its tier.
   */
  'org.plan_set': { kind: 'write', reason: 'required' },
  /**
   * An organization was SUSPENDED (MOTIR-748, design Panel 3a) — the
   * non-payment / abuse lever: every member of every workspace under it is
   * refused at the access gate on every door until it is reactivated. Nothing is
   * deleted. `targetKind: 'organization'`, the org as `organizationId`.
   */
  'org.suspend': { kind: 'write', reason: 'required' },
  /**
   * A suspended organization was REACTIVATED (MOTIR-748, design Panel 3c) — its
   * members are admitted again on their next request. Kill-switches keep their
   * own state across a suspension; reactivating does not touch them.
   */
  'org.reactivate': { kind: 'write', reason: 'required' },
  /**
   * A per-org KILL-SWITCH was turned OFF (MOTIR-750) — `ai_planning`,
   * `hosted_runs` or `web_search`, named in `metadata.key` with
   * `metadata.enabled: false`. Takes effect on the org's next request.
   */
  'org.kill_switch_off': { kind: 'write', reason: 'required' },
  /** A per-org kill-switch was turned back ON (MOTIR-750), `metadata.key`. */
  'org.kill_switch_on': { kind: 'write', reason: 'required' },
  /**
   * A superadmin STARTED a staff "View as" session (MOTIR-749, design Panel 4) —
   * seeing, or acting in, a tenant as one of its users. `required`, at the
   * `superadmin` degree of ADR §7. `targetKind: 'user'` (the account viewed as),
   * the org as `organizationId`; `metadata` carries
   * `{ sessionId, mode, durationMinutes, expiresAt, targetUserId, targetEmail,
   * organizationId, workspaceId }`.
   */
  'user.impersonation_start': { kind: 'write', reason: 'required' },
  /**
   * A staff session ENDED (MOTIR-749). Its reason is the SESSION's — the operator
   * typed it once, at start, and the row carries a copy (`inherited`), so the
   * trail answers "why was staff in this account?" on the end row too.
   * `metadata.endedBy` is `operator` (Exit session, or a new session replacing
   * it), `expiry` (the time-box ran out — noticed at the gate or by the sweep)
   * or `revoked` (the operator lost `superadmin` or signed out, or the account /
   * organization was suspended). The actor is the session's operator in every
   * case, so the end sits in the same operator's trail as its start.
   */
  'user.impersonation_end': { kind: 'write', reason: 'inherited' },
  /**
   * A page was OPENED inside a staff session (MOTIR-749) — one row per page
   * render, read-only and full access alike, `metadata` `{ sessionId, mode,
   * path }`. A read, so reason-free; the session's reason is on its start row,
   * joined by `sessionId`. The design's ended-page promise — "the session and
   * everything you opened in it are in the audit log" — is these rows.
   */
  'user.impersonation_view': { kind: 'read', reason: 'never' },
  /**
   * A MUTATING request (a Server Action, or a non-GET API call) made inside a
   * FULL-ACCESS staff session (MOTIR-749) — written BEFORE the request runs, so
   * nothing can be changed as a customer without the row "run by staff X as
   * user Y, reason Z" existing first. `inherited` reason; `metadata`
   * `{ sessionId, mode, method, path, serverAction }`. A read-only session never
   * produces one: its mutating requests are refused at the same chokepoint.
   */
  'user.impersonation_action': { kind: 'write', reason: 'inherited' },
  /**
   * The audit log ITSELF was searched (MOTIR-751 — the page is MOTIR-752,
   * design Panel 6). Reading the record of who touched the estate is a platform
   * read like any other, so it leaves a row: "who looked at the audit log, and
   * for what?" is a question the log has to be able to answer about itself.
   * `targetKind: 'organization'` with the org when the search was narrowed to
   * one tenant, `platform` otherwise; `metadata` carries the filters.
   */
  'audit.read': { kind: 'read', reason: 'never' },
  /**
   * The hash chain was VERIFIED (MOTIR-751, design Panels 6/7's "Verify
   * again"). A read — it recomputes and changes nothing — recorded with its
   * range in `metadata`, so a broken-chain finding can be traced to the check
   * that surfaced it.
   */
  'audit.verify': { kind: 'read', reason: 'never' },
} as const satisfies Record<
  string,
  { kind: PlatformAuditActionKind; reason: PlatformAuditReasonPolicy }
>;

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
export type PlatformAuditReasonPolicy = 'never' | 'required' | 'inherited';

/**
 * Whether an action READS the estate or CHANGES something (MOTIR-749).
 *
 * Explicit rather than derived from the reason policy since MOTIR-749: until
 * then "reason `never`" and "a read" were the same set, and MOTIR-751 derived
 * the audit log's default "Writes" filter from that. `user.impersonation_end`
 * and `user.impersonation_action` are WRITES whose reason the operator did not
 * type on the row itself — it is the session's, copied (`inherited`) — so the
 * derivation would have had to choose between misfiling them as reads and
 * pretending the operator typed a reason twice. The kind says what the action
 * IS; the policy says where its reason comes from.
 */
export type PlatformAuditActionKind = 'read' | 'write';

/** A member of the platform audit vocabulary. */
export type PlatformAuditAction = keyof typeof PLATFORM_AUDIT_ACTIONS;

/** Every action, as an array — for iteration and for tests. */
export const PLATFORM_AUDIT_ACTION_KEYS = Object.keys(
  PLATFORM_AUDIT_ACTIONS,
) as readonly PlatformAuditAction[];

/**
 * The READ verbs — what the audit log's default "Writes" filter leaves out
 * (MOTIR-751, design Panel 6).
 *
 * Derived from each action's explicit `kind` (MOTIR-749). It used to be derived
 * from the reason policy (`never` ⇒ read), which stopped being exact when the
 * staff-session writes arrived carrying the SESSION's reason — see
 * {@link PlatformAuditActionKind}. `tests/platform/platformAuditLog.test.ts`
 * pins the kind and the policy together: a read is always `never`, a write is
 * never `never`.
 */
export const PLATFORM_AUDIT_READ_ACTIONS: readonly PlatformAuditAction[] =
  PLATFORM_AUDIT_ACTION_KEYS.filter((a) => PLATFORM_AUDIT_ACTIONS[a].kind === 'read');

/** True for an action that CHANGES something — every operator write, direct or in a staff session. */
export function isPlatformAuditWrite(action: PlatformAuditAction): boolean {
  return PLATFORM_AUDIT_ACTIONS[action].kind === 'write';
}

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
  // `inherited` is held to the same bar: the service copies the session's
  // reason onto the row, and a row that arrived without one is a bug upstream.
  if (policy === 'never') return true;
  return typeof reason === 'string' && reason.trim().length > 0;
}
