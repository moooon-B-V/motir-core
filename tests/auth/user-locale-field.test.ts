import { describe, expect, it } from 'vitest';
import { authOptions } from '@/lib/auth';

// Story MOTIR-7730 · MOTIR-7743 — the saved language is a Better-Auth additional
// field the session carries, and NO client body may set it (`input: false`): the
// writes are the product's own (the Settings choice and the sign-up seed).
describe('user.locale additional field', () => {
  it('is declared optional, string-typed and not client-writable', () => {
    expect(authOptions.user?.additionalFields?.['locale']).toEqual({
      type: 'string',
      required: false,
      input: false,
    });
  });
});
