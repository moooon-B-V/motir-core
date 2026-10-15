// THE SEED TARGET GUARD (Story MOTIR-8538 · MOTIR-8673).
//
// A seed writes thousands of rows and a reset rewrites statuses, so both commands
// must be impossible to point at production. Before any import that opens a
// database connection, they:
//
//   1. name EVERY missing environment variable at once (`missingSeedEnv`);
//   2. refuse a target whose endpoint host is not LOADTEST_ALLOWED_DB_HOST;
//   3. refuse a target whose endpoint host is in LOADTEST_PRODUCTION_DB_HOSTS, and
//      refuse to run at all while that deny-list is unset — an unset deny-list would
//      let a mistyped allowed host through, so the guard fails closed.
//
// Hosts are compared as ENDPOINT hosts (`endpointHost`): Neon's pooled host carries
// a `-pooler` suffix on its first label, and `DATABASE_URL` is the pooled URL while
// the allowed host is recorded bare. The same allow-list idea as
// `STAGING_ALLOWED_HOST` in MOTIR-8620.

import { endpointHost, endpointHostList } from '../lib/endpointHost';

/** Every variable the seed and reset read, in the order the usage header lists them. */
export const SEED_ENV = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MOTIR_BASE_URL',
  'NODE_ENV',
  'LOADTEST_ALLOWED_DB_HOST',
  'LOADTEST_PRODUCTION_DB_HOSTS',
] as const;

/** Synthetic users' mail domain: reserved by RFC 2606, so it can never deliver. */
export const SYNTHETIC_EMAIL_DOMAIN = 'loadtest.invalid';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The seed variables that are unset or wrong, each named with what is expected.
 * `NODE_ENV` must be `production`: the staging app runs that way, and the session
 * cookie's attributes are built from it.
 */
export function missingSeedEnv(env: Env): string[] {
  const missing: string[] = [];
  for (const name of SEED_ENV) {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    else if (name === 'NODE_ENV' && value !== 'production') {
      missing.push(`NODE_ENV (must be production, got ${value})`);
    }
  }
  return missing;
}

export class SeedTargetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedTargetRefusedError';
  }
}

/**
 * Refuse the target unless it is the allowed staging endpoint and not a production
 * one. Returns the endpoint host the command will write to. Reads only the
 * environment — it opens no connection.
 */
export function assertSeedTarget(env: Env): string {
  const allowed = endpointHost(env['LOADTEST_ALLOWED_DB_HOST']);
  if (!allowed) {
    throw new SeedTargetRefusedError(
      'LOADTEST_ALLOWED_DB_HOST is unset: the seed writes only to the staging branch host it names.',
    );
  }
  if (!env['LOADTEST_PRODUCTION_DB_HOSTS']?.trim()) {
    throw new SeedTargetRefusedError(
      'LOADTEST_PRODUCTION_DB_HOSTS is unset: the guard fails closed without the production deny-list.',
    );
  }
  const production = new Set(endpointHostList(env['LOADTEST_PRODUCTION_DB_HOSTS']));
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'] as const) {
    const host = endpointHost(env[name]);
    if (!host) throw new SeedTargetRefusedError(`${name} has no readable host.`);
    if (production.has(host)) {
      throw new SeedTargetRefusedError(
        `${name} points at a PRODUCTION endpoint (${host}). Refused.`,
      );
    }
    if (host !== allowed) {
      throw new SeedTargetRefusedError(
        `${name} points at ${host}, not LOADTEST_ALLOWED_DB_HOST (${allowed}). Refused.`,
      );
    }
  }
  return allowed;
}
