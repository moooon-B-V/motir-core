/**
 * The inbound delivery-webhook signing secret (`RESEND_WEBHOOK_SECRET`) is not
 * configured on this deployment (Bug MOTIR-3507 · Subtask MOTIR-3515). Read at
 * CALL time, so a self-hosted instance that never wires Resend cannot reach the
 * webhook path rather than crashing on boot. A server MISCONFIG (→ 500),
 * deliberately distinct from a bad signature (→ 401): without a secret we can
 * neither trust nor reject a delivery, and a silent 401 would read to the
 * operator as "Resend is signing wrong" instead of "nobody set the secret".
 *
 * Setting it is MOTIR-3518's job — a `manual` card, because the secret is
 * issued by Resend's dashboard and lives in `fly secrets`.
 */
export class ResendWebhookNotConfiguredError extends Error {
  readonly code = 'RESEND_WEBHOOK_NOT_CONFIGURED' as const;
  constructor() {
    super('Resend webhooks are not configured. Set RESEND_WEBHOOK_SECRET.');
    this.name = 'ResendWebhookNotConfiguredError';
  }
}

/**
 * A delivery's signature headers are missing, malformed, or do not match the
 * HMAC we recompute over the raw body (Bug MOTIR-3507 · Subtask MOTIR-3515).
 * The route rejects it 401 BEFORE parsing the body — an unauthentic delivery is
 * never processed. Carries no detail: this endpoint is public by necessity, and
 * there is nothing to hand an attacker probing it.
 *
 * A STALE timestamp raises this too. A captured delivery replayed later is
 * correctly signed — the signature alone cannot tell it from a fresh one — so
 * the timestamp window is the only thing standing between a recorded event and
 * an attacker rewriting a message's state with it.
 */
export class ResendWebhookSignatureError extends Error {
  readonly code = 'RESEND_WEBHOOK_INVALID_SIGNATURE' as const;
  constructor() {
    super('Resend webhook signature verification failed.');
    this.name = 'ResendWebhookSignatureError';
  }
}
