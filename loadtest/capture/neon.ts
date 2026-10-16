// THE NEON ENDPOINT, AND THE BRANCH'S DIRECT URL (Story MOTIR-8538 · MOTIR-8683).
//
// The endpoint's compute state and autoscaling range, read at the start and the
// end of the run from the Neon API:
//   GET {LOADTEST_NEON_API_URL}/projects/{project}/branches/{branch}/endpoints
// with `Authorization: Bearer $LOADTEST_NEON_API_KEY`. A REST call, because the
// Neon CLI has no `endpoints` command. `LOADTEST_NEON_API_URL` defaults to
// https://console.neon.tech/api/v2 and lets a stub stand in. Without the key both
// files say `unmeasured` and the run goes on.
//
// ⚠️ The response's field names (`endpoints[].current_state`,
// `autoscaling_limit_min_cu`, `autoscaling_limit_max_cu`) follow the Neon API's
// endpoint object as documented; the first real run reads one response and
// confirms them (MOTIR-8683's recorded discrepancy).
//
// The direct URL comes from `neonctl connection-string` (the branch positional,
// never `--pooled`; ../run/neon.ts). It holds the role's password: in memory only,
// never printed or written. A `-pooler.` host is REFUSED, the rule
// `resolveDirectUrl` in scripts/pgTopStatements.ts applies (it refuses, it does
// not strip).

import { branchConnectionString } from '../run/neon';
import type { Exec } from '../run/fly';
import { redact } from './redact';

export const NEON_API_DEFAULT = 'https://console.neon.tech/api/v2';
export const ENDPOINT_FIELDS = [
  'id',
  'type',
  'current_state',
  'autoscaling_limit_min_cu',
  'autoscaling_limit_max_cu',
] as const;

export type EndpointReading =
  | {
      state: 'ok';
      readAt: string;
      endpoints: Record<(typeof ENDPOINT_FIELDS)[number], unknown>[];
    }
  | { state: 'unmeasured'; readAt: string; reason: string };

export async function readEndpointState(opts: {
  env: Readonly<Record<string, string | undefined>>;
  project: string;
  branchId: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}): Promise<EndpointReading> {
  const readAt = (opts.now ?? (() => new Date()))().toISOString();
  const key = opts.env['LOADTEST_NEON_API_KEY']?.trim();
  if (!key) return { state: 'unmeasured', readAt, reason: 'LOADTEST_NEON_API_KEY is not set' };
  const base = (opts.env['LOADTEST_NEON_API_URL']?.trim() || NEON_API_DEFAULT).replace(/\/+$/, '');
  const url = `${base}/projects/${encodeURIComponent(opts.project)}/branches/${encodeURIComponent(opts.branchId)}/endpoints`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    });
    if (!res.ok)
      return { state: 'unmeasured', readAt, reason: `the Neon API answered ${res.status}` };
    const body = (await res.json()) as { endpoints?: Record<string, unknown>[] };
    if (!Array.isArray(body.endpoints)) {
      return { state: 'unmeasured', readAt, reason: 'the Neon API answer has no endpoints array' };
    }
    return {
      state: 'ok',
      readAt,
      endpoints: body.endpoints.map(
        (e) =>
          Object.fromEntries(ENDPOINT_FIELDS.map((f) => [f, e[f] ?? 'unmeasured'])) as Record<
            (typeof ENDPOINT_FIELDS)[number],
            unknown
          >,
      ),
    };
  } catch (err) {
    return { state: 'unmeasured', readAt, reason: redact((err as Error).message, [key]) };
  }
}

export class PoolerUrlRefusedError extends Error {
  constructor(host: string) {
    super(`refused: ${host} is a Neon pooler host; the capture reads the direct endpoint only`);
    this.name = 'PoolerUrlRefusedError';
  }
}

/** Refuse a `-pooler.` host, else return the URL unchanged. */
export function assertDirectUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('the direct connection string is not a URL');
  }
  if (host.includes('-pooler.')) throw new PoolerUrlRefusedError(host);
  return url;
}

/** The branch's direct URL, held in memory only. */
export async function resolveBranchDirectUrl(
  exec: Exec,
  project: string,
  branch: string,
): Promise<string> {
  return assertDirectUrl(await branchConnectionString(exec, project, branch));
}
