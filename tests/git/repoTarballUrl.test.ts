import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGitProvider,
  requireRepoTarballUrlResolver,
  RepoTarballUrlMissingLocationError,
  RepoTarballUrlNotRedirectedError,
  RepoTarballUrlTimeoutError,
  RepoTarballUrlUnreachableError,
  RepoTarballUrlUnsupportedError,
  REPO_TARBALL_TIMEOUT_MS,
  type GitProvider,
} from '@/lib/git';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// RESOLVING the pre-signed tarball URL (Story MOTIR-1981 · MOTIR-1989) —
// `docs/decisions/code-graph-index-fleet.md` §10, "the container holds NO GitHub
// credential".
//
// The property under test is a NEGATIVE one and it is the whole point of the
// card: the request stops at GitHub's 302 and the body is NEVER read. A test
// that only asserted the returned URL would pass just as happily against an
// implementation that downloaded 350 MB first and threw it away — which is the
// OOM (§2: `motir-core`, 5/5 attempts) this path exists to remove. So the fake
// Response below is built so that touching its body is DETECTABLE.

const CODELOAD_URL =
  'https://codeload.github.com/moooon/acme/legacy.tar.gz/refs/heads/main' +
  '?token=ABC123&X-Amz-Expires=300';

const github = getGitProvider('github');

// Reached through the REQUIRE helper rather than the optional property, so every
// case below also proves the capability is discharged the one sanctioned way.
const resolveGithub = requireRepoTarballUrlResolver(github);

/** A Response whose body accessors THROW, so any implementation that reads the
 *  body fails the test loudly instead of silently costing a download. */
function redirectResponse(
  status: number,
  headers: Record<string, string>,
): Response & { bodyTouched: () => boolean } {
  let touched = false;
  const res = new Response(null, { status, headers });
  const trap = (name: string) => () => {
    touched = true;
    throw new Error(`the resolver read the response body via ${name}()`);
  };
  Object.defineProperties(res, {
    arrayBuffer: { value: trap('arrayBuffer') },
    blob: { value: trap('blob') },
    text: { value: trap('text') },
    json: { value: trap('json') },
  });
  return Object.assign(res, { bodyTouched: () => touched });
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      token: 'ghs_resolve',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('github.resolveRepoTarballUrl (MOTIR-1989)', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns the Location URL, requests redirect:manual, and NEVER reads the body', async () => {
    const redirect = redirectResponse(302, { location: CODELOAD_URL });
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/access_tokens')) return tokenResponse();
      if (u.includes('/tarball/')) return redirect;
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveGithub('inst-1', 'moooon', 'acme', 'main');
    expect(resolved).toBe(CODELOAD_URL);

    // ⚠️ THE ASSERTION THE CARD IS ABOUT. No repo bytes entered this process.
    expect(redirect.bodyTouched()).toBe(false);

    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/tarball/'));
    expect(call).toBeTruthy();
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/moooon/acme/tarball/main');
    // Without this, `fetch` follows the 302 itself and buffers what comes back.
    expect(init.redirect).toBe('manual');
    // The FIRST hop still carries the installation token — only the codeload hop
    // does not need it, which is the whole reason the URL is safe to hand over.
    expect(init.headers).toMatchObject({ authorization: 'Bearer ghs_resolve' });
    // And it is bounded, like its byte-returning sibling.
    expect(init.signal).toBeDefined();
  });

  it('resolves a 301/307/308 too — the arm is "a redirect", not "302"', async () => {
    for (const status of [301, 307, 308]) {
      _resetInstallationTokenCache();
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (url: string): Promise<Response> =>
            String(url).includes('/access_tokens')
              ? tokenResponse()
              : redirectResponse(status, { location: CODELOAD_URL }),
        ),
      );
      await expect(resolveGithub('inst-1', 'moooon', 'acme', 'main')).resolves.toBe(CODELOAD_URL);
    }
  });

  it('throws NotRedirected on a 200 — a served BODY is a failure here, not a success', async () => {
    // The most important negative case: if GitHub ever serves the bytes inline,
    // this method must refuse rather than quietly return nothing.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string): Promise<Response> =>
          String(url).includes('/access_tokens')
            ? tokenResponse()
            : redirectResponse(200, { 'content-type': 'application/gzip' }),
      ),
    );
    await expect(resolveGithub('inst-1', 'moooon', 'acme', 'main')).rejects.toBeInstanceOf(
      RepoTarballUrlNotRedirectedError,
    );
  });

  it('throws NotRedirected with the STATUS on a 404 (the installation lost the repo)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string): Promise<Response> =>
          String(url).includes('/access_tokens') ? tokenResponse() : redirectResponse(404, {}),
      ),
    );
    const err = await resolveGithub('inst-1', 'moooon', 'acme', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTarballUrlNotRedirectedError);
    expect((err as RepoTarballUrlNotRedirectedError).status).toBe(404);
    expect((err as RepoTarballUrlNotRedirectedError).failure).toBe('not_redirected');
  });

  it('throws MissingLocation on a redirect with no Location header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string): Promise<Response> =>
          String(url).includes('/access_tokens') ? tokenResponse() : redirectResponse(302, {}),
      ),
    );
    const err = await resolveGithub('inst-1', 'moooon', 'acme', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTarballUrlMissingLocationError);
    expect((err as RepoTarballUrlMissingLocationError).failure).toBe('no_location');
    // NEVER a falsy URL: an empty MOTIR_INDEX_TARBALL_URL would boot a container
    // that fails with a FETCH exit code, blaming the repo for a dispatcher bug.
    expect(String((err as Error).message)).not.toBe('');
  });

  it('throws Timeout when the request aborts on the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (String(url).includes('/access_tokens')) return tokenResponse();
        // Simulate what the runtime does when OUR AbortController fires.
        const signal = init?.signal as AbortSignal & { reason?: unknown };
        Object.defineProperty(signal, 'aborted', { value: true, configurable: true });
        throw new Error('This operation was aborted');
      }),
    );
    const err = await resolveGithub('inst-1', 'moooon', 'acme', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTarballUrlTimeoutError);
    expect((err as RepoTarballUrlTimeoutError).timeoutMs).toBe(REPO_TARBALL_TIMEOUT_MS);
  });

  it('throws Unreachable on a transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        if (String(url).includes('/access_tokens')) return tokenResponse();
        throw new Error('ECONNRESET');
      }),
    );
    const err = await resolveGithub('inst-1', 'moooon', 'acme', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTarballUrlUnreachableError);
    expect((err as Error).message).toContain('ECONNRESET');
  });

  it('the four failures are DISTINCT classes and carry distinct discriminators', () => {
    // The card's requirement, asserted as a property rather than implied by the
    // cases above: an operator's response differs per arm, so the arms must be
    // separable both by `instanceof` and by a total switch on `failure`.
    const all = [
      new RepoTarballUrlNotRedirectedError(500),
      new RepoTarballUrlMissingLocationError(302),
      new RepoTarballUrlTimeoutError(1),
      new RepoTarballUrlUnreachableError('x'),
    ];
    expect(new Set(all.map((e) => e.failure)).size).toBe(4);
    expect(new Set(all.map((e) => e.name)).size).toBe(4);
  });
});

describe('requireRepoTarballUrlResolver (the LOUD refusal)', () => {
  it('returns a bound resolver for a provider that implements the capability', async () => {
    const resolve = requireRepoTarballUrlResolver(github);
    expect(typeof resolve).toBe('function');
  });

  it('REFUSES a provider without it — and offers no byte-downloading fallback', () => {
    // GitLab is the real instance: its archive endpoint streams bytes against a
    // PRIVATE-TOKEN header, so there is no self-authorizing URL to hand a
    // container and it deliberately does not implement this.
    const gitlab = getGitProvider('gitlab');
    expect(gitlab.resolveRepoTarballUrl).toBeUndefined();
    expect(() => requireRepoTarballUrlResolver(gitlab)).toThrow(RepoTarballUrlUnsupportedError);

    // ⚠️ THE POINT: the refusal must not be recoverable into a download. The
    // helper's ONLY return is the resolver, so there is no arm a caller could
    // take that ends in `fetchRepoTarball` — asserted by the fact that the
    // failure is a throw and not a nullable return.
    let returned: unknown = 'not-thrown';
    try {
      returned = requireRepoTarballUrlResolver(gitlab);
    } catch (err) {
      returned = err;
    }
    expect(returned).toBeInstanceOf(RepoTarballUrlUnsupportedError);
    expect((returned as RepoTarballUrlUnsupportedError).providerId).toBe('gitlab');
  });

  it('names the provider in the error, so the message says which host cannot', () => {
    const stub = { id: 'bitbucket' } as unknown as GitProvider;
    expect(() => requireRepoTarballUrlResolver(stub)).toThrow(/bitbucket/);
  });
});

describe('fetchRepoTarball is UNTOUCHED by this card', () => {
  it('still exists as a required method on both shipped providers', () => {
    // §11: `system.code-graph-refresh` and motir-ai's hydrate-on-read path still
    // use the byte-returning method. This card ADDS a sibling; it does not
    // migrate or deprecate anything, and a future edit that removes the old
    // method has to come past this assertion.
    expect(typeof github.fetchRepoTarball).toBe('function');
    expect(typeof getGitProvider('gitlab').fetchRepoTarball).toBe('function');
  });
});
