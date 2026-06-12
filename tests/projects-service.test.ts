import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError, ProjectWorkspaceMismatchError } from '@/lib/projects/errors';
import { NotAMemberError } from '@/lib/workspaces/errors';
import { truncateAuthTables } from './helpers/db';

// Comprehensive service-layer tests for projectsService + the per-project
// work-item counter on projectRepository (Subtask 1.3.5).
//
// Mirrors workspaces-service.test.ts: real Postgres, no DB mocks, the
// truncate helper resets between tests, typed-error assertions use the
// real error classes from lib/projects/errors.ts + lib/workspaces/errors.ts.
//
// Coverage:
//   - createProject identifier/slug derivation + per-workspace uniqueness
//   - identifier + slug collision retry (numeric suffix on identifier,
//     random suffix on slug)
//   - same identifier reusable across different workspaces
//   - caller-supplied identifier is normalized through the same shape rule
//   - membership gate for create / rename / archive / list / setActive
//   - allocateWorkItemNumber: monotonic per project AND independent across
//     projects
//   - setActiveProject: per-member, persisted on the membership row,
//     rejected when the project belongs to a different workspace
//   - archiveProject: drops the project from listProjects, second-call
//     behavior matches the service (asserted against the real shipped code)
//   - cascade: db.workspace.delete cascades to projects
//   - SetNull: a hard db.project.delete clears activeProjectId on the
//     membership row (the FK-level structural backstop)
//   - archive (soft-delete): clears the ACTOR's own activeProjectId but
//     leaves OTHER members' pointers intact (PRODECT_FINDINGS #29 / #16)
//   - getActiveProject: returns a normal pinned project, SURFACES an archived
//     pinned project (#29.2), RECOVERS + persists to the first non-archived
//     when the pointer is unset/stale (#29.3), and returns null when every
//     project is archived

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string, name = 'Owner') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

async function makeWorkspace(ownerEmail: string, workspaceName: string) {
  const owner = await makeUser(ownerEmail);
  const { workspace, membership } = await workspacesService.createWorkspace({
    name: workspaceName,
    ownerUserId: owner.id,
  });
  return { owner, workspace, membership };
}

describe('createProject — happy path', () => {
  it('derives a 3-5 char uppercase identifier and a slug from the name and returns a DTO', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');

    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Motir Core',
    });

    // DTO shape: id / name / slug / identifier / archivedAt / accessLevel +
    // the Story 6.8 avatar fields ONLY — never a raw Prisma row (no createdAt,
    // no lastWorkItemNumber). archivedAt rides on the DTO so the shell can flag
    // an archived active project (#29.2); a freshly created project is always
    // non-archived (null). avatarIcon/avatarColor backfill to null (the
    // mono-identifier rendering); `previousKeys` is NOT present here — it loads
    // only on the details-surface read path (6.8), not on a plain create.
    expect(Object.keys(project).sort()).toEqual([
      'accessLevel',
      'archivedAt',
      'avatarColor',
      'avatarIcon',
      'id',
      'identifier',
      'name',
      'slug',
    ]);
    expect(project.avatarIcon).toBeNull();
    expect(project.avatarColor).toBeNull();
    expect(project.name).toBe('Motir Core');
    expect(project.slug).toBe('motir-core');
    expect(project.archivedAt).toBeNull();
    expect(project.identifier).toMatch(/^[A-Z0-9]{3,5}$/);
    // "Motir Core" → strip non-alnum → "MOTIRCORE" → first 5 → "MOTIR"
    expect(project.identifier).toBe('MOTIR');

    // The row IS persisted with the bookkeeping fields, just not in the DTO.
    const persisted = await db.project.findUnique({ where: { id: project.id } });
    expect(persisted).not.toBeNull();
    expect(persisted?.workspaceId).toBe(workspace.id);
    expect(persisted?.lastWorkItemNumber).toBe(0);
    expect(persisted?.archivedAt).toBeNull();
  });

  it('pads a short name to the 3-char identifier minimum', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Hi',
    });
    // "Hi" → "HI" → pad to 3 with X → "HIX"
    expect(project.identifier).toBe('HIX');
    expect(project.identifier).toMatch(/^[A-Z0-9]{3,5}$/);
  });

  it('falls back to PRJ when the name strips to nothing', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: '!!!',
    });
    expect(project.identifier).toBe('PRJ');
    // Slug also has a documented fallback.
    expect(project.slug).toBe('project');
  });
});

describe('createProject — identifier collision retry', () => {
  it('appends a numeric suffix so the second project gets a distinct identifier in the same workspace', async () => {
    // Use two DISTINCT names so the slugs differ ("motir-core" vs
    // "motir-core-two"), then force the identifier to collide by passing
    // the same override. Targeted at the identifier-retry path only — the
    // slug-retry path has its own test below.
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');

    const first = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Motir Core',
      identifier: 'PRODE',
    });
    const second = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Motir Core Two',
      identifier: 'PRODE',
    });

    expect(first.identifier).toBe('PRODE');
    expect(second.identifier).not.toBe(first.identifier);
    // Documented pattern: base trimmed + numeric suffix, still <= 5 chars,
    // still uppercase + digits.
    expect(second.identifier).toMatch(/^[A-Z0-9]{3,5}$/);
    // First retry with attempt=1 produces "PROD1" (base "PRODE" trimmed to
    // 4 chars + "1") — assert the documented shape.
    expect(second.identifier).toBe('PROD1');
  });
});

describe('createProject — slug collision recovery (regression guard for Finding #15)', () => {
  it('recovers from a slug collision by suffixing both the slug and the identifier', async () => {
    // Regression guard for PRODECT_FINDINGS #15 (resolved in PR #33 commit
    // 74714e9). Background: Prisma 7 returns `undefined` for
    // `P2002.meta.target` against Postgres on the project table's composite
    // unique indexes, so the original `collisionField()` helper always
    // returned null and the slug-bump branch in createProject's retry loop
    // was dead code — a same-slug-different-identifier second insert would
    // loop on the same slug for all 5 attempts and throw
    // IdentifierCollisionError. Fix: unconditionally re-suffix BOTH fields
    // on every retry.
    //
    // This test pins the corrected behavior AND the documented trade-off
    // (see createProject's docstring): the second create succeeds with the
    // slug suffixed AND a numeric identifier suffix appended — even though
    // the identifier didn't actually collide. That's the cost of giving up
    // on `P2002.meta.target` and re-suffixing both fields unconditionally.
    // Identifier suffixes are cheap and human-readable, so this is the
    // durable shape over an unrecoverable retry loop.
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');

    const first = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Alpha',
      identifier: 'ONE',
    });
    expect(first.slug).toBe('alpha');
    expect(first.identifier).toBe('ONE');

    // Same slug ("alpha") + distinct identifier ("TWO") → identifier doesn't
    // collide, slug does. Pre-fix this hit IdentifierCollisionError on
    // attempt 5; post-fix the first retry succeeds with both fields bumped.
    const second = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Alpha',
      identifier: 'TWO',
    });
    // Identifier base "TWO" with a numeric suffix from the retry counter
    // (attempt + 1). The exact suffix value depends on how many retries the
    // loop runs; in this scenario it succeeds on the first retry → "TWO1".
    expect(second.identifier).toMatch(/^TWO\d+$/);
    expect(second.slug).not.toBe('alpha');
    expect(second.slug).toMatch(/^alpha-[a-z0-9]{4}$/);
    expect(second.id).not.toBe(first.id);
  });

  it('emits a deterministic slug for a non-colliding name', async () => {
    // Sanity check that uncontested slug derivation still produces the
    // documented deterministic shape. Sits in this describe block as a
    // companion to the regression-guard above.
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const p = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: '   Hello, World!! ',
    });
    expect(p.slug).toBe('hello-world');
  });
});

describe('createProject — uniqueness is per-workspace', () => {
  it('lets the SAME identifier exist in two different workspaces', async () => {
    const a = await makeWorkspace('a@example.com', 'A WS');
    const b = await makeWorkspace('b@example.com', 'B WS');

    const inA = await projectsService.createProject({
      workspaceId: a.workspace.id,
      actorUserId: a.owner.id,
      name: 'Apollo',
      identifier: 'APOL',
    });
    const inB = await projectsService.createProject({
      workspaceId: b.workspace.id,
      actorUserId: b.owner.id,
      name: 'Apollo',
      identifier: 'APOL',
    });

    expect(inA.identifier).toBe('APOL');
    expect(inB.identifier).toBe('APOL');
    // Same identifier; distinct rows (different workspaces).
    expect(inA.id).not.toBe(inB.id);
  });
});

describe('createProject — caller-supplied identifier override', () => {
  it('normalizes a lowercase + symbol-laden override through the same shape contract', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');

    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Anything',
      identifier: 'p-rod!', // lowercase + symbols
    });

    // Stripped non-alnum, uppercased, clamped to 5 chars: "PROD"
    expect(project.identifier).toBe('PROD');
    expect(project.identifier).toMatch(/^[A-Z0-9]{3,5}$/);
  });

  it('pads a too-short override up to 3 chars', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Whatever',
      identifier: 'a',
    });
    expect(project.identifier).toBe('AXX');
  });
});

describe('membership gate — non-member is rejected with NotAMemberError', () => {
  it('blocks createProject for a non-member', async () => {
    const { workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const stranger = await makeUser('stranger@example.com', 'Stranger');

    await expect(
      projectsService.createProject({
        workspaceId: workspace.id,
        actorUserId: stranger.id,
        name: 'Forbidden',
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
    await expect(
      projectsService.createProject({
        workspaceId: workspace.id,
        actorUserId: stranger.id,
        name: 'Forbidden',
      }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('blocks renameProject for a non-member', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const stranger = await makeUser('stranger@example.com', 'Stranger');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Existing',
    });

    await expect(
      projectsService.renameProject({
        projectId: project.id,
        workspaceId: workspace.id,
        actorUserId: stranger.id,
        name: 'Hacked',
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  it('blocks archiveProject for a non-member', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const stranger = await makeUser('stranger@example.com', 'Stranger');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Existing',
    });

    await expect(
      projectsService.archiveProject({
        projectId: project.id,
        workspaceId: workspace.id,
        actorUserId: stranger.id,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  it('blocks listProjects for a non-member', async () => {
    const { workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const stranger = await makeUser('stranger@example.com', 'Stranger');

    await expect(projectsService.listProjects(workspace.id, stranger.id)).rejects.toBeInstanceOf(
      NotAMemberError,
    );
  });

  it('blocks setActiveProject for a non-member', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const stranger = await makeUser('stranger@example.com', 'Stranger');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Existing',
    });

    await expect(
      projectsService.setActiveProject({
        userId: stranger.id,
        workspaceId: workspace.id,
        projectId: project.id,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });
});

describe('allocateWorkItemNumber — monotonic + independent per project', () => {
  it('returns sequential 1,2,3 within a project', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'P',
    });

    const n1 = await db.$transaction((tx) =>
      projectRepository.allocateWorkItemNumber(project.id, tx),
    );
    const n2 = await db.$transaction((tx) =>
      projectRepository.allocateWorkItemNumber(project.id, tx),
    );
    const n3 = await db.$transaction((tx) =>
      projectRepository.allocateWorkItemNumber(project.id, tx),
    );

    expect([n1, n2, n3]).toEqual([1, 2, 3]);
  });

  it('keeps the counter independent across projects (A and B do not interfere)', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const a = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Apollo',
      identifier: 'APOL',
    });
    const b = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Beacon',
      identifier: 'BEAC',
    });

    // Advance A's counter several times — B's counter must not move.
    await db.$transaction((tx) => projectRepository.allocateWorkItemNumber(a.id, tx));
    await db.$transaction((tx) => projectRepository.allocateWorkItemNumber(a.id, tx));
    await db.$transaction((tx) => projectRepository.allocateWorkItemNumber(a.id, tx));

    const bRowBefore = await db.project.findUnique({ where: { id: b.id } });
    expect(bRowBefore?.lastWorkItemNumber).toBe(0);

    // Now allocate B's first number — it must be 1, not 4.
    const b1 = await db.$transaction((tx) => projectRepository.allocateWorkItemNumber(b.id, tx));
    expect(b1).toBe(1);

    // Confirm A's counter is at 3 (unaffected by B's allocation).
    const aRow = await db.project.findUnique({ where: { id: a.id } });
    expect(aRow?.lastWorkItemNumber).toBe(3);
  });

  it('throws ProjectNotFoundError when allocating against a missing project id', async () => {
    await expect(
      db.$transaction((tx) => projectRepository.allocateWorkItemNumber('does-not-exist', tx)),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('setActiveProject — per-member, persisted, cross-workspace guarded', () => {
  it('persists activeProjectId on the actor’s membership row', async () => {
    const { owner, workspace, membership } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Alpha',
    });

    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    const row = await db.workspaceMembership.findUnique({ where: { id: membership.id } });
    expect(row?.activeProjectId).toBe(project.id);
  });

  it('clears activeProjectId when called with null', async () => {
    const { owner, workspace, membership } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Alpha',
    });
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: null,
    });

    const row = await db.workspaceMembership.findUnique({ where: { id: membership.id } });
    expect(row?.activeProjectId).toBeNull();
  });

  it('lets two members of the same workspace have independent active projects', async () => {
    const {
      owner,
      workspace,
      membership: ownerMembership,
    } = await makeWorkspace('owner@example.com', 'Acme');
    const second = await makeUser('second@example.com', 'Second');
    const secondMembership = await workspacesService.addMember({
      userId: second.id,
      workspaceId: workspace.id,
    });

    const alpha = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Alpha',
      identifier: 'ALPH',
    });
    const beta = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Beta',
      identifier: 'BETA',
    });

    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: alpha.id,
    });
    await projectsService.setActiveProject({
      userId: second.id,
      workspaceId: workspace.id,
      projectId: beta.id,
    });

    const ownerRow = await db.workspaceMembership.findUnique({
      where: { id: ownerMembership.id },
    });
    const secondRow = await db.workspaceMembership.findUnique({
      where: { id: secondMembership.id },
    });
    expect(ownerRow?.activeProjectId).toBe(alpha.id);
    expect(secondRow?.activeProjectId).toBe(beta.id);
  });

  it('rejects setting a project that belongs to a DIFFERENT workspace', async () => {
    const a = await makeWorkspace('a@example.com', 'A WS');
    const b = await makeWorkspace('b@example.com', 'B WS');
    const projectInB = await projectsService.createProject({
      workspaceId: b.workspace.id,
      actorUserId: b.owner.id,
      name: 'BProject',
    });

    await expect(
      projectsService.setActiveProject({
        userId: a.owner.id,
        workspaceId: a.workspace.id,
        projectId: projectInB.id,
      }),
    ).rejects.toBeInstanceOf(ProjectWorkspaceMismatchError);
  });

  it('rejects setting a missing project id', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');

    await expect(
      projectsService.setActiveProject({
        userId: owner.id,
        workspaceId: workspace.id,
        projectId: 'does-not-exist',
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('renameProject', () => {
  it('updates the name, leaves slug + identifier stable', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Old Name',
    });

    const renamed = await projectsService.renameProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: '  New Name  ',
    });

    expect(renamed.name).toBe('New Name');
    expect(renamed.slug).toBe(project.slug); // stable
    expect(renamed.identifier).toBe(project.identifier); // stable

    const persisted = await db.project.findUnique({ where: { id: project.id } });
    expect(persisted?.name).toBe('New Name');
  });

  it('rejects renaming a project that belongs to a different workspace', async () => {
    const a = await makeWorkspace('a@example.com', 'A WS');
    const b = await makeWorkspace('b@example.com', 'B WS');
    // The actor is a member of BOTH workspaces; we still expect the
    // workspace-mismatch guard to fire because projectId belongs to B
    // but workspaceId points to A.
    await workspacesService.addMember({
      userId: a.owner.id,
      workspaceId: b.workspace.id,
    });
    const projectInB = await projectsService.createProject({
      workspaceId: b.workspace.id,
      actorUserId: b.owner.id,
      name: 'BProject',
    });

    await expect(
      projectsService.renameProject({
        projectId: projectInB.id,
        workspaceId: a.workspace.id,
        actorUserId: a.owner.id,
        name: 'Pwned',
      }),
    ).rejects.toBeInstanceOf(ProjectWorkspaceMismatchError);
  });
});

describe('archiveProject + listProjects', () => {
  it('archives a project and drops it from listProjects', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const keep = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Keep',
      identifier: 'KEEP',
    });
    const drop = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Drop',
      identifier: 'DROP',
    });

    const before = await projectsService.listProjects(workspace.id, owner.id);
    expect(before.map((p) => p.id).sort()).toEqual([keep.id, drop.id].sort());

    await projectsService.archiveProject({
      projectId: drop.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const after = await projectsService.listProjects(workspace.id, owner.id);
    expect(after.map((p) => p.id)).toEqual([keep.id]);

    const archivedRow = await db.project.findUnique({ where: { id: drop.id } });
    expect(archivedRow?.archivedAt).not.toBeNull();
  });

  it('archiving the same project a second time succeeds and is a no-op (re-stamps archivedAt)', async () => {
    // Read the shipped behavior: archiveProject calls projectRepository.archive,
    // which UPDATEs archivedAt = now(). It does NOT guard against archived
    // projects, so a second call re-stamps the timestamp rather than throwing.
    // Asserting the ACTUAL behavior here (not aspirational idempotence).
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Twice',
    });

    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    const firstStamp = await db.project.findUnique({ where: { id: project.id } });
    const firstArchivedAt = firstStamp?.archivedAt;
    expect(firstArchivedAt).not.toBeNull();

    // Small sleep so the re-stamp clock advances enough to be distinguishable.
    await new Promise((r) => setTimeout(r, 20));

    await expect(
      projectsService.archiveProject({
        projectId: project.id,
        workspaceId: workspace.id,
        actorUserId: owner.id,
      }),
    ).resolves.toBeUndefined();
    const secondStamp = await db.project.findUnique({ where: { id: project.id } });
    expect(secondStamp?.archivedAt).not.toBeNull();
    // Project remains hidden from listProjects either way.
    const list = await projectsService.listProjects(workspace.id, owner.id);
    expect(list.find((p) => p.id === project.id)).toBeUndefined();
  });
});

describe('cascade: deleting the parent workspace removes its projects', () => {
  it('db.workspace.delete cascades to all projects in the workspace', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Doomed');
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'A',
      identifier: 'AAAA',
    });
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'B',
      identifier: 'BBBB',
    });

    expect(await db.project.count({ where: { workspaceId: workspace.id } })).toBe(2);
    await db.workspace.delete({ where: { id: workspace.id } });
    expect(await db.project.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });
});

describe('SetNull: hard-deleting a project clears the member’s activeProjectId', () => {
  it('a hard db.project.delete sets activeProjectId to null on the membership row', async () => {
    const { owner, workspace, membership } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Active',
    });
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    const beforeRow = await db.workspaceMembership.findUnique({
      where: { id: membership.id },
    });
    expect(beforeRow?.activeProjectId).toBe(project.id);

    // Hard delete bypasses the soft-delete service path — this exercises the
    // FK-level onDelete: SetNull declared on WorkspaceMembership.activeProject.
    await db.project.delete({ where: { id: project.id } });

    const afterRow = await db.workspaceMembership.findUnique({
      where: { id: membership.id },
    });
    expect(afterRow?.activeProjectId).toBeNull();
  });

  it('archiveProject clears the ACTOR’s own activeProjectId pointer (PRODECT_FINDINGS #29 / #16)', async () => {
    // Resolution of the gap previously logged here: archiveProject now clears
    // the actor's own activeProjectId when it referenced the archived project,
    // so the actor "moves on" (getActiveProject recovers to the next project
    // or the empty state). OTHER members keep their pointer — asserted in the
    // sibling test below.
    const { owner, workspace, membership } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Pinned',
    });
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const row = await db.workspaceMembership.findUnique({
      where: { id: membership.id },
    });
    expect(row?.activeProjectId).toBeNull();
  });

  it('archiveProject leaves OTHER members’ activeProjectId intact (enables the #29.2 Archived pill)', async () => {
    // The #29.2 scenario: a teammate archives a project another member still
    // has open. The other member's pointer must survive so getActiveProject
    // surfaces the archived project (with the Archived pill) for them rather
    // than silently swapping it out.
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Shared',
    });

    // A second member who has the same project pinned.
    const other = await makeUser('other@example.com', 'Other');
    const otherMembership = await db.workspaceMembership.create({
      data: {
        userId: other.id,
        workspaceId: workspace.id,
        role: 'member',
        activeProjectId: project.id,
      },
    });

    // The owner (not `other`) archives the project.
    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const otherRow = await db.workspaceMembership.findUnique({
      where: { id: otherMembership.id },
    });
    expect(otherRow?.activeProjectId).toBe(project.id);
  });
});

describe('getActiveProject — resolution, archived surfacing (#29.2), recovery (#29.3)', () => {
  it('returns the pinned project with archivedAt=null for a normal active project', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Active',
    });
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    const resolved = await projectsService.getActiveProject(owner.id, workspace.id);
    expect(resolved?.id).toBe(project.id);
    expect(resolved?.archivedAt).toBeNull();
  });

  it('surfaces an archived pinned project (archivedAt set) instead of swapping it out (#29.2)', async () => {
    // Simulate a teammate archiving a project another member still has pinned:
    // archive the project directly via the repo (so the actor-clears path does
    // NOT fire), leaving the owner's pointer at the now-archived project.
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const pinned = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Pinned',
    });
    // A second, non-archived project exists — proving we surface the archived
    // pinned one rather than falling back to this available alternative.
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Other',
    });
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: pinned.id,
    });
    await db.project.update({ where: { id: pinned.id }, data: { archivedAt: new Date() } });

    const resolved = await projectsService.getActiveProject(owner.id, workspace.id);
    expect(resolved?.id).toBe(pinned.id);
    expect(resolved?.archivedAt).not.toBeNull();
  });

  it('recovers to the first non-archived project and PERSISTS the pointer when it is unset (#29.3)', async () => {
    const { owner, workspace, membership } = await makeWorkspace('owner@example.com', 'Acme');
    // Two projects, NO active pointer set on the membership row.
    const first = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'First',
    });
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Second',
    });
    // createProject does NOT pin; ensure the pointer really is null.
    await db.workspaceMembership.update({
      where: { id: membership.id },
      data: { activeProjectId: null },
    });

    const resolved = await projectsService.getActiveProject(owner.id, workspace.id);
    expect(resolved?.id).toBe(first.id);

    // The recovery self-heals the pointer so subsequent reads don't re-recover.
    const row = await db.workspaceMembership.findUnique({ where: { id: membership.id } });
    expect(row?.activeProjectId).toBe(first.id);
  });

  it('returns null when every project is archived and no pointer resolves', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const only = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Only',
    });
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: only.id,
    });
    // Owner archives their own only project → pointer cleared, none remain.
    await projectsService.archiveProject({
      projectId: only.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const resolved = await projectsService.getActiveProject(owner.id, workspace.id);
    expect(resolved).toBeNull();
  });
});
