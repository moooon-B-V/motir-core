import { generateKeyPairSync } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { encodeInstallState } from '@/lib/github/installState';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { MigrateOnboardingExitConditionError } from '@/lib/migrateOnboarding/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';
import { randomInt } from '../helpers/random';

// ONBOARDING LINKS AN ALREADY-INSTALLED ACCOUNT — the whole server-side journey
// the connect step drives (Story MOTIR-8245 · MOTIR-8765), against a real
// Postgres, with two organisations sharing ONE installation.
//
// Each route is pinned alone by `connectFlowApi.test.ts`, and the onboarding
// `select_repos` redirect alone by `setupOutcomes.integration.test.ts`. What only
// the CHAIN shows is asserted here: the `installation_id` the setup callback
// hands back is the id the reads and the link accept, and once the link lands
// the onboarding connect read and the step's exit gate both see it.
//
// The account `acme` (installation 4242) holds repositories 1..5. Organisation X
// links 1 and 2. Organisation Y is the person's, with a migrate run at `connect`
// in its first workspace and a second workspace beside it.
//
// GitHub is faked at `fetch`; the session and workspace resolvers are mocked
// because the test environment has no cookies; the motir-ai client and the index
// enqueue are mocked so the migrate service loads and the gate's kick is inert.

const PASSWORD = 'hunter2hunter2';
const SECRET = 'test-better-auth-secret-abcdef0123456789';
const INSTALLATION = '4242';

const session: { userId: string | null } = { userId: null };
const workspace: { id: string | null } = { id: null };

vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>()),
  requireCompliantSession: async () =>
    session.userId
      ? { ok: true, session: { user: { id: session.userId } } }
      : { ok: false, response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }) },
  resolveTwoFactorHold: async () => null,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => (session.userId ? { user: { id: session.userId } } : null),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    session.userId && workspace.id ? { userId: session.userId, workspaceId: workspace.id } : null,
}));
vi.mock('@/lib/github/indexEnqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/indexEnqueue')>()),
  enqueueCodeGraphIndex: vi.fn(async () => {}),
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'a', conventionJobId: 'c' })),
  getPreplanState: vi.fn(async () => ({ session: null, docs: [], catalog: null })),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { migrateOnboardingService } = await import('@/lib/services/migrateOnboardingService');
const accountsRoute = await import('@/app/api/organizations/[orgId]/github/accounts/route');
const reposRoute =
  await import('@/app/api/organizations/[orgId]/github/accounts/[installationId]/repositories/route');
const installationsRoute =
  await import('@/app/api/organizations/[orgId]/github/installations/route');
const setupRoute = await import('@/app/api/github/setup/route');
const connectStateRoute = await import('@/app/api/onboarding/migrate/[id]/connect-state/route');

/** Installations each user token can see on GitHub, by token. */
let userInstallations: Record<string, { id: number; login: string }[]> = {};

function stubGithub(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_APP_SLUG', 'motir-test');
  const json = (o: unknown): Response =>
    new Response(JSON.stringify(o), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/user/installations')) {
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        const token = auth.replace(/^Bearer /, '');
        return json({
          installations: (userInstallations[token] ?? []).map((i) => ({
            id: i.id,
            app_id: 999,
            repository_selection: 'selected',
            account: { login: i.login, type: 'Organization', avatar_url: null },
          })),
        });
      }
      if (url.includes('/access_tokens')) {
        return json({
          token: 'ghs_app',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.includes('/installation/repositories')) {
        return json({
          repositories: [1, 2, 3, 4, 5].map((id) => ({
            id,
            name: `r${id}`,
            owner: { login: 'acme' },
            default_branch: 'main',
          })),
        });
      }
      if (url.includes('/app/installations/')) {
        return json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

interface X {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
}

interface Y extends X {
  /** The migrate run, at `connect`, in Y's first workspace. */
  runId: string;
  /** A second workspace of the same organisation, with its own run. */
  secondWorkspaceId: string;
  secondRunId: string;
}

async function makeX(): Promise<X> {
  const user = await usersService.createUser({
    email: 'x@example.com',
    password: PASSWORD,
    name: 'Owner X',
  });
  const { workspace: ws } = await workspacesService.createWorkspace({
    name: 'Xenon Holdings',
    ownerUserId: user.id,
  });
  const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: ws.id } });
  return { organizationId: row.organizationId, workspaceId: ws.id, ownerId: user.id };
}

async function makeY(): Promise<Y> {
  const user = await usersService.createUser({
    email: 'y@example.com',
    password: PASSWORD,
    name: 'Owner Y',
  });
  const { workspace: first } = await workspacesService.createWorkspace({
    name: 'Yonder',
    ownerUserId: user.id,
  });
  // The free tier caps an organisation at one workspace; a second needs a plan.
  await adminDb.organization.update({
    where: { id: first.organizationId },
    data: { scaledTrackerSubscription: { status: 'active', seats: 5 } },
  });
  const { workspace: second } = await workspacesService.createWorkspace({
    name: 'Yonder two',
    ownerUserId: user.id,
    organizationId: first.organizationId,
  });
  const runIn = async (workspaceId: string): Promise<string> => {
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: user.id,
      name: 'Onboarded',
      identifier: `Y${randomInt(100, 1000)}`,
    });
    const run = await migrateOnboardingService.startMigration(project.id, {
      userId: user.id,
      workspaceId,
    });
    return run.id;
  };
  return {
    organizationId: first.organizationId,
    workspaceId: first.id,
    ownerId: user.id,
    runId: await runIn(first.id),
    secondWorkspaceId: second.id,
    secondRunId: await runIn(second.id),
  };
}

async function connectIdentity(userId: string, token: string): Promise<void> {
  await adminDb.githubIdentity.create({
    data: {
      userId,
      githubUserId: `gh-${userId}`,
      githubLogin: `login-${userId}`,
      accessTokenEncrypted: encryptToken(token),
    },
  });
}

function signIn(userId: string, workspaceId: string): void {
  session.userId = userId;
  workspace.id = workspaceId;
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

/** Every response body the journey read, so none can name X (checked once, at the end). */
let bodies: string[] = [];

interface Answer<T> {
  status: number;
  body: T;
}

async function answer<T>(res: Response): Promise<Answer<T>> {
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: JSON.parse(text) as T };
}

interface AccountsBody {
  state?: string;
  code?: string;
  accounts?: { installationId: string; linkState: string }[];
}
interface ReposBody {
  code?: string;
  repos?: { repoId: string; fullName: string; availability: string }[];
  counts?: { available: number; connectedHere: number; connectedElsewhere: number };
}
interface LinkBody {
  code?: string;
  repos?: { repoId: string; fullName: string }[];
  repoIds?: string[];
}
interface ConnectStateBody {
  organizationId: string;
  outcome: string;
  repositories: { repoRef: string }[];
}

async function getAccounts(orgId: string) {
  return answer<AccountsBody>(
    await accountsRoute.GET(new Request('http://localhost/x'), params({ orgId })),
  );
}
async function getRepos(orgId: string, installationId: string) {
  return answer<ReposBody>(
    await reposRoute.GET(new Request('http://localhost/x'), params({ orgId, installationId })),
  );
}
async function postLink(orgId: string, body: unknown) {
  return answer<LinkBody>(
    await installationsRoute.POST(
      new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }),
      params({ orgId }),
    ),
  );
}
async function connectState(runId: string) {
  return answer<ConnectStateBody>(
    await connectStateRoute.GET(
      new Request(`http://localhost:3000/api/onboarding/migrate/${runId}/connect-state`),
      params({ id: runId }),
    ),
  );
}

/** The onboarding connect step's install round trip, for a pick of 4242. */
async function returnFromGithub(y: Y): Promise<URL> {
  const state = encodeInstallState({
    workspaceId: y.workspaceId,
    userId: y.ownerId,
    origin: 'onboardingMigrateConnect',
  });
  const res = await setupRoute.GET(
    new NextRequest(
      `http://localhost:3000/api/github/setup?installation_id=${INSTALLATION}&setup_action=install&state=${encodeURIComponent(state)}`,
    ),
  );
  return new URL(res.headers.get('location')!);
}

/** The step's exit gate (`CONNECT.checkExit`), through the one door that runs it. */
async function exitHolds(runId: string, workspaceId: string, userId: string): Promise<boolean> {
  try {
    const advanced = await migrateOnboardingService.advanceNext(runId, { userId, workspaceId });
    expect(advanced.step).toBe('index');
    return true;
  } catch (err) {
    if (err instanceof MigrateOnboardingExitConditionError) return false;
    throw err;
  }
}

async function ownedBy(organizationId: string): Promise<string[]> {
  const rows = await adminDb.githubRepo.findMany({
    where: { organizationId },
    orderBy: { repoId: 'asc' },
  });
  return rows.map((r) => r.repoId);
}

/** Everything X holds on the GitHub side. */
async function snapshotX(x: X) {
  return {
    repos: await adminDb.githubRepo.findMany({
      where: { organizationId: x.organizationId },
      orderBy: { repoId: 'asc' },
    }),
    links: await adminDb.githubInstallationOrgLink.findMany({
      where: { organizationId: x.organizationId },
      orderBy: { id: 'asc' },
    }),
  };
}

/** What a body must never carry about X: its ids, its name and its slug. */
async function xMarks(x: X): Promise<string[]> {
  const org = await adminDb.organization.findUniqueOrThrow({ where: { id: x.organizationId } });
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: x.workspaceId } });
  return [x.organizationId, x.workspaceId, org.name, org.slug, ws.name].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}

let x: X;
let y: Y;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
  _resetInstallationTokenCache();
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  stubGithub();
  spyOnJobDispatch();
  bodies = [];
  x = await makeX();
  y = await makeY();
  await connectIdentity(x.ownerId, 'gho_x');
  await connectIdentity(y.ownerId, 'gho_y');
  userInstallations = {
    gho_x: [{ id: 4242, login: 'acme' }],
    gho_y: [{ id: 4242, login: 'acme' }],
  };
  await githubInstallationService.linkInstallationToOrganization({
    workspaceId: x.workspaceId,
    installationId: INSTALLATION,
    repoIds: ['1', '2'],
  });
  signIn(y.ownerId, y.workspaceId);
});

afterEach(async () => {
  // No body anywhere in the journey named the other organisation.
  const marks = await xMarks(x);
  for (const body of bodies) {
    for (const mark of marks) expect(body).not.toContain(mark);
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  session.userId = null;
  workspace.id = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('return, list, pick, link, exit', () => {
  it('the select_repos id is the one the reads and the link accept, and the exit then holds', async () => {
    const xBefore = await snapshotX(x);

    const to = await returnFromGithub(y);
    expect(to.pathname).toBe('/onboarding/migrate');
    expect(to.searchParams.get('github')).toBe('select_repos');
    const installationId = to.searchParams.get('installation_id')!;
    expect(installationId).toBe(INSTALLATION);

    const accounts = await getAccounts(y.organizationId);
    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts).toMatchObject([{ installationId, linkState: 'not_linked' }]);

    const repos = await getRepos(y.organizationId, installationId);
    expect(repos.status).toBe(200);
    expect(Object.fromEntries(repos.body.repos!.map((r) => [r.repoId, r.availability]))).toEqual({
      '1': 'connected_elsewhere',
      '2': 'connected_elsewhere',
      '3': 'available',
      '4': 'available',
      '5': 'available',
    });

    // Before the link: the return and both reads wrote nothing, and nothing lets Y out.
    const before = await connectState(y.runId);
    expect(before.status).toBe(200);
    expect(before.body.repositories).toEqual([]);
    expect(before.body.outcome).not.toMatch(/connected/);
    expect(await exitHolds(y.runId, y.workspaceId, y.ownerId)).toBe(false);
    expect(await ownedBy(y.organizationId)).toEqual([]);
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(0);

    const linked = await postLink(y.organizationId, { installationId, repoIds: ['3'] });
    expect(linked.status).toBe(200);

    const after = await connectState(y.runId);
    expect(after.status).toBe(200);
    expect(after.body.organizationId).toBe(y.organizationId);
    expect(after.body.repositories.map((r) => r.repoRef)).toEqual(['acme/r3']);
    expect(after.body.outcome).toBe('already_connected');
    expect(await exitHolds(y.runId, y.workspaceId, y.ownerId)).toBe(true);

    const again = await getAccounts(y.organizationId);
    expect(again.body.accounts).toMatchObject([{ installationId, linkState: 'linked_here' }]);

    // The other organisation is untouched, and Y owns exactly its pick.
    expect(await snapshotX(x)).toEqual(xBefore);
    expect(await ownedBy(x.organizationId)).toEqual(['1', '2']);
    expect(await ownedBy(y.organizationId)).toEqual(['3']);
  });

  it("a second workspace of Y's organisation is connected too, once the link lands", async () => {
    // Signed in to the first workspace, the second workspace's run is not found.
    expect((await connectState(y.secondRunId)).status).toBe(404);

    signIn(y.ownerId, y.secondWorkspaceId);
    const unlinked = await connectState(y.secondRunId);
    expect(unlinked.body.repositories).toEqual([]);
    expect(await exitHolds(y.secondRunId, y.secondWorkspaceId, y.ownerId)).toBe(false);

    signIn(y.ownerId, y.workspaceId);
    expect(
      (await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: ['4'] })).status,
    ).toBe(200);

    signIn(y.ownerId, y.secondWorkspaceId);
    const linked = await connectState(y.secondRunId);
    expect(linked.status).toBe(200);
    expect(linked.body.repositories.map((r) => r.repoRef)).toEqual(['acme/r4']);
    expect(linked.body.outcome).toBe('already_connected');
    expect(await exitHolds(y.secondRunId, y.secondWorkspaceId, y.ownerId)).toBe(true);
  });
});

describe('the selection changes under the person', () => {
  it('taken meanwhile: a 409 naming the repository, nothing written, and a re-read offers the rest', async () => {
    const firstRead = await getRepos(y.organizationId, INSTALLATION);
    expect(firstRead.body.repos!.find((r) => r.repoId === '3')!.availability).toBe('available');

    // X takes repository 3 between Y's read and Y's confirm.
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1', '2', '3'],
    });
    const xBefore = await snapshotX(x);

    const refused = await postLink(y.organizationId, {
      installationId: INSTALLATION,
      repoIds: ['3', '4'],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('repository_owned_by_other_organization');
    expect(refused.body.repos!.map((r) => r.repoId)).toEqual(['3']);
    expect(await ownedBy(y.organizationId)).toEqual([]);
    expect((await connectState(y.runId)).body.repositories).toEqual([]);
    expect(await exitHolds(y.runId, y.workspaceId, y.ownerId)).toBe(false);

    const reread = await getRepos(y.organizationId, INSTALLATION);
    const availability = Object.fromEntries(
      reread.body.repos!.map((r) => [r.repoId, r.availability]),
    );
    expect(availability['3']).toBe('connected_elsewhere');
    expect(availability['4']).toBe('available');

    const ok = await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: ['4'] });
    expect(ok.status).toBe(200);
    expect(await ownedBy(y.organizationId)).toEqual(['4']);
    expect(await snapshotX(x)).toEqual(xBefore);
  });

  it('nothing left: no available row, and both counts are what the nothing-left state renders', async () => {
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1', '2', '3', '4', '5'],
    });
    const repos = await getRepos(y.organizationId, INSTALLATION);
    expect(repos.status).toBe(200);
    expect(repos.body.repos!.filter((r) => r.availability === 'available')).toEqual([]);
    expect(repos.body.counts).toEqual({ available: 0, connectedHere: 0, connectedElsewhere: 5 });
    expect(await exitHolds(y.runId, y.workspaceId, y.ownerId)).toBe(false);
  });

  it('no longer accessible: a 403 installation_not_accessible on the link and the read, nothing written', async () => {
    const xBefore = await snapshotX(x);
    userInstallations['gho_y'] = [];

    const refused = await postLink(y.organizationId, {
      installationId: INSTALLATION,
      repoIds: ['3'],
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ code: 'installation_not_accessible' });
    expect(await ownedBy(y.organizationId)).toEqual([]);

    const accounts = await getAccounts(y.organizationId);
    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts!.map((a) => a.installationId)).not.toContain(INSTALLATION);

    const repos = await getRepos(y.organizationId, INSTALLATION);
    expect(repos.status).toBe(403);
    expect(repos.body.code).toBe('installation_not_accessible');
    expect(await snapshotX(x)).toEqual(xBefore);
  });
});

describe('refusals the step must tell apart', () => {
  it('a plain member gets a 403 on every route whose body is NOT installation_not_accessible', async () => {
    const member = await usersService.createUser({
      email: 'member@example.com',
      password: PASSWORD,
      name: 'Member',
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: y.organizationId, userId: member.id, role: 'member' },
    });
    await connectIdentity(member.id, 'gho_member');
    userInstallations['gho_member'] = [{ id: 4242, login: 'acme' }];
    signIn(member.id, y.workspaceId);

    const refusals = [
      await getAccounts(y.organizationId),
      await getRepos(y.organizationId, INSTALLATION),
      await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: ['3'] }),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(403);
      // The shape the account-list and confirm cards map to "not an admin":
      // `{ code: 'ORG_FORBIDDEN', error: <a sentence> }`, read by its code.
      expect(refusal.body).toEqual({ code: 'ORG_FORBIDDEN', error: expect.any(String) });
      expect(refusal.body.code).not.toBe('installation_not_accessible');
    }
    expect(await ownedBy(y.organizationId)).toEqual([]);
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(0);
  });

  it('an invalid selection is refused with the codes the route ships, writing nothing', async () => {
    const xBefore = await snapshotX(x);

    const missing = await postLink(y.organizationId, { installationId: INSTALLATION });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('BAD_REQUEST');

    const empty = await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('BAD_REQUEST');

    const invisible = await postLink(y.organizationId, {
      installationId: INSTALLATION,
      repoIds: ['3', '99'],
    });
    expect(invisible.status).toBe(422);
    expect(invisible.body.code).toBe('repository_not_visible');

    expect(await ownedBy(y.organizationId)).toEqual([]);
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(0);
    expect(await exitHolds(y.runId, y.workspaceId, y.ownerId)).toBe(false);
    expect(await snapshotX(x)).toEqual(xBefore);
  });
});
