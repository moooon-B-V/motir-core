import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectVisitorRepository } from '@/lib/repositories/projectVisitorRepository';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The VISITOR RECORD's repository (Story MOTIR-6170 · MOTIR-6665), against the
// real database: one row per (person, project) however often they consent, a
// latest visit that only moves forward, a Managers' list that pages without
// skipping or repeating, and rows that go with the person and with the project.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function person(name = 'Visitor') {
  const n = seq++;
  return adminDb.user.create({
    data: { email: `pv-${n}@example.com`, name, emailVerified: true },
  });
}
/** A PUBLIC project — the only kind a visitor record is written on. */
async function project() {
  const identifier = `PV${seq++}`;
  const fx = await makeWorkItemFixture({ name: `PV ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData('public'),
  });
  return fx;
}
const t0 = new Date('2026-09-27T10:00:00.000Z');
const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe('upsertConsent', () => {
  it('two consents leave ONE row: the first consent and first visit, the second latest visit', async () => {
    const fx = await project();
    const u = await person();
    await db.$transaction((tx) =>
      projectVisitorRepository.upsertConsent({ projectId: fx.projectId, userId: u.id, at: t0 }, tx),
    );
    await db.$transaction((tx) =>
      projectVisitorRepository.upsertConsent(
        { projectId: fx.projectId, userId: u.id, at: later(5) },
        tx,
      ),
    );
    const rows = await adminDb.projectVisitor.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consentedAt).toEqual(t0);
    expect(rows[0]!.firstVisitAt).toEqual(t0);
    expect(rows[0]!.lastVisitAt).toEqual(later(5));
  });

  it('concurrent consents make one row and raise nothing', async () => {
    const fx = await project();
    const u = await person();
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        db.$transaction((tx) =>
          projectVisitorRepository.upsertConsent(
            { projectId: fx.projectId, userId: u.id, at: later(i) },
            tx,
          ),
        ),
      ),
    );
    expect(await adminDb.projectVisitor.count({ where: { projectId: fx.projectId } })).toBe(1);
  });
});

describe('touchLastVisit', () => {
  it('moves the latest visit forward, and an older moment changes nothing', async () => {
    const fx = await project();
    const u = await person();
    await db.$transaction((tx) =>
      projectVisitorRepository.upsertConsent(
        { projectId: fx.projectId, userId: u.id, at: later(10) },
        tx,
      ),
    );
    const older = await db.$transaction((tx) =>
      projectVisitorRepository.touchLastVisit(
        { projectId: fx.projectId, userId: u.id, at: t0 },
        tx,
      ),
    );
    expect(older).toBe(0);
    const newer = await db.$transaction((tx) =>
      projectVisitorRepository.touchLastVisit(
        { projectId: fx.projectId, userId: u.id, at: later(20) },
        tx,
      ),
    );
    expect(newer).toBe(1);
    const row = await projectVisitorRepository.findByProjectAndUser(fx.projectId, u.id);
    expect(row!.lastVisitAt).toEqual(later(20));
    expect(row!.firstVisitAt).toEqual(later(10));
  });

  it('touches nothing for a person with no record', async () => {
    const fx = await project();
    const u = await person();
    const n = await db.$transaction((tx) =>
      projectVisitorRepository.touchLastVisit(
        { projectId: fx.projectId, userId: u.id, at: t0 },
        tx,
      ),
    );
    expect(n).toBe(0);
    expect(await projectVisitorRepository.findByProjectAndUser(fx.projectId, u.id)).toBeNull();
  });
});

describe('listByProject', () => {
  it('returns name and email, newest latest visit first, and pages without skipping or repeating', async () => {
    const fx = await project();
    const people = await Promise.all([0, 1, 2, 3, 4].map((i) => person(i === 2 ? '' : `P${i}`)));
    for (const [i, u] of people.entries()) {
      // Two share a latest visit, so the id tiebreak is exercised.
      const at = later(i === 4 ? 3 : i);
      await db.$transaction((tx) =>
        projectVisitorRepository.upsertConsent({ projectId: fx.projectId, userId: u.id, at }, tx),
      );
    }
    const seen: string[] = [];
    let cursor: { lastVisitAt: Date; id: string } | null = null;
    for (;;) {
      const page = await projectVisitorRepository.listByProject({
        projectId: fx.projectId,
        cursor,
        limit: 2,
      });
      if (page.length === 0) break;
      for (const row of page) seen.push(row.userId);
      const last = page[page.length - 1]!;
      cursor = { lastVisitAt: last.lastVisitAt, id: last.id };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const all = await projectVisitorRepository.listByProject({
      projectId: fx.projectId,
      limit: 10,
    });
    const times = all.map((r) => r.lastVisitAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const nameless = all.find((r) => r.userId === people[2]!.id)!;
    expect(nameless.name).toBe('');
    expect(nameless.email).toBe(people[2]!.email);
    expect(await projectVisitorRepository.countByProject(fx.projectId)).toBe(5);
  });
});

describe('the records go with the person and with the project', () => {
  it('deleting the person removes their records; deleting the project removes its records', async () => {
    const a = await project();
    const b = await project();
    const u = await person();
    const v = await person();
    for (const [fx, who] of [
      [a, u],
      [b, u],
      [a, v],
    ] as const) {
      await db.$transaction((tx) =>
        projectVisitorRepository.upsertConsent(
          { projectId: fx.projectId, userId: who.id, at: t0 },
          tx,
        ),
      );
    }
    expect(await projectVisitorRepository.listByUser(u.id)).toHaveLength(2);

    await adminDb.user.delete({ where: { id: u.id } });
    expect(await adminDb.projectVisitor.count({ where: { userId: u.id } })).toBe(0);
    expect(await adminDb.projectVisitor.count({ where: { userId: v.id } })).toBe(1);

    await adminDb.project.delete({ where: { id: a.projectId } });
    expect(await adminDb.projectVisitor.count({ where: { projectId: a.projectId } })).toBe(0);
  });

  it('listByUser names the project each record is about', async () => {
    const fx = await project();
    const u = await person();
    await db.$transaction((tx) =>
      projectVisitorRepository.upsertConsent({ projectId: fx.projectId, userId: u.id, at: t0 }, tx),
    );
    const own = await projectVisitorRepository.listByUser(u.id);
    expect(own).toEqual([
      expect.objectContaining({
        projectId: fx.projectId,
        projectIdentifier: fx.projectIdentifier,
        consentedAt: t0,
      }),
    ]);
  });

  it('a project that is no longer public keeps the record but names nothing', async () => {
    const fx = await project();
    const u = await person();
    await db.$transaction((tx) =>
      projectVisitorRepository.upsertConsent({ projectId: fx.projectId, userId: u.id, at: t0 }, tx),
    );
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('members'),
    });
    const own = await projectVisitorRepository.listByUser(u.id);
    expect(own).toHaveLength(1);
    expect(own[0]!.projectId).toBe(fx.projectId);
  });
});
