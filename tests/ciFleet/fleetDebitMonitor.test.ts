import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import type { FleetVerdict } from '@/lib/dto/platformFleetMonitor';
import { createTestUser } from '../fixtures/userFixtures';
import { JobTestEngine } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE FLEET DEBIT MONITOR (Story MOTIR-6905 · MOTIR-7318): one Sentry alert per
// mismatched (org, reason), fingerprinted so a persisting mismatch stays ONE
// issue. Sentry is mocked at its module; the verdict is the fleet monitor's own,
// run for real against Postgres where the case needs real rows.

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const { fleetDebitMonitor, FLEET_DEBIT_MONITOR_CRON } =
  await import('@/lib/jobs/definitions/fleetDebitMonitor');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { jobServices } = await import('@/lib/jobs/services');
const { jobSchedules } = await import('@/lib/jobs/schedules');
const { fleetDebitMonitorService } = await import('@/lib/services/fleetDebitMonitorService');
const { platformFleetMonitorService } = await import('@/lib/services/platformFleetMonitorService');
const { workspacesService } = await import('@/lib/services/workspacesService');

let seq = 0;

async function seedOrgRunningUndebited(): Promise<{ organizationId: string; name: string }> {
  const owner = await createTestUser({ email: `debit-mon-${seq++}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Leaky ${seq}`,
    ownerUserId: owner.id,
  });
  // A CI job that started 11 minutes ago, and no accrual has reached the org.
  await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      installationId: '1',
      runId: `run-${seq}`,
      runAttempt: 1,
      jobId: `job-${seq}`,
      repoOwner: 'motir-projects',
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(Date.now() - 12 * 60_000),
      status: 'running',
      startedAt: new Date(Date.now() - 11 * 60_000),
    },
  });
  return { organizationId: workspace.organizationId, name: `Leaky ${seq}` };
}

/** Stand in for the monitor's own judgement: one reading per org id. */
function judged(byOrg: Record<string, FleetVerdict[] | Error>) {
  vi.spyOn(platformFleetMonitorService, 'listOrganizationsToJudge').mockResolvedValue(
    Object.keys(byOrg),
  );
  vi.spyOn(platformFleetMonitorService, 'judgeOrganization').mockImplementation(async (id) => {
    const verdicts = byOrg[id];
    if (verdicts instanceof Error) throw verdicts;
    return {
      organizationId: id,
      name: `Org ${id}`,
      verdicts: verdicts ?? ['ok'],
    } as Awaited<ReturnType<typeof platformFleetMonitorService.judgeOrganization>>;
  });
}

beforeEach(async () => {
  await truncateJobRuns();
  await truncateAuthTables();
  captureException.mockReset();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the job is registered and watched (AC1)', () => {
  it('runs on */5 and is in the schedule table the health check iterates', () => {
    expect(FLEET_DEBIT_MONITOR_CRON).toBe('*/5 * * * *');
    expect(jobDefinitions).toContain(fleetDebitMonitor);
    expect(jobServices.fleetDebitMonitor).toBe(fleetDebitMonitorService);
    expect(jobSchedules()).toContainEqual({
      functionId: 'system.fleet-debit-monitor',
      cron: '*/5 * * * *',
    });
  });
});

describe('alerts (AC2–AC4)', () => {
  it('AC2 + AC3: a running_not_debited org is one named error, and stays ONE issue across runs', async () => {
    const leaky = await seedOrgRunningUndebited();

    const engine = new JobTestEngine({ function: fleetDebitMonitor });
    const { result } = await engine.execute();
    expect(result).toEqual({ orgs: 1, mismatched: 1, alerted: 1, failures: 0 });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, hint] = captureException.mock.calls[0]!;
    expect(error).toMatchObject({ name: 'FleetDebitMismatchError' });
    expect((error as Error).message).toContain(leaky.name);
    expect((error as Error).message).toContain(leaky.organizationId);
    expect((error as Error).message).toContain('running, not debited');
    expect(hint).toMatchObject({
      fingerprint: ['fleet-debit-mismatch', 'running_not_debited', leaky.organizationId],
      tags: {
        fleet_alert: 'FleetDebitMismatchError',
        fleet_org: leaky.organizationId,
        fleet_reason: 'running_not_debited',
      },
    });

    // The next run over the same mismatch: a second EVENT, the same fingerprint.
    await new JobTestEngine({ function: fleetDebitMonitor }).execute();
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(captureException.mock.calls[1]![1]).toMatchObject({ fingerprint: hint.fingerprint });
  });

  it('two reasons on one org are two issues', async () => {
    judged({ a: ['running_not_debited', 'exhausted_still_running'] });
    const result = await fleetDebitMonitorService.run(new Date());
    expect(result).toEqual({ orgs: 1, mismatched: 1, alerted: 2, failures: 0 });
    expect(captureException.mock.calls.map(([, hint]) => hint.fingerprint)).toEqual([
      ['fleet-debit-mismatch', 'running_not_debited', 'a'],
      ['fleet-debit-mismatch', 'exhausted_still_running', 'a'],
    ]);
  });

  it('debited_nothing_running is alerted in words', async () => {
    judged({ b: ['debited_nothing_running'] });
    await fleetDebitMonitorService.run(new Date());
    expect((captureException.mock.calls[0]![0] as Error).message).toContain(
      'Org b (b): debited, nothing running',
    );
  });

  it('AC4: ok, balance_unknown and not_charged capture nothing', async () => {
    judged({ ok: ['ok'], unknown: ['balance_unknown'], meta: ['not_charged'] });
    const result = await fleetDebitMonitorService.run(new Date());
    expect(result).toEqual({ orgs: 3, mismatched: 0, alerted: 0, failures: 0 });
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('a failure is one org, never the run (AC5)', () => {
  it('logs the throw, judges the rest, and counts the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    judged({ broken: new Error('db hiccup'), c: ['running_not_debited'] });
    const result = await fleetDebitMonitorService.run(new Date());
    expect(result).toEqual({ orgs: 2, mismatched: 1, alerted: 1, failures: 1 });
    expect(error).toHaveBeenCalledWith(
      '[fleetDebitMonitorService] could not judge an organization',
      { organizationId: 'broken', detail: 'db hiccup' },
    );
  });

  it('an alert that throws inside Sentry never stops the pass', async () => {
    captureException.mockImplementation(() => {
      throw new Error('sentry down');
    });
    judged({ d: ['running_not_debited'], e: ['debited_nothing_running'] });
    const result = await fleetDebitMonitorService.run(new Date());
    expect(result).toEqual({ orgs: 2, mismatched: 2, alerted: 2, failures: 0 });
  });
});
