import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { GithubRepo } from '@/generated/prisma/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { ArchivedTargetRepoError, UnknownTargetRepoError } from '@/lib/workItems/errors';
import { listDispatchRepoNames } from '@/lib/workItems/dispatchRepo';
import { runNextReady } from '@/lib/mcp/tools/nextReady';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// PROJECT-SCOPED repo resolution + the CLONE coordinates on the dispatch payload
// (Story MOTIR-1775 · MOTIR-1783) — the two gaps MOTIR-1804 left, over real
// Postgres.
//
// MOTIR-1804 resolved an item's repo against "the workspace's SINGLE connected
// repo", which is the one-repo assumption this Story removed; and it named a repo
// without saying how to obtain it, so an agent with no checkout had nothing to
// clone. What is pinned here is every place either could quietly be wrong:
//
//   1. The SCOPE LADDER: a project with a set is answered by ITS set; a project
//      with none still falls back to the workspace's connected repos (the
//      compatibility path every pre-`project_repository` project lives on).
//   2. The refusal to guess SURVIVES the rescoping — two established repos and no
//      pin is still `null`, so a future "helpful" default cannot creep in.
//   3. A pin naming a SIBLING project's repo is rejected. Under workspace-wide
//      validation it was accepted, and dispatched an agent into a checkout that
//      has nothing to do with its project.
//   4. The coordinates are served for a resolved repo and are PRESENT-and-null
//      when Motir cannot know them (no repo; a pin whose row is still a plan).
//   5. EVERY dispatch surface agrees — `next_ready`, `claim_next_ready`,
//      `POST /api/ready/next`, `dispatch_prompt` — and a caller written before
//      this change still parses the payload.
//
// The route half stubs ONLY `getWorkspaceContext` (the session resolver the test
// env can't supply), partially, so the real RLS-binding `withWorkspaceContext`
// the repo reads depend on stays untouched — the same exception
// `dispatchTargetRepo.test.ts` takes.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { POST: nextPOST } = await import('@/app/api/ready/next/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
  await adminDb.$disconnect();
});

/** Connect one repo to the fixture's workspace — the 7.10.3 installation mirror
 *  a set row realizes against, and the workspace-scoped compatibility domain. */
async function connectRepo(
  workspaceId: string,
  name: string,
  opts: { owner?: string; provider?: string; defaultBranch?: string; archived?: boolean } = {},
): Promise<GithubRepo> {
  const owner = opts.owner ?? 'moooon';
  const provider = opts.provider ?? 'github';
  const installationId = `inst-${workspaceId}-${provider}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
      provider,
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: workspaceId,
      repoId: `${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: opts.defaultBranch ?? 'main',
      archived: opts.archived ?? false,
      provider,
    },
  });
}

/** Add a set row to `projectId` and REALIZE it against a freshly connected repo —
 *  an `established` row, the only kind a dispatch may resolve to. */
async function establishRepo(
  fx: WorkItemFixture,
  name: string,
  opts: {
    projectId?: string;
    role?: 'web' | 'api';
    owner?: string;
    defaultBranch?: string;
    /** Establish the row against a repository that is ARCHIVED on the host
     *  (MOTIR-1959) — a settled row whose repository accepts no writes. */
    archived?: boolean;
  } = {},
): Promise<GithubRepo> {
  const projectId = opts.projectId ?? fx.projectId;
  const row = await projectRepoSetService.addRow(
    projectId,
    { role: opts.role ?? 'web', name },
    fx.ctx,
  );
  const repo = await connectRepo(fx.workspaceId, name, {
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    ...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
    ...(opts.archived !== undefined ? { archived: opts.archived } : {}),
  });
  await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
  return repo;
}

/** Add a set row and leave it PROPOSED — planned, but no repository exists yet. */
async function proposeRepo(fx: WorkItemFixture, name: string): Promise<void> {
  await projectRepoSetService.addRow(fx.projectId, { role: 'api', name }, fx.ctx);
}

/** A ready (todo, unblocked) leaf, optionally pinned. */
async function makeReady(fx: WorkItemFixture, title: string, targetRepo?: string | null) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      assigneeId: null,
      descriptionMd: null,
      ...(targetRepo !== undefined ? { targetRepo } : {}),
    },
    fx.ctx,
  );
}

/** The dispatch payload for the fixture's single ready item. */
async function dispatchOf(fx: WorkItemFixture) {
  const dispatch = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
  if (!dispatch) throw new Error('expected a ready item');
  return dispatch;
}

// ── 1 · the scope ladder ────────────────────────────────────────────────────

describe('resolution scope — the project’s set, else the workspace’s connected repos', () => {
  it("resolves against the PROJECT's single established repo, with no pin", async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    await makeReady(fx, 'unpinned');

    expect(await dispatchOf(fx)).toMatchObject({ targetRepo: 'acme-web' });
  });

  it("IGNORES a workspace repo that is not in the project's set", async () => {
    // The rescoping's whole point: another project's repository is connected to
    // the same workspace, and it must not become this project's default.
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    await connectRepo(fx.workspaceId, 'someone-elses-repo');
    await makeReady(fx, 'unpinned');

    expect((await dispatchOf(fx)).targetRepo).toBe('acme-web');
  });

  it("falls back to the WORKSPACE's single connected repo for a project with NO set", async () => {
    // The compatibility path: every project that predates `project_repository`
    // (including Motir's own) must keep routing exactly as it did yesterday.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await makeReady(fx, 'unpinned');

    expect((await dispatchOf(fx)).targetRepo).toBe('motir-core');
  });

  it('does NOT fall back once the project HAS a set, even one that resolves to nothing', async () => {
    // A planned-but-unrealized set is a DECISION about which repositories this
    // project has. Answering it with the workspace's single repo would hand back
    // a repository the project deliberately did not choose.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await proposeRepo(fx, 'acme-api');
    await makeReady(fx, 'unpinned');

    expect((await dispatchOf(fx)).targetRepo).toBeNull();
  });

  it('resolves null for a project with no set and no connected repos at all', async () => {
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'unpinned');

    expect((await dispatchOf(fx)).targetRepo).toBeNull();
    expect(await listDispatchRepoNames(fx.projectId, fx.ctx)).toEqual([]);
  });
});

// ── 2 · the refusal to guess survives the rescoping ─────────────────────────

describe('two or more repos and no pin', () => {
  it('resolves NULL — never an arbitrary pick', async () => {
    // Pinned deliberately: a future "helpful" default here would send an agent's
    // cwd into the wrong checkout, which is worse than no answer at all.
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', { role: 'web' });
    await establishRepo(fx, 'acme-api', { role: 'api' });
    await makeReady(fx, 'unpinned');

    const dispatch = await dispatchOf(fx);
    expect(dispatch.targetRepo).toBeNull();
    expect(dispatch.targetRepoCloneUrl).toBeNull();
    expect(dispatch.targetRepoDefaultBranch).toBeNull();
  });

  it('an explicit pin still wins over the ambiguous set', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', { role: 'web' });
    await establishRepo(fx, 'acme-api', { role: 'api' });
    await makeReady(fx, 'targets the api repo', 'acme-api');

    expect((await dispatchOf(fx)).targetRepo).toBe('acme-api');
  });
});

// ── 3 · validation is project-scoped ────────────────────────────────────────

describe("authoring a pin validates against THIS project's set", () => {
  it('REJECTS a repo that belongs to a SIBLING project of the same workspace', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Sibling',
      identifier: 'SIB',
    });
    await establishRepo(fx, 'sibling-api', { projectId: sibling.id, role: 'api' });

    await expect(makeReady(fx, 'wrong project', 'sibling-api')).rejects.toBeInstanceOf(
      UnknownTargetRepoError,
    );
    // The message names the domain the author must correct against.
    await expect(makeReady(fx, 'wrong project', 'sibling-api')).rejects.toThrow(
      /This project's repositories: moooon\/acme-web/,
    );
    // …and the rejected create left no row behind.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('ACCEPTS a pin naming a row that is still PROPOSED — the plan pins before it creates', async () => {
    // ADR §5.1: the planner pins at generation, when no repository exists yet.
    // Validation exists to catch a typo, not to forbid planning ahead.
    const fx = await makeWorkItemFixture();
    await proposeRepo(fx, 'acme-api');

    const item = await makeReady(fx, 'planned repo', 'acme-api');
    expect(item.targetRepo).toBe('acme-api');
  });

  it('rejects a typo on UPDATE too — the patch surface is never looser', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    const item = await makeReady(fx, 'patch me');

    await expect(
      workItemsService.updateWorkItem(item.id, { targetRepo: 'acme-wbe' }, fx.ctx),
    ).rejects.toBeInstanceOf(UnknownTargetRepoError);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).targetRepo,
    ).toBeNull();

    const pinned = await workItemsService.updateWorkItem(
      item.id,
      { targetRepo: 'moooon/acme-web' },
      fx.ctx,
    );
    expect(pinned.targetRepo).toBe('acme-web');
  });

  it('clears a pin without consulting any domain, and 404s an unknown item', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'unpin me');
    const cleared = await workItemsService.updateWorkItem(item.id, { targetRepo: null }, fx.ctx);
    expect(cleared.targetRepo).toBeNull();

    await expect(
      workItemsService.updateWorkItem('wi_missing', { targetRepo: 'acme-web' }, fx.ctx),
    ).rejects.toThrow(/wi_missing/);
  });
});

// ── 4 · the clone coordinates ───────────────────────────────────────────────

describe('the payload says HOW to obtain the repo', () => {
  it('serves the clone URL + default branch of a resolved, realized repo', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', { owner: 'acme', defaultBranch: 'trunk' });
    await makeReady(fx, 'unpinned');

    expect(await dispatchOf(fx)).toMatchObject({
      targetRepo: 'acme-web',
      targetRepoCloneUrl: 'https://github.com/acme/acme-web.git',
      targetRepoDefaultBranch: 'trunk',
    });
  });

  it('serves them for an explicitly PINNED realized repo', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', { role: 'web' });
    await establishRepo(fx, 'acme-api', { role: 'api' });
    await makeReady(fx, 'pinned', 'acme-api');

    expect(await dispatchOf(fx)).toMatchObject({
      targetRepo: 'acme-api',
      targetRepoCloneUrl: 'https://github.com/moooon/acme-api.git',
      targetRepoDefaultBranch: 'main',
    });
  });

  it('serves PRESENT-and-null coordinates for a pin whose row is still a plan', async () => {
    // The routing decision stands — the agent is told which repo it belongs to —
    // but there is nothing to clone yet, and saying so beats inventing a URL.
    const fx = await makeWorkItemFixture();
    await proposeRepo(fx, 'acme-api');
    await makeReady(fx, 'pinned at plan time', 'acme-api');

    const dispatch = await dispatchOf(fx);
    expect(dispatch.targetRepo).toBe('acme-api');
    expect(dispatch).toHaveProperty('targetRepoCloneUrl', null);
    expect(dispatch).toHaveProperty('targetRepoDefaultBranch', null);
  });

  it('derives a GitLab-connected repo’s URL from the GitLab instance', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const repo = await connectRepo(fx.workspaceId, 'acme-web', {
      provider: 'gitlab',
      owner: 'acme-group',
    });
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    await makeReady(fx, 'unpinned');

    expect((await dispatchOf(fx)).targetRepoCloneUrl).toBe(
      'https://gitlab.com/acme-group/acme-web.git',
    );
  });
});

// ── 5 · every dispatch surface agrees ───────────────────────────────────────

describe('all dispatch surfaces serve the same resolution', () => {
  it('`next_ready` (MCP)', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    await connectRepo(fx.workspaceId, 'not-ours');
    const item = await makeReady(fx, 'dispatch me');

    const res = await runNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as {
      item: { key: string; targetRepo: string | null; targetRepoCloneUrl: string | null } | null;
    };
    expect(sc.item?.key).toBe(item.identifier);
    expect(sc.item?.targetRepo).toBe('acme-web');
    expect(sc.item?.targetRepoCloneUrl).toBe('https://github.com/moooon/acme-web.git');
  });

  it('`claim_next_ready` (MCP)', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    const item = await makeReady(fx, 'claim me');

    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as {
      item: {
        key: string;
        targetRepo: string | null;
        targetRepoCloneUrl: string | null;
        targetRepoDefaultBranch: string | null;
      } | null;
    };
    expect(sc.item?.key).toBe(item.identifier);
    expect(sc.item?.targetRepo).toBe('acme-web');
    expect(sc.item?.targetRepoCloneUrl).toBe('https://github.com/moooon/acme-web.git');
    expect(sc.item?.targetRepoDefaultBranch).toBe('main');
  });

  it('`POST /api/ready/next` (the BYOK HTTP contract)', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    const item = await makeReady(fx, 'over http');
    ctxRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };

    const res = await nextPOST(
      new Request(`${BASE}/api/ready/next`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey: fx.projectIdentifier }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      targetRepo: string | null;
      targetRepoCloneUrl: string | null;
      targetRepoDefaultBranch: string | null;
    };
    expect(body.key).toBe(item.identifier);
    expect(body.targetRepo).toBe('acme-web');
    expect(body.targetRepoCloneUrl).toBe('https://github.com/moooon/acme-web.git');
    expect(body.targetRepoDefaultBranch).toBe('main');
  });

  it('`dispatch_prompt` — the printed-prompt surface routes identically', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    await connectRepo(fx.workspaceId, 'not-ours');
    const item = await makeReady(fx, 'print me');

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.targetRepo).toBe('acme-web');
    expect(dto.targetRepoCloneUrl).toBe('https://github.com/moooon/acme-web.git');
    expect(dto.targetRepoDefaultBranch).toBe('main');
  });
});

// ── 6 · the published contract stays backward-compatible ───────────────────

// ── 6 · the ARCHIVED repository (MOTIR-1959) ────────────────────────────────

// A repository can be archived at ANY time after it joined the project's set —
// which is the incident MOTIR-1956 recorded, one layer down. Membership and a
// collaborator's `push` permission are both silent about it, so before this guard
// a card resolving to an archived repo stayed `ready`, dispatched, and could not
// open a PR. What is pinned here is that the refusal happens at RESOLUTION, over
// real Postgres, on every dispatch surface — not at the point an agent tries to
// push, which is far too late and far from the reader.
describe('a dispatch resolving to an ARCHIVED repository', () => {
  it('REFUSES the project default, naming the repository and the reason', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', { archived: true });
    await makeReady(fx, 'unpinned');

    await expect(dispatchOf(fx)).rejects.toThrow(ArchivedTargetRepoError);
    await expect(dispatchOf(fx)).rejects.toThrow(/acme-web/);
    await expect(dispatchOf(fx)).rejects.toThrow(/archived/);
  });

  it('REFUSES an explicit pin to an archived repo', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', { archived: true });
    await establishRepo(fx, 'acme-api', { role: 'api' });
    await makeReady(fx, 'pinned at the dead one', 'acme-web');

    await expect(dispatchOf(fx)).rejects.toThrow(ArchivedTargetRepoError);
  });

  it('still dispatches a SIBLING item pinned to the LIVE repo — rows are independent', async () => {
    // The guard is about the repository the ITEM resolves to, never about the set
    // merely containing an archived row: an archived `web` repository cannot
    // strand the `api` work (ADR §4.2, one layer up).
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', { archived: true });
    await establishRepo(fx, 'acme-api', { role: 'api' });
    const live = await makeReady(fx, 'pinned at the live one', 'acme-api');

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      live.identifier,
      fx.ctx,
    );
    expect(dto.targetRepo).toBe('acme-api');
  });

  it('refuses on EVERY dispatch surface — `next_ready`, `claim_next_ready`, `dispatch_prompt`', async () => {
    // The surfaces share `resolveItemDispatchRepo` precisely so they can never
    // route differently; a guard on one of them would be a guard on none.
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', { archived: true });
    const item = await makeReady(fx, 'dispatch me');

    await expect(runNextReady({ projectKey: fx.projectIdentifier }, fx.ctx)).rejects.toThrow(
      ArchivedTargetRepoError,
    );
    await expect(
      dispatchPromptService.getDispatchPrompt(fx.projectId, item.identifier, fx.ctx),
    ).rejects.toThrow(ArchivedTargetRepoError);
    await expect(runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx)).rejects.toThrow(
      ArchivedTargetRepoError,
    );
  });

  it('un-archiving the repository makes the item dispatchable again — no other repair needed', async () => {
    // The state is RECORDED, not inferred, so the fix on the host is the whole
    // fix: nothing in Motir has to be re-established, re-pinned or re-planned.
    const fx = await makeWorkItemFixture();
    const repo = await establishRepo(fx, 'acme-web', { archived: true });
    await makeReady(fx, 'unpinned');
    await expect(dispatchOf(fx)).rejects.toThrow(ArchivedTargetRepoError);

    await adminDb.githubRepo.update({ where: { id: repo.id }, data: { archived: false } });
    expect(await dispatchOf(fx)).toMatchObject({ targetRepo: 'acme-web' });
  });
});

describe('contract discipline — additive only', () => {
  it("leaves today's fields unchanged in name and type, and adds only the two", async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web');
    await makeReady(fx, 'shape check');

    const dispatch = await dispatchOf(fx);
    expect(Object.keys(dispatch).sort()).toEqual(
      [
        'assignee',
        'blockerKeys',
        'contextRefs',
        'descriptionExcerpt',
        'descriptionMd',
        'executor',
        'id',
        // Amendment 17 (MOTIR-2400) put the readiness qualifier on the ready
        // ROW, so the dispatch superset inherits it. `sessionBranch` below is
        // the SAME value addressed as an instruction, and both stay: this
        // payload tells an agent what to do, the row states a fact.
        'inheritedSessionBranch',
        'key',
        'kind',
        'parentKey',
        'priority',
        'runCommand',
        'sessionBranch',
        'status',
        'targetRepo',
        'targetRepoCloneUrl',
        'targetRepoDefaultBranch',
        'title',
        'type',
      ].sort(),
    );
    expect(typeof dispatch.targetRepo).toBe('string');
    expect(dispatch.runCommand).toMatch(/^motir run [A-Z]+-\d+$/);
  });

  it('a caller written BEFORE this change still parses a null-repo payload', async () => {
    // The BYOK contract: today's consumers read a fixed set of fields and ignore
    // the rest, so a payload where Motir knows no repo must be byte-for-byte
    // usable by them — new keys present with null values, nothing required.
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'no repo anywhere');

    const dispatch = await dispatchOf(fx);
    const legacyView = {
      id: dispatch.id,
      key: dispatch.key,
      kind: dispatch.kind,
      title: dispatch.title,
      priority: dispatch.priority,
      status: dispatch.status,
      type: dispatch.type,
      executor: dispatch.executor,
      targetRepo: dispatch.targetRepo,
      sessionBranch: dispatch.sessionBranch,
    };
    expect(legacyView).toEqual({
      id: dispatch.id,
      key: dispatch.key,
      kind: 'task',
      title: 'no repo anywhere',
      priority: dispatch.priority,
      status: dispatch.status,
      type: null,
      executor: null,
      targetRepo: null,
      sessionBranch: null,
    });
    // Round-trips through JSON with the nulls intact — never dropped keys.
    const wire = JSON.parse(JSON.stringify(dispatch)) as Record<string, unknown>;
    expect('targetRepoCloneUrl' in wire).toBe(true);
    expect('targetRepoDefaultBranch' in wire).toBe(true);
    expect(wire['targetRepoCloneUrl']).toBeNull();
  });
});

// ── 6 · a project that ARRIVED WITH CODE keeps it when the set gains a row ───
//
// MOTIR-3086. The five sections above all reason about a project whose
// repositories are the ones its SET names — a project born in Motir, where the
// set is a complete statement and the workspace rung is pure back-compat. This
// section is the other project: one that arrived with a codebase, whose
// repositories are recorded NOWHERE in `project_repository` because the connect
// branch writes no row (ADR amendment 2026-08-19 · MOTIR-3086). Its first row
// used to REPLACE its repo list rather than extend it.

/**
 * Give `fx`'s project a codebase of its OWN — the `migrate` onboarding run's
 * `connectedRepoRef`, which is the only PROJECT-scoped record that a project
 * arrived with code (MOTIR-3073's gate reads the same field).
 *
 * Deliberately does NOT touch `project_repository`: that is the whole shape of
 * the defect — such a project has zero rows by construction, and its
 * repositories are known only through the workspace installation.
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

describe('a project that already has code, gaining its FIRST set row', () => {
  it('keeps every repository it already had PINNABLE (MOTIR-3086)', async () => {
    // The reported defect, at the reporter's own base: five repos connected,
    // no set rows, one row added — and from that moment nothing the project
    // already had could be pinned on a card.
    const fx = await makeWorkItemFixture();
    for (const name of ['motir-core', 'motir-ai', 'motir-gateway', 'motir-meta']) {
      await connectRepo(fx.workspaceId, name);
    }
    await giveProjectItsOwnCode(fx, 'moooon/motir-core');

    // Legal BEFORE the first row — the compatibility rung answers.
    const before = await makeReady(fx, 'pinned before', 'motir-core');
    expect(before.targetRepo).toBe('motir-core');

    // The DELIBERATE path 3073 does not touch: the user asks Motir to host a new
    // repository alongside the ones they already have.
    await proposeRepo(fx, 'motir-hosted-web');

    // …and the repositories the project already had are STILL pinnable.
    const after = await makeReady(fx, 'pinned after', 'motir-core');
    expect(after.targetRepo).toBe('motir-core');
    // Every one of them, not just the one the onboarding run happens to name —
    // which is why this is a UNION and not a seed of that single field.
    for (const name of ['motir-ai', 'motir-gateway', 'motir-meta']) {
      expect((await makeReady(fx, `pinned ${name}`, name)).targetRepo).toBe(name);
    }
    // The newly-added row is pinnable too — the set is not shadowed by the union.
    expect((await makeReady(fx, 'pinned new', 'motir-hosted-web')).targetRepo).toBe(
      'motir-hosted-web',
    );
  });

  it('keeps them in the DISPATCH domain, set rows FIRST', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await giveProjectItsOwnCode(fx, 'moooon/motir-core');
    await establishRepo(fx, 'motir-hosted-web');

    expect((await listDispatchRepoNames(fx.projectId, fx.ctx)).map((r) => r.name)).toEqual([
      'motir-hosted-web',
      'motir-core',
    ]);
  });

  it('a pin whose repo is workspace-only resolves with its CLONE coordinates', async () => {
    // The union hands back real `GithubRepo` rows, so the coordinates an agent
    // with no checkout needs survive the switch that used to drop them.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core', {
      owner: 'moooon-B-V',
      defaultBranch: 'trunk',
    });
    await giveProjectItsOwnCode(fx, 'moooon-B-V/motir-core');
    await proposeRepo(fx, 'motir-hosted-web');
    await makeReady(fx, 'pinned', 'motir-core');

    expect(await dispatchOf(fx)).toMatchObject({
      targetRepo: 'motir-core',
      targetRepoCloneUrl: 'https://github.com/moooon-B-V/motir-core.git',
      targetRepoDefaultBranch: 'trunk',
    });
  });

  it('stops guessing a single default once the union makes the domain ambiguous', async () => {
    // A consequence to state rather than discover: such a project genuinely HAS
    // two repositories, so there is no non-arbitrary single choice — and routing
    // every unpinned card into the just-added hosted repo is the other half of
    // the reported defect.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await giveProjectItsOwnCode(fx, 'moooon/motir-core');
    await establishRepo(fx, 'motir-hosted-web');
    await makeReady(fx, 'unpinned');

    expect((await dispatchOf(fx)).targetRepo).toBeNull();
  });

  it('still REJECTS a name that is in NEITHER domain — the typo', async () => {
    // The union widens the domain to the WORKSPACE's repos, so what it must not
    // lose is the typo. (A sibling PROJECT's set row is a different case: it is
    // covered below.)
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'motir-core');
    await giveProjectItsOwnCode(fx, 'moooon/motir-core');
    await proposeRepo(fx, 'motir-hosted-web');

    await expect(makeReady(fx, 'typo', 'motir-cero')).rejects.toBeInstanceOf(
      UnknownTargetRepoError,
    );
  });
});

describe('a project with NO code of its own is UNCHANGED by the first row', () => {
  it('the set IS the list — a workspace repo outside it stays unpinnable', async () => {
    // The other direction of the transition, and the reason the new rung is
    // CONDITIONED rather than unconditional: for a project born in Motir the set
    // is a complete statement of its repositories, so it still answers alone and
    // the sibling-isolation §3 asserts is untouched.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'someone-elses-repo');
    await proposeRepo(fx, 'acme-api');

    await expect(makeReady(fx, 'not ours', 'someone-elses-repo')).rejects.toBeInstanceOf(
      UnknownTargetRepoError,
    );
    expect((await makeReady(fx, 'ours', 'acme-api')).targetRepo).toBe('acme-api');
  });

  it('an onboarding run that never connected a repo is not "has code"', async () => {
    // The signal is the FIELD, not the run: a project that started the migrate
    // wizard and abandoned it at `connect` has no code, and must not acquire a
    // union because a row exists in `migrate_onboarding`.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'someone-elses-repo');
    await adminDb.migrateOnboarding.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'migrate',
        step: 'connect',
        status: 'active',
        connectedRepoRef: null,
      },
    });
    await proposeRepo(fx, 'acme-api');

    await expect(makeReady(fx, 'not ours', 'someone-elses-repo')).rejects.toBeInstanceOf(
      UnknownTargetRepoError,
    );
  });
});
