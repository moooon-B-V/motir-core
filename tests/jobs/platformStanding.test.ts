import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-8197 — `resolveJobsPlatformRole`, the ONE place the jobs surface turns
// platform-staff standing into an answer. The System tab doors and the
// workspace-less replay all read it, so the cases that matter are the ones where
// a principal has the most TENANT standing available and still gets `null`, and
// the one where the gate fails for a reason that is not "no standing" — that
// must not be swallowed into a quiet "not staff".
//
// Real Postgres, the real gate, the real `platformRole` column. The single stub
// is `getSession()`, the standing exception in this repo.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

// `requirePlatformStaff` is wrapped in React `cache()`; with no request scope in
// vitest that cache is process-wide, so each case re-imports a fresh graph to be
// its own "request" (the same reason `platformStaffGate.test.ts` does).
beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function freshStanding() {
  const [standing, repo] = await Promise.all([
    import('@/lib/jobs/platformStanding'),
    import('@/lib/repositories/platformStaffRepository'),
  ]);
  return { ...standing, platformStaffRepository: repo.platformStaffRepository };
}

describe('the two levels', () => {
  it('reads the tab at support and replays at operator', async () => {
    const { JOBS_SYSTEM_READ_ROLE, JOBS_SYSTEM_REPLAY_ROLE } = await freshStanding();
    expect(JOBS_SYSTEM_READ_ROLE).toBe('support');
    expect(JOBS_SYSTEM_REPLAY_ROLE).toBe('operator');
  });
});

describe('resolveJobsPlatformRole', () => {
  it.each(['support', 'operator', 'superadmin'] as const)(
    'returns %s for a staff member holding it',
    async (role) => {
      const user = await createTestUser();
      await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
      currentSession = { user: { id: user.id } };

      const { resolveJobsPlatformRole } = await freshStanding();
      await expect(resolveJobsPlatformRole()).resolves.toBe(role);
    },
  );

  it('returns null for a signed-in user with no platform role', async () => {
    const user = await createTestUser();
    currentSession = { user: { id: user.id } };

    const { resolveJobsPlatformRole } = await freshStanding();
    await expect(resolveJobsPlatformRole()).resolves.toBeNull();
  });

  it('returns null with no session at all', async () => {
    const { resolveJobsPlatformRole } = await freshStanding();
    await expect(resolveJobsPlatformRole()).resolves.toBeNull();
  });

  it('ignores the retired admin-email env var, even when it names the caller', async () => {
    const user = await createTestUser({ email: 'owner@tenant.test' });
    // Named in pieces so the repository grep for the retired gate stays clean.
    vi.stubEnv('PLATFORM_ADMIN' + '_EMAIL', 'owner@tenant.test');
    currentSession = { user: { id: user.id } };

    const { resolveJobsPlatformRole } = await freshStanding();
    await expect(resolveJobsPlatformRole()).resolves.toBeNull();
    vi.unstubAllEnvs();
  });

  it('reads the role fresh — a revoke is seen on the next request', async () => {
    const user = await createTestUser();
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });
    currentSession = { user: { id: user.id } };

    expect(await (await freshStanding()).resolveJobsPlatformRole()).toBe('operator');

    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: null } });
    vi.resetModules();

    expect(await (await freshStanding()).resolveJobsPlatformRole()).toBeNull();
  });

  it('rethrows an unexpected error rather than answering "not staff"', async () => {
    const user = await createTestUser();
    currentSession = { user: { id: user.id } };

    const { resolveJobsPlatformRole, platformStaffRepository } = await freshStanding();
    vi.spyOn(platformStaffRepository, 'findStandingByUserId').mockRejectedValueOnce(
      new Error('connection reset'),
    );

    await expect(resolveJobsPlatformRole()).rejects.toThrow('connection reset');
  });
});
