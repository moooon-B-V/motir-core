import type { AccountDeletionRequest } from '@/generated/prisma/client';
import { deleteAttachmentBlob } from '@/lib/blob/uploader';
import { accountRepository } from '@/lib/repositories/accountRepository';
import { accountDeletionRequestRepository } from '@/lib/repositories/accountDeletionRequestRepository';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { dataExportRequestRepository } from '@/lib/repositories/dataExportRequestRepository';
import { deviceCodeRepository } from '@/lib/repositories/deviceCodeRepository';
import { emailChangeRequestRepository } from '@/lib/repositories/emailChangeRequestRepository';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { passkeyRepository } from '@/lib/repositories/passkeyRepository';
import { sessionRepository } from '@/lib/repositories/sessionRepository';
import { twoFactorRepository } from '@/lib/repositories/twoFactorRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { accountErasureService } from '@/lib/services/accountErasureService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ERASED_USER_NAME, erasedEmailFor, erasureResumeFloor } from '@/lib/users/accountErasure';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';

// THE ERASURE SWEEP (Story 8.4 · Subtask MOTIR-3702) — the job that actually
// keeps the promise. `motir.co/legal/privacy` §6 tells every user *"we erase
// or anonymise within 30 days"*; MOTIR-3700 writes the request and MOTIR-3699
// shows them what it will reach. This is the only code in the product that
// makes the sentence true, and the only code that can make it false in a way
// nobody notices.
//
// Design of record: `design/settings/design-notes.md` → `Data & privacy` →
// DECISION 3, whose three groups this file executes in order.
//
// ── DELETED · ANONYMISED · KEPT ─────────────────────────────────────────────
//
// **DELETED — what is theirs alone.** Every credential and every piece of
// personal auth substrate (`account` · `session` · `passkey` · `two_factor` ·
// `api_token` · `github_identity` · `device_code` · `email_change_request`),
// **every personal-data export they ever asked for** (`data_export_request`,
// and the archive each one built), their memberships, and every workspace they
// are the ONLY member of.
//
// ⚠️ The card names *"credentials, sessions, passkeys, two-factor enrolment,
// API tokens"*. This reads **credentials** as the CLASS rather than the
// `account` table alone, so it also takes the GitHub OAuth identity (which
// holds an encrypted user token), in-flight `motir login` device grants, and
// pending email-change tokens. A live credential outlasting the account it
// authenticates is a security defect, not a scope question — and none of the
// three is reachable from any surface that would have surfaced the omission.
//
// ⚠️ AND THE EXPORT IS IN THE GROUP FOR A DIFFERENT REASON: IT IS THE ARCHIVE
// (Bug MOTIR-3732). Everything else in the DELETED group is a fragment; the
// export is the copy of EVERYTHING, built to contain it (DECISION 1: *"the
// user's own account and profile, plus the workspaces they are a member of"*).
// It reached this file late because it did not exist when the group was
// written: MOTIR-3701 shipped the table AFTER MOTIR-3702's card was authored,
// so the DELETED group named what it could see. The composition is what was
// wrong — a reader who exported and then deleted kept a downloadable archive
// for the archive's full `DATA_EXPORT_RETENTION_DAYS` after the erasure
// reported `completed`. Neither the FK cascade nor the expiry sweep is a second
// chance: the cascade is `ON DELETE CASCADE` on a `user` row this sweep
// deliberately never deletes, and `listExpirable` selects `ready` rows past
// their `expiresAt` — erasure is not one of its triggers.
//
// **The generalisable half, and the reason a reader is being told rather than
// shown:** every NEW table keyed to `user_id` is a new obligation on this
// group, and nothing in the schema enforces it — precisely because the
// anonymise-in-place decision makes the cascades inert for this population. The
// coverage is a decision somebody keeps making, not a property the database
// maintains.
//
// **ANONYMISED — what is part of someone else's project.** Not a per-table
// walk. Every surface renders a person through `user.name` / `user.email` /
// `user.image`, so the profile row is scrubbed in place and every attribution
// loses its name at once — comments and work items in shared workspaces
// included, and every table nobody thought to enumerate. That totality is the
// point: an enumeration is a list that goes stale, and its failure mode is a
// silent PASS. `lib/users/accountErasure.ts` carries the full argument,
// including the four NOT NULL `Restrict` foreign keys that make deleting the
// row impossible for precisely this population.
//
// **KEPT — what erasure does not reach.** Invoices, tax records, and data in an
// unrotated backup. **This branch does nothing, by design.** Article 17 is not
// absolute, `ACCOUNT_ERASURE_KEPT_EXCEPTIONS` is the ledger copy that says so,
// and the group is named here so a reader can tell a decision from an omission.
// In motir-core the billing substrate is ORGANIZATION-scoped
// (`Organization.scaledTrackerSubscription`, the `Ci*Usage` / `CiPeriodCharge`
// meters) — nothing about it is keyed to a user, so it survives by construction
// and the sweep never names it.
//
// ── SYSTEM-scoped, like every other retention sweep ────────────────────────
// The due set spans users and tenants, so the SELECT runs under
// `withSystemContext` (`account_deletion_request_owner_or_system` is the arm
// that admits it) and the ledger row is untenanted. Each user's erasure then
// runs under `withUserContext`, because the tables it writes gate on
// `app.user_id` and NOT on `app.system_admin` — `workspace_membership` and
// `organization_membership` have no system arm at all, so a system-bound
// DELETE there would remove zero rows and raise nothing.

/** How many requests one tick erases. The residue is the next tick's. */
export const ACCOUNT_ERASURE_SWEEP_BATCH_SIZE = 25;

/** What happened to one request. */
export type ErasureOutcome =
  /** The erasure ran: the account is anonymised and the request is `completed`. */
  | 'erased'
  /** A `completed` request whose post-commit workspace deletes were finished off. */
  | 'resumed'
  /** The request was cancelled (or already completed) under the lock — see below. */
  | 'skipped'
  /** The reader is the last owner of a SHARED organization; left `scheduled`. */
  | 'blocked';

/** One tick's report — the job's return value, persisted on its `job_run` row. */
export interface AccountErasureSweepSummary {
  scanned: number;
  erased: number;
  resumed: number;
  skipped: number;
  blocked: number;
  failed: number;
  /** Sole-membership workspaces deleted across the whole tick. */
  workspacesDeleted: number;
  /** `data_export_request` rows deleted across the whole tick (MOTIR-3732). */
  exportsDeleted: number;
  /**
   * One entry per built archive whose BLOB delete failed, by EXPORT REQUEST id
   * — never by pathname, which embeds the user id (see `failures` below for the
   * same rule).
   *
   * ⚠️ NOTHING RETRIES THESE, which is why the list exists at all. The row is
   * deleted inside the erasure transaction and the blob delete happens after it
   * commits, so by the time one fails there is no row left for a later tick to
   * re-derive it from — the resume arm correctly finds an empty set. This list
   * is therefore the ONLY record that an object was stranded in the store, and
   * a non-empty one is an operator action, not a statistic.
   */
  exportBlobFailures: Array<{ exportRequestId: string; error: string }>;
  /**
   * One entry per request that threw, by REQUEST id — never by user id or
   * address. A failure line on an operator dashboard is not a place to put the
   * personal data an erasure exists to remove.
   */
  failures: Array<{ requestId: string; error: string }>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One built archive the erasure transaction removed the row for, and whose
 *  blob the post-commit step therefore owes a delete. */
interface ErasedExportBlob {
  /** The `data_export_request` id — what a failure is reported by. */
  requestId: string;
  pathname: string;
}

/** What the erasure transaction hands back to the post-commit steps. */
interface ErasureTxResult {
  outcome: ErasureOutcome;
  exportsDeleted: number;
  /** Empty on `resumed` and `skipped` — see below. */
  exportBlobs: ErasedExportBlob[];
}

/**
 * Erase ONE account: the locked transaction, then the archives, then the
 * workspaces.
 *
 * ⚠️ THE LOCK IS WHAT MAKES A DAY-29 CANCEL STICK, AND ITS SPAN IS THE WHOLE
 * DESIGN. `cancelOpenRequest` (`accountDeletionService`) takes a `FOR UPDATE`
 * on the same request row, so a cancel arriving while this transaction is open
 * BLOCKS on it and then re-reads the row this transaction left behind. Every
 * destructive write below therefore sits behind one re-read of the status taken
 * under that lock: a cancel that lands before it wins outright (nothing has been
 * touched), and one that lands after it is answered *"already erased"* — which
 * is exactly the third outcome `cancelAccountDeletion` was built to return.
 * There is no window between them.
 *
 * ⚠️ AND THE WORKSPACES ARE DELIBERATELY OUTSIDE IT — POST-COMMIT, LAST.
 * `workspacesService.deleteWorkspace` opens its own transactions and fires its
 * own `workspace_deleted` offboarding enqueue, so it cannot be nested inside
 * this one (`lib/workspaces/context.ts`: *"Never open a second"*). Running it
 * AFTER the commit is what keeps the cancel window at zero — by the time it
 * runs, the request is already `completed` and no cancel can arrive. The cost
 * is that a crash in between leaves a `completed` request with its workspaces
 * standing, which is what `findDueOrResumable`'s second arm exists to finish.
 *
 * EVERY MEMBERSHIP is held back from the transaction for the same reason, and
 * that ordering is FORCED: `deleteWorkspace` opens with `assertMembership`,
 * which resolves through the ORGANIZATION tier (6.10.4 — a stale workspace
 * membership with no org membership is DENIED). Dropping either tier first
 * makes the workspace deletes refuse. So they are erasure's last act, after
 * the account is already credential-less and anonymised and can no longer use
 * them for anything.
 *
 * ⚠️ AND THE EXPORT ARCHIVES SIT OUTSIDE IT FOR THE SAME REASON AND RUN FIRST
 * OF THE TWO (Bug MOTIR-3732). Deleting a blob is an external side effect with
 * no rollback, so it may not happen where a later statement — or the day-29
 * cancel winning under the lock — could still undo the row it belongs to. It
 * runs BEFORE the workspace loop because that loop THROWS on failure, and by
 * then the export rows are already gone: a throw ahead of the blob deletes
 * would skip them permanently rather than deferring them to a later tick.
 */
async function eraseOneAccount(
  request: AccountDeletionRequest,
  now: Date,
): Promise<{
  outcome: ErasureOutcome;
  workspacesDeleted: number;
  exportsDeleted: number;
  exportBlobFailures: Array<{ exportRequestId: string; error: string }>;
}> {
  const userId = request.userId;

  // ── The impact read, OUTSIDE any transaction ──────────────────────────────
  // It fans out across one bound transaction per tenant (its own comment says
  // why no single binding can express that), so it cannot join the erasure's.
  // It answers both questions this run needs: whether the erasure is BLOCKED,
  // and which workspaces the reader is the only member of.
  const preview = await accountErasureService.previewAccountErasure(userId);
  const soleMemberWorkspaceIds = preview.deleted.soleMemberWorkspaces.map((w) => w.id);

  // ── The block, RE-CHECKED at erasure time ─────────────────────────────────
  // `scheduleAccountDeletion` refuses the last owner of a SHARED organization,
  // and its own comment hands this case to this job in as many words: *"a
  // reader who becomes a sole owner one second after scheduling has a deletion
  // that the erasure (MOTIR-3702) must refuse to complete."* Thirty days is a
  // long time for an ownership to move.
  //
  // The request stays `scheduled`, so it is due again on every later tick and
  // completes by itself the moment somebody else takes the owner role. That is
  // the only correct answer: `assertNotLastOwner` is structural — an org may
  // not drop to zero owners — so there is nothing the sweep could do instead.
  // The `blocked` count is what makes the wait visible rather than silent.
  //
  // NOT re-checked on the RESUME arm: that request is already `completed`, the
  // point of no return is behind it, and refusing there would strand the
  // leftover workspaces for ever.
  if (request.status === 'scheduled' && preview.blocked) {
    return { outcome: 'blocked', workspacesDeleted: 0, exportsDeleted: 0, exportBlobFailures: [] };
  }

  const txResult: ErasureTxResult =
    request.status === 'completed'
      ? // ⚠️ THE RESUME ARM CARRIES NO EXPORTS, and that is the idempotence
        // rather than an omission. The rows went with the erasure transaction
        // that committed on the first pass, so a second pass over the same
        // account re-derives an EMPTY set — exactly as it re-derives an empty
        // sole-membership workspace set. Nothing is re-deleted and nothing
        // raises. The cost of that shape is the stranded blob the summary's
        // `exportBlobFailures` exists to name.
        { outcome: 'resumed', exportsDeleted: 0, exportBlobs: [] }
      : await withUserContext(userId, async (tx): Promise<ErasureTxResult> => {
          // ── LOCK, THEN RE-READ ────────────────────────────────────────────
          // The row was SELECTed in an earlier, already-committed transaction;
          // a cancel may have landed since. `findOpenByUserIdForUpdate` filters
          // on `status = 'scheduled'`, so a `null` here means precisely "not
          // open any more" — cancelled, or completed by a concurrent tick.
          // Nothing below runs in that case.
          const open = await accountDeletionRequestRepository.findOpenByUserIdForUpdate(userId, tx);
          if (!open) return { outcome: 'skipped', exportsDeleted: 0, exportBlobs: [] };

          // ── DELETED: credentials and personal auth substrate ──────────────
          await accountRepository.deleteAllForUser(userId, tx);
          await sessionRepository.deleteAllForUser(userId, tx);
          await passkeyRepository.deleteAllForUser(userId, tx);
          await twoFactorRepository.deleteByUserId(userId, tx);
          // The enrolment row and its flag are cleared together, in one
          // transaction — the pair `setTwoFactorEnabled` exists for, and the
          // column's only write (`twoFactorPredicateOneImplementation`).
          await userRepository.setTwoFactorEnabled(userId, false, tx);
          await apiTokenRepository.deleteAllForUser(userId, tx);
          await githubIdentityRepository.deleteByUserId(userId, tx);
          await deviceCodeRepository.deleteAllForUser(userId, tx);
          await emailChangeRequestRepository.deleteAllForUser(userId, tx);

          // ── DELETED: every personal-data export (Bug MOTIR-3732) ──────────
          // The ROW goes here, in the transaction, so it is gone the instant
          // the erasure commits and no cancel-window state can leave it
          // half-erased. Its BLOB cannot: deleting an object is an external
          // side effect with no rollback, so it waits for the commit — the
          // position `deleteWorkspace` takes below, for the same reason.
          //
          // Read the pathnames BEFORE the delete: `deleteMany` answers with a
          // count, not with the rows, and after it there is nothing left to ask.
          const exports = await dataExportRequestRepository.listByUserId(userId, tx);
          // A `preparing` row has no blob yet and a `failed` / `expired` one no
          // longer has one — but the ROW still goes, because it carries this
          // person's `user_id` either way.
          const exportBlobs: ErasedExportBlob[] = exports
            .filter((row): row is { id: string; blobPathname: string } => row.blobPathname !== null)
            .map((row) => ({ requestId: row.id, pathname: row.blobPathname }));
          const exportsDeleted = await dataExportRequestRepository.deleteAllForUser(userId, tx);

          // ── ANONYMISED: the profile row every attribution reads through ───
          await userRepository.anonymise(
            userId,
            {
              name: ERASED_USER_NAME,
              email: erasedEmailFor(userId),
              emailVerified: false,
              image: null,
              lastActiveProjectId: null,
              platformRole: null,
              suspendedAt: null,
              suspendedReason: null,
            },
            tx,
          );

          // ── The record that it happened ───────────────────────────────────
          await accountDeletionRequestRepository.update(
            open.id,
            { status: 'completed', completedAt: now },
            tx,
          );
          return { outcome: 'erased', exportsDeleted, exportBlobs };
        });

  const { outcome, exportsDeleted, exportBlobs } = txResult;

  if (outcome === 'skipped') {
    return { outcome, workspacesDeleted: 0, exportsDeleted: 0, exportBlobFailures: [] };
  }

  // ── DELETED: the archives themselves — POST-COMMIT, AND FIRST ─────────────
  // ⚠️ FIRST among the post-commit steps, deliberately. The workspace loop
  // below THROWS on failure (that is what `findDueOrResumable`'s resume arm
  // exists to finish), and a throw there would skip this step — permanently,
  // because the rows it derives from are already gone. Ordering it ahead costs
  // nothing: an archive is not a precondition for anything below it.
  //
  // ⚠️ AND BEST-EFFORT, because the account must still be erased. A blob store
  // that is unreachable for thirty seconds must not un-erase somebody, and it
  // must not leave a `data_export_request` row standing to claim the archive is
  // still theirs to download — the row is already gone. What is owed is the
  // RECORD, and it goes in the summary by export-request id.
  const exportBlobFailures: Array<{ exportRequestId: string; error: string }> = [];
  for (const blob of exportBlobs) {
    try {
      await deleteAttachmentBlob(blob.pathname);
    } catch (err) {
      exportBlobFailures.push({ exportRequestId: blob.requestId, error: errorText(err) });
      console.error(
        `[accountErasure] the archive for export request ${blob.requestId} could not be ` +
          'deleted; its row is gone, so no later tick will retry it.',
      );
    }
  }

  // ── DELETED: the workspaces that go with the account ──────────────────────
  // ⚠️ THROUGH `deleteWorkspace`, AND THAT IS A CONTRACT RATHER THAN A STYLE
  // CHOICE. That method enqueues the `workspace_deleted` code-graph offboarding
  // reason, and — the ordering trap — enumerates the project ids BEFORE the
  // cascade takes them. `CodeGraphOffboardReason` is a closed four-member set
  // and `docs/decisions/code-graph-index-fleet.md` §14.1 is explicit that the
  // FK cascade makes an unenqueued delete WORSE, because it removes the only
  // inventory naming the snapshot keys. Reaching these rows any other way would
  // owe a fifth reason plus that ordering; this run takes the existing path and
  // owes neither. Deleting a workspace here is not an escalation: DECISION 3
  // records that `deleteWorkspace` asserts membership and checks no role, so
  // the sole member has always been allowed to do exactly this.
  let workspacesDeleted = 0;
  for (const workspaceId of soleMemberWorkspaceIds) {
    await workspacesService.deleteWorkspace({ workspaceId, actorUserId: userId });
    workspacesDeleted += 1;
  }

  // ── DELETED: the tenants they no longer belong to — LAST, and it has to be ─
  // ⚠️ THE MEMBERSHIPS CANNOT GO IN THE TRANSACTION ABOVE, and the reason is a
  // gate rather than tidiness. `deleteWorkspace` opens with `assertMembership`,
  // which resolves through the ORGANIZATION tier (Story 6.10.4: *"a user with a
  // stale workspace membership but no org membership is DENIED"*), so removing
  // either tier before the loop above makes every one of those deletes refuse —
  // leaving standing exactly the workspaces DECISION 3 says go with the account.
  //
  // Running them after the commit is safe because the account is already
  // credential-less and anonymised by then: it cannot act on a membership it
  // still nominally holds. And `deleteMany` is idempotent, so the resume arm
  // re-runs this step with nothing to do.
  await withUserContext(userId, async (tx) => {
    await workspaceMembershipRepository.deleteAllByUser(userId, tx);
    await organizationMembershipRepository.deleteAllByUser(userId, tx);
  });

  return { outcome, workspacesDeleted, exportsDeleted, exportBlobFailures };
}

export const accountErasureSweepService = {
  /**
   * Erase every account whose grace period has run out.
   *
   * IDEMPOTENT AND RESUMABLE BY CONSTRUCTION, on both arms. A re-run re-derives
   * everything it acts on rather than replaying a plan: an erased account's
   * request no longer matches the `scheduled` arm, its `deleteMany`s match zero
   * rows, its sole-membership workspaces are gone from the impact read, and its
   * export set is re-derived EMPTY because those rows went with the first
   * commit — so a second pass over the same row does nothing and raises
   * nothing.
   *
   * ⚠️ ONE USER'S FAILURE MUST NOT ABORT THE BATCH, and the reason is the shape
   * of the queue rather than politeness: the rows are ordered by deadline, so an
   * account that throws on every tick would otherwise hold every account behind
   * it past the published 30 days indefinitely. Each failure is caught, counted
   * and logged with its request id, and the loop continues; that request stays
   * `scheduled` and is retried on the next tick.
   *
   * `now` is injectable so a test owns the clock rather than asserting a window
   * around wall-clock (the `offboardDueAt` precedent).
   */
  async sweep(now: Date = new Date()): Promise<AccountErasureSweepSummary> {
    const due = await withSystemContext((tx) =>
      accountDeletionRequestRepository.findDueOrResumable(
        { now, resumeFloor: erasureResumeFloor(now), take: ACCOUNT_ERASURE_SWEEP_BATCH_SIZE },
        tx,
      ),
    );

    const summary: AccountErasureSweepSummary = {
      scanned: due.length,
      erased: 0,
      resumed: 0,
      skipped: 0,
      blocked: 0,
      failed: 0,
      workspacesDeleted: 0,
      exportsDeleted: 0,
      exportBlobFailures: [],
      failures: [],
    };

    for (const request of due) {
      try {
        const { outcome, workspacesDeleted, exportsDeleted, exportBlobFailures } =
          await eraseOneAccount(request, now);
        summary[outcome] += 1;
        summary.workspacesDeleted += workspacesDeleted;
        summary.exportsDeleted += exportsDeleted;
        summary.exportBlobFailures.push(...exportBlobFailures);
      } catch (err) {
        summary.failed += 1;
        summary.failures.push({ requestId: request.id, error: errorText(err) });
        console.error(
          `[accountErasure] request ${request.id} failed; it stays due and will be retried.`,
          err,
        );
      }
    }

    return summary;
  },
};
