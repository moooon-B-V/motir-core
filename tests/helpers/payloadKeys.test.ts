import { describe, expect, it } from 'vitest';
import { leakedKeys, payloadKeys } from './payloadKeys';

// MOTIR-7349 — a boundary assertion scans field NAMES, never the generated ids
// in the values.

const METER_FIELD = /cost|usdPerSecond|handleId/i;

// The shape `hostedRunCharge.test.ts` asserts on, with ids that happen to spell
// the forbidden word — the case the merge queue hit at random.
const charge = {
  coreOrganizationId: 'cmurcost0001qa8xk2l4m9z7p',
  coreRunId: 'cmur8y3th0001COSTk2l4m9z7',
  credits: 3,
  billableSeconds: 91,
  externalRef: 'cmur8y3th0001COSTk2l4m9z7',
  reason: 'hosted run machine time',
  coreWorkspaceId: 'cmurcosta002qa8xk2l4m9z7p',
  coreProjectId: 'cmurz9c0st03qa8xk2l4m9z7p',
};

describe('leakedKeys', () => {
  it('passes a payload whose ids contain the forbidden word — the old serialized scan did not', () => {
    // The reproduction: the assertion the card replaced fires on this payload.
    expect(JSON.stringify(charge)).toMatch(/costUsd|usdPerSecond|handleId|cost/i);
    expect(leakedKeys(charge, METER_FIELD)).toEqual([]);
  });

  it('still catches a forbidden field, at any depth', () => {
    expect(leakedKeys({ ...charge, costUsd: 0.12 }, METER_FIELD)).toEqual(['costUsd']);
    expect(
      leakedKeys({ ...charge, meter: [{ usdPerSecond: 0.0001, handleId: 'h-1' }] }, METER_FIELD),
    ).toEqual(['usdPerSecond', 'handleId']);
  });

  it('reads the keys the wire carries, not the in-memory object', () => {
    expect(
      payloadKeys({ a: undefined, b: { toJSON: () => ({ c: 1 }) }, d: [{ e: null }] }),
    ).toEqual(['b', 'c', 'd', 'e']);
    expect(payloadKeys(undefined)).toEqual([]);
  });
});
