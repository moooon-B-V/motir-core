import { Prisma, type AccountDeletionRequest } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { accountDeletionRequestRepository } from '@/lib/repositories/accountDeletionRequestRepository';
import { sessionRepository } from '@/lib/repositories/sessionRepository';
import { accountErasureService } from '@/lib/services/accountErasureService';
import { withUserContext } from '@/lib/workspaces/context';
import { erasureDueAt } from '@/lib/users/dataSubjectRequests';
import {
  AccountDeletionAlreadyCompletedError,
  AccountDeletionAlreadyScheduledError,
  AccountDeletionBlockedError,
  NoOpenAccountDeletionRequestError,
} from '@/lib/users/errors';
import { toAccountDeletionRequestDTO } from '@/lib/mappers/accountErasureMappers';
import type { AccountDeletionRequestDTO } from '@/lib/dto/accountErasure';

// Scheduling and cancelling an account deletion (Story 8.4 · Subtask
// MOTIR-3700) — the SECOND of the two backend capabilities a destructive flow
// needs, the do-the-action WRITE. `accountErasureService` is the first (the
// impact preview / read); the erasure sweep that acts on these rows is
// MOTIR-3702, and the pane and banner that drive them are MOTIR-1136 /
// MOTIR-3704.
//
// Design of record: `design/settings/design-notes.md` → `Data & privacy` →
// DECISION 4 (a 30-day grace period, because here the window is REACHABLE) and
// DECISION 5 (the BLOCKED case is the ORGANIZATION).
//
// ── DELETION SCHEDULES; IT DOES NOT FIRE ────────────────────────────────────
// Nothing here erases anything. The row this writes is a DECISION with a
// deadline on it, and the reader keeps a way back for the whole window:
// *"A grace period the user cannot reach is not a grace period"*
// (`docs/decisions/code-graph-index-fleet.md` §14.3). §14.3 uses that doctrine
// to refuse a window for a workspace hard-delete, because deleting a workspace
// cascades away every surface a user could undo INTO. An account deletion is
// the mirror case: the reader's own credentials survive the window, so they can
// sign back in — and what they land on is MOTIR-3704's app-wide banner, with
// `Cancel deletion` on it, on every authed page.
//
// ⚠️ SIGNING IN IS THE WAY BACK TO THE WINDOW; IT IS NOT ITSELF THE CANCEL
// (MOTIR-3742). MOTIR-3700 wired an auto-cancel onto `session.create.after`,
// and composed with the sign-out below it took the deletion back before any
// page rendered — leaving the two doors the design DRAWS reachable only when
// that cancel had thrown, and silently revoking the deletion of anyone who
// signed in to collect their export. The cancel is now the deliberate act:
// `docs/decisions/account-deletion-cancel-path.md`.
//
// ── THE BLOCK IS READ, NOT CAUGHT ───────────────────────────────────────────
// {@link scheduleAccountDeletion} asks the impact preview for its verdict and
// refuses on it. It does NOT attempt the delete and catch `LastOrgOwnerError`:
// DECISION 5 is explicit that *"a blocked state discovered at submit is a
// design defect, not an error message"*, and a service that learns the verdict
// only by trying cannot render it on the pane at rest.

/** `true` when `err` is the partial unique index refusing a second open request. */
function isOpenRequestUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Sign the reader out of every device — the post-commit half of scheduling.
 *
 * ⚠️ BEST-EFFORT, AND THAT IS THE DECISION RATHER THAN A SHORTCUT. The durable
 * state is the request row; the sign-out is a consequence of it. If it throws,
 * the deletion is still scheduled, the caller still gets its due date, and the
 * account is still closed as far as every read path is concerned — so failing
 * the request would discard a decision the reader made and correctly recorded,
 * in exchange for nothing. The residual is one stale session, which the erasure
 * sweep removes anyway. Logged loudly, never rethrown.
 */
async function revokeEverySession(userId: string): Promise<void> {
  try {
    // ⚠️ A BARE TRANSACTION, DELIBERATELY — `session` is a Better-Auth-owned
    // table with RLS DISABLED (the same set `accountErasureService` reads on the
    // singleton: `account` / `passkey` / `two_factor`). There is no policy for a
    // context to satisfy, and the delete is already keyed to `userId`. Binding
    // `app.user_id` here would suggest a gate that does not exist.
    //
    // It is a transaction at all only because the repository contract requires
    // `tx` on every write, and it is bounded by Prisma's own interactive
    // -transaction timeout — a hand-rolled deadline would duplicate that and add
    // an arm nothing can reach.
    await db.$transaction((tx) => sessionRepository.deleteAllForUser(userId, tx));
  } catch (err) {
    console.error(
      `[accountDeletion] sign-out failed for user ${userId}; the deletion is scheduled ` +
        `and its sessions are still open until the erasure sweep runs.`,
      err,
    );
  }
}

/**
 * What a cancel found. Three outcomes rather than a nullable row, because
 * *"nothing scheduled"* and *"already erased"* are opposite answers to the
 * reader, and the surface renders a different sentence for each.
 */
type CancelOutcome =
  | { outcome: 'cancelled'; request: AccountDeletionRequest }
  | { outcome: 'completed' }
  | { outcome: 'none' };

/**
 * Lock this account's latest request, re-read its status under the lock, and
 * cancel it if it is still open. The one locked transaction both DRAWN cancel
 * doors share, through {@link cancelAccountDeletion}.
 *
 * ⚠️ THE LOCK READS THE LATEST ROW, NOT THE OPEN ONE — its predicate is
 * `user_id` alone so that a cancel which LOSES the race is handed the row with
 * its new status instead of an empty result set. The repository comment on
 * `findLatestByUserIdForUpdate` carries the mechanism (under READ COMMITTED a
 * waiting `FOR UPDATE` re-evaluates its WHERE against the winner's row
 * version, so a `status = 'scheduled'` filter would drop the row it just waited
 * for). The consequence is the one that matters here: a cancel racing the
 * erasure sweep can say *"already erased"* rather than *"nothing scheduled"*.
 */
async function cancelOpenRequest(userId: string): Promise<CancelOutcome> {
  return withUserContext(userId, async (tx) => {
    const latest = await accountDeletionRequestRepository.findLatestByUserIdForUpdate(userId, tx);
    if (!latest) return { outcome: 'none' };
    if (latest.status === 'completed') return { outcome: 'completed' };
    if (latest.status !== 'scheduled') return { outcome: 'none' };

    const request = await accountDeletionRequestRepository.update(
      latest.id,
      { status: 'cancelled', cancelledAt: new Date() },
      tx,
    );
    return { outcome: 'cancelled', request };
  });
}

export const accountDeletionService = {
  /**
   * Close the account now and schedule its erasure for `requestedAt + 30 days`.
   *
   * Returns the request, whose `erasureDueAt` is the date the confirmation copy
   * and the app-wide banner interpolate — never a locally recomputed
   * `now + 30 days` (DECISION 4: the number is a published promise, held in ONE
   * constant so the promise and the behaviour cannot drift).
   *
   * @throws AccountDeletionBlockedError    the reader is an organization's last owner
   * @throws AccountDeletionAlreadyScheduledError  a request is already open
   */
  async scheduleAccountDeletion(userId: string): Promise<AccountDeletionRequestDTO> {
    // ── The block, as a READ ─────────────────────────────────────────────────
    // Outside the write transaction on purpose: it is the same verdict the pane
    // renders at rest, it takes no lock (see `accountErasureService`'s own note
    // on why a preview must not), and it fans out across one bound transaction
    // per tenant — none of which belongs inside a transaction whose whole job is
    // to be small and locked.
    //
    // The residual window is real and is the sweep's to close: an organization
    // can gain or lose an owner between this read and the write below. That is
    // an ORDINARY ordering, not a race to serialise here — a reader who becomes
    // a sole owner one second after scheduling has a deletion that the erasure
    // (MOTIR-3702) must refuse to complete, and no lock taken now could have
    // prevented it.
    const preview = await accountErasureService.previewAccountErasure(userId);
    if (preview.blocked) {
      throw new AccountDeletionBlockedError(
        preview.blockingOrganization?.name ?? 'an organization',
      );
    }

    const requestedAt = new Date();

    let created;
    try {
      created = await withUserContext(userId, async (tx) => {
        // ── Lock, re-read, then write ─────────────────────────────────────────
        // `CLAUDE.md` § 4-layer: a read that GATES a write is taken inside the
        // transaction with `FOR UPDATE`. Two cancels, or a cancel racing this,
        // are ordered by it.
        //
        // ⚠️ IT DOES NOT SERIALISE THE FIRST REQUEST, and reading its `null` as
        // "nobody else can be scheduling right now" is the specific mistake the
        // repository's own comment warns about: a `SELECT … FOR UPDATE` over a
        // predicate matching zero rows locks NOTHING, so two first-time racers
        // both fall through here together. The partial unique index
        // `account_deletion_request_open_per_user_key` is the guard on that
        // path, and the catch below is where its refusal becomes a domain error.
        const open = await accountDeletionRequestRepository.findOpenByUserIdForUpdate(userId, tx);
        if (open) throw new AccountDeletionAlreadyScheduledError();

        return accountDeletionRequestRepository.create(
          { userId, requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
          tx,
        );
      });
    } catch (err) {
      // ⚠️ CAUGHT OUTSIDE THE TRANSACTION, WHICH IS THE ONLY PLACE IT CAN BE.
      // Prisma aborts an interactive transaction on the first error, so a catch
      // wrapped around the `create` INSIDE the callback would swallow the code
      // and then run its remaining statements on a transaction Postgres has
      // already rolled back.
      if (isOpenRequestUniqueViolation(err)) throw new AccountDeletionAlreadyScheduledError();
      throw err;
    }

    // ── The side effect, after the commit ────────────────────────────────────
    // The transaction above holds the DB writes this decision consists of and
    // nothing else. Signing every device out is a CONSEQUENCE of the decision,
    // so it runs once the decision is durable and cannot take it down with it.
    await revokeEverySession(userId);

    return toAccountDeletionRequestDTO(created);
  },

  /**
   * Take the deletion back — the pane's `Cancel deletion` and the app-wide
   * banner's (both MOTIR-3704). The EXPLICIT act: somebody pressed a button, so
   * every non-cancel outcome is an error the surface must render.
   *
   * @throws NoOpenAccountDeletionRequestError    nothing is scheduled
   * @throws AccountDeletionAlreadyCompletedError the erasure has already run
   */
  async cancelAccountDeletion(userId: string): Promise<AccountDeletionRequestDTO> {
    const result = await cancelOpenRequest(userId);
    if (result.outcome === 'completed') throw new AccountDeletionAlreadyCompletedError();
    if (result.outcome === 'none') throw new NoOpenAccountDeletionRequestError();
    return toAccountDeletionRequestDTO(result.request);
  },

  /**
   * This account's open request, or `null` — what the pane renders at rest, and
   * what the app-wide banner reads on every authed request (MOTIR-3704). Since
   * MOTIR-3742 that banner is the whole of the reader's way back: nothing on
   * the sign-in path consults this any more.
   *
   * Read-only, and it still opens a transaction: `account_deletion_request` is
   * RLS-gated on `app.user_id`, a GUC only a transaction can bind. On the `db`
   * singleton the policy's predicate is NULL and the read returns ZERO ROWS
   * while raising nothing — which on this surface means telling somebody their
   * account is not being erased when it is (the repository's own warning).
   */
  async findOpenDeletion(userId: string): Promise<AccountDeletionRequestDTO | null> {
    const open = await withUserContext(userId, (tx) =>
      accountDeletionRequestRepository.findOpenByUserId(userId, tx),
    );
    return open ? toAccountDeletionRequestDTO(open) : null;
  },
};
