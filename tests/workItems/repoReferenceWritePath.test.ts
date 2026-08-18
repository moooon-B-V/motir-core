import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { resolveItemDispatchRepo } from '@/lib/workItems/dispatchRepo';
import {
  ConflictingTargetRepoInputError,
  UnknownProjectRepoRefError,
} from '@/lib/workItems/errors';
import { createWorkItemBodySchema, updateWorkItemBodySchema } from '@/lib/api/v1/workItems/schema';
import { DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// A work item's repositories as REFERENCES, through the real write path, over real
// Postgres (Story MOTIR-2732 · MOTIR-3039, ADR
// `docs/decisions/work-item-repository-set.md` "Amendment 2026-08-18").
//
// The sibling `targetRepoSetWritePath.test.ts` pins the NAME model MOTIR-2727
// shipped; that model is not replaced here, it is DEMOTED to a projection, so both
// files must stay green together. What only a row can answer, and what this file
// therefore owns:
//
//   1. The references ROUND-TRIP through create and update, ordered, with element 0
//      the primary and the names derived from the same resolution.
//   2. A reference to a SIBLING PROJECT's repository row is refused — the check no
//      foreign key can make, because `project_repository.project_id` and
//      `work_item.project_id` are two unrelated columns.
//   3. The MIGRATION's backfill, driven with the migration's OWN SQL read off
//      disk, so the assertion and the shipped statement cannot drift.
//   4. RLS on the new table, proved by DROPPING to `motir_app` — without the role
//      switch every such assertion asserts the opposite of reality.
//   5. DISPATCH is unchanged for every shape of row the migration can leave behind.

const MIGRATION_SQL = path.join(
  process.cwd(),
  'prisma/migrations/20260818140000_work_item_repository_reference/migration.sql',
);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

/** Connect one repository to the fixture's workspace — the 7.10.3 installation
 *  mirror a realized row points at, and the domain the compatibility rung uses. */
async function connectRepo(fx: WorkItemFixture, name: string, defaultBranch = 'main') {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-github` },
    create: {
      installationId: `inst-${fx.workspaceId}-github`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch,
      archived: false,
      provider: 'github',
    },
  });
}

/**
 * Add one row to a project's repository SET.
 *
 * `realized` connects it to a `github_repo` mirror and marks it `connected` — the
 * established state a dispatch can route to. Left unrealized the row stays
 * `proposed`, which is a legal pin target under the reference model and the case
 * the name model could not express at all.
 */
async function addRepoRow(opts: {
  fx: WorkItemFixture;
  projectId?: string;
  name: string;
  role?: 'web' | 'api' | 'mobile' | 'shared' | 'infra' | 'other';
  realized?: boolean;
  defaultBranch?: string;
}): Promise<{ id: string; name: string }> {
  const { fx, name, role = 'other', realized = true } = opts;
  const gh = realized ? await connectRepo(fx, name, opts.defaultBranch ?? 'main') : null;
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: opts.projectId ?? fx.projectId,
      role,
      name,
      seedSource: 'blank',
      state: realized ? 'connected' : 'proposed',
      position: `a${randomToken(4)}`,
      ...(gh ? { githubRepoId: gh.id } : {}),
    },
  });
  return { id: row.id, name: row.name };
}

/** One item's references, in set order, as `{ position, projectRepoId }`. */
async function refs(workItemId: string) {
  return adminDb.workItemRepo.findMany({
    where: { workItemId },
    orderBy: { position: 'asc' },
    select: { position: true, projectRepoId: true },
  });
}

async function names(workItemId: string) {
  const found = await adminDb.workItem.findUnique({
    where: { id: workItemId },
    select: { targetRepo: true, targetRepos: true },
  });
  if (!found) throw new Error(`work item ${workItemId} vanished`);
  return found;
}

describe('the references on the write path — create', () => {
  it('resolves authored NAMES to ordered row references, and derives the names from the same resolution', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core', role: 'web' });
    const ai = await addRepoRow({ fx, name: 'motir-ai', role: 'api', defaultBranch: 'trunk' });

    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'A card that ships in two repositories',
        assigneeId: null,
        descriptionMd: null,
        targetRepos: ['motir-ai', 'motir-core'],
      },
      fx.ctx,
    );

    // Ordered, contiguous from 0, in the author's order — element 0 is the
    // repository dispatch routes to, not "whichever row the join returned first".
    expect(await refs(created.id)).toEqual([
      { position: 0, projectRepoId: ai.id },
      { position: 1, projectRepoId: core.id },
    ]);
    // The names are a PROJECTION of that same resolution, so the two cannot
    // describe different repositories.
    expect(await names(created.id)).toMatchObject({
      targetRepos: ['motir-ai', 'motir-core'],
      targetRepo: 'motir-ai',
    });
  });

  it('accepts the reference-native form — row ids — and resolves the names from the rows', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core', role: 'web' });
    const ai = await addRepoRow({ fx, name: 'motir-ai', role: 'api' });

    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Pinned by row',
        assigneeId: null,
        targetRepositories: [core.id, ai.id],
      },
      fx.ctx,
    );

    expect(await refs(created.id)).toEqual([
      { position: 0, projectRepoId: core.id },
      { position: 1, projectRepoId: ai.id },
    ]);
    expect(await names(created.id)).toMatchObject({
      targetRepos: ['motir-core', 'motir-ai'],
      targetRepo: 'motir-core',
    });
  });

  it('references a PROPOSED row — the pin the name model could not express', async () => {
    // The hinge of the amendment (§A3): a row that names no repository yet is a
    // perfectly good thing to point AT, which is why the role stand-in retires.
    const fx = await makeWorkItemFixture();
    const planned = await addRepoRow({ fx, name: 'acme-api', role: 'api', realized: false });

    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Planned before the repository exists',
        assigneeId: null,
        targetRepositories: [planned.id],
      },
      fx.ctx,
    );

    expect(await refs(created.id)).toEqual([{ position: 0, projectRepoId: planned.id }]);
    // The NAME is the row's authored intent — there is no host casing to prefer
    // yet. Dispatch is UNCHANGED by the reference: a pin still wins over the
    // domain (`resolveDispatchRepo` rung 1), and a proposed row contributes no
    // coordinates, so the answer is the name with `cloneUrl` / `defaultBranch`
    // null — Motir saying "this is where it ships, and I do not know where that
    // is yet" rather than inventing a checkout.
    expect(await names(created.id)).toMatchObject({ targetRepo: 'acme-api' });
    expect(await resolveItemDispatchRepo('acme-api', fx.projectId, fx.ctx)).toEqual({
      name: 'acme-api',
      cloneUrl: null,
      defaultBranch: null,
    });
  });

  it('COLLAPSES a duplicate reference, keeping the first occurrence', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });
    const ai = await addRepoRow({ fx, name: 'motir-ai' });

    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Duplicated',
        assigneeId: null,
        targetRepositories: [core.id, ai.id, core.id],
      },
      fx.ctx,
    );

    expect(await refs(created.id)).toEqual([
      { position: 0, projectRepoId: core.id },
      { position: 1, projectRepoId: ai.id },
    ]);
  });

  it('DROPS blank and null elements rather than reading them as a reference', async () => {
    // The list-semantics half the name path already has (`matchAuthoredTargetRepos`
    // drops a blank element): a list is not the place to discover that "" is a
    // repository. A list of only blanks is the EMPTY set, not an error.
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });

    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Blanks',
        assigneeId: null,
        targetRepositories: ['', core.id, '   '],
      },
      fx.ctx,
    );
    expect(await refs(created.id)).toEqual([{ position: 0, projectRepoId: core.id }]);

    const empty = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Only blanks',
        assigneeId: null,
        targetRepositories: ['', '  '],
      },
      fx.ctx,
    );
    expect(await refs(empty.id)).toEqual([]);
    expect(await names(empty.id)).toMatchObject({ targetRepo: null, targetRepos: [] });
  });

  it("REFUSES a sibling project's repository row — the check no foreign key can make", async () => {
    const fx = await makeWorkItemFixture();
    await addRepoRow({ fx, name: 'motir-core' });
    const otherProject = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Sibling',
        identifier: `SIB${randomToken(3).toUpperCase()}`,
        slug: `sibling-${randomToken(6)}`,
      },
    });
    const foreign = await addRepoRow({
      fx,
      projectId: otherProject.id,
      name: 'sibling-web',
    });

    // The row exists, is in the same WORKSPACE, and satisfies the foreign key
    // perfectly. Only the write layer can see that it is the wrong project's.
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Wrong project',
          assigneeId: null,
          targetRepositories: [foreign.id],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(UnknownProjectRepoRefError);

    // And it wrote nothing — validation is all-or-nothing, exactly as it is for
    // an unknown NAME.
    expect(await adminDb.workItemRepo.count({ where: { projectRepoId: foreign.id } })).toBe(0);
  });

  it('rejects a THIRD repository field beside either of the other two', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });
    const conflicting: Array<{ targetRepo?: string; targetRepos?: string[] }> = [
      { targetRepo: 'motir-core' },
      { targetRepos: ['motir-core'] },
    ];
    for (const extra of conflicting) {
      await expect(
        workItemsService.createWorkItem(
          {
            projectId: fx.projectId,
            kind: 'task',
            title: 'Both forms',
            assigneeId: null,
            targetRepositories: [core.id],
            ...extra,
          },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(ConflictingTargetRepoInputError);
    }
  });

  it('writes NO reference for a project with no repository set — the compatibility rung', async () => {
    // Nothing to point at, so the pin stays a NAME validated against the
    // workspace's connected repos, exactly as it is today.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'legacy-repo');

    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'No set',
        assigneeId: null,
        targetRepo: 'legacy-repo',
      },
      fx.ctx,
    );

    expect(await refs(created.id)).toEqual([]);
    expect(await names(created.id)).toMatchObject({
      targetRepo: 'legacy-repo',
      targetRepos: ['legacy-repo'],
    });
    // And dispatch answers exactly as it did before the table existed.
    expect((await resolveItemDispatchRepo('legacy-repo', fx.projectId, fx.ctx))?.name).toBe(
      'legacy-repo',
    );
  });
});

describe('the references on the write path — update', () => {
  it('REPLACES the set wholesale, and a re-order is a real change', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });
    const ai = await addRepoRow({ fx, name: 'motir-ai' });
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Re-ordered',
        assigneeId: null,
        targetRepositories: [core.id, ai.id],
      },
      fx.ctx,
    );

    await workItemsService.updateWorkItem(
      created.id,
      { targetRepositories: [ai.id, core.id] },
      fx.ctx,
    );

    expect(await refs(created.id)).toEqual([
      { position: 0, projectRepoId: ai.id },
      { position: 1, projectRepoId: core.id },
    ]);
    // The primary MOVED, so dispatch moves with it.
    expect(await names(created.id)).toMatchObject({ targetRepo: 'motir-ai' });
  });

  it('clears the set with `[]`', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Cleared',
        assigneeId: null,
        targetRepositories: [core.id],
      },
      fx.ctx,
    );

    await workItemsService.updateWorkItem(created.id, { targetRepositories: [] }, fx.ctx);

    expect(await refs(created.id)).toEqual([]);
    expect(await names(created.id)).toMatchObject({ targetRepo: null, targetRepos: [] });
  });

  it('MIGRATES a name-only card onto a reference when the project gains a set — the case an empty diff hides', async () => {
    // The card is written while the project has no set, so it holds a NAME and no
    // reference. The set arrives later; re-sending the SAME name now resolves to a
    // row for the first time. The revision diff is legitimately empty — the names
    // did not change — and gating the reference write on it would silently drop
    // exactly this write.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Named first',
        assigneeId: null,
        targetRepo: 'motir-core',
      },
      fx.ctx,
    );
    expect(await refs(created.id)).toEqual([]);

    const core = await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'web',
        name: 'motir-core',
        seedSource: 'blank',
        state: 'connected',
        position: 'a0',
        githubRepoId: (
          await adminDb.githubRepo.findFirstOrThrow({
            where: { workspaceId: fx.workspaceId, name: 'motir-core' },
          })
        ).id,
      },
    });

    await workItemsService.updateWorkItem(created.id, { targetRepo: 'motir-core' }, fx.ctx);

    expect(await refs(created.id)).toEqual([{ position: 0, projectRepoId: core.id }]);
    expect(await names(created.id)).toMatchObject({ targetRepo: 'motir-core' });
  });
});

describe('the MIGRATION backfill', () => {
  /** The backfill statements, read from the shipped migration so this assertion
   *  and the statement that runs in production cannot drift. */
  function backfillStatements(): string[] {
    const sql = readFileSync(MIGRATION_SQL, 'utf8');
    return (
      sql
        .split(/;\s*\n/)
        // Each statement is preceded by its own comment block; strip the leading
        // `--` lines so what is left is the SQL the database actually runs.
        .map((chunk) =>
          chunk
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('--'))
            .join('\n')
            .trim(),
        )
        .filter((s) => s.startsWith('WITH') && s.includes('INSERT INTO "work_item_repository"'))
        .map((s) => `${s};`)
    );
  }

  it('reads TWO backfill passes off the shipped migration', () => {
    expect(backfillStatements()).toHaveLength(2);
  });

  it('resolves names to rows, recovers a role-only pin, and leaves an unresolvable string alone', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core', role: 'web' });
    const ai = await addRepoRow({ fx, name: 'motir-ai', role: 'api' });

    // Three legacy shapes, written straight to the columns so the backfill is the
    // only thing that has ever touched the join table for them.
    const seed = async (patch: Prisma.WorkItemUncheckedUpdateInput, title: string) => {
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title, assigneeId: null },
        fx.ctx,
      );
      await adminDb.workItem.update({ where: { id: item.id }, data: patch });
      await adminDb.workItemRepo.deleteMany({ where: { workItemId: item.id } });
      return item.id;
    };

    const named = await seed(
      { targetRepo: 'motir-ai', targetRepos: ['motir-ai', 'motir-core'] },
      'Two names',
    );
    const roleOnly = await seed(
      { targetRepo: null, targetRepos: [], targetRepoRole: 'api' },
      'Role only',
    );
    const unresolvable = await seed(
      { targetRepo: 'not-in-this-project', targetRepos: ['not-in-this-project'] },
      'Unresolvable',
    );

    for (const statement of backfillStatements()) {
      await adminDb.$executeRawUnsafe(statement);
    }

    // Pass 1 — names, in the stored order.
    expect(await refs(named)).toEqual([
      { position: 0, projectRepoId: ai.id },
      { position: 1, projectRepoId: core.id },
    ]);
    // Pass 2 — the role, resolved to the single row carrying it. This is the item
    // the NAME model had to leave unrouted until a background pass ran.
    expect(await refs(roleOnly)).toEqual([{ position: 0, projectRepoId: ai.id }]);
    // A string that resolves to no row of this project is a FINDING, not a
    // no-op: no reference is invented, and the column keeps its value so the card
    // dispatches exactly as it did.
    expect(await refs(unresolvable)).toEqual([]);
    expect(await names(unresolvable)).toMatchObject({ targetRepo: 'not-in-this-project' });
  });

  it('does NOT resolve an AMBIGUOUS role — two rows share it, so there is nothing to pick', async () => {
    // ADR `project-repository-set.md` §5.3: an ambiguous role resolves to nothing
    // rather than to an arbitrary row, counted over rows in ANY state so the
    // verdict is a property of the SET and not of run order.
    const fx = await makeWorkItemFixture();
    await addRepoRow({ fx, name: 'billing-api', role: 'api' });
    await addRepoRow({ fx, name: 'search-api', role: 'api', realized: false });

    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ambiguous role', assigneeId: null },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { targetRepo: null, targetRepos: [], targetRepoRole: 'api' },
    });
    await adminDb.workItemRepo.deleteMany({ where: { workItemId: item.id } });

    for (const statement of backfillStatements()) {
      await adminDb.$executeRawUnsafe(statement);
    }

    expect(await refs(item.id)).toEqual([]);
  });
});

describe('RLS on work_item_repository', () => {
  /** Drop to the non-BYPASSRLS app role with the workspace GUC bound — without
   *  this switch every assertion below asserts the OPPOSITE of reality. */
  async function asAppRole<T>(
    ctx: { userId?: string; workspaceId?: string },
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      if (ctx.userId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
      }
      if (ctx.workspaceId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
      }
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx);
    });
  }

  it("hides another workspace's references, and refuses to write one", async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A' });
    const b = await makeWorkItemFixture({ name: 'Tenant B' });
    const aRepo = await addRepoRow({ fx: a, name: 'a-web' });
    const bRepo = await addRepoRow({ fx: b, name: 'b-web' });

    const aItem = await workItemsService.createWorkItem(
      {
        projectId: a.projectId,
        kind: 'task',
        title: "A's",
        assigneeId: null,
        targetRepositories: [aRepo.id],
      },
      a.ctx,
    );
    const bItem = await workItemsService.createWorkItem(
      {
        projectId: b.projectId,
        kind: 'task',
        title: "B's",
        assigneeId: null,
        targetRepositories: [bRepo.id],
      },
      b.ctx,
    );

    // SELECT under A's GUC sees A's row and not B's (USING).
    const seen = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.workItemRepo.findMany({ select: { workItemId: true } }),
    );
    expect(seen.map((r) => r.workItemId)).toEqual([aItem.id]);
    expect(seen.map((r) => r.workItemId)).not.toContain(bItem.id);

    // DELETE of B's row under A's GUC matches nothing.
    const deleted = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.workItemRepo.deleteMany({ where: { workItemId: bItem.id } }),
    );
    expect(deleted.count).toBe(0);

    // INSERT tagged with B's workspace under A's GUC violates WITH CHECK (42501).
    await expect(
      asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
        tx.workItemRepo.create({
          data: {
            workspaceId: b.workspaceId,
            workItemId: bItem.id,
            projectRepoId: bRepo.id,
            position: 5,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('dispatch is unchanged', () => {
  it('answers identically for a pinned, an unpinned and a role-only card', async () => {
    const fx = await makeWorkItemFixture();
    await addRepoRow({ fx, name: 'motir-core', role: 'web' });
    await addRepoRow({ fx, name: 'motir-ai', role: 'api', defaultBranch: 'trunk' });

    // Pinned — the primary's resolved name, with its coordinates.
    const pinned = await resolveItemDispatchRepo('motir-ai', fx.projectId, fx.ctx);
    expect(pinned).toMatchObject({ name: 'motir-ai', defaultBranch: 'trunk' });

    // Unpinned with TWO established repositories — still `null`, still a refusal
    // to guess, which is the property the whole attribution model rests on.
    expect(await resolveItemDispatchRepo(null, fx.projectId, fx.ctx)).toBeNull();

    // A role-only card has no NAME to resolve, so dispatch answered `null` before
    // this change and answers `null` after it. The reference is what a later card
    // reads; `resolveDispatchRepo` still takes the pin.
    expect(await resolveItemDispatchRepo(null, fx.projectId, fx.ctx)).toBeNull();
  });
});

describe('the two WRITE SURFACES refuse a foreign reference the same way', () => {
  it('/api/v1 accepts the field and maps the typed error to 422', async () => {
    // The surface half of the service assertion above. Two things can break
    // independently and neither is visible from the other: the request schema is
    // `.strict()`, so an unlisted field is a 422 for the WRONG reason; and the
    // status map is keyed by `code`, so a new typed error with no row escapes as
    // an opaque 500.
    expect(
      createWorkItemBodySchema.safeParse({
        kind: 'task',
        title: 'Pinned by row',
        targetRepositories: ['some-row-id'],
      }).success,
    ).toBe(true);
    expect(updateWorkItemBodySchema.safeParse({ targetRepositories: [] }).success).toBe(true);
    // Still exactly one of the three — the schema admits all of them, and the
    // service is what refuses two.
    expect(
      createWorkItemBodySchema.safeParse({
        kind: 'task',
        title: 'Both',
        targetRepo: 'motir-core',
        targetRepositories: ['some-row-id'],
      }).success,
    ).toBe(true);
    expect(DOMAIN_ERROR_STATUS.UNKNOWN_PROJECT_REPO_REF).toBe(422);
    expect(DOMAIN_ERROR_STATUS.CONFLICTING_TARGET_REPO_INPUT).toBe(422);
  });

  it('the MCP tool returns a SELF-CORRECTABLE error naming the project rows, not an opaque failure', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });
    const otherProject = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Sibling',
        identifier: `SIB${randomToken(3).toUpperCase()}`,
        slug: `sibling-${randomToken(6)}`,
      },
    });
    const foreign = await addRepoRow({ fx, projectId: otherProject.id, name: 'sibling-web' });

    const result = await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        kind: 'task',
        title: 'Wrong project, over MCP',
        targetRepositories: [foreign.id],
      },
      fx.ctx,
    );

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('UNKNOWN_PROJECT_REPO_REF');
    // The message lists what IS pinnable, as `id (name)`, so an agent
    // self-corrects in one hop instead of guessing — the same contract the name
    // error has carried since MOTIR-1804.
    expect(text).toContain(core.id);
    expect(text).toContain('motir-core');
  });

  it('the MCP tool WRITES the references on the happy path', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });
    const ai = await addRepoRow({ fx, name: 'motir-ai' });

    const created = await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        kind: 'task',
        title: 'Pinned by row, over MCP',
        targetRepositories: [ai.id, core.id],
      },
      fx.ctx,
    );
    expect(created.isError).toBeFalsy();

    const item = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Pinned by row, over MCP' },
    });
    expect(await refs(item.id)).toEqual([
      { position: 0, projectRepoId: ai.id },
      { position: 1, projectRepoId: core.id },
    ]);
    expect(item.targetRepo).toBe('motir-ai');
  });
});

describe('workItemRepoRepository — the batched reads the later cards consume', () => {
  it('lists several items’ references in one call, grouped and ordered', async () => {
    // The rollup (MOTIR-2978) and the read seams (MOTIR-3041) both need a LIST's
    // worth of references without N round trips, so the ordering contract —
    // grouped by item, ascending by position — is asserted here where it is
    // written rather than in each consumer.
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });
    const ai = await addRepoRow({ fx, name: 'motir-ai' });
    const one = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'One',
        assigneeId: null,
        targetRepositories: [ai.id, core.id],
      },
      fx.ctx,
    );
    const two = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Two',
        assigneeId: null,
        targetRepositories: [core.id],
      },
      fx.ctx,
    );

    // Read INSIDE a workspace context — the repository uses the RLS-bound client,
    // so a read with no `app.workspace_id` bound legitimately returns nothing.
    const rows = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) => workItemRepoRepository.listByWorkItems([one.id, two.id], tx),
    );
    expect(rows.filter((r) => r.workItemId === one.id).map((r) => r.projectRepoId)).toEqual([
      ai.id,
      core.id,
    ]);
    expect(rows.filter((r) => r.workItemId === two.id).map((r) => r.projectRepoId)).toEqual([
      core.id,
    ]);
    // The join comes back with it, so a name resolves without a second query.
    expect(rows[0]?.projectRepo.name).toBe('motir-ai');

    // An empty request is a no-op, not a query with an empty `IN` list.
    expect(
      await withWorkspaceContext(
        { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
        (tx) => workItemRepoRepository.listByWorkItems([], tx),
      ),
    ).toEqual([]);
  });

  it('lists every reference to ONE repository row — what a rename or a removal has to sweep', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow({ fx, name: 'motir-core' });
    const ai = await addRepoRow({ fx, name: 'motir-ai' });
    const one = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'One',
        assigneeId: null,
        targetRepositories: [core.id],
      },
      fx.ctx,
    );
    const two = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Two',
        assigneeId: null,
        targetRepositories: [core.id, ai.id],
      },
      fx.ctx,
    );

    const pointing = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) => workItemRepoRepository.listByProjectRepo(core.id, tx),
    );
    expect(new Set(pointing.map((r) => r.workItemId))).toEqual(new Set([one.id, two.id]));

    // Deleting the row CASCADES the references away — the project no longer has
    // that repository, so a card cannot go on referring to it. `Restrict` would
    // make the set uneditable, which ADR project-repository-set §4.4 forbids.
    await adminDb.projectRepo.delete({ where: { id: core.id } });
    expect(
      await withWorkspaceContext(
        { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
        (tx) => workItemRepoRepository.listByProjectRepo(core.id, tx),
      ),
    ).toEqual([]);
    expect(await refs(two.id)).toEqual([{ position: 1, projectRepoId: ai.id }]);
  });
});
