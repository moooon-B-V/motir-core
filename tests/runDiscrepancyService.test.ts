import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  DiscrepancyAlreadyRecordedError,
  RUN_DISCREPANCY_FIELD_MAX,
  RUN_DISCREPANCY_POINTS_MAX,
  RunDiscrepancyInvalidError,
} from '@/lib/dispatchRuns/errors';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { DISPATCH_RUN_EVENT_LIMIT, dispatchRunService } from '@/lib/services/dispatchRunService';
import { runDiscrepancyService } from '@/lib/services/runDiscrepancyService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from './helpers/workspaceRoleFixtures';

// A RUN'S DISCREPANCY RECORD (Story MOTIR-8651 · Subtask MOTIR-8655) against a real
// Postgres — `runDiscrepancyService.recordDiscrepancy`, as decided in the page MOTIR-8654:
// ONE comment listing the points, ONE pointer-only `discrepancy_recorded` finding per open
// leg, `DISCREPANCY_ALREADY_RECORDED` on a second call, `recorded: false` with no open leg.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const POINT = {
  planAsked: 'SENTINEL-ASKED: call the helper fooBar()',
  built: 'SENTINEL-BUILT: called the equivalent bazQux()',
  why: 'SENTINEL-WHY: fooBar() was retired in the previous release',
};

/** A member whose custom role holds exactly `permissions`, bound to the project. */
async function memberWithRole(
  fx: WorkItemFixture,
  name: string,
  permissions: readonly string[],
): Promise<ServiceContext> {
  const user = await createTestUser({ name });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name,
    permissions: [...permissions],
  });
  const key = fx.projectIdentifier;
  await addToProjectAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  await setProjectRoleAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: role.id,
  });
  return { userId: user.id, workspaceId: fx.workspaceId, tokenProjectId: fx.projectId };
}

async function card(fx: WorkItemFixture, title = 'A card') {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id, key: item.identifier };
}

/** A running dispatch run whose legs for `keys` are all OPEN (claimed). */
async function openLegs(
  fx: WorkItemFixture,
  keys: string[],
  ctx: ServiceContext,
  reportedBy: 'cli' | 'agent' = 'cli',
) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy,
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    keys.map((key) => ({
      kind: 'card_claimed' as const,
      workItemKey: key,
      disposition: 'running' as const,
    })),
    ctx,
  );
  return run.id;
}

const record = (key: string, points: unknown[], ctx: ServiceContext) =>
  runDiscrepancyService.recordDiscrepancy({ key, points: points as (typeof POINT)[] }, ctx);

const findings = (workItemId: string) =>
  adminDb.dispatchRunEvent.findMany({
    where: { kind: 'discrepancy_recorded', card: { workItemId } },
  });

describe('validation — refused before anything is resolved or written', () => {
  it('an empty point list, too many points, an empty field and an over-long field', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);

    await expect(record(c.key, [], fx.ctx)).rejects.toMatchObject({ reason: 'points_empty' });
    await expect(
      record(
        c.key,
        Array.from({ length: RUN_DISCREPANCY_POINTS_MAX + 1 }, () => POINT),
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'points_too_many' });
    await expect(record(c.key, [{ ...POINT, why: '   ' }], fx.ctx)).rejects.toMatchObject({
      reason: 'field_empty',
      where: { point: 1, field: 'why' },
    });
    await expect(
      record(
        c.key,
        [POINT, { ...POINT, built: 'x'.repeat(RUN_DISCREPANCY_FIELD_MAX + 1) }],
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'field_too_long', where: { point: 2, field: 'built' } });
    await expect(record(c.key, [], fx.ctx)).rejects.toBeInstanceOf(RunDiscrepancyInvalidError);

    expect(await adminDb.comment.count()).toBe(0);
  });

  it('accepts the maximum: 20 points of 2000 characters', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const big = 'y'.repeat(RUN_DISCREPANCY_FIELD_MAX);
    const points = Array.from({ length: RUN_DISCREPANCY_POINTS_MAX }, () => ({
      planAsked: big,
      built: big,
      why: big,
    }));
    expect(await record(c.key, points, fx.ctx)).toMatchObject({ recorded: false });
  });
});

describe('an open leg — one comment, one pointer-only finding', () => {
  it('three points make ONE comment listing all three and ONE finding with a pointer', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await memberWithRole(fx, 'CLI agent', CLI_TOKEN_GRANT);
    const c = await card(fx);
    await openLegs(fx, [c.key], cli);
    const points = [1, 2, 3].map((n) => ({
      planAsked: `ASKED-${n}`,
      built: `BUILT-${n}`,
      why: `WHY-${n}`,
    }));

    const result = await record(c.key, points, cli);
    expect(result.recorded).toBe(true);

    const comments = await adminDb.comment.findMany({ where: { workItemId: c.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(result.commentId);
    expect(comments[0]!.authorId).toBe(cli.userId);
    for (const n of [1, 2, 3]) {
      expect(comments[0]!.bodyMd).toContain(`ASKED-${n}`);
      expect(comments[0]!.bodyMd).toContain(`BUILT-${n}`);
      expect(comments[0]!.bodyMd).toContain(`WHY-${n}`);
    }

    const events = await findings(c.id);
    expect(events).toHaveLength(1);
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { workItemId: c.id } });
    // A POINTER and a count — exactly these keys, and none of the text.
    expect(events[0]!.data).toEqual({
      commentId: result.commentId,
      pointCount: 3,
      dispatchRunCardId: leg.id,
    });
    expect(JSON.stringify(events[0]!.data)).not.toContain('ASKED');
    expect(events[0]).toMatchObject({
      workspaceId: fx.workspaceId,
      dispatchRunId: leg.dispatchRunId,
      dispatchRunCardId: leg.id,
      reportedBy: 'cli',
    });
  });

  it('an agent-reported run records the finding as reportedBy: agent', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx, 'agent');

    expect((await record(c.key, [POINT], fx.ctx)).recorded).toBe(true);
    expect((await findings(c.id))[0]!.reportedBy).toBe('agent');
  });

  it("a parent run's discrepancy lands on the CHILD's own leg", async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const a = await card(fx, 'Child A');
    const b = await card(fx, 'Child B');
    await openLegs(fx, [a.key, b.key], fx.ctx, 'agent');

    await record(b.key, [POINT], fx.ctx);

    expect(await findings(a.id)).toHaveLength(0);
    expect(await findings(b.id)).toHaveLength(1);
    // …and the sibling can still record its own.
    await record(a.key, [POINT, POINT], fx.ctx);
    expect((await findings(a.id))[0]!.data).toMatchObject({ pointCount: 2 });
  });

  it('a SECOND call on the same leg is refused and writes no second comment', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx);

    await record(c.key, [POINT], fx.ctx);
    await expect(record(c.key, [POINT], fx.ctx)).rejects.toBeInstanceOf(
      DiscrepancyAlreadyRecordedError,
    );

    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(1);
    expect(await findings(c.id)).toHaveLength(1);
  });

  it('two concurrent calls on one leg write exactly one record', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx);

    const settled = await Promise.allSettled([
      record(c.key, [POINT], fx.ctx),
      record(c.key, [POINT], fx.ctx),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const refused = settled.filter((s) => s.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DiscrepancyAlreadyRecordedError,
    );
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(1);
    expect(await findings(c.id)).toHaveLength(1);
  });
});

describe('no open leg — the comment is still written, and that is not an error', () => {
  it('a card on no run answers recorded: false with its comment and no event', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);

    const result = await record(c.key, [POINT], fx.ctx);

    expect(result.recorded).toBe(false);
    const comments = await adminDb.comment.findMany({ where: { workItemId: c.id } });
    expect(comments.map((x) => x.id)).toEqual([result.commentId]);
    expect(await adminDb.dispatchRunEvent.count({ where: { kind: 'discrepancy_recorded' } })).toBe(
      0,
    );
  });

  it('a leg on a CLOSED run is not open', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const runId = await openLegs(fx, [c.key], fx.ctx);
    await dispatchRunService.close(runId, { stopReason: 'completed' }, fx.ctx);

    expect((await record(c.key, [POINT], fx.ctx)).recorded).toBe(false);
  });
});

describe('the edges', () => {
  it('a key with no dash and a key of an unknown project are both WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    await expect(record('NODASH', [POINT], fx.ctx)).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(record('NOPE-1', [POINT], fx.ctx)).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('a point with a MISSING field is refused as an empty field', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await expect(record(c.key, [{ planAsked: 'a', built: 'b' }], fx.ctx)).rejects.toBeInstanceOf(
      RunDiscrepancyInvalidError,
    );
  });

  it('a call made through an automation rule still records', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const result = await record(c.key, [POINT], { ...fx.ctx, viaAutomationRuleId: 'rule-1' });
    expect(result.commentId).toEqual(expect.any(String));
  });

  it('a run already at the event cap keeps the comment and answers recorded: false', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const runId = await openLegs(fx, [c.key], fx.ctx);
    await adminDb.dispatchRunEvent.createMany({
      data: Array.from({ length: DISPATCH_RUN_EVENT_LIMIT }, (_, i) => ({
        workspaceId: fx.workspaceId,
        dispatchRunId: runId,
        seq: 100_000 + i,
        kind: 'card_claimed' as const,
        reportedBy: 'cli' as const,
        data: {},
      })),
    });

    const result = await record(c.key, [POINT], fx.ctx);

    expect(result.recorded).toBe(false);
    expect(await findings(c.id)).toHaveLength(0);
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(1);
  });
});

describe('who may record', () => {
  it('a member holding exactly CLI_TOKEN_GRANT may', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await memberWithRole(fx, 'CLI agent', CLI_TOKEN_GRANT);
    const c = await card(fx);

    expect(CLI_TOKEN_GRANT).toContain('work_item:edit');
    expect((await record(c.key, [POINT], cli)).commentId).toEqual(expect.any(String));
  });

  it('a member who may only browse is refused and nothing is written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const viewer = await memberWithRole(fx, 'Viewer', ['project:browse']);
    const c = await card(fx);

    await expect(record(c.key, [POINT], viewer)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await adminDb.comment.count()).toBe(0);
  });

  it('an unknown card key is a WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    await expect(record('CUST-9999', [POINT], fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});
