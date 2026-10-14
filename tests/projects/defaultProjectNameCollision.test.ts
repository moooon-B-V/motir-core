import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { db } from '@/lib/db';
import { deriveIdentifierBase, projectsService, slugify } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { IdentifierCollisionError } from '@/lib/projects/errors';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-8239 · Subtask MOTIR-8528 — the seeding's collision ladder.
//
// `ensureDefaultProject` names the project it seeds with a drawn
// `adjective-noun-dddd` name and derives the identifier and slug from it. When
// that candidate is taken it climbs three rungs: (1) a FRESH draw, so the name,
// the key and the slug keep describing the same words; (2) once the draws are
// spent, the last drawn name with the shipped numeric identifier suffix and
// random slug suffix, recorded as one structured warning; (3)
// `IdentifierCollisionError` only when that suffixed candidate is held as well.
//
// ⚠️ The DRAW is pinned by mocking the generator module — the production
// signature of `ensureDefaultProject` carries no test-only parameter. Every
// other dependency is real: real Postgres, real unique indexes, real aliases.
//
// The collision fixture is an ARCHIVED project holding the drawn identifier:
// archive stamps `archivedAt` and never deletes the row, the per-workspace
// identifier constraint does not exclude archived rows, and the seeding's
// idempotency read sees only live projects — so the workspace still counts as
// empty while the drawn key is taken.

const { generateProjectName } = vi.hoisted(() => ({
  generateProjectName: vi.fn<() => string>(),
}));
vi.mock('@/lib/projects/projectNameGenerator', () => ({ generateProjectName }));

/** Pin the draw: each call returns the next name; the last one repeats. */
function pinDraws(...names: string[]) {
  let i = 0;
  generateProjectName.mockImplementation(() => names[Math.min(i++, names.length - 1)]!);
}

let warn: MockInstance<typeof console.warn>;

beforeEach(async () => {
  await truncateAuthTables();
  generateProjectName.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The warnings the seeding path emitted (other modules' warnings ignored). */
function seedingWarnings() {
  return warn.mock.calls.filter(
    ([message]: unknown[]) =>
      typeof message === 'string' && message.includes('ensureDefaultProject'),
  );
}

async function emptyWorkspace() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Collision WS',
    ownerUserId: owner.id,
  });
  return { owner, workspace };
}

/**
 * Plant an ARCHIVED project holding `identifier` (and, when given, the slug
 * derived from `name`), so a seeding that draws it collides while the
 * workspace still has no live project to return.
 */
async function plantArchived(
  owner: { id: string },
  workspaceId: string,
  name: string,
  identifier: string,
) {
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name,
    identifier,
  });
  await projectsService.archiveProject({
    projectId: project.id,
    workspaceId,
    actorUserId: owner.id,
  });
  return project;
}

async function liveProjectsIn(workspaceId: string) {
  return adminDb.project.findMany({ where: { workspaceId, archivedAt: null } });
}

describe('rung 1 — a colliding draw is redrawn', () => {
  it('a drawn identifier held by an archived project yields the SECOND draw, unsuffixed', async () => {
    const { owner, workspace } = await emptyWorkspace();
    await plantArchived(owner, workspace.id, 'Planted', 'QUIET');
    pinDraws('quiet-harbor-4821', 'amber-comet-1307');

    const seeded = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    expect(generateProjectName).toHaveBeenCalledTimes(2);
    expect(seeded!.name).toBe('amber-comet-1307');
    expect(seeded!.identifier).toBe(deriveIdentifierBase('amber-comet-1307'));
    expect(seeded!.slug).toBe(slugify('amber-comet-1307'));
    expect(seeded!.identifier).toBe('AMBER');
    expect(seeded!.slug).toBe('amber-comet-1307');
    // Nothing of the first draw reaches the created project.
    expect(seeded!.name).not.toMatch(/quiet|harbor/i);
    expect(seeded!.slug).not.toMatch(/quiet|harbor/);
    expect(seedingWarnings()).toHaveLength(0);
  });

  it('a drawn identifier RESERVED by a retired key is redrawn the same way', async () => {
    const { owner, workspace } = await emptyWorkspace();
    // A project once keyed QUIET, re-keyed to OLDER — QUIET is now reserved by
    // its previous-key alias — and then archived so the workspace is empty.
    const planted = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Planted',
      identifier: 'QUIET',
    });
    await projectsService.changeKey({
      key: 'QUIET',
      newKey: 'OLDER',
      ctx: { userId: owner.id, workspaceId: workspace.id },
    });
    await projectsService.archiveProject({
      projectId: planted.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    expect(
      await adminDb.projectKeyAlias.count({
        where: { workspaceId: workspace.id, identifier: 'QUIET' },
      }),
    ).toBe(1);
    pinDraws('quiet-harbor-4821', 'amber-comet-1307');

    const seeded = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    expect(seeded!.name).toBe('amber-comet-1307');
    expect(seeded!.identifier).toBe('AMBER');
    expect(seeded!.slug).toBe('amber-comet-1307');
    expect(seedingWarnings()).toHaveLength(0);
  });

  it('a usable first draw is taken as drawn, with no warning', async () => {
    const { owner, workspace } = await emptyWorkspace();
    pinDraws('quiet-harbor-4821');

    const seeded = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    expect(generateProjectName).toHaveBeenCalledTimes(1);
    expect(seeded!.name).toBe('quiet-harbor-4821');
    expect(seeded!.identifier).toBe('QUIET');
    expect(seeded!.slug).toBe('quiet-harbor-4821');
    expect(seedingWarnings()).toHaveLength(0);
  });
});

describe('rung 2 — the draws are spent', () => {
  it('completes on the last drawn name with the shipped suffixes and ONE warning', async () => {
    const { owner, workspace } = await emptyWorkspace();
    await plantArchived(owner, workspace.id, 'Planted', 'QUIET');
    // Every draw is the same name, so every fresh draw collides.
    pinDraws('quiet-harbor-4821');

    const seeded = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    expect(seeded).not.toBeNull();
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: seeded!.id } });
    expect(row.workspaceId).toBe(workspace.id);
    expect(seeded!.name).toBe('quiet-harbor-4821');
    // The shipped numeric suffix on the drawn base: distinct from the held key.
    expect(seeded!.identifier).toMatch(/^QUIE\d$/);
    expect(seeded!.identifier).not.toBe('QUIET');
    // The shipped random slug suffix on the drawn slug.
    expect(seeded!.slug).toMatch(/^quiet-harbor-4821-[a-z0-9]+$/);
    expect(await liveProjectsIn(workspace.id)).toHaveLength(1);

    const warnings = seedingWarnings();
    expect(warnings).toHaveLength(1);
    const [, payload] = warnings[0]!;
    expect(payload).toMatchObject({
      workspaceId: workspace.id,
      name: 'quiet-harbor-4821',
      identifier: seeded!.identifier,
    });
  });
});

describe('rung 3 — every candidate the loop knows is held', () => {
  it('rejects with IDENTIFIER_COLLISION and creates no project', async () => {
    const { owner, workspace } = await emptyWorkspace();
    await plantArchived(owner, workspace.id, 'Planted', 'QUIET');
    await plantArchived(owner, workspace.id, 'Planted again', 'QUIE1');
    pinDraws('quiet-harbor-4821');

    const rejection = projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    await expect(rejection).rejects.toBeInstanceOf(IdentifierCollisionError);
    await expect(rejection).rejects.toMatchObject({ code: 'IDENTIFIER_COLLISION' });
    expect(await liveProjectsIn(workspace.id)).toHaveLength(0);
    expect(await adminDb.project.count({ where: { workspaceId: workspace.id } })).toBe(2);
  });
});

describe('createProject — a person-named project is never redrawn', () => {
  it('keeps the name the caller passed when its identifier and slug are taken', async () => {
    const { owner, workspace } = await emptyWorkspace();
    await plantArchived(owner, workspace.id, 'quiet-harbor-4821', 'QUIET');

    const created = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'quiet-harbor-4821',
    });

    expect(created.name).toBe('quiet-harbor-4821');
    expect(created.identifier).not.toBe('QUIET');
    expect(created.identifier).toMatch(/^QUIE\d$/);
    expect(generateProjectName).not.toHaveBeenCalled();
  });
});
