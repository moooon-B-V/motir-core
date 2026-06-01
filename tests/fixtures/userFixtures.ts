import type { User } from '@prisma/client';
import { usersService } from '@/lib/services/usersService';

// Shared test fixtures — user rows (Subtask 1.4.7).
//
// Extracted from the near-identical `makeFixture` helpers that each work-item
// test file (repository / link-repository / service / revisions) inlined.
// These build REAL rows through the service layer against the REAL Postgres
// (Yue's no-mocks rule) so a fixture user is indistinguishable from a
// production sign-up: hashed password, default workspace wiring left to the
// caller. Story 1.4.8's E2E reuses these too — that's why they live here
// rather than in any single test file.
//
// Naming mirrors the doooo project's `createTest*` convention (CLAUDE.md
// cross-reference): `createTest<Entity>` mints one fresh row.

/** A fixed password that satisfies the credential-strength rule. */
export const TEST_PASSWORD = 'hunter2hunter2';

export interface CreateTestUserOptions {
  /** Override the auto-generated unique email. */
  email?: string;
  /** Override the display name (default 'Owner'). */
  name?: string;
  /** Override the password (default {@link TEST_PASSWORD}). */
  password?: string;
}

/**
 * Create a real user. The email defaults to a per-call random address so
 * concurrent fixtures never collide on the unique email constraint (the
 * inlined helpers all did this via `owner+${Math.random()}@example.com`).
 */
export async function createTestUser(opts: CreateTestUserOptions = {}): Promise<User> {
  return usersService.createUser({
    email: opts.email ?? `owner+${Math.random().toString(36).slice(2)}@example.com`,
    password: opts.password ?? TEST_PASSWORD,
    name: opts.name ?? 'Owner',
  });
}
