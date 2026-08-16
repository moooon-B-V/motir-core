import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { importEngineService } from '@/lib/import/engine/importEngineService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-2874 — the DEFAULT member loader, against a real Postgres.
//
// `tests/import/importEngineService.test.ts` covers the engine with every read
// seam INJECTED, which is the right shape for the classifier and is precisely
// why this defect survived: `defaultLoadMembers` — the seam's production
// fallback — was never executed by any test. It opened a bare `db.$transaction`
// and read `workspace_membership` inside it, and
// `membership_visible_active_or_own` admits a row only on `"workspaceId" =
// app.workspace_id` OR `"userId" = app.user_id`. Bound to neither, the read
// returned `[]` under `motir_app`: `buildResolveContext`'s email→user map came
// back empty and every imported issue silently resolved to NO assignee.
//
// So these cases deliberately do NOT inject `loadMembers`. They inject only
// `loadStatuses`, so the workflow half needs no project fixture and the member
// half runs the real repository through the real context tier
// (`withWorkspaceServiceContext`, which binds `app.workspace_id` — the arm a
// userless trusted import path has to rely on).
//
// The assertions are ADMIT assertions: a NON-EMPTY map. An RLS-denied SELECT
// returns fewer rows and raises nothing, so an empty map is an ordinary-looking
// answer — which is what made this class invisible to both `singletonReadScan`
// and `callSiteScan`. Each of those asks whether a read takes and is passed a
// `tx`; this read is and was. Neither asks what the transaction BOUND.

const STATUSES: WorkflowStatusDto[] = [
  {
    id: 'ws-todo',
    projectId: 'project-not-read-here',
    key: 'todo',
    label: 'To Do',
    category: 'todo',
    color: null,
    position: 'a0',
    isInitial: true,
  },
];

const loadStatuses = async () => STATUSES;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeUser(email: string, name: string) {
  return usersService.createUser({ email, password: 'hunter2hunter2', name });
}

describe('importEngineService.buildResolveContext — the default member loader (MOTIR-2874)', () => {
  it('resolves every workspace member into membersByEmail, lowercased', async () => {
    const owner = await makeUser('Owner@Example.com', 'Owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Importing Co',
      ownerUserId: owner.id,
    });
    const teammate = await makeUser('Teammate@Example.com', 'Teammate');
    await workspacesService.addMember({ userId: teammate.id, workspaceId: workspace.id });

    const ctx = await importEngineService.buildResolveContext(
      'project-not-read-here',
      workspace.id,
      owner.id,
      { loadStatuses },
    );

    // Non-empty is the whole assertion. An unbound read makes this map size 0,
    // and size 0 is a perfectly ordinary answer for a workspace with no members.
    expect(ctx.membersByEmail.size).toBe(2);
    expect(ctx.membersByEmail.get('owner@example.com')).toBe(owner.id);
    expect(ctx.membersByEmail.get('teammate@example.com')).toBe(teammate.id);
  });

  it('does NOT leak members of another workspace into the map', async () => {
    // The bound read is scoped by `app.workspace_id`, so the admit assertion
    // above must not be reachable by admitting everything. Two tenants, one
    // context: the other tenant's member is absent.
    const mine = await makeUser('mine@example.com', 'Mine');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Mine Co',
      ownerUserId: mine.id,
    });
    const theirs = await makeUser('theirs@example.com', 'Theirs');
    await workspacesService.createWorkspace({ name: 'Theirs Co', ownerUserId: theirs.id });

    const ctx = await importEngineService.buildResolveContext(
      'project-not-read-here',
      workspace.id,
      mine.id,
      { loadStatuses },
    );

    expect(ctx.membersByEmail.get('mine@example.com')).toBe(mine.id);
    expect(ctx.membersByEmail.has('theirs@example.com')).toBe(false);
  });

  it('carries the resolved map into an assignee on the classified row', async () => {
    // The consequence, end to end: this is what "every imported issue silently
    // resolves to no assignee" actually looks like when it is working.
    const owner = await makeUser('lead@example.com', 'Lead');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Assignee Co',
      ownerUserId: owner.id,
    });

    const ctx = await importEngineService.buildResolveContext(
      'project-not-read-here',
      workspace.id,
      owner.id,
      { loadStatuses },
    );
    const row = await importEngineService.classifyIssue(
      'github',
      {
        externalId: 'X-1',
        title: 'Imported',
        descriptionMd: null,
        type: null,
        status: null,
        priority: null,
        assigneeEmail: 'LEAD@example.com',
        assigneeName: 'Lead',
        reporterEmail: null,
        reporterName: null,
        labels: [],
        comments: [],
        attachments: [],
        parentExternalId: null,
        links: [],
        createdAt: null,
        closedAt: null,
      },
      {},
      ctx,
      { lookupExisting: async () => null },
    );

    expect(row.payload.assigneeId).toBe(owner.id);
  });
});
