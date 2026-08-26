import { Prisma, type EmailDelivery } from '@/generated/prisma/client';
import { emailDeliveryRepository } from '@/lib/repositories/emailDeliveryRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// Business logic for the transactional-mail delivery record (Bug MOTIR-3507 ·
// Subtask MOTIR-3513). Owns the transaction, exactly as `jobRunsService` owns
// the job ledger's.
//
// SYSTEM-ADMIN CONTEXT: the write opens its transaction through
// `withSystemContext`, which binds `app.system_admin = 'true'`. The send runs
// inside the `email.send` job, OUTSIDE any HTTP request, so there is no active
// workspace context; the `email_delivery` policy's system-admin branch is what
// lets this INSERT land under the non-bypass `motir_app` role in production
// (in dev/CI the superuser bypasses RLS regardless, so it is a no-op there).
// The READ path — the operator dashboard, MOTIR-3517 — will use
// `withWorkspaceContext` instead, so a tenant sees only its own rows.
//
// ⚠️ EVERY FAILURE HERE IS SWALLOWED, AND THAT IS THE POINT. By the time this
// is called the provider has ALREADY ACCEPTED the message. This is a record of
// something that happened, not a step in making it happen — so a failure to
// write it must never fail the send, because the job's retry would re-deliver
// an email that is already on its way. The rule is `CLAUDE.md`'s
// side-effects-outside-the-transaction contract, applied one layer up: commit
// the real work, then record, and degrade gracefully if recording fails.

export interface RecordAcceptedInput {
  /** The provider's own id for the message, or null when it issued none. */
  providerMessageId: string | null;
  /** Which provider took it — `resend`, `console`, `file`. */
  provider: string;
  recipient: string;
  /** The `TransactionalEmail` discriminant this message was rendered from. */
  template: string;
  /** Null for a cross-workspace / system email (a password reset). */
  workspaceId: string | null;
  /** The send's dedup key — the lane-independent join back to the job run. */
  idempotencyKey?: string | null;
  /** `job_queue.id` on the Postgres engine, an Inngest run id on that lane. */
  runId?: string | null;
  /** The triggering event's id, same lane caveat as `runId`. */
  eventId?: string | null;
}

/**
 * A delivery write whose tenant vanished under it — the workspace was deleted
 * between the send and the record (in production a hard tenant deletion; in
 * the E2E harness a between-test `TRUNCATE ... CASCADE` a still-in-flight job
 * outlives). The FK trips as Prisma `P2003`. Not an error worth surfacing: the
 * mail went out, and there is no longer a tenant to show the row to.
 */
function isVanishedTenantError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

/** The unique index on `provider_message_id` rejected a duplicate. */
function isDuplicateMessageError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export const emailDeliveryService = {
  /**
   * Record a message the provider accepted, at state `accepted`.
   *
   * Returns the row, or `null` when nothing was written — which happens for
   * three reasons, none of them a problem worth propagating:
   *   - the provider deduped a RETRIED send to a message we already hold a row
   *     for (the unique index rejects; the existing row is returned instead);
   *   - the owning workspace was deleted between the send and this write;
   *   - anything else went wrong writing a record of an email that has already
   *     been accepted.
   */
  async recordAccepted(input: RecordAcceptedInput): Promise<EmailDelivery | null> {
    try {
      return await withSystemContext((tx) =>
        emailDeliveryRepository.create(
          {
            providerMessageId: input.providerMessageId,
            provider: input.provider,
            recipient: input.recipient,
            template: input.template,
            // Scalar FK (not a relation connect) — see the repository.
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey ?? null,
            runId: input.runId ?? null,
            eventId: input.eventId ?? null,
          },
          tx,
        ),
      );
    } catch (err) {
      // A retried attempt the provider deduped to the same message: the row is
      // already there, and returning it is more useful than a null.
      if (isDuplicateMessageError(err) && input.providerMessageId !== null) {
        try {
          return await withSystemContext((tx) =>
            emailDeliveryRepository.findByProviderMessageId(input.providerMessageId!, tx),
          );
        } catch {
          return null;
        }
      }
      if (isVanishedTenantError(err)) return null;
      // Anything else: the email is sent. Losing its record is a degradation,
      // never a reason to fail — or retry — a delivery that already happened.
      console.error('[email] failed to record delivery for an accepted message', err);
      return null;
    }
  },
};
