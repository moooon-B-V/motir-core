import 'server-only';

import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import type {
  PlatformUserDetailDTO,
  PlatformUserPageDTO,
  PlatformUserSummaryDTO,
} from '@/lib/dto/platform';
import {
  toPlatformAuditLogDTO,
  toPlatformUserDetailDTO,
  toPlatformUserSummaryDTO,
} from '@/lib/mappers/platformMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { PlatformSuspensionStateError, PlatformUserNotFoundError } from '@/lib/platform/errors';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { platformUserRepository } from '@/lib/repositories/platformUserRepository';
import { isPlatformAuditAction, reasonPolicyFor } from '@/lib/platform/auditActions';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

/**
 * The day-1 SUPPORT tools — design `platform-admin/design-notes.md` **Panel 9**,
 * card MOTIR-1167, and the `operator` tier of the ADR's §7 allocation table.
 *
 * Three things an operator can do on launch day when somebody writes in: FIND
 * the account, LOOK at it, and take one of exactly two actions on it — send a
 * password reset, or suspend / unsuspend it. Everything else on the account is
 * read-only, and every other operator power belongs to Story 10.3.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER, PER METHOD
 * ---------------------------------------------------------------------------
 * `support` reads, `operator` writes — the ADR's §1 table, applied here rather
 * than inherited from the `(admin)` layout. §2 is explicit that the two
 * assertions are BOTH required: *"the layout protects the PAGES; the service
 * check protects against a future route handler, server action or job that
 * reaches the platform tier without passing through a layout."* Every public
 * method below opens with its own `requirePlatformStaff(<degree>)`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WRITES ARE ORDERED AUDIT-FIRST, AND WHAT THAT COSTS
 * ---------------------------------------------------------------------------
 * `withPlatformRead` INSERTs the audit row as the first statement of the
 * transaction, before the work — so a write that rolls back leaves no row, and a
 * write that commits cannot exist without one (ADR §3a). The suspension columns
 * and the session revocation go INSIDE that transaction with it, so the three
 * share one fate.
 *
 * The password-reset send cannot: an email is an external side effect and
 * `CLAUDE.md` keeps those outside the transaction. So it is ordered
 * RECORD-then-SEND, and the residual failure is named rather than hidden: if the
 * provider rejects the send, the log carries a row for an action the recipient
 * never saw, and the operator sees the error and retries. That is the safe
 * direction. The opposite order — send, then record — loses the record of a mail
 * that actually went out, and the whole point of Panel 9's log is that *"an
 * operator can never perform an action and wonder whether it was recorded."*
 */

/**
 * How many accounts one lookup returns.
 *
 * A hard cap, not a page. The answer to "too many matches" is a narrower query,
 * not a pager an operator scrolls through reading strangers' email addresses —
 * and a cross-tenant surface should make the cheap, broad read the awkward one.
 */
export const PLATFORM_USER_SEARCH_LIMIT = 25;

/**
 * The shortest query the lookup will run.
 *
 * Two characters over every account Motir hosts is not a lookup, it is a dump
 * with an extra step. The floor is enforced in the SERVICE rather than by the
 * form, because a Server Action is reachable without the form.
 */
export const PLATFORM_USER_SEARCH_MIN_LENGTH = 3;

/** How many audit rows the drill-down reads before filtering to the writes. */
const PLATFORM_USER_ACTION_LOG_LIMIT = 50;

/**
 * Is this row an operator WRITE, as Panel 9's log means the word?
 *
 * ⚠️ THE DISCRIMINATOR IS THE REASON POLICY, NOT A LIST OF ACTION NAMES. The
 * ADR requires a stated reason for every write and forbids one on every read
 * (§3b), so `reason: 'required'` IS "this action changed something" — and a
 * hard-coded list here would need editing every time Story 10.3 adds a verb,
 * with the log silently omitting the new one until somebody noticed.
 *
 * A row whose action this build does not recognise is EXCLUDED. The column is a
 * `String`, so a row written by a newer deploy can carry a member this build has
 * never heard of, and there is no way to know whether it was a write. Excluding
 * it under-reports; including it would assert a write happened on the strength
 * of not recognising the name.
 */
function isOperatorWrite(row: { action: string }): boolean {
  return isPlatformAuditAction(row.action) && reasonPolicyFor(row.action) === 'required';
}

export const platformSupportService = {
  /**
   * Find accounts by email or name.
   *
   * Returns `[]` for a query under the floor rather than throwing: an empty box
   * and a two-character box are the same intent — the operator has not finished
   * typing — and the surface renders both as its "nothing yet" state.
   *
   * ⚠️ THIS IS THE *USER* LOOKUP, NOT THE ESTATE SEARCH. Panel 3's global search
   * groups results into Organizations / Workspaces / Projects / Users, and three
   * of those four are tenant tables whose `platform_staff` READ arms do not exist
   * — the ADR's own "deliberately does NOT decide" table allocates every one of
   * them to MOTIR-730. A read of them from this tier answers with zero rows and
   * raises nothing once MOTIR-2435 cuts over to the non-bypass role. `user` has
   * no RLS at all (`tenant-root-creation-rls.test.ts`'s DELIBERATELY_UNGUARDED
   * map), so this half answers identically before and after that cutover, which
   * is precisely why it is the half that ships on launch day.
   */
  async searchUsers(
    principal: PlatformPrincipal,
    query: string,
  ): Promise<PlatformUserSummaryDTO[]> {
    await requirePlatformStaff('support');
    const trimmed = query.trim();
    if (trimmed.length < PLATFORM_USER_SEARCH_MIN_LENGTH) return [];

    const rows = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'user', targetLabel: trimmed },
      (tx) => platformUserRepository.search(trimmed, PLATFORM_USER_SEARCH_LIMIT, tx),
    );
    return rows.map(toPlatformUserSummaryDTO);
  },

  /**
   * The whole drill-down page — the account AND its support-action log.
   *
   * ONE method returning both, so the page costs ONE platform transaction and
   * writes ONE audit row. Two methods would write two rows per page view and put
   * the trail's own noise floor above the actions it exists to record.
   *
   * The audit row it writes is what the surface's own `--el-info` banner tells
   * the operator is being written — *"This cross-tenant read is recorded in the
   * audit log"* — so the claim on screen and the row in the table are produced by
   * the same call and cannot drift apart.
   */
  async getUserPage(principal: PlatformPrincipal, userId: string): Promise<PlatformUserPageDTO> {
    await requirePlatformStaff('support');

    const result = await withPlatformRead(
      principal,
      { action: 'user.read', targetKind: 'user', targetId: userId },
      // ⚠️ THROWN INSIDE THE TRANSACTION, NOT AFTER IT. The audit row is already
      // written by the time this callback runs, so returning a sentinel and
      // throwing outside would COMMIT a row recording a read of an account that
      // does not exist. Throwing here rolls the row back with the read, which is
      // the ADR §3a property stated from the other side: *"a read that rolls back
      // leaves no audit row."* Every method below throws from inside for the same
      // reason.
      async (tx) => {
        const row = await platformUserRepository.findById(userId, tx);
        if (!row) throw new PlatformUserNotFoundError(userId);
        const sessions = await platformUserRepository.countSessions(userId, tx);
        const trail = await platformAuditLogRepository.listByTarget(
          'user',
          userId,
          PLATFORM_USER_ACTION_LOG_LIMIT,
          tx,
        );
        return { row, sessions, trail };
      },
    );

    return {
      user: toPlatformUserDetailDTO(result.row, result.sessions),
      actions: result.trail.filter(isOperatorWrite).map(toPlatformAuditLogDTO),
    };
  },

  /**
   * Send the account holder a password-reset link.
   *
   * ⚠️ IT TRIGGERS THE SHIPPED FLOW; IT DOES NOT SET A PASSWORD. The link goes to
   * the account's OWN address through `auth.api.requestPasswordReset` — the same
   * Verification-table token, the same `sendResetPassword` hook, the same
   * `/reset-password/new` confirm page the product already uses, and the same
   * one-hour expiry. So an operator never holds a credential and never sees one,
   * and an operator with a compromised session cannot take an account over: the
   * mail lands in the account holder's inbox, not theirs.
   *
   * That is also why this is `operator` rather than `superadmin` while
   * being a write: its blast radius is one email to an address the operator did
   * not choose.
   */
  async sendPasswordReset(
    principal: PlatformPrincipal,
    userId: string,
    reason: string,
  ): Promise<PlatformUserDetailDTO> {
    await requirePlatformStaff('operator');
    const entry = {
      action: 'user.password_reset_sent',
      targetKind: 'user',
      targetId: userId,
      reason,
    } as const;
    assertReasonSatisfied(entry);

    const result = await withPlatformRead(principal, entry, async (tx) => {
      const row = await platformUserRepository.findById(userId, tx);
      if (!row) throw new PlatformUserNotFoundError(userId);
      const sessions = await platformUserRepository.countSessions(userId, tx);
      return { row, sessions };
    });

    // OUTSIDE the transaction — an email is an external side effect, and the
    // audit row above has already committed (see the header's RECORD-then-SEND
    // note for the residual failure this deliberately accepts).
    const requestHeaders = await headers();
    await auth.api.requestPasswordReset({
      headers: requestHeaders,
      body: {
        email: result.row.email,
        redirectTo: `${resolveBaseUrlTrimmed()}/reset-password/new`,
      },
    });

    return toPlatformUserDetailDTO(result.row, result.sessions);
  },

  /**
   * Suspend or unsuspend one account.
   *
   * ONE method for both directions, because they are one toggle in the design
   * and — more to the point — one invariant: an account is suspended or it is
   * not, and the check that it is not already in the requested state is the same
   * lock-and-re-read in both directions. Two methods would be two copies of the
   * concurrency guard, and the second copy is the one that gets it wrong.
   *
   * ⚠️ THE ROW IS LOCKED AND RE-READ INSIDE THE TRANSACTION. This is a
   * read-derived write: whether to write at all depends on the state read a
   * moment earlier. Without `FOR UPDATE` two operators acting on one account
   * during the same incident both read "open", both write, and the log carries
   * two suspensions while the column silently keeps whichever reason committed
   * last — a trail that disagrees with the account it describes.
   *
   * ⚠️ AND THE SESSION REVOCATION IS PART OF THE SUSPENSION, not a follow-up.
   * The column stops the NEXT sign-in (`lib/auth/index.ts`'s session hook); this
   * stops the sessions already open. A suspension that did only the first would
   * leave an already-signed-in account working for up to the session lifetime,
   * which is the one window the action exists to close — and the design's confirm
   * copy promises both in as many words: *"They are signed out of every session
   * immediately and cannot sign back in."*
   *
   * Unsuspending revokes nothing: there is nothing to revoke, and the person
   * signs in again for themselves.
   */
  async setSuspended(
    principal: PlatformPrincipal,
    userId: string,
    suspended: boolean,
    reason: string,
    now: Date = new Date(),
  ): Promise<PlatformUserDetailDTO> {
    await requirePlatformStaff('operator');
    const entry = {
      action: suspended ? ('user.suspend' as const) : ('user.unsuspend' as const),
      targetKind: 'user' as const,
      targetId: userId,
      reason,
    };
    assertReasonSatisfied(entry);

    const result = await withPlatformRead(principal, entry, async (tx) => {
      const locked = await platformUserRepository.lockSuspensionState(userId, tx);
      // Both refusals are thrown from INSIDE, which rolls the audit row back with
      // them. A row recording a suspension that was refused is worse than no row:
      // it is the trail asserting something about the account that the account
      // itself contradicts.
      if (!locked) throw new PlatformUserNotFoundError(userId);
      if ((locked.suspendedAt !== null) === suspended) {
        throw new PlatformSuspensionStateError(suspended);
      }

      const row = await platformUserRepository.setSuspension(
        userId,
        suspended
          ? { suspendedAt: now, suspendedReason: reason.trim() }
          : { suspendedAt: null, suspendedReason: null },
        tx,
      );
      if (suspended) await platformUserRepository.deleteSessions(userId, tx);
      const sessions = await platformUserRepository.countSessions(userId, tx);
      return { row, sessions };
    });

    return toPlatformUserDetailDTO(result.row, result.sessions);
  },
};
