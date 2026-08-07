import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRepoTakeoverState } from '@/generated/prisma/client';
import {
  PROJECT_REPO_TAKEOVER_STATES,
  PROJECT_REPO_TAKEOVER_TRANSITIONS,
  allowedTakeoverTransitions,
  canStartTakeover,
  canTakeover,
  isTakeoverSettled,
} from '@/lib/projectRepos/takeover';
import { repoTransferClient, RepoTransferError } from '@/lib/github/repoTransfer';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// The TAKE-IT-OVER machine and its GitHub boundary (Story MOTIR-1775 · MOTIR-711),
// with NO database. These two modules are where the saga's rules are encoded, so
// they are worth pinning independently of any row — the DB-backed half is
// `projectRepoTakeoverService.test.ts`.

describe('the takeover state machine', () => {
  it('declares edges for EVERY state — the table is total', () => {
    // `Record<ProjectRepoTakeoverState, …>` makes this a compile-time guarantee;
    // this asserts the runtime list agrees, so a state added to the Prisma enum
    // without edges cannot slip through as a silently unreachable state.
    for (const state of PROJECT_REPO_TAKEOVER_STATES) {
      expect(PROJECT_REPO_TAKEOVER_TRANSITIONS[state]).toBeDefined();
    }
    expect(Object.keys(PROJECT_REPO_TAKEOVER_TRANSITIONS).sort()).toEqual(
      [...PROJECT_REPO_TAKEOVER_STATES].sort(),
    );
  });

  it('walks the happy path requested → transfer_pending → awaiting_reinstall → done', () => {
    expect(canTakeover('requested', 'transfer_pending')).toBe(true);
    expect(canTakeover('transfer_pending', 'awaiting_reinstall')).toBe(true);
    expect(canTakeover('awaiting_reinstall', 'done')).toBe(true);
  });

  it('lets an ORG target skip the accept step (requested → awaiting_reinstall)', () => {
    // GitHub completes an org transfer without an acceptance, and the client
    // reports it — so the pending state must be skippable, not mandatory.
    expect(canTakeover('requested', 'awaiting_reinstall')).toBe(true);
  });

  it('never skips the RE-INSTALL: no state jumps straight to done', () => {
    // The load-bearing invariant. `done` means the loop survived, which requires
    // an installation under the new owner — so only the state that is WAITING for
    // one may reach it. A transfer alone must never settle the saga.
    const canReachDone = PROJECT_REPO_TAKEOVER_STATES.filter((s) =>
      PROJECT_REPO_TAKEOVER_TRANSITIONS[s].includes('done'),
    );
    expect(canReachDone).toEqual(['awaiting_reinstall']);
  });

  it('makes every unfinished state reachable to `failed`, and `failed` re-promptable', () => {
    // Re-promptability is the durability requirement expressed as edges: a
    // transfer nobody accepted and a re-install nobody finished are the two most
    // likely real outcomes, and both must be recoverable by asking again.
    for (const state of ['requested', 'transfer_pending', 'awaiting_reinstall'] as const) {
      expect(canTakeover(state, 'failed')).toBe(true);
    }
    expect(canTakeover('failed', 'requested')).toBe(true);
    expect(canStartTakeover('failed')).toBe(true);
  });

  it('treats `done` as the ONLY settled state', () => {
    const settled = PROJECT_REPO_TAKEOVER_STATES.filter((s) => isTakeoverSettled(s));
    expect(settled).toEqual(['done']);
    expect(allowedTakeoverTransitions('done')).toEqual([]);
    // A `done` row cannot be handed over again from Motir — and should not be:
    // the repository is theirs, and moving it again is done from their own GitHub.
    expect(canStartTakeover('done')).toBe(false);
  });

  it('starts only from null (never requested) or `failed` (a retry)', () => {
    expect(canStartTakeover(null)).toBe(true);
    for (const state of ['requested', 'transfer_pending', 'awaiting_reinstall', 'done'] as const) {
      expect(canStartTakeover(state)).toBe(false);
    }
  });

  it('reports `null` as NOT settled — it is the absence of a saga, not its end', () => {
    expect(isTakeoverSettled(null)).toBe(false);
  });

  it('rejects every backwards hop', () => {
    const backwards: Array<[ProjectRepoTakeoverState, ProjectRepoTakeoverState]> = [
      ['transfer_pending', 'requested'],
      ['awaiting_reinstall', 'transfer_pending'],
      ['done', 'awaiting_reinstall'],
      ['done', 'failed'],
    ];
    for (const [from, to] of backwards) expect(canTakeover(from, to)).toBe(false);
  });
});

// ── The GitHub transfer boundary ────────────────────────────────────────────

describe('the repo-transfer client', () => {
  function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => handler(String(url), init)),
    );
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  beforeEach(() => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
    _resetInstallationTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const input = {
    installationId: '556677',
    owner: 'motir-projects',
    repo: 'acme-web',
    newOwner: 'yue-personal',
  };

  it('POSTs `new_owner` to the transfer endpoint', async () => {
    let seen: { url: string; body: unknown } | null = null;
    stubFetch((url, init) => {
      if (url.includes('/access_tokens')) {
        return json(200, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() });
      }
      seen = { url, body: JSON.parse(String(init?.body)) };
      return json(202, { owner: { login: 'motir-projects' } });
    });

    await repoTransferClient.transferRepo(input);

    expect(seen!.url).toBe('https://api.github.com/repos/motir-projects/acme-web/transfer');
    expect(seen!.body).toEqual({ new_owner: 'yue-personal' });
  });

  it('reads COMPLETION from the body, not the status code', async () => {
    // GitHub answers 202 whether or not a human still has to accept, so the
    // status cannot distinguish them — only `owner.login` can.
    stubFetch((url) =>
      url.includes('/access_tokens')
        ? json(200, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() })
        : json(202, { owner: { login: 'yue-personal' } }),
    );
    expect(await repoTransferClient.transferRepo(input)).toEqual({ completed: true });

    stubFetch((url) =>
      url.includes('/access_tokens')
        ? json(200, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() })
        : json(202, { owner: { login: 'motir-projects' } }),
    );
    expect(await repoTransferClient.transferRepo(input)).toEqual({ completed: false });
  });

  it('matches the owner case-INSENSITIVELY, as GitHub logins are', async () => {
    stubFetch((url) =>
      url.includes('/access_tokens')
        ? json(200, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() })
        : json(202, { owner: { login: 'Yue-Personal' } }),
    );
    expect(await repoTransferClient.transferRepo(input)).toEqual({ completed: true });
  });

  it('reports NOT completed for an unparseable body — the safe direction', async () => {
    // Null reads as "not completed", so the saga waits for the webhook rather
    // than declaring a handoff that may not have happened.
    stubFetch((url) =>
      url.includes('/access_tokens')
        ? json(200, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() })
        : new Response('not json', { status: 202 }),
    );
    expect(await repoTransferClient.transferRepo(input)).toEqual({ completed: false });
  });

  it('throws a typed error on a refusal, carrying GitHub’s message but never its body', async () => {
    stubFetch((url) =>
      url.includes('/access_tokens')
        ? json(200, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() })
        : json(422, { message: 'new_owner does not exist', errors: [{ secret: 'x' }] }),
    );

    const err = await repoTransferClient.transferRepo(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTransferError);
    expect((err as RepoTransferError).status).toBe(422);
    expect((err as RepoTransferError).message).toContain('new_owner does not exist');
    expect((err as RepoTransferError).message).not.toContain('secret');
  });

  it('does NOT swallow a 404 — unlike the Actions call, a missing repo is a failure', async () => {
    // `actionsPermissions` treats 404 as success because the intent (no workflows)
    // is satisfied by the repo's absence. Here the thing we were asked to hand
    // over cannot be found, which the row must record rather than report as done.
    stubFetch((url) =>
      url.includes('/access_tokens')
        ? json(200, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() })
        : json(404, { message: 'Not Found' }),
    );
    await expect(repoTransferClient.transferRepo(input)).rejects.toBeInstanceOf(RepoTransferError);
  });

  it('wraps a network failure as the same typed error, with a null status', async () => {
    stubFetch((url) => {
      if (url.includes('/access_tokens')) {
        return json(200, { token: 't', expires_at: new Date(Date.now() + 3.6e6).toISOString() });
      }
      throw new Error('ECONNRESET');
    });
    const err = await repoTransferClient.transferRepo(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTransferError);
    expect((err as RepoTransferError).status).toBeNull();
  });
});
