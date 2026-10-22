import { describe, expect, it } from 'vitest';
import { LARGER_POOL_REFUSALS, largerPoolRefusalFor } from '@/lib/billing/largerPoolRefusal';
import enMessages from '@/messages/en.json';

// Which `billing.plans.larger.refused.*` sentence a failed larger-pool checkout body
// names (MOTIR-8997). Pure: it reads `code`, and for motir-ai's two guard refusals the
// `<reason>:` prefix inside `error`; anything else is null, so the page's own failure
// toast answers.

describe('largerPoolRefusalFor', () => {
  it.each([
    [{ code: 'BILLING_POOL_AT_OR_BELOW_CEILING', error: 'x' }, 'atOrBelowCeiling'],
    [{ code: 'BILLING_INVALID_QUANTITY', error: 'x' }, 'quantity'],
    [{ code: 'BILLING_UNKNOWN_PRICE', error: 'x' }, 'notForSale'],
    [
      {
        code: 'MOTIR_AI_BAD_REQUEST',
        error: 'motir-ai rejected the request: plan_offer_expired: the offer moved',
      },
      'offerExpired',
    ],
    [
      {
        code: 'MOTIR_AI_BAD_REQUEST',
        error: 'motir-ai rejected the request: plan_price_drift: stripe disagrees',
      },
      'notForSale',
    ],
  ] as const)('%j → %s', (body, reason) => {
    expect(largerPoolRefusalFor(body)).toBe(reason);
  });

  it.each([
    ['another code', { code: 'BILLING_PLAN_CHANGE_REFUSED', error: 'x' }],
    ['a bad request with another detail', { code: 'MOTIR_AI_BAD_REQUEST', error: 'nope' }],
    ['a bad request with no error', { code: 'MOTIR_AI_BAD_REQUEST' }],
    ['no code', { error: 'plan_offer_expired: x' }],
    ['null', null],
    ['a string', 'BILLING_UNKNOWN_PRICE'],
  ])('%s → null', (_name, body) => {
    expect(largerPoolRefusalFor(body)).toBeNull();
  });

  it('names only sentences the catalogue carries', () => {
    expect(Object.keys(enMessages.billing.plans.larger.refused).sort()).toEqual(
      [...LARGER_POOL_REFUSALS].sort(),
    );
  });
});
