import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { dispatchRunGitCredentialsSchema } from '@/lib/api/v1/workLoop/schema';
import { DispatchRunNotFoundError } from '@/lib/dispatchRuns/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { hostedRunGitCredentialService } from '@/lib/services/hostedRunGitCredentialService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { bearer, createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/dispatch-runs/{id}/git-credential (Story MOTIR-683 · MOTIR-6538)
// — a running hosted run trades its OWN run credential for fresh git
// credentials, through the real bearer path (`withV1Route` →
// `authenticateApiToken`) against a real Postgres. GitHub is stubbed at the HTTP
// seam with a global `fetch` mock; nothing reaches github.com. The contract is
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5.
//
// ⚠️ EVERY REFUSAL IS DRIVEN. The route hands out a live token that can push
// code, so the doors it must NOT open — another run's credential, a person's
// PAT, a run that has ended — are each knocked on here.

const BASE = 'http://localhost:3000/api/v1';
const HOUR = 3_600_000;
const STUDIO_APP_ID = '111';
const INTEGRATION_APP_ID = '222';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const ACCEPTED = { contents: 'write', pull_requests: 'write', metadata: 'read' };

/** The App a JWT was signed for, read from its `iss` claim. */
function appIdOf(authorization: string): string {
  const jwt = authorization.replace(/^Bearer /, '');
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as {
    iss?: string;
  };
  return String(payload.iss);
}

let tokenSeq = 0;
let mints: { installation: string; app: string; body: Record<string, unknown> }[] = [];

function stubGithub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      const inst = /\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        const owner = inst[1] ?? '';
        const id = owner === 'motir-projects' ? 7 : 42;
        return json(200, {
          id,
          account: { login: owner },
          permissions: ACCEPTED,
          suspended_at: null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/${id}`,
        });
      }
      const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
      if (mint && method === 'POST') {
        tokenSeq += 1;
        mints.push({
          installation: mint[1] ?? '',
          app: appIdOf(headers.authorization ?? ''),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        return json(201, {
          token: `ghs_run_${tokenSeq}`,
          expires_at: new Date(Date.now() + HOUR).toISOString(),
        });
      }
      if (url.endsWith('/app') && method === 'GET') {
        return json(200, {
          slug:
            appIdOf(headers.authorization ?? '') === STUDIO_APP_ID
              ? 'motir-studio'
              : 'motir-integration',
        });
      }
      const user = /\/users\/(.+)$/.exec(url);
      if (user && method === 'GET') {
        const login = decodeURIComponent(user[1] ?? '');
        return json(200, { id: login === 'motir-studio[bot]' ? 1001 : 2002, login });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

let caller: V1ProjectCaller;
let seq = 0;

/** A project repository with a realized GitHub repository. */
async function seedRepo(opts: {
  state: 'created' | 'connected';
  owner: string;
  name: string;
}): Promise<string> {
  seq += 1;
  const f = caller.fixture;
  const organizationId = f.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${f.workspaceId}-${opts.owner}` },
    create: {
      installationId: `inst-${f.workspaceId}-${opts.owner}`,
      workspaceId: f.workspaceId,
      organizationId,
      accountLogin: opts.owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: f.workspaceId,
      organizationId,
      repoId: String(800_000 + seq),
      owner: opts.owner,
      name: opts.name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      role: 'web',
      name: opts.name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: opts.state,
      position: `a${String(seq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
  return row.id;
}

/** Open a hosted run over ONE card pinned to the given project repositories. */
async function openRun(projectRepoIds: string[]): Promise<string> {
  const f = caller.fixture;
  const item = await workItemsService.createWorkItem(
    { projectId: f.projectId, kind: 'task', title: 'a hosted card' },
    f.ctx,
  );
  for (const [position, projectRepoId] of projectRepoIds.entries()) {
    await adminDb.workItemRepo.create({
      data: { workspaceId: f.workspaceId, workItemId: item.id, projectRepoId, position },
    });
  }
  const { run } = await dispatchRunService.open(
    {
      projectKey: f.projectIdentifier,
      command: 'run',
      origin: 'hosted',
      model: 'claude-opus-5-5',
      cards: [{ key: item.identifier, disposition: 'queued' as const }],
    },
    f.ctx,
  );
  return run.id;
}

async function runTokenFor(runId: string): Promise<Record<string, string>> {
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId: runId,
    dispatcherUserId: caller.fixture.owner.id,
    expiresAt: new Date(Date.now() + HOUR),
  });
  return bearer(token);
}

async function issue(headers: Record<string, string>, id: string): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/git-credential/route');
  return POST(
    new Request(`${BASE}/dispatch-runs/${id}/git-credential`, { method: 'POST', headers }),
    { params: Promise.resolve({ id }) },
  );
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

const recorded = (runId: string) =>
  adminDb.dispatchRunGitCredential.findMany({
    where: { dispatchRunId: runId },
    orderBy: { createdAt: 'asc' },
  });

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
  mints = [];
  vi.stubEnv('GITHUB_STUDIO_APP_ID', STUDIO_APP_ID);
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', INTEGRATION_APP_ID);
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  stubGithub();
  caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/v1/dispatch-runs/{id}/git-credential (MOTIR-6538)', () => {
  it('AC1 — the run’s own credential gets a fresh token, a second call another, both recorded', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'shop' });
    const runId = await openRun([repo]);
    const headers = await runTokenFor(runId);

    const first = await issue(headers, runId);
    expect(first.status).toBe(200);
    const one = dispatchRunGitCredentialsSchema.parse(await first.json());
    const second = dispatchRunGitCredentialsSchema.parse(
      await (await issue(headers, runId)).json(),
    );

    expect(one.credentials).toHaveLength(1);
    expect(one.credentials[0]?.repository).toBe('motir-projects/shop');
    expect(second.credentials[0]?.token).not.toBe(one.credentials[0]?.token);
    expect(one.dispatchedBy).toBe(caller.fixture.owner.name);
    expect(await recorded(runId)).toHaveLength(2);
  });

  it('AC4 — a run over a Motir-created and a connected repository gets one entry each, each from its own App, all recorded', async () => {
    const created = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'shop' });
    const connected = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const runId = await openRun([created, connected]);

    const res = await issue(await runTokenFor(runId), runId);
    expect(res.status).toBe(200);
    const body = dispatchRunGitCredentialsSchema.parse(await res.json());

    const byRepo = new Map(body.credentials.map((c) => [c.repository, c]));
    expect([...byRepo.keys()].sort()).toEqual(['acme/api', 'motir-projects/shop']);
    // Each repository's author is the bot of the App that writes it — never the dispatcher.
    expect(byRepo.get('motir-projects/shop')?.authorName).toBe('motir-studio[bot]');
    expect(byRepo.get('acme/api')?.authorName).toBe('motir-integration[bot]');
    for (const c of body.credentials) {
      expect(c.authorName).not.toBe(caller.fixture.owner.name);
      expect(c.authorEmail).toMatch(/\[bot\]@users\.noreply\.github\.com$/);
    }
    // One mint per App installation, each by its own App.
    expect(mints.map((m) => m.app).sort()).toEqual([STUDIO_APP_ID, INTEGRATION_APP_ID].sort());
    const rows = await recorded(runId);
    expect(rows.map((r) => r.app).sort()).toEqual(['motir-integration', 'motir-studio']);
  });

  it('AC2 — 409 once the run is not running, and nothing is minted', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'shop' });
    const runId = await openRun([repo]);
    const headers = await runTokenFor(runId);
    await dispatchRunService.close(runId, { stopReason: 'completed' }, caller.fixture.ctx);

    const res = await issue(headers, runId);
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TERMINAL');
    expect(mints).toHaveLength(0);
    expect(await recorded(runId)).toHaveLength(0);
  });

  it('AC2 — 403 for a credential bound to ANOTHER run, the same for a run that does not exist', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'shop' });
    const own = await openRun([repo]);
    const other = await openRun([repo]);
    const headers = await runTokenFor(own);

    const res = await issue(headers, other);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');

    const missing = await issue(headers, 'no-such-run');
    expect(missing.status).toBe(403);
    expect(await codeOf(missing)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect(mints).toHaveLength(0);
  });

  it('AC2 — 403 for a person’s PAT, although its grant holds the route’s key', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'shop' });
    const runId = await openRun([repo]);

    const res = await issue(caller.headers, runId);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect(mints).toHaveLength(0);
  });

  it('AC2 — 404 for a run outside the caller’s workspace (the tenancy read), before any mint', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'shop' });
    const runId = await openRun([repo]);
    const elsewhere = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });

    // Over HTTP a foreign run token is refused by its binding first (403, above);
    // the workspace read is what stands behind it, driven here directly.
    await expect(
      hostedRunGitCredentialService.issue(runId, {
        ...elsewhere.fixture.ctx,
        tokenDispatchRunId: runId,
      }),
    ).rejects.toBeInstanceOf(DispatchRunNotFoundError);
    expect(mints).toHaveLength(0);
  });

  it('AC3 — the run credential reaches this route for its own run and still nothing it could not reach before', async () => {
    const repo = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'shop' });
    const runId = await openRun([repo]);
    const headers = await runTokenFor(runId);

    expect((await issue(headers, runId)).status).toBe(200);

    // A door the run-credential route test proves closed stays closed.
    const { GET } = await import('@/app/api/v1/workspaces/route');
    const other = await GET(new Request(`${BASE}/workspaces`, { headers }));
    expect(other.status).toBe(403);
    expect(await codeOf(other)).toBe('RUN_TOKEN_NOT_ALLOWED');
  });
});
