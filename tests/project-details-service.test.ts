import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectKeyAliasRepository } from '@/lib/repositories/projectKeyAliasRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  AliasNotFoundError,
  IdentifierReservedError,
  IdentifierTakenError,
  IdentifierUnchangedError,
  InvalidAvatarError,
  InvalidIdentifierError,
  InvalidProjectNameError,
  NotProjectAdminError,
  ProjectNotFoundError,
  ProjectOverviewTooLongError,
  ProjectTaglineTooLongError,
  ProjectTagsInvalidError,
} from '@/lib/projects/errors';
import {
  PUBLIC_TAG_MAX_LENGTH,
  PUBLIC_TAGS_MAX_COUNT,
  PUBLIC_TAGLINE_MAX_LENGTH,
} from '@/lib/publicProjects/limits';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from './helpers/db';

// Service-layer tests for the Story 6.8 (Subtask 6.8.1) project-details + change-
// key backend: projectsService.{updateDetails, changeKey, releaseAlias,
// getDetails} + the create-path alias reservation + the atomic rename transaction
// (lock, collision matrix, reclaim/release, fault-injected rollback) + the
// rename∥issue-create concurrency invariant. Real Postgres, no DB mocks; the
// truncate helper CASCADEs workspace → project → work_item / project_key_alias
// between tests. Typed-error assertions use the real classes.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

// An owner + workspace + project keyed PROD. The owner is the workspace OWNER, so
// they manage the project via the workspace-manager tier (no project membership).
async function makeFixture(slug: string, identifier = 'PROD') {
  const owner = await makeUser(`owner-${slug}@example.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
    identifier,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  return { owner, workspace, project, key: project.identifier, ownerCtx };
}

async function addWorkspaceMember(workspaceId: string, email: string) {
  const user = await makeUser(email, 'Member');
  await workspacesService.addMember({ userId: user.id, workspaceId, role: 'member' });
  return user;
}

// Seed `n` work items into a project, returning their { identifier, key } pairs.
async function seedItems(projectId: string, ctx: WorkspaceContext, n: number) {
  const items: { identifier: string; key: number }[] = [];
  for (let i = 0; i < n; i++) {
    const dto = await workItemsService.createWorkItem(
      { projectId, kind: 'task', title: `Item ${i}` },
      ctx,
    );
    items.push({ identifier: dto.identifier, key: dto.key });
  }
  return items;
}

async function identifiersOf(projectId: string): Promise<string[]> {
  const rows = await db.workItem.findMany({ where: { projectId }, select: { identifier: true } });
  return rows.map((r) => r.identifier).sort();
}

describe('updateDetails', () => {
  it('renames the project (slug stable) and returns the DTO with empty previousKeys', async () => {
    const { key, project, ownerCtx } = await makeFixture('rename');

    const updated = await projectsService.updateDetails({
      key,
      ctx: ownerCtx,
      name: '  Renamed  ',
    });

    expect(updated.name).toBe('Renamed');
    expect(updated.slug).toBe(project.slug); // slug is NOT regenerated
    expect(updated.identifier).toBe('PROD');
    expect(updated.previousKeys).toEqual([]);
  });

  it('sets and clears the avatar (icon + colour)', async () => {
    const { key, ownerCtx } = await makeFixture('avatar');

    const set = await projectsService.updateDetails({
      key,
      ctx: ownerCtx,
      avatarIcon: 'rocket',
      avatarColor: 'mint',
    });
    expect(set.avatarIcon).toBe('rocket');
    expect(set.avatarColor).toBe('mint');

    const cleared = await projectsService.updateDetails({
      key,
      ctx: ownerCtx,
      avatarIcon: null,
      avatarColor: null,
    });
    expect(cleared.avatarIcon).toBeNull();
    expect(cleared.avatarColor).toBeNull();
  });

  it('rejects a blank name, an unknown icon, and an unknown colour', async () => {
    const { key, ownerCtx } = await makeFixture('valid');

    await expect(
      projectsService.updateDetails({ key, ctx: ownerCtx, name: '   ' }),
    ).rejects.toBeInstanceOf(InvalidProjectNameError);
    await expect(
      projectsService.updateDetails({ key, ctx: ownerCtx, avatarIcon: 'not-an-icon' }),
    ).rejects.toBeInstanceOf(InvalidAvatarError);
    await expect(
      projectsService.updateDetails({ key, ctx: ownerCtx, avatarColor: 'chartreuse' }),
    ).rejects.toBeInstanceOf(InvalidAvatarError);
  });

  it('rejects a non-admin with NotProjectAdminError', async () => {
    const { key, workspace } = await makeFixture('gate');
    const member = await addWorkspaceMember(workspace.id, 'm-gate@example.com');
    const memberCtx: WorkspaceContext = { userId: member.id, workspaceId: workspace.id };

    await expect(
      projectsService.updateDetails({ key, ctx: memberCtx, name: 'Nope' }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
  });

  it('throws ProjectNotFoundError for an unknown key (no existence leak)', async () => {
    const { ownerCtx } = await makeFixture('missing');
    await expect(
      projectsService.updateDetails({ key: 'ZZZ', ctx: ownerCtx, name: 'X' }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('changeKey', () => {
  it('atomically rewrites every issue identifier (numbers preserved) and reserves the old key', async () => {
    const { key, project, ownerCtx } = await makeFixture('change');
    const seeded = await seedItems(project.id, ownerCtx, 4);
    const keys = seeded.map((s) => s.key).sort((a, b) => a - b);

    const updated = await projectsService.changeKey({ key, newKey: 'nif', ctx: ownerCtx });

    expect(updated.identifier).toBe('NIF');
    expect(updated.previousKeys).toEqual([{ identifier: 'PROD', retiredAt: expect.any(String) }]);
    // Every identifier re-rendered NIF-<key>, numbers preserved.
    expect(await identifiersOf(project.id)).toEqual(keys.map((k) => `NIF-${k}`).sort());
    // The alias row for the old key exists, owned by this project.
    expect(
      await db.projectKeyAlias.count({ where: { projectId: updated.id, identifier: 'PROD' } }),
    ).toBe(1);
  });

  it('rewrites the whole project in ONE statement (the bulk-update count equals the row total)', async () => {
    const { project, ownerCtx } = await makeFixture('bulk');
    const n = 12;
    await seedItems(project.id, ownerCtx, n);

    // The repository method is a single $executeRaw; its returned row count being
    // the full total proves one statement rewrote every row (no per-row loop).
    const count = await db.$transaction((tx) =>
      workItemRepository.rewriteIdentifiersForProject(project.id, 'ZAP', tx),
    );
    expect(count).toBe(n);
    expect((await identifiersOf(project.id)).every((id) => id.startsWith('ZAP-'))).toBe(true);
  });

  it('is atomic: a fault after the rewrite rolls back EVERYTHING (no partial state)', async () => {
    const { key, project, ownerCtx } = await makeFixture('atomic');
    const before = await identifiersOf(project.id);
    await seedItems(project.id, ownerCtx, 3);
    const beforeRewrite = await identifiersOf(project.id);

    vi.spyOn(projectKeyAliasRepository, 'create').mockRejectedValueOnce(new Error('boom'));
    await expect(projectsService.changeKey({ key, newKey: 'NIF', ctx: ownerCtx })).rejects.toThrow(
      'boom',
    );

    // The project key, the work-item identifiers, and the alias table are all untouched.
    const fresh = await db.project.findUnique({ where: { id: project.id } });
    expect(fresh?.identifier).toBe('PROD');
    expect(await identifiersOf(project.id)).toEqual(beforeRewrite);
    expect(await db.projectKeyAlias.count({ where: { projectId: project.id } })).toBe(0);
    expect(before).toEqual([]);
  });

  it("rejects collisions: a live identifier → Taken, another project's alias → Reserved", async () => {
    const { workspace, owner } = await makeFixture('coll-host');
    const ctx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
    // Two more projects in the same workspace.
    const live = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Live',
      identifier: 'LIVE',
    });
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Mover',
      identifier: 'MOVE',
    });
    // MOVE → GONE, so MOVE becomes the mover's alias (reserved).
    await projectsService.changeKey({ key: 'MOVE', newKey: 'GONE', ctx });

    // PROD → LIVE collides with a live identifier.
    await expect(
      projectsService.changeKey({ key: 'PROD', newKey: 'LIVE', ctx }),
    ).rejects.toBeInstanceOf(IdentifierTakenError);
    // PROD → MOVE collides with another project's reserved alias.
    await expect(
      projectsService.changeKey({ key: 'PROD', newKey: 'MOVE', ctx }),
    ).rejects.toBeInstanceOf(IdentifierReservedError);
    expect(live.identifier).toBe('LIVE');
  });

  it("reclaims the project's OWN previous key (swaps which key is the alias)", async () => {
    const { key, project, ownerCtx } = await makeFixture('reclaim');
    await projectsService.changeKey({ key, newKey: 'NIF', ctx: ownerCtx }); // PROD → NIF (PROD aliased)
    const back = await projectsService.changeKey({ key: 'NIF', newKey: 'PROD', ctx: ownerCtx });

    expect(back.identifier).toBe('PROD');
    // PROD's alias row is gone; NIF is now the alias.
    expect(back.previousKeys).toEqual([{ identifier: 'NIF', retiredAt: expect.any(String) }]);
    const aliasIds = (await db.projectKeyAlias.findMany({ where: { projectId: project.id } })).map(
      (a) => a.identifier,
    );
    expect(aliasIds).toEqual(['NIF']);
  });

  it('rejects malformed keys (400) and an unchanged key (no-op)', async () => {
    const { key, ownerCtx } = await makeFixture('shape');
    for (const bad of ['ab', 'TOOLONG', 'A-B', '']) {
      await expect(
        projectsService.changeKey({ key, newKey: bad, ctx: ownerCtx }),
      ).rejects.toBeInstanceOf(InvalidIdentifierError);
    }
    await expect(
      projectsService.changeKey({ key, newKey: 'prod', ctx: ownerCtx }),
    ).rejects.toBeInstanceOf(IdentifierUnchangedError);
  });

  it('rejects a non-admin with NotProjectAdminError', async () => {
    const { key, workspace } = await makeFixture('ckgate');
    const member = await addWorkspaceMember(workspace.id, 'm-ck@example.com');
    const memberCtx: WorkspaceContext = { userId: member.id, workspaceId: workspace.id };
    await expect(
      projectsService.changeKey({ key, newKey: 'NIF', ctx: memberCtx }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
  });

  it('never mints a stale-prefix identifier when a rename races issue creation', async () => {
    const { key, project, ownerCtx } = await makeFixture('race');
    await seedItems(project.id, ownerCtx, 2);

    // Fire the rename and a creation concurrently. Whichever grabs the project
    // row lock first, the FOR-UPDATE lock + the in-tx prefix re-read guarantee
    // the final state has every identifier on the canonical (new) prefix.
    await Promise.all([
      projectsService.changeKey({ key, newKey: 'NIF', ctx: ownerCtx }),
      workItemsService.createWorkItem(
        { projectId: project.id, kind: 'task', title: 'Racer' },
        ownerCtx,
      ),
    ]);

    const ids = await identifiersOf(project.id);
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => /^NIF-\d+$/.test(id))).toBe(true);
  });
});

describe('createProject reserved-key guard', () => {
  it("a new project cannot take a key reserved by another project's alias", async () => {
    const { workspace, owner } = await makeFixture('reserve');
    const ctx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx }); // PROD reserved

    const fresh = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Newbie',
      identifier: 'PROD',
    });
    expect(fresh.identifier).not.toBe('PROD');
    expect(fresh.identifier).toBe('PROD1');
  });
});

describe('releaseAlias', () => {
  it('removes the alias, un-reserves the key, and breaks the implicit reservation', async () => {
    const { workspace, owner } = await makeFixture('release');
    const ctx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
    const moved = await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx });

    const after = await projectsService.releaseAlias({ key: 'NIF', alias: 'prod', ctx });
    expect(after.previousKeys).toEqual([]);
    expect(await db.projectKeyAlias.count({ where: { projectId: moved.id } })).toBe(0);

    // PROD is now free for a new project.
    const reuse = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Reuser',
      identifier: 'PROD',
    });
    expect(reuse.identifier).toBe('PROD');
  });

  it("throws AliasNotFoundError when the key is not one of the project's aliases", async () => {
    const { key, ownerCtx } = await makeFixture('release-miss');
    await expect(
      projectsService.releaseAlias({ key, alias: 'XXX', ctx: ownerCtx }),
    ).rejects.toBeInstanceOf(AliasNotFoundError);
  });

  it('rejects a non-admin with NotProjectAdminError', async () => {
    const { workspace, owner } = await makeFixture('release-gate');
    const ctx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx });
    const member = await addWorkspaceMember(workspace.id, 'm-rel@example.com');
    const memberCtx: WorkspaceContext = { userId: member.id, workspaceId: workspace.id };
    await expect(
      projectsService.releaseAlias({ key: 'NIF', alias: 'PROD', ctx: memberCtx }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
  });
});

describe('getDetails', () => {
  it('returns the DTO with previousKeys, readable by a browser', async () => {
    const { key, ownerCtx } = await makeFixture('details');
    await projectsService.changeKey({ key, newKey: 'NIF', ctx: ownerCtx });

    const details = await projectsService.getDetails('NIF', ownerCtx);
    expect(details.identifier).toBe('NIF');
    expect(details.previousKeys).toEqual([{ identifier: 'PROD', retiredAt: expect.any(String) }]);
    // The details-surface path also carries `createdAt` (the 6.5.3 "Created"
    // row), as a parseable ISO string — unlike the hot active-project DTO.
    expect(details.createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(details.createdAt!))).toBe(false);

    // The repo's no-tx read path (the `?? db` branch) also resolves the aliases.
    const direct = await projectKeyAliasRepository.findManyByProject(details.id);
    expect(direct.map((a) => a.identifier)).toEqual(['PROD']);
  });
});

// Subtask 6.16.3 — the public-hero WRITE path: `setPublicOverview` now authors
// the README body PLUS the tagline + tags (a partial, admin-gated, validated
// author). Reads back the persisted columns directly to prove what was stored.
describe('setPublicOverview — public hero authoring (6.16.3)', () => {
  async function readHero(projectId: string) {
    const row = await db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { publicOverviewMd: true, publicTagline: true, publicTags: true },
    });
    return row;
  }

  it('persists all three fields in one call; trims tagline + normalizes tags', async () => {
    const { key, project, ownerCtx } = await makeFixture('hero-all');

    await projectsService.setPublicOverview({
      key,
      ctx: ownerCtx,
      publicOverviewMd: '  # Readme  ',
      publicTagline: '  Plan, build, ship  ',
      publicTags: ['  Agile ', 'agile', '', 'Roadmap', 'Open Source'],
    });

    const hero = await readHero(project.id);
    expect(hero.publicOverviewMd).toBe('# Readme');
    expect(hero.publicTagline).toBe('Plan, build, ship');
    // trimmed; the case-insensitive duplicate ("agile") dropped; empties dropped;
    // first spelling + author order kept.
    expect(hero.publicTags).toEqual(['Agile', 'Roadmap', 'Open Source']);
  });

  it('is a PARTIAL author — an omitted field is left untouched', async () => {
    const { key, project, ownerCtx } = await makeFixture('hero-partial');
    await projectsService.setPublicOverview({
      key,
      ctx: ownerCtx,
      publicTagline: 'First tagline',
      publicTags: ['alpha'],
    });

    // A later edit that only sets the body must not wipe the tagline/tags.
    await projectsService.setPublicOverview({ key, ctx: ownerCtx, publicOverviewMd: 'Body' });

    const hero = await readHero(project.id);
    expect(hero.publicOverviewMd).toBe('Body');
    expect(hero.publicTagline).toBe('First tagline');
    expect(hero.publicTags).toEqual(['alpha']);
  });

  it('empty / blank tagline clears it to null', async () => {
    const { key, project, ownerCtx } = await makeFixture('hero-clear');
    await projectsService.setPublicOverview({ key, ctx: ownerCtx, publicTagline: 'something' });
    await projectsService.setPublicOverview({ key, ctx: ownerCtx, publicTagline: '   ' });

    expect((await readHero(project.id)).publicTagline).toBeNull();
  });

  it('rejects a too-long tagline with ProjectTaglineTooLongError (no write)', async () => {
    const { key, project, ownerCtx } = await makeFixture('hero-tagline-long');
    await expect(
      projectsService.setPublicOverview({
        key,
        ctx: ownerCtx,
        publicTagline: 'x'.repeat(PUBLIC_TAGLINE_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(ProjectTaglineTooLongError);

    expect((await readHero(project.id)).publicTagline).toBeNull();
  });

  it('rejects a single over-long tag with ProjectTagsInvalidError(tag_too_long)', async () => {
    const { key, ownerCtx } = await makeFixture('hero-tag-long');
    const err = await projectsService
      .setPublicOverview({
        key,
        ctx: ownerCtx,
        publicTags: ['ok', 'y'.repeat(PUBLIC_TAG_MAX_LENGTH + 1)],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectTagsInvalidError);
    expect((err as ProjectTagsInvalidError).reason).toBe('tag_too_long');
  });

  it('rejects too many tags (after dedupe) with ProjectTagsInvalidError(too_many)', async () => {
    const { key, ownerCtx } = await makeFixture('hero-tag-count');
    const tooMany = Array.from({ length: PUBLIC_TAGS_MAX_COUNT + 1 }, (_, i) => `tag-${i}`);
    const err = await projectsService
      .setPublicOverview({ key, ctx: ownerCtx, publicTags: tooMany })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectTagsInvalidError);
    expect((err as ProjectTagsInvalidError).reason).toBe('too_many');
  });

  it('rejects a too-long README body with ProjectOverviewTooLongError', async () => {
    const { key, ownerCtx } = await makeFixture('hero-body-long');
    await expect(
      projectsService.setPublicOverview({
        key,
        ctx: ownerCtx,
        publicOverviewMd: 'x'.repeat(50_001),
      }),
    ).rejects.toBeInstanceOf(ProjectOverviewTooLongError);
  });

  it('is admin-gated — a plain workspace member is rejected with NotProjectAdminError', async () => {
    const { key, project, workspace } = await makeFixture('hero-gate');
    const member = await addWorkspaceMember(workspace.id, 'hero-member@example.com');
    const memberCtx: WorkspaceContext = { userId: member.id, workspaceId: workspace.id };

    await expect(
      projectsService.setPublicOverview({
        key,
        ctx: memberCtx,
        publicTagline: 'sneaky',
        publicTags: ['x'],
      }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);

    // The denied edit wrote nothing.
    const hero = await readHero(project.id);
    expect(hero.publicTagline).toBeNull();
    expect(hero.publicTags).toEqual([]);
  });
});
