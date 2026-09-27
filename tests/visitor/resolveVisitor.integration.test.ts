import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectAccessMode } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { VISITOR_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { levelForMode } from '@/lib/projects/accessMode';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The Visitor's ONE resolution (Story MOTIR-6170 · MOTIR-6642), through the real
// resolver and datastore: `not_found` for everything a stranger must not be able
// to tell apart, `enter` for a person who belongs in their own view, and
// `visitor` — with the private-epic hidden set — for everyone else.

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const session = (id: string) => ({ user: { id } });

async function user(label: string) {
  const n = seq++;
  return adminDb.user.create({
    data: { email: `rv-${label}-${n}@example.com`, name: `RV ${label}`, emailVerified: true },
  });
}

/** A project in `mode`, with a Manager (the fixture owner), a Full member and a Limited member. */
async function tenant(mode: ProjectAccessMode = 'public') {
  const identifier = `RV${seq++}`;
  const fx = await makeWorkItemFixture({ name: `RV ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { accessMode: mode, accessLevel: levelForMode(mode) },
  });
  const full = await user('full');
  const limited = await user('limited');
  const limitedAdded = await user('limited-added');
  for (const [u, accessScope] of [
    [full, 'full'],
    [limited, 'limited'],
    [limitedAdded, 'limited'],
  ] as const) {
    await adminDb.workspaceMembership.create({
      data: {
        userId: u.id,
        workspaceId: fx.workspaceId,
        role: 'member',
        workspaceRole: 'member',
        accessScope,
      },
    });
  }
  await adminDb.projectMembership.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      userId: limitedAdded.id,
      role: 'member',
    },
  });
  return { fx, identifier, full, limited, limitedAdded };
}

describe('not_found — one indistinguishable answer', () => {
  it('cloud off, an unknown identifier, a workspace project and a members project are deep-equal', async () => {
    const pub = await tenant('public');
    const ws = await tenant('workspace');
    const members = await tenant('members');

    process.env['MOTIR_CLOUD'] = 'false';
    const cloudOff = await projectAccessService.resolveVisitor(pub.identifier, null);
    process.env['MOTIR_CLOUD'] = 'true';
    const unknown = await projectAccessService.resolveVisitor('NOPE404', null);
    const workspaceMode = await projectAccessService.resolveVisitor(ws.identifier, null);
    const membersMode = await projectAccessService.resolveVisitor(members.identifier, null);

    expect(cloudOff).toEqual({ kind: 'not_found' });
    expect(unknown).toEqual(cloudOff);
    expect(workspaceMode).toEqual(cloudOff);
    expect(membersMode).toEqual(cloudOff);
  });

  it('a member of a non-public project still gets not_found — the Visitor URL is not their door', async () => {
    const ws = await tenant('workspace');
    const verdict = await projectAccessService.resolveVisitor(ws.identifier, session(ws.full.id));
    expect(verdict).toEqual({ kind: 'not_found' });
  });
});

describe('enter — a person who can enter the public project', () => {
  it('answers enter for the Manager, a Full member and an added Limited member', async () => {
    const t = await tenant('public');
    for (const who of [t.fx.ownerId, t.full.id, t.limitedAdded.id]) {
      const verdict = await projectAccessService.resolveVisitor(t.identifier, session(who));
      expect(verdict.kind, who).toBe('enter');
      if (verdict.kind === 'enter') expect(verdict.project.id).toBe(t.fx.projectId);
    }
  });
});

describe('visitor — everyone else', () => {
  it('answers visitor for no session, another organisation and a Limited member not added', async () => {
    const t = await tenant('public');
    const other = await tenant('workspace');
    const readers: Array<[string, { user: { id: string } } | null, string | null]> = [
      ['anonymous', null, null],
      ['another organisation', session(other.full.id), other.full.id],
      ['a Limited member not added', session(t.limited.id), t.limited.id],
    ];
    for (const [label, s, actor] of readers) {
      const verdict = await projectAccessService.resolveVisitor(t.identifier, s);
      expect(verdict.kind, label).toBe('visitor');
      if (verdict.kind !== 'visitor') continue;
      expect(verdict.ctx.kind).toBe('visitor');
      expect(verdict.ctx.project.id).toBe(t.fx.projectId);
      expect(verdict.ctx.actorUserId, label).toBe(actor);
      expect([...verdict.ctx.permissions].sort()).toEqual([...VISITOR_PERMISSIONS].sort());
    }
  });

  it('carries the private-epic hidden set, equal to findPublicHiddenDescendantIds', async () => {
    const t = await tenant('public');
    const privateEpic = await createTestWorkItem(t.fx, { kind: 'epic', title: 'Private epic' });
    const a = await createTestWorkItem(t.fx, {
      kind: 'story',
      title: 'Hidden A',
      parentId: privateEpic.id,
    });
    const b = await createTestWorkItem(t.fx, {
      kind: 'story',
      title: 'Hidden B',
      parentId: privateEpic.id,
    });
    const openEpic = await createTestWorkItem(t.fx, { kind: 'epic', title: 'Open epic' });
    await adminDb.workItem.update({
      where: { id: privateEpic.id },
      data: { publicChildrenHidden: true },
    });

    const verdict = await projectAccessService.resolveVisitor(t.identifier, null);
    expect(verdict.kind).toBe('visitor');
    if (verdict.kind !== 'visitor') return;
    const expected = await withWorkspaceServiceContext(t.fx.workspaceId, (tx) =>
      workItemRepository.findPublicHiddenDescendantIds(t.fx.projectId, t.fx.workspaceId, tx),
    );
    expect([...verdict.ctx.hiddenIds].sort()).toEqual([...expected].sort());
    expect([...verdict.ctx.hiddenIds].sort()).toEqual([a.id, b.id].sort());
    // The private epic's OWN row stays visible (epic-privacy.md §4), and so does an open epic.
    expect(verdict.ctx.hiddenIds.has(privateEpic.id)).toBe(false);
    expect(verdict.ctx.hiddenIds.has(openEpic.id)).toBe(false);
  });
});
