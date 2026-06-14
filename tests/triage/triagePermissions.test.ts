import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { triageService } from '@/lib/services/triageService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// 6.11.8 — the triage 6.4 PERMISSION matrix. Triage reads gate on `canBrowse`
// and triage WRITES (accept / promote / decline / mark-duplicate / snooze /
// unsnooze) gate on `canEdit`, both via `projectAccessService` (the same gate
// the rest of the app uses). `triageService` lets the typed
// `ProjectAccessDeniedError` propagate (kind 'browse' → 404, kind 'edit' → 403)
// — it does NOT wrap it. So a read-only project `viewer` can SEE the inbox but
// can take NO action on it. This locks that matrix cell; the action post-states
// themselves are in `triageActions.test.ts` (6.11.5). Real Postgres.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface PermScenario {
  fx: WorkItemFixture;
  triagedId: string;
  canonicalId: string;
  /** A workspace member holding the read-only project `viewer` role. */
  viewerCtx: ServiceContext;
}

/**
 * An OPEN project with one active triage item + a second (canonical) triage
 * item for the merge case, plus a workspace member explicitly demoted to the
 * project `viewer` role (browse but not edit). The owner (`fx.ctx`) keeps full
 * edit rights.
 */
async function buildScenario(): Promise<PermScenario> {
  const fx = await makeWorkItemFixture();

  const triaged = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'bug', title: 'Needs triage' },
    fx.ctx,
  );
  const canonical = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'bug', title: 'Canonical' },
    fx.ctx,
  );
  await db.workItem.update({ where: { id: triaged.id }, data: { triagedAt: new Date() } });
  await db.workItem.update({ where: { id: canonical.id }, data: { triagedAt: new Date() } });

  const viewer = await usersService.createUser({
    email: 'viewer@ex.com',
    password: 'hunter2hunter2',
    name: 'Read Only',
  });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });

  return {
    fx,
    triagedId: triaged.id,
    canonicalId: canonical.id,
    viewerCtx: { userId: viewer.id, workspaceId: fx.workspaceId },
  };
}

/** Run `p`, assert it rejected with a `ProjectAccessDeniedError` of `kind`. */
async function expectAccessDenied(p: Promise<unknown>, kind: 'browse' | 'edit'): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected ProjectAccessDeniedError('${kind}') but the call resolved`);
}

describe('triage permissions — a read-only viewer can browse the inbox but not act on it', () => {
  it('lets the viewer READ the triage queue (canBrowse)', async () => {
    const s = await buildScenario();
    const page = await triageService.getTriageQueue(s.fx.projectId, {}, s.viewerCtx);
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(s.triagedId);
    expect(ids).toContain(s.canonicalId);
  });

  it('rejects the viewer on EVERY triage write with ProjectAccessDeniedError(edit) — nothing mutates', async () => {
    const s = await buildScenario();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await expectAccessDenied(triageService.acceptTriageItem(s.triagedId, {}, s.viewerCtx), 'edit');
    await expectAccessDenied(
      triageService.promoteTriageItem(s.triagedId, { parentId: null }, s.viewerCtx),
      'edit',
    );
    await expectAccessDenied(triageService.declineTriageItem(s.triagedId, {}, s.viewerCtx), 'edit');
    await expectAccessDenied(
      triageService.markDuplicateTriageItem(
        s.triagedId,
        { canonicalId: s.canonicalId },
        s.viewerCtx,
      ),
      'edit',
    );
    await expectAccessDenied(
      triageService.snoozeTriageItem(s.triagedId, { snoozedUntil: future }, s.viewerCtx),
      'edit',
    );
    await expectAccessDenied(triageService.unsnoozeTriageItem(s.triagedId, s.viewerCtx), 'edit');

    // The denied writes mutated nothing: the item is still an un-snoozed,
    // un-graduated, non-cancelled triage item.
    const row = await db.workItem.findUniqueOrThrow({ where: { id: s.triagedId } });
    expect(row.triagedAt).not.toBeNull();
    expect(row.snoozedUntil).toBeNull();
    expect(row.parentId).toBeNull();
    expect(row.status).not.toBe('cancelled');
  });

  it('still lets the OWNER (canEdit) act — the gate denies only the viewer', async () => {
    const s = await buildScenario();
    // Same accept the viewer was denied, now as the owner: it graduates.
    const dto = await triageService.acceptTriageItem(s.triagedId, {}, s.fx.ctx);
    expect(dto.id).toBe(s.triagedId);
    const row = await db.workItem.findUniqueOrThrow({ where: { id: s.triagedId } });
    expect(row.triagedAt).toBeNull(); // graduated into the backlog
  });
});
