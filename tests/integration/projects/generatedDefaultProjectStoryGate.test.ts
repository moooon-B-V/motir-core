import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { PROJECT_NAME_ADJECTIVES, PROJECT_NAME_NOUNS } from '@/lib/projects/projectNameGenerator';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The STORY GATE for "a new sign-up's first project gets a generated
// adjective-noun name" — Story MOTIR-8239 · Subtask MOTIR-8530.
//
// The assembled contract at the service tier, on a real Postgres: the NAME the
// seeding draws on each of the three zero-project doors, the identifier and
// slug that AGREE with it, the draw-once guards, a project a person names, and
// a rename that changes the name and nothing else.
//
// ⚠️ NO RANDOMNESS IS PINNED. The name is asserted structurally — two
// Title-Cased words, the first from the committed adjective list and the
// second from the committed noun list — and the handles by AGREEMENT with the
// drawn name, so this suite holds for whatever pair a run draws. The collision
// ladder, which does need a pinned draw, is tests/projects/
// defaultProjectNameCollision.test.ts.
//
// ⚠️ THE RENAME ENTERS AT `updateDetails`, the operation both
// `PATCH /api/projects/[key]` and the settings action call — not
// `renameProject`, which nothing outside a test wires. And no slug-addressed URL
// is asserted: the slug is a create-time artifact no route consumes, so this
// tier asserts it is UNCHANGED by a rename and leaves the address to the
// browser walk.

const BASE_URL = 'http://localhost:3000';
const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Assert `name` is a generated pair drawn from the committed lists. */
function expectGeneratedPair(name: string) {
  expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  const [adjective, noun] = name.split(' ') as [string, string];
  expect(PROJECT_NAME_ADJECTIVES).toContain(adjective.toLowerCase());
  expect(PROJECT_NAME_NOUNS).toContain(noun.toLowerCase());
}

/**
 * Assert the identifier and slug AGREE with the drawn name: the identifier is
 * a 3–5 character prefix of the name's letters (padded with X only when the
 * letters run short), and the slug is the two words lowercased and joined by
 * `-`. Agreement, not a copy of the derivation.
 */
function expectHandlesAgree(project: { name: string; identifier: string; slug: string }) {
  const letters = project.name.replace(/\s/g, '').toUpperCase();
  expect(project.identifier).toMatch(/^[A-Z0-9]{3,5}$/);
  const unpadded = project.identifier.replace(/X+$/, '');
  expect(letters.startsWith(project.identifier) || letters === unpadded).toBe(true);
  expect(project.identifier.length).toBe(Math.min(5, Math.max(3, letters.length)));
  expect(project.slug).toBe(project.name.toLowerCase().split(' ').join('-'));
}

async function ownerWithWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.ensureDefaultWorkspace({
    userId: user.id,
    userName: user.name,
  });
  return { user, workspace };
}

async function projectsIn(workspaceId: string) {
  return adminDb.project.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
}

describe('door 1 — registration', () => {
  it('a brand-new account resolves to exactly one project with a generated, agreeing name', async () => {
    await auth.api.signUpEmail({
      body: { email: 'gate-signup@example.com', password: PASSWORD, name: 'Gate' },
      headers: { origin: BASE_URL },
    });
    const user = await adminDb.user.findUniqueOrThrow({
      where: { email: 'gate-signup@example.com' },
    });
    const membership = await adminDb.workspaceMembership.findFirstOrThrow({
      where: { userId: user.id },
      include: { workspace: true },
    });
    const workspace = membership.workspace;

    // The first authed request — the moment the seeding happens.
    const active = await projectsService.getActiveProject(user.id, workspace.id);

    const rows = await projectsIn(workspace.id);
    expect(rows).toHaveLength(1);
    expect(active!.id).toBe(rows[0]!.id);
    const pinned = await adminDb.workspaceMembership.findFirstOrThrow({
      where: { userId: user.id, workspaceId: workspace.id },
    });
    expect(pinned.activeProjectId).toBe(active!.id);

    expectGeneratedPair(active!.name);
    expect(active!.name).not.toBe(workspace.name);
    expectHandlesAgree(active!);
  });
});

describe('door 2 — a workspace created later', () => {
  it('seeds a generated name while the workspace keeps the name it was given', async () => {
    const { user } = await ownerWithWorkspace('gate-door2@example.com');
    const { workspace: side } = await workspacesService.createWorkspace({
      name: 'Side project',
      ownerUserId: user.id,
    });

    const active = await projectsService.getActiveProject(user.id, side.id);

    expect(await projectsIn(side.id)).toHaveLength(1);
    expectGeneratedPair(active!.name);
    expectHandlesAgree(active!);
    const sideRow = await adminDb.workspace.findUniqueOrThrow({ where: { id: side.id } });
    expect(sideRow.name).toBe('Side project');
  });
});

describe('door 3 — archiving the last project', () => {
  it('re-seeds a NEW generated project and leaves the archived one as it was', async () => {
    const { user, workspace } = await ownerWithWorkspace('gate-door3@example.com');
    const first = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });
    await projectsService.archiveProject({
      projectId: first!.id,
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    const reseeded = await projectsService.getActiveProject(user.id, workspace.id);

    expect(reseeded!.id).not.toBe(first!.id);
    expectGeneratedPair(reseeded!.name);
    expect(reseeded!.name).not.toBe(workspace.name);
    expectHandlesAgree(reseeded!);
    const archived = await adminDb.project.findUniqueOrThrow({ where: { id: first!.id } });
    expect(archived.name).toBe(first!.name);
    expect(archived.archivedAt).not.toBeNull();
  });
});

describe('idempotency — the draw is per workspace, never per call', () => {
  it('a second seeding returns the same project and the same name', async () => {
    const { user, workspace } = await ownerWithWorkspace('gate-idem@example.com');
    const a = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });
    const b = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    expect(b!.id).toBe(a!.id);
    expect(b!.name).toBe(a!.name);
    expect(await projectsIn(workspace.id)).toHaveLength(1);
  });

  it('two parallel seedings of one empty workspace create ONE project with ONE name', async () => {
    const { user, workspace } = await ownerWithWorkspace('gate-parallel@example.com');

    // Both calls settle before anything is asserted, so no connection is left
    // in flight for the lane's probe.
    const [a, b] = await Promise.all([
      projectsService.ensureDefaultProject({ workspaceId: workspace.id, actorUserId: user.id }),
      projectsService.ensureDefaultProject({ workspaceId: workspace.id, actorUserId: user.id }),
    ]);

    expect(await projectsIn(workspace.id)).toHaveLength(1);
    expect(a!.id).toBe(b!.id);
    expect(a!.name).toBe(b!.name);
  });

  it('four workspaces seeded in one run draw at least two distinct names', async () => {
    // Not a two-name inequality: two draws may match once in about ten thousand.
    const { user } = await ownerWithWorkspace('gate-distinct@example.com');
    const names: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { workspace } = await workspacesService.createWorkspace({
        name: `Distinct ${i}`,
        ownerUserId: user.id,
      });
      const seeded = await projectsService.ensureDefaultProject({
        workspaceId: workspace.id,
        actorUserId: user.id,
      });
      expectGeneratedPair(seeded!.name);
      names.push(seeded!.name);
    }
    expect(new Set(names).size).toBeGreaterThanOrEqual(2);
  });
});

describe('a project a person names', () => {
  it('keeps the name typed, and the workspace resolves to it rather than to a seeded one', async () => {
    const user = await usersService.createUser({
      email: 'gate-named@example.com',
      password: PASSWORD,
      name: 'Named',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Named WS',
      ownerUserId: user.id,
    });

    const created = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Billing revamp',
    });
    const active = await projectsService.getActiveProject(user.id, workspace.id);

    expect(created.name).toBe('Billing revamp');
    expect(active!.id).toBe(created.id);
    expect(await projectsIn(workspace.id)).toHaveLength(1);
  });
});

describe('the rename — the name moves, the handles do not', () => {
  it('leaves the identifier, the slug and every work-item key exactly as seeded', async () => {
    const { user, workspace } = await ownerWithWorkspace('gate-rename@example.com');
    const ctx: WorkspaceContext = { userId: user.id, workspaceId: workspace.id };
    const seeded = (await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
    }))!;
    const item = await workItemsService.createWorkItem(
      { projectId: seeded.id, kind: 'task', title: 'Before the rename' },
      ctx,
    );
    expect(item.identifier).toBe(`${seeded.identifier}-${item.key}`);

    const renamed = await projectsService.updateDetails({
      key: seeded.identifier,
      ctx,
      name: 'Billing revamp',
    });
    expect(renamed.name).toBe('Billing revamp');
    expect(renamed.identifier).toBe(seeded.identifier);
    expect(renamed.slug).toBe(seeded.slug);

    const again = await projectsService.updateDetails({
      key: seeded.identifier,
      ctx,
      name: 'Billing revamp, phase two',
    });
    expect(again.name).toBe('Billing revamp, phase two');
    expect(again.identifier).toBe(seeded.identifier);
    expect(again.slug).toBe(seeded.slug);

    const row = await adminDb.project.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(row.name).toBe('Billing revamp, phase two');
    expect(row.identifier).toBe(seeded.identifier);
    expect(row.slug).toBe(seeded.slug);

    // The work item minted before the rename still carries its key, and that
    // key still names the project's (unchanged) key.
    const itemRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(itemRow.identifier).toBe(item.identifier);
    expect(itemRow.identifier.startsWith(`${seeded.identifier}-`)).toBe(true);
  });
});
