import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  jobsDashboardService,
  SYSTEM_DLQ_REPLAYED_WINDOW_DAYS,
} from '@/lib/services/jobsDashboardService';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import {
  DlqEntryNotFoundError,
  SystemReplayForbiddenError,
  SystemReplayWorkspaceRowError,
} from '@/lib/jobs/errors';
import { isPlatformOperator } from '@/lib/jobs/platformOperator';
// Side-effect import: evaluates `email.send`'s definition module so the engine
// knows its idempotency template. A replay of a job whose definition is not
// loaded in THIS process still works, but with no dedup key — which would turn
// the already-replayed test below into a test of the wrong thing.
import '@/lib/jobs/definitions/emailSend';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// MOTIR-8083 — A DEAD LETTER WITH NO WORKSPACE CAN BE REPLAYED, BY THE OPERATOR.
//
// A `system.*` job writes its dead letters with `workspace_id` NULL, and the only
// replay door (`replayDLQ`) runs in the caller's workspace and asks for a row of
// that workspace — so it answered "the dead letter is gone" for every system row,
// and two `system.platform-meter-report` rows stood undisposed for a week with no
// way to replay them. This drives the new operator door against a real Postgres:
// a seeded `workspaceId: null` row reaching `replayed`, the two refusals that are
// the whole of its safety (it runs under `withSystemContext`, which bypasses
// tenant RLS), and the list the System tab reads.

const OPERATOR_EMAIL = 'operator@motir.test';
const FUNCTION_ID = 'system.platform-meter-report';
const DAY_MS = 24 * 60 * 60 * 1000;

let operator: { id: string };
let tenantOwner: { id: string };
let workspaceId: string;

async function seedDlq(opts: {
  workspaceId: string | null;
  functionId?: string;
  lastFailedAt?: Date;
  replayedAt?: Date | null;
  eventData?: object;
}): Promise<string> {
  const row = await adminDb.jobRunDlq.create({
    data: {
      workspaceId: opts.workspaceId,
      functionId: opts.functionId ?? FUNCTION_ID,
      eventName: opts.functionId ?? FUNCTION_ID,
      eventData: opts.eventData ?? { containerId: 'c-1', idempotencyKey: 'meter-key-1' },
      failure: { message: 'MOTIR_AI_UNAVAILABLE' },
      attempts: 5,
      ...(opts.lastFailedAt ? { lastFailedAt: opts.lastFailedAt } : {}),
      ...(opts.replayedAt ? { replayedAt: opts.replayedAt } : {}),
    },
  });
  return row.id;
}

const asOperator = (dlqId: string) => ({
  dlqId,
  userId: operator.id,
  userEmail: OPERATOR_EMAIL,
});

beforeEach(async () => {
  vi.stubEnv('PLATFORM_ADMIN_EMAIL', OPERATOR_EMAIL);
  await truncateAuthTables();
  await truncateJobRuns();
  operator = await usersService.createUser({
    email: OPERATOR_EMAIL,
    password: 'hunter2hunter2',
    name: 'Platform Operator',
  });
  tenantOwner = await usersService.createUser({
    email: 'tenant-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Tenant Owner',
  });
  const created = await workspacesService.createWorkspace({
    name: 'Tenant Workspace',
    ownerUserId: tenantOwner.id,
  });
  workspaceId = created.workspace.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the defect: the workspace door cannot take a row with no workspace', () => {
  it('replayDLQ answers "gone" for a workspace-less row, even from a workspace manager', async () => {
    // The reproduction from the card, kept as a regression guard on the OTHER
    // door: it stays manager-gated and workspace-scoped, which is exactly why the
    // operator door exists. If this ever replays, the tenant door has widened.
    const dlqId = await seedDlq({ workspaceId: null });

    await expect(
      jobsDashboardService.replayDLQ({ dlqId, workspaceId, userId: tenantOwner.id }),
    ).rejects.toBeInstanceOf(DlqEntryNotFoundError);

    expect((await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt).toBeNull();
    expect(await adminDb.jobEvent.count()).toBe(0);
  });
});

describe('jobsDashboardService.replaySystemDLQ', () => {
  it('the operator replays a workspace-less row: re-emitted with the :replay:<dlqId> key, then stamped', async () => {
    const dlqId = await seedDlq({ workspaceId: null });

    const result = await jobsDashboardService.replaySystemDLQ(asOperator(dlqId));

    expect(result.outcome).toBe('replayed');
    expect(result.entry.replayedAt).not.toBeNull();

    // Read off the queue rows: a replay is a fresh job_event + job_queue pair.
    const events = await adminDb.jobEvent.findMany({ where: { name: FUNCTION_ID } });
    expect(events).toHaveLength(1);
    expect(events[0]!.workspaceId).toBeNull();
    expect(events[0]!.data).toEqual({
      containerId: 'c-1',
      idempotencyKey: `meter-key-1:replay:${dlqId}`,
    });
    expect(events[0]!.idempotencyKey).toBe(`meter-key-1:replay:${dlqId}`);
    expect(await adminDb.jobQueueRun.count({ where: { jobId: FUNCTION_ID } })).toBe(1);

    const reread = await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } });
    expect(reread!.replayedAt).not.toBeNull();
  });

  it('stamps replayedAt only when the event was actually published', async () => {
    // The ordering lib/jobs/dlq.ts promises, held through THIS door: if the
    // re-emit throws, the whole system transaction rolls back and the row is
    // still un-replayed — "replayed" never records a send that did not happen.
    const dlqId = await seedDlq({ workspaceId: null });
    vi.spyOn(jobEventRepository, 'create').mockRejectedValueOnce(new Error('publish failed'));

    await expect(jobsDashboardService.replaySystemDLQ(asOperator(dlqId))).rejects.toThrow(
      'publish failed',
    );

    expect((await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt).toBeNull();
    expect(await adminDb.jobEvent.count()).toBe(0);
  });

  it('a second replay of the same row answers already-replayed and enqueues nothing more', async () => {
    // `email.send` rather than the meter report, because the dedup lives in the
    // engine's `(job_id, idempotency_key)` unique index and only a job that
    // DECLARES an idempotency template has a key to collide on. A password-reset
    // delivery is also a genuine workspace-less dead letter (it carries no
    // workspace), so this is a real shape for this door, not a convenience.
    const dlqId = await seedDlq({
      workspaceId: null,
      functionId: 'email.send',
      eventData: { to: 'reset@example.com', template: 'password-reset', idempotencyKey: 'pw-1' },
    });

    const first = await jobsDashboardService.replaySystemDLQ(asOperator(dlqId));
    const second = await jobsDashboardService.replaySystemDLQ(asOperator(dlqId));

    expect(first.outcome).toBe('replayed');
    expect(second.outcome).toBe('already-replayed');
    // The entry carries the FIRST replay's stamp, not a new one.
    expect(second.entry.replayedAt).toBe(first.entry.replayedAt);
    expect(await adminDb.jobEvent.count({ where: { name: 'email.send' } })).toBe(1);
    expect(await adminDb.jobQueueRun.count({ where: { jobId: 'email.send' } })).toBe(1);
  });

  it('refuses a caller who is not the platform operator — and re-emits nothing', async () => {
    const dlqId = await seedDlq({ workspaceId: null });

    await expect(
      jobsDashboardService.replaySystemDLQ({
        dlqId,
        userId: tenantOwner.id,
        userEmail: 'tenant-owner@example.com',
      }),
    ).rejects.toBeInstanceOf(SystemReplayForbiddenError);

    expect((await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt).toBeNull();
    expect(await adminDb.jobEvent.count()).toBe(0);
  });

  it('refuses everybody when PLATFORM_ADMIN_EMAIL is unset — an empty gate matches nobody', async () => {
    vi.stubEnv('PLATFORM_ADMIN_EMAIL', '');
    const dlqId = await seedDlq({ workspaceId: null });

    for (const userEmail of ['', OPERATOR_EMAIL]) {
      await expect(
        jobsDashboardService.replaySystemDLQ({ dlqId, userId: operator.id, userEmail }),
      ).rejects.toBeInstanceOf(SystemReplayForbiddenError);
    }
    expect(await adminDb.jobEvent.count()).toBe(0);
  });

  it('refuses a row that HAS a workspace — that row keeps the manager-gated door', async () => {
    // The anti cross-tenant property. The system door bypasses RLS, so without
    // this the operator door would be a way to replay ANY tenant's dead letter
    // by id. The refusal is by name, not by "not found", so the surface can send
    // the operator to the door that takes the row.
    const dlqId = await seedDlq({ workspaceId });

    await expect(jobsDashboardService.replaySystemDLQ(asOperator(dlqId))).rejects.toBeInstanceOf(
      SystemReplayWorkspaceRowError,
    );

    expect((await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt).toBeNull();
    expect(await adminDb.jobEvent.count()).toBe(0);

    // …and that row's own door is unchanged: its manager still replays it.
    const viaWorkspace = await jobsDashboardService.replayDLQ({
      dlqId,
      workspaceId,
      userId: tenantOwner.id,
    });
    expect(viaWorkspace.outcome).toBe('replayed');
  });

  it('answers not-found for an unknown id', async () => {
    await expect(
      jobsDashboardService.replaySystemDLQ(asOperator('does-not-exist')),
    ).rejects.toBeInstanceOf(DlqEntryNotFoundError);
    expect(await adminDb.jobEvent.count()).toBe(0);
  });

  it('checks the gate BEFORE it looks the row up — a non-operator learns nothing about an id', async () => {
    const real = await seedDlq({ workspaceId: null });
    const call = (dlqId: string) =>
      jobsDashboardService.replaySystemDLQ({
        dlqId,
        userId: tenantOwner.id,
        userEmail: 'tenant-owner@example.com',
      });

    // The same refusal whether the id exists or not.
    await expect(call(real)).rejects.toBeInstanceOf(SystemReplayForbiddenError);
    await expect(call('does-not-exist')).rejects.toBeInstanceOf(SystemReplayForbiddenError);
  });
});

describe('jobsDashboardService.listSystemDlq', () => {
  const NOW = new Date('2026-10-10T12:00:00.000Z');
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

  it('lists workspace-less rows only: unreplayed first, then replayed within the window, newest failure first', async () => {
    const waitingOld = await seedDlq({ workspaceId: null, lastFailedAt: ago(8) });
    const waitingNew = await seedDlq({ workspaceId: null, lastFailedAt: ago(2) });
    const replayedNewer = await seedDlq({
      workspaceId: null,
      lastFailedAt: ago(4),
      replayedAt: ago(1),
    });
    const replayedOlder = await seedDlq({
      workspaceId: null,
      lastFailedAt: ago(6),
      replayedAt: ago(3),
    });
    // Out of the list: replayed OUTSIDE the window, and two rows that have a
    // workspace (one waiting, one replayed in the window).
    await seedDlq({
      workspaceId: null,
      lastFailedAt: ago(30),
      replayedAt: ago(SYSTEM_DLQ_REPLAYED_WINDOW_DAYS + 1),
    });
    await seedDlq({ workspaceId, lastFailedAt: ago(1) });
    await seedDlq({ workspaceId, lastFailedAt: ago(1), replayedAt: ago(1) });

    const list = await jobsDashboardService.listSystemDlq(NOW);

    expect(list.rows.map((r) => r.id)).toEqual([
      waitingNew,
      waitingOld,
      replayedNewer,
      replayedOlder,
    ]);
    expect(list.rows.every((r) => r.workspaceId === null)).toBe(true);
    expect(list.waiting).toBe(2);
    expect(list.replayedRecently).toBe(2);
  });

  it('is empty, with zero counts, when no system dead letter exists', async () => {
    await seedDlq({ workspaceId });

    expect(await jobsDashboardService.listSystemDlq(NOW)).toEqual({
      rows: [],
      waiting: 0,
      replayedRecently: 0,
    });
  });

  it('a row replayed through the operator door moves from waiting to replayed', async () => {
    const dlqId = await seedDlq({ workspaceId: null, lastFailedAt: ago(1) });
    expect((await jobsDashboardService.listSystemDlq()).waiting).toBe(1);

    await jobsDashboardService.replaySystemDLQ(asOperator(dlqId));

    const after = await jobsDashboardService.listSystemDlq();
    expect(after.waiting).toBe(0);
    expect(after.replayedRecently).toBe(1);
    expect(after.rows.map((r) => r.id)).toEqual([dlqId]);
    expect(after.rows[0]!.replayedAt).not.toBeNull();
  });
});

describe('isPlatformOperator', () => {
  it('matches only the configured email, exactly', () => {
    expect(isPlatformOperator(OPERATOR_EMAIL)).toBe(true);
    expect(isPlatformOperator('someone@else.test')).toBe(false);
    expect(isPlatformOperator(OPERATOR_EMAIL.toUpperCase())).toBe(false);
    expect(isPlatformOperator(null)).toBe(false);
    expect(isPlatformOperator(undefined)).toBe(false);
    expect(isPlatformOperator('')).toBe(false);
  });

  it('matches nobody when PLATFORM_ADMIN_EMAIL is unset or empty', () => {
    vi.stubEnv('PLATFORM_ADMIN_EMAIL', '');
    expect(isPlatformOperator(OPERATOR_EMAIL)).toBe(false);
    expect(isPlatformOperator('')).toBe(false);
  });
});
