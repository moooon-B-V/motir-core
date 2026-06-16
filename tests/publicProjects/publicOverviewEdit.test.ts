import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { NotProjectAdminError, ProjectTaglineTooLongError } from '@/lib/projects/errors';
import { PUBLIC_TAGLINE_MAX_LENGTH } from '@/lib/publicProjects/limits';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';

// Story 6.16 · Subtask 6.16.5 — the ON-PAGE save path. The public Overview editor
// persists tagline + tags + body through `publicProjectsService.setPublicOverview`,
// which keys off the PUBLIC `identifier` (not the active-project cookie the
// settings author uses) and admin-gates the write. These assertions lock the seam
// the per-subtask units don't: that the identifier-keyed public entry point
// resolves the right project, persists all three fields so the public read
// reflects them, and rejects a non-admin / anonymous caller (the action's 403).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makePublicProjectFixture(): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name: 'Acme' });
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

describe('publicProjectsService.setPublicOverview — on-page editing (6.16.5)', () => {
  it('an admin persists tagline + tags + body, and the public read reflects them', async () => {
    const fx = await makePublicProjectFixture();

    await publicProjectsService.setPublicOverview(fx.projectIdentifier, fx.ownerId, {
      publicTagline: 'Vibe your whole project.',
      publicTags: ['Vibe project', 'Open source'],
      publicOverviewMd: '## Hello\n\nA README body.',
    });

    // Read back through the SAME public projection the page renders (anonymous).
    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(overview.publicTagline).toBe('Vibe your whole project.');
    expect(overview.publicTags).toEqual(['Vibe project', 'Open source']);
    expect(overview.publicOverviewMd).toBe('## Hello\n\nA README body.');
  });

  it('persists a partial edit (tags only) without clobbering the other fields', async () => {
    const fx = await makePublicProjectFixture();
    await publicProjectsService.setPublicOverview(fx.projectIdentifier, fx.ownerId, {
      publicTagline: 'Keep me',
      publicOverviewMd: 'Keep me too',
    });

    await publicProjectsService.setPublicOverview(fx.projectIdentifier, fx.ownerId, {
      publicTags: ['solo'],
    });

    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(overview.publicTags).toEqual(['solo']);
    expect(overview.publicTagline).toBe('Keep me');
    expect(overview.publicOverviewMd).toBe('Keep me too');
  });

  it('clearing the tagline (empty string) falls back to null', async () => {
    const fx = await makePublicProjectFixture();
    await publicProjectsService.setPublicOverview(fx.projectIdentifier, fx.ownerId, {
      publicTagline: 'something',
    });
    await publicProjectsService.setPublicOverview(fx.projectIdentifier, fx.ownerId, {
      publicTagline: '   ',
    });
    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(overview.publicTagline).toBeNull();
  });

  it('rejects a non-member actor with NotProjectAdminError (→ the action 403)', async () => {
    const fx = await makePublicProjectFixture();
    const outsider = await createTestUser({ email: 'outsider@example.com' });

    await expect(
      publicProjectsService.setPublicOverview(fx.projectIdentifier, outsider.id, {
        publicTagline: 'nope',
      }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);

    // And nothing was written.
    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(overview.publicTagline).toBeNull();
  });

  it('rejects an anonymous caller (null actor) with NotProjectAdminError', async () => {
    const fx = await makePublicProjectFixture();
    await expect(
      publicProjectsService.setPublicOverview(fx.projectIdentifier, null, {
        publicTagline: 'nope',
      }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
  });

  it('propagates the tagline-too-long validation error', async () => {
    const fx = await makePublicProjectFixture();
    await expect(
      publicProjectsService.setPublicOverview(fx.projectIdentifier, fx.ownerId, {
        publicTagline: 'x'.repeat(PUBLIC_TAGLINE_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(ProjectTaglineTooLongError);
  });
});
