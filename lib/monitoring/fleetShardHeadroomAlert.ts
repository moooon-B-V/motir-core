import * as Sentry from '@sentry/nextjs';
import type {
  GithubOrgHeadroomExceededError,
  ShardHeadroomExceededError,
  SustainedDeferralError,
} from '@/lib/ciFleet/headroomErrors';

export type FleetHeadroomAlert =
  | ShardHeadroomExceededError
  | GithubOrgHeadroomExceededError
  | SustainedDeferralError;

/**
 * Tell the platform admin a fleet account, GitHub org or fleet kind is near its
 * limit (MOTIR-8969).
 *
 * ⚠️ FINGERPRINTED PER (SUBJECT, LIMIT), so a limit that stays above 70% is one
 * issue that keeps getting events, not a new issue every minute.
 *
 * NEVER THROWS: an alert is not allowed to stop the pass that raised it.
 */
export function alertFleetShardHeadroom(error: FleetHeadroomAlert): void {
  try {
    const { subjectTag, subject, limit } = describe(error);
    Sentry.captureException(error, {
      level: 'warning',
      tags: { [subjectTag]: subject, fleet_limit: limit, fleet_alert: error.name },
      fingerprint: ['fleet-shard-headroom', subject, limit],
    });
  } catch {
    // Swallowed on purpose — see the header.
  }
}

function describe(error: FleetHeadroomAlert): {
  subjectTag: 'fleet_shard' | 'github_org' | 'fleet_kind';
  subject: string;
  limit: string;
} {
  switch (error.name) {
    case 'ShardHeadroomExceededError': {
      const e = error as ShardHeadroomExceededError;
      return { subjectTag: 'fleet_shard', subject: e.shardName, limit: e.limit };
    }
    case 'GithubOrgHeadroomExceededError': {
      const e = error as GithubOrgHeadroomExceededError;
      return { subjectTag: 'github_org', subject: e.org, limit: e.limit };
    }
    default: {
      const e = error as SustainedDeferralError;
      return { subjectTag: 'fleet_kind', subject: e.fleetKind, limit: 'sustained_deferral' };
    }
  }
}
