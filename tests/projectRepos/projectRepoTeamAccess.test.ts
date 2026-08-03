import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';

// TEAM CODE ACCESS over real Postgres (Story MOTIR-1775 · MOTIR-1910).
//
// The gap this card closes is the test plan. MOTIR-1900 let the APPROVING USER
// into the code Motir made; every repository is Motir-owned and private, so on a
// six-person workspace the other five could not clone it — and the record was
// four columns on the repository row, which hold one account, so there was
// nowhere to write that they may. What is pinned here:
//
//   1. The invitable set is `canEdit`, not a membership query — so an `open`
//      project's workspace member with NO ProjectMembership row IS invited, and a
//      `viewer` is not. This is the answer that moved during the decision, and
//      the reason it moved is a case a membership query gets WRONG.
//   2. The permission is per invitee: `push` for a teammate, `admin` kept for the
//      approving user — and a team sweep never DOWNGRADES the owner.
//   3. A member with no connected GitHub account is reported, not invited, with
//      the reason that is actionable only by them.
//   4. One member's GitHub refusal costs only that member — the row stays
//      `created`, every sibling invitation still lands, nothing rolls back.
//   5. The retrofit is honest about history: the owner's access survives, and the
//      establish path still grants `admin`.
//   6. Narrowing works per row AND per member, which is what a per-cell **Resend
//      invitation** needs.
//   7. A REAL-CONCURRENCY test: two simultaneous passes over one cell produce ONE
//      record and no lost update. The unique index is the guarantee; deleting the
//      lock must make this fail.
//
// Real Postgres; the ONLY fake is `fetch` (the GitHub HTTP boundary — the shipped
// convention for these suites).

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const OWNER_LOGIN = 'yuezhu';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let existingRepos: Map<string, number>;
/** Repo names whose INVITE the fake GitHub refuses, keyed `name:login`. */
let inviteRefusals: Set<string>;
let collaborators: Set<string>;
let nextRepoId: number;
let actionsVariables: ActionsVariableFake;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function parseCollaboratorPath(u: string): { name: string; login: string } | null {
  const m = /\/repos\/[^/]+\/([^/]+)\/collaborators\/([^/?]+)$/.exec(u);
  return m ? { name: m[1]!, login: m[2]! } : null;
}

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

      const collab = parseCollaboratorPath(u);
      if (collab && method === 'PUT') {
        if (inviteRefusals.has(`${collab.name}:${collab.login}`)) {
          return json(403, { message: 'Must have admin rights to Repository.' });
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
      if (method === 'PUT') return json(201, { content: {} });

      // The org's FLEET RUNNER VARIABLE (MOTIR-2015) — establishing a repository
      // now ensures `MOTIR_RUNNER`. The service swallows its own failures by
      // contract, so an unfaked call would be INVISIBLE here rather than loud: this
      // suite's `throw` below would be caught and discarded, leaving the seam
      // green, silent, and no longer describing what the product does.
      //
      // (This suite has no runner-GROUP fake and relies on that same swallow for
      // MOTIR-1972's sync — a pre-existing gap this card does not widen and does
      // not pretend to close.)
      const variable = actionsVariables.handle(u, method, body);
      if (variable) return variable;

      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

async function connectGithub(userId: string, login: string, githubUserId: string): Promise<void> {
  await withUserContext(userId, (tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId,
        githubUserId,
        githubLogin: login,
        avatarUrl: null,
        accessTokenEncrypted: 'encrypted-not-read-here',
      },
      tx,
    ),
  );
}

/**
 * Add a WORKSPACE member — and, optionally, a project membership + a connected
 * GitHub account. Deliberately built from the real tables rather than a helper,
 * because WHICH memberships exist is the thing under test: the `canEdit` answer
 * turns on the interaction between the two roles and the project's access level.
 */
async function addMember(
  fx: WorkItemFixture,
  opts: {
    email: string;
    workspaceRole?: 'owner' | 'admin' | 'member' | 'viewer';
    projectRole?: 'owner' | 'admin' | 'member' | 'viewer' | null;
    login?: string | null;
  },
): Promise<string> {
  const user = await db.user.create({
    data: { name: opts.email.split('@')[0]!, email: opts.email, emailVerified: true },
  });
  await db.workspaceMembership.create({
    data: {
      userId: user.id,
      workspaceId: fx.workspaceId,
      role: opts.workspaceRole ?? 'member',
    },
  });
  if (opts.projectRole) {
    await db.projectMembership.create({
      data: {
        userId: user.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        role: opts.projectRole,
      },
    });
  }
  if (opts.login) await connectGithub(user.id, opts.login, `gh-${user.id.slice(-6)}`);
  return user.id;
}

async function establishOneRepo(fx: WorkItemFixture, name = 'acme-web'): Promise<string> {
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx);
  await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
  return row.id;
}

/** Every collaborator PUT the fake saw. */
function invitePuts(): Call[] {
  return calls.filter((c) => c.method === 'PUT' && parseCollaboratorPath(c.url) !== null);
}

/** The permission each login was invited at, across every PUT. */
function invitedPermissions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of invitePuts()) {
    const p = parseCollaboratorPath(c.url)!;
    out.set(p.login, String(c.body?.['permission']));
  }
  return out;
}

function memberCell(
  access: Awaited<ReturnType<typeof projectRepoAccessService.listTeamAccess>>,
  rowId: string,
  userId: string,
) {
  return access.rows.find((r) => r.rowId === rowId)!.members.find((m) => m.userId === userId)!;
}

beforeEach(async () => {
  await truncateAuthTables();
  calls = [];
  existingRepos = new Map();
  inviteRefusals = new Set();
  collaborators = new Set();
  nextRepoId = 900_001;
  actionsVariables = createActionsVariableFake(MOTIR_ORG);
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

describe('who is invitable — the shipped canEdit policy, not a membership query', () => {
  it('invites a workspace member with NO project membership on an `open` project', async () => {
    // THE case a "every ProjectMembership whose role is not viewer" rule gets
    // wrong, and why the decision moved: on an `open` project a workspace member
    // edits everything with no project-membership row at all, so a membership
    // query would lock out someone who can already change the whole project.
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const teammate = await addMember(fx, {
      email: 'teammate@example.com',
      projectRole: null,
      login: 'teammate-gh',
    });
    const rowId = await establishOneRepo(fx);

    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);
    const access = await projectRepoAccessService.listTeamAccess(fx.projectId, fx.ctx);

    const cell = memberCell(access, rowId, teammate);
    expect(cell).toMatchObject({
      eligible: true,
      state: 'invited',
      login: 'teammate-gh',
      reason: null,
    });
  });

  it('never invites a project `viewer`, and says WHY', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const viewer = await addMember(fx, {
      email: 'viewer@example.com',
      projectRole: 'viewer',
      login: 'viewer-gh',
    });
    const rowId = await establishOneRepo(fx);
    calls = [];

    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);
    const access = await projectRepoAccessService.listTeamAccess(fx.projectId, fx.ctx);

    // Read-only everywhere means read-only here too — the code is not a side door
    // around the project's own access model.
    expect(invitedPermissions().has('viewer-gh')).toBe(false);
    expect(memberCell(access, rowId, viewer)).toMatchObject({
      eligible: false,
      state: 'not_invited',
      reason: 'role_cannot_edit',
    });
  });

  it('scopes a `private` project to its own members', async () => {
    const fx = await makeWorkItemFixture();
    await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    // In the workspace but NOT on the project: on `private` they cannot even
    // browse it, so they are not a candidate for its code.
    const outsider = await addMember(fx, {
      email: 'outsider@example.com',
      projectRole: null,
      login: 'outsider-gh',
    });
    const insider = await addMember(fx, {
      email: 'insider@example.com',
      projectRole: 'member',
      login: 'insider-gh',
    });
    const rowId = await establishOneRepo(fx);
    calls = [];

    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);
    const access = await projectRepoAccessService.listTeamAccess(fx.projectId, fx.ctx);

    expect(invitedPermissions().has('insider-gh')).toBe(true);
    expect(invitedPermissions().has('outsider-gh')).toBe(false);
    const row = access.rows.find((r) => r.rowId === rowId)!;
    expect(row.members.map((m) => m.userId)).toContain(insider);
    expect(row.members.map((m) => m.userId)).not.toContain(outsider);
  });
});

describe('the permission is PER INVITEE', () => {
  it('grants a teammate `push` while the approving user keeps `admin`', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const teammate = await addMember(fx, {
      email: 'teammate@example.com',
      projectRole: 'member',
      login: 'teammate-gh',
    });
    const rowId = await establishOneRepo(fx);
    calls = [];

    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);

    // A teammate clones, branches and pushes. They do NOT get the settings that
    // would let them transfer, rename or delete the project's repository — the
    // takeover path those exist for is the owner's alone.
    expect(invitedPermissions().get('teammate-gh')).toBe('push');
    expect(invitedPermissions().get(OWNER_LOGIN)).toBe('admin');

    const access = await projectRepoAccessService.listTeamAccess(fx.projectId, fx.ctx);
    expect(memberCell(access, rowId, teammate).permission).toBe('push');
    expect(memberCell(access, rowId, fx.ownerId).permission).toBe('admin');
  });

  it('a team sweep never DOWNGRADES the approving user the establish path made admin', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const rowId = await establishOneRepo(fx);

    // The establish path already granted admin; a later team pass runs over the
    // same cell. Silently rewriting it to `push` would strip the settings the
    // takeover (MOTIR-711) needs, from the one person entitled to them.
    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);

    const access = await projectRepoAccessService.listTeamAccess(fx.projectId, fx.ctx);
    expect(memberCell(access, rowId, fx.ownerId).permission).toBe('admin');
  });
});

describe('a member with no connected GitHub account', () => {
  it('is reported with an actionable-by-them-only reason, and is not a failure', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const unconnected = await addMember(fx, {
      email: 'nogh@example.com',
      projectRole: 'member',
      login: null,
    });
    const rowId = await establishOneRepo(fx);
    calls = [];

    const result = await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);

    // Motir cannot OAuth on their behalf, so there is no account to invite — and
    // that is a state to explain, never a red mark for something nobody did wrong.
    expect(result.skippedNoIdentity).toBe(1);
    expect(result.failed).toBe(0);
    expect(memberCell(result.access, rowId, unconnected)).toMatchObject({
      eligible: true,
      state: 'not_invited',
      reason: 'no_github_identity',
      login: null,
    });
  });

  it('is invited once they connect — the same pass, run again', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const late = await addMember(fx, {
      email: 'late@example.com',
      projectRole: 'member',
      login: null,
    });
    const rowId = await establishOneRepo(fx);
    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);

    await connectGithub(late, 'late-gh', 'gh-late');
    const result = await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);

    expect(result.skippedNoIdentity).toBe(0);
    expect(memberCell(result.access, rowId, late)).toMatchObject({
      state: 'invited',
      login: 'late-gh',
      reason: null,
    });
  });
});

describe('rows and members are independent', () => {
  it("one member's GitHub refusal costs only that member — the row and its siblings survive", async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const refused = await addMember(fx, {
      email: 'refused@example.com',
      projectRole: 'member',
      login: 'refused-gh',
    });
    const ok = await addMember(fx, {
      email: 'ok@example.com',
      projectRole: 'member',
      login: 'ok-gh',
    });
    const rowId = await establishOneRepo(fx);
    inviteRefusals.add('acme-web:refused-gh');

    const result = await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);

    expect(result.failed).toBe(1);
    // The repository is real and already established. Failing the row — or
    // rolling back the invitations that DID go out — would be a lie about the
    // world to make one report look tidy.
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.find((r) => r.id === rowId)!.state).toBe('created');
    expect(memberCell(result.access, rowId, ok).state).toBe('invited');
    expect(memberCell(result.access, rowId, refused).state).toBe('not_invited');
  });

  it('narrows to ONE cell — the per-row, per-member resend', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const a = await addMember(fx, {
      email: 'a@example.com',
      projectRole: 'member',
      login: 'a-gh',
    });
    await addMember(fx, { email: 'b@example.com', projectRole: 'member', login: 'b-gh' });
    const webId = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    calls = [];

    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx, {
      rowId: webId.id,
      userId: a,
    });

    // Exactly one PUT: re-sending one person's invitation must never quietly
    // re-send their neighbours' or the other repository's.
    const puts = invitePuts();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain('/acme-web/collaborators/a-gh');
  });

  it('never invites anyone to a `connected` row — that repository was never Motir’s to share', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    await addMember(fx, { email: 'a@example.com', projectRole: 'member', login: 'a-gh' });
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'their-own-repo' },
      fx.ctx,
    );
    const repo = await db.githubRepo.create({
      data: {
        provider: 'github',
        workspaceId: fx.workspaceId,
        installationId: (
          await db.githubInstallation.create({
            data: {
              workspaceId: fx.workspaceId,
              installationId: '999',
              accountLogin: 'their-org',
              accountType: 'Organization',
            },
          })
        ).id,
        repoId: '77',
        owner: 'their-org',
        name: 'their-own-repo',
        defaultBranch: 'main',
        archived: false,
      },
    });
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    calls = [];

    const result = await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx);

    expect(invitePuts()).toHaveLength(0);
    expect(result.invited).toBe(0);
    expect(result.access.rows.find((r) => r.rowId === row.id)!.invitable).toBe(false);
  });
});

describe('the retrofit is honest about history', () => {
  it('the establish path still grants the approving user admin, recorded per member', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const rowId = await establishOneRepo(fx);

    const stored = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) => tx.projectRepoCollaborator.findMany({ where: { projectRepoId: rowId } }),
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      userId: fx.ownerId,
      githubLogin: OWNER_LOGIN,
      permission: 'admin',
    });
    expect(stored[0]!.invitedAt).not.toBeNull();
    // And the establish step's own view of it is unchanged by the retrofit.
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.find((r) => r.id === rowId)!.access).toMatchObject({
      state: 'invited',
      login: OWNER_LOGIN,
    });
  });
});

describe('concurrency', () => {
  it('two simultaneous passes over the same cell produce ONE record and no lost update', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const teammate = await addMember(fx, {
      email: 'teammate@example.com',
      projectRole: 'member',
      login: 'teammate-gh',
    });
    const rowId = await establishOneRepo(fx);

    // A genuine race, not a serial pair: the surface's own sweep and one member's
    // Resend can land together, and the GitHub call is idempotent, so the ONLY
    // thing at risk is the record. Both passes are allowed to succeed; what is
    // forbidden is two records for one (repository, member) or a half-written one.
    await Promise.all([
      projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx, { userId: teammate }),
      projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx, { userId: teammate }),
    ]).catch(() => {
      // A lost unique-index race is a legitimate outcome of real concurrency; the
      // invariant asserted below is the state, not which caller won.
    });

    const stored = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) =>
        tx.projectRepoCollaborator.findMany({
          where: { projectRepoId: rowId, userId: teammate },
        }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ githubLogin: 'teammate-gh', permission: 'push' });
    expect(stored[0]!.invitedAt).not.toBeNull();
  });

  it('a refresh racing an invite cannot un-accept a member who already has access', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const teammate = await addMember(fx, {
      email: 'teammate@example.com',
      projectRole: 'member',
      login: 'teammate-gh',
    });
    const rowId = await establishOneRepo(fx);
    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx, { userId: teammate });
    collaborators.add('acme-web:teammate-gh');
    await projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx);

    // The lost update the lock exists to prevent: an invite write that cleared
    // `acceptedAt` would tell someone who HAS access to go accept an invitation
    // that no longer exists.
    await Promise.all([
      projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx),
      projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx, { userId: teammate }),
    ]).catch(() => {});

    const access = await projectRepoAccessService.listTeamAccess(fx.projectId, fx.ctx);
    expect(memberCell(access, rowId, teammate)).toMatchObject({
      state: 'accepted',
      invitationUrl: null,
    });
  });

  it('acceptance is monotonic — a repeated refresh never rewrites when access was first seen', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx.ownerId, OWNER_LOGIN, '4242');
    const teammate = await addMember(fx, {
      email: 'teammate@example.com',
      projectRole: 'member',
      login: 'teammate-gh',
    });
    const rowId = await establishOneRepo(fx);
    await projectRepoAccessService.grantTeamAccess(fx.projectId, fx.ctx, { userId: teammate });
    collaborators.add('acme-web:teammate-gh');

    await projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx);
    const first = await projectRepoAccessService.listTeamAccess(fx.projectId, fx.ctx);
    await projectRepoAccessService.refreshAccess(fx.projectId, fx.ctx);
    const second = await projectRepoAccessService.listTeamAccess(fx.projectId, fx.ctx);

    expect(memberCell(second, rowId, teammate).acceptedAt).toBe(
      memberCell(first, rowId, teammate).acceptedAt,
    );
  });
});
