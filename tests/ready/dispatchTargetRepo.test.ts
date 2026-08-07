import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { UnknownTargetRepoError } from '@/lib/workItems/errors';
import { listConnectedRepoNames } from '@/lib/workItems/targetRepo';
import { resolveAuthoredTargetRepoInProject } from '@/lib/workItems/dispatchRepo';
import { runNextReady } from '@/lib/mcp/tools/nextReady';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// Per-item REPO ATTRIBUTION over real Postgres (Story 7.9 · MOTIR-1804) — the
// rebuilt producer half of the cancelled 7.7.3 contract that the CLI's repo
// routing (MOTIR-881) consumes.
//
// Four things are pinned here, because each is a place the feature could quietly
// be wrong:
//   1. The pin ROUND-TRIPS (create → read → update → clear) through the column.
//   2. An unknown repo is REJECTED with the typed error — on create AND update,
//      so the patch surface can never be looser than the create one.
//   3. Dispatch RESOLVES: one connected repo → items resolve to it; two or more
//      with no pin → null (never a guess); an explicit pin always wins.
//   4. All three dispatch surfaces carry it — `next_ready`, `claim_next_ready`,
//      and `POST /api/ready/next` — since the CLI reads whichever it is given.
//
// The route half stubs ONLY `getWorkspaceContext` (the session resolver the test
// env can't supply), partially, so the real RLS-binding `withWorkspaceContext`
// the connected-repo read depends on stays untouched — the same exception
// `ready-routes.test.ts` takes.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { POST: nextPOST } = await import('@/app/api/ready/next/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect one repo to the fixture's workspace (the 7.10.3 installation mirror —
 *  the single repo registry a `targetRepo` validates against). */
async function connectRepo(
  fx: WorkItemFixture,
  name: string,
  opts: { owner?: string; provider?: string } = {},
): Promise<void> {
  const rand = randomToken(8);
  const owner = opts.owner ?? 'moooon';
  const provider = opts.provider ?? 'github';
  const inst = await db.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${provider}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${provider}`,
      workspaceId: fx.workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
      provider,
    },
    update: {},
  });
  await db.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-${rand}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider,
    },
  });
}

/** A ready (todo, unblocked) leaf. */
async function makeReady(fx: WorkItemFixture, title: string, targetRepo?: string | null) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      assigneeId: null,
      descriptionMd: null,
      ...(targetRepo !== undefined ? { targetRepo } : {}),
    },
    fx.ctx,
  );
}

async function dispatchRepoOf(fx: WorkItemFixture): Promise<string | null> {
  const dispatch = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
  return dispatch?.targetRepo ?? null;
}

describe('githubRepoRepository.listByWorkspace — the connected repo SET', () => {
  it("lists every repo across the workspace's installations, provider-agnostic", async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    // A GitLab-connected project lives in the SAME table under provider gitlab.
    // It is checked out exactly like a GitHub one, so it belongs to the domain.
    await connectRepo(fx, 'motir-gateway', { provider: 'gitlab' });

    const repos = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
      (tx) => githubRepoRepository.listByWorkspace(fx.workspaceId, tx),
    );
    expect(repos.map((r) => r.name).sort()).toEqual(['motir-core', 'motir-gateway']);
  });

  it('is empty for a workspace with no connection at all', async () => {
    const fx = await makeWorkItemFixture();
    const repos = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
      (tx) => githubRepoRepository.listByWorkspace(fx.workspaceId, tx),
    );
    expect(repos).toEqual([]);
  });

  it("never leaks ANOTHER workspace's connected repos", async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'MINE' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THRS' });
    await connectRepo(theirs, 'secret-repo');

    expect(await listConnectedRepoNames(mine.ctx)).toEqual([]);
  });
});

describe('listConnectedRepoNames', () => {
  it('de-duplicates by NAME — two owners exposing the same name are one checkout identity', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'widgets', { owner: 'acme' });
    await connectRepo(fx, 'widgets', { owner: 'zeta' });

    const names = await listConnectedRepoNames(fx.ctx);
    // The CLI resolves BOTH to `<root>/widgets`, so dispatch cannot tell them
    // apart — carrying one entry is the honest model of that. The coordinates
    // (MOTIR-1783) come from the winning row, so the URL an agent clones and the
    // name it checks out into always describe the same repository.
    expect(names).toEqual([
      {
        name: 'widgets',
        repoRef: 'acme/widgets',
        cloneUrl: 'https://github.com/acme/widgets.git',
        defaultBranch: 'main',
        archived: false,
      },
    ]);
  });
});

describe('authored-pin validation falls back to the CONNECTED set for a project with no repo set', () => {
  it('accepts a connected repo by bare name and by `owner/name`', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core', { owner: 'moooon' });

    expect(await resolveAuthoredTargetRepoInProject('motir-core', fx.projectId, fx.ctx)).toBe(
      'motir-core',
    );
    expect(
      await resolveAuthoredTargetRepoInProject('moooon/motir-core', fx.projectId, fx.ctx),
    ).toBe('motir-core');
  });

  it("matches case-insensitively but STORES the connected repo's own casing", async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'Motir-Core');
    // Git-host names are case-insensitive; storing the canonical casing is what
    // keeps the column and `.motir.json`'s directory name from disagreeing.
    expect(await resolveAuthoredTargetRepoInProject('motir-core', fx.projectId, fx.ctx)).toBe(
      'Motir-Core',
    );
  });

  it('normalizes a blank / null value to "unpinned" WITHOUT touching the connected set', async () => {
    const fx = await makeWorkItemFixture(); // no repos connected at all
    expect(await resolveAuthoredTargetRepoInProject(null, fx.projectId, fx.ctx)).toBeNull();
    expect(await resolveAuthoredTargetRepoInProject('   ', fx.projectId, fx.ctx)).toBeNull();
  });

  it('rejects an unknown repo with a typed error naming the connected set', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');

    await expect(
      resolveAuthoredTargetRepoInProject('motir-ai', fx.projectId, fx.ctx),
    ).rejects.toBeInstanceOf(UnknownTargetRepoError);
    await expect(
      resolveAuthoredTargetRepoInProject('motir-ai', fx.projectId, fx.ctx),
    ).rejects.toThrow(/Connected repositories: moooon\/motir-core/);
  });

  it('rejects ANY pin when the workspace has no connected repositories, and says so', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      resolveAuthoredTargetRepoInProject('motir-core', fx.projectId, fx.ctx),
    ).rejects.toThrow(/no connected repositories/);
  });
});

describe('targetRepo round-trips through create → read → update', () => {
  it('creates pinned, reads back the pin, re-pins, and clears it', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');

    const created = await makeReady(fx, 'pinned', 'motir-core');
    expect(created.targetRepo).toBe('motir-core');

    const read = await workItemsService.getWorkItem(created.id, fx.ctx);
    expect(read.targetRepo).toBe('motir-core');

    const repinned = await workItemsService.updateWorkItem(
      created.id,
      { targetRepo: 'moooon/motir-ai' },
      fx.ctx,
    );
    expect(repinned.targetRepo).toBe('motir-ai');

    const cleared = await workItemsService.updateWorkItem(created.id, { targetRepo: null }, fx.ctx);
    expect(cleared.targetRepo).toBeNull();
    expect((await db.workItem.findUniqueOrThrow({ where: { id: created.id } })).targetRepo).toBe(
      null,
    );
  });

  it('is null on a create that never mentions it (no write-time defaulting)', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core'); // even with ONE connected repo…

    const created = await makeReady(fx, 'unpinned');
    // …the COLUMN stays null: it records a decision, not a guess. The default
    // is applied at dispatch, where it always reflects the current repo set.
    expect(created.targetRepo).toBeNull();
  });

  it('records the change in the revision diff (History), and a no-op re-save writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const item = await makeReady(fx, 'audit me');

    await workItemsService.updateWorkItem(item.id, { targetRepo: 'motir-core' }, fx.ctx);
    const afterChange = await db.workItemRevision.findMany({
      where: { workItemId: item.id, changeKind: 'updated' },
    });
    expect(afterChange).toHaveLength(1);
    expect(afterChange[0]!.diff).toMatchObject({
      targetRepo: { from: null, to: 'motir-core' },
    });

    // Same value again → the diff is empty, so no second revision.
    await workItemsService.updateWorkItem(item.id, { targetRepo: 'motir-core' }, fx.ctx);
    expect(
      await db.workItemRevision.count({ where: { workItemId: item.id, changeKind: 'updated' } }),
    ).toBe(1);
  });

  it('rejects an unknown repo on BOTH create and update — the patch surface is never looser', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');

    await expect(makeReady(fx, 'bad pin', 'not-connected')).rejects.toBeInstanceOf(
      UnknownTargetRepoError,
    );
    // …and the rejected create never burned a work-item key or left a row.
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);

    const item = await makeReady(fx, 'good');
    await expect(
      workItemsService.updateWorkItem(item.id, { targetRepo: 'not-connected' }, fx.ctx),
    ).rejects.toBeInstanceOf(UnknownTargetRepoError);
    expect((await db.workItem.findUniqueOrThrow({ where: { id: item.id } })).targetRepo).toBeNull();
  });
});

describe('the DISPATCH payload resolves targetRepo', () => {
  it('ONE connected repo and no pin → items resolve to it', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await makeReady(fx, 'unpinned');

    expect(await dispatchRepoOf(fx)).toBe('motir-core');
  });

  it('TWO connected repos and no pin → null (never a guess)', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    await makeReady(fx, 'unpinned');

    expect(await dispatchRepoOf(fx)).toBeNull();
  });

  it('NO connected repos and no pin → null', async () => {
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'unpinned');

    expect(await dispatchRepoOf(fx)).toBeNull();
  });

  it('an explicit pin WINS over the ambiguous set — the repo-routing case', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    await makeReady(fx, 'targets repo B', 'motir-ai');

    expect(await dispatchRepoOf(fx)).toBe('motir-ai');
  });
});

describe('every dispatch surface carries targetRepo', () => {
  it('`next_ready` (MCP)', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const item = await makeReady(fx, 'dispatch me', 'motir-ai');

    const res = await runNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as { item: { key: string; targetRepo: string | null } | null };
    expect(sc.item?.key).toBe(item.identifier);
    expect(sc.item?.targetRepo).toBe('motir-ai');
  });

  it('`claim_next_ready` (MCP)', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const item = await makeReady(fx, 'claim me');

    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as { item: { key: string; targetRepo: string | null } | null };
    expect(sc.item?.key).toBe(item.identifier);
    // Unpinned + exactly one connected repo → the unambiguous default.
    expect(sc.item?.targetRepo).toBe('motir-core');
  });

  it('`POST /api/ready/next` (the BYOK HTTP contract)', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const item = await makeReady(fx, 'over http', 'motir-core');
    ctxRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };

    const res = await nextPOST(
      new Request(`${BASE}/api/ready/next`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey: fx.projectIdentifier }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; targetRepo: string | null };
    expect(body.key).toBe(item.identifier);
    expect(body.targetRepo).toBe('motir-core');
  });
});

describe('the MCP authoring tools set targetRepo', () => {
  it('`create_work_item` pins it; an unknown repo is a clean tool error, not a throw', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');

    const ok = await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        kind: 'subtask',
        title: 'pinned via MCP',
        parentKey: (
          await runCreateWorkItem(
            { projectKey: fx.projectIdentifier, kind: 'story', title: 'parent' },
            fx.ctx,
          ).then((r) => r.structuredContent as { identifier: string })
        ).identifier,
        targetRepo: 'moooon/motir-core',
      },
      fx.ctx,
    );
    expect((ok.structuredContent as { targetRepo: string | null }).targetRepo).toBe('motir-core');

    const bad = await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        kind: 'task',
        title: 'bad pin',
        targetRepo: 'nope',
      },
      fx.ctx,
    );
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain('UNKNOWN_TARGET_REPO');
  });

  it('`update_work_item` patches it, and reports the unknown-repo error with the connected set', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const item = await makeReady(fx, 'patch me');

    const ok = await runUpdateWorkItem({ key: item.identifier, targetRepo: 'motir-core' }, fx.ctx);
    expect((ok.structuredContent as { targetRepo: string | null }).targetRepo).toBe('motir-core');

    const bad = await runUpdateWorkItem({ key: item.identifier, targetRepo: 'nope' }, fx.ctx);
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain('moooon/motir-core');
  });
});
