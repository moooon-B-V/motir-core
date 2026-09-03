import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-3875 · MOTIR-4243 — `projectsService.getPublicHero`, the read the
// **Settings › Project › Public page** room starts from.
//
// It is `getPublicOverview` WIDENED. That method returned the README body alone
// and was the 6.12.8 read for the in-place editor on the app-hosted public page;
// MOTIR-3951 deleted that page and took its last caller with it, leaving a
// tested, transaction-owning method that nothing called — which compiles and
// passes for ever while the capability is simply gone. The room needs all three
// hero fields, so the read is widened rather than joined by a second one running
// the same query.
//
// Real Postgres, per the repo convention: the three fields are independently
// nullable at the COLUMN, and a mock would assert the shape this file exists to
// read off the schema.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('projectsService.getPublicHero (MOTIR-4243)', () => {
  it('returns all three fields on a project that has never been authored', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme' });

    const hero = await projectsService.getPublicHero({ key: fx.projectIdentifier, ctx: fx.ctx });

    // ⚠️ The two null arms and the empty-array arm are DIFFERENT defaults, and
    // the room renders them differently: a null README is the state whose helper
    // says the public page shows an automatic introduction instead (state C1),
    // while the tags column defaults to `[]` rather than null.
    expect(hero).toEqual({ publicOverviewMd: null, publicTagline: null, publicTags: [] });
  });

  it('returns what an admin actually wrote — all three, not just the body', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme' });
    await projectsService.setPublicOverview({
      key: fx.projectIdentifier,
      ctx: fx.ctx,
      publicOverviewMd: '## Hello\n\nA README body.',
      publicTagline: 'Vibe your whole project.',
      publicTags: ['Vibe project', 'Open source'],
    });

    const hero = await projectsService.getPublicHero({ key: fx.projectIdentifier, ctx: fx.ctx });

    expect(hero.publicOverviewMd).toBe('## Hello\n\nA README body.');
    expect(hero.publicTagline).toBe('Vibe your whole project.');
    expect(hero.publicTags).toEqual(['Vibe project', 'Open source']);
  });

  it('reads each field independently — a cleared tagline does not clear the README', async () => {
    // The partial-author contract on the write side, observed from the read: the
    // room sends all three fields every time so a cleared tagline arrives as
    // `null`, and this is what the reader then has to hand back.
    const fx = await makeWorkItemFixture({ name: 'Acme' });
    await projectsService.setPublicOverview({
      key: fx.projectIdentifier,
      ctx: fx.ctx,
      publicOverviewMd: 'Kept.',
      publicTagline: 'About to go.',
      publicTags: ['kept'],
    });
    await projectsService.setPublicOverview({
      key: fx.projectIdentifier,
      ctx: fx.ctx,
      publicTagline: null,
    });

    const hero = await projectsService.getPublicHero({ key: fx.projectIdentifier, ctx: fx.ctx });

    expect(hero.publicTagline).toBeNull();
    expect(hero.publicOverviewMd).toBe('Kept.');
    expect(hero.publicTags).toEqual(['kept']);
  });

  it('is workspace-scoped — an unknown key in this workspace is a 404, not an empty hero', async () => {
    // The room resolves the ACTIVE project's key, so a hero that came back all
    // nulls for a key belonging to nobody would read as "never authored".
    const fx = await makeWorkItemFixture({ name: 'Acme' });

    await expect(
      projectsService.getPublicHero({ key: 'NOSUCH', ctx: fx.ctx }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
