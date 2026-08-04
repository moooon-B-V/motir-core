import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// A zero-dependency release-lane script, deliberately `.mjs` — it runs on a bare
// runner with no install and no build step. Its typed contract lives beside it
// in `assert-public.d.mts`.
import {
  assertPublic,
  parseBearerChallenge,
  parseReference,
  probeAnonymousPull,
  resolveReferences,
  main,
} from '../sandbox/smoke/assert-public.mjs';

// The anonymous-pull guard (MOTIR-2010), driven against a REAL registry rather
// than a mocked fetch: a stub HTTP server that speaks the OCI Distribution v2
// challenge → token → manifest dance, so the thing under test is the wire
// behaviour it will meet at ghcr.io, not a fake's idea of it. The same choice
// `login-smoke.sh` makes with `stub-server.mjs` for the device flow.
//
// What this suite is FOR: the script exists because `cli-v0.1.0` published nine
// images that no user could pull, green. A guard that is itself wrong — that
// says PUBLIC when the registry refuses, or that reports a network blip as
// "private" — would reinstate exactly that failure with more ceremony. So the
// interesting cases here are the negative ones and the control.

interface StubState {
  /** Repositories the stub will serve to an anonymous caller. */
  public: Set<string>;
  /** Repositories that exist but refuse an anonymous token — i.e. private. */
  private: Set<string>;
  /** Repositories the token endpoint answers for but whose manifest 404s. */
  absent: Set<string>;
}

const state: StubState = { public: new Set(), private: new Set(), absent: new Set() };
let server: Server;
let origin = '';

/** The stub's host, in the `<registry>/<repo>` form the script parses. */
const ref = (repository: string, reference = 'latest'): string =>
  `${origin}/${repository}:${reference}`;

/** The script always talks https; the stub is http, so requests are rewritten
 *  onto it. Everything else — headers, statuses, the two round trips — is real. */
const stubFetch: typeof fetch = (input, init) =>
  fetch(String(input).replace('https://', 'http://'), init);

const probe = (reference: string) => probeAnonymousPull(reference, { fetch: stubFetch });

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');

    // The token endpoint: hand a token out for public repositories only. This is
    // precisely how a v2 registry encodes "is this public?" on the wire.
    if (url.pathname === '/token') {
      const scope = url.searchParams.get('scope') ?? '';
      const repository = /^repository:(.+):pull$/.exec(scope)?.[1] ?? '';
      if (state.public.has(repository) || state.absent.has(repository)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token: 'anonymous-token' }));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }));
      return;
    }

    const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
    if (manifest) {
      const repository = manifest[1] as string;
      const authorized = req.headers.authorization === 'Bearer anonymous-token';
      if (!authorized) {
        // The challenge. Note it is issued for repositories that do not exist
        // too — which is why a challenge alone can never prove a package is
        // there, only that the registry is willing to talk about the name.
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="http://${origin.replace('http://', '')}/token",service="stub",scope="repository:${repository}:pull"`,
        });
        res.end();
        return;
      }
      if (state.absent.has(repository)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/vnd.oci.image.index.v1+json',
        'docker-content-digest': 'sha256:' + 'a'.repeat(64),
      });
      res.end('{}');
      return;
    }

    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `127.0.0.1:${port}`;

  state.public.add('org/public-image').add('control/image');
  state.private.add('org/private-image');
  state.absent.add('org/absent-image');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the anonymous pull probe', () => {
  // `toMatchObject` throughout, rather than reading a property off the verdict:
  // the return type is a discriminated union, so `verdict.reason` does not
  // typecheck until `pullable` has been narrowed — and a test that narrows by
  // hand asserts less than one that states the whole shape it expects.
  it('says PUBLIC when the registry serves the manifest to a caller with no credential', async () => {
    expect(await probe(ref('org/public-image'))).toMatchObject({
      pullable: true,
      digest: `sha256:${'a'.repeat(64)}`,
    });
  });

  it('never sends an Authorization header of its own — the whole measurement is its absence', async () => {
    const seen: (string | undefined)[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get('authorization') ?? undefined);
      return stubFetch(input, init);
    };
    await probeAnonymousPull(ref('org/public-image'), { fetch: recordingFetch });
    // Three calls: the challenge, the token request, the authorized retry. Only
    // the LAST may carry a header, and only the token the registry just minted
    // for an anonymous caller.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBeUndefined();
    expect(seen[2]).toBe('Bearer anonymous-token');
  });

  it('says PRIVATE when the token endpoint refuses an anonymous pull token', async () => {
    expect(await probe(ref('org/private-image'))).toMatchObject({
      pullable: false,
      reason: 'unauthorized',
      // The scope is carried out so a failure message can name the PACKAGE the
      // registry is scoping to — which is what tells you how many flips it takes.
      scope: 'repository:org/private-image:pull',
    });
  });

  it('distinguishes ABSENT from private — a 404 behind a valid token is not a visibility problem', async () => {
    expect(await probe(ref('org/absent-image'))).toMatchObject({
      pullable: false,
      reason: 'absent',
    });
  });

  it('reports a transport failure as "could not tell", never as private', async () => {
    // The three-valued split is the point: collapsing this into `false` would
    // let one DNS blip fail a release with "your package is private" (it is not).
    const verdict = await probeAnonymousPull('127.0.0.1:1/org/image:latest', {
      fetch: (input, init) => fetch(String(input).replace('https://', 'http://'), init),
    });
    expect(verdict).toMatchObject({ pullable: null, reason: 'unreachable' });
  });

  it('refuses a reference with no registry host rather than guessing Docker Hub', async () => {
    expect(await probe('motir-sandbox:claude')).toMatchObject({
      pullable: null,
      reason: 'unparseable',
    });
  });
});

describe('reference parsing', () => {
  it('splits a digest reference, a tagged one, and a host with a port', () => {
    expect(parseReference('ghcr.io/moooon-b-v/motir-sandbox@sha256:abc')).toEqual({
      registry: 'ghcr.io',
      repository: 'moooon-b-v/motir-sandbox',
      reference: 'sha256:abc',
    });
    expect(parseReference('ghcr.io/moooon-b-v/motir-sandbox:claude')).toEqual({
      registry: 'ghcr.io',
      repository: 'moooon-b-v/motir-sandbox',
      reference: 'claude',
    });
    // A port is a colon that is NOT a tag separator — the classic parser trap.
    expect(parseReference('localhost:5000/team/image')).toEqual({
      registry: 'localhost:5000',
      repository: 'team/image',
      reference: 'latest',
    });
    expect(parseReference('ubuntu')).toBeNull();
    expect(parseReference('  ')).toBeNull();
  });

  it('reads a bearer challenge verbatim, so the probe is not GHCR-specific', () => {
    expect(
      parseBearerChallenge(
        'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="r:x:pull"',
      ),
    ).toEqual({ realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'r:x:pull' });
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge(null)).toBeNull();
  });
});

describe('the release-lane assertion', () => {
  const options = () => ({ fetch: stubFetch, control: ref('control/image'), attempts: 1 });

  it('exits 0 when every published reference pulls anonymously', async () => {
    const result = await assertPublic([ref('org/public-image')], options());
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain('pull anonymously');
  });

  it('exits 1 — a DEFINITE refusal — when one of them is private', async () => {
    const result = await assertPublic(
      [ref('org/public-image'), ref('org/private-image')],
      options(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain('1 of 2');
  });

  it('exits 2 and probes NOTHING when the positive control is not public', async () => {
    // The load-bearing case. A probe that has silently broken answers "private"
    // to everything, and "private" is the answer this script is hunting — so
    // without a control, a broken probe reads as a confirmed bug and the real
    // one hides behind it. A failed control must never produce a verdict.
    const result = await assertPublic([ref('org/public-image')], {
      ...options(),
      control: ref('org/private-image'),
    });
    expect(result.exitCode).toBe(2);
    expect(result.results).toEqual([]);
    expect(result.summary).toContain('proves NOTHING');
  });

  it('exits 2, not 1, when a reference could not be reached at all', async () => {
    const result = await assertPublic(['127.0.0.1:1/org/image:latest'], options());
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain('could not be probed');
  });
});

describe('the digest directory the release lane hands it', () => {
  const io = (files: Record<string, string>) => ({
    readdir: () => Promise.resolve(Object.keys(files)),
    readFile: (path: string) => Promise.resolve(files[path.split('/').pop() as string] as string),
    log: () => {},
    error: () => {},
  });

  it('turns one file per published name into digest-pinned references', async () => {
    const refs = await resolveReferences(
      ['--image', 'ghcr.io/x/y', '--digests', 'digests'],
      io({ base: `sha256:${'b'.repeat(64)}\n`, claude: `sha256:${'c'.repeat(64)}\n` }),
    );
    expect(refs).toEqual([
      `ghcr.io/x/y@sha256:${'b'.repeat(64)}`,
      `ghcr.io/x/y@sha256:${'c'.repeat(64)}`,
    ]);
  });

  it('refuses an EMPTY digest directory instead of passing "0 of 0 refused"', async () => {
    // The failure mode `sandbox-published`'s "No digest was published" check
    // exists for, repeated here: a matrix leg that silently dropped uploads
    // nothing, and a checker that iterates an empty list is green and blind.
    await expect(
      resolveReferences(['--image', 'ghcr.io/x/y', '--digests', 'digests'], io({})),
    ).rejects.toThrow(/no published digests/);
  });

  it('refuses a recorded digest that is not a sha256 reference', async () => {
    await expect(
      resolveReferences(
        ['--image', 'ghcr.io/x/y', '--digests', 'digests'],
        io({ base: 'claude\n' }),
      ),
    ).rejects.toThrow(/not a sha256 reference/);
  });

  it('takes explicit --ref arguments, which is how a human runs it from a shell', async () => {
    expect(
      await resolveReferences(['--ref', 'ghcr.io/x/y:claude', '--ref', 'ghcr.io/x/y:base'], io({})),
    ).toEqual(['ghcr.io/x/y:claude', 'ghcr.io/x/y:base']);
  });
});

describe('what it prints when the images are unobtainable', () => {
  it('spells out the IRREVERSIBLE one-package flip as the remediation', async () => {
    const lines: string[] = [];
    const code = await main(
      ['--ref', ref('org/private-image'), '--control', ref('control/image'), '--attempts', '1'],
      {
        readdir: () => Promise.resolve([]),
        readFile: () => Promise.resolve(''),
        log: (line: string) => lines.push(line),
        error: (line: string) => lines.push(line),
        fetch: stubFetch,
      },
    );
    expect(code).toBe(1);
    const message = lines.join('\n');
    // A failure message that only says "private" leaves the reader to rediscover
    // that the fix is a UI click, that it covers every tag at once, and that it
    // cannot be undone. All three go in the message.
    expect(message).toContain('::error::');
    expect(message).toContain('Change visibility');
    expect(message).toContain('ONE package');
    expect(message).toContain('IRREVERSIBLE');
  });

  it('does NOT offer the visibility flip when the reference is merely ABSENT', async () => {
    // The two refusals look alike in the table and need opposite fixes — and
    // one of them is irreversible, so proposing it for a missing digest is the
    // expensive kind of wrong. `absent` means the registry handed out a token
    // and then had nothing to serve, which is a release problem.
    const lines: string[] = [];
    const code = await main(
      ['--ref', ref('org/absent-image'), '--control', ref('control/image'), '--attempts', '1'],
      {
        readdir: () => Promise.resolve([]),
        readFile: () => Promise.resolve(''),
        log: (line: string) => lines.push(line),
        error: (line: string) => lines.push(line),
        fetch: stubFetch,
      },
    );
    expect(code).toBe(1);
    const message = lines.join('\n');
    expect(message).toContain('ABSENT rather than private');
    expect(message).toContain('do not flip anything');
    expect(message).not.toContain('Change visibility');
  });
});
