import type { GithubRepo } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { derivePrMergeModeDefault, isEstablishedSet } from '@/lib/projects/prMergeModeDefault';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { projectPrMergeModeService } from '@/lib/services/projectPrMergeModeService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';

// THE PROVENANCE DEFAULT AT ESTABLISHMENT — Story MOTIR-4880 · MOTIR-5178,
// `docs/decisions/approval-gates.md` §7 and its 2026-09-13 amendment.
//
// What is pinned, each against the place it could quietly be wrong:
//
//   1. The rule, total over the set: all Motir-hosted ⇒ `auto`; imported ⇒
//      `manual`; MIXED ⇒ `manual` (named, not inherited from the imported case);
//      no repository ⇒ `manual`; `hostOwner: null` ⇒ `manual`.
//   2. The MOMENT: nothing is written while any row is unsettled, and the hop that
//      settles the last row writes it — through every seam that can be that hop.
//   3. ONCE: a later hosted repository, a re-settle, or a person's earlier choice
//      is never overwritten.
//
// Real Postgres, through the services. The provisioning org is the environment
// variable the server reads (`GITHUB_FALLBACK_ORG`), stubbed per test.

const HOST = 'motir-projects';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_FALLBACK_ORG', HOST);
  vi.spyOn(codeGraphIndexService, 'enqueueFirstIndexForRepos').mockResolvedValue();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A repository mirror row owned by `owner`, connected to the fixture workspace. */
async function repoOwnedBy(owner: string, name: string): Promise<GithubRepo> {
  const installationId = `inst-${fx.workspaceId}-${owner}`;
  const organizationId = await organizationIdOf(fx.workspaceId);
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: `${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}

/** Add a proposed row; return its id. */
async function propose(name: string): Promise<string> {
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx);
  return row.id;
}

/** Settle a proposed row as Motir-CREATED under the provisioning org. */
async function createHosted(name: string): Promise<void> {
  const rowId = await propose(name);
  await projectRepoSetService.markCreating(rowId, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(rowId, (await repoOwnedBy(HOST, name)).id, fx.ctx);
}

/** Settle a proposed row as CONNECTED to the customer's own repository. */
async function connectImported(name: string): Promise<void> {
  const rowId = await propose(name);
  await projectRepoSetService.attachRealizedRepo(
    rowId,
    (await repoOwnedBy('acme', name)).id,
    fx.ctx,
  );
}

async function stored() {
  return adminDb.project.findUniqueOrThrow({
    where: { id: fx.projectId },
    select: { prMergeMode: true, prMergeModeDecidedAt: true },
  });
}

describe('the derivation — pure', () => {
  const hosted = { state: 'created' as const, githubRepo: { owner: 'Motir-Projects' } };
  const imported = { state: 'connected' as const, githubRepo: { owner: 'acme' } };
  const skipped = { state: 'skipped' as const, githubRepo: null };

  it('is established only with at least one row and every row settled', () => {
    expect(isEstablishedSet([])).toBe(false);
    expect(isEstablishedSet([hosted, { state: 'proposed' }])).toBe(false);
    expect(isEstablishedSet([hosted, { state: 'failed' }])).toBe(false);
    expect(isEstablishedSet([hosted, imported, skipped])).toBe(true);
  });

  it('seeds auto only when every repository is Motir-hosted, compared case-insensitively', () => {
    expect(derivePrMergeModeDefault([hosted], HOST)).toBe('auto');
    expect(derivePrMergeModeDefault([hosted, skipped], HOST)).toBe('auto');
  });

  it('seeds manual for imported, MIXED, empty, all-skipped, and no provisioning org', () => {
    expect(derivePrMergeModeDefault([imported], HOST)).toBe('manual');
    expect(derivePrMergeModeDefault([hosted, imported], HOST)).toBe('manual');
    expect(derivePrMergeModeDefault([], HOST)).toBe('manual');
    expect(derivePrMergeModeDefault([skipped], HOST)).toBe('manual');
    expect(derivePrMergeModeDefault([hosted], null)).toBe('manual');
  });
});

describe('the provenance default, written at establishment', () => {
  it('an entirely Motir-hosted set seeds auto', async () => {
    await createHosted('web');
    const row = await stored();
    expect(row.prMergeMode).toBe('auto');
    expect(row.prMergeModeDecidedAt).not.toBeNull();
  });

  it('a set holding the customer’s own repository seeds manual — and marks it decided', async () => {
    await connectImported('web');
    const row = await stored();
    expect(row.prMergeMode).toBe('manual');
    expect(row.prMergeModeDecidedAt, 'a derived manual is DECIDED, not the floor').not.toBeNull();
  });

  it('a MIXED set — one hosted, one imported — seeds manual rather than silently auto-merging', async () => {
    const importedRow = await propose('api');
    await createHosted('web');
    // One row still proposed: not established, nothing written.
    expect((await stored()).prMergeModeDecidedAt).toBeNull();

    await projectRepoSetService.attachRealizedRepo(
      importedRow,
      (await repoOwnedBy('acme', 'api')).id,
      fx.ctx,
    );
    expect((await stored()).prMergeMode).toBe('manual');
  });

  it('an EMPTY set writes nothing — the manual floor stands, undecided', async () => {
    expect(await stored()).toEqual({ prMergeMode: 'manual', prMergeModeDecidedAt: null });
  });

  it('a set whose every row is SKIPPED seeds manual, through the skip hop', async () => {
    await projectRepoSetService.skipRow(await propose('web'), fx.ctx);
    const row = await stored();
    expect(row.prMergeMode).toBe('manual');
    expect(row.prMergeModeDecidedAt).not.toBeNull();
  });

  it('with NO provisioning org, a repository under that login is not hosted and seeds manual', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    await createHosted('web');
    expect((await stored()).prMergeMode).toBe('manual');
  });

  it('nothing is written while a row is still unsettled', async () => {
    await propose('web');
    await createHosted('api');
    expect((await stored()).prMergeModeDecidedAt).toBeNull();
  });

  it('removing the last UNSETTLED row establishes the set', async () => {
    const pending = await propose('api');
    await createHosted('web');
    expect((await stored()).prMergeModeDecidedAt).toBeNull();

    await projectRepoSetService.removeRow(pending, fx.ctx);
    expect((await stored()).prMergeMode).toBe('auto');
  });

  it('linking an organisation repository establishes the set too', async () => {
    const repo = await repoOwnedBy('acme', 'org-repo');
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repo.id, role: 'api' },
      fx.ctx,
    );
    const row = await stored();
    expect(row.prMergeMode).toBe('manual');
    expect(row.prMergeModeDecidedAt).not.toBeNull();
  });

  it('two rows settling CONCURRENTLY still write the default', async () => {
    const a = await propose('web');
    const b = await propose('api');
    await projectRepoSetService.markCreating(a, fx.ctx);
    await projectRepoSetService.markCreating(b, fx.ctx);
    const [repoA, repoB] = [await repoOwnedBy(HOST, 'web'), await repoOwnedBy(HOST, 'api')];

    await Promise.all([
      projectRepoSetService.attachRealizedRepo(a, repoA.id, fx.ctx),
      projectRepoSetService.attachRealizedRepo(b, repoB.id, fx.ctx),
    ]);

    expect((await stored()).prMergeMode).toBe('auto');
  });
});

describe('the default is written ONCE', () => {
  it('adding a HOSTED repository to an established manual project leaves it manual', async () => {
    await connectImported('web');
    expect((await stored()).prMergeMode).toBe('manual');

    await createHosted('api');
    expect(
      (await stored()).prMergeMode,
      'a later repository must not re-derive — the set is now MIXED either way, and the value was decided',
    ).toBe('manual');
  });

  it('a set emptied and re-established later does not re-derive', async () => {
    await createHosted('web');
    const first = await stored();
    expect(first.prMergeMode).toBe('auto');

    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    for (const row of rows) await projectRepoSetService.removeRow(row.id, fx.ctx);
    await connectImported('api');

    expect(await stored()).toEqual(first);
  });

  it('a person’s choice made BEFORE establishment is never overwritten by the default', async () => {
    const at = new Date('2026-09-13T09:00:00.000Z');
    await adminDb.$transaction((tx) =>
      projectRepository.setPrMergeMode(fx.projectId, 'auto', at, tx),
    );

    await connectImported('web');

    expect(await stored()).toEqual({ prMergeMode: 'auto', prMergeModeDecidedAt: at });
  });

  it('the service answers null and writes nothing when the value is already decided', async () => {
    await connectImported('web');
    const before = await stored();
    const written = await withWorkspaceContext(
      { userId: fx.ctx.userId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) => projectPrMergeModeService.seedAtEstablishment(fx.projectId, fx.workspaceId, tx, HOST),
    );
    expect(written).toBeNull();
    expect(await stored()).toEqual(before);
  });

  it('the service answers null for a project that does not exist', async () => {
    const written = await withWorkspaceContext(
      { userId: fx.ctx.userId, workspaceId: fx.workspaceId },
      (tx) => projectPrMergeModeService.seedAtEstablishment('no-such-project', fx.workspaceId, tx),
    );
    expect(written).toBeNull();
  });
});
