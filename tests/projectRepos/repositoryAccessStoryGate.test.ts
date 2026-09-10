import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withUserContext } from '@/lib/workspaces/context';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createRunnerGroupFake, type RunnerGroupFake } from '../helpers/runnerGroupFake';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';
import { spyOnJobDispatch } from '../helpers/jobs';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';

/**
 * THE STORY GATE for MOTIR-5010 — *the repository question belongs to ONBOARDING*
 * (subtask MOTIR-5017).
 *
 * ⚠️ WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT. Each sibling card
 * ships its own unit tests; that is the per-card floor and none of it is
 * re-covered here. What no single sibling's suite can see is the SEAM BETWEEN
 * them — that establishing a set *results in* the one line the review rail reads
 * — because each half is correct in isolation and the outcome is assembled from
 * both.
 *
 * The three outcomes are asserted through `codeOutcomeOf`'s own predicate rather
 * than through a component render: the rail is fed by `PlanDetail`, which derives
 * the outcome from the SET, so the honest question at this altitude is what the
 * set says after an establish. The rendered panel is the E2E sibling's
 * (MOTIR-5018).
 *
 * Real Postgres, per the repository convention. The ONLY fake is `fetch` — the
 * GitHub HTTP boundary — because the dedupe assertion is about a real unique
 * constraint and a mock cannot prove one.
 */

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '778899';
const LOGIN = 'yuezhu';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let existingRepos: Map<string, number>;
let inviteRefusals: Map<string, number>;
let collaborators: Set<string>;
let nextRepoId: number;
let runnerGroups: RunnerGroupFake;
let actionsVariables: ActionsVariableFake;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** `PUT /repos/:owner/:repo/collaborators/:login` → the row's name and the login. */
function parseCollaboratorPath(u: string): { name: string; login: string } | null {
  const m = /\/repos\/[^/]+\/([^/]+)\/collaborators\/([^/?]+)/.exec(u);
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
      const group = await runnerGroups.handle(u, method, body);
      if (group) return group;
      const variable = actionsVariables.handle(u, method, body);
      if (variable) return variable;

      const collab = parseCollaboratorPath(u);
      if (collab && method === 'PUT') {
        const refusal = inviteRefusals.get(collab.name);
        if (refusal) return json(refusal, { message: 'Refused' });
        collaborators.add(`${collab.name}:${collab.login}`);
        return json(201, {
          id: 1,
          html_url: `https://github.com/${MOTIR_ORG}/${collab.name}/invitations`,
        });
      }

      if (collab && method === 'GET') {
        return collaborators.has(`${collab.name}:${collab.login}`)
          ? new Response(null, { status: 204 })
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
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

async function connectGithub(fx: WorkItemFixture): Promise<void> {
  await withUserContext(fx.ownerId, (tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId: fx.ownerId,
        githubUserId: '9090',
        githubLogin: LOGIN,
        avatarUrl: null,
        accessTokenEncrypted: 'encrypted-not-read-here',
      },
      tx,
    ),
  );
}

async function addRow(
  fx: WorkItemFixture,
  role: 'web' | 'api' | 'infra',
  name: string,
): Promise<string> {
  const row = await projectRepoSetService.addRow(fx.projectId, { role, name }, fx.ctx);
  return row.id;
}

async function readRows(fx: WorkItemFixture): Promise<ProjectRepoDto[]> {
  return projectRepoSetService.listByProject(fx.projectId, fx.ctx);
}

/**
 * `PlanDetail.codeOutcomeOf`'s predicate, applied to the set the establish left
 * behind — the ONE line the review rail reads about the project's code.
 *
 * ⚠️ MIRRORED RATHER THAN IMPORTED, and that is the point of the case. The
 * shipped copy is a module-private function inside a `'use client'` component;
 * what this gate proves is that the SET an establish produces resolves to the
 * outcome the rail renders, which is a claim about the data, not about the
 * component. A drift between this predicate and the component's is exactly what
 * the E2E sibling catches, on the rendered page.
 */
function codeOutcomeOf(rows: readonly ProjectRepoDto[]): string | null {
  if (rows.length === 0) return null;
  const settled = (s: string) => s === 'created' || s === 'connected' || s === 'skipped';
  if (!rows.every((r) => settled(r.state))) return 'unfinished';
  const reachable = (r: ProjectRepoDto) =>
    r.state !== 'created' || r.access.state !== 'not_invited';
  return rows.every(reachable) ? 'ready' : 'needs_access';
}

/** Every collaborator PUT the fake saw. */
function invitePuts(): Call[] {
  return calls.filter((c) => c.method === 'PUT' && parseCollaboratorPath(c.url) !== null);
}

beforeEach(async () => {
  await truncateAuthTables();
  calls = [];
  existingRepos = new Map();
  inviteRefusals = new Map();
  collaborators = new Set();
  nextRepoId = 700_001;
  actionsVariables = createActionsVariableFake(MOTIR_ORG);
  runnerGroups = createRunnerGroupFake(MOTIR_ORG);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey as string);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _setReadinessPollForTests({ attempts: 2, delayMs: 0 });
  installGitHub();
  spyOnJobDispatch();
  // The invite path logs its own row-level failures by contract; keep the
  // suite's output to its assertions.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _setReadinessPollForTests(null);
});

afterAll(async () => {
  _setReadinessPollForTests(null);
  await db.$disconnect();
});

// ── 1 · THE THREE OUTCOMES THE RAIL RENDERS ──────────────────────────────────
//
// Each half is unit-tested by its own card. What is asserted here is that
// establishing a set RESULTS IN the outcome the rail reads — the sentence no
// single sibling's suite contains.

describe('establish → invite → the one line the rail reads', () => {
  it('an identity that GitHub accepts ⇒ every row invited, and the rail reads READY', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    await addRow(fx, 'web', 'gate-web');
    await addRow(fx, 'api', 'gate-api');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const rows = await readRows(fx);
    expect(rows.map((r) => r.state)).toEqual(['created', 'created']);
    expect(rows.every((r) => r.access.state === 'invited')).toBe(true);
    expect(codeOutcomeOf(rows)).toBe('ready');
  });

  it('NO identity ⇒ GitHub is never asked, and the rail reads NEEDS_ACCESS', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'gate-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const rows = await readRows(fx);
    expect(rows[0]!.state).toBe('created');
    expect(rows[0]!.access.state).toBe('not_invited');
    // The repositories exist; only the way in is missing. That distinction is the
    // whole reason `needs_access` is not `unfinished`.
    expect(invitePuts()).toHaveLength(0);
    expect(codeOutcomeOf(rows)).toBe('needs_access');
  });

  it('a REFUSAL on one row ⇒ every row still created, one notification, and the establish does not throw', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    inviteRefusals.set('gate-api', 403);
    await addRow(fx, 'web', 'gate-web');
    await addRow(fx, 'api', 'gate-api');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // GRACEFUL DEGRADATION, asserted rather than quoted: the invitation is a side
    // effect after commit, so a refusal cannot roll a repository back or report
    // the establish as failed.
    expect(result.rows.map((r) => r.outcome)).toEqual(['created', 'created']);
    const rows = await readRows(fx);
    expect(rows.every((r) => r.state === 'created')).toBe(true);
    expect(rows.every((r) => r.failureReason === null)).toBe(true);

    const notifications = await adminDb.notification.findMany({
      where: { recipientUserId: fx.ownerId },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe('code_access_refused');
  });
});

// ── 2 · THE MIXED-ROW CASE ───────────────────────────────────────────────────
//
// The case a per-card suite structurally cannot reach: one card owns the invite
// predicate and another owns the outcome, and neither sees a set holding both
// kinds of row at once. This is also the shape that produced a dead button in the
// shipped code, so it is asserted rather than reasoned about.

describe('a MIXED set — one Motir-created row, one the user already owns', () => {
  it('invites the CREATED row only, and never asks GitHub about the CONNECTED one', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    const createdId = await addRow(fx, 'web', 'gate-web');
    const connectedId = await addRow(fx, 'api', 'gate-owned');

    // The user's own repository, adopted rather than created. `connected` is the
    // state `needsCollaboratorInvite` deliberately excludes: it is already theirs,
    // so an invitation would be a request that can only answer "already a
    // collaborator".
    await adminDb.projectRepo.update({
      where: { id: connectedId },
      data: { state: 'connected' },
    });

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const puts = invitePuts().map((p) => parseCollaboratorPath(p.url)!.name);
    expect(puts).toEqual(['gate-web']);
    expect(puts).not.toContain('gate-owned');

    const rows = await readRows(fx);
    const created = rows.find((r) => r.id === createdId)!;
    const connected = rows.find((r) => r.id === connectedId)!;
    expect(created.access.state).toBe('invited');
    // Untouched — and NOT `not_invited` as a failure: there is nothing to invite to.
    expect(connected.state).toBe('connected');
  });

  it('the rail reads READY for a mixed set — a `connected` row raises no access question', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    await addRow(fx, 'web', 'gate-web');
    const connectedId = await addRow(fx, 'api', 'gate-owned');
    await adminDb.projectRepo.update({
      where: { id: connectedId },
      data: { state: 'connected' },
    });

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // ⚠️ THE ASSERTION THAT MATTERS. `reachable` excuses a non-`created` row, so a
    // mixed set must not read `needs_access` merely because one row was never
    // invited. Getting this backwards would tell every BYOK project that its
    // access is unfinished, for ever.
    expect(codeOutcomeOf(await readRows(fx))).toBe('ready');
  });
});

// ── 3 · IDEMPOTENCE, ON THE REAL CONSTRAINT ──────────────────────────────────

describe('a retried establish is idempotent in both directions', () => {
  it('two runs against a refusing GitHub write exactly ONE notification', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    inviteRefusals.set('gate-web', 403);
    await addRow(fx, 'web', 'gate-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    // **Try again** on the failed panel is an ordinary user action.
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // The `(dedupeKey, recipientUserId)` unique is what makes this true, which is
    // why it is asserted on real Postgres — a mock cannot prove a constraint.
    expect(await adminDb.notification.count({ where: { recipientUserId: fx.ownerId } })).toBe(1);
  });

  it('a second run over an ACCEPTED record asks GitHub nothing for that row', async () => {
    const fx = await makeWorkItemFixture();
    await connectGithub(fx);
    const rowId = await addRow(fx, 'web', 'gate-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    // The user accepted on GitHub; Motir learns it from the acceptance read.
    await adminDb.projectRepoCollaborator.updateMany({
      where: { projectRepoId: rowId },
      data: { acceptedAt: new Date() },
    });

    const before = invitePuts().length;
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // Re-inviting an accepted collaborator is a request that can only answer
    // "already a collaborator" — `grantAccess` skips the record rather than
    // spending the call.
    expect(invitePuts().length).toBe(before);
  });
});
