// Typed errors for the Git provider seam (Story 7.10 · MOTIR-891), and in
// particular for the TARBALL-URL RESOLUTION capability (MOTIR-1989).
//
// ⚠️ WHY THESE ARE FOUR CLASSES AND NOT ONE STRING. The resolver's caller is the
// index DISPATCH path: it hands the resolved URL to a container that has no
// GitHub credential of its own (`docs/decisions/code-graph-index-fleet.md` §10),
// so a resolution that fails must fail LOUDLY and legibly. The four failures
// below have four different operator responses — re-dispatch, look at the App
// installation, look at GitHub's status, add the provider capability — and a
// single `Error("could not resolve")` collapses all of them into "something went
// wrong with indexing", which is exactly the diagnosis the whole story exists to
// stop producing.
//
// They also exist so no caller can EVER mistake a failure for a URL: every arm
// throws, and none returns a falsy string. A resolver that returned `''` on a
// missing `Location` would put an empty `MOTIR_INDEX_TARBALL_URL` in a container
// spec, and the container would fail with a `FETCH` exit code that blames the
// repo for a defect in the dispatcher.

/** Why a tarball URL could not be resolved. Stable — a consumer switches on it. */
export type RepoTarballUrlFailure =
  /** The host answered, but not with a redirect — so there is no signed URL. */
  | 'not_redirected'
  /** A redirect with no `Location` header. The host's contract broke. */
  | 'no_location'
  /** The host did not answer inside {@link REPO_TARBALL_TIMEOUT_MS}. */
  | 'timeout'
  /** The request never completed — DNS, TLS, connection reset. */
  | 'unreachable';

/**
 * The base every resolution failure extends, carrying the discriminator.
 *
 * Both forms are usable: `instanceof RepoTarballUrlTimeoutError` for the one
 * case a caller treats specially, and `err.failure` for a switch that must be
 * total. The subclasses are what make a stack trace say what happened.
 */
export class RepoTarballUrlError extends Error {
  readonly failure: RepoTarballUrlFailure;

  constructor(failure: RepoTarballUrlFailure, message: string) {
    super(message);
    this.name = 'RepoTarballUrlError';
    this.failure = failure;
  }
}

/** The host returned a non-redirect status (a 200, a 404, a 500 — anything that
 *  is not a 3xx). A 200 is the interesting one: it means the host served the
 *  BYTES, which is precisely what this path exists not to receive. */
export class RepoTarballUrlNotRedirectedError extends RepoTarballUrlError {
  readonly status: number;

  constructor(status: number) {
    super(
      'not_redirected',
      `the tarball endpoint answered ${status} instead of redirecting to a pre-signed URL`,
    );
    this.name = 'RepoTarballUrlNotRedirectedError';
    this.status = status;
  }
}

/** A 3xx with no `Location`. Nothing to hand a container. */
export class RepoTarballUrlMissingLocationError extends RepoTarballUrlError {
  readonly status: number;

  constructor(status: number) {
    super('no_location', `the tarball endpoint returned ${status} with no Location header`);
    this.name = 'RepoTarballUrlMissingLocationError';
    this.status = status;
  }
}

/** The host did not answer inside the deadline. RETRYABLE. */
export class RepoTarballUrlTimeoutError extends RepoTarballUrlError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super('timeout', `the tarball endpoint did not respond within ${timeoutMs}ms`);
    this.name = 'RepoTarballUrlTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The request failed at the transport layer. RETRYABLE. */
export class RepoTarballUrlUnreachableError extends RepoTarballUrlError {
  constructor(detail: string) {
    super('unreachable', `the tarball endpoint was unreachable (${detail})`);
    this.name = 'RepoTarballUrlUnreachableError';
  }
}

/**
 * The provider does not implement tarball-URL resolution at all.
 *
 * ⚠️ NOT a `RepoTarballUrlError` — deliberately. Those four say "this attempt
 * failed"; this says "this host cannot do the thing, and no retry will change
 * that." It is thrown by {@link requireRepoTarballUrlResolver} rather than by any
 * provider, and it exists so the refusal is LOUD: the alternative a caller would
 * otherwise reach for is falling back to `fetchRepoTarball` and buffering the
 * bytes, which re-introduces the OOM the container path removes.
 */
export class RepoTarballUrlUnsupportedError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `the ${providerId} provider cannot resolve a pre-signed tarball URL; ` +
        'container indexing requires a host that redirects to a self-authorizing archive URL',
    );
    this.name = 'RepoTarballUrlUnsupportedError';
    this.providerId = providerId;
  }
}
