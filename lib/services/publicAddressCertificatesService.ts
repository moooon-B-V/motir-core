import type { PublicAddress, PublicAddressStatus } from '@/generated/prisma/client';

import type { CertificateState } from '@/lib/publicAddresses/certificateProvider';
import { certificateProvider, certificatesConfigured } from '@/lib/publicAddresses/providers';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE CERTIFICATE SWEEP — Story MOTIR-3878 · Subtask MOTIR-4219.
// Reads the platform, writes what it said. Requests nothing: the lifecycle
// (MOTIR-4216) is what asks for a certificate; this only carries the answer home.

/** How many rows one status may contribute to a single run. */
const PAGE_SIZE = 50;

/**
 * How stale a row must be before it is re-checked, per status.
 *
 * ⚠️ THIS IS WHERE THE CARD'S TWO CADENCES LIVE. It asked for a fast schedule
 * for the in-flight states and an hourly one for `issued`; the schedule
 * clustering (`lib/jobs/schedules.ts`) allows one cadence, so the distinction
 * moves here — one wake, two staleness windows — which costs a query rather
 * than a cold start.
 */
const STALE_AFTER_MS: Partial<Record<PublicAddressStatus, number>> = {
  // In flight: re-check on every sweep.
  verifying: 0,
  pending_certificate: 0,
  // Live: hourly is plenty. A renewal is Fly's and an expiry is weeks away;
  // checking a healthy certificate every half hour spends API calls to learn
  // nothing.
  issued: 60 * 60 * 1000,
  // Broken: hourly. A customer who fixes their DNS uses the pane's own
  // *Check again*, so this is the backstop for the one who does not come back.
  failed: 60 * 60 * 1000,
  expired: 60 * 60 * 1000,
  // `active` and `alias` are SUBDOMAIN states covered by the wildcard, and
  // `revoked` is terminal until a customer acts. Absent from this map on
  // purpose — see `SWEEPS`, which is what makes the omission total rather than
  // forgotten.
};

/**
 * ⚠️ TOTAL OVER THE ENUM, and that is the point of writing it as a `Record`
 * rather than a list of the interesting values: when `PublicAddressStatus`
 * grows, this fails to compile and somebody decides what the new value does on
 * a check. A list would simply not mention it, and the new state would be
 * swept or not by accident.
 */
const SWEEPS: Record<PublicAddressStatus, boolean> = {
  active: false, // a subdomain — the wildcard covers it, there is nothing to check
  alias: false, // a redirect; it serves no certificate of its own
  unverified: false, // waiting on the CUSTOMER, not on the platform
  verifying: true,
  pending_certificate: true,
  issued: true, // renewals and expiries arrive here
  failed: true,
  expired: true,
  revoked: false, // terminal until a customer asks again
};

export interface CertificateSweepSummary {
  scanned: number;
  changed: number;
  failed: number;
  skipped: 'not-configured' | null;
}

export const publicAddressCertificatesService = {
  /**
   * Re-read every address whose status this job owns and that is due a check.
   *
   * The platform call is a side effect OUTSIDE any transaction (`CLAUDE.md`):
   * read the platform, then one short write per row. A failure on one hostname
   * marks nothing and moves on, so a single unreachable call never wedges the
   * sweep — the run reports it and the engine's retry budget carries the run.
   */
  async refreshDueAddresses(): Promise<CertificateSweepSummary> {
    // ⚠️ BEFORE ANY REPOSITORY READ. A self-hosted build schedules this job like
    // every other and must do nothing at all — not read, not log per row, not
    // touch the database it may not even have addresses in.
    if (!(await certificatesConfigured())) {
      return { scanned: 0, changed: 0, failed: 0, skipped: 'not-configured' };
    }

    const provider = await certificateProvider();
    const now = Date.now();
    let scanned = 0;
    let changed = 0;
    let failed = 0;

    for (const status of Object.keys(SWEEPS) as PublicAddressStatus[]) {
      if (!SWEEPS[status]) continue;
      const staleAfter = STALE_AFTER_MS[status] ?? 0;
      const before = new Date(now - staleAfter);

      // Cross-tenant: the sweep spans every workspace, so it binds the system
      // context rather than reading unbound (where the public arm would narrow
      // it to public projects and return a plausible, wrong subset).
      const due = await withSystemContext((tx) =>
        publicAddressRepository.listByStatusOlderThan(status, before, PAGE_SIZE, tx),
      );

      for (const address of due) {
        scanned += 1;
        try {
          // OUTSIDE the transaction.
          const state = await provider.check(address.hostname);
          const next = nextStatus(address, state);
          if (next === null) {
            // No transition, but the check HAPPENED — recording that is what
            // stops the row being re-checked every sweep for ever, and what
            // lets the pane say when it last looked.
            await write(address, {
              status: address.status,
              failureReason: address.failureReason,
              lastCheckedAt: state.checkedAt,
            });
            continue;
          }
          await write(address, next);
          changed += 1;
        } catch (err) {
          // One hostname's failure is not the sweep's. Counted, LOGGED with the
          // hostname, and left for the next run — the engine's retry budget and
          // the DLQ carry the RUN, not the row.
          //
          // ⚠️ LOGGED, not swallowed. A bare `catch {}` here makes an
          // unreachable platform and a bug in this file's own mapping look
          // identical from the summary — which is exactly what it did while this
          // was being written, and cost a debugging round trip to notice.
          console.warn(
            `[public-addresses] certificate check failed for ${address.hostname}:`,
            err instanceof Error ? err.message : err,
          );
          failed += 1;
        }
      }
    }

    return { scanned, changed, failed, skipped: null };
  },
};

/**
 * What the platform's answer means for this row, or `null` for no transition.
 *
 * Reads `issued` off the presence of a certificate rather than off a status
 * string, for the reason the adapter gives: `status` is a vocabulary nobody has
 * closed, and mapping an open string set is how a state machine acquires a
 * silent tenth value.
 */
function nextStatus(
  address: PublicAddress,
  state: CertificateState,
): {
  status: PublicAddressStatus;
  failureReason: string | null;
  lastCheckedAt: Date;
  issuedAt?: Date;
} | null {
  if (state.issued) {
    if (address.status === 'issued') return null;
    return {
      status: 'issued',
      failureReason: null,
      lastCheckedAt: state.checkedAt,
      // Exactly once: the FIRST time this row becomes issued. A renewal is not a
      // new issuance from the customer's point of view, and overwriting the date
      // on every renewal would lose when the address actually went live.
      ...(address.issuedAt ? {} : { issuedAt: new Date() }),
    };
  }

  // Previously live and no longer: the platform has stopped serving it. This is
  // the transition nobody is watching for, and the whole reason a backstop
  // sweep exists.
  if (address.status === 'issued') {
    return {
      status: 'expired',
      failureReason: 'The certificate is no longer active. Check that the DNS records still exist.',
      lastCheckedAt: state.checkedAt,
    };
  }

  // Still in flight and still not configured — the customer has not finished
  // their DNS. Not a failure: it is the ordinary state on the way in.
  if (!state.configured) return null;

  // Pointed correctly but still no certificate: keep waiting. Fly validates
  // asynchronously and a minute or two here is normal.
  return null;
}

function write(
  address: PublicAddress,
  data: {
    status: PublicAddressStatus;
    failureReason: string | null;
    lastCheckedAt: Date;
    issuedAt?: Date;
  },
) {
  return withSystemContext((tx) => publicAddressRepository.updateStatus(address.id, data, tx));
}
