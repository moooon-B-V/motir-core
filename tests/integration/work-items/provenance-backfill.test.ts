import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  WorkItemImplementationSource,
  WorkItemPlanningSource,
} from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { MOTIR_SEED_BURST_END } from '@/lib/workItems/provenanceBackfill';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The provenance BACKFILL against real Postgres (MOTIR-1758) — the half the
// pure decision-table suite (tests/workItems/provenance-backfill-rules.test.ts)
// cannot assert: that the sweep reads the right rows, that the writes land
// through the repository under a bound workspace context, that a row which
// already carried provenance SURVIVES untouched, and that a second consecutive
// run writes nothing. Real Postgres, no mocks, per CLAUDE.md.

const IN_BURST = new Date(MOTIR_SEED_BURST_END.getTime() - 60_000);
const AFTER_BURST = new Date(MOTIR_SEED_BURST_END.getTime() + 60_000);

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "github_pull_request", "github_repo", "github_installation", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/**
 * Create a work item and force the row-level facts the backfill reads —
 * `createdAt` (which Prisma defaults to now()) and `status` — through the same
 * kind of direct column write the seed's own history represents. This is a
 * FIXTURE, not the code under test: the service still reads and writes through
 * its own layers.
 */
async function seedRow(
  fx: WorkItemFixture,
  opts: {
    title: string;
    createdAt: Date;
    status?: string;
    executor?: 'coding_agent' | 'human';
    type?: 'code' | 'manual';
    // Derived from the GENERATED enums, never re-typed by hand: a value added
    // to `schema.prisma` (as `api` was — MOTIR-2044) must be seedable here
    // without editing this fixture, or the tests that prove the new value is
    // handled cannot be written in the first place.
    planningSource?: WorkItemPlanningSource;
    implementationSource?: WorkItemImplementationSource;
    sessionBranch?: string;
    archived?: boolean;
  },
): Promise<{ id: string; identifier: string }> {
  const item = await createTestWorkItem(fx, {
    kind: 'task',
    title: opts.title,
    type: opts.type ?? 'code',
    executor: opts.executor ?? 'coding_agent',
  });
  await db.workItem.update({
    where: { id: item.id },
    data: {
      createdAt: opts.createdAt,
      status: opts.status ?? 'todo',
      planningSource: opts.planningSource ?? null,
      implementationSource: opts.implementationSource ?? null,
      sessionBranch: opts.sessionBranch ?? null,
      archivedAt: opts.archived ? new Date() : null,
    },
  });
  return { id: item.id, identifier: item.identifier };
}

let prNumber = 0;

/** Attach a linked PR to an item — the 7.10.3 `GithubPullRequest` mirror the rules read. */
async function linkPullRequest(fx: WorkItemFixture, workItemId: string): Promise<void> {
  const installationId = `inst-${fx.workspaceId}`;
  const inst = await db.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await db.githubRepo.upsert({
    where: { installationId_repoId: { installationId: inst.id, repoId: 'repo-1' } },
    create: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: 'repo-1',
      owner: 'moooon-B-V',
      name: 'motir-core',
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
    update: {},
  });
  prNumber += 1;
  await db.githubPullRequest.create({
    data: {
      provider: 'github',
      repoId: repo.id,
      number: prNumber,
      state: 'closed',
      merged: true,
      headRef: `subtask/MOTIR-${prNumber}`,
      workItemId,
    },
  });
}

function read(id: string) {
  return db.workItem.findUniqueOrThrow({
    where: { id },
    select: {
      planningSource: true,
      planningHarness: true,
      planningModel: true,
      implementationSource: true,
      implementationHarness: true,
      implementationModel: true,
    },
  });
}

describe('backfillProvenanceForProject — the decision pass over real rows', () => {
  it('stamps planning + implementation per the rules, and reports the split', async () => {
    const fx = await makeWorkItemFixture();
    const seedDone = await seedRow(fx, {
      title: 'seed, done, PR',
      createdAt: IN_BURST,
      status: 'done',
    });
    await linkPullRequest(fx, seedDone.id);
    const seedHuman = await seedRow(fx, {
      title: 'seed, done, human',
      createdAt: IN_BURST,
      status: 'done',
      executor: 'human',
    });
    const postSeedOpen = await seedRow(fx, {
      title: 'post-seed, open',
      createdAt: AFTER_BURST,
      status: 'in_progress',
    });
    const postSeedAgentDone = await seedRow(fx, {
      title: 'post-seed, done, agent, no evidence',
      createdAt: AFTER_BURST,
      status: 'done',
    });

    const report = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    expect(report.projectIdentifier).toBe(fx.project.identifier);
    expect(report.dryRun).toBe(false);
    expect(report.candidates).toBe(4);
    expect(report.createdAtOrBeforeBoundary).toBe(2);
    expect(report.createdAfterBoundary).toBe(2);
    // `cancelled` is a done-CATEGORY status but is excluded from "implemented".
    expect(report.implementedStatusKeys).toEqual(['done']);

    expect(report.planning.manual.written).toBe(2);
    expect(report.planning.mcp.written).toBe(2);
    expect(report.implementation.byok.written).toBe(1);
    expect(report.implementation.manual.written).toBe(1);
    expect(report.implementationLeftNull.notImplementedYet).toBe(1);
    expect(report.implementationLeftNull.doneWithoutEvidence).toBe(1);

    expect(await read(seedDone.id)).toMatchObject({
      planningSource: 'manual',
      implementationSource: 'byok',
    });
    expect(await read(seedHuman.id)).toMatchObject({
      planningSource: 'manual',
      implementationSource: 'manual',
    });
    expect(await read(postSeedOpen.id)).toMatchObject({
      planningSource: 'mcp',
      implementationSource: null,
    });
    expect(await read(postSeedAgentDone.id)).toMatchObject({
      planningSource: 'mcp',
      implementationSource: null,
    });
  });

  it('NEVER writes a harness or a model — all four columns stay NULL', async () => {
    const fx = await makeWorkItemFixture();
    const item = await seedRow(fx, {
      title: 'seed, done, human',
      createdAt: IN_BURST,
      status: 'done',
      executor: 'human',
    });

    await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    const row = await read(item.id);
    expect(row.planningSource).toBe('manual');
    expect(row.implementationSource).toBe('manual');
    expect(row.planningHarness).toBeNull();
    expect(row.planningModel).toBeNull();
    expect(row.implementationHarness).toBeNull();
    expect(row.implementationModel).toBeNull();
  });

  it('leaves a PRE-STAMPED row exactly as it was — both halves, both directions', async () => {
    const fx = await makeWorkItemFixture();
    // A row the rules would otherwise call `manual` + `byok`, already carrying
    // something else. The backfill must not "correct" it.
    const stamped = await seedRow(fx, {
      title: 'already attributed',
      createdAt: IN_BURST,
      status: 'done',
      executor: 'human',
      planningSource: 'native',
      implementationSource: 'hosted',
    });
    await linkPullRequest(fx, stamped.id);
    await db.workItem.update({
      where: { id: stamped.id },
      data: {
        planningHarness: 'Motir',
        planningModel: 'deepseek-chat',
        implementationHarness: 'hosted-runner',
        implementationModel: 'claude-opus-5',
      },
    });
    const before = await read(stamped.id);

    const report = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    // Fully-stamped rows are not even candidates.
    expect(report.candidates).toBe(0);
    expect(await read(stamped.id)).toEqual(before);
  });

  // ⚠️ The specific row MOTIR-2044 exists to protect. A work item created over
  // `/api/v1` sits AFTER the seed burst, which is exactly the shape the planning
  // rule stamps `mcp` — so if the backfill ever stopped honouring an existing
  // value, every API-created item would be silently re-attributed to the agent
  // tool surface, permanently and unrecoverably (nothing in a row reveals which
  // surface wrote it). Asserted against real Postgres rather than the pure rule,
  // because the write-level null-guard is the half that actually runs in
  // production.
  it('leaves a row stamped `api` untouched — it is never re-classified as `mcp`', async () => {
    const fx = await makeWorkItemFixture();
    const apiRow = await seedRow(fx, {
      title: 'created by an external integration over /api/v1',
      createdAt: AFTER_BURST, // the shape the `mcp` rule would otherwise claim
      status: 'todo',
      planningSource: 'api',
    });
    const before = await read(apiRow.id);

    const report = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    expect(await read(apiRow.id)).toMatchObject({ planningSource: 'api' });
    // And the planning half wrote nothing at all on this row.
    expect(report.planning.mcp.sample).not.toContain(apiRow.identifier);
    expect(report.planning.manual.sample).not.toContain(apiRow.identifier);
    expect((await read(apiRow.id)).planningSource).toBe(before.planningSource);
  });

  it('fills only the MISSING half of a half-stamped row', async () => {
    const fx = await makeWorkItemFixture();
    const half = await seedRow(fx, {
      title: 'planning known, implementation unknown',
      createdAt: AFTER_BURST,
      status: 'done',
      executor: 'human',
      planningSource: 'native',
    });

    await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    expect(await read(half.id)).toMatchObject({
      planningSource: 'native', // untouched
      implementationSource: 'manual', // filled
    });
  });

  it('counts a row whose IMPLEMENTATION is already known as already-stamped', async () => {
    const fx = await makeWorkItemFixture();
    // Planning missing, implementation already reported by a BYOK agent — the
    // row is still a candidate (for its planning half) but its implementation
    // half must be recorded as untouchable, not as missing evidence.
    const half = await seedRow(fx, {
      title: 'implementation known, planning unknown',
      createdAt: IN_BURST,
      status: 'done',
      executor: 'human',
      implementationSource: 'byok',
    });

    const report = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    expect(report.candidates).toBe(1);
    expect(report.implementationLeftNull).toEqual({
      alreadyStamped: 1,
      notImplementedYet: 0,
      doneWithoutEvidence: 0,
    });
    expect(report.implementation.manual.written).toBe(0);
    expect(await read(half.id)).toMatchObject({
      planningSource: 'manual', // filled
      implementationSource: 'byok', // untouched
    });
  });

  it('is IDEMPOTENT — a second consecutive run writes zero rows', async () => {
    const fx = await makeWorkItemFixture();
    await seedRow(fx, { title: 'a', createdAt: IN_BURST, status: 'done', executor: 'human' });
    await seedRow(fx, { title: 'b', createdAt: AFTER_BURST, status: 'todo' });

    const first = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);
    expect(first.planning.manual.written + first.planning.mcp.written).toBe(2);
    expect(first.implementation.manual.written).toBe(1);

    const second = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);
    expect(second.candidates).toBe(1); // the todo row still has no implementation source
    expect(second.planning.manual.written).toBe(0);
    expect(second.planning.mcp.written).toBe(0);
    expect(second.implementation.byok.written).toBe(0);
    expect(second.implementation.manual.written).toBe(0);
  });

  it('includes ARCHIVED rows and reports how many it touched', async () => {
    const fx = await makeWorkItemFixture();
    const archived = await seedRow(fx, {
      title: 'archived seed row',
      createdAt: IN_BURST,
      status: 'done',
      executor: 'human',
      archived: true,
    });

    const report = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    expect(report.archivedCandidates).toBe(1);
    expect(await read(archived.id)).toMatchObject({
      planningSource: 'manual',
      implementationSource: 'manual',
    });
  });

  it('treats a session branch as BYOK evidence', async () => {
    const fx = await makeWorkItemFixture();
    const item = await seedRow(fx, {
      title: 'integrated on a branch',
      createdAt: AFTER_BURST,
      status: 'done',
      sessionBranch: 'subtask/MOTIR-1758-provenance-backfill',
    });

    await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    expect(await read(item.id)).toMatchObject({ implementationSource: 'byok' });
  });

  it('never stamps an implementation source on a CANCELLED item', async () => {
    const fx = await makeWorkItemFixture();
    const cancelled = await seedRow(fx, {
      title: 'abandoned',
      createdAt: IN_BURST,
      status: 'cancelled',
      executor: 'human',
    });
    await linkPullRequest(fx, cancelled.id);

    const report = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    expect(report.implementation.byok.written).toBe(0);
    expect(report.implementation.manual.written).toBe(0);
    expect(await read(cancelled.id)).toMatchObject({
      planningSource: 'manual', // planning is still knowable
      implementationSource: null, // implementation is not
    });
  });

  it('does not touch ANOTHER project’s rows', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await seedRow(other, {
      title: 'someone else’s history',
      createdAt: IN_BURST,
      status: 'done',
      executor: 'human',
    });

    const report = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    expect(report.candidates).toBe(0);
    expect(await read(foreign.id)).toMatchObject({
      planningSource: null,
      implementationSource: null,
    });
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    await expect(
      workItemsService.backfillProvenanceForProject('does-not-exist', 'nobody'),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('backfillProvenanceForProject — dry run', () => {
  it('decides and reports the same counts but writes NOTHING', async () => {
    const fx = await makeWorkItemFixture();
    const seedHuman = await seedRow(fx, {
      title: 'seed, done, human',
      createdAt: IN_BURST,
      status: 'done',
      executor: 'human',
    });
    const postSeed = await seedRow(fx, { title: 'post-seed', createdAt: AFTER_BURST });

    const dry = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId, {
      dryRun: true,
    });

    expect(dry.dryRun).toBe(true);
    expect(dry.candidates).toBe(2);
    expect(dry.planning.manual.count).toBe(1);
    expect(dry.planning.mcp.count).toBe(1);
    expect(dry.implementation.manual.count).toBe(1);
    expect(dry.planning.manual.sample).toContain(seedHuman.identifier);
    // …but every `written` is 0, and the rows are untouched.
    expect(dry.planning.manual.written).toBe(0);
    expect(dry.planning.mcp.written).toBe(0);
    expect(dry.implementation.manual.written).toBe(0);
    expect(await read(seedHuman.id)).toMatchObject({
      planningSource: null,
      implementationSource: null,
    });
    expect(await read(postSeed.id)).toMatchObject({ planningSource: null });

    // A real run afterwards writes exactly what the rehearsal predicted.
    const real = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);
    expect(real.planning.manual.written).toBe(dry.planning.manual.count);
    expect(real.planning.mcp.written).toBe(dry.planning.mcp.count);
    expect(real.implementation.manual.written).toBe(dry.implementation.manual.count);
  });

  it('honours a caller-supplied seed-burst boundary', async () => {
    const fx = await makeWorkItemFixture();
    await seedRow(fx, { title: 'after the MOTIR boundary', createdAt: AFTER_BURST });

    const withDefault = await workItemsService.backfillProvenanceForProject(
      fx.projectId,
      fx.ownerId,
      { dryRun: true },
    );
    expect(withDefault.planning.mcp.count).toBe(1);
    expect(withDefault.planning.manual.count).toBe(0);

    const withLater = await workItemsService.backfillProvenanceForProject(
      fx.projectId,
      fx.ownerId,
      {
        dryRun: true,
        seedBurstEnd: new Date(AFTER_BURST.getTime() + 1_000),
      },
    );
    expect(withLater.planning.manual.count).toBe(1);
    expect(withLater.planning.mcp.count).toBe(0);
  });
});
