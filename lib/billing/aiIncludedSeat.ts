import { AiIncludedSeatValidationError } from '@/lib/billing/errors';

// The AI-included-seat propagation contract (Subtask 8.1.24 / MOTIR-1318) — the
// motir-core side of "a PAID Motir AI plan bundles 1 Motir seat, lifting the §4
// caps" (ADR §4, amended 2026-06-24 / 8.1.22). motir-ai's webhook (8.1.23)
// resolves whether the org holds a paid AI pool tier and POSTs the boolean here
// via its coreClient. DISTINCT from the scaled-tracker (purchased-seat) state so
// the two never clobber. The wire body is `{ organizationId, included }`.

export interface SetAiIncludedSeatInput {
  organizationId: string;
  /** True while a PAID AI plan is active (live/grace); false clears it (downgrade). */
  included: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate + narrow an untrusted inbound body into a `SetAiIncludedSeatInput`.
 * Throws `AiIncludedSeatValidationError` (→ 400) on any malformed field.
 */
export function parseSetAiIncludedSeatInput(body: unknown): SetAiIncludedSeatInput {
  if (!isObject(body)) {
    throw new AiIncludedSeatValidationError('request body must be a JSON object');
  }
  const { organizationId, included } = body;
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    throw new AiIncludedSeatValidationError('organizationId must be a non-empty string');
  }
  if (typeof included !== 'boolean') {
    throw new AiIncludedSeatValidationError('included must be a boolean');
  }
  return { organizationId, included };
}
