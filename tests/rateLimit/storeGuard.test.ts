import { describe, expect, it } from 'vitest';
import {
  assertRateLimitStoreAllowed,
  MemoryRateLimitStoreRefusedError,
  RATE_LIMIT_STORE_ENV,
} from '@/lib/rateLimit/storeGuard';
import * as store from '@/lib/rateLimit/store';

// The boot guard on the `memory` rate-limit store (MOTIR-8614). A pure function
// of the env it is handed, so the table needs no database and no process.env
// mutation.

describe('assertRateLimitStoreAllowed', () => {
  it.each(['memory', 'MEMORY', ' Memory ', ' memory '])(
    'refuses a production build with %j',
    (value) => {
      const call = () =>
        assertRateLimitStoreAllowed({ NODE_ENV: 'production', [RATE_LIMIT_STORE_ENV]: value });
      expect(call).toThrow(MemoryRateLimitStoreRefusedError);
      expect(call).toThrow(/MOTIR_RATE_LIMIT_STORE/);
      expect(call).toThrow(/postgres/);
    },
  );

  it.each<[string, Record<string, string | undefined>]>([
    ['production + postgres', { NODE_ENV: 'production', [RATE_LIMIT_STORE_ENV]: 'postgres' }],
    ['production + unset', { NODE_ENV: 'production' }],
    ['production + empty', { NODE_ENV: 'production', [RATE_LIMIT_STORE_ENV]: '' }],
    ['test + memory', { NODE_ENV: 'test', [RATE_LIMIT_STORE_ENV]: 'memory' }],
    ['development + memory', { NODE_ENV: 'development', [RATE_LIMIT_STORE_ENV]: 'memory' }],
    ['no NODE_ENV + memory', { [RATE_LIMIT_STORE_ENV]: 'memory' }],
  ])('allows %s', (_label, env) => {
    expect(() => assertRateLimitStoreAllowed(env)).not.toThrow();
  });

  it('names itself, like UnknownRateLimitBackendError', () => {
    expect(new MemoryRateLimitStoreRefusedError('memory').name).toBe(
      'MemoryRateLimitStoreRefusedError',
    );
  });

  it('is reachable from lib/rateLimit/store.ts, where the store is chosen', () => {
    expect(store.assertRateLimitStoreAllowed).toBe(assertRateLimitStoreAllowed);
    expect(store.RATE_LIMIT_STORE_ENV).toBe('MOTIR_RATE_LIMIT_STORE');
  });
});
