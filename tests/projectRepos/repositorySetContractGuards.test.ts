import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { enqueueReposMissingFirstIndex } from '@/lib/github/indexEnqueue';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// ─────────────────────────────────────────────────────────────────────────────
// The Story-level ARCHITECTURE / CONTRACT guards for the repository set (Story
// MOTIR-1775 · MOTIR-1784) — the things a coverage percentage cannot see.
//
// Every assertion here fails on a change that leaves the whole suite otherwise
// green, which is the only reason to write it:
//
//   1. `project_repository` is tenant data, so `workspace_id` and its RLS
//      policies must ship in the SAME migration — asserted against the migration
//      SQL, not against prose. A later migration adding the policy would leave a
//      window in which the table is deployed unguarded, and no runtime test can
//      see that window because by then the policy exists.
//   2. The webhook → reconcile → index chain got NO new code. The repo-creation
//      path reaches the index through the shipped chokepoint with the shipped
//      payload, proved by driving BOTH producers and comparing what they emit.
//   3. `resolveCodeContext` and `codeGraphIndexService` are UNCHANGED — this
//      Story deliberately left AI grounding workspace-scoped (MOTIR-1754 owns
//      that adoption). Pinning their current behaviour is what stops a
//      well-meant "while I'm here, this should be project-scoped too" edit from
//      silently moving what a planning job sees. (MOTIR-1974 re-pointed the
//      index assertion at `resolveIndexTarget`, the method that now owns the
//      fan-out after the job was split into per-project steps — the SCOPE it
//      guards is unchanged, which is the point of re-pointing it rather than
//      dropping it.)
//   4. The row's two FKs behave as modelled: a deleted project takes its rows
//      with it, while a deleted `GithubRepo` leaves a READABLE row with no claim
//      rather than a dangling reference or a vanished plan.
//
// The assembled behavioural seams live in
// `tests/integration/projectRepos/repositorySetStoryGate.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

/** Every migration's SQL, newest-name-last (the directory names sort by stamp). */
function migrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }));
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

// ── 1 · the table and its RLS ship together ─────────────────────────────────

describe('project_repository — workspace_id and RLS in ONE migration', () => {
  it('creates the table, its workspace_id and its policies in the SAME file — no unguarded window', () => {
    const creating = migrations().filter((m) => /CREATE TABLE\s+"project_repository"/i.test(m.sql));
    expect(creating).toHaveLength(1);
    const { sql } = creating[0]!;

    // The tenant column is NOT NULL — a nullable one would make "whose row is
    // this?" unanswerable for exactly the rows RLS has to judge.
    expect(sql).toMatch(/"workspace_id"\s+TEXT\s+NOT NULL/i);

    // RLS is ENABLED and FORCED (forced, so the table owner is not exempt) and
    // the policy gates on the row's OWN workspace_id against the request GUC.
    expect(sql).toMatch(/ALTER TABLE\s+"project_repository"\s+ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/ALTER TABLE\s+"project_repository"\s+FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY[\s\S]*ON\s+"project_repository"/i);
    expect(sql).toMatch(/USING\s*\(\s*"workspace_id"\s*=\s*current_setting\('app\.workspace_id'/i);
    // WITH CHECK too — without it a tenant could MOVE its own row to another
    // workspace, which reads as a write it is allowed to make.
    expect(sql).toMatch(
      /WITH CHECK\s*\(\s*"workspace_id"\s*=\s*current_setting\('app\.workspace_id'/i,
    );
  });

  it('adds no LATER migration that first enables RLS on the table', () => {
    // The failure this catches is the one the rule exists for: a follow-up
    // migration "fixing up" the policy means the table shipped unguarded.
    const enabling = migrations().filter((m) =>
      /ALTER TABLE\s+"project_repository"\s+ENABLE ROW LEVEL SECURITY/i.test(m.sql),
    );
    expect(enabling.map((m) => m.name)).toHaveLength(1);
  });
});

// ── 2 · the webhook → reconcile → index chain is untouched ──────────────────

describe('the index chain got no new code', () => {
  it('the repo-set creation path emits the SAME job payload as the shipped reconcile path', async () => {
    // Both producers are driven for real and their payloads compared key-for-key.
    // A repo-set-specific field bolted onto the job — or a key renamed on one
    // side — fails here, which no per-subtask suite can see because each knows
    // only its own producer.
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    await enqueueReposMissingFirstIndex({
      installationId: '556677',
      workspaceId: 'ws-1',
      repos: [
        {
          providerRepoId: 'r1',
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
        } as never,
      ],
      indexedRepoRefs: [],
    });

    expect(send).toHaveBeenCalledTimes(1);
    const shipped = send.mock.calls[0]![0] as { name: string; data: Record<string, unknown> };
    expect(shipped.name).toBe('system.code-graph-index');
    // The exact contract the establish run must also satisfy — asserted in the
    // story-gate suite, which drives a real establish and reads these same keys.
    expect(Object.keys(shipped.data).sort()).toEqual([
      'defaultBranch',
      'installationId',
      'repoName',
      'repoOwner',
      'workspaceId',
    ]);
  });

  it('the enqueue chokepoint knows nothing about the repository set', () => {
    // Structural, and deliberately narrow: the chokepoint is shared by the
    // webhook reconcile, the fresh-install bind AND the creation primitive, so
    // a repo-set import here would be the first branch in a path that must stay
    // one path for all three.
    const source = readFileSync(join(process.cwd(), 'lib', 'github', 'indexEnqueue.ts'), 'utf8');
    expect(source).not.toMatch(/projectRepo/i);
    expect(source).not.toMatch(/project_repository/i);
  });
});

// ── 3 · AI grounding stayed workspace-scoped ────────────────────────────────

describe('resolveCodeContext and codeGraphIndexService are unchanged', () => {
  /** Connect a repo to the workspace's OWN installation — the 7.10.3 mirror the
   *  code-context resolver reads. */
  async function connectRepo(workspaceId: string, name: string): Promise<string> {
    const installationId = `inst-${workspaceId}`;
    const inst = await db.githubInstallation.upsert({
      where: { installationId },
      create: {
        installationId,
        workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
      update: {},
    });
    const repo = await db.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId,
        repoId: `${name}-id`,
        owner: 'moooon',
        name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    return repo.id;
  }

  it('still answers with the WORKSPACE’s repos, not the project’s narrower set', async () => {
    // The set exists and names ONE repo; the workspace connects TWO. A planning
    // job must still see both — re-pointing this resolver would change shipped AI
    // grounding in a Story that never scoped it (MOTIR-1754 owns that).
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'acme-web');
    await connectRepo(fx.workspaceId, 'acme-api');
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);

    const context = await resolveCodeContext({ userId: fx.ownerId, workspaceId: fx.workspaceId });

    expect(context!.repos.map((r) => r.repoRef).sort()).toEqual([
      'moooon/acme-api',
      'moooon/acme-web',
    ]);
  });

  it('is unaffected by a SIBLING project’s set — it never reads the set at all', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'acme-web');
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Sibling',
      identifier: 'SIB',
    });
    const siblingFx: WorkItemFixture = { ...fx, project: sibling, projectId: sibling.id };
    await projectRepoSetService.addRow(
      siblingFx.projectId,
      { role: 'api', name: 'sibling-api' },
      siblingFx.ctx,
    );

    const context = await resolveCodeContext({ userId: fx.ownerId, workspaceId: fx.workspaceId });

    expect(context!.repos.map((r) => r.repoRef)).toEqual(['moooon/acme-web']);
  });

  it('still resolves to undefined for a workspace with no installation', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);

    // A repo SET is not a code context. If this ever returns the set's rows, the
    // resolver was re-pointed and a start-fresh project's job envelope changed.
    await expect(
      resolveCodeContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }),
    ).resolves.toBeUndefined();
  });

  it('the index job is keyed by WORKSPACE — its input carries no project', async () => {
    const { codeGraphIndexService } = await import('@/lib/services/codeGraphIndexService');
    // MOTIR-1974 split the job's single method into `resolveIndexTarget` (reads)
    // + `indexRepoIntoProject` (one project's network work) so each can be its own
    // durable step. `resolveIndexTarget` is where the guarded property now lives:
    // it takes the SAME workspace-keyed input (no project) and it is what decides
    // the fan-out. The split is a checkpointing change, NOT a narrowing one — the
    // projectIds it returns are still every project of the workspace, and it still
    // never reads `project_repository`. (`indexRepoIntoProject` does take a
    // projectId, but only one this resolver handed out.)
    //
    // Driving it with an installation that does not exist is the cheapest way to
    // prove the shape it accepts without a tarball fetch: the no-op it returns is
    // itself part of the contract (the job never throws on a vanished tenant).
    await expect(
      codeGraphIndexService.resolveIndexTarget({
        installationId: 'nope',
        workspaceId: 'nope',
        repoOwner: 'moooon',
        repoName: 'motir-core',
        defaultBranch: 'main',
      }),
    ).resolves.toEqual({ indexed: false, reason: 'installation_missing' });
  });
});

// ── 4 · the row's two foreign keys ──────────────────────────────────────────

describe('what a delete does to a repository row', () => {
  async function realizedRow(fx: WorkItemFixture): Promise<{ rowId: string; repoId: string }> {
    const inst = await db.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await db.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        repoId: 'acme-web-id',
        owner: 'moooon',
        name: 'acme-web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    // Through `creating`, so the row settles as `created` — a repository Motir
    // MADE, which is the case where losing the mirror row matters most.
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    return { rowId: row.id, repoId: repo.id };
  }

  it('a deleted GithubRepo leaves a READABLE row with no claim — not a dangling FK', async () => {
    // SetNull, not Cascade: disconnecting a repository is not losing the plan.
    // The role, name and seed source survive so the row can be re-established,
    // and `established` goes false while `state` keeps saying what happened.
    const fx = await makeWorkItemFixture();
    const { rowId, repoId } = await realizedRow(fx);

    await db.githubRepo.delete({ where: { id: repoId } });

    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    const row = rows.find((r) => r.id === rowId)!;
    expect(row).toMatchObject({
      name: 'acme-web',
      role: 'web',
      state: 'created',
      established: false,
      realizedRepo: null,
    });
    // …and the claim is released, so the row can realize against a new repo.
    const raw = await db.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
    expect(raw.githubRepoId).toBeNull();
  });

  it('a deleted PROJECT takes its rows with it, leaving the repository alone', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, repoId } = await realizedRow(fx);

    await db.project.delete({ where: { id: fx.projectId } });

    expect(await db.projectRepo.findUnique({ where: { id: rowId } })).toBeNull();
    // The repository is a real artifact on GitHub — deleting a Motir project
    // must not pretend it went away.
    expect(await db.githubRepo.findUnique({ where: { id: repoId } })).not.toBeNull();
  });
});
