import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectAccessMode } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { VISITOR_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectVisitorRepository } from '@/lib/repositories/projectVisitorRepository';
import { visitorRecordsService } from '@/lib/services/visitorRecordsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { VisitorConsentNotApplicableError } from '@/lib/visitor/errors';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { consentedVisitor } from './_consentedVisitor';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The Visitor's ONE resolution (Story MOTIR-6170 · MOTIR-6642), through the real
// resolver and datastore: `not_found` for everything a stranger must not be able
// to tell apart, `enter` for a person who belongs in their own view, and
// `visitor` — with the private-epic hidden set — for everyone else.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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
    data: projectAccessData(mode),
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
    },
  });
  return { fx, identifier, full, limited, limitedAdded };
}

describe('not_found — one indistinguishable answer, asked before the session', () => {
  it('cloud off, an unknown identifier, a workspace project and a members project are deep-equal, signed out or in', async () => {
    const pub = await tenant('public');
    const ws = await tenant('workspace');
    const members = await tenant('members');
    const stranger = await user('stranger');

    process.env['MOTIR_CLOUD'] = 'false';
    const cloudOff = await projectAccessService.resolveVisitor(pub.identifier, null);
    process.env['MOTIR_CLOUD'] = 'true';
    const answers = [
      cloudOff,
      await projectAccessService.resolveVisitor('NOPE404', null),
      await projectAccessService.resolveVisitor(ws.identifier, null),
      await projectAccessService.resolveVisitor(members.identifier, null),
      await projectAccessService.resolveVisitor(ws.identifier, session(stranger.id)),
      await projectAccessService.resolveVisitor(members.identifier, session(stranger.id)),
    ];
    for (const answer of answers) expect(answer).toEqual({ kind: 'not_found' });
  });

  it('a member of a non-public project still gets not_found — the Visitor URL is not their door', async () => {
    const ws = await tenant('workspace');
    const verdict = await projectAccessService.resolveVisitor(ws.identifier, session(ws.full.id));
    expect(verdict).toEqual({ kind: 'not_found' });
  });
});

describe('sign_in — a public project and no session', () => {
  it('answers sign_in carrying only the key', async () => {
    const t = await tenant('public');
    const verdict = await projectAccessService.resolveVisitor(t.identifier, null);
    expect(verdict).toEqual({ kind: 'sign_in', identifier: t.identifier });
  });
});

describe('enter — a person who can enter the public project', () => {
  it('answers enter for the Manager, a Full member and an added Limited member, and never asks consent', async () => {
    const t = await tenant('public');
    for (const who of [t.fx.ownerId, t.full.id, t.limitedAdded.id]) {
      const verdict = await projectAccessService.resolveVisitor(t.identifier, session(who));
      expect(verdict.kind, who).toBe('enter');
      if (verdict.kind === 'enter') expect(verdict.project.id).toBe(t.fx.projectId);
    }
  });

  it('refuses their consent and writes nothing', async () => {
    const t = await tenant('public');
    await expect(
      visitorRecordsService.recordConsent({ identifier: t.identifier, userId: t.full.id }),
    ).rejects.toBeInstanceOf(VisitorConsentNotApplicableError);
    expect(await adminDb.projectVisitor.count({ where: { projectId: t.fx.projectId } })).toBe(0);
  });
});

describe('consent — signed in, cannot enter, not yet consented', () => {
  it('answers consent for another organisation and a Limited member not added, with only what the screen says', async () => {
    const t = await tenant('public');
    const other = await tenant('workspace');
    for (const who of [other.full.id, t.limited.id]) {
      const verdict = await projectAccessService.resolveVisitor(t.identifier, session(who));
      expect(verdict.kind, who).toBe('consent');
      if (verdict.kind !== 'consent') continue;
      expect(Object.keys(verdict.subject).sort()).toEqual(
        ['identifier', 'projectName', 'workspaceName'].sort(),
      );
      expect(verdict.subject.identifier).toBe(t.identifier);
      expect(verdict.subject.workspaceName).toBe(t.fx.workspace.name);
      expect(JSON.stringify(verdict)).not.toContain('hiddenIds');
    }
  });

  it('refuses a consent on a project that is not public, as not found', async () => {
    const ws = await tenant('workspace');
    const stranger = await user('stranger');
    await expect(
      visitorRecordsService.recordConsent({ identifier: ws.identifier, userId: stranger.id }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('visitor — signed in, cannot enter, consented', () => {
  it('after the consent the same person is a visitor; a second consent keeps one row and the first consent time', async () => {
    const t = await tenant('public');
    const other = await tenant('workspace');
    const who = other.full.id;
    const first = new Date('2026-09-27T10:00:00.000Z');
    await visitorRecordsService.recordConsent({
      identifier: t.identifier,
      userId: who,
      now: first,
    });
    await visitorRecordsService.recordConsent({
      identifier: t.identifier,
      userId: who,
      now: new Date('2026-09-27T10:05:00.000Z'),
    });
    const rows = await adminDb.projectVisitor.findMany({ where: { projectId: t.fx.projectId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consentedAt).toEqual(first);

    const verdict = await projectAccessService.resolveVisitor(t.identifier, session(who));
    expect(verdict.kind).toBe('visitor');
    if (verdict.kind !== 'visitor') return;
    expect(verdict.ctx.project.id).toBe(t.fx.projectId);
    expect(verdict.ctx.actorUserId).toBe(who);
    expect([...verdict.ctx.permissions].sort()).toEqual([...VISITOR_PERMISSIONS].sort());
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

    const ctx = await consentedVisitor(t.identifier);
    const expected = await withWorkspaceServiceContext(t.fx.workspaceId, (tx) =>
      workItemRepository.findPublicHiddenDescendantIds(t.fx.projectId, t.fx.workspaceId, tx),
    );
    expect([...ctx.hiddenIds].sort()).toEqual([...expected].sort());
    expect([...ctx.hiddenIds].sort()).toEqual([a.id, b.id].sort());
    // The private epic's OWN row stays visible (epic-privacy.md §4), and so does an open epic.
    expect(ctx.hiddenIds.has(privateEpic.id)).toBe(false);
    expect(ctx.hiddenIds.has(openEpic.id)).toBe(false);
  });
});

describe('the latest visit', () => {
  async function consentedAt(minutesAgo: number) {
    const t = await tenant('public');
    const other = await tenant('workspace');
    const who = other.full.id;
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await visitorRecordsService.recordConsent({ identifier: t.identifier, userId: who, now: at });
    return { t, who, at };
  }
  const lastVisit = async (projectId: string, userId: string) =>
    (await adminDb.projectVisitor.findFirstOrThrow({ where: { projectId, userId } })).lastVisitAt;

  it('a read 11 minutes after the last visit moves it; one 2 minutes after does not', async () => {
    const stale = await consentedAt(11);
    await projectAccessService.resolveVisitor(stale.t.identifier, session(stale.who));
    expect((await lastVisit(stale.t.fx.projectId, stale.who)).getTime()).toBeGreaterThan(
      stale.at.getTime(),
    );

    const fresh = await consentedAt(2);
    await projectAccessService.resolveVisitor(fresh.t.identifier, session(fresh.who));
    expect(await lastVisit(fresh.t.fx.projectId, fresh.who)).toEqual(fresh.at);
  });

  it('a touch that throws leaves the verdict visitor', async () => {
    const stale = await consentedAt(30);
    const spy = vi
      .spyOn(projectVisitorRepository, 'touchLastVisit')
      .mockRejectedValueOnce(new Error('store down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const verdict = await projectAccessService.resolveVisitor(
        stale.t.identifier,
        session(stale.who),
      );
      expect(verdict.kind).toBe('visitor');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});
