import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { withUserContext } from '@/lib/workspaces/context';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// COLLABORATOR ACCESS over real Postgres (Story MOTIR-1775 · MOTIR-1900).
//
// The card's own framing is the test plan. Every repository Motir creates lives
// in MOTIR's org and is PRIVATE, so what is pinned here is that the approving
// user can actually get INTO their code — and, just as load-bearing, that failing
// to let them in never damages what they already have:
//
//   1. Establishing a set for a user WITH a connected identity invites them to
//      every created repository, as an ADMIN, at the realized coordinates.
//   2. A user with NO identity is not invited and gets the connect-prompt signal
//      (`login: null`) — and the establish itself still succeeds, because the
//      access step is a step AFTER approval, never a gate before it.
//   3. Connecting later and running the pass invites them then. That is the whole
//      default-path journey: approve → code exists → connect → invited.
//   4. A GitHub refusal does NOT fail the row: the repository stays `created`, the
//      row stays retryable, and the pass reports the failure per row.
//   5. The three access states derive correctly, including the `204`
//      already-has-access path, which is `accepted` with no invitation to open.
//   6. `connected` rows (the user's OWN repositories) are never invited to.
//   7. Acceptance is OBSERVED, not assumed — a refresh reads GitHub and settles.
//   8. A REAL-CONCURRENCY test: two simultaneous grant passes produce one
//      consistent state and no lost update.
//
// Real Postgres; the ONLY fake is `fetch` (the GitHub HTTP boundary — the shipped
// convention for these suites).

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const LOGIN = 'yuezhu';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let existingRepos: Map<string, number>;
/** Repo names whose INVITE the fake GitHub refuses, and with which status. */
let inviteRefusals: Map<string, number>;
/** Logins the fake GitHub reports as ALREADY collaborators, per repo name. */
let collaborators: Set<string>;
/** Repo names whose invite answers `204` (the account already has access). */
let alreadyHasAccess: Set<string>;
let nextRepoId: number;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** `/repos/{org}/{name}/collaborators/{login}` → the repo name and the login. */
function parseCollaboratorPath(u: string): { name: string; login: string } | null {
  const m = /\/repos\/[^/]+\/([^/]+)\/collaborators\/([^/?]+)$/.exec(u);
  return m ? { name: m[1]!, login: m[2]! } : null;
}

/**
 * A GitHub good enough to be worth asserting against: it resolves the
 * provisioning installation, mints tokens, creates and serves repositories, and
 * — the half this suite is about — invites collaborators and answers whether one
 * has access.
 */
function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: u, method, body });

      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }

      // ── The collaborator half ──────────────────────────────────────────────
      const collab = parseCollaboratorPath(u);
      if (collab && method === 'PUT') {
        const refusal = inviteRefusals.get(collab.name);
        if (refusal) return json(refusal, { message: 'Must have admin rights to Repository.' });
        if (alreadyHasAccess.has(collab.name)) {
          collaborators.add(`${collab.name}:${collab.login}`);
          return noContent();
        }
        return json(201, {
          id: 987,
          html_url: `https://github.com/${MOTIR_ORG}/${collab.name}/invitations`,
        });
      }
      if (collab && method === 'GET') {
        return collaborators.has(`${collab.name}:${collab.login}`)
          ? noContent()
          : json(404, { message: 'Not Found' });
      }

      // ── The creation half (the shipped primitive's fake, unchanged) ────────
      if (
        method === 'POST' &&
        (u.includes('/generate') || u.endsWith(`/orgs/${MOTIR_ORG}/repos`))
      ) {
        const name = String(body?.['name']);
        const id = nextRepoId++;
        existingRepos.set(name, id);
        return json(201, { id, name, owner: { login: MOTIR_ORG } });
      }
      if (method === 'GET' && u.includes(`/repos/${MOTIR_ORG}/`)) {
        const name = u.split('/').pop()!;
        const id = existingRepos.get(name);
        if (!id) return json(404, { message: 'Not Found' });
        return json(200, { id, name, owner: { login: MOTIR_ORG }, default_branch: 'main' });
      }
      // The CI stub's contents PUT.
      if (method === 'PUT') return json(201, { content: {} });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

/** Give the fixture's owner a connected GitHub identity — grant 1, the ONLY
 *  thing the access step needs. */
async function connectGithub(fx: WorkItemFixture, login = LOGIN): Promise<void> {
  await withUserContext(fx.ownerId, (tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId: fx.ownerId,
        githubUserId: '4242',
        githubLogin: login,
        avatarUrl: 'https://avatars.example/yuezhu.png',
        accessTokenEncrypted: 'encrypted-not-read-here',
      },
      tx,
    ),
  );
}

async function addRow(fx: WorkItemFixture, role: 'web' | 'api', name: string): Promise<string> {
  const row = await projectRepoSetService.addRow(fx.projectId, { role, name }, fx.ctx);
  return row.id;
}

async function readRow(fx: WorkItemFixture, rowId: string) {
  const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
  return rows.find((r) => r.id === rowId)!;
}

/** Every collaborator PUT the fake saw, as `name → body`. */
function invitePuts(): Call[] {
  return calls.filter((c) => c.method === 'PUT' && parseCollaboratorPath(c.url) !== null);
}

beforeEach(async () => {
  await truncateAuthTables();
  calls = [];
  existingRepos = new Map();
  inviteRefusals = new Map();
  collaborators = new Set();
  alreadyHasAccess = new Set();
  nextRepoId = 900_001;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _setReadinessPollForTests({ attempts: 2, delayMs: 0 });
  installGitHub();
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
  // The invite path logs its own row-level failures; keep the suite's output to
  // its assertions.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _setReadinessPollForTests(null);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('establishing a set invites the approving user', () => {
  it('invites them to EVERY created repository, as an admin, at the realized coordinates', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    const webId = await addRow(fx, 'web', 'acme-web');
    const apiId = await addRow(fx, 'api', 'acme-api');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // The invite rides the establish itself — the user does not have to ask.
    const puts = invitePuts();
    expect(puts).toHaveLength(2);
    expect(puts.map((p) => p.url.replace(/^.*\/repos\//, ''))).toEqual([
      `${MOTIR_ORG}/acme-web/collaborators/${LOGIN}`,
      `${MOTIR_ORG}/acme-api/collaborators/${LOGIN}`,
    ]);
    // ADMIN, per the card: the repository is theirs in every sense but the
    // account it sits under.
    expect(puts.every((p) => p.body?.['permission'] === 'admin')).toBe(true);

    for (const id of [webId, apiId]) {
      const row = await readRow(fx, id);
      expect(row.state).toBe('created');
      expect(row.access).toMatchObject({ state: 'invited', login: LOGIN });
      expect(row.access.invitationUrl).toContain('/invitations');
    }
  });

  it('a `204` (the account already has access) settles the row as ACCEPTED, with nothing to open', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    alreadyHasAccess.add('acme-web');
    const rowId = await addRow(fx, 'web', 'acme-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const row = await readRow(fx, rowId);
    // There was never an invitation to accept, so offering "Open the invitation"
    // would point at nothing.
    expect(row.access).toEqual({ state: 'accepted', login: LOGIN, invitationUrl: null });
  });
});

describe('a user who has NOT connected GitHub', () => {
  it('is not invited, and the establish still succeeds — the access step is not a gate', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // The repository was created and the plan is untouched. This is the whole
    // point of the ordering: nothing about GitHub can cost the user their code.
    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    expect(invitePuts()).toHaveLength(0);
    const row = await readRow(fx, rowId);
    expect(row.state).toBe('created');
    expect(row.access).toEqual({ state: 'not_invited', login: null, invitationUrl: null });
  });

  it('gets the CONNECT-PROMPT signal from the pass — a null login, not an error', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const result = await projectRepoAccessService.grantAccess(fx.projectId, fx.ctx);

    expect(result.login).toBeNull();
    expect(result.invited).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.rows).toHaveLength(1);
  });

  it('is invited once they connect and the pass runs — the default-path journey end to end', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');
    // 1. Approve → the code exists, with no GitHub anywhere in it.
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect((await readRow(fx, rowId)).access.state).toBe('not_invited');

    // 2. Connect → 3. the access step's return trip.
    await connectGithub(fx);
    const result = await projectRepoAccessService.grantAccess(fx.projectId, fx.ctx);

    expect(result).toMatchObject({ login: LOGIN, invited: 1, failed: 0 });
    expect((await readRow(fx, rowId)).access).toMatchObject({ state: 'invited', login: LOGIN });
  });
});

describe('an invitation failure never damages the repository', () => {
  it('leaves the row `created` and reports the failure per row', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    inviteRefusals.set('acme-api', 403);
    const webId = await addRow(fx, 'web', 'acme-web');
    const apiId = await addRow(fx, 'api', 'acme-api');

    const established = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // BOTH repositories were created. The invite is a side effect after commit,
    // so a refusal cannot roll one back or report it as failed.
    expect(established.rows.map((r) => r.outcome)).toEqual(['created', 'created']);
    expect((await readRow(fx, webId)).state).toBe('created');
    const api = await readRow(fx, apiId);
    expect(api.state).toBe('created');
    expect(api.failureReason).toBeNull();
    // …and the row degrades to the state the UI renders with a way forward.
    expect(api.access.state).toBe('not_invited');

    // Rows are independent: the sibling kept its own outcome.
    expect((await readRow(fx, webId)).access.state).toBe('invited');

    // An explicit pass counts it rather than throwing.
    const result = await projectRepoAccessService.grantAccess(fx.projectId, fx.ctx);
    expect(result.failed).toBe(1);
    expect(result.login).toBe(LOGIN);
  });

  it('is retryable — a later pass succeeds once GitHub stops refusing', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    inviteRefusals.set('acme-web', 500);
    const rowId = await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect((await readRow(fx, rowId)).access.state).toBe('not_invited');

    inviteRefusals.clear();
    await projectRepoAccessService.grantAccess(fx.projectId, fx.ctx, { rowId });

    expect((await readRow(fx, rowId)).access.state).toBe('invited');
  });
});

describe('what is NOT invited to', () => {
  it('never invites to a `connected` row — that repository is already the user’s own', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    // A `proposed` row pointed at a repository the user ALREADY has — the shape
    // "Use one of mine" produces, and the only way a row reaches `connected`.
    const rowId = await addRow(fx, 'web', 'their-own-monorepo');
    const mirrored = await githubInstallationService.persistProvisionedRepo({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: INSTALLATION_ID,
        accountLogin: LOGIN,
        accountType: 'User',
      },
      repo: {
        providerRepoId: '777001',
        owner: LOGIN,
        name: 'their-own-monorepo',
        defaultBranch: 'main',
      },
    });
    calls = [];

    const connected = await projectRepoSetService.attachRealizedRepo(rowId, mirrored.id, fx.ctx);
    expect(connected.state).toBe('connected');

    const result = await projectRepoAccessService.grantAccess(fx.projectId, fx.ctx);

    // Neither the establish seam's own hook nor an explicit pass invites to it.
    expect(invitePuts()).toHaveLength(0);
    expect(result.invited).toBe(0);
    expect((await readRow(fx, rowId)).access.state).toBe('not_invited');
  });

  it('never invites to a `skipped` row — there is nothing to be invited to', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    const rowId = await addRow(fx, 'web', 'acme-web');
    await projectRepoSetService.skipRow(rowId, fx.ctx);
    calls = [];

    const result = await projectRepoAccessService.grantAccess(fx.projectId, fx.ctx);

    expect(invitePuts()).toHaveLength(0);
    expect(result.invited).toBe(0);
  });

  it('a `rowId` narrows the pass to ONE row, leaving its siblings alone', async () => {
    const fx = await makeWorkItemFixture();
    const webId = await addRow(fx, 'web', 'acme-web');
    await addRow(fx, 'api', 'acme-api');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    await connectGithub(fx);
    calls = [];

    await projectRepoAccessService.grantAccess(fx.projectId, fx.ctx, { rowId: webId });

    // Rows are independent, so a **Resend** on one must not quietly re-send the
    // other's invitation.
    expect(invitePuts()).toHaveLength(1);
    expect(invitePuts()[0]!.url).toContain('acme-web');
  });
});

describe('acceptance is OBSERVED, never assumed', () => {
  it('stays `invited` until GitHub reports the account a collaborator, then settles', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    const rowId = await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // GitHub tells Motir nothing when an invitation is accepted, so before the
    // read the honest answer is still "pending".
    let rows = await projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx);
    expect(rows.find((r) => r.id === rowId)!.access.state).toBe('invited');

    // The user accepts on GitHub…
    collaborators.add(`acme-web:${LOGIN}`);
    rows = await projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx);

    const row = rows.find((r) => r.id === rowId)!;
    expect(row.access.state).toBe('accepted');
    // The pending invitation is gone the moment it is accepted, so its URL goes
    // with it rather than being left to point at a 404.
    expect(row.access.invitationUrl).toBeNull();
  });

  it('is MONOTONIC — a repeat refresh keeps the original acceptance stamp', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    const rowId = await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    collaborators.add(`acme-web:${LOGIN}`);
    await projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx);
    const first = await db.projectRepo.findUniqueOrThrow({ where: { id: rowId } });

    await projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx);
    const second = await db.projectRepo.findUniqueOrThrow({ where: { id: rowId } });

    expect(second.collaboratorAcceptedAt).toEqual(first.collaboratorAcceptedAt);
  });

  it('an already-accepted row is not re-invited by a later pass', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    collaborators.add(`acme-web:${LOGIN}`);
    await projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx);
    calls = [];

    const result = await projectRepoAccessService.grantAccess(fx.projectId, fx.ctx);

    expect(invitePuts()).toHaveLength(0);
    expect(result.invited).toBe(0);
  });
});

describe('concurrency — two grant passes race', () => {
  it('produce ONE consistent state and no lost update', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    const rowId = await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // A poll and a **Resend**, two tabs, two members — the check-then-write shape
    // this row's lock exists for. Only a WARM pool can fail this; a serial
    // version of the same test cannot.
    const [a, b] = await Promise.all([
      projectRepoAccessService.grantAccess(fx.projectId, fx.ctx),
      projectRepoAccessService.grantAccess(fx.projectId, fx.ctx),
    ]);

    // Both passes legitimately succeed: the GitHub call is idempotent (a repeat
    // updates the pending invitation rather than making a second), so what had to
    // be protected was the ROW.
    expect(a.failed).toBe(0);
    expect(b.failed).toBe(0);
    const row = await readRow(fx, rowId);
    expect(row.access).toMatchObject({ state: 'invited', login: LOGIN });
    expect(row.access.invitationUrl).toContain('/invitations');
  });

  it('a resend racing an ACCEPTANCE never rewinds the row to merely invited', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    const rowId = await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    collaborators.add(`acme-web:${LOGIN}`);

    // The lost update this lock exists to prevent: an invite write that cleared
    // `collaboratorAcceptedAt` would tell a user who HAS access to go accept an
    // invitation that no longer exists.
    await Promise.all([
      projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx),
      projectRepoAccessService.grantAccess(fx.projectId, fx.ctx),
    ]);

    const stored = await db.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
    expect(stored.collaboratorAcceptedAt).not.toBeNull();
    expect((await readRow(fx, rowId)).access.state).toBe('accepted');
  });
});
