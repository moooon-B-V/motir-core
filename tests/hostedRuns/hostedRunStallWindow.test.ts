import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_RUN_STALL_WINDOW_MS, hostedRunStallWindowMs } from '@/lib/hostedRuns/limits';

// The stall window a hosted run's supervisor reads (MOTIR-6452). Production always
// gets the 15-minute constant; only the E2E acceptance lane — which sets BOTH the
// production-harness flag and the override — can shorten it, so its stall case does
// not wait 15 real minutes.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hostedRunStallWindowMs', () => {
  it('is the 15-minute constant outside the E2E harness, whatever the override says', () => {
    vi.stubEnv('E2E_PROD_HARNESS', '');
    vi.stubEnv('E2E_HOSTED_RUN_STALL_WINDOW_MS', '1000');
    expect(hostedRunStallWindowMs()).toBe(HOSTED_RUN_STALL_WINDOW_MS);
    expect(HOSTED_RUN_STALL_WINDOW_MS).toBe(15 * 60_000);
  });

  it('is the override under the E2E harness', () => {
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    vi.stubEnv('E2E_HOSTED_RUN_STALL_WINDOW_MS', '4000');
    expect(hostedRunStallWindowMs()).toBe(4000);
  });

  it.each([
    ['', 'unset'],
    ['abc', 'not a number'],
    ['0', 'zero'],
    ['-5', 'negative'],
  ])('falls back to the constant under the harness when the override is %j (%s)', (value) => {
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    vi.stubEnv('E2E_HOSTED_RUN_STALL_WINDOW_MS', value);
    expect(hostedRunStallWindowMs()).toBe(HOSTED_RUN_STALL_WINDOW_MS);
  });
});
