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

async function identifiersOf(projectId: string): Promise<string[]> {
  const rows = await db.workItem.findMany({ where: { projectId }, select: { identifier: true } });
  return rows.map((r) => r.identifier).sort();
}

describe('Story 6.8 — the project-details lifecycle, composed on one project', () => {
  it('walks the full verification recipe end to end (rename → avatar → key change → redirect → reclaim → release)', async () => {
    const { project, ownerCtx } = await makeFixture('lifecycle');
    const [one, two] = await seedItems(project.id, ownerCtx, 2);
    expect(one?.identifier).toBe('PROD-1');
    expect(two?.identifier).toBe('PROD-2');

    // ── 1. Rename + avatar (the batched updateDetails path) ──────────────────
    const renamed = await projectsService.updateDetails({
      key: 'PROD',
      name: '  Lifecycle Renamed  ',
      avatarIcon: 'rocket',
      avatarColor: 'lavender',
      ctx: ownerCtx,
    });
    expect(renamed.name).toBe('Lifecycle Renamed'); // trimmed
    expect(renamed.avatarIcon).toBe('rocket');
    expect(renamed.avatarColor).toBe('lavender');
    expect(renamed.identifier).toBe('PROD'); // a rename does NOT touch the key

    // ── 2. Change the key PROD → NIF (the atomic rewrite) ────────────────────
    const moved = await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    expect(moved.identifier).toBe('NIF');
    expect(moved.previousKeys).toEqual([{ identifier: 'PROD', retiredAt: expect.any(String) }]);
    // Every issue re-keyed, numbers preserved; the avatar/name survive the change.
    expect(await identifiersOf(project.id)).toEqual(['NIF-1', 'NIF-2']);
    expect(moved.name).toBe('Lifecycle Renamed');
    expect(moved.avatarIcon).toBe('rocket');

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
    expect(await identifiersOf(project.id)).toEqual(['PROD-1', 'PROD-2']);
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
    expect(await db.projectKeyAlias.count({ where: { projectId: project.id } })).toBe(1);
    expect(await identifiersOf(project.id)).toEqual(['NIF-1', 'NIF-2']);
  });

  it('two renames to DIFFERENT keys both apply, serialised, leaving a clean alias chain', async () => {
    const { project, ownerCtx } = await makeFixture('race-rr-diff');
    await seedItems(project.id, ownerCtx, 1);

    // PROD→NIF and PROD→ZAP concurrently. Whichever grabs the lock first renames;
    // the second resolves the (now-aliased) PROD to the SAME project and renames
    // again — both succeed, serialised, with no lost update. The final key is one
    // of the two targets, and BOTH non-final keys resolve flat to the project.
    const results = await Promise.allSettled([
      projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx }),
      projectsService.changeKey({ key: 'PROD', newKey: 'ZAP', ctx: ownerCtx }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const fresh = await projectsService.resolveByKey('PROD', ownerCtx);
    const finalKey = fresh.project.identifier;
    expect(['NIF', 'ZAP']).toContain(finalKey);
    // Both PROD and the non-final target are retired keys that resolve flat.
    const retired = finalKey === 'NIF' ? 'ZAP' : 'NIF';
    for (const oldKey of ['PROD', retired]) {
      const r = await projectsService.resolveByKey(oldKey, ownerCtx);
      expect(r.viaAlias).toBe(true);
      expect(r.project.identifier).toBe(finalKey);
    }
    expect(await identifiersOf(project.id)).toEqual([`${finalKey}-1`]);
  });
});
