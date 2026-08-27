import { vi } from 'vitest';

/**
 * The 2FA policy answering "nobody is asking anything of this person".
 *
 * Story MOTIR-1215 · Subtask MOTIR-3653 made every route under `app/api/**` — and
 * MOTIR-3648 every signed-in route group — resolve the 2FA hold before doing any
 * work. That is one real service call, through `withUserContext` and a real
 * `user` row, on a path a transport test has no reason to own: a suite about a
 * route's OWN gates should not have to seed a user to assert a 404.
 *
 * So a suite that mocks its way around the database mocks this too, and gets the
 * state every one of its cases was written in — no tier requires a second
 * factor, so the gate is a pass-through.
 *
 * ⚠️ NOT A DEFAULT, AND DELIBERATELY NOT A SETUP FILE. Wiring this globally
 * would mock the gate out of the suites that exist to test it. It is opt-in per
 * file, and `tests/api/twoFactorApiRefusal.test.ts` — which asserts the refusal
 * against real Postgres and the real predicate — deliberately does not use it.
 *
 * Usage (the factory is hoisted, so the import happens inside it):
 *
 * ```ts
 * vi.mock('@/lib/services/twoFactorPolicyService', async () =>
 *   (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy());
 * ```
 */
export function noTwoFactorPolicy() {
  return {
    twoFactorPolicyService: {
      resolveRequirement: vi.fn(async () => ({
        required: false,
        mandatedBy: null,
        compliant: false,
      })),
    },
  };
}
