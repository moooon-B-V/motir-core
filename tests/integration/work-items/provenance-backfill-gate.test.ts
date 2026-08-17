import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { MOTIR_SEED_BURST_END } from '@/lib/workItems/provenanceBackfill';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { createTestProject } from '../../fixtures/projectFixtures';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The provenance backfill's INTEGRATION GATE (MOTIR-1760) — the seams
// MOTIR-1758's own suite does not drive, against real Postgres.
//
// Its unit suite proves the DECISION TABLE over synthetic row shapes and its
// integration suite proves the service writes what the table decided. Neither
// proves the third link: that the Provenance section can READ BACK what the
// backfill wrote. A key or mapping drift between the writer (the repository's
// `updateMany`) and the reader (`toWorkItemDto`) would leave both of those
// suites green while the surface the whole repair exists to fill renders empty
// — the failure mode a story-level seam test exists to catch (Story 5.7's
// `workItemKey`-vs-`issueKey` drift, PR #959). So EVERY branch below is
// asserted twice: once on the persisted column, once through
// `workItemsService.getWorkItem`, the same read the detail page performs.
//
// It also closes three claims the card makes that were asserted only in part:
// idempotence as byte-identity (not just a zero write count), `--dry-run` as a
// whole-table no-op (not just two spot reads), and tenant scoping against a
// SECOND PROJECT IN THE SAME WORKSPACE — the sharper form, since a shared
// workspace means only the `projectId` filter can hold the line.
//
// ── THE CLIENT EACH DIRECT LINE TAKES (MOTIR-2911) ──────────────────────────
// Two clients, and which one a line gets is decided by whether the statement is
// the SUBJECT of the test or its scaffolding:
//
//   * `workItemRepository.findProvenanceBackfillCandidates` and the two
//     `backfill*SourceByIds` writes ARE the subject — MOTIR-2881's class 2 — so
//     they stay on `@/lib/db` and get a BOUND transaction via
//     `withWorkspaceContext(fx.ctx, …)`. `work_item` is workspace-keyed; called
//     with no `tx` (or inside a bare `db.$transaction`, which binds no GUC at
//     all) the sweep read returns `[]` under `motir_app` and the `updateMany`
//     matches nothing — both silently. Moving them to `adminDb` would make every
//     assertion here green by taking the code under test off the restricted role,
//     which is the one way this work fails without saying so.
//   * `adminDb` keeps the seeding, the mid-sweep clobber and the raw readbacks —
//     fixtures that need OWNERSHIP (`TRUNCATE`, and writing values the backfill
//     is not allowed to produce).

const IN_BURST = new Date(MOTIR_SEED_BURST_END.getTime() - 60_000);
const AFTER_BURST = new Date(MOTIR_SEED_BURST_END.getTime() + 60_000);

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "github_pull_request", "github_repo", "github_installation", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface SeedOptions {
  title: string;
  createdAt: Date;
  status?: string;
  executor?: 'coding_agent' | 'human';
  type?: 'code' | 'manual';
  planningSource?: 'native' | 'mcp' | 'manual';
  implementationSource?: 'hosted' | 'byok' | 'manual';
  planningHarness?: string;
  sessionBranch?: string;
}

/**
 * Create a work item and force the row-level facts the backfill reads —
 * `createdAt` (Prisma defaults it to now()) and `status`. A FIXTURE, not the
 * code under test: the service still reads and writes through its own layers.
 * Mirrors `seedRow` in the MOTIR-1758 suite rather than importing it, so a
 * change to either suite's fixture cannot silently reshape the other's cases.
 */
async function seedRow(
  fx: WorkItemFixture,
  opts: SeedOptions,
): Promise<{ id: string; identifier: string }> {
  const item = await createTestWorkItem(fx, {
    kind: 'task',
    title: opts.title,
    type: opts.type ?? 'code',
    executor: opts.executor ?? 'coding_agent',
  });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      createdAt: opts.createdAt,
      status: opts.status ?? 'todo',
      planningSource: opts.planningSource ?? null,
      implementationSource: opts.implementationSource ?? null,
      planningHarness: opts.planningHarness ?? null,
      sessionBranch: opts.sessionBranch ?? null,
    },
  });
  return { id: item.id, identifier: item.identifier };
}

let prNumber = 0;

/** Attach a linked PR — the 7.10.3 `GithubPullRequest` mirror the rules read. */
async function linkPullRequest(fx: WorkItemFixture, workItemId: string): Promise<void> {
  const installationId = `inst-${fx.workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
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
  const repo = await adminDb.githubRepo.upsert({
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
  await adminDb.githubPullRequest.create({
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

/**
 * Every provenance column of every row in the database, plus `updatedAt` — the
 * whole-table snapshot the dry-run and idempotence claims compare. `updatedAt`
 * is in it deliberately: Prisma stamps it on `updateMany`, so including it is
 * what turns "wrote nothing" from a reported count into an observed fact.
 */
async function snapshotProvenance() {
  return adminDb.workItem.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      planningSource: true,
      planningHarness: true,
      planningModel: true,
      implementationSource: true,
      implementationHarness: true,
      implementationModel: true,
      updatedAt: true,
    },
  });
}

/** Read one item back the way the detail surface does — through the DTO. */
function readDto(id: string, fx: WorkItemFixture): Promise<WorkItemDto> {
  return workItemsService.getWorkItem(id, fx.ctx);
}

/** The decision table, seeded once — one row per branch, plus the two abstentions. */
async function seedTheDecisionTable(fx: WorkItemFixture) {
  const seedBurst = await seedRow(fx, { title: 'seed-burst row', createdAt: IN_BURST });
  const postSeed = await seedRow(fx, { title: 'later MCP row', createdAt: AFTER_BURST });
  const donePr = await seedRow(fx, {
    title: 'done, linked PR',
    createdAt: AFTER_BURST,
    status: 'done',
  });
  await linkPullRequest(fx, donePr.id);
  const doneBranch = await seedRow(fx, {
    title: 'done, session branch',
    createdAt: AFTER_BURST,
    status: 'done',
    sessionBranch: 'subtask/MOTIR-1758-provenance-backfill',
  });
  const doneHuman = await seedRow(fx, {
    title: 'done, human card, no evidence',
    createdAt: IN_BURST,
    status: 'done',
    executor: 'human',
  });
  const doneAgentNoEvidence = await seedRow(fx, {
    title: 'done, coding agent, no evidence',
    createdAt: IN_BURST,
    status: 'done',
    executor: 'coding_agent',
  });
  const notDone = await seedRow(fx, {
    title: 'in review — work not merged',
    createdAt: AFTER_BURST,
    status: 'in_review',
  });
  await linkPullRequest(fx, notDone.id);
  const preStamped = await seedRow(fx, {
    title: 'already carries provenance',
    createdAt: IN_BURST,
    status: 'done',
    executor: 'human',
    planningSource: 'native',
    implementationSource: 'byok',
    planningHarness: 'Cursor',
  });
  return {
    seedBurst,
    postSeed,
    donePr,
    doneBranch,
    doneHuman,
    doneAgentNoEvidence,
    notDone,
    preStamped,
  };
}

describe('the backfill, read back through the consumer DTO', () => {
  it('every branch of the decision table lands on the column AND on the DTO', async () => {
    const fx = await makeWorkItemFixture();
    const rows = await seedTheDecisionTable(fx);

    await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    // (source, implementation) expected per branch — asserted on the DTO, which
    // is what the Provenance section actually renders.
    const expected: Array<[string, string | null, string | null, string]> = [
      [
        rows.seedBurst.id,
        'manual',
        null,
        'a seed-burst row is hand-authored planning, not shipped',
      ],
      [rows.postSeed.id, 'mcp', null, 'a later row came through the MCP tool surface'],
      [rows.donePr.id, 'mcp', 'byok', 'a linked PR is the database’s own evidence of BYOK work'],
      [rows.doneBranch.id, 'mcp', 'byok', 'a session branch is the same evidence in another form'],
      [rows.doneHuman.id, 'manual', 'manual', 'a done human card with no PR is genuinely manual'],
      [
        rows.doneAgentNoEvidence.id,
        'manual',
        null,
        'THE ABSTENTION — a done coding-agent card with no evidence stays NULL',
      ],
      [rows.notDone.id, 'mcp', null, 'in-review work is not merged, so nothing was implemented'],
      [
        rows.preStamped.id,
        'native',
        'byok',
        'a pre-stamped row keeps exactly what its writer wrote',
      ],
    ];

    for (const [id, planningSource, implementationSource, why] of expected) {
      const dto = await readDto(id, fx);
      expect(
        { planningSource: dto.planningSource, implementationSource: dto.implementationSource },
        why,
      ).toEqual({
        planningSource,
        implementationSource,
      });
      // …and the DTO agrees with the column, so no mapper default is papering
      // over a write that never landed.
      const row = await adminDb.workItem.findUniqueOrThrow({
        where: { id },
        select: { planningSource: true, implementationSource: true },
      });
      expect(row).toEqual({ planningSource, implementationSource });
    }
  });

  it('leaves the harness + model columns NULL on every row it touched — on the DTO too', async () => {
    const fx = await makeWorkItemFixture();
    const rows = await seedTheDecisionTable(fx);

    await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    for (const [name, row] of Object.entries(rows)) {
      if (name === 'preStamped') continue; // its harness was seeded, not written
      const dto = await readDto(row.id, fx);
      expect(
        {
          planningHarness: dto.planningHarness,
          planningModel: dto.planningModel,
          implementationHarness: dto.implementationHarness,
          implementationModel: dto.implementationModel,
        },
        `${name} must carry no fabricated harness or model`,
      ).toEqual({
        planningHarness: null,
        planningModel: null,
        implementationHarness: null,
        implementationModel: null,
      });
    }

    // The pre-stamped row's own harness survives untouched — the backfill does
    // not write these columns in EITHER direction.
    const preserved = await readDto(rows.preStamped.id, fx);
    expect(preserved.planningHarness).toBe('Cursor');
  });
});

describe('the no-op claims, proven against the whole table', () => {
  it('--dry-run mutates NOTHING — every row byte-identical, updatedAt included', async () => {
    const fx = await makeWorkItemFixture();
    await seedTheDecisionTable(fx);

    const before = await snapshotProvenance();
    const dry = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId, {
      dryRun: true,
    });
    const after = await snapshotProvenance();

    // It DECIDED plenty — this is not a no-op because it found nothing to do.
    expect(dry.planning.manual.count + dry.planning.mcp.count).toBeGreaterThan(0);
    expect(dry.implementation.byok.count).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });

  it('a second consecutive run is byte-identical — idempotence, not just a zero count', async () => {
    const fx = await makeWorkItemFixture();
    const rows = await seedTheDecisionTable(fx);

    await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);
    const afterFirst = await snapshotProvenance();

    const second = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);
    const afterSecond = await snapshotProvenance();

    expect(second.planning.manual.written).toBe(0);
    expect(second.planning.mcp.written).toBe(0);
    expect(second.implementation.byok.written).toBe(0);
    expect(second.implementation.manual.written).toBe(0);
    expect(afterSecond).toEqual(afterFirst);

    // The pre-stamped row in particular — the one a looser rule would clobber.
    const preStamped = afterSecond.find((row) => row.id === rows.preStamped.id);
    expect(preStamped).toMatchObject({
      planningSource: 'native',
      implementationSource: 'byok',
      planningHarness: 'Cursor',
    });
  });
});

describe('the null-guard is what makes the sweep race-safe, not merely tidy', () => {
  // MOTIR-1758 claims the writes need no row lock because every `updateMany`
  // carries `<source>: null` in its WHERE. A two-consecutive-runs test does NOT
  // exercise that claim — by the second run the classifier has already
  // abstained, so the guard never has to do anything and deleting it leaves the
  // suite green. The guard only earns its keep in the window between the sweep
  // READ and the WRITE, so that is the window these two drive directly.

  it('a row stamped BETWEEN the sweep and the write keeps the concurrent value', async () => {
    const fx = await makeWorkItemFixture();
    const raced = await seedRow(fx, {
      title: 'stamped mid-sweep by a concurrent MCP create',
      createdAt: IN_BURST,
      status: 'done',
      executor: 'human',
    });

    // The sweep reads it as a candidate and decides `manual` / `manual`…
    const candidates = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemRepository.findProvenanceBackfillCandidates(fx.projectId, fx.workspaceId, tx),
    );
    expect(candidates.map((row) => row.id)).toEqual([raced.id]);

    // …and before the write lands, another writer stamps both halves. These are
    // deliberately values the backfill can NEVER produce (`native` / `hosted`),
    // so a clobber is unmistakable rather than a coincidence.
    await adminDb.workItem.update({
      where: { id: raced.id },
      data: { planningSource: 'native', implementationSource: 'hosted' },
    });

    // A BOUND transaction, not a bare `db.$transaction`: the guard under test is
    // `<source>: null` in the WHERE, and an unbound `updateMany` writes 0 rows
    // whatever the guard says — which is the number this asserts.
    const written = await withWorkspaceContext(fx.ctx, async (tx) => ({
      planning: await workItemRepository.backfillPlanningSourceByIds([raced.id], 'manual', tx),
      implementation: await workItemRepository.backfillImplementationSourceByIds(
        [raced.id],
        'manual',
        tx,
      ),
    }));

    expect(written).toEqual({ planning: 0, implementation: 0 });
    const dto = await readDto(raced.id, fx);
    expect({
      planningSource: dto.planningSource,
      implementationSource: dto.implementationSource,
    }).toEqual({ planningSource: 'native', implementationSource: 'hosted' });
  });

  it('writes nothing, and opens no statement, for an empty id list', async () => {
    const fx = await makeWorkItemFixture();
    const untouched = await seedRow(fx, { title: 'bystander', createdAt: IN_BURST });

    const written = await withWorkspaceContext(fx.ctx, async (tx) => ({
      planning: await workItemRepository.backfillPlanningSourceByIds([], 'manual', tx),
      implementation: await workItemRepository.backfillImplementationSourceByIds([], 'byok', tx),
    }));

    expect(written).toEqual({ planning: 0, implementation: 0 });
    const dto = await readDto(untouched.id, fx);
    expect(dto.planningSource).toBeNull();
  });
});

describe('tenant scoping', () => {
  it('a single-project run leaves a SECOND PROJECT in the same workspace untouched', async () => {
    const fx = await makeWorkItemFixture();
    const siblingProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SIB',
      name: 'Sibling',
    });
    // Same workspace, same owner, same everything but the project — so the
    // workspace gate cannot be what holds the line here; only the projectId
    // filter can. That is the guard this repair needs.
    const siblingFx: WorkItemFixture = {
      ...fx,
      project: siblingProject,
      projectId: siblingProject.id,
      projectIdentifier: siblingProject.identifier,
    };
    const sibling = await seedTheDecisionTable(siblingFx);
    const target = await seedTheDecisionTable(fx);

    const report = await workItemsService.backfillProvenanceForProject(fx.projectId, fx.ownerId);

    // The target project WAS repaired…
    expect(report.candidates).toBeGreaterThan(0);
    expect((await readDto(target.seedBurst.id, fx)).planningSource).toBe('manual');

    // …and every sibling row is exactly as it was seeded.
    for (const [name, row] of Object.entries(sibling)) {
      const dto = await readDto(row.id, siblingFx);
      const expectedPlanning = name === 'preStamped' ? 'native' : null;
      const expectedImplementation = name === 'preStamped' ? 'byok' : null;
      expect(
        { planningSource: dto.planningSource, implementationSource: dto.implementationSource },
        `sibling-project row ${name} must be untouched`,
      ).toEqual({
        planningSource: expectedPlanning,
        implementationSource: expectedImplementation,
      });
    }
  });
});

describe('the candidate read', () => {
  it('returns the same rows in a CALLER-supplied transaction as in the service’s own', async () => {
    // `findProvenanceBackfillCandidates` takes an optional `tx` so a caller can
    // read and write in one context. The comparison used to be tx-vs-no-tx, and
    // that arm is now DEAD: under `motir_app` the `?? db` fallback binds no
    // `app.workspace_id`, so it answers `[]` and the equality held over two empty
    // arrays — a vacuous pass the `toBeGreaterThan(0)` below was the only guard
    // against (MOTIR-2911; the fallback arm itself is
    // `tests/rls/tx-fallback-arm.test.ts`'s adjudicated subject, not this file's).
    //
    // What is worth asserting instead is the claim the overload actually makes:
    // the read returns the same rows through EITHER bound context — the
    // workspace-only one the service opens (`withWorkspaceServiceContext`, the
    // real caller at workItemsService.backfillProvenanceForProject) and a
    // caller's own user+workspace transaction. Two different GUC sets, one
    // admission decision.
    const fx = await makeWorkItemFixture();
    await seedTheDecisionTable(fx);

    const asTheServiceReadsIt = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findProvenanceBackfillCandidates(fx.projectId, fx.workspaceId, tx),
    );
    const inACallersTransaction = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemRepository.findProvenanceBackfillCandidates(fx.projectId, fx.workspaceId, tx),
    );

    expect(inACallersTransaction).toEqual(asTheServiceReadsIt);
    expect(asTheServiceReadsIt.length).toBeGreaterThan(0);
  });

  it('excludes a row that already carries BOTH sources', async () => {
    const fx = await makeWorkItemFixture();
    await seedRow(fx, {
      title: 'fully stamped',
      createdAt: IN_BURST,
      status: 'done',
      planningSource: 'mcp',
      implementationSource: 'byok',
    });
    const partial = await seedRow(fx, {
      title: 'half stamped',
      createdAt: IN_BURST,
      status: 'done',
      planningSource: 'mcp',
    });

    const candidates = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemRepository.findProvenanceBackfillCandidates(fx.projectId, fx.workspaceId, tx),
    );

    expect(candidates.map((row) => row.id)).toEqual([partial.id]);
  });
});
