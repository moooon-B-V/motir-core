import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { db } from '@/lib/db';
import { projectTagsService } from '@/lib/services/projectTagsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectTagRepository } from '@/lib/repositories/projectTagRepository';
import { MAX_TAGS_PER_PROJECT, PROJECT_TAG_VOCABULARY } from '@/lib/projectTags/vocabulary';
import { InvalidProjectTagError, TooManyProjectTagsError } from '@/lib/projectTags/errors';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// projectTagsService (Story 6.13 · Subtask 6.13.5) — the topic-tag model +
// per-project tagging + the public tag-FACET read, against a REAL Postgres (the
// no-mocks rule). Covers: the curated-vocabulary validation + cap, the
// idempotent set-replace, cross-project tag reuse, the 6.4 two-tier admin gate,
// and the public-only facet counts. The truncate helper CASCADE-resets
// organization → workspace → project → project_tag_assignment; project_tag rows
// are shared/system-level (no tenant FK), so they are cleared explicitly.

beforeEach(async () => {
  await truncateAuthTables();
  await db.projectTagAssignment.deleteMany();
  await db.projectTag.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Make a project `public` so the facet read counts it. */
async function makePublic(projectId: string): Promise<void> {
  await db.project.update({ where: { id: projectId }, data: { accessLevel: 'public' } });
}

describe('projectTagsService.setProjectTags — per-project tagging', () => {
  it('assigns curated tags and reads them back in label order', async () => {
    const fx = await makeWorkItemFixture();
    const tags = await projectTagsService.setProjectTags(
      fx.projectIdentifier,
      ['design', 'ai-ml'],
      fx.ctx,
    );
    expect(tags.map((t) => t.slug)).toEqual(['ai-ml', 'design']); // label-ordered
    expect(tags.find((t) => t.slug === 'ai-ml')?.label).toBe('AI & Machine Learning');

    const readBack = await projectTagsService.getProjectTags(fx.projectIdentifier, fx.ctx);
    expect(readBack.map((t) => t.slug)).toEqual(['ai-ml', 'design']);
  });

  it('is an idempotent full REPLACE (adds + removes to match exactly)', async () => {
    const fx = await makeWorkItemFixture();
    await projectTagsService.setProjectTags(fx.projectIdentifier, ['design', 'ai-ml'], fx.ctx);
    // Re-set to a different set: 'design' stays, 'ai-ml' goes, 'security' added.
    const tags = await projectTagsService.setProjectTags(
      fx.projectIdentifier,
      ['security', 'design'],
      fx.ctx,
    );
    expect(tags.map((t) => t.slug)).toEqual(['design', 'security']);

    // A re-set to the SAME set is a no-op (idempotent) and returns the same.
    const again = await projectTagsService.setProjectTags(
      fx.projectIdentifier,
      ['design', 'security'],
      fx.ctx,
    );
    expect(again.map((t) => t.slug)).toEqual(['design', 'security']);
  });

  it('de-duplicates repeated slugs in the input', async () => {
    const fx = await makeWorkItemFixture();
    const tags = await projectTagsService.setProjectTags(
      fx.projectIdentifier,
      ['design', 'design', ' design '],
      fx.ctx,
    );
    expect(tags.map((t) => t.slug)).toEqual(['design']);
  });

  it('clears all tags when set to an empty list', async () => {
    const fx = await makeWorkItemFixture();
    await projectTagsService.setProjectTags(fx.projectIdentifier, ['design'], fx.ctx);
    const tags = await projectTagsService.setProjectTags(fx.projectIdentifier, [], fx.ctx);
    expect(tags).toEqual([]);
  });

  it('reuses ONE shared tag row across projects (the GitHub-Topics shape)', async () => {
    const a = await makeWorkItemFixture({ name: 'Org A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Org B', identifier: 'BBB' });
    await projectTagsService.setProjectTags(a.projectIdentifier, ['design'], a.ctx);
    await projectTagsService.setProjectTags(b.projectIdentifier, ['design'], b.ctx);

    const rows = await projectTagRepository.findBySlugs(['design']);
    expect(rows).toHaveLength(1); // one normalized vocabulary row, shared
  });

  it('rejects an off-vocabulary slug with InvalidProjectTagError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      projectTagsService.setProjectTags(
        fx.projectIdentifier,
        ['design', 'not-a-real-topic'],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProjectTagError);
    // Nothing persisted on rejection.
    expect(await projectTagsService.getProjectTags(fx.projectIdentifier, fx.ctx)).toEqual([]);
  });

  it('rejects more than the per-project cap with TooManyProjectTagsError', async () => {
    const fx = await makeWorkItemFixture();
    const tooMany = PROJECT_TAG_VOCABULARY.slice(0, MAX_TAGS_PER_PROJECT + 1).map((e) => e.slug);
    await expect(
      projectTagsService.setProjectTags(fx.projectIdentifier, tooMany, fx.ctx),
    ).rejects.toBeInstanceOf(TooManyProjectTagsError);
  });

  it('throws ProjectNotFoundError for an unknown / cross-tenant key', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      projectTagsService.setProjectTags('NOPE', ['design'], fx.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('projectTagsService — the 6.4 two-tier admin gate', () => {
  interface Actors {
    fx: WorkItemFixture;
    memberCtx: ServiceContext;
    projectAdminCtx: ServiceContext;
  }

  async function buildActors(): Promise<Actors> {
    const fx = await makeWorkItemFixture();
    async function wsMember(
      email: string,
      name: string,
    ): Promise<{ user: User; ctx: ServiceContext }> {
      const user = await createTestUser({ email, name });
      await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
      return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
    }
    const { ctx: memberCtx } = await wsMember('member@ex.com', 'Plain Member');
    const { user: projAdmin, ctx: projectAdminCtx } = await wsMember('padmin@ex.com', 'Proj Admin');
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: projAdmin.id,
      role: 'admin',
    });
    return { fx, memberCtx, projectAdminCtx };
  }

  it('lets a project admin (not a workspace manager) set tags', async () => {
    const { fx, projectAdminCtx } = await buildActors();
    const tags = await projectTagsService.setProjectTags(
      fx.projectIdentifier,
      ['design'],
      projectAdminCtx,
    );
    expect(tags.map((t) => t.slug)).toEqual(['design']);
  });

  it('rejects a plain member with NotProjectAdminError', async () => {
    const { fx, memberCtx } = await buildActors();
    await expect(
      projectTagsService.setProjectTags(fx.projectIdentifier, ['design'], memberCtx),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
  });

  it('lets any browsing member READ the tags', async () => {
    const { fx, memberCtx } = await buildActors();
    await projectTagsService.setProjectTags(fx.projectIdentifier, ['design'], fx.ctx);
    const tags = await projectTagsService.getProjectTags(fx.projectIdentifier, memberCtx);
    expect(tags.map((t) => t.slug)).toEqual(['design']);
  });
});

describe('projectTagsService.listCategories — the public tag facet', () => {
  it('counts ONLY public projects and sorts by count desc, then label', async () => {
    // Two public projects tagged `design`; one also `ai-ml`.
    const a = await makeWorkItemFixture({ name: 'Org A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Org B', identifier: 'BBB' });
    await makePublic(a.projectId);
    await makePublic(b.projectId);
    await projectTagsService.setProjectTags(a.projectIdentifier, ['design', 'ai-ml'], a.ctx);
    await projectTagsService.setProjectTags(b.projectIdentifier, ['design'], b.ctx);

    // A NON-public project tagged `security` — must NOT inflate the facet.
    const c = await makeWorkItemFixture({ name: 'Org C', identifier: 'CCC' });
    await projectTagsService.setProjectTags(c.projectIdentifier, ['security'], c.ctx);

    const categories = await projectTagsService.listCategories();
    expect(categories).toEqual([
      { slug: 'design', label: 'Design', projectCount: 2 },
      { slug: 'ai-ml', label: 'AI & Machine Learning', projectCount: 1 },
    ]);
    // The non-public project's tag never appears.
    expect(categories.some((cat) => cat.slug === 'security')).toBe(false);
  });

  it('drops a tag once its last public project goes non-public', async () => {
    const a = await makeWorkItemFixture({ name: 'Org A', identifier: 'AAA' });
    await makePublic(a.projectId);
    await projectTagsService.setProjectTags(a.projectIdentifier, ['design'], a.ctx);
    expect((await projectTagsService.listCategories()).map((c) => c.slug)).toEqual(['design']);

    await db.project.update({ where: { id: a.projectId }, data: { accessLevel: 'open' } });
    expect(await projectTagsService.listCategories()).toEqual([]);
  });
});
