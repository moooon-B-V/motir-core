import { describe, expect, it } from 'vitest';
import { isHostnameUniqueViolation } from '@/lib/publicAddresses/errors';

// `isHostnameUniqueViolation`, driven directly — MOTIR-5273.
//
// It read `meta.target` alone, which is ABSENT under this client, so every
// violation fell through to its last arm and the constraint check it documented
// protected nothing. It now reads the constraint the database reported through
// the shared reader. The case that proves the check is LIVE is the last one: a
// violation of some OTHER index is no longer reported as a taken hostname.

function driverP2002(constraint: string) {
  return {
    code: 'P2002',
    meta: {
      modelName: 'PublicAddress',
      driverAdapterError: {
        cause: {
          originalCode: '23505',
          originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
        },
      },
    },
  };
}

describe('isHostnameUniqueViolation', () => {
  it('recognises the hostname index from the DRIVER error — the shape this client produces', () => {
    expect(isHostnameUniqueViolation(driverP2002('public_address_hostname_key'))).toBe(true);
  });

  it('recognises it from the older `meta.target` shapes', () => {
    expect(isHostnameUniqueViolation({ code: 'P2002', meta: { target: ['hostname'] } })).toBe(true);
    expect(
      isHostnameUniqueViolation({ code: 'P2002', meta: { target: 'public_address_hostname_key' } }),
    ).toBe(true);
  });

  it('still answers true for a P2002 that names no constraint, rather than letting a raw error escape', () => {
    expect(isHostnameUniqueViolation({ code: 'P2002', meta: { modelName: 'PublicAddress' } })).toBe(
      true,
    );
  });

  it('does NOT report a different index as a taken hostname — the check is live again', () => {
    expect(isHostnameUniqueViolation(driverP2002('public_address_some_future_key'))).toBe(false);
  });

  it('ignores anything that is not a P2002', () => {
    expect(isHostnameUniqueViolation({ code: 'P2003', meta: { target: ['hostname'] } })).toBe(
      false,
    );
    expect(isHostnameUniqueViolation(new Error('boom'))).toBe(false);
    expect(isHostnameUniqueViolation(null)).toBe(false);
  });
});
