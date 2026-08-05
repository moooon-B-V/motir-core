import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  CODE_GRAPH_RETENTION_WINDOW_DAYS,
  CODE_GRAPH_RETENTION_WINDOW_MS,
  OFFBOARD_ALL_REPOS,
  isImmediate,
  offboardDueAt,
} from '@/lib/codeGraph/offboarding';
import { codeGraphOffboardingRepository } from '@/lib/repositories/codeGraphOffboardingRepository';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables, truncateCodeGraphOffboarding } from './helpers/db';

// THE CODE-GRAPH OFFBOARDING QUEUE (MOTIR-2166 ·
// `docs/decisions/code-graph-index-fleet.md` §14) — real Postgres, the shipped
// services, no DB mocks.
//
// §14 commits the product to a stated 30-day retention window for a derived code
// graph. A window is deferred work, so something must survive the trigger long
// enough to do it. This suite proves that something behaves:
//
//   1. the WINDOW and the sentinel (pure)
//   2. enqueue / cancel / upsert semantics
//   3. ⚠️ the row SURVIVES `deleteWorkspace` — the single most important
//      assertion on the card, and the reason the table has no foreign key
//   4. every trigger enqueues with the right scope and `dueAt`
//   5. enqueue is POST-COMMIT and QUIET — a failing queue write may not fail or
//      roll back the user's disconnect / archive / delete
//   6. cancel-on-reconnect, which is what makes the window a grace period

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
  // Explicitly, because a workspace CASCADE deliberately cannot reach this table
  // — see the helper's comment. Section 3 is the same fact, asserted.
  await truncateCodeGraphOffboarding();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeWorkspace(email: string, name: string) {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  return { owner, workspace };
}

async function makeProject(workspaceId: string, actorUserId: string, name: string) {
  return projectsService.createProject({ workspaceId, actorUserId, name });
}

/** Every queue row, unscoped — read under system context, which is the only reach the policy admits. */
async function allRows() {
  return withSystemContext((tx) =>
    tx.codeGraphOffboarding.findMany({ orderBy: [{ coreProjectId: 'asc' }, { repoRef: 'asc' }] }),
  );
}

// ── 1. the window and the sentinel ───────────────────────────────────────────

describe('the retention window (§14.3)', () => {
  it('is 30 days, as ONE named constant', () => {
    // The value is USER-FACING — MOTIR-2171 renders it in the disconnect /
    // archive / delete dialogs. A literal at four call sites is how the promise
    // and the behaviour drift apart (`notes.html` #185).
    expect(CODE_GRAPH_RETENTION_WINDOW_DAYS).toBe(30);
    expect(CODE_GRAPH_RETENTION_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('is applied to the three reversible triggers and NOT to a workspace delete', () => {
    const now = new Date('2026-08-05T00:00:00.000Z');
    const windowed = new Date(now.getTime() + CODE_GRAPH_RETENTION_WINDOW_MS);

    for (const reason of [
      'repo_disconnected',
      'connection_disconnected',
      'project_archived',
    ] as const) {
      expect(isImmediate(reason)).toBe(false);
      expect(offboardDueAt(reason, now)).toEqual(windowed);
    }

    // A hard delete leaves no surface to undo into, so a window would protect
    // nothing and only extend retention — "a grace period the user cannot reach
    // is not a grace period."
    expect(isImmediate('workspace_deleted')).toBe(true);
    expect(offboardDueAt('workspace_deleted', now)).toEqual(now);
  });

  it('uses a sentinel repoRef for "every repo", not NULL', () => {
    // Not cosmetic. Postgres treats NULLs as distinct in a unique index, so a
    // nullable column would let two project-wide rows for one project both
    // insert, and Prisma cannot express a null component in the compound-unique
    // `where` an upsert needs. §14's "enqueue is an upsert" only holds with this.
    expect(OFFBOARD_ALL_REPOS).toBe('*');
    // It can never collide with a real value: a repoRef is always `owner/name`.
    expect(OFFBOARD_ALL_REPOS).not.toContain('/');
  });
});

// ── 2. enqueue / cancel semantics ────────────────────────────────────────────

describe('enqueue and cancel', () => {
  it('writes one row per (project × repo) and re-enqueue UPSERTS rather than stacking', async () => {
    const now = new Date('2026-08-05T00:00:00.000Z');
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1', 'p2'],
      repoRefs: ['acme/api'],
      reason: 'repo_disconnected',
      now,
    });

    expect(await allRows()).toHaveLength(2);

    // The same scope again — a repo disconnected, reconnected and disconnected
    // again must hold ONE row carrying the LATEST dueAt, not a stack whose oldest
    // would remove the graph on a clock the user's newest action already reset.
    const later = new Date(now.getTime() + 60_000);
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1', 'p2'],
      repoRefs: ['acme/api'],
      reason: 'connection_disconnected',
      now: later,
    });

    const rows = await allRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.dueAt).toEqual(new Date(later.getTime() + CODE_GRAPH_RETENTION_WINDOW_MS));
      expect(row.reason).toBe('connection_disconnected');
    }
  });

  it('omitting repoRefs enqueues ONE project-wide row per project', async () => {
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      reason: 'project_archived',
    });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repoRef).toBe(OFFBOARD_ALL_REPOS);
  });

  it('dedupes repeated projects and repos so the returned count is honest', async () => {
    // Callers legitimately produce repeats — two connections in one workspace can
    // carry the same `owner/name`. The upsert converges either way; the count
    // must not claim two removals are pending when one is.
    const written = await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1', 'p1'],
      repoRefs: ['acme/api', 'acme/api'],
      reason: 'repo_disconnected',
    });

    expect(written).toBe(1);
    expect(await allRows()).toHaveLength(1);
  });

  it('cancel removes only the named scope, and is a silent no-op when nothing is pending', async () => {
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      repoRefs: ['acme/api', 'acme/web'],
      reason: 'repo_disconnected',
    });

    expect(
      await codeGraphOffboardingService.cancel({
        coreWorkspaceId: 'ws1',
        coreProjectIds: ['p1'],
        repoRefs: ['acme/api'],
      }),
    ).toBe(1);
    expect((await allRows()).map((r) => r.repoRef)).toEqual(['acme/web']);

    // Cancelling nothing is the COMMON case — most re-indexes follow no
    // disconnect at all — so it must be zero, never a P2025.
    expect(
      await codeGraphOffboardingService.cancel({
        coreWorkspaceId: 'ws1',
        coreProjectIds: ['p1'],
        repoRefs: ['acme/api'],
      }),
    ).toBe(0);
  });

  it('cancelling a repo does NOT clear the project-wide row', async () => {
    // Re-connecting a repo is not un-archiving the project. Clearing the wider
    // row here would cancel a removal the user never reversed.
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      reason: 'project_archived',
    });
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      repoRefs: ['acme/api'],
      reason: 'repo_disconnected',
    });

    await codeGraphOffboardingService.cancel({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      repoRefs: ['acme/api'],
    });

    expect((await allRows()).map((r) => r.repoRef)).toEqual([OFFBOARD_ALL_REPOS]);
  });

  it('findDue returns only rows whose dueAt has passed, oldest first, bounded', async () => {
    const now = new Date('2026-08-05T00:00:00.000Z');
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      reason: 'workspace_deleted',
      now: new Date(now.getTime() - 2000),
    });
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p2'],
      reason: 'workspace_deleted',
      now: new Date(now.getTime() - 1000),
    });
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p3'],
      reason: 'project_archived',
      now, // due in 30 days — not yet
    });

    const due = await withSystemContext((tx) =>
      codeGraphOffboardingRepository.findDue(now, 10, tx),
    );
    expect(due.map((r) => r.coreProjectId)).toEqual(['p1', 'p2']);

    const bounded = await withSystemContext((tx) =>
      codeGraphOffboardingRepository.findDue(now, 1, tx),
    );
    expect(bounded.map((r) => r.coreProjectId)).toEqual(['p1']);
  });
});

// ── 3. ⚠️ THE ROW SURVIVES THE WORKSPACE CASCADE ─────────────────────────────

describe('the queue row OUTLIVES its workspace (§14.5)', () => {
  it('survives deleteWorkspace — the reason the table has no foreign key', async () => {
    // THE assertion of this card. Today's defect is that the only inventory of
    // what was retained (`CodeRepo`) is destroyed by the delete that makes it
    // garbage. A queue row FK'd to the workspace would reproduce that exact bug
    // one repo over — and would look completely normal in review, because every
    // other id column in this schema SHOULD be a relation.
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await makeProject(workspace.id, owner.id, 'Core');

    await workspacesService.deleteWorkspace({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    // The workspace and its projects really are gone…
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(await db.project.findUnique({ where: { id: project.id } })).toBeNull();

    // …and the row naming their code graph is still here, which is the ONLY
    // reason anything can ever remove that graph.
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      repoRef: OFFBOARD_ALL_REPOS,
      reason: 'workspace_deleted',
    });
  });

  it('has no foreign key on either tenant column', async () => {
    // The property above, asserted at the SCHEMA rather than only through a
    // scenario — so a migration that "tidies up" by adding the relation fails
    // here with a message naming the decision, instead of silently passing until
    // someone deletes a workspace in production.
    const fks = await db.$queryRawUnsafe<{ column_name: string }[]>(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'code_graph_offboarding'
        AND tc.constraint_type = 'FOREIGN KEY'
    `);
    expect(fks).toEqual([]);
  });
});

// ── 4. the four triggers ─────────────────────────────────────────────────────

describe('the four lifecycle triggers (§14.3)', () => {
  it('WORKSPACE DELETE enqueues immediately, for every project INCLUDING archived ones', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const live = await makeProject(workspace.id, owner.id, 'Core');
    const archived = await makeProject(workspace.id, owner.id, 'Legacy');
    await projectsService.archiveProject({
      projectId: archived.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const before = Date.now();
    await workspacesService.deleteWorkspace({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    const after = Date.now();

    const rows = await allRows();
    expect(rows.map((r) => r.coreProjectId).sort()).toEqual([live.id, archived.id].sort());
    for (const row of rows) {
      expect(row.reason).toBe('workspace_deleted');
      // IMMEDIATE — a timestamp assertion is a window, not an equality, so this
      // brackets the call rather than pinning a value.
      expect(row.dueAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.dueAt.getTime()).toBeLessThanOrEqual(after);
    }
    // The archived project's own WINDOWED row was superseded, not duplicated —
    // an archived project's graph still exists and a workspace delete must take
    // it now, which is exactly why the enumeration is unfiltered.
    expect(rows).toHaveLength(2);
  });

  it('PROJECT ARCHIVE enqueues a windowed, project-wide row', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await makeProject(workspace.id, owner.id, 'Core');

    const before = Date.now();
    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      // WHOLE PROJECT, not the workspace's connected repos: §14.1's finding is
      // that the inventory here can be gone while the artifacts remain, so
      // enumerating locally would skip exactly the orphans the decision is about.
      repoRef: OFFBOARD_ALL_REPOS,
      reason: 'project_archived',
    });
    expect(rows[0]!.dueAt.getTime()).toBeGreaterThanOrEqual(
      before + CODE_GRAPH_RETENTION_WINDOW_MS,
    );
  });

  it('a GITHUB reconcile that PRUNES a repo enqueues that repo across every project', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const p1 = await makeProject(workspace.id, owner.id, 'Core');
    const p2 = await makeProject(workspace.id, owner.id, 'Web');

    const installation = {
      installationId: 'inst-1',
      accountLogin: 'acme',
      accountType: 'Organization',
    };
    const repo = (name: string, id: string) => ({
      providerRepoId: id,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
    });

    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation,
      repos: [repo('api', 'r1'), repo('web', 'r2')],
    });
    expect(await allRows()).toEqual([]);

    // The user de-selects `acme/web` — the `deleteExcept` prune. A repo dropped
    // from the selection is a disconnect: nothing will index it again.
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation,
      repos: [repo('api', 'r1')],
    });

    const rows = await allRows();
    // ONE ROW PER PROJECT — a graph is per (project × repo) on motir-ai's side, so
    // one disconnected repo leaves one graph per project of the workspace behind.
    expect(rows.map((r) => [r.coreProjectId, r.repoRef]).sort()).toEqual(
      [
        [p1.id, 'acme/web'],
        [p2.id, 'acme/web'],
      ].sort(),
    );
    for (const row of rows) expect(row.reason).toBe('repo_disconnected');
  });

  it('re-SELECTING a pruned repo cancels its pending removal', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    await makeProject(workspace.id, owner.id, 'Core');
    const installation = {
      installationId: 'inst-1',
      accountLogin: 'acme',
      accountType: 'Organization',
    };
    const repo = (name: string, id: string) => ({
      providerRepoId: id,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
    });

    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation,
      repos: [repo('api', 'r1'), repo('web', 'r2')],
    });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation,
      repos: [repo('api', 'r1')],
    });
    expect(await allRows()).toHaveLength(1);

    // …and back. This is the grace period doing its job, and the difference
    // between a window and a delay.
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation,
      repos: [repo('api', 'r1'), repo('web', 'r2')],
    });

    expect(await allRows()).toEqual([]);
  });

  it('a GITLAB project disconnect enqueues that repo; the connection disconnect enqueues them all', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await makeProject(workspace.id, owner.id, 'Core');

    // The GitLab connection + two connected projects, written directly — the
    // OAuth exchange is not what this case is about.
    const conn = await withSystemContext((tx) =>
      tx.githubInstallation.create({
        data: {
          installationId: `gitlab-ws-${workspace.id}`,
          workspaceId: workspace.id,
          accountLogin: 'acme',
          accountType: 'User',
          provider: 'gitlab',
        },
      }),
    );
    for (const [repoId, name] of [
      ['g1', 'api'],
      ['g2', 'web'],
    ]) {
      await withSystemContext((tx) =>
        tx.githubRepo.create({
          data: {
            installationId: conn.id,
            workspaceId: workspace.id,
            repoId: repoId!,
            owner: 'acme',
            name: name!,
            defaultBranch: 'main',
            provider: 'gitlab',
          },
        }),
      );
    }

    await gitlabConnectionService.disconnectProject(
      { userId: owner.id, workspaceId: workspace.id },
      'g1',
    );

    expect((await allRows()).map((r) => r.repoRef)).toEqual(['acme/api']);

    await gitlabConnectionService.disconnect({ userId: owner.id, workspaceId: workspace.id });

    const rows = await allRows();
    expect(rows.map((r) => r.repoRef).sort()).toEqual(['acme/api', 'acme/web']);
    for (const row of rows) expect(row.coreProjectId).toBe(project.id);
    // The connection arm re-stamps the reason on the row the per-repo arm wrote —
    // the upsert converging, not a second row.
    expect(rows.find((r) => r.repoRef === 'acme/web')!.reason).toBe('connection_disconnected');
  });
});

// ── 5. post-commit and QUIET ─────────────────────────────────────────────────

describe('a failing enqueue never fails the user action (§14.5, `notes.html` #39)', () => {
  it('archiveProject still commits when the queue write throws', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const project = await makeProject(workspace.id, owner.id, 'Core');

    const boom = vi
      .spyOn(codeGraphOffboardingRepository, 'upsert')
      .mockRejectedValue(new Error('queue is down'));

    await expect(
      projectsService.archiveProject({
        projectId: project.id,
        workspaceId: workspace.id,
        actorUserId: owner.id,
      }),
    ).resolves.toBeUndefined();

    // The archive COMMITTED. Coupling a mutation's success to a side effect's
    // success is what turns a saved change into a reported failure.
    const row = await db.project.findUnique({ where: { id: project.id } });
    expect(row?.archivedAt).not.toBeNull();
    expect(await allRows()).toEqual([]);
    boom.mockRestore();
  });

  it('deleteWorkspace still commits when the queue write throws', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    await makeProject(workspace.id, owner.id, 'Core');

    const boom = vi
      .spyOn(codeGraphOffboardingRepository, 'upsert')
      .mockRejectedValue(new Error('queue is down'));

    await expect(
      workspacesService.deleteWorkspace({ workspaceId: workspace.id, actorUserId: owner.id }),
    ).resolves.toBeUndefined();

    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    boom.mockRestore();
  });

  it('a GitHub reconcile still returns its DTO when the queue write throws', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    await makeProject(workspace.id, owner.id, 'Core');
    const installation = {
      installationId: 'inst-1',
      accountLogin: 'acme',
      accountType: 'Organization',
    };
    const repo = (name: string, id: string) => ({
      providerRepoId: id,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
    });

    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation,
      repos: [repo('api', 'r1'), repo('web', 'r2')],
    });

    const boom = vi
      .spyOn(codeGraphOffboardingRepository, 'upsert')
      .mockRejectedValue(new Error('queue is down'));

    const dto = await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation,
      repos: [repo('api', 'r1')],
    });

    // The reconcile is what the webhook depends on; it must not 500 because a
    // retention queue was unavailable.
    expect(dto.repos.map((r) => r.name)).toEqual(['api']);
    boom.mockRestore();
  });
});

// ── 6. cancel-on-reconnect, at the service seam ──────────────────────────────

describe('cancelForRepos / enqueueForRepos resolve the workspace’s projects themselves', () => {
  it('fans out over every project, and cancels the same set', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    const p1 = await makeProject(workspace.id, owner.id, 'Core');
    const p2 = await makeProject(workspace.id, owner.id, 'Web');

    await codeGraphOffboardingService.enqueueForRepos(
      workspace.id,
      ['acme/api'],
      'repo_disconnected',
    );
    expect((await allRows()).map((r) => r.coreProjectId).sort()).toEqual([p1.id, p2.id].sort());

    await codeGraphOffboardingService.cancelForRepos(workspace.id, ['acme/api']);
    expect(await allRows()).toEqual([]);
  });

  it('is a no-op for a workspace with no projects, and for an empty repo list', async () => {
    const { workspace } = await makeWorkspace('owner@example.com', 'Acme');

    // Both guards, on BOTH entry points. A workspace with no projects is the
    // ordinary state right after signup, and an empty repo list is what a
    // reconcile that pruned nothing hands in — neither may reach the queue.
    expect(
      await codeGraphOffboardingService.enqueueForRepos(workspace.id, [], 'repo_disconnected'),
    ).toBe(0);
    expect(await codeGraphOffboardingService.cancelForRepos(workspace.id, [])).toBe(0);
    expect(
      await codeGraphOffboardingService.enqueueForRepos(
        workspace.id,
        ['acme/api'],
        'repo_disconnected',
      ),
    ).toBe(0);
    expect(await codeGraphOffboardingService.cancelForRepos(workspace.id, ['acme/api'])).toBe(0);
    expect(await allRows()).toEqual([]);
  });

  it('swallows a project-read failure — it sits outside enqueueQuietly’s own guard', async () => {
    const { owner, workspace } = await makeWorkspace('owner@example.com', 'Acme');
    await makeProject(workspace.id, owner.id, 'Core');

    const { projectRepository } = await import('@/lib/repositories/projectRepository');
    const boom = vi
      .spyOn(projectRepository, 'findAllIdsByWorkspace')
      .mockRejectedValue(new Error('read is down'));

    await expect(
      codeGraphOffboardingService.enqueueForRepos(workspace.id, ['acme/api'], 'repo_disconnected'),
    ).resolves.toBe(0);
    await expect(
      codeGraphOffboardingService.cancelForRepos(workspace.id, ['acme/api']),
    ).resolves.toBe(0);
    boom.mockRestore();
  });
});

// ── 7. the reads and the retire the SWEEP will use (MOTIR-2168) ──────────────

describe('the sweep-facing surface', () => {
  it('listPending returns a project’s rows, oldest-due first', async () => {
    const now = new Date('2026-08-05T00:00:00.000Z');
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      repoRefs: ['acme/web'],
      reason: 'project_archived',
      now: new Date(now.getTime() + 1000),
    });
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      repoRefs: ['acme/api'],
      reason: 'repo_disconnected',
      now,
    });
    // Another project's row must not leak into the read.
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p2'],
      reason: 'project_archived',
      now,
    });

    const pending = await codeGraphOffboardingService.listPending('ws1', 'p1');
    expect(pending.map((r) => r.repoRef)).toEqual(['acme/api', 'acme/web']);
  });

  it('deleteById retires exactly one row, and is zero on a second call', async () => {
    // How the sweep retires a removal motir-ai confirmed. Idempotent for the same
    // reason everything else here is: the queue IS the retry (§14.5), so a tick
    // that dies after motir-ai succeeded must converge on the next one, not throw.
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1', 'p2'],
      reason: 'workspace_deleted',
    });
    const [first] = await allRows();

    expect(
      await withSystemContext((tx) => codeGraphOffboardingRepository.deleteById(first!.id, tx)),
    ).toBe(1);
    expect(
      await withSystemContext((tx) => codeGraphOffboardingRepository.deleteById(first!.id, tx)),
    ).toBe(0);
    expect(await allRows()).toHaveLength(1);
  });

  it('findByProject reads through the db singleton when handed no tx', async () => {
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      reason: 'project_archived',
    });
    // The `tx ?? db` arm — a read-only caller outside a transaction. (Under the
    // dev/CI BYPASSRLS role this reaches the row; in production this repository's
    // callers are all inside `withSystemContext`, which is what the policy admits.)
    const rows = await codeGraphOffboardingRepository.findByProject('ws1', 'p1');
    expect(rows).toHaveLength(1);
  });

  it('cancelQuietly swallows a repository failure rather than failing its caller', async () => {
    // The mirror of the enqueue guard: a cancel fires from the CONNECT and INDEX
    // paths, both of which have already succeeded by the time it runs.
    const boom = vi
      .spyOn(codeGraphOffboardingRepository, 'deleteByScope')
      .mockRejectedValue(new Error('queue is down'));

    await expect(
      codeGraphOffboardingService.cancelQuietly({
        coreWorkspaceId: 'ws1',
        coreProjectIds: ['p1'],
        repoRefs: ['acme/api'],
      }),
    ).resolves.toBe(0);

    // …and the throwing form still throws, so a synchronous caller can see it.
    await expect(
      codeGraphOffboardingService.cancel({
        coreWorkspaceId: 'ws1',
        coreProjectIds: ['p1'],
        repoRefs: ['acme/api'],
      }),
    ).rejects.toThrow('queue is down');
    boom.mockRestore();
  });

  it('enqueue and cancel are no-ops for an empty project set', async () => {
    expect(
      await codeGraphOffboardingService.enqueue({
        coreWorkspaceId: 'ws1',
        coreProjectIds: [],
        reason: 'workspace_deleted',
      }),
    ).toBe(0);
    expect(
      await codeGraphOffboardingService.cancel({ coreWorkspaceId: 'ws1', coreProjectIds: [] }),
    ).toBe(0);
    expect(await allRows()).toEqual([]);
  });
});
