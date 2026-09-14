import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@/generated/prisma/client';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';

// MOTIR-5507 — the story gate for PHASE 2 of `Workspace.subtaskPrMergeMode`'s
// retirement (Story MOTIR-5175 · `docs/decisions/delivery-reader-migration.md` §6b).
//
// ─── WHAT THIS FILE HOLDS, AND WHY A STATIC CHECK CANNOT ─────────────────────
//
// Phase 2 (MOTIR-5505) put `@ignore` on the field so the generated client stops
// SELECTING the column while the column stays. A green typecheck proves no code
// NAMES the field; it says nothing about which columns a query sends. A read with
// no explicit `select` — `workspaceRepository.findById`, or a bare
// `include: { workspace: true }` — emits every scalar the MODEL declares, so the
// column list is a property of the datamodel and of no line of source. That is
// what 500-ed `get_work_item` tenant-wide in MOTIR-3852, when the declaration and
// the `DROP COLUMN` landed in one release.
//
// So the assertions are query-level: every `Workspace` read site is driven through
// a client with query logging on, and the SQL it EMITS is read. Each capture
// carries a POSITIVE half (the projection still names a column the read really
// returns) so it cannot pass by capturing nothing, and the capture helper is shown
// to catch the column when a statement does name it.
//
// The precedent is `tests/github/checkRunFeedbackColumnRetired.test.ts`, which
// MOTIR-3803 deleted with its column; its capture mechanism is reused unchanged.
//
// ─── THE SITES, AND WHAT IS NOT DRIVEN ───────────────────────────────────────
//
// Enumerated on `origin/main` `cc09db183` with `git grep` over `lib app components
// scripts` for `.workspace.<op>(`, `workspace: true` and `workspace: {`. Driven
// below: all nine `workspaceRepository` methods that touch the model, the three bare
// `include: { workspace: true }` reads in `workspaceMembershipRepository`, and the
// nested `workspace: { include: { organization: true } }` scope include
// `apiTokenRepository` shares across `findByUser` / `findByIdForUser` / `create`.
// NOT driven, each with its reason:
//   • `projectRepository.findWorkspaceNameForPublic` reads through the `db`
//     singleton and takes no client, so its SQL cannot be captured here. Its
//     projection is the explicit `select: { name: true }`, and a field absent from
//     the generated types cannot be named in a `select` without failing typecheck.
//   • `scripts/seed-large.ts`, `scripts/seedCollabFixture.ts` and
//     `scripts/seedReportingFixture.ts` are dev fixture scripts that never run in a
//     deployed image, so they cannot be the still-serving reader phase 3 is about.
//
// ⚠️ PHASE 3 (MOTIR-5508) INVERTS the column-still-exists assertion below to
// column-ABSENT when it drops the column — flip it, do not delete it. The
// emitted-SQL half then has nothing left to guard and goes with it.
//
// No DDL here: dropping the column in the shared test database to simulate phase 3
// would take a table lock every concurrent shard contends on, and the property is
// fully observable from the emitted SQL.

const COLUMN = 'subtaskPrMergeMode';

let client: PrismaClient;
const queries: string[] = [];

/** A client with query logging on. It is a SEPARATE `PrismaClient` because
 *  `lib/db.ts` and `helpers/adminDb.ts` are both constructed without the `log`
 *  option, and a client's logging is fixed at construction. Same worker database,
 *  admin role, so RLS does not narrow what the reads reach. */
beforeAll(() => {
  client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: currentWorkerAdminUrl() }),
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query' as never, ((e: { query: string }) => queries.push(e.query)) as never);
});

afterAll(async () => {
  await client.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  queries.length = 0;
});

/** The logging client, typed as the transaction client every repository leaf takes. */
function tx(): Prisma.TransactionClient {
  return client as unknown as Prisma.TransactionClient;
}

/** Run `read` and return ONLY the statements it emitted that touch `workspace`. */
async function workspaceStatements(read: () => Promise<unknown>): Promise<string[]> {
  queries.length = 0;
  await read();
  return queries.filter((q) => q.includes('"workspace"'));
}

/** The capture is real (it fired, and names `positive`), and no statement names the column. */
function expectProjectionWithoutColumn(statements: string[], positive: string): void {
  expect(statements.length, 'the read emitted no statement over "workspace"').toBeGreaterThan(0);
  expect(
    statements.some((q) => q.includes(`"${positive}"`)),
    `no captured statement names "${positive}" — the capture may have captured nothing`,
  ).toBe(true);
  expect(statements.filter((q) => q.includes(COLUMN))).toEqual([]);
}

let seq = 0;

async function seedTenant() {
  const n = seq++;
  const user = await createTestUser();
  const org = await adminDb.organization.create({
    data: { name: `Org ${n}`, slug: `wsmm-org-${n}-${Date.now()}` },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS ${n}`, slug: `wsmm-ws-${n}-${Date.now()}`, organizationId: org.id },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: workspace.id, role: 'owner' },
  });
  return { user, org, workspace };
}

describe('workspaceRepository — every select-less read emits the projection without the column', () => {
  it('findById · findBySlug · findByIdInTx', async () => {
    const { workspace } = await seedTenant();
    for (const read of [
      () => workspaceRepository.findById(workspace.id, tx()),
      () => workspaceRepository.findBySlug(workspace.slug, tx()),
      () => workspaceRepository.findByIdInTx(workspace.id, tx()),
    ]) {
      expectProjectionWithoutColumn(await workspaceStatements(read), 'slug');
    }
  });

  it('listByOrganization', async () => {
    const { org } = await seedTenant();
    const statements = await workspaceStatements(() =>
      workspaceRepository.listByOrganization(org.id, tx()),
    );
    expectProjectionWithoutColumn(statements, 'slug');
  });

  it('create · update · delete — the RETURNING projection is the model’s too', async () => {
    const { org } = await seedTenant();
    let createdId = '';
    const created = await workspaceStatements(async () => {
      createdId = (
        await workspaceRepository.create(
          { name: 'Made here', slug: `wsmm-made-${Date.now()}`, organizationId: org.id },
          tx(),
        )
      ).id;
    });
    expectProjectionWithoutColumn(created, 'slug');

    // The column keeps its database default, so an insert that omits it still
    // writes a legal row — read back in raw SQL, the only way to name it now.
    const [row] = await adminDb.$queryRaw<{ mode: string }[]>`
      SELECT "subtaskPrMergeMode"::text AS mode FROM workspace WHERE id = ${createdId}`;
    expect(row?.mode).toBe('manual');

    expectProjectionWithoutColumn(
      await workspaceStatements(() =>
        workspaceRepository.update(createdId, { name: 'Renamed' }, tx()),
      ),
      'slug',
    );
    expectProjectionWithoutColumn(
      await workspaceStatements(() => workspaceRepository.delete(createdId, tx())),
      'slug',
    );
  });

  it('findOrganizationId · countByOrganization — the explicit-select reads name only what they ask for', async () => {
    const { workspace, org } = await seedTenant();
    expectProjectionWithoutColumn(
      await workspaceStatements(() => workspaceRepository.findOrganizationId(workspace.id, tx())),
      'organizationId',
    );
    expectProjectionWithoutColumn(
      await workspaceStatements(() => workspaceRepository.countByOrganization(org.id, tx())),
      'organizationId',
    );
  });
});

describe('a relation include reaches the same columns without naming the model', () => {
  it('workspaceMembershipRepository — the three bare `include: { workspace: true }` reads', async () => {
    const { user, workspace } = await seedTenant();
    for (const read of [
      () => workspaceMembershipRepository.findWorkspacesByUser(user.id, tx()),
      () => workspaceMembershipRepository.findFirstByUserWithWorkspace(user.id, tx()),
      () =>
        workspaceMembershipRepository.findByUserAndWorkspaceWithWorkspace(
          user.id,
          workspace.id,
          tx(),
        ),
    ]) {
      expectProjectionWithoutColumn(await workspaceStatements(read), 'slug');
    }
  });

  it('apiTokenRepository — the nested `workspace: { include: { organization: true } }` scope include', async () => {
    const { user, workspace } = await seedTenant();
    let tokenId = '';
    const created = await workspaceStatements(async () => {
      tokenId = (
        await apiTokenRepository.create(
          {
            userId: user.id,
            workspaceId: workspace.id,
            label: 'gate',
            tokenHash: `wsmm-hash-${Date.now()}-${seq++}`,
            tokenPrefix: 'mtr_wsmm',
            expiresAt: null,
            scopes: [],
            projectId: null,
          },
          tx(),
        )
      ).id;
    });
    expectProjectionWithoutColumn(created, 'slug');
    expectProjectionWithoutColumn(
      await workspaceStatements(() => apiTokenRepository.findByUser(user.id, tx())),
      'slug',
    );
    expectProjectionWithoutColumn(
      await workspaceStatements(() => apiTokenRepository.findByIdForUser(tokenId, user.id, tx())),
      'slug',
    );
  });
});

describe('the capture helper CAN see the column — so the absences above are evidence', () => {
  it('a statement that names the column is caught by the same capture', async () => {
    const { workspace } = await seedTenant();
    const statements = await workspaceStatements(
      () =>
        client.$queryRaw`SELECT "subtaskPrMergeMode" FROM "workspace" WHERE id = ${workspace.id}`,
    );
    expect(statements.filter((q) => q.includes(COLUMN))).toHaveLength(1);
  });
});

describe('phase 2’s two-sided state — out of the client, still in the database', () => {
  it('the generated client’s Workspace scalar-field enum has no member for the field', () => {
    expect(Object.keys(Prisma.WorkspaceScalarFieldEnum)).not.toContain(COLUMN);
    // Positive half: the enum is the real one, not an empty object.
    expect(Object.keys(Prisma.WorkspaceScalarFieldEnum)).toEqual(
      expect.arrayContaining(['id', 'slug', 'organizationId']),
    );
  });

  it('information_schema still reports the column on workspace', async () => {
    // ⚠️ PHASE 3 (MOTIR-5508) flips this to `toEqual([])` in the commit that
    // drops the column. Raw SQL, necessarily: the field is `@ignore`d.
    const rows = await adminDb.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workspace'
        AND column_name = ${COLUMN}
    `;
    expect(rows).toEqual([{ column_name: COLUMN }]);
  });
});
