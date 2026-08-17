import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { homeService } from '@/lib/services/homeService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceContext } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { truncateAuthTables } from '../../helpers/db';
import {
  createTestProject,
  createTestUser,
  createTestWorkItem as createWorkItem,
  makeWorkItemFixture as makeFixture,
  type WorkItemFixture,
} from '../../fixtures';
import type { ProjectDTO } from '@/lib/dto/projects';

// The STORY-level seam tests for Home (Story MOTIR-2649 · Subtask MOTIR-2655),
// against the real Postgres and the shipped services. The subtask suites
// (`personal-reads.test.ts`) covers each read's own
// behaviour; this file covers the story's correctness CLAIMS at the seam where
// they can break, and it is written to a stricter bar than the others:
//
//   ⚠️ NO ASSERTION HERE MAY PASS VACUOUSLY. An access test that passes because
//   the fixture happened to hold no inaccessible item is worse than no test —
//   it is a green check certifying nothing. So every "must not appear" case is
//   paired with a POSITIVE CONTROL: the same fixture read through the same
//   repository with the guard's input widened, proving the row is there and
//   that only the guard is keeping it out. Deleting the browsable-set filter
//   turns each of these red, which is the property the card asks for and the
//   one a reader cannot otherwise verify.
//
// The other thing that only exists at this tier: the dedupe and the access
// filter are both asserted ACROSS A PAGE BOUNDARY. A single-page test cannot
// see either failure — a service-side union deduping after the LIMIT, or a
// post-read filter shortening a page — because with one page there is no
// boundary for them to be wrong at.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

async function touch(id: string, iso: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { updatedAt: new Date(iso) } });
}

async function own(
  id: string,
  who: { assignee?: string | null; reporter?: string },
): Promise<void> {
  await adminDb.workItem.update({
    where: { id },
    data: {
      ...(who.assignee !== undefined ? { assigneeId: who.assignee } : {}),
      ...(who.reporter !== undefined ? { reporterId: who.reporter } : {}),
    },
  });
}

function inProject(fx: WorkItemFixture, project: ProjectDTO): WorkItemFixture {
  return { ...fx, project, projectId: project.id, projectIdentifier: project.identifier };
}

/**
 * The reader's context AS HOME NOW TAKES IT — the workspace pair plus the ACTIVE
 * project (MOTIR-2761). The access cases below point the reader AT the project
 * under test: with the scope narrowed, a private project the reader is merely
 * not switched into is excluded by the project axis alone, and an access
 * assertion arranged that way would stay green with the browsable-set filter
 * deleted — the vacuous pass this file exists to refuse.
 */
const hctx = (fx: WorkItemFixture, projectId: string = fx.projectId) => ({
  ...fx.ctx,
  projectId,
});

/**
 * THE POSITIVE CONTROL. Reads the personal query with EVERY project id in the
 * workspace — i.e. with the browsable-set guard's input widened to "everything"
 * — so a test can prove the row it expects to be hidden is in fact present and
 * reachable, and that the guard is the only thing excluding it.
 */
async function readWithoutAccessFilter(
  ctx: { userId: string; workspaceId: string },
  take = 100,
): Promise<string[]> {
  return withWorkspaceContext(ctx, async (tx) => {
    const all = await projectRepository.findByWorkspace(ctx.workspaceId, tx);
    const rows = await workItemRepository.findByAssigneeOrReporterInWorkspace(
      ctx.userId,
      ctx.workspaceId,
      { projectScopes: all.map((p) => ({ projectId: p.id, doneStatusKeys: [] })), take },
      tx,
    );
    return rows.map((r) => r.identifier);
  });
}

/** The browsable set the service actually resolves for a reader. */
async function browsableFor(ctx: { userId: string; workspaceId: string }): Promise<string[]> {
  return withWorkspaceContext(ctx, async (tx) => {
    const all = await projectRepository.findByWorkspace(ctx.workspaceId, tx);
    const ok = await projectAccessService.filterBrowsable(all, ctx, tx);
    return ok.map((p) => p.id);
  });
}

describe('Home story seam — the dedupe, at the boundary that can break it', () => {
  it('keeps a BOTH-assignee-and-reporter item to ONE row while it straddles a page boundary', async () => {
    const fx = await makeFixture({ identifier: 'SD' });
    const other = await createTestUser({ email: `sd-${Date.now()}@example.com` });
    await workspacesService.addMember({
      userId: other.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });

    // Nine items, alternating the reader's relation, with the BOTH items
    // deliberately placed either side of every page edge at limit = 4.
    const made: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const item = await createWorkItem(fx, { kind: 'task', title: `Item ${i}` });
      made.push(item.identifier);
      const relation = i % 3;
      await own(item.id, {
        assignee: relation === 1 ? other.id : fx.ownerId,
        reporter: relation === 2 ? other.id : fx.ownerId,
      });
      await touch(item.id, `2026-08-11T0${i}:00:00.000Z`);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: { identifier: string }[]; nextCursor: string | null } =
        await homeService.listMyWork(hctx(fx), { limit: 4, cursor });
      // Every page but the last is FULL — the has-more probe makes the boundary
      // exact, so a short page here would mean rows were dropped after the read.
      if (page.nextCursor !== null) expect(page.items).toHaveLength(4);
      seen.push(...page.items.map((r) => r.identifier));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBeGreaterThan(1); // there IS a boundary to be wrong at
    expect(new Set(seen).size).toBe(seen.length); // no id repeated across pages
    expect(seen.slice().sort()).toEqual(made.slice().sort()); // and none dropped
  });

  it('says BOTH on the one row, which is what makes the single row honest', async () => {
    const fx = await makeFixture({ identifier: 'SB' });
    const both = await createWorkItem(fx, { kind: 'task', title: 'Both' });
    await own(both.id, { assignee: fx.ownerId, reporter: fx.ownerId });

    const rows = (await homeService.listMyWork(hctx(fx))).items;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ viewerIsAssignee: true, viewerIsReporter: true });
  });
});

describe('Home story seam — the access matrix', () => {
  it('hides a PRIVATE project the reader is not a member of — and the control proves it is there', async () => {
    const fx = await makeFixture({ identifier: 'AM' });
    const secret = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'AMS',
    });
    await adminDb.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });

    const open = await createWorkItem(fx, { kind: 'task', title: 'Open' });
    const hidden = await createWorkItem(inProject(fx, secret), { kind: 'task', title: 'Hidden' });

    const member = await createTestUser({ email: `am-${Date.now()}@example.com` });
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });
    // The reader is the REPORTER of both — the only difference is the project.
    await own(open.id, { assignee: null, reporter: member.id });
    await own(hidden.id, { assignee: null, reporter: member.id });

    const ctx = { userId: member.id, workspaceId: fx.workspaceId };

    // The guard's own input, first: the private project is genuinely excluded.
    expect(await browsableFor(ctx)).toEqual([fx.projectId]);
    // THE POSITIVE CONTROL — with the filter widened, the hidden row IS there.
    expect((await readWithoutAccessFilter(ctx)).sort()).toEqual(
      [open.identifier, hidden.identifier].sort(),
    );
    // And through the service, WITH THE PRIVATE PROJECT ACTIVE, it is not — the
    // arrangement in which the access filter is the only thing that can be
    // excluding it (MOTIR-2761: point the reader at it, not beside it).
    expect((await homeService.listMyWork({ ...ctx, projectId: secret.id })).items).toEqual([]);
    // …and the browsable one still reads, so "always empty" cannot pass this.
    expect(
      (await homeService.listMyWork({ ...ctx, projectId: fx.projectId })).items.map(
        (r) => r.identifier,
      ),
    ).toEqual([open.identifier]);
  });

  it('SHOWS the same private project once the reader is a member of it', async () => {
    const fx = await makeFixture({ identifier: 'AMM' });
    const secret = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'AMN',
    });
    await adminDb.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });
    const item = await createWorkItem(inProject(fx, secret), {
      kind: 'task',
      title: 'Now visible',
    });

    const member = await createTestUser({ email: `amm-${Date.now()}@example.com` });
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });
    await own(item.id, { assignee: member.id, reporter: fx.ownerId });
    await projectMembersService.addMember({
      key: secret.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: member.id,
      role: 'viewer',
    });

    const ctx = { userId: member.id, workspaceId: fx.workspaceId, projectId: secret.id };

    // The mirror of the case above: the SAME project, the SAME active pointer,
    // the only difference being project membership. The filter is what decides,
    // and it decides both ways — without this, "always empty" would pass the
    // previous test too.
    expect((await homeService.listMyWork(ctx)).items.map((r) => r.identifier)).toEqual([
      item.identifier,
    ]);
  });

  it('hides a SECOND WORKSPACE, and hides everything from a NON-MEMBER', async () => {
    const here = await makeFixture({ identifier: 'AW' });
    const elsewhere = await makeFixture({ identifier: 'AX' });

    const mine = await createWorkItem(here, { kind: 'task', title: 'Here' });
    const theirs = await createWorkItem(elsewhere, { kind: 'task', title: 'There' });
    await own(mine.id, { assignee: here.ownerId, reporter: here.ownerId });
    await own(theirs.id, { assignee: here.ownerId, reporter: here.ownerId });

    // Same person, same two items — only the workspace in the context differs.
    expect((await homeService.listMyWork(hctx(here))).items.map((r) => r.identifier)).toEqual([
      mine.identifier,
    ]);

    // A NON-MEMBER of the workspace resolves to NO browsable projects, so the
    // read is empty rather than an error (the no-existence-leak convention).
    const stranger = await createTestUser({ email: `aw-${Date.now()}@example.com` });
    await own(mine.id, { assignee: stranger.id });
    const strangerCtx = {
      userId: stranger.id,
      workspaceId: here.workspaceId,
      projectId: here.projectId,
    };
    expect(await browsableFor({ userId: stranger.id, workspaceId: here.workspaceId })).toEqual([]);
    // THE CONTROL: the stranger IS the assignee — only membership excludes them.
    expect(
      await readWithoutAccessFilter({ userId: stranger.id, workspaceId: here.workspaceId }),
    ).toEqual([mine.identifier]);
    expect((await homeService.listMyWork(strangerCtx)).items).toEqual([]);
  });

  it('REQUEST N, GET N — a filtered-out row shortens no page', async () => {
    const fx = await makeFixture({ identifier: 'AN' });
    const secret = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'ANS',
    });
    await adminDb.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });

    const member = await createTestUser({ email: `an-${Date.now()}@example.com` });
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });

    // INTERLEAVED by updatedAt: visible, hidden, visible, hidden, … so a
    // post-read filter would carve holes out of the middle of every page. Since
    // MOTIR-2761 the surviving hole-carver is the DONE-category exclusion, which
    // is the other half of the same scope object — so the interleave is by
    // lifecycle, inside the one project, and the private project stays as the
    // control that the access half is still in the query too.
    const visible: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const item = await createWorkItem(fx, { kind: 'task', title: `I${i}` });
      await own(item.id, { assignee: member.id, reporter: fx.ownerId });
      await touch(item.id, `2026-08-11T${String(i).padStart(2, '0')}:00:00.000Z`);
      if (i % 2 === 0) visible.push(item.identifier);
      else await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
    }
    const hidden = await createWorkItem(inProject(fx, secret), { kind: 'task', title: 'Hidden' });
    await own(hidden.id, { assignee: member.id, reporter: fx.ownerId });

    const ctx = { userId: member.id, workspaceId: fx.workspaceId, projectId: fx.projectId };
    // The control: all thirteen are the reader's, and one is in the private project.
    expect(
      await readWithoutAccessFilter({ userId: member.id, workspaceId: fx.workspaceId }),
    ).toHaveLength(13);

    const first = await homeService.listMyWork(ctx, { limit: 3 });
    const second = await homeService.listMyWork(ctx, { limit: 3, cursor: first.nextCursor });

    // FULL pages, both of them. A JavaScript-side filter after a `take: 3` read
    // would return one or two rows here — the exact "the list ends early
    // sometimes" bug the query-input design exists to make impossible.
    expect(first.items).toHaveLength(3);
    expect(second.items).toHaveLength(3);
    expect([...first.items, ...second.items].map((r) => r.identifier).sort()).toEqual(
      visible.slice().sort(),
    );
  });

  it('applies the same matrix to the WATCHING read', async () => {
    const fx = await makeFixture({ identifier: 'AWT' });
    const secret = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'AWS',
    });
    await adminDb.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });

    const open = await createWorkItem(fx, { kind: 'task', title: 'Open' });
    const hidden = await createWorkItem(inProject(fx, secret), { kind: 'task', title: 'Hidden' });
    const member = await createTestUser({ email: `awt-${Date.now()}@example.com` });
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });
    await adminDb.$transaction(async (tx) => {
      await watcherRepository.add(open.id, member.id, tx);
      await watcherRepository.add(hidden.id, member.id, tx);
    });

    const ctx = { userId: member.id, workspaceId: fx.workspaceId };

    // THE CONTROL: both watches exist, so only the browsable set excludes one.
    expect(await adminDb.watcher.count({ where: { userId: member.id } })).toBe(2);
    // Pointed at the private project: empty. Pointed at the open one: the row.
    // Same reader, same two watches — only the access rule differs.
    expect((await homeService.listWatching({ ...ctx, projectId: secret.id })).items).toEqual([]);
    expect(
      (await homeService.listWatching({ ...ctx, projectId: fx.projectId })).items.map(
        (r) => r.identifier,
      ),
    ).toEqual([open.identifier]);
  });
});

describe('Home story seam — the scope is the ACTIVE PROJECT (MOTIR-2761)', () => {
  it('returns DIFFERENT rows as the reader s ACTIVE PROJECT is switched — through the shipped resolver', async () => {
    // ⚠️ THE INVERSION. Until 2026-08-17 this block was headed "the scope is the
    // WORKSPACE, not the active project" and asserted that switching changed
    // nothing — a contract test for the defect itself. `/home` sits FIRST in the
    // project tier of the rail, under the switcher the shell renders on every
    // authed page, so "switching changes nothing" was a passing test asserting
    // that a shipped control does nothing on the first screen after sign-in.
    const fx = await makeFixture({ identifier: 'SP' });
    const second = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Atlas',
      identifier: 'SQ',
    });
    const first = await createWorkItem(fx, { kind: 'task', title: 'In one' });
    const alsoMine = await createWorkItem(inProject(fx, second), { kind: 'task', title: 'In two' });

    // Read through the SHIPPED resolver the page uses — `projectsService`
    // decides what "active" means, and a test that hand-passed an id would not
    // notice the page and the service disagreeing about it.
    const read = async () => {
      const active = await projectsService.getActiveProject(fx.ownerId, fx.workspaceId);
      const page = await homeService.listMyWork({ ...fx.ctx, projectId: active!.id });
      return page.items.map((r) => r.identifier).sort();
    };

    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const withFirstActive = await read();
    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: second.id,
    });
    const withSecondActive = await read();

    // The reader owns BOTH items, so the only thing separating them is which
    // project is active. Each read holds exactly its own, and neither is a
    // subset of the other — a scope that merely SHRANK would pass one of these.
    expect(withFirstActive).toEqual([first.identifier]);
    expect(withSecondActive).toEqual([alsoMine.identifier]);
    expect(withFirstActive).not.toEqual(withSecondActive);
  });
});

describe('Home story seam — the two tabs are different questions', () => {
  it('returns an owned-AND-watched item from BOTH reads, and each read excludes the other s exclusive', async () => {
    const fx = await makeFixture({ identifier: 'TT' });
    const other = await createTestUser({ email: `tt-${Date.now()}@example.com` });
    await workspacesService.addMember({
      userId: other.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });

    const ownedOnly = await createWorkItem(fx, { kind: 'task', title: 'Owned only' });
    const watchedOnly = await createWorkItem(fx, { kind: 'task', title: 'Watched only' });
    const both = await createWorkItem(fx, { kind: 'task', title: 'Owned and watched' });
    await own(watchedOnly.id, { assignee: other.id, reporter: other.id });
    await adminDb.$transaction(async (tx) => {
      await watcherRepository.add(watchedOnly.id, fx.ownerId, tx);
      await watcherRepository.add(both.id, fx.ownerId, tx);
    });

    const work = (await homeService.listMyWork(hctx(fx))).items.map((r) => r.id);
    const watching = (await homeService.listWatching(hctx(fx))).items.map((r) => r.id);

    expect(work).toContain(ownedOnly.id);
    expect(work).toContain(both.id);
    expect(work).not.toContain(watchedOnly.id);

    expect(watching).toContain(watchedOnly.id);
    expect(watching).toContain(both.id); // the overlap is deliberate
    expect(watching).not.toContain(ownedOnly.id);
  });
});

describe('Home story seam — an agent-executed item is not special', () => {
  it('returns it from BOTH reads, carrying executor and the owning project', async () => {
    const fx = await makeFixture({ identifier: 'AG' });
    const agentItem = await createWorkItem(fx, {
      kind: 'task',
      title: 'An agent is on it',
      type: 'code',
      executor: 'coding_agent',
    });
    await adminDb.$transaction((tx) => watcherRepository.add(agentItem.id, fx.ownerId, tx));

    const work = (await homeService.listMyWork(hctx(fx))).items;
    const watching = (await homeService.listWatching(hctx(fx))).items;

    for (const rows of [work, watching]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        executor: 'coding_agent',
        project: { identifier: fx.projectIdentifier, name: 'Motir' },
      });
    }
  });
});
