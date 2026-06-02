import { defineJob } from '../defineJob';
import type { EmailSendData } from '../types';

// The first PRODUCTION background job (Story 1.6 · Subtask 1.6.3): the durable
// `email.send`. Every transactional email in prodect-core flows through here.
// The request-lifecycle callers (password reset in lib/auth, workspace invites
// in workspaceInvitesService) used to render + `sendEmail()` INSIDE the HTTP
// request — so a slow or down provider stalled the request or returned a
// misleading success. Now they `sendEvent('email.send', …)` and return; this
// job does the actual delivery with retries, off the request path.
//
// The handler is deliberately tiny: it owns NO email logic. Rendering +
// dispatch live in `emailService` (the 4-layer rule — a job handler is the
// "service caller" for a background trigger, so it receives services via the
// injected bag rather than importing `@/lib/email` itself). The single
// `step.run('send', …)` makes the provider call durable across Inngest
// retries: once a step's result is persisted, a later retry of a *different*
// step won't re-run the send (no double-delivery).
//
// IDEMPOTENCY: `idempotency: 'event.data.idempotencyKey'` tells Inngest to
// dedup same-key events inside its window (callers pass the reset token / the
// invite token). So a retried Server Action that re-fires the same send
// collapses to one delivery. This is event-level dedup enforced by the Inngest
// runtime (validated on the dev-server / cloud surfaces in 1.6.1) — the
// in-process unit harness runs the handler directly and does NOT simulate it,
// so the unit tests assert the WIRING (the config carries the expression) +
// the caller contract (the key is supplied), not the runtime drop. See
// docs/jobs.md → "Canonical job: email.send".

/** The CEL expression Inngest evaluates against the event to dedup sends. */
export const EMAIL_SEND_IDEMPOTENCY = 'event.data.idempotencyKey';

export const emailSend = defineJob(
  // `retryPolicy: 'transient'` (1.6.4): a transactional-email send fails on
  // transient provider/network blips, so a few attempts with backoff is the
  // right intent. The idempotency key (the reset / invite token) keeps a retried
  // Server Action that re-fires the same send from double-delivering.
  { id: 'email.send', retryPolicy: 'transient', idempotency: EMAIL_SEND_IDEMPOTENCY },
  async (ctx, services) => {
    // `event.data` is typed loosely on the shared JobContext; narrow it to the
    // email payload (the map in types.ts is the source of truth for the shape).
    // EmailSendData = TransactionalEmail & { workspaceId, idempotencyKey }, so
    // `payload` is itself a valid TransactionalEmail (the envelope fields are
    // just ignored by the service) — no per-field rebuild, no cast needed.
    const payload = ctx.event.data as EmailSendData;
    return ctx.step.run('send', async () => {
      await services.email.send(payload);
      return { to: payload.to, template: payload.template };
    });
  },
);
