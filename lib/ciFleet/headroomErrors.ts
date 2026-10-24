// The headroom pass's three alerts (Story MOTIR-8953 · MOTIR-8969,
// `docs/decisions/fleet-per-org-pool.md` AMENDMENT 1). Each is CAPTURED to Sentry
// and never thrown out of the pass: one subject over its threshold must not stop
// the pass reaching the others. The message is the whole of what the platform
// admin reads.

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** A fleet account at or over 70% of one of its limits. */
export class ShardHeadroomExceededError extends Error {
  constructor(
    readonly shardName: string,
    readonly fleetKind: string,
    readonly limit: string,
    readonly used: number,
    readonly capacity: number,
    readonly fraction: number,
  ) {
    super(
      `Fleet account ${shardName} (${fleetKind}) is at ${percent(fraction)} of its ${limit}: ` +
        `${used} of ${capacity}.`,
    );
    this.name = 'ShardHeadroomExceededError';
  }
}

/** A GitHub org at or over 70% of one of its limits — counted on the runner's
 *  org, whichever accounts booted the machines. */
export class GithubOrgHeadroomExceededError extends Error {
  constructor(
    readonly org: string,
    readonly limit: string,
    readonly used: number,
    readonly capacity: number,
    readonly fraction: number,
    /** The accounts whose machines made the calls. */
    readonly shardNames: readonly string[],
    /** True when no fleet account names the org, so its documented defaults were used. */
    readonly noAccountRow: boolean = false,
  ) {
    super(
      `GitHub org ${org} is at ${percent(fraction)} of its ${limit}: ${used} of ${capacity}` +
        `${noAccountRow ? ' (no fleet account names it; documented defaults)' : ''}` +
        `${shardNames.length > 0 ? `. Accounts: ${shardNames.join(', ')}` : ''}.`,
    );
    this.name = 'GithubOrgHeadroomExceededError';
  }
}

/** A fleet kind whose jobs keep waiting for capacity: its pool is not growing
 *  fast enough. */
export class SustainedDeferralError extends Error {
  constructor(
    readonly fleetKind: string,
    readonly deferred: number,
    readonly total: number,
    readonly windowMinutes: number,
  ) {
    super(
      `${deferred} of ${total} ${fleetKind} jobs in the last ${windowMinutes} min waited for ` +
        'capacity (shard_capacity). The pool needs more quota or another account.',
    );
    this.name = 'SustainedDeferralError';
  }
}
