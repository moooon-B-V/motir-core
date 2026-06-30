import { describe, expect, it } from 'vitest';
import { validateEstimateMinutes } from '@/lib/estimation/validate';
import { InvalidEstimateError } from '@/lib/estimation/errors';

// Unit test for the shared `validateEstimateMinutes` rule (MOTIR-1433) — the
// non-negative-integer-minutes validator the plan substrate's boundary-less
// write paths (addProposals / updateProposal → materialize) call, matching the
// MCP create path's `z.number().int().nonnegative()` boundary.
describe('validateEstimateMinutes', () => {
  it('accepts null (clears the estimate)', () => {
    expect(validateEstimateMinutes(null)).toBeNull();
  });

  it('accepts a non-negative integer (incl. zero) and returns it unchanged', () => {
    expect(validateEstimateMinutes(0)).toBe(0);
    expect(validateEstimateMinutes(55)).toBe(55);
  });

  it('rejects a non-finite value', () => {
    expect(() => validateEstimateMinutes(Number.POSITIVE_INFINITY)).toThrow(InvalidEstimateError);
    expect(() => validateEstimateMinutes(Number.NaN)).toThrow(InvalidEstimateError);
  });

  it('rejects a fractional value (minutes are whole)', () => {
    expect(() => validateEstimateMinutes(12.5)).toThrow(InvalidEstimateError);
  });

  it('rejects a negative value', () => {
    expect(() => validateEstimateMinutes(-1)).toThrow(InvalidEstimateError);
  });
});
