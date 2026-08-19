import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { describeInFlight, inFlightBackends } from '../helpers/inFlightWork';

// MOTIR-3066 — the CI flake was `truncateAuthTables` dying on `40P01 deadlock
// detected` in a `beforeEach`, killing a test whose body never ran. The
// deadlock is real and it is not between two resets: Postgres named the two
// transactions, and the other side was an ordinary bound READ.
//
//   Process A: SELECT … FROM "project" …          waits AccessShareLock on workspace_membership
//   Process B: TRUNCATE … "workspace_membership" … waits AccessExclusiveLock on project
//
// The read was an ABANDONED arm of `getQuickView`'s `Promise.all`. Arm 0 is the
// access gate (`getIssueDetail`); the other arms are `withWorkspaceServiceContext`
// interactive transactions. `Promise.all` rejects the instant the gate throws —
// which is the ordinary 404 path for a foreign, unknown or deleted key — and the
// caller returns, but the sibling arms keep running with nobody awaiting them.
// They outlive the test, and the next test's reset TRUNCATE walks into them.
//
// So this file asserts the invariant the reset depends on, at the one place it
// is cheap and deterministic to check: a REFUSED peek must leave nothing running.
// It fails before the fix (four abandoned transactions, `idle in transaction` on
// `SELECT set_config('app.workspace_id', …)`) and passes after.
//
// It deliberately does NOT touch `quick-view-story-gate.test.ts`, which is where
// the deadlock was OBSERVED and where nothing is wrong.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeScenario(slug: string) {
  const user = await usersService.createUser({
    email: `refused-${slug}@example.com`,
    password: PASSWORD,
    name: 'Alice Chen',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Project ${slug}`,
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

function peek(s: Scenario, identifier: string) {
  return workItemsService.getQuickView(
    s.project.id,
    identifier,
    s.project.accessLevel,
    s.ctx,
    'en',
  );
}

describe('a REFUSED peek leaves no work in flight (MOTIR-3066)', () => {
  it('a cross-workspace key rejects AND abandons no transaction', async () => {
    const owner = await makeScenario('owner');
    const item = await workItemsService.createWorkItem(
      { projectId: owner.project.id, kind: 'task', title: 'Private work' },
      owner.ctx,
    );
    const outsider = await makeScenario('outsider');

    // The gate arm of the fan-out throws — the ordinary 404 path.
    await expect(peek(outsider, item.identifier)).rejects.toBeInstanceOf(WorkItemNotFoundError);

    // …and the moment it does, nothing this worker started may still be running.
    // A leftover here is not a slow query: it is a transaction the caller stopped
    // waiting for, holding locks the next test's reset will collide with.
    const leftover = await inFlightBackends();
    expect(
      leftover,
      `a refused peek left ${leftover.length} backend(s) in flight:\n${describeInFlight(leftover)}`,
    ).toEqual([]);
  });

  it('an unknown key rejects AND abandons no transaction', async () => {
    const s = await makeScenario('unknown');

    await expect(peek(s, `${s.project.identifier}-99999`)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );

    const leftover = await inFlightBackends();
    expect(
      leftover,
      `a refused peek left ${leftover.length} backend(s) in flight:\n${describeInFlight(leftover)}`,
    ).toEqual([]);
  });

  it('a deleted key rejects AND abandons no transaction', async () => {
    const s = await makeScenario('deleted');
    const doomed = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Doomed' },
      s.ctx,
    );
    await workItemsService.deleteWorkItem(doomed.id, s.ctx);

    await expect(peek(s, doomed.identifier)).rejects.toBeInstanceOf(WorkItemNotFoundError);

    const leftover = await inFlightBackends();
    expect(
      leftover,
      `a refused peek left ${leftover.length} backend(s) in flight:\n${describeInFlight(leftover)}`,
    ).toEqual([]);
  });

  it('an ACCEPTED peek still returns the whole payload', async () => {
    // The repair must not change the happy path: the fan-out still costs one
    // round trip, and every option source still arrives.
    const s = await makeScenario('accepted');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Visible' },
      s.ctx,
    );

    const data = await peek(s, item.identifier);

    expect(data.identifier).toBe(item.identifier);
    expect(Array.isArray(data.sprints)).toBe(true);
    expect(Array.isArray(data.projectComponents)).toBe(true);
    expect(Array.isArray(data.members)).toBe(true);
    expect(data.estimation).toBeTruthy();
    expect(data.workflow.statuses.length).toBeGreaterThan(0);
    expect(await inFlightBackends()).toEqual([]);
  });
});
