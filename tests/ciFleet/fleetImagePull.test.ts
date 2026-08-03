import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseBearerChallenge,
  parseImageReference,
  probeImagePull,
} from '@/lib/orchestrator/imagePull';
import {
  OrchestratorImageUnpullableError,
  verifyFleetBootable,
  verifyIndexFleetBootable,
} from '@/lib/orchestrator';

// THE FLEET BOOT PREFLIGHT (Story MOTIR-1916 · MOTIR-2006) — §6.1 + §7 of
// `docs/decisions/fleet-image-pull.md`.
//
// The assertion MOTIR-1980 did not have. The fleet shipped code-complete and
// unable to boot a single container while `isFlyFleetConfigured()` answered
// `true` throughout, because "three env vars are non-empty" was all it ever
// checked. These tests pin the predicate that DOES ask the real question, and —
// just as importantly — pin the boundary between its three answers: pullable,
// definitely not pullable, and could-not-tell. Collapsing the last two is how a
// registry blip becomes "your image is private" and how a private image hides
// behind a retry.
//
// ⚠️ THE FIXTURES ARE MEASURED, NOT INVENTED. Every wire shape below was
// observed against ghcr.io and api.machines.dev on 2026-08-02 (recorded in the
// ADR §2.1–§2.2 and re-run by MOTIR-2006):
//
//   * public  → GET /token returns {"token":"…"}, then the manifest GET returns
//     200 with `content-type: application/vnd.oci.image.index.v1+json`.
//   * private → GET /token returns
//     {"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}
//     with HTTP 401, and the pull never happens.
//
// No database, no network. `fetch` is the only fake.

const PUBLIC_IMAGE =
  'ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692df68c80367876c65082c60ec3b1c667f32a98811ac53f0dfa8a0e6d1d';
const PRIVATE_IMAGE = 'ghcr.io/moooon-b-v/motir-sandbox:claude';

/** GHCR's real challenge header, copied from a live 401. */
const GHCR_CHALLENGE =
  'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:moooon-b-v/motir-ci-runner:pull"';

let urls: string[];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * A registry that behaves exactly like GHCR — challenge the anonymous manifest
 * GET with a per-REPOSITORY scope, hand out a token only for `publicRepos`, then
 * serve the manifest to a bearer.
 *
 * Per-repository is the whole point: a fixture whose challenge always named the
 * same repo would answer "public" for every input, and the test that consumes it
 * exists to prove the probe distinguishes.
 */
function ghcrLike(publicRepos: string[]) {
  return async (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    urls.push(rawUrl);

    if (url.pathname === '/token') {
      const scope = url.searchParams.get('scope') ?? '';
      return publicRepos.some((repo) => scope.includes(repo))
        ? json(200, { token: 'anon-pull-token' })
        : json(401, { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] });
    }

    const repository = /^\/v2\/(.+)\/manifests\//.exec(url.pathname)?.[1] ?? '';
    const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
    if (auth) return json(200, {}, { 'docker-content-digest': 'sha256:served' });
    return json(
      401,
      {},
      {
        'www-authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${repository}:pull"`,
      },
    );
  };
}

beforeEach(() => {
  urls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseImageReference — the registry a reference actually names', () => {
  it('splits a digest-pinned GHCR reference into host, repository and digest', () => {
    expect(parseImageReference(PUBLIC_IMAGE)).toEqual({
      registry: 'ghcr.io',
      repository: 'moooon-b-v/motir-ci-runner',
      reference: 'sha256:446c692df68c80367876c65082c60ec3b1c667f32a98811ac53f0dfa8a0e6d1d',
      isDigest: true,
    });
  });

  it('splits a tagged reference and marks it as NOT a digest', () => {
    expect(parseImageReference(PRIVATE_IMAGE)).toMatchObject({
      registry: 'ghcr.io',
      repository: 'moooon-b-v/motir-sandbox',
      reference: 'claude',
      isDigest: false,
    });
  });

  it('defaults a bare name to Docker Hub AND to the implicit `library/` namespace', () => {
    // `ubuntu` means `registry-1.docker.io/library/ubuntu:latest`. Only Hub does
    // this, and getting it wrong would probe a URL that 404s and report a real
    // public image as absent.
    expect(parseImageReference('ubuntu')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'library/ubuntu',
      reference: 'latest',
      isDigest: false,
    });
  });

  it('treats a first segment WITHOUT a dot, colon or `localhost` as a Hub namespace', () => {
    expect(parseImageReference('moooon/motir:v2')).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'moooon/motir',
      reference: 'v2',
    });
  });

  it('recognises `localhost:5000` and a host:port as registries, not namespaces', () => {
    expect(parseImageReference('localhost:5000/motir/runner:dev')).toMatchObject({
      registry: 'localhost:5000',
      repository: 'motir/runner',
    });
  });

  it('does NOT mistake a registry port for a tag', () => {
    // `registry.example.com:5000/x` has a colon AFTER no slash-bounded tag. A
    // parser that took the last colon would probe `registry.example.com` for a
    // repository named `5000/x`.
    expect(parseImageReference('registry.example.com:5000/motir/runner')).toMatchObject({
      registry: 'registry.example.com:5000',
      repository: 'motir/runner',
      reference: 'latest',
    });
  });

  it('returns null for nonsense rather than guessing', () => {
    // A parser that guessed would report "private image" for what is really a
    // typo in MOTIR_RUNNER_IMAGE, and §6's preflight is only worth having if its
    // verdict can be trusted.
    expect(parseImageReference('')).toBeNull();
    expect(parseImageReference('   ')).toBeNull();
    expect(parseImageReference('ghcr.io/repo@')).toBeNull();
    expect(parseImageReference('@sha256:abc')).toBeNull();
    // A host with no repository at all — `https://ghcr.io/v2//manifests/latest`
    // is not a URL worth issuing.
    expect(parseImageReference('ghcr.io/')).toBeNull();
  });
});

describe('parseBearerChallenge — the WWW-Authenticate dance', () => {
  it("reads GHCR's real challenge into its params", () => {
    expect(parseBearerChallenge(GHCR_CHALLENGE)).toEqual({
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:moooon-b-v/motir-ci-runner:pull',
    });
  });

  it('is null for a missing header, a non-Bearer scheme, or a Bearer with no realm', () => {
    expect(parseBearerChallenge(null)).toBeNull();
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge('Bearer service="ghcr.io"')).toBeNull();
  });
});

describe('probeImagePull — the question Fly asks at machine-create, asked early', () => {
  it('a PUBLIC digest resolves: token, then manifest, then `pullable: true`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(rawUrl));
        urls.push(String(rawUrl));
        if (url.pathname === '/token') return json(200, { token: 'anon-pull-token' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        if (!auth) return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
        return json(
          200,
          {},
          { 'docker-content-digest': 'sha256:446c692d', 'content-type': 'application/json' },
        );
      }),
    );

    const verdict = await probeImagePull(PUBLIC_IMAGE);

    expect(verdict).toEqual({
      pullable: true,
      reference: PUBLIC_IMAGE,
      registry: 'ghcr.io',
      digest: 'sha256:446c692d',
    });
    // The token request must carry the challenge's OWN service + scope — a probe
    // that hardcoded GHCR's would silently stop working on the §5 mirror.
    const tokenUrl = new URL(urls.find((u) => u.includes('/token')) as string);
    expect(tokenUrl.searchParams.get('service')).toBe('ghcr.io');
    expect(tokenUrl.searchParams.get('scope')).toBe('repository:moooon-b-v/motir-ci-runner:pull');
  });

  it('a PRIVATE repository is `pullable: false` — the token endpoint refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        urls.push(String(rawUrl));
        if (url.pathname === '/token') {
          return json(401, {
            errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }],
          });
        }
        return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );

    const verdict = await probeImagePull(PRIVATE_IMAGE);

    expect(verdict).toMatchObject({ pullable: false, reason: 'unauthorized', registry: 'ghcr.io' });
    // No manifest fetch was attempted after the refusal — the question was
    // already answered, and a second call would only be noise in a log.
    expect(urls.filter((u) => u.includes('/manifests/'))).toHaveLength(1);
  });

  it('a registry that demands auth with NO bearer challenge is `unauthorized`, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, {})),
    );
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
      detail: expect.stringContaining('no bearer challenge'),
    });
  });

  it('a token endpoint that answers 200 with NO token is still `unauthorized`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { expires_in: 300 });
        return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
  });

  it('a token endpoint that answers 200 with a NON-JSON body is `unauthorized`, not a crash', async () => {
    // A proxy or a captive portal in front of the registry answers HTML with a
    // 200. Parsing must not throw out of a probe whose whole contract is that it
    // never throws.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') {
          return new Response('<html>sign in</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
  });

  it('a thrown NON-Error still produces a verdict rather than escaping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'undici exploded';
      }),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: null,
      reason: 'unreachable',
      detail: expect.stringContaining('unknown'),
    });
  });

  it('accepts `access_token` as well as `token` — both are in the spec', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { access_token: 'anon' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        return auth ? json(200, {}) : json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({ pullable: true });
  });

  it('a 404 is `absent` — a distinct diagnosis from "private"', async () => {
    // A garbage-collected `registry.fly.io` mirror (§5.2) and a private GHCR
    // package both stop the fleet, and the operator's next action is different
    // for each. The verdict says which.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] })),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'absent',
    });
  });

  it('any other hard NO is `refused` rather than being read as absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(500, {})),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'refused',
      detail: expect.stringContaining('500'),
    });
  });

  it('a 403 after a token is `unauthorized`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { token: 'anon' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        return auth ? json(403, {}) : json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
  });

  it('a TRANSPORT failure is `pullable: null` — never a claim about the image', async () => {
    // ⚠️ THE ARM THAT KEEPS THE PREFLIGHT TRUSTWORTHY. If a DNS failure reported
    // "unpullable", the health check would page an operator about a private
    // image that is in fact public, and the row would be learned as noise.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND ghcr.io');
      }),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: null,
      reason: 'unreachable',
      detail: expect.stringContaining('ENOTFOUND'),
    });
  });

  it('an unparseable reference is `pullable: null`, not `false`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, {})),
    );
    await expect(probeImagePull('  ')).resolves.toMatchObject({
      pullable: null,
      reason: 'unparseable',
      registry: null,
    });
  });

  it('the ghcr-like fixture distinguishes public from private — the probe is not matching everything', async () => {
    // A guard nobody has watched DISAGREE is a guard that may be answering the
    // same thing to every input. One registry fake, two repositories, two
    // verdicts.
    const registry = ghcrLike(['motir-ci-runner']);
    vi.stubGlobal(
      'fetch',
      vi.fn((rawUrl: string, init?: RequestInit) => registry(String(rawUrl), init)),
    );

    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({ pullable: true });
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
  });
});

describe('OrchestratorImageUnpullableError — the sentence that reaches the operator', () => {
  // It is not decoration. This message becomes
  // `ci_runner_provisioning_intent.failure_detail`, which the operator surface
  // renders verbatim — so every arm of it is the difference between a diagnosis
  // and "the orchestrator refused a call".
  it('names the image, the status and the registry error', () => {
    const err = new OrchestratorImageUnpullableError(
      'fly',
      400,
      PRIVATE_IMAGE,
      'failed to get manifest ghcr.io/moooon-b-v/motir-sandbox:claude: unauthorized',
    );
    expect(err.message).toContain(PRIVATE_IMAGE);
    expect(err.message).toContain('HTTP 400');
    expect(err.message).toContain('failed to get manifest');
    expect(err.imageReference).toBe(PRIVATE_IMAGE);
    expect(err.code).toBe('ORCHESTRATOR_API_FAILED');
  });

  it('says "no response" rather than "HTTP null" when the provider never answered', () => {
    const err = new OrchestratorImageUnpullableError('fly', null, PRIVATE_IMAGE, 'socket hang up');
    expect(err.message).toContain('no response');
    expect(err.message).not.toContain('null');
  });

  it('omits an empty detail instead of trailing a bare colon', () => {
    const err = new OrchestratorImageUnpullableError('fly', 400, PRIVATE_IMAGE, '');
    expect(err.message).toContain('(HTTP 400)');
    expect(err.message).not.toContain('HTTP 400:');
  });
});

describe('verifyFleetBootable — §7: the predicate `isFlyFleetConfigured()` deliberately is NOT', () => {
  function stubFleetEnv(image: string) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', image);
  }

  it('answers `bootable` when the configured image resolves anonymously', async () => {
    stubFleetEnv(PUBLIC_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { token: 'anon' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        return auth
          ? json(200, {}, { 'docker-content-digest': 'sha256:446c692d' })
          : json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );

    await expect(verifyFleetBootable()).resolves.toEqual({
      verdict: 'bootable',
      reference: PUBLIC_IMAGE,
      digest: 'sha256:446c692d',
    });
  });

  it("answers `unpullable` — WITH the image reference and the registry's words — for a private image", async () => {
    // THE MOTIR-1980 CASE, caught. This is the exact state the fleet shipped in:
    // configured, and unable to pull anything.
    stubFleetEnv(PRIVATE_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') {
          return json(401, {
            errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }],
          });
        }
        return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );

    const verdict = await verifyFleetBootable();

    expect(verdict.verdict).toBe('unpullable');
    // The reference is IN the verdict, because the operator surface renders the
    // verdict and "the fleet is unhealthy" is not a fix.
    expect(verdict).toMatchObject({ reference: PRIVATE_IMAGE });
    expect((verdict as { detail: string }).detail).toContain('ghcr.io');
    expect((verdict as { detail: string }).detail).toContain('unauthorized');
  });

  it('answers `indeterminate` — NOT `unpullable` — when the registry cannot be reached', async () => {
    stubFleetEnv(PUBLIC_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    await expect(verifyFleetBootable()).resolves.toMatchObject({
      verdict: 'indeterminate',
      reference: PUBLIC_IMAGE,
    });
  });

  it('answers `not_applicable` on the fake adapter, and touches no network', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyFleetBootable()).resolves.toMatchObject({ verdict: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers `not_applicable` on an UNWIRED deployment — a self-hosted build is not a fault', async () => {
    // The same posture `isOrchestratorConfigured()` holds: off-cloud there is no
    // fleet, so there is nothing here to be loud about. A preflight that failed
    // on every self-hosted install would be a daily false alarm.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyFleetBootable()).resolves.toMatchObject({ verdict: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── THE INDEXER IMAGE'S OWN PREFLIGHT (MOTIR-2030) ───────────────────────────
//
// `docs/decisions/fleet-image-pull.md` §5's third constraint, in one sentence:
// "It is a second pull path. The fleet then has two, and each needs §6's
// preflight independently." MOTIR-1989 added the second path; until now
// `verifyFleetBootable()` probed one image and the indexer's was checked by
// nothing.
//
// §5's SECOND constraint is why this is the path that matters most:
// `registry.fly.io` garbage-collects UNREFERENCED images, and a fleet whose
// machines are ephemeral by design references nothing between jobs. So the image
// more likely to vanish was the one with no assertion over it — the MOTIR-1980
// shape ("every predicate answers configured") re-opened one workload over.
//
// The fixtures below give the two paths DIFFERENT references on purpose. A test
// where both images are the same string would pass for a preflight that probed
// the runner's image twice, which is precisely the bug being fixed.

const INDEXER_IMAGE =
  'registry.fly.io/motir-ci-fleet/motir-indexer@sha256:9f2c1ab4de77c0138a6d5e4b2f0c9a7318e4d6b5c2019fae83d7c4b6e5109a2d';

/** The Fly registry's challenge, scoped to the INDEXER repository — so a probe
 *  that asked about the runner instead would be visibly asking the wrong one. */
const FLY_CHALLENGE =
  'Bearer realm="https://registry.fly.io/token",service="registry.fly.io",scope="repository:motir-ci-fleet/motir-indexer:pull"';

describe('verifyIndexFleetBootable — §5.3: the fleet has TWO pull paths, and each needs its own preflight', () => {
  /** A cloud deployment wired for CI. `indexerImage` omitted = indexing not
   *  wired, which is the state the `not_applicable` arm exists for. */
  function stubIndexEnv(indexerImage?: string) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', PUBLIC_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', indexerImage ?? '');
  }

  /** A registry that serves the manifest to a bearer, and hands out an anonymous
   *  token only for the repositories named. Mirrors `ghcrLike`, over the Fly
   *  challenge the indexer's mirror actually returns. */
  function flyLike(publicRepos: string[]) {
    return vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(rawUrl));
      if (url.pathname === '/token') {
        const scope = url.searchParams.get('scope') ?? '';
        return publicRepos.some((repo) => scope.includes(repo))
          ? json(200, { token: 'anon-pull-token' })
          : json(401, { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
      return auth
        ? json(200, {}, { 'docker-content-digest': 'sha256:9f2c1ab4' })
        : json(401, {}, { 'www-authenticate': FLY_CHALLENGE });
    });
  }

  it("probes the INDEXER image — not the runner's — and answers `bootable`", async () => {
    stubIndexEnv(INDEXER_IMAGE);
    const fetchSpy = flyLike(['motir-ci-fleet/motir-indexer']);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyIndexFleetBootable()).resolves.toEqual({
      verdict: 'bootable',
      reference: INDEXER_IMAGE,
      digest: 'sha256:9f2c1ab4',
    });
    // The manifest call went to Fly's registry for the indexer's repository. A
    // preflight that re-probed `MOTIR_RUNNER_IMAGE` would have hit ghcr.io.
    // ⚠️ Compare the parsed HOST, never a substring of the URL: `ghcr.io` can
    // appear in a path or query of a request to somewhere else entirely, so a
    // substring test both under- and over-matches (CodeQL
    // `js/incomplete-url-substring-sanitization`).
    const hosts = fetchSpy.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(hosts).toContain('registry.fly.io');
    expect(hosts).not.toContain('ghcr.io');
  });

  it('answers `unpullable` naming the INDEXER reference — §5.2 GC is the likeliest cause', async () => {
    // The garbage-collected mirror, caught. `absent` is exactly what a registry
    // says about a digest it has cleaned up.
    stubIndexEnv(INDEXER_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { token: 'anon-pull-token' });
        return json(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
      }),
    );

    const verdict = await verifyIndexFleetBootable();

    expect(verdict.verdict).toBe('unpullable');
    // ⚠️ THE INDEXER'S reference, never the runner's. The operator surface is a
    // message; naming the wrong image sends the fix to the wrong registry.
    expect(verdict).toMatchObject({ reference: INDEXER_IMAGE });
    expect((verdict as { reference: string }).reference).not.toBe(PUBLIC_IMAGE);
    expect((verdict as { detail: string }).detail).toContain('registry.fly.io');
    expect((verdict as { detail: string }).detail).toContain('absent');
  });

  it('answers `indeterminate` — NOT `unpullable` — when the registry cannot be reached', async () => {
    // The same boundary its twin holds: a transport failure is never a claim
    // about the image.
    stubIndexEnv(INDEXER_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND registry.fly.io');
      }),
    );

    await expect(verifyIndexFleetBootable()).resolves.toMatchObject({
      verdict: 'indeterminate',
      reference: INDEXER_IMAGE,
    });
  });

  it('answers `not_applicable` when MOTIR_INDEXER_IMAGE is UNSET on a working CI deployment', async () => {
    // ⚠️ THE ARM THIS CARD EXISTS FOR. A deployment that runs CI but has not
    // wired the indexer simply does not INDEX — it is not broken — and reporting
    // it `unpullable` would fail a daily health check over a feature nobody
    // enabled. That false alarm is what teaches an operator to ignore the row,
    // which is how the next MOTIR-1980 gets missed.
    stubIndexEnv(); // fleet fully configured; only the indexer image is absent
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    const verdict = await verifyIndexFleetBootable();

    expect(verdict.verdict).toBe('not_applicable');
    expect(fetchSpy).not.toHaveBeenCalled();
    // And the RUNNER path on the very same deployment is unaffected — the two
    // verdicts are independent, which is the whole point of splitting them.
    vi.stubGlobal('fetch', flyLike([]));
    await expect(verifyFleetBootable()).resolves.toMatchObject({ verdict: 'unpullable' });
  });

  it('answers `not_applicable` on the fake adapter, and touches no network', async () => {
    // `indexFleetConfig()` returns a well-formed fake DIGEST under the fake
    // adapter, so a preflight that probed it unconditionally would try to reach
    // a registry for `motir/indexer@sha256:fake`. It must not.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', INDEXER_IMAGE);
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyIndexFleetBootable()).resolves.toMatchObject({ verdict: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers `not_applicable` on an UNWIRED deployment — a self-hosted build is not a fault', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', '');
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyIndexFleetBootable()).resolves.toMatchObject({ verdict: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
