import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { encryptToken } from '@/lib/gitlab/tokenCrypto';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { GET as getItemGET } from '@/app/api/internal/ai/get-item/route';
import { GET as repoChangesGET } from '@/app/api/internal/ai/repo-changes/route';
import { repoChangesService } from '@/lib/services/repoChangesService';
import { makeWorkItemFixture, createTestProject } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkProjectRepo } from '../../helpers/projectRepoLink';
import { randomToken } from '../../helpers/random';

// STORY MOTIR-6617's motir-core GATE (MOTIR-6621) — the ASSEMBLED behaviour of
// the two feature cards, driven through the REAL route handlers against a real
// Postgres:
//
//   • `GET /api/internal/ai/get-item` (MOTIR-6618) over real `work_item_delivery`
//     / `github_pull_request` rows, written and read under the RLS workspace
//     binding — the seam the unit suite mocks, and the one whose failure LOOKS
//     like an answer (`inFlightCode: []` for a card with an open pull request).
//   • `GET /api/internal/ai/repo-changes` (MOTIR-6619) from the job token through
//     the project-set repository resolution to EACH provider, with the host
//     stubbed at the HTTP boundary (`fetch`) and the providers themselves real.
//
// The two negatives are asserted, not inferred: the item read touches NO
// provider method (a double that fails the test on any call), and no serialized
// response body of any case carries a minted credential or a credential URL.

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
  _resetInstallationTokenCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeWorkItemFixture>>;

function tokenFor(fx: { ctx: { userId: string; workspaceId: string }; projectId: string }) {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function req(path: string, token: string, query: Record<string, string>): Request {
  const url = new URL(`http://core/api/internal/ai/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, {
    headers: { authorization: `Bearer ${SERVICE_SECRET}`, 'x-motir-job-token': token },
  });
}

// ── The no-provider-call double ─────────────────────────────────────────────
// EVERY method of BOTH registered providers is replaced by one that records the
// call and throws, and `fetch` itself fails — so a provider reached on the item
// read fails the test whether it is reached through the seam or around it.
function armNoProviderDouble() {
  const calls: string[] = [];
  for (const id of ['github', 'gitlab'] as const) {
    const provider = getGitProvider(id) as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(provider)) {
      if (typeof value !== 'function') continue;
      vi.spyOn(provider as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(
        () => {
          calls.push(`${id}.${name}`);
          throw new Error(`provider ${id}.${name} must not be called on the item read`);
        },
      );
    }
  }
  const fetchMock = vi.fn(async (url: unknown) => {
    calls.push(`fetch ${String(url)}`);
    throw new Error('no host may be called on the item read');
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

// ── get-item seeding: real rows, written through the real repositories ─────

async function addGithubRepo(fx: Fx, name: string): Promise<{ id: string }> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
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
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
    select: { id: true },
  });
}

let nextPrNumber = 6600;

async function addPr(
  repoId: string,
  opts: { headRef: string; merged?: boolean },
): Promise<{ id: string; number: number }> {
  const number = nextPrNumber++;
  const row = await adminDb.githubPullRequest.create({
    data: {
      repoId,
      number,
      state: opts.merged ? 'closed' : 'open',
      merged: opts.merged ?? false,
      headRef: opts.headRef,
      baseRef: 'main',
      provider: 'github',
    },
    select: { id: true },
  });
  return { id: row.id, number };
}

/** The link, written the way the product writes it — under the workspace binding. */
async function deliver(fx: Fx, workItemId: string, prId: string, repoId: string) {
  await withWorkspaceContext(fx.ctx, (tx) =>
    workItemDeliveryRepository.add(
      { workspaceId: fx.workspaceId, workItemId, githubPullRequestId: prId, repoId },
      tx,
    ),
  );
}

async function storyWithChild(fx: Fx) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Story' },
    fx.ctx,
  );
  const child = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'Child', parentId: story.id },
    fx.ctx,
  );
  return { story, child };
}

interface ItemBody {
  item: {
    identifier: string;
    inFlightCode: Array<Record<string, unknown>>;
    mergedRepos: string[];
  };
}

async function getItem(fx: Fx, key: string, bodies?: string[]): Promise<ItemBody> {
  const res = await getItemGET(req('get-item', tokenFor(fx), { key }));
  const text = await res.text();
  bodies?.push(text);
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as ItemBody;
}

describe('story gate — the item read’s in-flight location over real delivery rows', () => {
  it('seam: real rows → item read — an open parent-branch PR is the child’s one inherited entry', async () => {
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const core = await addGithubRepo(fx, 'motir-core');
    const headRef = `parent/${story.identifier}-in-flight-code`;
    const pr = await addPr(core.id, { headRef });
    await deliver(fx, story.id, pr.id, core.id);
    const calls = armNoProviderDouble();

    const body = await getItem(fx, child.identifier);
    expect(body.item.inFlightCode).toEqual([
      {
        repo: 'moooon/motir-core',
        branch: headRef,
        headSha: null,
        prNumber: pr.number,
        prUrl: `https://github.com/moooon/motir-core/pull/${pr.number}`,
        draft: false,
        baseRef: 'main',
        source: 'inherited',
        fromKey: story.identifier,
      },
    ]);
    expect(body.item.mergedRepos).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('seam: merged vs never — merged is [] + mergedRepos; no PR anywhere is both empty', async () => {
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const core = await addGithubRepo(fx, 'motir-core');
    const pr = await addPr(core.id, { headRef: `parent/${story.identifier}-x`, merged: true });
    await deliver(fx, story.id, pr.id, core.id);
    const bare = await storyWithChild(fx);
    const calls = armNoProviderDouble();

    const merged = await getItem(fx, story.identifier);
    expect(merged.item.inFlightCode).toEqual([]);
    expect(merged.item.mergedRepos).toEqual(['moooon/motir-core']);
    // The merged story's child inherits nothing: merged is not in flight.
    const mergedChild = await getItem(fx, child.identifier);
    expect(mergedChild.item.inFlightCode).toEqual([]);

    for (const key of [bare.story.identifier, bare.child.identifier]) {
      const never = await getItem(fx, key);
      expect(never.item.inFlightCode).toEqual([]);
      expect(never.item.mergedRepos).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('seam: multi-repo — own motir-ai under a story open in motir-core is two entries, each with its source', async () => {
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const core = await addGithubRepo(fx, 'motir-core');
    const ai = await addGithubRepo(fx, 'motir-ai');
    const storyPr = await addPr(core.id, { headRef: `parent/${story.identifier}-core` });
    const ownPr = await addPr(ai.id, { headRef: `subtask/${child.identifier}-ai` });
    await deliver(fx, story.id, storyPr.id, core.id);
    await deliver(fx, child.id, ownPr.id, ai.id);
    const calls = armNoProviderDouble();

    const body = await getItem(fx, child.identifier);
    expect(body.item.inFlightCode).toEqual([
      expect.objectContaining({
        repo: 'moooon/motir-ai',
        branch: `subtask/${child.identifier}-ai`,
        prNumber: ownPr.number,
        source: 'own',
      }),
      expect.objectContaining({
        repo: 'moooon/motir-core',
        branch: `parent/${story.identifier}-core`,
        prNumber: storyPr.number,
        source: 'inherited',
        fromKey: story.identifier,
      }),
    ]);
    expect(body.item.inFlightCode[0]).not.toHaveProperty('fromKey');
    expect(calls).toEqual([]);
  });

  it('seam: multi-repo — entries are ordered by repository, not by the level that claimed them', async () => {
    // The mirror of the case above: OWN in motir-core, INHERITED in motir-ai, so the
    // own entry is claimed first and the read still answers in repository order.
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const core = await addGithubRepo(fx, 'motir-core');
    const ai = await addGithubRepo(fx, 'motir-ai');
    const ownPr = await addPr(core.id, { headRef: `subtask/${child.identifier}-core` });
    const storyPr = await addPr(ai.id, { headRef: `parent/${story.identifier}-ai` });
    await deliver(fx, child.id, ownPr.id, core.id);
    await deliver(fx, story.id, storyPr.id, ai.id);
    const calls = armNoProviderDouble();

    const body = await getItem(fx, child.identifier);
    expect(body.item.inFlightCode.map((e) => [e['repo'], e['source']])).toEqual([
      ['moooon/motir-ai', 'inherited'],
      ['moooon/motir-core', 'own'],
    ]);
    expect(calls).toEqual([]);
  });

  it('guard: tenancy — another workspace’s delivery on a same-shaped card never appears', async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs' });
    const my = await storyWithChild(mine);
    const their = await storyWithChild(theirs);
    // SAME SHAPE, SAME KEYS: both projects are PROD, so the two children share an
    // identifier and only the token's project tells them apart.
    expect(their.child.identifier).toBe(my.child.identifier);

    const theirRepo = await addGithubRepo(theirs, 'motir-core');
    const theirPr = await addPr(theirRepo.id, { headRef: 'parent/THEIRS-leak' });
    await deliver(theirs, their.story.id, theirPr.id, theirRepo.id);
    // ⚠️ AND A ROW THAT POINTS AT MY CARD but is tenanted to THEIR workspace — the
    // shape only a missing / wrong workspace binding would ever surface. Written as
    // the superuser, since no product path can create it.
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: theirs.workspaceId,
        workItemId: my.story.id,
        githubPullRequestId: theirPr.id,
        repoId: theirRepo.id,
      },
    });
    const calls = armNoProviderDouble();

    for (const key of [my.story.identifier, my.child.identifier]) {
      const body = await getItem(mine, key);
      expect(body.item.inFlightCode).toEqual([]);
      expect(body.item.mergedRepos).toEqual([]);
    }
    // Their own read of the same key still sees their row — the row is real.
    const theirsBody = await getItem(theirs, their.child.identifier);
    expect(theirsBody.item.inFlightCode).toEqual([
      expect.objectContaining({ branch: 'parent/THEIRS-leak', source: 'inherited' }),
    ]);
    expect(calls).toEqual([]);
  });

  it('guard: tenancy — the ancestor walk never crosses the token’s project', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
      name: 'Other',
    });
    const foreignStory = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'story', title: 'Foreign story' },
      fx.ctx,
    );
    const { story, child } = await storyWithChild(fx);
    const core = await addGithubRepo(fx, 'motir-core');
    const foreignPr = await addPr(core.id, { headRef: 'parent/OTHR-1-foreign' });
    await deliver(fx, foreignStory.id, foreignPr.id, core.id);
    // FIRST DEFENCE: the database refuses a parent edge that leaves the project.
    await expect(
      adminDb.workItem.update({ where: { id: story.id }, data: { parentId: foreignStory.id } }),
    ).rejects.toThrow(/WI_PARENT_CROSS_PROJECT/);
    // SECOND DEFENCE, the one this read owns: were such a chain ever read (a row
    // written before the trigger, a trigger dropped by a migration), the walk CUTS
    // at the first ancestor outside the token's project. The chain is the REAL
    // one with the REAL foreign story — whose REAL open delivery is in the batch
    // the read would issue — spliced in as the root.
    const foreignRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: foreignStory.id } });
    const realFindAncestors = workItemRepository.findAncestors.bind(workItemRepository);
    vi.spyOn(workItemRepository, 'findAncestors').mockImplementation(async (...args) => [
      foreignRow,
      ...(await realFindAncestors(...args)),
    ]);
    const batched = vi.spyOn(workItemDeliveryRepository, 'listByWorkItemsWithChecks');
    const calls = armNoProviderDouble();

    for (const key of [story.identifier, child.identifier]) {
      const body = await getItem(fx, key);
      expect(body.item.inFlightCode).toEqual([]);
    }
    // The foreign card never even entered the delivery read.
    for (const [ids] of batched.mock.calls) expect(ids).not.toContain(foreignStory.id);
    expect(batched).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
  });

  it('guard: no provider call on the item read — the double stays uncalled on an own + inherited read', async () => {
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const core = await addGithubRepo(fx, 'motir-core');
    const storyPr = await addPr(core.id, { headRef: `parent/${story.identifier}-y` });
    const ownPr = await addPr(core.id, { headRef: `subtask/${child.identifier}-y` });
    await deliver(fx, story.id, storyPr.id, core.id);
    await deliver(fx, child.id, ownPr.id, core.id);
    const calls = armNoProviderDouble();

    const body = await getItem(fx, child.identifier);
    // Own wins over inherited in the same repository.
    expect(body.item.inFlightCode).toEqual([
      expect.objectContaining({ source: 'own', prNumber: ownPr.number }),
    ]);
    expect(calls).toEqual([]);
  });
});

// ── repo-changes through BOTH providers ─────────────────────────────────────

const GH_TOKEN = 'ghs_story_gate_minted_secret';
const GL_TOKEN = 'glpat_story_gate_stored_secret';
const BASE_SHA = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
const HEAD_SHA = '0328041d1152db8ae77652d1618a02e57f745f17';

/** A recorded GitHub `compare/{base}...{head}` payload (trimmed to the fields the
 *  host sends that matter here, including the ones that must NOT be relayed). */
function githubComparePayload() {
  return {
    url: `https://api.github.com/repos/moooon/motir-core/compare/trunk...feat/x`,
    html_url: 'https://github.com/moooon/motir-core/compare/trunk...feat/x',
    status: 'ahead',
    ahead_by: 1,
    behind_by: 0,
    base_commit: { sha: BASE_SHA },
    merge_base_commit: { sha: BASE_SHA },
    commits: [{ sha: HEAD_SHA }],
    files: [
      {
        sha: 'bbcd538c8e72b8c175046e27cc8f907076331401',
        filename: 'lib/services/inFlightCode.ts',
        status: 'added',
        additions: 97,
        deletions: 0,
        changes: 97,
        blob_url: `https://github.com/moooon/motir-core/blob/${HEAD_SHA}/lib/services/inFlightCode.ts`,
        raw_url: `https://x-access-token:${GH_TOKEN}@github.com/moooon/motir-core/raw/${HEAD_SHA}/lib/services/inFlightCode.ts`,
        contents_url: `https://api.github.com/repos/moooon/motir-core/contents/lib/services/inFlightCode.ts?ref=${HEAD_SHA}`,
        patch: '@@ -0,0 +1,97 @@',
      },
      {
        filename: 'lib/git/providers/github.ts',
        status: 'modified',
        patch: '@@ -1,8 +1,15 @@',
      },
      {
        filename: 'lib/old/name.ts',
        status: 'removed',
      },
      {
        filename: 'lib/new/name.ts',
        previous_filename: 'lib/was/name.ts',
        status: 'renamed',
      },
    ],
  };
}

/** A recorded GitLab `repository/compare` payload for the same change. */
function gitlabComparePayload() {
  return {
    commit: { id: HEAD_SHA, short_id: HEAD_SHA.slice(0, 8), title: 'feat' },
    commits: [{ id: HEAD_SHA }],
    diffs: [
      {
        old_path: 'lib/services/inFlightCode.ts',
        new_path: 'lib/services/inFlightCode.ts',
        a_mode: '0',
        b_mode: '100644',
        diff: '@@ -0,0 +1,97 @@',
        new_file: true,
        renamed_file: false,
        deleted_file: false,
      },
      {
        old_path: 'lib/git/providers/github.ts',
        new_path: 'lib/git/providers/github.ts',
        a_mode: '100644',
        b_mode: '100644',
        diff: '@@ -1,8 +1,15 @@',
        new_file: false,
        renamed_file: false,
        deleted_file: false,
      },
      {
        old_path: 'lib/old/name.ts',
        new_path: 'lib/old/name.ts',
        a_mode: '100644',
        b_mode: '0',
        diff: '',
        new_file: false,
        renamed_file: false,
        deleted_file: true,
      },
      {
        old_path: 'lib/was/name.ts',
        new_path: 'lib/new/name.ts',
        a_mode: '100644',
        b_mode: '100644',
        diff: '',
        new_file: false,
        renamed_file: true,
        deleted_file: false,
      },
    ],
    compare_timeout: false,
    compare_same_ref: false,
    web_url: `https://gitlab.com/moooon-gl/platform/motir-web/-/compare/${BASE_SHA}...${HEAD_SHA}`,
  };
}

const EXPECTED_FILES = [
  { path: 'lib/services/inFlightCode.ts', status: 'added' },
  { path: 'lib/git/providers/github.ts', status: 'modified' },
  { path: 'lib/old/name.ts', status: 'removed' },
  { path: 'lib/new/name.ts', status: 'renamed', previousPath: 'lib/was/name.ts' },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The HTTP boundary for both hosts: GitHub's token mint + compare, GitLab's
 *  compare. Everything else is a 404 the test would notice. */
function stubHosts() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/app/installations/') && u.endsWith('/access_tokens')) {
      return json({ token: GH_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (u.startsWith('https://api.github.com/repos/moooon/motir-core/compare/')) {
      return json(githubComparePayload());
    }
    if (u.startsWith('https://gitlab.com/api/v4/projects/moooon-gl%2Fplatform%2Fmotir-web/')) {
      return json(gitlabComparePayload());
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * One project whose set holds a GitHub-connected repository (default branch
 * `trunk`) and a GitLab-connected one in a NESTED group (default branch
 * `develop`), plus a GitHub repository connected to the organisation but in no
 * set of this project.
 */
async function seedBothHosts() {
  const fx = await makeWorkItemFixture();
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: { installationId: 'gh-inst-1', accountLogin: 'moooon', accountType: 'User' },
    repos: [
      {
        providerRepoId: '111',
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'trunk',
        archived: false,
      },
      {
        providerRepoId: '222',
        owner: 'moooon',
        name: 'motir-secret',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const conn = await withSystemContext((tx) =>
    githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: 'gl-conn-1',
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        accountLogin: 'moooon-gl',
        accountType: 'User',
        accessTokenEncrypted: encryptToken(GL_TOKEN),
        refreshTokenEncrypted: encryptToken('glrt_story_gate_refresh'),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      tx,
    ),
  );
  const glRepo = await adminDb.githubRepo.create({
    data: {
      installationId: conn.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: '333',
      owner: 'moooon-gl/platform',
      name: 'motir-web',
      defaultBranch: 'develop',
      archived: false,
      provider: 'gitlab',
    },
  });
  const ghRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: fx.workspaceId, name: 'motir-core' },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: ghRepo.id,
    name: 'motir-core',
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: glRepo.id,
    name: 'motir-web',
  });
  return { fx, token: tokenFor(fx) };
}

function spyListChangedFiles(id: 'github' | 'gitlab') {
  const provider = getGitProvider(id) as GitProvider;
  return vi.spyOn(provider, 'listChangedFiles');
}

describe('story gate — the changed-files route through both providers', () => {
  // Every serialized body of this block, scanned for credentials by the last test.
  const bodies: string[] = [];

  async function changes(token: string, query: Record<string, string>) {
    const res = await repoChangesGET(req('repo-changes', token, query));
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  it('seam: route → provider, both hosts — the same result shape, default base = the mirrored branch', async () => {
    const fetchMock = stubHosts();
    const { token } = await seedBothHosts();
    const gh = spyListChangedFiles('github');
    const gl = spyListChangedFiles('gitlab');

    const viaGithub = await changes(token, { repoRef: 'moooon/motir-core', head: 'feat/x' });
    const viaGitlab = await changes(token, {
      repoRef: 'moooon-gl/platform/motir-web',
      head: 'feat/x',
    });

    expect(viaGithub.status).toBe(200);
    expect(viaGitlab.status).toBe(200);
    expect(viaGithub.body).toEqual({
      result: {
        outcome: 'ok',
        base: 'trunk',
        head: 'feat/x',
        files: EXPECTED_FILES,
        truncated: false,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
    });
    // The SAME answer from the other host, but for the mirrored default branch.
    expect(viaGitlab.body).toEqual({
      result: {
        outcome: 'ok',
        base: 'develop',
        head: 'feat/x',
        files: EXPECTED_FILES,
        truncated: false,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
    });

    // Each host was asked with the STORED coordinates and the mirrored base.
    expect(gh).toHaveBeenCalledWith('gh-inst-1', 'moooon', 'motir-core', 'trunk', 'feat/x');
    expect(gl).toHaveBeenCalledWith(
      'gl-conn-1',
      'moooon-gl/platform',
      'motir-web',
      'develop',
      'feat/x',
    );
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain(
      'https://api.github.com/repos/moooon/motir-core/compare/trunk...feat%2Fx',
    );
    expect(urls).toContain(
      'https://gitlab.com/api/v4/projects/moooon-gl%2Fplatform%2Fmotir-web/repository/compare?from=develop&to=feat%2Fx',
    );
  });

  it('seam: an explicit base overrides the mirrored branch on both hosts', async () => {
    stubHosts();
    const { token } = await seedBothHosts();
    for (const repoRef of ['moooon/motir-core', 'moooon-gl/platform/motir-web']) {
      const r = await changes(token, { repoRef, head: 'feat/x', base: 'release' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: { outcome: 'ok', base: 'release', head: 'feat/x' } });
    }
  });

  it('guard: credential boundary — an out-of-set repoRef is 404 with the provider double uncalled', async () => {
    const fetchMock = stubHosts();
    const { token } = await seedBothHosts();
    const fail = () => {
      throw new Error('the provider must not be called for a repository outside the set');
    };
    const gh = spyListChangedFiles('github').mockImplementation(fail);
    const gl = spyListChangedFiles('gitlab').mockImplementation(fail);

    for (const repoRef of [
      'moooon/motir-secret', // connected to the organisation, in no set of this project
      'nobody/at-all', // connected nowhere
      'moooon-gl/motir-web', // the GitLab repo under a WRONG owner
    ]) {
      const r = await changes(token, { repoRef, head: 'feat/x' });
      expect(r.status, repoRef).toBe(404);
      expect(r.body).toMatchObject({ code: 'REPO_NOT_IN_PROJECT' });
    }
    expect(gh).not.toHaveBeenCalled();
    expect(gl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('guard: credential boundary — a repository in the SAME set of another workspace’s project is 404', async () => {
    stubHosts();
    await seedBothHosts();
    // A second tenant whose token names the first tenant's repository.
    const stranger = await makeWorkItemFixture({ name: 'Stranger' });
    const gh = spyListChangedFiles('github');
    const gl = spyListChangedFiles('gitlab');
    for (const repoRef of ['moooon/motir-core', 'moooon-gl/platform/motir-web']) {
      const r = await changes(tokenFor(stranger), { repoRef, head: 'feat/x' });
      expect(r.status, repoRef).toBe(404);
    }
    expect(gh).not.toHaveBeenCalled();
    expect(gl).not.toHaveBeenCalled();
  });

  it('seam: a repoRef that is not owner/name is the same 404, with no provider call', async () => {
    const fetchMock = stubHosts();
    const { token } = await seedBothHosts();
    const gh = spyListChangedFiles('github');
    const gl = spyListChangedFiles('gitlab');
    const r = await changes(token, { repoRef: 'motir-core', head: 'feat/x' });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'REPO_NOT_IN_PROJECT' });
    expect(gh).not.toHaveBeenCalled();
    expect(gl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('seam: a connection whose provider this deployment does not register is not_connected, not a 500', async () => {
    const fetchMock = stubHosts();
    const { token } = await seedBothHosts();
    await adminDb.githubInstallation.update({
      where: { installationId: 'gl-conn-1' },
      data: { provider: 'bitbucket' },
    });
    const r = await changes(token, { repoRef: 'moooon-gl/platform/motir-web', head: 'feat/x' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      result: { outcome: 'not_connected', base: 'develop', head: 'feat/x' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('seam: a provider that THROWS is a named host_error at 200, whatever it threw', async () => {
    stubHosts();
    const { token } = await seedBothHosts();
    spyListChangedFiles('github').mockRejectedValueOnce(new Error('socket hang up'));
    spyListChangedFiles('gitlab').mockRejectedValueOnce('not an Error');

    const gh = await changes(token, { repoRef: 'moooon/motir-core', head: 'feat/x' });
    expect(gh.status).toBe(200);
    expect(gh.body).toEqual({
      result: { outcome: 'host_error', base: 'trunk', head: 'feat/x', detail: 'socket hang up' },
    });
    const gl = await changes(token, { repoRef: 'moooon-gl/platform/motir-web', head: 'feat/x' });
    expect(gl.status).toBe(200);
    expect(gl.body).toEqual({
      result: { outcome: 'host_error', base: 'develop', head: 'feat/x', detail: 'unknown' },
    });
  });

  it('seam: an UNEXPECTED service failure propagates — the route’s 404 catch is narrow', async () => {
    stubHosts();
    const { token } = await seedBothHosts();
    vi.spyOn(repoChangesService, 'listChangedFiles').mockRejectedValueOnce(
      new Error('connection terminated unexpectedly'),
    );
    await expect(
      repoChangesGET(req('repo-changes', token, { repoRef: 'moooon/motir-core', head: 'feat/x' })),
    ).rejects.toThrow('connection terminated unexpectedly');
  });

  it('guard: credential boundary — no response body carries the minted token or an x-access-token URL', async () => {
    // Runs LAST in this block: `bodies` holds every body the cases above served.
    // One more pair is added here so the scan never runs over an empty list.
    stubHosts();
    const { token } = await seedBothHosts();
    await changes(token, { repoRef: 'moooon/motir-core', head: 'feat/x' });
    await changes(token, { repoRef: 'moooon-gl/platform/motir-web', head: 'feat/x' });

    // 2 + 2 + 3 + 2 + 1 + 1 + 2 from the cases above, and the 2 here.
    expect(bodies).toHaveLength(15);
    for (const body of bodies) {
      expect(body).not.toContain(GH_TOKEN);
      expect(body).not.toContain(GL_TOKEN);
      expect(body).not.toContain('glrt_story_gate_refresh');
      expect(body).not.toMatch(/x-access-token/i);
      expect(body).not.toMatch(/https?:\/\//i);
      expect(body).not.toContain('Bearer');
      expect(body).not.toContain(SERVICE_SECRET);
      expect(body).not.toContain('@@ ');
    }
  });
});
