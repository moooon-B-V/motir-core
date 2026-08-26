import type { EmailDeliveryState } from '@/generated/prisma/client';
import { emailDeliveryRepository } from '@/lib/repositories/emailDeliveryRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// The Resend delivery webhook's business logic (Bug MOTIR-3507 · Subtask
// MOTIR-3515). The route verifies the signature and hands the parsed body
// here; ALL logic lives in this file (the 4-layer rule — the route is HTTP
// only, exactly as `githubWebhookService` is to its route).
//
// SYSTEM-ADMIN CONTEXT: an inbound webhook has no session and no active
// workspace — Resend is not a tenant — and the row it moves may be untenanted
// anyway (a password-reset delivery). `withSystemContext` binds
// `app.system_admin = 'true'`, which is the `email_delivery` policy's other
// branch. This is the same argument `jobRunsService` makes for the ledger.

/** The provider event names this endpoint subscribes to, mapped to our state. */
const EVENT_STATE: Readonly<Record<string, EmailDeliveryState>> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'delayed',
};

/**
 * How far along a message's life each state sits. A transition is applied only
 * when it moves FORWARD, which is what makes the endpoint safe against the two
 * things a webhook always does: deliver out of order, and deliver twice.
 *
 * The order is not arbitrary and the interesting entry is `complained`:
 *
 *   - `accepted` is where every row starts — the provider took the POST.
 *   - `delayed` is a deferral, so it may still become anything.
 *   - `delivered` outranks `delayed`, because a `delivery_delayed` event that
 *     arrives after the message actually landed must not un-deliver it. That is
 *     the common out-of-order case, not a hypothetical: Resend emits the delay
 *     while retrying and the delivery moments later, and the two race.
 *   - `complained` outranks `delivered` DELIBERATELY. A spam complaint arrives
 *     hours or days after a successful delivery — the recipient has to open the
 *     mail to complain about it — so "delivered, then complained" is the normal
 *     sequence and the more important fact of the two.
 *   - `bounced` sits between them as a terminal failure. A bounce and a
 *     complaint are mutually exclusive in practice, so their relative order
 *     only decides which wins if a provider ever sent both; the complaint does,
 *     because it is the one a human performed.
 */
const STATE_RANK: Readonly<Record<EmailDeliveryState, number>> = {
  accepted: 0,
  delayed: 1,
  delivered: 2,
  bounced: 3,
  complained: 4,
};

/** What became of one delivery event — the route logs it, nothing more. */
export type ResendWebhookOutcome =
  | { outcome: 'applied'; state: EmailDeliveryState }
  /** We hold no row for this message id. Acked, not an error — see below. */
  | { outcome: 'unknown_message' }
  /** The row is already at or past this state (a duplicate or a late event). */
  | { outcome: 'not_newer'; state: EmailDeliveryState }
  /** An event type we do not subscribe to, or a body without a message id. */
  | { outcome: 'ignored' };

/** The fields we read off a delivery. Everything else in the body is ignored. */
interface ResendWebhookPayload {
  type?: unknown;
  data?: { email_id?: unknown } | null;
}

function messageIdOf(payload: ResendWebhookPayload): string | null {
  const id = payload.data?.email_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

export const resendWebhookService = {
  /**
   * Apply one verified delivery event.
   *
   * ⚠️ EVERY BRANCH HERE ANSWERS 2xx AT THE ROUTE, INCLUDING THE ONES THAT DO
   * NOTHING. A webhook receiver that returns an error makes the provider retry,
   * and there is no number of retries that will make us hold a row we do not
   * hold — so an unknown message id acks and drops rather than 404s. The
   * alternative is a message retrying against us until Resend disables the
   * endpoint, which would cost us the events we DO care about.
   *
   * Legitimately unknown ids are ordinary, not a defect: every message sent
   * before MOTIR-3513 shipped has no row, and a `console`/`file` provider send
   * never had a provider id at all.
   */
  async handleEvent(payload: ResendWebhookPayload): Promise<ResendWebhookOutcome> {
    const type = typeof payload.type === 'string' ? payload.type : '';
    const next = EVENT_STATE[type];
    const providerMessageId = messageIdOf(payload);
    if (next === undefined || providerMessageId === null) return { outcome: 'ignored' };

    return withSystemContext(async (tx) => {
      // Lock first: two events for one message can arrive concurrently, and the
      // rank comparison below is a read-then-write that races without the lock
      // (CLAUDE.md's concurrency rule).
      const existing = await emailDeliveryRepository.lockByProviderMessageId(providerMessageId, tx);
      if (existing === null) return { outcome: 'unknown_message' };

      if (STATE_RANK[next] <= STATE_RANK[existing.state]) {
        return { outcome: 'not_newer', state: existing.state };
      }

      await emailDeliveryRepository.updateState(
        existing.id,
        { state: next, lastEventAt: new Date() },
        tx,
      );
      return { outcome: 'applied', state: next };
    });
  },
};
