import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostedRunRepoAccessService } from '@/lib/services/hostedRunRepoAccessService';
import {
  SEED_SOURCE_ORGANIZATION,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';

// MOTIR-1895 — the Repositories room's hosted-run line per connected repository
// (`design/repository-set/design-notes.md` §18.1). GitHub is stubbed at its HTTP
// seam; the answer comes from MOTIR-6449's `hostedRunWriteAccess`, so these tests
// pin the MAPPING onto the room's three states and the rules for what draws
// nothing — a Motir-hosted row, an unconfigured deployment, a failed read.

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const INSTALL_HREF = 'https://github.com/apps/motir-integration/installations/new';
const ACCEPTED = { contents: 'write', pull_requests: 'write', metadata: 'read' };

interface InstallationStub {
  status?: number;
  permissions?: Record<string, string>;
  suspended?: boolean;
  /** Never answers — the read's timeout is what ends it. */
  hang?: boolean;
  throws?: boolean;
}

function stubGithub(installation: Record<string, InstallationStub> = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const m = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (!m) return new Response('{}', { status: 500 });
      const repo = m[1] ?? '';
      const s = installation[repo] ?? {};
      if (s.throws) throw new Error('socket hang up');
      if (s.hang) return new Promise<Response>(() => {});
      if ((s.status ?? 200) !== 200) return new Response('{}', { status: s.status ?? 404 });
      const owner = repo.split('/')[0];
      return new Response(
        JSON.stringify({
          id: 42,
          account: { login: owner },
          permissions: s.permissions ?? ACCEPTED,
          suspended_at: s.suspended ? '2026-09-01T00:00:00Z' : null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/42`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return calls;
}

let seq = 0;
function row(over: {
  owner: string;
  name: string;
  seedSource?: string;
  established?: boolean;
  provider?: string;
}): ProjectRepoDto {
  seq += 1;
  return {
    id: `row-${seq}`,
    seedSource: over.seedSource ?? SEED_SOURCE_ORGANIZATION,
    established: over.established ?? true,
    realizedRepo: {
      id: `gh-${seq}`,
      provider: over.provider ?? 'github',
      owner: over.owner,
      name: over.name,
      repoRef: `${over.owner}/${over.name}`,
      defaultBranch: 'main',
    },
  } as unknown as ProjectRepoDto;
}

beforeEach(() => {
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('hostedRunRepoAccessService.forRoomRows (MOTIR-1895)', () => {
  it('maps each connected repository onto ready / needs_permissions / unreachable', async () => {
    stubGithub({
      'acme-labs/acme-infra': { permissions: { contents: 'read', pull_requests: 'write' } },
      'acme-inc/design-tokens': { status: 404 },
      'acme-inc/paused': { suspended: true },
    });
    const ready = row({ owner: 'acme-inc', name: 'acme-booking-web' });
    const perms = row({ owner: 'acme-labs', name: 'acme-infra' });
    const gone = row({ owner: 'acme-inc', name: 'design-tokens' });
    const paused = row({ owner: 'acme-inc', name: 'paused' });

    const out = await hostedRunRepoAccessService.forRoomRows([ready, perms, gone, paused], {
      installHref: INSTALL_HREF,
    });

    expect(out).toEqual({
      [ready.id]: { state: 'ready' },
      [perms.id]: {
        state: 'needs_permissions',
        account: 'acme-labs',
        reviewHref: 'https://github.com/organizations/acme-labs/settings/installations/42',
      },
      [gone.id]: {
        state: 'unreachable',
        repository: 'acme-inc/design-tokens',
        reconnectHref: INSTALL_HREF,
      },
      [paused.id]: {
        state: 'unreachable',
        repository: 'acme-inc/paused',
        reconnectHref: INSTALL_HREF,
      },
    });
  });

  it('asks GitHub nothing for a Motir-hosted row, an unrealized row or a non-GitHub one', async () => {
    const calls = stubGithub();
    const hosted = row({
      owner: 'motir-projects',
      name: 'site',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
    });
    const unrealized = row({ owner: 'acme-inc', name: 'not-yet', established: false });
    const gitlab = row({ owner: 'acme-inc', name: 'on-gitlab', provider: 'gitlab' });

    expect(
      await hostedRunRepoAccessService.forRoomRows([hosted, unrealized, gitlab], {
        installHref: INSTALL_HREF,
      }),
    ).toEqual({});
    expect(calls).toEqual([]);
  });

  it('draws nothing at all on a deployment without the Integration App configured (AC3)', async () => {
    const calls = stubGithub();
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    expect(
      await hostedRunRepoAccessService.forRoomRows([row({ owner: 'acme-inc', name: 'web' })], {
        installHref: INSTALL_HREF,
      }),
    ).toEqual({});
    expect(calls).toEqual([]);
  });

  it('draws no line — never a warning — for a repository whose GitHub read fails', async () => {
    stubGithub({ 'acme-inc/flaky': { throws: true }, 'acme-inc/odd': { status: 502 } });
    const ok = row({ owner: 'acme-inc', name: 'web' });
    const flaky = row({ owner: 'acme-inc', name: 'flaky' });
    const odd = row({ owner: 'acme-inc', name: 'odd' });

    const out = await hostedRunRepoAccessService.forRoomRows([ok, flaky, odd], {
      installHref: INSTALL_HREF,
    });
    expect(out).toEqual({ [ok.id]: { state: 'ready' } });
  });

  it('draws no line for a repository GitHub does not answer inside the timeout', async () => {
    vi.useFakeTimers();
    stubGithub({ 'acme-inc/slow': { hang: true } });
    const ok = row({ owner: 'acme-inc', name: 'web' });
    const slow = row({ owner: 'acme-inc', name: 'slow' });

    const pending = hostedRunRepoAccessService.forRoomRows([ok, slow], {
      installHref: INSTALL_HREF,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toEqual({ [ok.id]: { state: 'ready' } });
  });

  it('falls back to the install screen when a permission review has no installation page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 42,
              account: { login: 'acme-labs' },
              permissions: { contents: 'read', pull_requests: 'read' },
              suspended_at: null,
              html_url: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const perms = row({ owner: 'acme-labs', name: 'infra' });
    expect(
      await hostedRunRepoAccessService.forRoomRows([perms], { installHref: INSTALL_HREF }),
    ).toEqual({
      [perms.id]: { state: 'needs_permissions', account: 'acme-labs', reviewHref: INSTALL_HREF },
    });
  });

  // Coverage top-up (MOTIR-692): an error `hostedRunWriteAccess` cannot
  // actually produce (every real failure of its own is a typed
  // `RunGitCredentialUnavailableError`) still must not be SWALLOWED — the "draws
  // nothing" rule above is for the two NAMED failure shapes, never for "the
  // read threw something we don't recognise".
  it('does not swallow an error that is neither a recognised refusal nor not-configured', async () => {
    const runGitCredential = await import('@/lib/github/runGitCredential');
    vi.spyOn(runGitCredential, 'hostedRunWriteAccess').mockRejectedValueOnce(
      new Error('a bug, not a refusal'),
    );
    const perms = row({ owner: 'acme-labs', name: 'infra' });
    await expect(
      hostedRunRepoAccessService.forRoomRows([perms], { installHref: INSTALL_HREF }),
    ).rejects.toThrow('a bug, not a refusal');
  });
});
