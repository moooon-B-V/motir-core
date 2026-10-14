// THE PINNED CLIENT FOR THE TWO-MACHINE STAGING CHECK (Story MOTIR-8547 · MOTIR-8620).
//
// Every request goes to ONE base URL — the deployed app behind Fly's proxy — and
// carries `fly-force-instance-id: <machine id>`, which tells the proxy which
// machine must serve it. That header is the ONLY routing: no sticky cookie, no
// second proxy, no per-machine hostname.
//
// ── WHICH MACHINE SERVED A RESPONSE ─────────────────────────────────────────
// Checked against a Fly-hosted response on 2026-10-14 (`curl -sI https://fly.io`):
// the proxy adds `fly-request-id: <ulid>-<region>`, `via: 1.1 fly.io` and
// `server: Fly/<build>`, and NO header naming the machine. The app exposes none
// either (`FLY_MACHINE_ID` reaches only the staff-only hosting signal). So a
// response is attributed in one of two ways, in this order:
//
//   1. `response-header` — a machine-id header on the response
//      (`ATTRIBUTION_HEADERS`). None exists today; it is read first so a later
//      proxy or app header is used without a code change. A header that names a
//      machine OTHER than the pinned one is a hard failure: the pin was ignored.
//   2. `pin-enforced` — the pinned id, but ONLY once `probePinEnforcement()` has
//      shown the proxy REFUSES a request pinned to a machine that does not exist.
//      Fly does not fall back to another machine for a forced instance; if it
//      did, a bogus pin would be answered by the app (200 from the readiness
//      probe) and every attribution would be a guess.
//
// With neither, `machineOf` is null and `attributePair` fails the case with
// "cannot attribute the response to a machine". It never assumes.
//
// This module imports nothing from the app: it is an HTTP client, run from any
// machine with network access.

export type Machine = 'A' | 'B';

export const FORCE_INSTANCE_HEADER = 'fly-force-instance-id';

/** Response headers that would name the serving machine, read in order. */
export const ATTRIBUTION_HEADERS = ['fly-machine-id', 'fly-instance-id', 'x-motir-machine-id'];

/** The id `probePinEnforcement` pins to — a machine no fleet has. */
export const NO_SUCH_MACHINE = 'motir-two-machine-check-no-such-machine';

/** A configuration the script refuses before it sends a single request. */
export class StagingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingConfigError';
  }
}

/** A response that cannot be tied to the two pinned machines. */
export class AttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributionError';
  }
}

/**
 * The base URL, parsed — or a refusal. `allowedHost` must be set and equal the
 * URL's hostname exactly, so a typo cannot point the script at production.
 */
export function assertAllowedBaseUrl(
  baseUrl: string | undefined,
  allowedHost: string | undefined,
): URL {
  if (!baseUrl) throw new StagingConfigError('STAGING_BASE_URL is not set.');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new StagingConfigError(`STAGING_BASE_URL is not a URL: ${baseUrl}`);
  }
  if (!allowedHost) {
    throw new StagingConfigError(
      'STAGING_ALLOWED_HOST is not set. It must equal the hostname of STAGING_BASE_URL — the ' +
        'guard that keeps this script off production.',
    );
  }
  if (url.hostname !== allowedHost.trim()) {
    throw new StagingConfigError(
      `STAGING_BASE_URL's host "${url.hostname}" is not STAGING_ALLOWED_HOST ("${allowedHost}"). ` +
        'Refusing to send any request.',
    );
  }
  return url;
}

export interface Served {
  readonly machine: Machine;
  readonly pinnedId: string;
  /** The machine id this response is attributed to, or null when it cannot be. */
  readonly machineId: string | null;
  readonly attribution: 'response-header' | 'pin-enforced' | null;
  readonly response: Response;
}

export interface PinnedClientOptions {
  baseUrl: string | undefined;
  allowedHost: string | undefined;
  machineA: string | undefined;
  machineB: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface PinnedClient {
  readonly origin: string;
  readonly ids: Readonly<Record<Machine, string>>;
  /** Send to one machine, pinned. Redirects are NOT followed. */
  sendTo(machine: Machine, path: string, init?: RequestInit): Promise<Served>;
  /** Whether the proxy refuses a bogus pin — the precondition of `pin-enforced`. */
  probePinEnforcement(): Promise<boolean>;
}

/**
 * Build the client, or refuse: a missing or disallowed base URL, a missing
 * machine id, and two identical ids are all refused before any request.
 */
export function createPinnedClient(options: PinnedClientOptions): PinnedClient {
  const url = assertAllowedBaseUrl(options.baseUrl, options.allowedHost);
  const a = options.machineA?.trim();
  const b = options.machineB?.trim();
  if (!a || !b) {
    throw new StagingConfigError(
      'STAGING_MACHINE_A and STAGING_MACHINE_B must both be set — two ids from ' +
        '`fly machine list --json` for the app process group.',
    );
  }
  if (a === b) {
    throw new StagingConfigError(
      `STAGING_MACHINE_A and STAGING_MACHINE_B are the same machine (${a}); every case ` +
        'would pass against one machine.',
    );
  }
  const ids: Record<Machine, string> = { A: a, B: b };
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = url.origin;
  const prefix = url.pathname.replace(/\/$/, '');
  let pinEnforced = false;

  const raw = (id: string, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set(FORCE_INSTANCE_HEADER, id);
    return fetchImpl(origin + prefix + path, { redirect: 'manual', ...init, headers });
  };

  return {
    origin,
    ids,
    async sendTo(machine, path, init) {
      const pinnedId = ids[machine];
      const response = await raw(pinnedId, path, init);
      const named = ATTRIBUTION_HEADERS.map((h) => response.headers.get(h)).find(Boolean);
      if (named) {
        if (named !== pinnedId) {
          throw new AttributionError(
            `${path} was pinned to ${machine} (${pinnedId}) and served by ${named}: the proxy ` +
              `did not honour ${FORCE_INSTANCE_HEADER}.`,
          );
        }
        return { machine, pinnedId, machineId: named, attribution: 'response-header', response };
      }
      return pinEnforced
        ? { machine, pinnedId, machineId: pinnedId, attribution: 'pin-enforced', response }
        : { machine, pinnedId, machineId: null, attribution: null, response };
    },
    async probePinEnforcement() {
      const res = await raw(NO_SUCH_MACHINE, '/api/health/ready');
      const text = await res.text();
      // The app's readiness answer is `{ "state": … }`. Getting it back for a
      // machine that does not exist means the pin was ignored.
      let answeredByApp = false;
      try {
        answeredByApp =
          res.ok && typeof (JSON.parse(text) as { state?: unknown }).state === 'string';
      } catch {
        answeredByApp = false;
      }
      pinEnforced = !answeredByApp;
      return pinEnforced;
    },
  };
}

/**
 * The two machine ids a case's first and second request were served by — or an
 * `AttributionError` when either is unattributed or both are the same machine.
 */
export function attributePair(first: Served, second: Served): { first: string; second: string } {
  for (const served of [first, second]) {
    if (!served.machineId) {
      throw new AttributionError(
        `cannot attribute the response to a machine (pinned ${served.machine} = ${served.pinnedId}; ` +
          `no ${ATTRIBUTION_HEADERS.join(' / ')} header, and the proxy was not shown to enforce ` +
          `${FORCE_INSTANCE_HEADER}).`,
      );
    }
  }
  if (first.machineId === second.machineId) {
    throw new AttributionError(
      `both requests were served by ${first.machineId}: the case cannot pass against one machine.`,
    );
  }
  return { first: first.machineId!, second: second.machineId! };
}
