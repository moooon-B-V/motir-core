import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectRepoEstablishService } from '@/lib/services/projectRepoEstablishService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { ProjectRepoInvalidFieldError } from '@/lib/projectRepos/errors';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The establish step's READ MODEL + the two set operations MOTIR-1782 adds to make
// the design's editable set real (Story MOTIR-1775).
//
// What is pinned here is what the STEP would otherwise get silently wrong:
//
//   1. The view is ONE snapshot of three sources, and its access gate is the SET's
//      — so a project the actor cannot browse never causes a GitHub read at all.
//   2. The picker offers exactly the installation's repositories, and MARKS the
//      ones this project already claims (a repository backs at most one row).
//   3. `replanRow` is the ADR §4.1 "remove and re-add" made callable — it is
//      allowed out of the two settlements that made NOTHING, refused out of
//      `created` (a real artifact), and preserves everything but the row's id.
//   4. `moveRow` reorders, is a NO-OP at the edges, and is legal in every state —
//      because which repository is PRIMARY is a decision, not a display setting.
//   5. `establishSet({ rowId })` attempts ONLY that row (per-row Retry must not
//      re-attempt a sibling the user has not asked about again).
//
// Real Postgres, no mocks (the repo convention).

const ORG_ENV = 'GITHUB_FALLBACK_ORG';
const originalOrg = process.env[ORG_ENV];

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  if (originalOrg === undefined) delete process.env[ORG_ENV];
  else process.env[ORG_ENV] = originalOrg;
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect repos to the fixture's workspace through a real installation — the
 *  7.10.3 mirror rows the "Use one of mine" picker is built from. */
async function connectRepos(workspaceId: string, names: string[]) {
  const installationId = `inst-${workspaceId}`;
  const inst = await db.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: 'acme-inc',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const created = [];
  for (const name of names) {
    created.push(
      await db.githubRepo.create({
        data: {
          installationId: inst.id,
          workspaceId,
          repoId: `${name}-${created.length}`,
          owner: 'acme-inc',
          name,
          defaultBranch: 'main',
          provider: 'github',
        },
      }),
    );
  }
  return created;
}

describe('the establish step’s read model', () => {
  it('answers with the set plus BOTH GitHub facts as plain nullable values — never a grant state', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);

    const view = await projectRepoEstablishService.getEstablishView(fx.projectId, fx.ctx);

    expect(view.set.rows.map((r) => r.name)).toEqual(['acme-web']);
    // No identity and no installation is a legal, unremarkable state: nothing on
    // the default path asks the user for a GitHub permission.
    expect(view.githubLogin).toBeNull();
    expect(view.hasInstallation).toBe(false);
    expect(view.connectCandidates).toEqual([]);
  });

  it('carries the provisioning org as the row’s FIXED owner prefix, and null when the deployment cannot provision', async () => {
    const fx = await makeWorkItemFixture();

    process.env[ORG_ENV] = 'motir-projects';
    expect(
      (await projectRepoEstablishService.getEstablishView(fx.projectId, fx.ctx)).hostOwner,
    ).toBe('motir-projects');

    // A self-hosted instance with no org: the prefix simply disappears. It is NOT
    // a blocked state — the design draws no such screen, and a create attempt
    // fails with the not-configured reason on the row that tried.
    delete process.env[ORG_ENV];
    expect(
      (await projectRepoEstablishService.getEstablishView(fx.projectId, fx.ctx)).hostOwner,
    ).toBeNull();
  });

  it('offers the installation’s repositories, and MARKS the one this project already claims', async () => {
    const fx = await makeWorkItemFixture();
    const [mine, theirs] = await connectRepos(fx.workspaceId, ['booking-service', 'spare-repo']);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    await projectRepoSetService.attachRealizedRepo(row.id, mine!.id, fx.ctx);

    const view = await projectRepoEstablishService.getEstablishView(fx.projectId, fx.ctx);

    expect(view.hasInstallation).toBe(true);
    expect(view.connectCandidates.map((c) => c.repoRef).sort()).toEqual([
      'acme-inc/booking-service',
      'acme-inc/spare-repo',
    ]);
    // Claimed is what keeps the picker from offering a choice that can only 409.
    expect(view.connectCandidates.find((c) => c.id === mine!.id)?.claimed).toBe(true);
    expect(view.connectCandidates.find((c) => c.id === theirs!.id)?.claimed).toBe(false);
  });

  it('hides a project in ANOTHER workspace as a 404 — the set’s own gate, inherited', async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture();

    const err = await projectRepoEstablishService
      .getEstablishView(b.projectId, a.ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('replanRow — the ADR §4.1 “remove and re-add”, made callable', () => {
  it('puts a SKIPPED row back in play as a fresh proposal, keeping everything but its id', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api', label: 'billing', proposalSignal: 'plan-item-role' },
      fx.ctx,
    );
    await projectRepoSetService.skipRow(row.id, fx.ctx);

    const fresh = await projectRepoSetService.replanRow(row.id, fx.ctx);

    expect(fresh.id).not.toBe(row.id);
    expect(fresh.state).toBe('proposed');
    expect(fresh.name).toBe('acme-api');
    expect(fresh.role).toBe('api');
    expect(fresh.label).toBe('billing');
    expect(fresh.seedSource).toBe(row.seedSource);
    // The signal records what MOTIR inferred at proposal time; the user changing
    // their mind about the row does not rewrite that history.
    expect(fresh.proposalSignal).toBe('plan-item-role');
    expect(fresh.position).toBe(row.position);

    // The old row is GONE — the set holds exactly one row, at the same place.
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.map((r) => r.id)).toEqual([fresh.id]);
  });

  it('UN-CLAIMS the repository when a CONNECTED row is re-planned, so it can be picked again', async () => {
    const fx = await makeWorkItemFixture();
    const [repo] = await connectRepos(fx.workspaceId, ['booking-monorepo']);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'w' },
      fx.ctx,
    );
    await projectRepoSetService.attachRealizedRepo(row.id, repo!.id, fx.ctx);

    const fresh = await projectRepoSetService.replanRow(row.id, fx.ctx);
    expect(fresh.realizedRepo).toBeNull();
    expect(fresh.established).toBe(false);

    // …and the repository is free for another row: the claim was the ROW's, not
    // the repository's, so nothing about the repository itself changed.
    const other = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'a' },
      fx.ctx,
    );
    const connected = await projectRepoSetService.attachRealizedRepo(other.id, repo!.id, fx.ctx);
    expect(connected.state).toBe('connected');
  });

  it('REFUSES a created row — a real repository is not un-made to tidy a record', async () => {
    const fx = await makeWorkItemFixture();
    const [repo] = await connectRepos(fx.workspaceId, ['acme-web']);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    const created = await projectRepoSetService.attachRealizedRepo(row.id, repo!.id, fx.ctx);
    expect(created.state).toBe('created');

    const err = await projectRepoSetService.replanRow(row.id, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectRepoInvalidFieldError);
    // Still there, still created — the refusal changed nothing.
    expect((await projectRepoSetService.listByProject(fx.projectId, fx.ctx))[0]!.state).toBe(
      'created',
    );
  });

  it('REFUSES an unsettled row — a proposed or failed row is edited in place, not re-planned', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'w' },
      fx.ctx,
    );

    const err = await projectRepoSetService.replanRow(row.id, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectRepoInvalidFieldError);
  });
});

describe('moveRow — which repository is PRIMARY is a decision', () => {
  async function threeRows() {
    const fx = await makeWorkItemFixture();
    const a = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'a' }, fx.ctx);
    const b = await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'b' }, fx.ctx);
    const c = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'infra', name: 'c' },
      fx.ctx,
    );
    return { fx, a, b, c };
  }

  const order = async (fx: {
    projectId: string;
    ctx: Parameters<typeof projectRepoSetService.listByProject>[1];
  }) => (await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).map((r) => r.name);

  it('moves a row UP one place, changing which row is primary', async () => {
    const { fx, b } = await threeRows();
    await projectRepoSetService.moveRow(b.id, 'up', fx.ctx);
    expect(await order(fx)).toEqual(['b', 'a', 'c']);
  });

  it('moves a row DOWN one place', async () => {
    const { fx, a } = await threeRows();
    await projectRepoSetService.moveRow(a.id, 'down', fx.ctx);
    expect(await order(fx)).toEqual(['b', 'a', 'c']);
  });

  it('is a NO-OP at each edge — a double-press on the top row is not a failure', async () => {
    const { fx, a, c } = await threeRows();
    const stillA = await projectRepoSetService.moveRow(a.id, 'up', fx.ctx);
    const stillC = await projectRepoSetService.moveRow(c.id, 'down', fx.ctx);
    expect(stillA.position).toBe(a.position);
    expect(stillC.position).toBe(c.position);
    expect(await order(fx)).toEqual(['a', 'b', 'c']);
  });

  it('reorders a SETTLED row too — order says which is primary, not what happened to it', async () => {
    const { fx, a, c } = await threeRows();
    await projectRepoSetService.skipRow(c.id, fx.ctx);
    await projectRepoSetService.moveRow(c.id, 'up', fx.ctx);
    expect(await order(fx)).toEqual(['a', 'c', 'b']);
    expect(a.position).toBeTruthy();
  });

  it('survives repeated moves without collapsing two rows onto one key', async () => {
    const { fx, a, b, c } = await threeRows();
    for (let i = 0; i < 6; i += 1) {
      await projectRepoSetService.moveRow(c.id, 'up', fx.ctx);
      await projectRepoSetService.moveRow(a.id, 'down', fx.ctx);
    }
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(new Set(rows.map((r) => r.position)).size).toBe(3);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });
});

describe('establishSet({ rowId }) — the per-row Retry', () => {
  it('attempts ONLY the named row and reports every sibling as not attempted', async () => {
    const fx = await makeWorkItemFixture();
    const a = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'a' }, fx.ctx);
    const b = await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'b' }, fx.ctx);

    // No provisioning credentials in the test env, so the attempted row FAILS —
    // which is exactly what this asserts on: it was attempted, and `b` was not.
    delete process.env[ORG_ENV];
    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx, {
      rowId: a.id,
    });

    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((r) => r.rowId === a.id)?.outcome).toBe('failed');
    expect(result.rows.find((r) => r.rowId === b.id)?.outcome).toBe('not_attempted');

    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.find((r) => r.id === a.id)?.state).toBe('failed');
    // The sibling is untouched — rows are independent (ADR §4.2).
    expect(rows.find((r) => r.id === b.id)?.state).toBe('proposed');
  });

  it('attempts nothing for a row id that is not in this set — the honest answer, not a throw', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'a' }, fx.ctx);

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx, {
      rowId: 'not-a-row-in-this-set',
    });

    expect(result.rows.every((r) => r.outcome === 'not_attempted')).toBe(true);
    expect((await projectRepoSetService.listByProject(fx.projectId, fx.ctx))[0]!.state).toBe(
      'proposed',
    );
  });
});
