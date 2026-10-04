import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import type { ImpersonationEndedBy, ImpersonationMode } from '@/generated/prisma/client';
import type {
  ImpersonationModeDTO,
  ImpersonationStartOptionsDTO,
  ImpersonationWorkspaceOptionDTO,
  StaffSessionDTO,
  StartedStaffSessionDTO,
} from '@/lib/dto/platformImpersonation';
import { firstNameOf, toStaffSessionDTO } from '@/lib/mappers/platformImpersonationMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import {
  ImpersonationInvalidRequestError,
  ImpersonationTargetIneligibleError,
  PlatformUserNotFoundError,
  type ImpersonationIneligibility,
} from '@/lib/platform/errors';
import {
  impersonationSessionRepository,
  type ImpersonationSessionWithNames,
} from '@/lib/repositories/impersonationSessionRepository';
import { platformEstateRepository } from '@/lib/repositories/platformEstateRepository';
import { platformStaffRepository } from '@/lib/repositories/platformStaffRepository';
import { platformUserRepository } from '@/lib/repositories/platformUserRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * STAFF "VIEW AS" SESSIONS — Story 10.3 · MOTIR-749, the backend of
 * `design/platform-admin/design-notes.md` § AMENDMENT 2026-10-03, Panels 4–5,
 * and ADR `platform-staff-auth.md` §7's "write-level impersonation" row.
 *
 * The shape is the verified safe-impersonation pattern, control by control:
 *
 *   1. REASON-GATED START. `user.impersonation_start` is `required`; the reason
 *      is asserted before the audited transaction opens, so a blank one leaves
 *      no row (the MOTIR-748 rule).
 *   2. TIME-BOXED. 15 / 30 / 60 minutes, nothing else — an "indefinite" session
 *      is refused here, not merely undrawn. The request-path gate refuses the
 *      session from `expires_at` whether or not anything has closed it; the
 *      sweep (`system.impersonation-expiry-sweep`) records the end of a session
 *      nobody came back to.
 *   3. A PERSISTENT BANNER — the (authed) layout renders the bar from the
 *      session this resolves; it is never dismissible.
 *   4. FULLY AUDITED, "run by staff X as user Y, reason Z". Start and end; one
 *      `user.impersonation_view` per page opened; one `user.impersonation_action`
 *      BEFORE every mutating request of a full-access session, carrying the
 *      session's reason. Every row's actor is the OPERATOR.
 *   5. NO RAW TOKENS, NO SHARED SESSION. Nothing is minted for the customer. The
 *      operator keeps their own Better-Auth session; a separate httpOnly cookie
 *      carries a random token (only its SHA-256 is stored), and `readSession`
 *      layers the target identity over the operator's session only while this
 *      row is open, bound to that very sign-in session, and inside its box.
 *
 * ⚠️ SUPERADMIN, AND ASSERTED HERE as well as in the server actions (ADR §2's
 * two-layer rule). Staff never impersonate staff, nobody impersonates
 * themselves, and neither a suspended account nor a suspended organization can
 * be entered (`ImpersonationTargetIneligibleError`, thrown inside the audited
 * transaction so the refusal leaves no start row).
 */

/** The time-boxes the dialog offers, in minutes. Never open-ended. */
export const STAFF_SESSION_DURATIONS_MINUTES = [15, 30, 60] as const;
export const STAFF_SESSION_DEFAULT_DURATION_MINUTES = 30;
const MAX_WORKSPACE_OPTIONS = 25;
const SWEEP_BATCH_SIZE = 100;

const MODES: readonly ImpersonationModeDTO[] = ['read_only', 'full'];

/** SHA-256 hex of a cookie token — what `impersonation_session.token_hash` stores. */
export function hashStaffSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The operator's own sign-in, as the request path knows it. */
export interface OperatorSignIn {
  userId: string;
  /** The Better-Auth session id the staff session is bound to. */
  sessionId: string;
}

/** What one request's staff session resolved to. */
export type StaffSessionResolution =
  /** The cookie names an open session, bound to this sign-in, inside its box. */
  | { kind: 'active'; session: StaffSessionDTO; target: Record<string, unknown> }
  /**
   * The cookie names a session that is over (or nothing at all). The request is
   * answered as signed-out until the cookie is cleared — fail closed, never
   * silently as the operator's own self in a tenant they think is the customer's.
   */
  | { kind: 'ended'; sessionId: string | null; operatorMatches: boolean };

/** How a request inside a staff session is classified (see `lib/platform/staffSession.ts`). */
export interface StaffRequestFacts {
  /** A Server Action or a non-GET request — something that may change data. */
  mutating: boolean;
  /** A tenant page render (the proxy's `x-current-path` is present). */
  pageView: boolean;
  method: string | null;
  path: string | null;
  serverAction: string | null;
}

class SessionAlreadyEndedSignal extends Error {}

function principalForRow(row: ImpersonationSessionWithNames): PlatformPrincipal {
  return { userId: row.operatorUserId, email: row.operator.email, role: row.operatorRole };
}

function workspaceOptions(
  memberships: Awaited<ReturnType<typeof platformEstateRepository.listWorkspaceMembershipsForUser>>,
): ImpersonationWorkspaceOptionDTO[] {
  return memberships.map((m) => ({
    workspaceId: m.workspace.id,
    workspaceName: m.workspace.name,
    organizationId: m.workspace.organization.id,
    organizationName: m.workspace.organization.name,
    organizationSuspended: m.workspace.organization.suspendedAt !== null,
  }));
}

/** The eligibility rules, as one pure function of what was read. */
function ineligibilityOf(
  principal: PlatformPrincipal,
  target: { id: string; platformRole: unknown; suspendedAt: Date | null },
  chosen: ImpersonationWorkspaceOptionDTO | null,
): ImpersonationIneligibility | null {
  if (target.id === principal.userId) return 'self';
  if (target.platformRole !== null) return 'platform_staff';
  if (target.suspendedAt !== null) return 'suspended_account';
  if (!chosen) return 'no_workspace';
  if (chosen.organizationSuspended) return 'suspended_organization';
  return null;
}

function chooseWorkspace(
  options: ImpersonationWorkspaceOptionDTO[],
  requested: string | null,
): ImpersonationWorkspaceOptionDTO | null {
  if (requested) return options.find((o) => o.workspaceId === requested) ?? null;
  return options.find((o) => !o.organizationSuspended) ?? options[0] ?? null;
}

/**
 * Record a session's END and mark the row, in one audited transaction. The row
 * is locked and re-read: two closers racing produce one end row and one no-op.
 * Returns false when it had already ended.
 */
async function closeSession(
  row: ImpersonationSessionWithNames,
  endedBy: ImpersonationEndedBy,
  extra: Record<string, string> = {},
): Promise<boolean> {
  const endedAt = new Date();
  const entry: PlatformAuditEntry = {
    action: 'user.impersonation_end',
    targetKind: 'user',
    targetId: row.targetUserId,
    targetLabel: row.target.email,
    organizationId: row.organizationId,
    reason: row.reason,
    metadata: {
      sessionId: row.id,
      mode: row.mode,
      endedBy,
      startedAt: row.startedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      endedAt: endedAt.toISOString(),
      ...extra,
    },
  };
  try {
    await withPlatformRead(principalForRow(row), entry, async (tx) => {
      const state = await impersonationSessionRepository.lockOpenState(row.id, tx);
      if (!state || state.endedAt) throw new SessionAlreadyEndedSignal();
      await impersonationSessionRepository.markEnded(row.id, { endedAt, endedBy }, tx);
    });
    return true;
  } catch (err) {
    if (err instanceof SessionAlreadyEndedSignal) return false;
    throw err;
  }
}

export const impersonationService = {
  /**
   * The "View as" dialog's data (design Panel 4): the account, where a session
   * would land, and whether one can start. An audited `estate.read` of the
   * account's tenancy. `superadmin` — the only degree that may start one.
   */
  async getStartOptions(
    principal: PlatformPrincipal,
    targetUserId: string,
    requestedWorkspaceId: string | null = null,
  ): Promise<ImpersonationStartOptionsDTO> {
    await requirePlatformStaff('superadmin');
    return withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'user', targetId: targetUserId },
      async (tx) => {
        const target = await platformUserRepository.findById(targetUserId, tx);
        if (!target) throw new PlatformUserNotFoundError(targetUserId);
        const options = workspaceOptions(
          await platformEstateRepository.listWorkspaceMembershipsForUser(
            targetUserId,
            MAX_WORKSPACE_OPTIONS,
            tx,
          ),
        );
        const chosen = chooseWorkspace(options, requestedWorkspaceId);
        return {
          targetUserId: target.id,
          name: target.name,
          firstName: firstNameOf(target.name, target.email),
          email: target.email,
          workspaces: options,
          defaultWorkspaceId: chosen?.workspaceId ?? null,
          ineligibility: ineligibilityOf(principal, target, chosen),
          durationsMinutes: STAFF_SESSION_DURATIONS_MINUTES,
          defaultDurationMinutes: STAFF_SESSION_DEFAULT_DURATION_MINUTES,
        };
      },
    );
  },

  /**
   * START a staff session (design Panel 4's primary). Audited
   * `user.impersonation_start`, reason required, `superadmin`.
   *
   * Any session the operator still has open is ENDED first (`endedBy:
   * operator`, `metadata.supersededBy: 'new_session'`) — one operator, one
   * session, so the bar can never describe a different session from the one the
   * cookie carries.
   *
   * The start row's metadata names the session, the tenant and the box, so they
   * are computed up front: the account and its workspaces are read first (an
   * audited `estate.read`), then re-checked INSIDE the start transaction, where a
   * change in between (a suspension, a lost membership) refuses the start and
   * rolls its row back.
   */
  async start(
    principal: PlatformPrincipal,
    input: {
      targetUserId: string;
      mode: string;
      durationMinutes: number;
      reason: string;
      operator: OperatorSignIn;
      workspaceId?: string | null;
    },
  ): Promise<StartedStaffSessionDTO> {
    await requirePlatformStaff('superadmin');
    if (!MODES.includes(input.mode as ImpersonationModeDTO)) {
      throw new ImpersonationInvalidRequestError(`unknown access mode "${input.mode}"`);
    }
    const mode = input.mode as ImpersonationMode;
    if (!(STAFF_SESSION_DURATIONS_MINUTES as readonly number[]).includes(input.durationMinutes)) {
      throw new ImpersonationInvalidRequestError(
        `a session lasts ${STAFF_SESSION_DURATIONS_MINUTES.join(', ')} minutes`,
      );
    }
    if (input.operator.userId !== principal.userId) {
      throw new ImpersonationInvalidRequestError('the sign-in is not the operator’s');
    }
    const reason = input.reason.trim();
    // Asserted against the action itself first, so a blank reason leaves no row
    // of any kind — not even the pre-read below.
    assertReasonSatisfied({ action: 'user.impersonation_start', targetKind: 'user', reason });

    const options = await this.getStartOptions(
      principal,
      input.targetUserId,
      input.workspaceId ?? null,
    );
    if (options.ineligibility) throw new ImpersonationTargetIneligibleError(options.ineligibility);
    const chosen = options.workspaces.find((w) => w.workspaceId === options.defaultWorkspaceId)!;

    // One operator, one session.
    const open = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'user', targetId: principal.userId },
      (tx) => impersonationSessionRepository.listOpenForOperator(principal.userId, tx),
    );
    for (const previous of open) {
      await closeSession(previous, 'operator', { supersededBy: 'new_session' });
    }

    const token = randomBytes(32).toString('base64url');
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + input.durationMinutes * 60_000);
    const entry: PlatformAuditEntry = {
      action: 'user.impersonation_start',
      targetKind: 'user',
      targetId: options.targetUserId,
      targetLabel: options.email,
      organizationId: chosen.organizationId,
      reason,
      metadata: {
        mode,
        durationMinutes: input.durationMinutes,
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        targetUserId: options.targetUserId,
        targetEmail: options.email,
        organizationId: chosen.organizationId,
        organizationName: chosen.organizationName,
        workspaceId: chosen.workspaceId,
        tokenHashPrefix: hashStaffSessionToken(token).slice(0, 12),
      },
    };

    const row = await withPlatformRead(principal, entry, async (tx) => {
      const target = await platformUserRepository.findById(options.targetUserId, tx);
      if (!target) throw new PlatformUserNotFoundError(options.targetUserId);
      const now = workspaceOptions(
        await platformEstateRepository.listWorkspaceMembershipsForUser(
          options.targetUserId,
          MAX_WORKSPACE_OPTIONS,
          tx,
        ),
      );
      const stillThere = now.find((w) => w.workspaceId === chosen.workspaceId) ?? null;
      const refusal = ineligibilityOf(principal, target, stillThere);
      if (refusal) throw new ImpersonationTargetIneligibleError(refusal);
      const created = await impersonationSessionRepository.create(
        {
          tokenHash: hashStaffSessionToken(token),
          operatorUserId: principal.userId,
          operatorRole: principal.role,
          operatorSessionId: input.operator.sessionId,
          targetUserId: options.targetUserId,
          organizationId: chosen.organizationId,
          workspaceId: chosen.workspaceId,
          mode,
          reason,
          startedAt,
          expiresAt,
        },
        tx,
      );
      return impersonationSessionRepository.findById(created.id, tx);
    });

    return { session: toStaffSessionDTO(row!), token };
  },

  /**
   * END the session a cookie carries, at the operator's request (the bar's Exit
   * session). `endedBy: operator`. Only the operator who opened it may end it
   * this way; a token naming anybody else's session is ignored. Returns the
   * session (ended), or null when the token named nothing the operator owns.
   *
   * Deliberately NOT gated on `superadmin`: an operator demoted mid-session must
   * still be able to leave it, and leaving changes nothing in the tenant.
   */
  async endByToken(operator: OperatorSignIn, token: string): Promise<StaffSessionDTO | null> {
    const row = await withSystemContext((tx) =>
      impersonationSessionRepository.findByTokenHash(hashStaffSessionToken(token), tx),
    );
    if (!row || row.operatorUserId !== operator.userId) return null;
    if (!row.endedAt) {
      const endedBy: ImpersonationEndedBy = row.expiresAt <= new Date() ? 'expiry' : 'operator';
      await closeSession(row, endedBy);
    }
    return this.findSessionRow(row.id);
  },

  /**
   * The cookie-clearing door's half (`/api/staff-session/clear`): record the end
   * of a session the gate found stale, if nothing has yet. Ends a session ONLY
   * when it is already over (past its box), so a GET can never cut a live
   * session short. Returns who it belonged to, for the redirect.
   */
  async settleStaleToken(
    token: string,
    signedInUserId: string | null,
  ): Promise<{ sessionId: string | null; operatorMatches: boolean }> {
    const row = await withSystemContext((tx) =>
      impersonationSessionRepository.findByTokenHash(hashStaffSessionToken(token), tx),
    );
    if (!row) return { sessionId: null, operatorMatches: false };
    if (!row.endedAt && row.expiresAt <= new Date()) await closeSession(row, 'expiry');
    return { sessionId: row.id, operatorMatches: row.operatorUserId === signedInUserId };
  },

  /**
   * THE REQUEST-PATH GATE: what the staff-session cookie means for this request.
   * Called by `readSession` (through `lib/platform/staffSession.ts`, which
   * memoises it per request) with the operator's own sign-in.
   *
   * Active only when ALL hold: the row exists and is open, it belongs to this
   * signed-in user AND this very sign-in session, it is inside its box, the
   * operator still holds `superadmin`, and the target account is not suspended.
   * A failed check other than "no such row" CLOSES the session (`expiry` or
   * `revoked`) with its end row, once.
   *
   * On an active session: a mutating request is REFUSED in read-only mode
   * (`ImpersonationReadOnlyError`, thrown by the caller) and AUDITED before it
   * runs in full mode; a tenant page render is audited as a view.
   */
  async resolveForRequest(
    operator: OperatorSignIn,
    token: string,
  ): Promise<StaffSessionResolution> {
    const row = await withSystemContext((tx) =>
      impersonationSessionRepository.findByTokenHash(hashStaffSessionToken(token), tx),
    );
    if (!row) return { kind: 'ended', sessionId: null, operatorMatches: false };
    const operatorMatches = row.operatorUserId === operator.userId;
    if (row.endedAt) return { kind: 'ended', sessionId: row.id, operatorMatches };

    let endedBy: ImpersonationEndedBy | null = null;
    let why = '';
    if (row.expiresAt <= new Date()) {
      endedBy = 'expiry';
    } else if (!operatorMatches || row.operatorSessionId !== operator.sessionId) {
      endedBy = 'revoked';
      why = 'operator_signed_out';
    } else {
      const standing = await platformStaffRepository.findStandingByUserId(row.operatorUserId);
      if (!standing?.platformRole || !platformRoleAtLeast(standing.platformRole, 'superadmin')) {
        endedBy = 'revoked';
        why = 'operator_lost_superadmin';
      }
    }
    const target = endedBy ? null : await userRepository.findById(row.targetUserId);
    if (!endedBy && (!target || target.suspendedAt)) {
      endedBy = 'revoked';
      why = 'account_suspended';
    }
    if (endedBy) {
      await closeSession(row, endedBy, why ? { revokedBecause: why } : {});
      return { kind: 'ended', sessionId: row.id, operatorMatches };
    }
    return {
      kind: 'active',
      session: toStaffSessionDTO(row),
      target: target as unknown as Record<string, unknown>,
    };
  },

  /**
   * Record one request made inside an ACTIVE session — before it runs. A page
   * render is `user.impersonation_view` (a read); a mutating request in a
   * full-access session is `user.impersonation_action`, carrying the session's
   * reason. The actor is the operator; the target is the account viewed as.
   */
  async recordRequest(session: StaffSessionDTO, facts: StaffRequestFacts): Promise<void> {
    const principal: PlatformPrincipal = {
      userId: session.operatorUserId,
      // The chained row records the actor's id and role; the email is the
      // principal's, unused by the append.
      email: '',
      role: 'superadmin',
    };
    const common = {
      targetKind: 'user' as const,
      targetId: session.targetUserId,
      targetLabel: session.targetEmail,
      organizationId: session.organizationId,
    };
    if (facts.mutating) {
      const entry: PlatformAuditEntry = {
        ...common,
        action: 'user.impersonation_action',
        reason: session.reason,
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          method: facts.method,
          path: facts.path,
          serverAction: facts.serverAction,
        },
      };
      assertReasonSatisfied(entry);
      await withPlatformRead(principal, entry, async () => undefined);
      return;
    }
    if (facts.pageView) {
      await withPlatformRead(
        principal,
        {
          ...common,
          action: 'user.impersonation_view',
          metadata: { sessionId: session.id, mode: session.mode, path: facts.path },
        },
        async () => undefined,
      );
    }
  },

  /** One session by id, unaudited — the service's own re-read after an end. */
  async findSessionRow(sessionId: string): Promise<StaffSessionDTO | null> {
    const row = await withSystemContext((tx) =>
      impersonationSessionRepository.findById(sessionId, tx),
    );
    return row ? toStaffSessionDTO(row) : null;
  },

  /**
   * The ended page's read (design Panel 5c) — one of the operator's OWN sessions,
   * audited as an `estate.read` of the account it was about. Null for a session
   * that is not theirs (the page then 404s) or does not exist.
   */
  async getOwnSession(
    principal: PlatformPrincipal,
    sessionId: string,
  ): Promise<StaffSessionDTO | null> {
    const row = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform', targetLabel: `staff session ${sessionId}` },
      (tx) => impersonationSessionRepository.findById(sessionId, tx),
    );
    if (!row || row.operatorUserId !== principal.userId) return null;
    return toStaffSessionDTO(row);
  },

  /**
   * The sweep (`system.impersonation-expiry-sweep`, every 5 minutes): record the
   * end of every session past its box that nobody closed — the operator closed
   * the tab and never came back. The gate already refused it from `expires_at`;
   * this makes the TRAIL whole. Bounded per pass; converges on re-run.
   */
  async closeExpiredSessions(): Promise<{ closed: number; scanned: number }> {
    const rows = await withSystemContext((tx) =>
      impersonationSessionRepository.listExpiredOpen(new Date(), SWEEP_BATCH_SIZE, tx),
    );
    let closed = 0;
    for (const row of rows) {
      if (await closeSession(row, 'expiry')) closed++;
    }
    return { closed, scanned: rows.length };
  },
};
