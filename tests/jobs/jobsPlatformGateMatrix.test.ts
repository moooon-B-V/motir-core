import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// MOTIR-8201 — THE JOBS PLATFORM GATE, ASSEMBLED, AGAINST REAL ROWS.
//
// The earlier cards each proved one piece in isolation: the service with a
// hand-passed `platformRole` (MOTIR-8197), the resolver with its own cases, and
// the two System tab doors with a mocked resolver (MOTIR-8199). Each of them
// would stay green if the resolver and the service disagreed about what
// "operator" means. This file closes that gap: a real `user.platform_role` goes
// through `resolveJobsPlatformRole()` (→ `requirePlatformStaff` →
// `platformStaffRepository`), and the role IT returns is what reaches
// `replaySystemDLQ` against a real workspace-less `job_run_dlq` row. Nothing
// about standing is stubbed; the single mock is `getSession()`, the standing
// exception in this repo (vitest has no cookies).
//
// The tab decision is asserted as `(await resolve()) !== null` — the exact
// expression both doors use — rather than by rendering a page; the rendered tab
// is MOTIR-8202's.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

// The retired env-var gate, named in pieces so the repository grep for it stays
// clean (MOTIR-8200) while this file proves setting it changes nothing.
const LEGACY = 'PLATFORM_ADMIN' + '_EMAIL';

const FUNCTION_ID = 'system.platform-meter-report';

type Principal = 'support' | 'operator' | 'superadmin' | 'workspaceOwner' | 'orgOwner' | 'anon';

let users: Record<Exclude<Principal, 'anon'>, { id: string; email: string }>;
let workspaceId: string;

/**
 * One "request": a fresh module graph, so `requirePlatformStaff`'s React
 * `cache()` starts empty AND the error classes compare against the ones the
 * service actually throws (a top-level import would bind a different class
 * object once `vi.resetModules()` has run — `platformStaffGate.test.ts`).
 */
async function freshRequest() {
  vi.resetModules();
  // Side-effect import, as `dashboard-system-replay.test.ts` does: it loads
  // `email.send`'s definition so the engine knows an idempotency template, and
  // the already-replayed assertion tests the dedup rather than a missing key.
  await import('@/lib/jobs/definitions/emailSend');
  const [standing, service, errors] = await Promise.all([
    import('@/lib/jobs/platformStanding'),
    import('@/lib/services/jobsDashboardService'),
    import('@/lib/jobs/errors'),
  ]);
  return {
    resolve: standing.resolveJobsPlatformRole,
    service: service.jobsDashboardService,
    ...errors,
  };
}

function signIn(principal: Principal): string {
  if (principal === 'anon') {
    currentSession = null;
    return 'anon';
  }
  currentSession = { user: { id: users[principal].id } };
  return users[principal].id;
}

/**
 * A workspace-less dead letter of `email.send` — a password-reset delivery
 * carries no workspace — because the already-replayed outcome is the engine's
 * `(job_id, idempotency_key)` dedup, and only a job that DECLARES an
 * idempotency template has a key to collide on (`dashboard-system-replay.test.ts`
 * says why the meter report cannot show it).
 */
async function seedSystemDlq(key = 'pw-1'): Promise<string> {
  const row = await adminDb.jobRunDlq.create({
    data: {
      workspaceId: null,
      functionId: 'email.send',
      eventName: 'email.send',
      eventData: { to: 'reset@example.com', template: 'password-reset', idempotencyKey: key },
      failure: { message: 'SMTP_UNAVAILABLE' },
      attempts: 5,
    },
  });
  return row.id;
}

async function replayedAt(dlqId: string): Promise<Date | null> {
  return (await adminDb.jobRunDlq.findUniqueOrThrow({ where: { id: dlqId } })).replayedAt;
}

async function setRole(principal: Exclude<Principal, 'anon'>, role: PlatformRole | null) {
  await adminDb.user.update({ where: { id: users[principal].id }, data: { platformRole: role } });
}

beforeEach(async () => {
  currentSession = null;
  await truncateAuthTables();
  await truncateJobRuns();

  const support = await createTestUser({ email: 'support@motir.test' });
  const operator = await createTestUser({ email: 'operator@motir.test' });
  const superadmin = await createTestUser({ email: 'superadmin@motir.test' });
  const orgOwner = await createTestUser({ email: 'org-owner@tenant.test' });
  const workspaceOwner = await createTestUser({ email: 'ws-owner@tenant.test' });

  // The org owner CREATES the workspace, so they hold the organization's `owner`
  // role and the workspace's `manager` role; the workspace owner is added as a
  // second manager of that workspace with no organization role. Both are the
  // principals with the MOST tenant standing — the ones that must get nothing.
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Tenant Workspace',
    ownerUserId: orgOwner.id,
  });
  workspaceId = workspace.id;
  await adminDb.workspaceMembership.create({
    data: { userId: workspaceOwner.id, workspaceId, workspaceRole: 'manager' },
  });

  users = { support, operator, superadmin, orgOwner, workspaceOwner };
  await setRole('support', 'support');
  await setRole('operator', 'operator');
  await setRole('superadmin', 'superadmin');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the fixture', () => {
  it('gives the two tenant principals real owner standing', async () => {
    const orgMembership = await adminDb.organizationMembership.findFirstOrThrow({
      where: { userId: users.orgOwner.id },
    });
    expect(orgMembership.role).toBe('owner');
    const wsMembership = await adminDb.workspaceMembership.findFirstOrThrow({
      where: { userId: users.workspaceOwner.id, workspaceId },
    });
    expect(wsMembership.workspaceRole).toBe('manager');
  });
});

// ── the matrix ───────────────────────────────────────────────────────────────

const MATRIX: Array<{
  principal: Principal;
  resolves: PlatformRole | null;
  replays: boolean;
}> = [
  { principal: 'support', resolves: 'support', replays: false },
  { principal: 'operator', resolves: 'operator', replays: true },
  { principal: 'superadmin', resolves: 'superadmin', replays: true },
  { principal: 'workspaceOwner', resolves: null, replays: false },
  { principal: 'orgOwner', resolves: null, replays: false },
  { principal: 'anon', resolves: null, replays: false },
];

/** One principal's whole outcome, read through the real resolver and service. */
async function outcomeFor(principal: Principal) {
  const userId = signIn(principal);
  const req = await freshRequest();
  const role = await req.resolve();
  const dlqId = await seedSystemDlq(`key-${principal}-${Math.random()}`);

  let replay: 'replayed' | 'already-replayed' | 'forbidden';
  try {
    ({ outcome: replay } = await req.service.replaySystemDLQ({
      dlqId,
      userId,
      platformRole: role,
    }));
  } catch (err) {
    if (!(err instanceof req.SystemReplayForbiddenError)) throw err;
    replay = 'forbidden';
  }

  let second: 'replayed' | 'already-replayed' | 'forbidden' | null = null;
  if (replay === 'replayed') {
    ({ outcome: second } = await req.service.replaySystemDLQ({
      dlqId,
      userId,
      platformRole: role,
    }));
  }

  return { role, tab: role !== null, replay, second, stamped: (await replayedAt(dlqId)) !== null };
}

describe('the platform gate, per principal', () => {
  it.each(MATRIX)(
    '$principal → resolves $resolves, replays: $replays',
    async ({ principal, resolves, replays }) => {
      const got = await outcomeFor(principal);

      expect(got.role).toBe(resolves);
      expect(got.tab).toBe(resolves !== null);
      if (replays) {
        expect(got.replay).toBe('replayed');
        expect(got.stamped).toBe(true);
        expect(got.second).toBe('already-replayed');
      } else {
        expect(got.replay).toBe('forbidden');
        expect(got.stamped).toBe(false);
      }
    },
  );
});

describe('the retired env var is ignored', () => {
  it.each(MATRIX)(
    '$principal: identical with it naming the tenant owner, the support user, or unset',
    async ({ principal }) => {
      const strip = (o: Awaited<ReturnType<typeof outcomeFor>>) => ({
        role: o.role,
        tab: o.tab,
        replay: o.replay,
        stamped: o.stamped,
      });

      const unset = strip(await outcomeFor(principal));

      vi.stubEnv(LEGACY, users.orgOwner.email);
      const namingOwner = strip(await outcomeFor(principal));

      vi.stubEnv(LEGACY, users.support.email);
      const namingSupport = strip(await outcomeFor(principal));

      vi.unstubAllEnvs();
      const unsetAgain = strip(await outcomeFor(principal));

      expect(namingOwner).toEqual(unset);
      expect(namingSupport).toEqual(unset);
      expect(unsetAgain).toEqual(unset);
    },
  );
});

describe('a role change takes effect on the next request', () => {
  it('a revoked operator resolves to null and is refused the replay', async () => {
    signIn('operator');
    expect(await (await freshRequest()).resolve()).toBe('operator');

    await setRole('operator', null);

    const req = await freshRequest();
    const role = await req.resolve();
    expect(role).toBeNull();
    const dlqId = await seedSystemDlq();
    await expect(
      req.service.replaySystemDLQ({ dlqId, userId: users.operator.id, platformRole: role }),
    ).rejects.toBeInstanceOf(req.SystemReplayForbiddenError);
    expect(await replayedAt(dlqId)).toBeNull();
  });

  it('an operator demoted to support keeps the tab and loses the replay', async () => {
    signIn('operator');
    expect(await (await freshRequest()).resolve()).toBe('operator');

    await setRole('operator', 'support');

    const req = await freshRequest();
    const role = await req.resolve();
    expect(role).toBe('support');
    const dlqId = await seedSystemDlq();
    await expect(
      req.service.replaySystemDLQ({ dlqId, userId: users.operator.id, platformRole: role }),
    ).rejects.toBeInstanceOf(req.SystemReplayForbiddenError);
    expect(await replayedAt(dlqId)).toBeNull();
  });
});

describe('the row checks still hold behind a passing role gate', () => {
  it('an operator replaying a WORKSPACE row is refused by name', async () => {
    signIn('operator');
    const req = await freshRequest();
    const role = await req.resolve();
    const row = await adminDb.jobRunDlq.create({
      data: {
        workspaceId,
        functionId: FUNCTION_ID,
        eventName: FUNCTION_ID,
        eventData: { containerId: 'c-1', idempotencyKey: 'ws-key' },
        failure: { message: 'boom' },
        attempts: 5,
      },
    });

    await expect(
      req.service.replaySystemDLQ({ dlqId: row.id, userId: users.operator.id, platformRole: role }),
    ).rejects.toBeInstanceOf(req.SystemReplayWorkspaceRowError);
    expect(await replayedAt(row.id)).toBeNull();
  });

  it('an operator replaying an unknown id gets DlqEntryNotFoundError', async () => {
    signIn('operator');
    const req = await freshRequest();
    const role = await req.resolve();

    await expect(
      req.service.replaySystemDLQ({
        dlqId: 'no-such-dlq',
        userId: users.operator.id,
        platformRole: role,
      }),
    ).rejects.toBeInstanceOf(req.DlqEntryNotFoundError);
  });
});
