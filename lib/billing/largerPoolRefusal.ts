// Why a larger-pool purchase was refused, as the sentence key the Calculator's offer
// shows (MOTIR-8997 · design/billing § "Amendment 2026-10-21 — the larger credit pool
// plan", panel 8). Pure: it reads a failed checkout's JSON body and names one of the
// four `billing.plans.larger.refused.*` sentences, or `null`.
//
// It reads the body's `code` and, for the two refusals motir-ai's checkout guard
// raises (MOTIR-8995), the `<reason>:` prefix its detail carries inside `error`. It
// never RENDERS `error`: the sentence is always the catalogue's. Anything it does not
// recognise is `null`, so the caller falls back to the shipped generic failure.

export const LARGER_POOL_REFUSALS = [
  'atOrBelowCeiling',
  'offerExpired',
  'quantity',
  'notForSale',
] as const;

export type LargerPoolRefusal = (typeof LARGER_POOL_REFUSALS)[number];

// motir-ai's guard prefixes, as its `validation_error` detail opens them.
const BOUNDARY_PREFIXES: ReadonlyArray<readonly [string, LargerPoolRefusal]> = [
  ['plan_offer_expired:', 'offerExpired'],
  ['plan_price_drift:', 'notForSale'],
];

export function largerPoolRefusalFor(payload: unknown): LargerPoolRefusal | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as { code?: unknown; error?: unknown };
  switch (body.code) {
    case 'BILLING_POOL_AT_OR_BELOW_CEILING':
      return 'atOrBelowCeiling';
    case 'BILLING_INVALID_QUANTITY':
      return 'quantity';
    case 'BILLING_UNKNOWN_PRICE':
      return 'notForSale';
    case 'MOTIR_AI_BAD_REQUEST': {
      const error = typeof body.error === 'string' ? body.error : '';
      return BOUNDARY_PREFIXES.find(([prefix]) => error.includes(prefix))?.[1] ?? null;
    }
    default:
      return null;
  }
}
