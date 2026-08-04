import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { truncateAuthTables } from '../helpers/db';

// Bug MOTIR-2050 — the peek payload's ARCHIVED state, read BACK through the
// consumer DTO. The peek's missing archived signal had a precise cause:
// `QuickViewData` carried no archived field, so the panel could not render one
// even though the aggregate the mapper receives already holds both facts
// (`item.archivedAt` + the `archivedBy` actor the detail banner reads). This
// asserts they survive the whole read — archive → getQuickView → QuickViewData —
// rather than testing the mapper against a hand-built fixture that could not
// catch the archived REVISION actor resolving wrong. Real Postgres.

const PASSWORD = 'hunter2hunter2';

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Alice Chen' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('getQuickView().archived — the peek payload carries the archived state (MOTIR-2050)', () => {
  it('a LIVE item reads back `archived: null`', async () => {
    const s = await makeScenario('peek-live@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Still live' },
      s.ctx,
    );

    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessLevel,
      s.ctx,
      'en',
    );

    expect(peek.archived).toBeNull();
  });

  it('an ARCHIVED item reads back WHO archived it and WHEN, formatted for display', async () => {
    const s = await makeScenario('peek-archived@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Archived work' },
      s.ctx,
    );
    await workItemsService.archiveWorkItem(item.id, s.ctx);

    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessLevel,
      s.ctx,
      'en',
    );

    // The WHO comes from the latest `'archived'` revision (the same source the
    // detail page's banner names); the WHEN is pre-formatted server-side, like
    // every other display label the peek carries.
    expect(peek.archived).not.toBeNull();
    expect(peek.archived?.byName).toBe('Alice Chen');
    expect(peek.archived?.atLabel).toMatch(/\d{4}/);

    // The status is untouched by archiving — which is exactly why the panel
    // cannot gate readiness on status alone.
    expect(peek.statusCategory).toBe('todo');
  });

  it('a RESTORED item goes back to `archived: null`', async () => {
    const s = await makeScenario('peek-restored@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Back from the archive' },
      s.ctx,
    );
    await workItemsService.archiveWorkItem(item.id, s.ctx);
    await workItemsService.unarchiveWorkItem(item.id, s.ctx);

    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessLevel,
      s.ctx,
      'en',
    );

    expect(peek.archived).toBeNull();
  });
});
