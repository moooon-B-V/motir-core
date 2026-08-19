import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { presentMcpWorkItem } from '@/lib/mcp/payloads/workItems';
import { presentWorkItemDetail } from '@/lib/api/v1/workItems/schema';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';
import { firstRepoStraddleCriterion } from '@/lib/workItems/proseVsGraph';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The repository REFERENCE through every READ seam (Story MOTIR-2732 ·
// MOTIR-3041, ADR `docs/decisions/work-item-repository-set.md` "Amendment
// 2026-08-18" §A4 / §A4.2), over real Postgres.
//
// Five readers ask a work item where it ships, and each used to receive a string
// and do its own thing with it. What this file pins:
//
//   1. Each seam returns the RESOLVED repository — DTO, `/api/v1`, MCP payload,
//      the activity renderer, the advisory.
//   2. All three published surfaces agree for ONE card, asserted in ONE test —
//      three tests that could drift is the state a key drifts in.
//   3. A RENAME changes what every seam DISPLAYS and nothing about what the card
//      REFERENCES — the property the whole model change exists for — and stops at
//      the History on purpose (§A4.2).

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

let nextPosition = 0;

async function addRepoRow(
  fx: WorkItemFixture,
  name: string,
  opts: {
    realizedName?: string;
    role?: 'web' | 'api';
    label?: string | null;
    proposed?: boolean;
  } = {},
): Promise<{ id: string; githubRepoId: string | null }> {
  let githubRepoId: string | null = null;
  if (!opts.proposed) {
    const inst = await adminDb.githubInstallation.upsert({
      where: { installationId: `inst-${fx.workspaceId}` },
      create: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
      update: {},
    });
    const gh = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        repoId: `repo-${randomToken(8)}`,
        owner: 'moooon',
        name: opts.realizedName ?? name,
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    githubRepoId = gh.id;
  }
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: opts.role ?? 'web',
      label: opts.label ?? null,
      name,
      seedSource: 'blank',
      state: opts.proposed ? 'proposed' : 'connected',
      position: `a${(nextPosition++).toString(36).padStart(4, '0')}`,
      ...(githubRepoId ? { githubRepoId } : {}),
    },
  });
  return { id: row.id, githubRepoId };
}

describe('the DTO seam', () => {
  it('resolves each repository to its ROW — reference, name, role, label, state, primary', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core', { role: 'web', label: 'storefront' });
    const planned = await addRepoRow(fx, 'acme-api', { role: 'api', proposed: true });

    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Two repositories',
        assigneeId: null,
        targetRepositories: [core.id, planned.id],
      },
      fx.ctx,
    );

    const resolved = await workItemsService.listRepositories(item.id, fx.ctx);
    expect(resolved).toEqual([
      {
        ref: core.id,
        name: 'motir-core',
        role: 'web',
        label: 'storefront',
        state: 'connected',
        primary: true,
      },
      {
        ref: planned.id,
        name: 'acme-api',
        role: 'api',
        label: null,
        state: 'proposed',
        primary: false,
      },
    ]);
  });

  it('prefers the REALIZED repository’s own name over the row’s authored intent', async () => {
    const fx = await makeWorkItemFixture();
    const row = await addRepoRow(fx, 'acme-web', { realizedName: 'acme-storefront' });
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Renamed on the host',
        assigneeId: null,
        targetRepositories: [row.id],
      },
      fx.ctx,
    );
    expect((await workItemsService.listRepositories(item.id, fx.ctx))[0]!.name).toBe(
      'acme-storefront',
    );
  });

  it('is ABSENT, not empty, on a read that did not load it', async () => {
    // The reserved-hole convention. "This card has no repositories" and "this read
    // did not ask" are different answers, and an empty array collapses them.
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Pinned',
        assigneeId: null,
        targetRepositories: [core.id],
      },
      fx.ctx,
    );
    // `createWorkItem` returns the bare mapping — no join was asked for.
    expect(item.targetRepositories).toBeUndefined();
    // …while the field itself is non-empty, which is the point.
    expect(await workItemsService.listRepositories(item.id, fx.ctx)).toHaveLength(1);
  });
});

describe('ALL THREE published surfaces agree — one card, one test', () => {
  it('the detail DTO, /api/v1 and the MCP payload carry the same repositories', async () => {
    // Asserted together rather than in three places: two surfaces agreeing is
    // exactly the state in which the third has drifted.
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core', { role: 'web' });
    const ai = await addRepoRow(fx, 'motir-ai', { role: 'api' });
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Ships in both',
        assigneeId: null,
        targetRepositories: [core.id, ai.id],
      },
      fx.ctx,
    );

    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);
    const v1 = presentWorkItemDetail(detail, 0, {}) as {
      targetRepositories: { ref: string; name: string }[];
      targetRepos: string[];
      targetRepo: string | null;
    };
    const mcp = presentMcpWorkItem(detail.item) as {
      targetRepositories?: { ref: string; name: string }[];
    };

    const expected = [
      { ref: core.id, name: 'motir-core' },
      { ref: ai.id, name: 'motir-ai' },
    ];
    const strip = (rs: { ref: string; name: string }[] | undefined) =>
      (rs ?? []).map((r) => ({ ref: r.ref, name: r.name }));

    expect(strip(detail.item.targetRepositories)).toEqual(expected);
    expect(strip(v1.targetRepositories)).toEqual(expected);
    expect(strip(mcp.targetRepositories)).toEqual(expected);

    // ADDITIVE: the two NAME fields keep their shape and meaning beside it.
    expect(v1.targetRepos).toEqual(['motir-core', 'motir-ai']);
    expect(v1.targetRepo).toBe('motir-core');
  });

  it('moves V1_CONTRACT_VERSION for the addition', () => {
    // Amendment 8 makes the bump obligatory for an additive change, because the
    // number rides a response header rather than a document nobody fetches.
    //
    // ⚠️ AT LEAST 1.11.0, not EXACTLY it (MOTIR-3131). This card's addition took
    // 1.11.0; pinning that string made the NEXT additive change under §8 — every
    // one of which is REQUIRED to move this number — red-light itself on a guard
    // belonging to a card it does not touch. MOTIR-2903 fixed the same assertion
    // one file over (`repositorySetReadSeams.test.ts`) and this copy was missed.
    // What the guard is for is that the version moved PAST the last release that
    // predates `targetRepositories`, and a monotonic floor says exactly that
    // while surviving its own success.
    const [major, minor] = V1_CONTRACT_VERSION.split('.').map(Number);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(11);
  });
});

describe('a RENAME — the property the model change exists for', () => {
  it('changes what every live seam DISPLAYS and nothing about what the card REFERENCES', async () => {
    const fx = await makeWorkItemFixture();
    const row = await addRepoRow(fx, 'acme-web');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Followed a rename',
        assigneeId: null,
        targetRepositories: [row.id],
      },
      fx.ctx,
    );
    const before = await workItemsService.listRepositories(item.id, fx.ctx);
    expect(before[0]).toMatchObject({ ref: row.id, name: 'acme-web' });

    // Rename ON THE HOST — the case a stored name cannot survive.
    await adminDb.githubRepo.update({
      where: { id: row.githubRepoId! },
      data: { name: 'acme-storefront' },
    });

    const after = await workItemsService.listRepositories(item.id, fx.ctx);
    // The DISPLAY moved…
    expect(after[0]!.name).toBe('acme-storefront');
    // …and the REFERENCE did not. Same row, same identity, nothing re-pinned.
    expect(after[0]!.ref).toBe(row.id);
    expect(await adminDb.workItemRepo.count({ where: { workItemId: item.id } })).toBe(1);
  });
});

describe('the ACTIVITY seam — §A4.2, and it deliberately does NOT follow a rename', () => {
  it('records a repository change as NAMES, so an old entry renders what was true THEN', async () => {
    // The decision, asserted on the stored diff rather than on the registry: a
    // cuid tells a reader nothing, and rendering a reference's CURRENT name would
    // make an old entry assert something that was not true when it was written.
    // So the rename property stops at the History on purpose.
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Moved repository',
        assigneeId: null,
        targetRepositories: [core.id],
      },
      fx.ctx,
    );

    await workItemsService.updateWorkItem(item.id, { targetRepositories: [ai.id] }, fx.ctx);

    const revision = await adminDb.workItemRevision.findFirst({
      where: { workItemId: item.id, changeKind: 'updated' },
      orderBy: { changedAt: 'desc' },
    });
    const diff = revision?.diff as Record<string, { from: unknown; to: unknown }> | null;
    // NAMES on both sides — never the row ids.
    expect(diff?.targetRepos).toEqual({ from: ['motir-core'], to: ['motir-ai'] });
    expect(diff?.targetRepo).toEqual({ from: 'motir-core', to: 'motir-ai' });
    expect(JSON.stringify(diff)).not.toContain(core.id);
    expect(JSON.stringify(diff)).not.toContain(ai.id);
  });
});

describe('the ADVISORY seam — a name on both sides, by necessity', () => {
  it('still compares NAMES, because the other side is a path written in prose', () => {
    // The comparison does not change shape; only where the card's side comes
    // from. A card carrying `motir-core` and a criterion naming a path in
    // `motir-ai` is the straddle it exists to report.
    const candidates = [
      { name: 'motir-core', repoRef: 'moooon/motir-core' },
      { name: 'motir-ai', repoRef: 'moooon/motir-ai' },
    ];
    const found = firstRepoStraddleCriterion(
      '## Acceptance criteria\n\n1. `motir-ai/src/llm/planningRulePacks.ts` gains the rule.\n',
      ['motir-core'],
      candidates,
    );
    expect(found).toMatchObject({ repo: 'motir-ai', reason: 'contradiction' });

    // …and a card that carries the repository its criterion names is not a
    // straddle — the verdicts do not move (this card's boundary).
    expect(
      firstRepoStraddleCriterion(
        '## Acceptance criteria\n\n1. `motir-ai/src/llm/planningRulePacks.ts` gains the rule.\n',
        ['motir-ai'],
        candidates,
      ),
    ).toBeNull();
  });
});
