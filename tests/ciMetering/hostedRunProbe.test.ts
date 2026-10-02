import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  HOSTED_RUN_WINDOW_MS,
  hostedRunProbeService,
  judgeHostedRuns,
} from '@/lib/services/hostedRunProbeService';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { MOTIR_FLEET_RUNNER_FAMILY, classifyRunner } from '@/lib/ciMetering/runnerRates';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The hosted-run probe (MOTIR-1934): a metered run in a Motir-owned org that ran
// on anything but the fleet. The service is driven against a REAL Postgres with
// an injected `now`; the verdict function is also pinned on its own.

const OWNED = 'motir-projects';
const NOW = new Date('2026-10-02T09:00:00.000Z');
const IN_WINDOW = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
const BEFORE_WINDOW = new Date(NOW.getTime() - HOSTED_RUN_WINDOW_MS - 60 * 1000);

/** A stored breakdown entry, exactly as `normalizeRunUsage` persists one. */
function entry(family: string) {
  return {
    family,
    multiplier: 1,
    billableMinutes: 3,
    rawWallClockSeconds: 150,
    linearEquivalentMinutes: 3,
    jobCount: 1,
    unpriced: false,
  };
}

let workspace: { id: string; organizationId: string };

async function seedRun(opts: {
  owner?: string;
  repo?: string;
  runId: string;
  completedAt?: Date;
  breakdown: unknown;
}): Promise<void> {
  const completedAt = opts.completedAt ?? IN_WINDOW;
  await adminDb.ciWorkflowRunUsage.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      runId: opts.runId,
      runAttempt: 1,
      repoOwner: opts.owner ?? OWNED,
      repoName: opts.repo ?? 'acme-web',
      periodStart: new Date(Date.UTC(completedAt.getUTCFullYear(), completedAt.getUTCMonth(), 1)),
      runCompletedAt: completedAt,
      billableMinutes: 3,
      rawWallClockSeconds: new Prisma.Decimal(150),
      linearEquivalentMinutes: new Prisma.Decimal(3),
      jobCount: 1,
      runnerBreakdown: opts.breakdown as Prisma.InputJsonValue,
    },
  });
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_workflow_run_usage" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  const user = await usersService.createUser({
    email: 'hosted-probe@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  ({ workspace } = await workspacesService.createWorkspace({
    name: 'WS hosted probe',
    ownerUserId: user.id,
  }));
  vi.stubEnv('GITHUB_FALLBACK_ORG', OWNED);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('motirOwnedOrgLogins', () => {
  it('is the provisioning org as a set of one, and empty when it is unset', () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'Motir-Projects');
    expect(motirOwnedOrgLogins()).toEqual(['motir-projects']);
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    expect(motirOwnedOrgLogins()).toEqual([]);
  });
});

describe('hostedRunProbeService.check', () => {
  it('is OK when every run in the window ran on the fleet', async () => {
    await seedRun({ runId: 'r1', breakdown: [entry(MOTIR_FLEET_RUNNER_FAMILY)] });
    await seedRun({ runId: 'r2', breakdown: [entry(MOTIR_FLEET_RUNNER_FAMILY)] });

    const verdict = await hostedRunProbeService.check(NOW);

    expect(verdict).toMatchObject({ verdict: 'ok', runsChecked: 2, ownedOrgs: [OWNED] });
  });

  it('FIRES on an ubuntu-latest run in an owned org, naming org, repo, run id and family', async () => {
    const family = classifyRunner(['ubuntu-latest']);
    await seedRun({ runId: 'r-fleet', breakdown: [entry(MOTIR_FLEET_RUNNER_FAMILY)] });
    await seedRun({ runId: '9001', repo: 'acme-api', breakdown: [entry(family)] });

    const verdict = await hostedRunProbeService.check(NOW);

    expect(verdict.verdict).toBe('hosted_runs');
    if (verdict.verdict !== 'hosted_runs') throw new Error('unreachable');
    expect(verdict.offenders).toEqual([
      {
        org: OWNED,
        repo: 'acme-api',
        runId: '9001',
        runAttempt: 1,
        completedAt: IN_WINDOW.toISOString(),
        families: [family],
      },
    ]);
  });

  it('does NOT fire on a hosted run in an org outside the owned set', async () => {
    await seedRun({
      runId: 'r-customer',
      owner: 'customer-org',
      breakdown: [entry(classifyRunner(['ubuntu-latest']))],
    });

    const verdict = await hostedRunProbeService.check(NOW);

    expect(verdict).toMatchObject({ verdict: 'ok', runsChecked: 0 });
  });

  it('FIRES on a run whose labels classified unknown — including an empty label set', async () => {
    expect(classifyRunner([])).toBe('unknown');
    await seedRun({ runId: 'r-empty', breakdown: [entry(classifyRunner([]))] });

    const verdict = await hostedRunProbeService.check(NOW);

    expect(verdict.verdict).toBe('hosted_runs');
    if (verdict.verdict !== 'hosted_runs') throw new Error('unreachable');
    expect(verdict.offenders[0]!.families).toEqual(['unknown']);
  });

  it('is OK over an EMPTY window, and ignores runs that completed before it', async () => {
    await seedRun({
      runId: 'r-old',
      completedAt: BEFORE_WINDOW,
      breakdown: [entry(classifyRunner(['ubuntu-latest']))],
    });

    const verdict = await hostedRunProbeService.check(NOW);

    expect(verdict).toMatchObject({ verdict: 'ok', runsChecked: 0 });
  });

  it('is NOT_APPLICABLE with no owned org configured, without reading anything', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    await seedRun({ runId: 'r1', breakdown: [entry(classifyRunner(['ubuntu-latest']))] });

    const verdict = await hostedRunProbeService.check(NOW);

    expect(verdict).toMatchObject({ verdict: 'not_applicable', ownedOrgs: [], runsChecked: 0 });
  });

  it('adding or removing an owned org is configuration only', async () => {
    await seedRun({
      runId: 'r-other',
      owner: 'motir-projects-eu',
      breakdown: [entry(classifyRunner(['ubuntu-latest']))],
    });

    expect((await hostedRunProbeService.check(NOW)).verdict).toBe('ok');
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects-eu');
    expect((await hostedRunProbeService.check(NOW)).verdict).toBe('hosted_runs');
  });
});

describe('judgeHostedRuns', () => {
  const run = (runnerBreakdown: unknown) => ({
    repoOwner: 'Motir-Projects',
    repoName: 'acme-web',
    runId: 'r1',
    runAttempt: 2,
    runCompletedAt: IN_WINDOW,
    runnerBreakdown,
  });
  const windowStart = new Date(NOW.getTime() - HOSTED_RUN_WINDOW_MS);

  it('matches the owner case-insensitively', () => {
    const verdict = judgeHostedRuns([run([entry('linux_x64')])], [OWNED], NOW, windowStart);
    expect(verdict.verdict).toBe('hosted_runs');
  });

  it('reports a mixed run by its non-fleet families only', () => {
    const verdict = judgeHostedRuns(
      [run([entry(MOTIR_FLEET_RUNNER_FAMILY), entry('macos'), entry('linux_x64')])],
      [OWNED],
      NOW,
      windowStart,
    );
    if (verdict.verdict !== 'hosted_runs') throw new Error('expected hosted_runs');
    expect(verdict.offenders[0]!.families).toEqual(['linux_x64', 'macos']);
  });

  it('treats an unreadable breakdown as unknown, and an empty one as no compute', () => {
    const unreadable = judgeHostedRuns([run({ nope: true })], [OWNED], NOW, windowStart);
    const malformedEntry = judgeHostedRuns([run([{ minutes: 3 }])], [OWNED], NOW, windowStart);
    const empty = judgeHostedRuns([run([])], [OWNED], NOW, windowStart);

    if (unreadable.verdict !== 'hosted_runs') throw new Error('expected hosted_runs');
    expect(unreadable.offenders[0]!.families).toEqual(['unknown']);
    expect(malformedEntry.verdict).toBe('hosted_runs');
    expect(empty.verdict).toBe('ok');
  });
});
