import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  buildPersonalDataArchive,
  PROJECT_VISITS_FILE,
  PROJECT_VISIT_SHARED_WITH,
} from '@/lib/export/personalDataArchive';
import { projectVisitorRepository } from '@/lib/repositories/projectVisitorRepository';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// A person's VISITOR RECORDS in their data export (Story MOTIR-6170 · MOTIR-6668),
// read back from the archive's zip bytes: one entry per public project they
// consented to share their name and email with, an empty list when there are
// none, and nobody else's data in the file.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function person(label: string) {
  const n = seq++;
  return adminDb.user.create({
    data: {
      email: `pve-${label}-${n}@example.com`,
      name: `PVE ${label} ${n}`,
      emailVerified: true,
    },
  });
}
async function publicProject() {
  const identifier = `PE${seq++}`;
  const fx = await makeWorkItemFixture({ name: `Watched ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData('public'),
  });
  return fx;
}
async function consent(projectId: string, userId: string, at: Date) {
  await db.$transaction((tx) =>
    projectVisitorRepository.upsertConsent({ projectId, userId, at }, tx),
  );
}

async function visitsOf(userId: string) {
  const built = await buildPersonalDataArchive(userId, new Date('2026-09-27T12:00:00.000Z'));
  const entries = unzipSync(built.bytes);
  expect(Object.keys(entries)).toContain(PROJECT_VISITS_FILE);
  const text = strFromU8(entries[PROJECT_VISITS_FILE]!);
  return { built, text, visits: JSON.parse(text) as Array<Record<string, unknown>> };
}

describe('project-visits.json', () => {
  it('lists every public project the person consented on, with its name, key, times and who it was shared with', async () => {
    const a = await publicProject();
    const b = await publicProject();
    const me = await person('me');
    await consent(a.projectId, me.id, new Date('2026-09-20T09:00:00.000Z'));
    await consent(b.projectId, me.id, new Date('2026-09-21T09:00:00.000Z'));

    const { built, visits } = await visitsOf(me.id);
    expect(built.counts.projectVisits).toBe(2);
    expect(visits).toEqual([
      {
        project: { id: a.projectId, name: a.project.name, identifier: a.projectIdentifier },
        consentedAt: '2026-09-20T09:00:00.000Z',
        firstVisitAt: '2026-09-20T09:00:00.000Z',
        lastVisitAt: '2026-09-20T09:00:00.000Z',
        sharedWith: PROJECT_VISIT_SHARED_WITH,
      },
      {
        project: { id: b.projectId, name: b.project.name, identifier: b.projectIdentifier },
        consentedAt: '2026-09-21T09:00:00.000Z',
        firstVisitAt: '2026-09-21T09:00:00.000Z',
        lastVisitAt: '2026-09-21T09:00:00.000Z',
        sharedWith: PROJECT_VISIT_SHARED_WITH,
      },
    ]);
  });

  it('is an empty list, and counted 0, for a person with no records', async () => {
    const me = await person('none');
    const { built, text, visits } = await visitsOf(me.id);
    expect(visits).toEqual([]);
    expect(text.trim()).toBe('[]');
    expect(built.counts.projectVisits).toBe(0);
  });

  it('names no other person — not another visitor, not the project owner', async () => {
    const a = await publicProject();
    const me = await person('me');
    const other = await person('other');
    await consent(a.projectId, me.id, new Date('2026-09-20T09:00:00.000Z'));
    await consent(a.projectId, other.id, new Date('2026-09-20T10:00:00.000Z'));

    const { text } = await visitsOf(me.id);
    for (const needle of [other.email, other.name, a.owner.email, a.owner.name, other.id]) {
      expect(text, `the file names ${needle}`).not.toContain(needle);
    }
    expect(text).not.toContain(me.email);
  });

  it('keeps the record of a project that is no longer public, without naming it', async () => {
    const a = await publicProject();
    const me = await person('me');
    await consent(a.projectId, me.id, new Date('2026-09-20T09:00:00.000Z'));
    await adminDb.project.update({
      where: { id: a.projectId },
      data: projectAccessData('members'),
    });
    const { visits } = await visitsOf(me.id);
    expect(visits).toHaveLength(1);
    expect(visits[0]!['project']).toEqual({ id: a.projectId, name: null, identifier: null });
  });
});
