import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubRepo } from '@/generated/prisma/client';
import { resolveEffectiveRepoDomain, mergeDomainsByName } from '@/lib/projectRepos/effectiveDomain';
import { projectRepoRoomService } from '@/lib/services/projectRepoRoomService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { listDispatchRepoNames } from '@/lib/workItems/dispatchRepo';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// THE EFFECTIVE REPOSITORY DOMAIN, as a SURFACE can read it (MOTIR-3126) — over
// real Postgres.
//
// ── What this pins, and why it is a new file ────────────────────────────────
// The scope LADDER (MOTIR-3086) is already covered end-to-end by
// `tests/ready/projectScopedDispatchRepo.test.ts`, through dispatch. That suite is
// deliberately untouched: it is the proof that moving the ladder out of
// `dispatchRepo.ts`'s private `resolveDomains` changed no behaviour, and a proof
// that had to be edited to keep passing would not be one.
//
// What it cannot cover is the half the move EXISTS for — the two registries kept
// APART, which dispatch collapses and a page cannot. So:
//
//   1. `connected` is the workspace rung AS LAYERED, per project shape — and it is
//      EMPTY for a project answered by its set alone. That empty is a different
//      fact from "the workspace has nothing connected", and conflating them is
//      what would put a `Your own repositories` heading on a project that has no
//      such repositories.
//   2. The union the reader returns is still exactly what dispatch resolves
//      against — asserted by reading BOTH through one project, so the two cannot
//      drift the way the resolver and the room already did once.
//   3. `getRoomView` renders that answer: the connected repositories minus the
//      ones a set row already names, and `connectedInDomain` from the LADDER
//      rather than from a count.
//
// Real Postgres, no mocks beyond the env the provisioning-org accessor reads.

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
  vi.stubEnv('GITHUB_APP_SLUG', 'motir');
});

describe('resolveEffectiveRepoDomain — the two registries, kept apart', () => {
  it('answers a set-less project with the WORKSPACE rung, and says so', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await connectRepo(fx.workspaceId, 'motir-ai');

    const domain = await resolveEffectiveRepoDomain(fx.projectId, fx.ctx);

    expect(domain.scope).toBe('workspace');
    expect(domain.hasSet).toBe(false);
    expect(domain.layersConnected).toBe(true);
    expect(domain.connected.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
    // The rung IS the domain here, so the union is the same list — and there are
    // no `project_repository` rows to point a reference at.
    expect(domain.pinnable.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
    expect(domain.projectRows).toBeNull();
  });

  it('answers a project BORN IN MOTIR with its set alone — `connected` is empty even though the workspace is not', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'someone-elses-repo');
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);

    const domain = await resolveEffectiveRepoDomain(fx.projectId, fx.ctx);

    expect(domain.scope).toBe('project');
    expect(domain.hasSet).toBe(true);
    expect(domain.layersConnected).toBe(false);
    // ⚠️ The point of the whole field: the workspace HAS a connected repository
    // and this project's domain does not include it. A surface that read the
    // workspace itself would offer the sibling project's repo as "yours".
    expect(domain.connected).toEqual([]);
    expect(domain.pinnable.map((r) => r.name)).toEqual(['acme-web']);
  });

  it('layers BOTH for a project that arrived with code, set first', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await connectRepo(fx.workspaceId, 'motir-ai');
    await giveProjectItsOwnCode(fx, 'moooon/motir-core');
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);

    const domain = await resolveEffectiveRepoDomain(fx.projectId, fx.ctx);

    expect(domain.scope).toBe('project');
    expect(domain.layersConnected).toBe(true);
    expect(domain.connected.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
    // Set FIRST — element 0 is the primary a set-less pin resolves to, and a
    // repository the project planned outranks one it inherited.
    expect(domain.pinnable[0]!.name).toBe('acme-api');
    expect(domain.pinnable.map((r) => r.name).sort()).toEqual([
      'acme-api',
      'motir-ai',
      'motir-core',
    ]);
    // The union carries no new ROW: `refs` can only point at the set's.
    expect(domain.projectRows!.map((r) => r.name)).toEqual(['acme-api']);
  });

  it('is the SAME domain dispatch resolves against — one definition, two readers', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await giveProjectItsOwnCode(fx, 'moooon/motir-core');
    await establishedRow(fx, 'acme-api');

    const [domain, dispatchable] = await Promise.all([
      resolveEffectiveRepoDomain(fx.projectId, fx.ctx),
      listDispatchRepoNames(fx.projectId, fx.ctx),
    ]);

    expect(domain.dispatchable.map((r) => r.name)).toEqual(dispatchable.map((r) => r.name));
    expect(dispatchable.map((r) => r.name).sort()).toEqual(['acme-api', 'motir-core']);
  });
});

describe('mergeDomainsByName', () => {
  it('keeps the FIRST occurrence of a name, case-insensitively', () => {
    const merged = mergeDomainsByName(
      [name('Acme-Web', 'set/Acme-Web')],
      [name('acme-web', 'workspace/acme-web'), name('acme-api', 'workspace/acme-api')],
    );
    // Two names differing only in case are ONE checkout identity, and the set's
    // entry is the one that knows its row.
    expect(merged.map((r) => r.repoRef)).toEqual(['set/Acme-Web', 'workspace/acme-api']);
  });
});

describe('projectRepoRoomService.getRoomView — the room renders the domain', () => {
  it('carries the connected repositories for a project whose set is EMPTY', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await connectRepo(fx.workspaceId, 'motir-ai');

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);

    // The defect, at the reporter's own shape: zero rows, and the page must NOT
    // be able to conclude the project has no repositories.
    expect(view.rows).toEqual([]);
    expect(view.connectedInDomain).toBe(true);
    expect(view.connected.map((r) => r.repoRef).sort()).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
    ]);
    expect(view.connected[0]!.defaultBranch).toBe('main');
  });

  it('does NOT repeat a repository that a set row already names', async () => {
    const fx = await makeWorkItemFixture();
    await giveProjectItsOwnCode(fx, 'moooon/motir-core');
    await connectRepo(fx.workspaceId, 'motir-core');
    // The row's realized repo is itself mirrored into `github_repo`, so the
    // workspace rung offers it back — exactly the duplicate the split must drop.
    await establishedRow(fx, 'acme-api');

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);

    expect(view.rows.map((r) => r.name)).toEqual(['acme-api']);
    expect(view.connected.map((r) => r.name)).toEqual(['motir-core']);
  });

  it('owns NO connected section for a project answered by its set alone', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'someone-elses-repo');
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);

    expect(view.connected).toEqual([]);
    // Not "empty right now" — not this project's section at all.
    expect(view.connectedInDomain).toBe(false);
  });

  it('owns the section for a project with NOTHING connected yet, so a later connect fills it', async () => {
    const fx = await makeWorkItemFixture();

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);

    // No set and no connected repositories: the rung is still the domain, so the
    // room owns the section and the island's refetch can populate it. This is the
    // distinction `connectedInDomain` exists to carry — a count could not.
    expect(view.connected).toEqual([]);
    expect(view.connectedInDomain).toBe(true);
  });

  it('owns the section for a project that arrived with code even before anything is connected', async () => {
    const fx = await makeWorkItemFixture();
    await giveProjectItsOwnCode(fx, 'moooon/motir-core');
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);

    // The case a `connected.length > 0` derivation gets WRONG: this project's
    // domain layers the workspace rung, the workspace simply has nothing in it
    // yet, and the section must survive that so the next connect lands in it.
    expect(view.connected).toEqual([]);
    expect(view.connectedInDomain).toBe(true);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function name(repoName: string, repoRef: string) {
  return { name: repoName, repoRef, cloneUrl: null, defaultBranch: null, archived: false };
}

async function connectRepo(workspaceId: string, repoName: string): Promise<GithubRepo> {
  const installationId = `inst-${workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      repoId: `${repoName}-${randomToken(8)}`,
      owner: 'moooon',
      name: repoName,
      defaultBranch: 'main',
      archived: false,
    },
  });
}

/**
 * Give the project a codebase of its OWN — the `migrate` onboarding run's
 * `connectedRepoRef`, the only PROJECT-scoped record that a project arrived with
 * code, and the field `projectHasItsOwnCode` reads.
 */
async function giveProjectItsOwnCode(fx: WorkItemFixture, connectedRepoRef: string): Promise<void> {
  await adminDb.migrateOnboarding.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      kind: 'migrate',
      step: 'done',
      status: 'completed',
      connectedRepoRef,
    },
  });
}

/** A set row taken through the real machine to `created` + realized, so it lands
 *  in the DISPATCH domain and not only the pin domain. */
async function establishedRow(fx: WorkItemFixture, repoName: string): Promise<void> {
  const mirror = await connectRepo(fx.workspaceId, repoName);
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'api', name: repoName },
    fx.ctx,
  );
  await projectRepoSetService.markCreating(row.id, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
}
