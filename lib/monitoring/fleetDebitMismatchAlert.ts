import * as Sentry from '@sentry/nextjs';
import type { FleetDebitMismatchError } from '@/lib/ciFleet/debitMismatchErrors';

/**
 * Tell the platform admin one organisation's running and debited disagree
 * (Story MOTIR-6905 · MOTIR-7318).
 *
 * ⚠️ FINGERPRINTED PER (REASON, ORG). A mismatch that persists for an hour is
 * twelve runs of the monitor, and it must be ONE issue whose event count grows,
 * not twelve; two reasons on one org are two issues, because each is a
 * different thing to fix.
 *
 * NEVER THROWS: an alert is not allowed to stop the pass that raised it. A build
 * with no DSN never called `Sentry.init`, so every call is a no-op there.
 */
export function alertFleetDebitMismatch(error: FleetDebitMismatchError): void {
  try {
    Sentry.captureException(error, {
      level: 'error',
      tags: {
        fleet_alert: error.name,
        fleet_org: error.organizationId,
        fleet_reason: error.reason,
      },
      fingerprint: ['fleet-debit-mismatch', error.reason, error.organizationId],
    });
  } catch {
    // Swallowed on purpose — see the header.
  }
}
