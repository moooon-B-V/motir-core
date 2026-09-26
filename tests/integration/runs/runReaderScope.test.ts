import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { isEnforced, type PermissionKey } from '@/lib/permissions/catalog';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { DispatchRunNotFoundError } from '@/lib/dispatchRuns/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs, setProjectRoleDefinitionFor } from '../../helpers/workspaceRoleFixtures';

// Story MOTIR-6179 · MOTIR-6331 — the run reads take a SCOPE. `project` for a
// reader holding `run:view_any` (on a token: in its grant too); `mine` — the
// runs the reader STARTED — for anyone who browses. One run outside the
// reader's scope is the same not-found an unknown id is. Real Postgres, the
// real resolver.

let fx: WorkItemFixture;
let seq = 0;

async function seat(role: 'member' | 'viewer'): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `runscope-${role}-${seq++}@example.com`,
    password: 'correct-horse-battery-staple',
    name: `Reader ${role}`,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role,
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

async function seatCustom(permissions: PermissionKey[]): Promise<ServiceContext> {
  const ctx = await seat('member');
  const role = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: fx.workspaceId,
      name: `Custom ${seq++}`,
      permissions,
    },
  });
  await adminDb.$transaction((tx) =>
    setProjectRoleDefinitionFor(
      ctx.userId,
      fx.projectId,
      { roleDefinitionId: role.id, role: CUSTOM_ROLE_TIER },
      tx,
    ),
  );
  return ctx;
}

let story: { id: string; identifier: string };
let card: string;

async function openRun(ctx: ServiceContext, opts: { scopeKey?: string } = {}): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'batch',
      ...(opts.scopeKey ? { scopeKey: opts.scopeKey } : {}),
      cards: [{ key: card, disposition: 'queued' as const }],
    },
    ctx,
  );
  return run.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'A story runs work' },
    fx.ctx,
  );
  card = (
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'A card' },
      fx.ctx,
    )
  ).identifier;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const EDITOR_WITHOUT_VIEW: PermissionKey[] = ['project:browse', 'work_item:edit'];

describe('the index resolves a SERVED scope', () => {
  it('a Member is served `project` (every run); `mine` narrows to the runs they started', async () => {
    const member = await seat('member');
    const theirs = await openRun(fx.ctx);
    const mine = await openRun(member);

    const project = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10, view: 'project' },
      member,
    );
    expect(project.scope).toBe('project');
    expect(project.runs.map((r) => r.id).sort()).toEqual([theirs, mine].sort());

    const own = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10, view: 'mine' },
      member,
    );
    expect(own).toMatchObject({ scope: 'mine' });
    expect(own.runs.map((r) => r.id)).toEqual([mine]);
  });

  it('a Viewer is served `project`', async () => {
    const viewer = await seat('viewer');
    const theirs = await openRun(fx.ctx);
    const page = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10 },
      viewer,
    );
    expect(page.scope).toBe('project');
    expect(page.runs.map((r) => r.id)).toEqual([theirs]);
  });

  it('an editor WITHOUT `run:view_any` asking for `project` is served `mine`', async () => {
    const editor = await seatCustom(EDITOR_WITHOUT_VIEW);
    await openRun(fx.ctx);
    const own = await openRun(editor);
    const page = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10, view: 'project' },
      editor,
    );
    expect(page.scope).toBe('mine');
    expect(page.runs.map((r) => r.id)).toEqual([own]);

    const active = await dispatchRunService.listActiveRunsForProject(fx.projectIdentifier, editor);
    expect(active.scope).toBe('mine');
    expect(active.runs.map((r) => r.id)).toEqual([own]);

    const history = await dispatchRunService.listRunsForWorkItemKey(card, { take: 10 }, editor);
    expect(history.map((r) => r.id)).toEqual([own]);
  });

  it('a reader holding neither key is served `mine`, and it is empty', async () => {
    const reader = await seatCustom(['project:browse']);
    await openRun(fx.ctx);
    const page = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10 },
      reader,
    );
    expect(page).toEqual({ scope: 'mine', runs: [] });
  });

  it('`scopeWorkItemKey` and `view: mine` compose — the reader’s own runs of that work item only', async () => {
    const member = await seat('member');
    await openRun(fx.ctx, { scopeKey: story.identifier });
    const mineScoped = await openRun(member, { scopeKey: story.identifier });
    await openRun(member);
    const page = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10, view: 'mine', scopeWorkItemKey: story.identifier },
      member,
    );
    expect(page.runs.map((r) => r.id)).toEqual([mineScoped]);
  });

  it('a bearer token whose GRANT lacks `run:view_any` is served `mine`', async () => {
    const member = await seat('member');
    await openRun(fx.ctx);
    const own = await openRun(member);
    const page = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10, view: 'project' },
      { ...member, tokenGrant: ['project:browse', 'work_item:edit'] },
    );
    expect(page.scope).toBe('mine');
    expect(page.runs.map((r) => r.id)).toEqual([own]);
  });
});

describe('one run outside the reader’s scope is NOT-FOUND, identical to an unknown id', () => {
  it('getRunDetail, readStreamPage and getRun refuse a colleague’s run and serve one’s own', async () => {
    const editor = await seatCustom(EDITOR_WITHOUT_VIEW);
    const theirs = await openRun(fx.ctx);
    const own = await openRun(editor);

    for (const read of [
      (id: string) => dispatchRunService.getRunDetail(id, editor),
      (id: string) => dispatchRunService.readStreamPage(id, 0, 10, editor),
      (id: string) => dispatchRunService.getRun(id, editor),
    ]) {
      await expect(read(theirs)).rejects.toBeInstanceOf(DispatchRunNotFoundError);
      await expect(read('no-such-run')).rejects.toBeInstanceOf(DispatchRunNotFoundError);
      await expect(read(own)).resolves.toBeDefined();
    }
  });

  it('a Viewer reads a colleague’s run', async () => {
    const viewer = await seat('viewer');
    const theirs = await openRun(fx.ctx);
    expect((await dispatchRunService.getRunDetail(theirs, viewer)).id).toBe(theirs);
  });
});

describe('the CLI keeps working', () => {
  it('a CLI_TOKEN_GRANT caller opens, streams to and closes a run, and reads it and the project’s runs back', async () => {
    const cli: ServiceContext = { ...fx.ctx, tokenGrant: [...CLI_TOKEN_GRANT] };
    const other = await seat('member');
    const colleague = await openRun(other);
    const runId = await openRun(cli);
    const appended = await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'run_opened' }, { kind: 'card_claimed', workItemKey: card }],
      cli,
    );
    expect(appended.appended).toBe(2);
    const stream = await dispatchRunService.readStreamPage(runId, 0, 10, cli);
    expect(stream.events).toHaveLength(2);
    await dispatchRunService.close(runId, { stopReason: 'completed' }, cli);
    expect((await dispatchRunService.getRun(runId, cli)).id).toBe(runId);
    const page = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10 },
      cli,
    );
    expect(page.scope).toBe('project');
    expect(page.runs.map((r) => r.id).sort()).toEqual([colleague, runId].sort());
  });

  it('`run:view_any` is enforced and grantable, and the CLI grant is entirely grantable', () => {
    expect(isEnforced('run:view_any')).toBe(true);
    expect(GRANTABLE_PERMISSIONS).toContain('run:view_any');
    for (const key of CLI_TOKEN_GRANT) expect(GRANTABLE_PERMISSIONS).toContain(key);
  });
});
