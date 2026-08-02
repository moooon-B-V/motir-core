// CAN THIS IMAGE REFERENCE BE PULLED WITHOUT A CREDENTIAL? (Story MOTIR-1916 ·
// MOTIR-2006) — the OCI Distribution v2 probe behind the fleet's boot preflight.
//
// `docs/decisions/fleet-image-pull.md` is why this file exists, and §0 is the
// finding that shapes it: **the Fly Machines API has no registry-credential
// field at all** (§2.3, measured — there is no `registry_auth`, no `docker_auth`,
// no `image_pull_secret`). So "can Fly boot this image?" reduces, exactly, to
// "does the registry serve this manifest to an ANONYMOUS caller?" — which is a
// question this repository can ask directly, cheaply, and without Fly.
//
// That reduction is the whole reason the probe is provider-neutral. It names no
// Fly concept, takes an image reference and nothing else, and therefore lives
// OUTSIDE `adapters/fly/` — `tests/ciFleet/orchestratorPortBoundary.test.ts`
// would fail it otherwise, and rightly: a registry is not a container platform.
// `verifyFleetBootable()` in the composition root is what marries this to the
// fleet's configured image.
//
// ⚠️ THREE-VALUED ON PURPOSE — `true` / `false` / "could not tell". A registry
// that refuses is a statement ABOUT THE IMAGE; a registry that cannot be reached
// is a statement about the network, and collapsing the two would let one DNS
// blip page an operator with "the runner image is private" (it isn't) or, worse,
// let a genuinely private image hide behind a retry. §6's preflight only fails
// loudly on the DEFINITE refusal; see `FleetBootableVerdict`.

/** How long one registry call may take. A preflight that hangs is a preflight
 *  that turns into a timeout somewhere less legible than here. */
const REGISTRY_TIMEOUT_MS = 10_000;

/** Docker Hub's real registry host — the one `nginx:latest` means. Hub is the
 *  only registry whose references omit their host, so it is the only one that
 *  needs naming here. */
const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

/** The manifest media types a v2 registry may answer with. All four, because a
 *  digest-pinned multi-arch reference resolves to an INDEX (`…index.v1+json` is
 *  what `ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692d…` returns, measured
 *  2026-08-02) while a single-arch one resolves to a plain manifest — and a
 *  registry answers 404 for a media type the client did not accept. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

/** An image reference, split into the two things a registry call needs. */
export interface ParsedImageReference {
  /** The registry HOST (`ghcr.io`, `registry.fly.io`, `registry-1.docker.io`). */
  readonly registry: string;
  /** The repository path, Hub-normalised (`ubuntu` → `library/ubuntu`). */
  readonly repository: string;
  /** A `sha256:…` digest or a tag — whatever the reference pinned. */
  readonly reference: string;
  /** True when `reference` is a digest, which is what §7.2 requires of the
   *  fleet's image. Carried out so a caller can say so without re-parsing. */
  readonly isDigest: boolean;
}

/**
 * The probe's answer about one reference.
 *
 * `pullable: null` is the "could not tell" arm and it is NOT a failure — see the
 * header. Every arm carries `reference` so a log line names the image without
 * the caller re-assembling it.
 */
export type ImagePullVerdict =
  /** The registry served the manifest to an anonymous caller. Fly can boot it. */
  | { pullable: true; reference: string; registry: string; digest: string | null }
  /** DEFINITE refusal. `unauthorized` = private (or the token endpoint said so);
   *  `absent` = the repository or digest does not exist; `refused` = any other
   *  hard registry NO. All three mean a Fly Machine create will 400. */
  | {
      pullable: false;
      reference: string;
      registry: string;
      reason: 'unauthorized' | 'absent' | 'refused';
      detail: string;
    }
  /** Could not tell: a transport failure, or a reference this probe cannot
   *  parse. Never a statement about the image. */
  | {
      pullable: null;
      reference: string;
      registry: string | null;
      reason: 'unreachable' | 'unparseable';
      detail: string;
    };

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown';
}

/** Does this first path segment name a HOST rather than a Docker Hub namespace?
 *  The standard rule, and the only one there is: a host has a dot or a port, or
 *  is literally `localhost`. `moooon-b-v/motir-ci-runner` has neither, which is
 *  why an unqualified reference means Hub. */
function looksLikeRegistryHost(segment: string): boolean {
  return segment === 'localhost' || segment.includes('.') || segment.includes(':');
}

/**
 * Split `[registry/]repository[:tag|@digest]`.
 *
 * Returns null for a reference this cannot make sense of, which the caller turns
 * into `unparseable` — never into "unpullable". A parser that guessed would
 * report a private image for what is really a typo in an env var, and the whole
 * point of §6's preflight is that its verdict can be trusted.
 */
export function parseImageReference(image: string): ParsedImageReference | null {
  const trimmed = image.trim();
  if (trimmed.length === 0) return null;

  // The digest/tag split first: `@` is unambiguous, and for `:` only the LAST
  // one after the final `/` can be a tag (a registry host may carry `:port`).
  let name = trimmed;
  let reference = 'latest';
  let isDigest = false;
  const at = trimmed.indexOf('@');
  if (at >= 0) {
    name = trimmed.slice(0, at);
    reference = trimmed.slice(at + 1);
    isDigest = true;
  } else {
    const lastSlash = trimmed.lastIndexOf('/');
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon > lastSlash) {
      name = trimmed.slice(0, lastColon);
      reference = trimmed.slice(lastColon + 1);
    }
  }
  if (name.length === 0 || reference.length === 0) return null;

  const segments = name.split('/');
  let registry = DOCKER_HUB_REGISTRY;
  let repository = name;
  if (segments.length > 1 && looksLikeRegistryHost(segments[0] as string)) {
    registry = segments[0] as string;
    repository = segments.slice(1).join('/');
  } else if (segments.length === 1) {
    // `ubuntu` is `library/ubuntu` on Hub. Only Hub does this.
    repository = `library/${name}`;
  }
  if (repository.length === 0) return null;

  return { registry, repository, reference, isDigest };
}

/**
 * Parse a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge.
 *
 * This is how a v2 registry says "ask that endpoint for a token first", and it
 * is the ONLY reason the probe needs two round-trips. Returning the params
 * verbatim (rather than hardcoding GHCR's) is what makes the probe work against
 * Hub and any other v2 registry unchanged.
 */
export function parseBearerChallenge(header: string | null): Record<string, string> | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.*)$/i.exec(header);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const part of (match[1] as string).matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
    params[part[1] as string] = part[2] as string;
  }
  return params['realm'] ? params : null;
}

async function registryFetch(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    headers: { 'user-agent': 'motir', ...headers },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
}

/** Ask the challenge's realm for an ANONYMOUS pull token. A registry that
 *  refuses here has already answered the question — the repository is not
 *  public — so a null is returned and the caller reports `unauthorized`. */
async function anonymousToken(challenge: Record<string, string>): Promise<string | null> {
  const url = new URL(challenge['realm'] as string);
  if (challenge['service']) url.searchParams.set('service', challenge['service']);
  if (challenge['scope']) url.searchParams.set('scope', challenge['scope']);
  const res = await registryFetch(url.toString(), { accept: 'application/json' });
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  const token =
    body && typeof body === 'object' && !Array.isArray(body)
      ? ((body as Record<string, unknown>)['token'] ??
        (body as Record<string, unknown>)['access_token'])
      : null;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Can an anonymous caller resolve this image reference's manifest?
 *
 * The exact question Fly answers at machine-create time, asked before any job
 * depends on the answer. Measured against the real thing on 2026-08-02: the flow
 * below returns `pullable: true` for
 * `ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692d…` (public since
 * MOTIR-2009) and `pullable: false, reason: 'unauthorized'` for
 * `ghcr.io/moooon-b-v/motir-sandbox:claude`, which is still private — the same
 * pair of states Fly itself reports as HTTP 201 and HTTP 400 `failed to get
 * manifest …: unauthorized`.
 *
 * NEVER THROWS. Every failure is a verdict, because the callers are a health
 * check and an operator surface; a throw would turn "could not reach ghcr.io"
 * into a stack trace in the one place that exists to produce a sentence.
 */
export async function probeImagePull(image: string): Promise<ImagePullVerdict> {
  const parsed = parseImageReference(image);
  if (!parsed) {
    return {
      pullable: null,
      reference: image,
      registry: null,
      reason: 'unparseable',
      detail: 'the image reference could not be parsed as [registry/]repository[:tag|@digest]',
    };
  }

  const { registry, repository, reference } = parsed;
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${reference}`;

  try {
    let res = await registryFetch(manifestUrl, { accept: MANIFEST_ACCEPT });

    if (res.status === 401) {
      // The standard challenge → anonymous-token dance. A registry that hands
      // out a token for a PUBLIC repository and refuses for a private one is
      // exactly how "is this public?" is answered on the wire.
      const challenge = parseBearerChallenge(res.headers.get('www-authenticate'));
      const token = challenge ? await anonymousToken(challenge) : null;
      if (!token) {
        return {
          pullable: false,
          reference: image,
          registry,
          reason: 'unauthorized',
          detail: challenge
            ? 'the registry refused an anonymous pull token — the repository is private or absent'
            : 'the registry demanded authentication and offered no bearer challenge',
        };
      }
      res = await registryFetch(manifestUrl, {
        accept: MANIFEST_ACCEPT,
        authorization: `Bearer ${token}`,
      });
    }

    if (res.ok) {
      return {
        pullable: true,
        reference: image,
        registry,
        digest: res.headers.get('docker-content-digest'),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        pullable: false,
        reference: image,
        registry,
        reason: 'unauthorized',
        detail: `the registry refused the manifest to an anonymous caller (HTTP ${res.status})`,
      };
    }
    if (res.status === 404) {
      return {
        pullable: false,
        reference: image,
        registry,
        reason: 'absent',
        detail: 'the registry has no such repository or digest (HTTP 404)',
      };
    }
    return {
      pullable: false,
      reference: image,
      registry,
      reason: 'refused',
      detail: `the registry refused the manifest (HTTP ${res.status})`,
    };
  } catch (err) {
    // Transport, DNS, TLS or the 10s deadline. NOT a statement about the image —
    // see the header's three-valued note.
    return {
      pullable: null,
      reference: image,
      registry,
      reason: 'unreachable',
      detail: `the registry could not be reached: ${detailOf(err)}`,
    };
  }
}
