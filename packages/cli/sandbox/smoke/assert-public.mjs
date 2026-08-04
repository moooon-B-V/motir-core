#!/usr/bin/env node
//
// CAN A STRANGER PULL THE IMAGE THE DOCS TELL THEM TO PULL? (MOTIR-2010)
//
// `docs/cli.md` § The sandbox opens with the words "Pull and go — no checkout,
// no build" over a `docker run ghcr.io/moooon-b-v/motir-sandbox:claude`. That
// sentence is a claim about a registry's ACCESS CONTROL, and nothing in the
// release lane ever tested it. So `cli-v0.1.0` published nine images, recorded
// nine digests in the README, went green — and the package was PRIVATE. Every
// user outside the org got `unauthorized` from the first command in the docs,
// silently, because `motir auto` in a normal console still worked and no
// assertion anywhere asked the question. This script is that assertion.
//
// ── Why it is a SEPARATE job and not a step of `sandbox-published` ──────────
//
// `sandbox-images.yml`'s existing verify job already pulls every published image
// back by digest — but it runs `docker/login-action` first, so it proves the
// PUBLISHER can pull, which was never in doubt. "Published" and "obtainable" are
// different claims, and only a caller with no credential can tell them apart
// (`notes.html` #207 — PULL it as the consumer, don't cite the lane). Hence a
// job with no registry login and no `packages:` permission, running a script
// that sends no `Authorization` header on any request. The anonymity is
// structural: it does not depend on the runner's ambient docker config, which is
// also what makes this runnable, unchanged and meaningfully, from a developer's
// already-logged-in shell.
//
// ── The control, without which a red verdict proves nothing ────────────────
//
// A probe that has quietly broken — DNS, a proxy, a changed token endpoint —
// reports "private" for everything, and "private" is exactly the answer we are
// looking for, so it would be believed. Every run therefore first probes a
// repository KNOWN to be public and requires a token back. A failed control is
// reported as INDETERMINATE, never as a visibility verdict about our images.
// (Same discipline as `docs/decisions/fleet-image-pull.md` §2.1, which pairs its
// GHCR probe with `homebrew/core/git`.)
//
// ── Three-valued on purpose ────────────────────────────────────────────────
//
// `public` / `private-or-absent` / `could not tell`, and the exit code
// distinguishes them (0 / 1 / 2). The app-side twin of this probe,
// `lib/orchestrator/imagePull.ts` (`probeImagePull`, the fleet's boot
// preflight), makes the same split for the same reason: collapsing "the
// registry refused" into "the network hiccuped" produces either a release that
// fails on a DNS blip or a private image that hides behind a retry. The two
// implementations are deliberately separate — that one is app code behind the
// orchestrator port, this one is a zero-dependency script the CLI package ships
// and a human can run — but they answer the same question, so keep their
// verdicts legible against each other.
//
// Usage:
//   assert-public.mjs --image <registry/repo> --digests <dir> [--names a,b,c]
//   assert-public.mjs --ref ghcr.io/moooon-b-v/motir-sandbox:claude [--ref …]
//
// `--digests <dir>` is the release lane's form: one file per published name,
// each holding that image's `sha256:…`, exactly as the push jobs upload them.
// Digests, not tags, because a moving tag can point somewhere else by the time
// this runs and the whole point is to check the bytes that were just pushed.

/**
 * The positive control: a reference that is public, resolves, and belongs to
 * nobody here.
 *
 * `astral-sh/uv` is the same public GHCR image `docs/decisions/fleet-image-pull.md`
 * §2.2 booted on Fly to prove an anonymous pull works end to end. It is
 * deliberately OUTSIDE the org — an in-org control would share a failure mode
 * with the thing under test (one org-wide packages change could take both down),
 * and a control that fails alongside the target is not a control.
 *
 * ⚠️ It must name a reference that RESOLVES, not just a public repository. The
 * first version of this pointed at `ghcr.io/homebrew/core/git`, which is public
 * and hands out an anonymous token happily — and then 404s, because Homebrew
 * publishes no `:latest`. The probe called that `absent` and correctly refused
 * to report anything, which is the control doing its job before it ever left the
 * branch.
 */
export const CONTROL_REFERENCE = 'ghcr.io/astral-sh/uv:latest';

/** Manifest media types to accept. A digest-pinned multi-arch reference resolves
 *  to an INDEX, a single-arch one to a plain manifest, and a registry answers
 *  404 for a media type the client did not ask for — so all four, always. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

const REQUEST_TIMEOUT_MS = 15_000;

/** How many times a "could not tell" is retried before it is reported as one.
 *  A transport failure is the one verdict worth re-asking for; a refusal is not
 *  going to change on the second try. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Split `registry/repository[:tag|@digest]` into the pieces a registry call
 * needs. Deliberately narrower than the app-side parser: everything this script
 * is pointed at is fully qualified, so an unqualified `ubuntu` (which would mean
 * Docker Hub's `library/ubuntu`) is refused rather than guessed at.
 */
export function parseReference(reference) {
  const trimmed = String(reference ?? '').trim();
  if (!trimmed) return null;

  let name = trimmed;
  let tagOrDigest = 'latest';
  const at = trimmed.indexOf('@');
  if (at >= 0) {
    name = trimmed.slice(0, at);
    tagOrDigest = trimmed.slice(at + 1);
  } else {
    const lastSlash = trimmed.lastIndexOf('/');
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon > lastSlash) {
      name = trimmed.slice(0, lastColon);
      tagOrDigest = trimmed.slice(lastColon + 1);
    }
  }

  const segments = name.split('/');
  const host = segments[0] ?? '';
  // A registry host has a dot or a port, or is localhost. Without one there is
  // no host, and a reference with no host is not something to guess about.
  if (segments.length < 2 || !(host.includes('.') || host.includes(':') || host === 'localhost')) {
    return null;
  }
  const repository = segments.slice(1).join('/');
  if (!repository || !tagOrDigest) return null;

  return { registry: host, repository, reference: tagOrDigest };
}

/** Parse a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge
 *  into its params. Returning them verbatim rather than hardcoding GHCR's is
 *  what lets this work against any v2 registry. */
export function parseBearerChallenge(header) {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.*)$/i.exec(header);
  if (!match) return null;
  const params = {};
  for (const part of match[1].matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) params[part[1]] = part[2];
  return params.realm ? params : null;
}

/**
 * Ask a registry, WITH NO CREDENTIAL, whether it will serve this manifest.
 *
 * Returns the three-valued verdict described in the header. Never throws: every
 * failure mode is a verdict, because the caller's job is to print a sentence a
 * human can act on, not a stack trace.
 */
export async function probeAnonymousPull(reference, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const parsed = parseReference(reference);
  if (!parsed) {
    return {
      pullable: null,
      reference,
      reason: 'unparseable',
      detail: 'not a fully-qualified <registry>/<repository>[:tag|@digest] reference',
    };
  }

  const { registry, repository } = parsed;
  const url = `https://${registry}/v2/${repository}/manifests/${parsed.reference}`;
  // NOTE: no `authorization` header is ever set on this request, and no docker
  // config is read. That absence is the entire measurement.
  const get = (headers) =>
    fetchImpl(url, {
      method: 'GET',
      headers: { accept: MANIFEST_ACCEPT, 'user-agent': 'motir-sandbox-assert-public', ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  try {
    let response = await get({});
    let scope = null;

    if (response.status === 401) {
      // The standard challenge → anonymous-token dance. A registry that hands a
      // token to a nobody for a public repository and refuses for a private one
      // is precisely how "is this public?" is answered on the wire.
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
      if (!challenge) {
        return {
          pullable: false,
          reference,
          reason: 'unauthorized',
          detail: 'the registry demanded authentication and offered no bearer challenge',
        };
      }
      scope = challenge.scope ?? null;
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
      if (challenge.scope) tokenUrl.searchParams.set('scope', challenge.scope);
      const tokenResponse = await fetchImpl(tokenUrl.toString(), {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'motir-sandbox-assert-public' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = tokenResponse.ok ? await tokenResponse.json().catch(() => null) : null;
      const token = body && typeof body === 'object' ? (body.token ?? body.access_token) : null;
      if (typeof token !== 'string' || token.length === 0) {
        return {
          pullable: false,
          reference,
          scope,
          reason: 'unauthorized',
          detail:
            'the registry refused an anonymous pull token — the package is private, or absent',
        };
      }
      response = await get({ authorization: `Bearer ${token}` });
    }

    if (response.ok) {
      return {
        pullable: true,
        reference,
        scope,
        digest: response.headers.get('docker-content-digest'),
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        pullable: false,
        reference,
        scope,
        reason: 'unauthorized',
        detail: `the registry refused the manifest to an anonymous caller (HTTP ${response.status})`,
      };
    }
    if (response.status === 404) {
      return {
        pullable: false,
        reference,
        scope,
        reason: 'absent',
        detail: 'no such repository, tag or digest (HTTP 404)',
      };
    }
    return {
      pullable: false,
      reference,
      scope,
      reason: 'refused',
      detail: `the registry refused the manifest (HTTP ${response.status})`,
    };
  } catch (err) {
    // Transport, DNS, TLS or the deadline. NOT a statement about the image.
    return {
      pullable: null,
      reference,
      reason: 'unreachable',
      detail: `the registry could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Probe, retrying only the "could not tell" arm. */
async function probeWithRetry(reference, options) {
  const attempts = options.attempts ?? ATTEMPTS;
  let verdict;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verdict = await probeAnonymousPull(reference, options);
    if (verdict.pullable !== null) return verdict;
    if (attempt < attempts) await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
  }
  return verdict;
}

/**
 * The whole check: control first, then every reference.
 *
 * `exitCode` is the verdict of record — 0 every reference is anonymously
 * pullable, 1 at least one DEFINITE refusal, 2 the probe could not tell (which
 * includes a failed control). Returned rather than applied so the unit tests can
 * assert the decision without spawning a process.
 */
export async function assertPublic(references, options = {}) {
  const control = options.control ?? CONTROL_REFERENCE;
  const results = [];

  const controlVerdict = await probeWithRetry(control, options);
  if (controlVerdict.pullable !== true) {
    return {
      exitCode: 2,
      control: controlVerdict,
      results,
      // The one message this script must never get wrong: a broken probe says
      // "private" about everything, and "private" is the answer being hunted.
      summary: `the positive control ${control} did not come back public (${controlVerdict.reason ?? 'no reason'}) — this run proves NOTHING about the sandbox images`,
    };
  }

  for (const reference of references) {
    results.push(await probeWithRetry(reference, options));
  }

  const refused = results.filter((r) => r.pullable === false);
  const unknown = results.filter((r) => r.pullable === null);
  const exitCode = refused.length > 0 ? 1 : unknown.length > 0 ? 2 : 0;
  const summary =
    refused.length > 0
      ? `${refused.length} of ${results.length} published references CANNOT be pulled anonymously`
      : unknown.length > 0
        ? `${unknown.length} of ${results.length} references could not be probed`
        : `all ${results.length} published references pull anonymously`;
  return { exitCode, control: controlVerdict, results, summary };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

function argsOf(argv, name) {
  return argv.flatMap((value, i) => (value === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
}

/** Build the reference list from either `--ref` (a human at a shell) or
 *  `--image` + `--digests` (the release lane, pinned to what it just pushed). */
export async function resolveReferences(argv, io) {
  const refs = argsOf(argv, 'ref');
  if (refs.length > 0) return refs;

  const image = argOf(argv, 'image');
  const digestsDir = argOf(argv, 'digests');
  if (!image || !digestsDir) {
    throw new Error(
      'usage: assert-public.mjs --image <registry/repo> --digests <dir> | --ref <ref>',
    );
  }
  const explicit = argOf(argv, 'names');
  const names = explicit ? explicit.split(',').filter(Boolean) : await io.readdir(digestsDir);
  if (names.length === 0) {
    // An empty digest directory would otherwise sail through as "0 of 0 refused".
    throw new Error(`no published digests found in ${digestsDir} — the release is incomplete`);
  }
  return Promise.all(
    names.sort().map(async (name) => {
      const digest = (await io.readFile(`${digestsDir}/${name}`)).trim();
      if (!digest.startsWith('sha256:')) {
        throw new Error(`the digest recorded for '${name}' is not a sha256 reference: '${digest}'`);
      }
      return `${image}@${digest}`;
    }),
  );
}

export async function main(argv, io) {
  const references = await resolveReferences(argv, io);
  const { exitCode, control, results, summary } = await assertPublic(references, {
    control: argOf(argv, 'control'),
    attempts: argOf(argv, 'attempts') ? Number(argOf(argv, 'attempts')) : undefined,
    // Unset in production, so the probe uses the platform fetch. The tests pass
    // one that speaks to a stub registry.
    fetch: io.fetch,
  });

  io.log(`control  ${control.pullable === true ? 'PUBLIC ' : 'FAILED '} ${control.reference}`);
  for (const result of results) {
    const verdict =
      result.pullable === true ? 'PUBLIC ' : result.pullable === false ? 'PRIVATE' : 'UNKNOWN';
    io.log(`         ${verdict} ${result.reference}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  io.log(summary);

  if (exitCode === 1) {
    // Two refusals that look alike in a table and need opposite fixes. A
    // package the registry WON'T serve is a visibility problem; one it HASN'T
    // GOT is a release that did not finish, or a digest transcribed wrong.
    // Printing the visibility remediation for both is how a wrong fix gets
    // attempted first — and this one cannot be undone.
    if (results.some((r) => r.pullable === false && r.reason === 'unauthorized')) {
      io.error(
        `::error::${summary}. The images are not obtainable by the users docs/cli.md is ` +
          `written for. FIX: GitHub → the moooon-B-V org → Packages → motir-sandbox → ` +
          `Package settings → Change visibility → Public. It is ONE package (every profile ` +
          `tag shares the repository scope repository:moooon-b-v/motir-sandbox:pull), so one ` +
          `flip covers every tag — and the flip is IRREVERSIBLE ` +
          `(docs/decisions/fleet-image-pull.md §4.1).`,
      );
    }
    if (results.some((r) => r.pullable === false && r.reason !== 'unauthorized')) {
      io.error(
        `::error::${summary}. At least one reference is ABSENT rather than private — the ` +
          `registry served a token and then had nothing to serve. That is an incomplete ` +
          `release or a mistranscribed digest, NOT a visibility setting; do not flip ` +
          `anything to fix it.`,
      );
    }
  } else if (exitCode === 2) {
    io.error(`::error::${summary} — this is a PROBE failure, not a visibility verdict.`);
  }
  return exitCode;
}

// Only when executed, never when imported by the unit tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { readdir, readFile } = await import('node:fs/promises');
  const io = {
    readdir: (dir) => readdir(dir),
    readFile: (path) => readFile(path, 'utf8'),
    // The report goes to STDOUT (it is the output a human asked for), the
    // failures to stderr where the runner's `::error::` annotations belong.
    // `process.stdout.write` rather than `console.log` — the repo's `no-console`
    // rule allows only `warn`/`error`, and a disable comment here would be
    // suppressing the rule rather than respecting it.
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => console.error(line),
  };
  main(process.argv.slice(2), io).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
