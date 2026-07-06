import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { authenticateGithubOidc } from '@/lib/github/oidcAuth';
import { truncateAuthTables } from '../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';

// MOTIR-1650 — the keyless GitHub-OIDC publish auth, against real Postgres (the
// repo→workspace + workspace-owner resolution) with a LOCALLY served JWKS +
// self-minted RS256 tokens (so we exercise the real `jose` verify, not a mock).
// One registered key backs the JWKS; the negative cases sign with a second,
// UNREGISTERED key or carry a wrong audience / past expiry.

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'motir-acceptance-video';
const KID = 'test-key-1';
const PASSWORD = 'hunter2hunter2';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let keys: KeyPair; // registered in the served JWKS
let otherKeys: KeyPair; // NOT in the JWKS — signatures from it must fail
let server: Server;

const REPO: NormalizedRepo = {
  providerRepoId: '111',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
};

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  otherKeys = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const bodyText = JSON.stringify({ keys: [jwk] });

  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(bodyText);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  process.env.GITHUB_OIDC_ISSUER = ISSUER;
  process.env.GITHUB_OIDC_JWKS_URL = `http://127.0.0.1:${port}/jwks`;
  process.env.GITHUB_OIDC_AUDIENCE = AUDIENCE;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.GITHUB_OIDC_ISSUER;
  delete process.env.GITHUB_OIDC_JWKS_URL;
  delete process.env.GITHUB_OIDC_AUDIENCE;
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

async function makeWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

async function connectRepo(
  workspaceId: string,
  installationId: string,
  repo: NormalizedRepo = REPO,
) {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: { installationId, accountLogin: repo.owner, accountType: 'Organization' },
    repos: [repo],
  });
}

async function mintToken(opts?: {
  repository?: string;
  audience?: string;
  expirationTime?: string | number;
  signWith?: KeyPair;
}): Promise<string> {
  const repository = opts?.repository ?? `${REPO.owner}/${REPO.name}`;
  const audience = opts?.audience ?? AUDIENCE;
  const expirationTime = opts?.expirationTime ?? '5m';
  const signWith = opts?.signWith ?? keys;
  return new SignJWT({ repository })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setExpirationTime(expirationTime)
    .sign(signWith.privateKey);
}

function oidcReq(token: string | null, marker: string | null = 'github-oidc'): Request {
  const headers: Record<string, string> = {};
  if (marker) headers['x-motir-auth'] = marker;
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new Request('http://localhost/api/work-items/MOTIR-1/acceptance-evidence', {
    method: 'POST',
    headers,
  });
}

describe('authenticateGithubOidc', () => {
  it('resolves a valid token for a connected repo to the workspace OWNER', async () => {
    const { user, workspace } = await makeWorkspace('owner@example.com');
    await connectRepo(workspace.id, 'inst-1');

    const result = await authenticateGithubOidc(oidcReq(await mintToken()));

    expect(result).toEqual({ ok: true, userId: user.id, workspaceId: workspace.id });
  });

  it('returns null (defer to the PAT path) when the OIDC marker is absent', async () => {
    const result = await authenticateGithubOidc(oidcReq(await mintToken(), null));
    expect(result).toBeNull();
  });

  it('401s when the marker is present but no bearer token is sent', async () => {
    const result = await authenticateGithubOidc(oidcReq(null));
    expect(result).toEqual({ ok: false, status: 401, reason: 'missing_oidc_token' });
  });

  it('401s a token with the wrong audience', async () => {
    await connectRepo((await makeWorkspace('a@example.com')).workspace.id, 'inst-a');
    const token = await mintToken({ audience: 'some-other-service' });
    const result = await authenticateGithubOidc(oidcReq(token));
    expect(result).toEqual({ ok: false, status: 401, reason: 'invalid_oidc_token' });
  });

  it('401s an expired token', async () => {
    await connectRepo((await makeWorkspace('b@example.com')).workspace.id, 'inst-b');
    const token = await mintToken({ expirationTime: Math.floor(Date.now() / 1000) - 3600 });
    const result = await authenticateGithubOidc(oidcReq(token));
    expect(result).toEqual({ ok: false, status: 401, reason: 'invalid_oidc_token' });
  });

  it('401s a token signed by a key that is not in the JWKS', async () => {
    await connectRepo((await makeWorkspace('c@example.com')).workspace.id, 'inst-c');
    const token = await mintToken({ signWith: otherKeys });
    const result = await authenticateGithubOidc(oidcReq(token));
    expect(result).toEqual({ ok: false, status: 401, reason: 'invalid_oidc_token' });
  });

  it('401s when the verified repository claim is malformed', async () => {
    const token = await mintToken({ repository: 'no-slash-here' });
    const result = await authenticateGithubOidc(oidcReq(token));
    expect(result).toEqual({ ok: false, status: 401, reason: 'missing_repository_claim' });
  });

  it('403s a valid token whose repo is not connected via the App', async () => {
    await makeWorkspace('d@example.com'); // workspace exists, but no repo connected
    const token = await mintToken({ repository: 'moooon/unconnected' });
    const result = await authenticateGithubOidc(oidcReq(token));
    expect(result).toEqual({ ok: false, status: 403, reason: 'repo_not_connected' });
  });

  it('403s (never silently picks) an ambiguous repo connected under two workspaces', async () => {
    const w1 = await makeWorkspace('e1@example.com');
    const w2 = await makeWorkspace('e2@example.com');
    await connectRepo(w1.workspace.id, 'inst-e1');
    await connectRepo(w2.workspace.id, 'inst-e2'); // same owner/name, second tenant

    const result = await authenticateGithubOidc(oidcReq(await mintToken()));
    expect(result).toEqual({ ok: false, status: 403, reason: 'repo_not_connected' });
  });

  it('matches the repository claim case-insensitively (GitHub coordinates are)', async () => {
    const { user, workspace } = await makeWorkspace('f@example.com');
    await connectRepo(workspace.id, 'inst-f');
    const token = await mintToken({ repository: 'MOOOON/Motir-Core' });
    const result = await authenticateGithubOidc(oidcReq(token));
    expect(result).toEqual({ ok: true, userId: user.id, workspaceId: workspace.id });
  });
});
