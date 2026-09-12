import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveAliasedIssueKey } from '@/lib/issues/aliasRedirect';
import {
  IdentifierReservedError,
  IdentifierTakenError,
  IdentifierUnchangedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story-closing integration journey for Story 6.8 (Subtask 6.8.5; Principle #18 —
// review at the Story level). The per-Subtask suites already prove each MATRIX in
// isolation, each on a freshly-truncated DB:
//
//   * the rename transaction — atomicity, the one-statement bulk rewrite, the
//     fault-injected rollback, the collision matrix, reclaim, release, and the
//     rename∥issue-create race — in `tests/project-details-service.test.ts` (6.8.1);
//   * alias-aware resolution — serve / 308-redirect / 404 / chained-flat, plus the
//     route-backing services — in `tests/project-alias-resolution.test.ts` (6.8.2).
//
// This spec does NOT re-assert those isolated matrices. It proves the two things a
// per-Subtask suite structurally cannot:
//
//   1. **The recipe as ONE continuous lifecycle on ONE project** — rename → avatar
//      → key-change → old-key serve + issue 308-redirect → reclaim (revert) →
//      release → old links 404. The unit suites reset state between every `it`; the
//      Story's verification recipe is a SEQUENCE where each step inherits the prior
//      step's state (e.g. "reclaim" only means anything AFTER a change created the
//      alias, and "release breaks the links" only after they were redirecting). This
//      asserts the steps compose — the seam the recipe is actually about.
//   2. **The rename ∥ rename race** — the one concurrency interleaving the 6.8.1
//      suite leaves uncovered (it has rename∥create, not rename∥rename): two admins
//      renaming the same project to the SAME key concurrently → exactly one wins, the
//      other gets a typed conflict (never two aliases, never a half-applied state).
//
// Real Postgres, no DB mocks (CLAUDE.md). The truncate helper CASCADEs workspace →
// project → work_item / project_key_alias between tests.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

// An owner + workspace + project keyed PROD. The owner is the workspace OWNER, so
// they manage the project via the workspace-manager tier (no project membership).
async function makeFixture(slug: string, identifier = 'PROD') {
  const owner = await makeUser(`owner-${slug}@example.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
    identifier,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  return { owner, workspace, project, ownerCtx };
}

async function seedItems(projectId: string, ctx: WorkspaceContext, n: number) {
  const items: { identifier: string; key: number }[] = [];
  for (let i = 0; i < n; i++) {
    const dto = await workItemsService.createWorkItem(
      { projectId, kind: 'task', title: `Item ${i}` },
      ctx,
    );
    items.push({ identifier: dto.identifier, key: dto.key });
  }
  return items;
}

/**
 * Every issue identifier in the project, sorted.
 *
 * ⚠️ This INCLUDES the project's seeded bug container (MOTIR-4935), which holds
 * the first key — so a project with N seeded items reports N+1 identifiers, and
 * the container is `<KEY>-1`. That is deliberate rather than tolerated: the
 * container is an ordinary work item, so a key change MUST re-key it too, and
 * asserting the full list is what proves the rewrite missed nothing.
 */
async function identifiersOf(projectId: string): Promise<string[]> {
  const rows = await adminDb.workItem.findMany({
    where: { projectId },
    select: { identifier: true },
  });
  return rows.map((r) => r.identifier).sort();
}

// A race assertion is only worth what its FAILURE says. `expected false to be
// true` discards the one fact that separates a benign interleaving from a broken
// lock — WHICH error rejected — so every tolerance below names its reason.
function describeRejection(reason: unknown): string {
  if (reason instanceof Error) return `${reason.constructor.name}: ${reason.message}`;
  return String(reason);
}

describe('Story 6.8 — the project-details lifecycle, composed on one project', () => {
  it('walks the full verification recipe end to end (rename → key change → redirect → reclaim → release)', async () => {
    const { project, ownerCtx } = await makeFixture('lifecycle');
    const [one, two] = await seedItems(project.id, ownerCtx, 2);
    // PROD-1 is the seeded bug container, so the items this test drives start
    // at PROD-2 (see `identifiersOf`).
    expect(one?.identifier).toBe('PROD-2');
    expect(two?.identifier).toBe('PROD-3');

    // ── 1. Rename (the batched updateDetails path) ───────────────────────────
    // This step also set a preset avatar until MOTIR-2680 dropped that pair; the
    // mark is an uploaded image now, and it has its own coverage in
    // `project-details-service.test.ts` (the own-project gate + the post-commit
    // blob collection) rather than riding along here. What this journey is for
    // is the KEY CHANGE, and the rename is its lead-in.
    const renamed = await projectsService.updateDetails({
      key: 'PROD',
      name: '  Lifecycle Renamed  ',
      ctx: ownerCtx,
    });
    expect(renamed.name).toBe('Lifecycle Renamed'); // trimmed
    expect(renamed.identifier).toBe('PROD'); // a rename does NOT touch the key

    // ── 2. Change the key PROD → NIF (the atomic rewrite) ────────────────────
    const moved = await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    expect(moved.identifier).toBe('NIF');
    expect(moved.previousKeys).toEqual([{ identifier: 'PROD', retiredAt: expect.any(String) }]);
    // Every issue re-keyed, numbers preserved; the name survives the change.
    // The container (NIF-1) is re-keyed with the rest — it is not exempt.
    expect(await identifiersOf(project.id)).toEqual(['NIF-1', 'NIF-2', 'NIF-3']);
    expect(moved.name).toBe('Lifecycle Renamed');

    // ── 3. The old key still SERVES (REST shape) and issue links REDIRECT ────
    const served = await projectsService.getByKey('PROD', ownerCtx); // no throw, canonical DTO
    expect(served.identifier).toBe('NIF');
    expect(await resolveAliasedIssueKey('PROD-1', ownerCtx)).toBe('NIF-1'); // 308 target
    expect(await resolveAliasedIssueKey('NIF-1', ownerCtx)).toBeNull(); // live key → no redirect

    // ── 4. Reclaim the OWN previous key (the revert path): NIF → PROD ────────
    const reverted = await projectsService.changeKey({ key: 'NIF', newKey: 'PROD', ctx: ownerCtx });
    expect(reverted.identifier).toBe('PROD');
    // PROD's alias was consumed (reclaimed); NIF is now the retired key.
    expect(reverted.previousKeys).toEqual([{ identifier: 'NIF', retiredAt: expect.any(String) }]);
    expect(await identifiersOf(project.id)).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
    // Old NIF links now redirect to the canonical PROD; the reclaimed PROD is live.
    expect(await resolveAliasedIssueKey('NIF-1', ownerCtx)).toBe('PROD-1');
    expect(await resolveAliasedIssueKey('PROD-1', ownerCtx)).toBeNull();

    // ── 5. Release the NIF alias → it un-reserves and BREAKS its old links ───
    const released = await projectsService.releaseAlias({
      key: 'PROD',
      alias: 'NIF',
      ctx: ownerCtx,
    });
    expect(released.previousKeys).toEqual([]);
    // The freed key now 404s as an issue prefix and as a project lookup.
    expect(await resolveAliasedIssueKey('NIF-1', ownerCtx)).toBeNull();
    await expect(projectsService.resolveByKey('NIF', ownerCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});

describe('Story 6.8 — concurrent renames serialise on the project-row lock', () => {
  it('two renames to the SAME key: exactly one wins, the other gets a typed conflict', async () => {
    const { project, ownerCtx } = await makeFixture('race-rr');
    await seedItems(project.id, ownerCtx, 2);

    // Two admins fire PROD→NIF at the same instant. The FOR-UPDATE lock serialises
    // them: the loser re-reads the now-NIF key under the lock and bails with a typed
    // conflict (UNCHANGED — the project is already NIF — or, depending on which guard
    // it reaches first, TAKEN/RESERVED). Never two winners, never two aliases.
    const results = await Promise.allSettled([
      projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx }),
      projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser's error is a TYPED domain error, never a raw DB error. Which one
    // depends on the interleaving (all are correct, non-corrupting outcomes):
    //   • re-reads the now-NIF key under the lock → IdentifierUnchangedError;
    //   • slips past the pre-checks on a stale snapshot and trips the unique
    //     constraint → translated to IdentifierTakenError (the changeKey P2002
    //     backstop) — never a raw P2002;
    //   • resolves AFTER the winner commits, when PROD is already an alias →
    //     ProjectNotFoundError (the resolve path is deliberately not alias-aware).
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(
      reason instanceof IdentifierUnchangedError ||
        reason instanceof IdentifierTakenError ||
        reason instanceof IdentifierReservedError ||
        reason instanceof ProjectNotFoundError,
    ).toBe(true);

    // The end state is single-valued: NIF is live, exactly ONE PROD alias exists,
    // and every issue is on the canonical NIF prefix.
    const finalProject = await projectsService.getByKey('NIF', ownerCtx);
    expect(finalProject.identifier).toBe('NIF');
    const projectKeyAliasCount = await adminDb.projectKeyAlias.count({
      where: { projectId: project.id },
    });
    expect(projectKeyAliasCount).toBe(1);
    expect(await identifiersOf(project.id)).toEqual(['NIF-1', 'NIF-2', 'NIF-3']);
  });

  it('two renames to DIFFERENT keys: both apply, or the loser loses TYPED — the end state is single-valued either way', async () => {
    const { project, ownerCtx } = await makeFixture('race-rr-diff');
    await seedItems(project.id, ownerCtx, 1);

    // PROD→NIF and PROD→ZAP concurrently. Whichever grabs the lock first renames.
    // The second has TWO legitimate fates, decided by where its resolve landed
    // relative to the winner's COMMIT:
    //   • resolve BEFORE the commit → it already holds the project, blocks on the
    //     FOR-UPDATE lock, re-reads the now-renamed key and renames again — both
    //     apply, serialised, with no lost update;
    //   • resolve AFTER the commit → PROD is already an ALIAS, and changeKey's
    //     resolve is deliberately NOT alias-aware (`resolveProjectByKeyInTx`:
    //     "alias-aware resolution is Subtask 6.8.2's job, not the admin write
    //     path's") — so it rejects with a typed ProjectNotFoundError.
    // This test used to assert `.every(fulfilled)`, i.e. only the first fate — a
    // guarantee the service has never made. It is the SAME loss mode `6ea8b7ada`
    // named when it de-flaked the SAME-key sibling above and left standing here,
    // and it evicted a merge-queue entry on an unrelated diff (MOTIR-5156).
    const results = await Promise.allSettled([
      projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx }),
      projectsService.changeKey({ key: 'PROD', newKey: 'ZAP', ctx: ownerCtx }),
    ]);

    // At MOST one may lose — two losers would mean the winner's write vanished.
    const rejectedReasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as unknown);
    expect(
      rejectedReasons.length,
      `at most one rename may lose; got ${rejectedReasons.length}: ${rejectedReasons
        .map(describeRejection)
        .join(' | ')}`,
    ).toBeLessThanOrEqual(1);
    // A loss is a TYPED domain error, never a raw DB error — and the message names
    // WHICH, so a future red tells the benign interleaving from a lock regression:
    //   • ProjectNotFoundError — the resolve landed after the winner's commit;
    //   • IdentifierTakenError — the changeKey P2002 backstop (never a raw P2002).
    for (const reason of rejectedReasons) {
      expect(
        reason instanceof ProjectNotFoundError || reason instanceof IdentifierTakenError,
        `the losing rename must fail with a typed rename conflict, got ${describeRejection(reason)}`,
      ).toBe(true);
    }
    const bothApplied = rejectedReasons.length === 0;

    // The end state is single-valued whichever way the race went: ONE live key, a
    // clean alias chain, every work item on the canonical prefix.
    const fresh = await projectsService.resolveByKey('PROD', ownerCtx);
    expect(fresh.viaAlias).toBe(true);
    const finalKey = fresh.project.identifier;
    expect(['NIF', 'ZAP']).toContain(finalKey);

    const otherTarget = finalKey === 'NIF' ? 'ZAP' : 'NIF';
    if (bothApplied) {
      // Both applied: PROD and the intermediate target are both retired keys that
      // resolve FLAT to the final key — no alias-to-alias chain.
      const r = await projectsService.resolveByKey(otherTarget, ownerCtx);
      expect(r.viaAlias, `${otherTarget} should be a retired key resolving to ${finalKey}`).toBe(
        true,
      );
      expect(r.project.identifier).toBe(finalKey);
    } else {
      // Only the winner applied: the loser rolled back, so its target was never
      // assigned and is neither a live key nor an alias.
      await expect(projectsService.resolveByKey(otherTarget, ownerCtx)).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
    }
    // Exactly one alias row per rename that actually applied — never a half-applied
    // state, and never a duplicate PROD alias.
    const projectKeyAliasCount = await adminDb.projectKeyAlias.count({
      where: { projectId: project.id },
    });
    expect(
      projectKeyAliasCount,
      `final key ${finalKey}; ${bothApplied ? 'both renames applied' : 'one rename applied'}`,
    ).toBe(bothApplied ? 2 : 1);
    expect(await identifiersOf(project.id)).toEqual([`${finalKey}-1`, `${finalKey}-2`]);
  });

  it('the tolerated loss mode, driven deterministically: a rename whose resolve lands AFTER the winner commits rejects ProjectNotFoundError', async () => {
    const { project, ownerCtx } = await makeFixture('race-rr-after');
    await seedItems(project.id, ownerCtx, 1);

    // The race above TOLERATES this outcome; this proves it is the outcome the
    // service actually produces, with no interleaving to depend on. Sequencing the
    // two renames IS the losing interleaving — the second call resolves PROD when
    // PROD has already become an alias — so the tolerance above is a tested claim
    // rather than a widened assertion nobody can exercise.
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    await expect(
      projectsService.changeKey({ key: 'PROD', newKey: 'ZAP', ctx: ownerCtx }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // And the loser changed NOTHING: NIF is still live, ZAP was never assigned,
    // and the single PROD alias still resolves flat.
    const fresh = await projectsService.resolveByKey('PROD', ownerCtx);
    expect(fresh.viaAlias).toBe(true);
    expect(fresh.project.identifier).toBe('NIF');
    await expect(projectsService.resolveByKey('ZAP', ownerCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    expect(await identifiersOf(project.id)).toEqual(['NIF-1', 'NIF-2']);
  });
});
