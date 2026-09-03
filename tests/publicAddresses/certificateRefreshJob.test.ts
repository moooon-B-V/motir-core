import { describe, expect, it, vi } from 'vitest';
import {
  publicAddressCertificateRefresh,
  PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON,
} from '@/lib/jobs/definitions/publicAddressCertificateRefresh';
import { SCHEDULE_CLUSTER_MINUTES } from '@/lib/jobs/schedules';

// THE CERTIFICATE-REFRESH JOB (Story MOTIR-3878 · MOTIR-4223, over MOTIR-4219).
//
// ⚠️ THE HANDLER HAD NEVER BEEN INVOKED — the gate measured this file at 50%
// lines and **0% functions**. Its declaration was covered by the registry
// guards; the body was covered by nothing, which means the one thing it does —
// hand a step to the sweep — was never observed.

describe('the schedule', () => {
  it('fires on BOTH clustered minutes, which is the finest cadence allowed', () => {
    // ⚠️ THE CARD ASKED FOR FIVE MINUTES AND THE PLATFORM DOES NOT HAVE IT.
    // `schedules.ts` clusters every wake into `SCHEDULE_CLUSTER_MINUTES` so the
    // engine wakes twice an hour rather than twelve times; a five-minute cron
    // would violate the wake-gap invariant its own guard asserts. The trade is
    // recorded on the job and in `job-queue-foundation.md` §11.4 — a domain
    // reaches `issued` within thirty minutes of the platform issuing it, and the
    // pane's own *Check again* is what a watching customer uses.
    expect(PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON).toBe('0,30 * * * *');

    const minutes = PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON.split(' ')[0]!.split(',').map(Number);
    // Read from the constant rather than restated, so a change to the cluster
    // fails here instead of shipping a job the engine will not wake.
    expect(minutes).toEqual([...SCHEDULE_CLUSTER_MINUTES].sort((a, b) => a - b));
  });

  it('is `latest` catch-up and idempotent, and both are readings of the same fact', () => {
    // A missed sweep has nothing to catch up ON: the platform holds the current
    // state and this job READS it, so replaying yesterday's skipped run asks the
    // same question and gets today's answer twice. The same fact makes every
    // write derived rather than accumulated, which is what `idempotent` means.
    expect(publicAddressCertificateRefresh.catchUp).toBe('latest');
    expect(publicAddressCertificateRefresh.retryPolicy).toBe('idempotent');
    expect(publicAddressCertificateRefresh.id).toBe('system.public-address-certificate-refresh');
  });
});

describe('the handler', () => {
  it('runs the sweep inside ONE named step and returns its summary', async () => {
    // A step is what makes the sweep replay-safe and legible in the run log. The
    // handler owns nothing else — every decision about WHICH addresses are due
    // belongs to the service, which is where it is tested.
    const refreshDueAddresses = vi.fn().mockResolvedValue({ checked: 3, changed: 1 });
    const run = vi.fn((_name: string, fn: () => unknown) => fn());

    const result = await publicAddressCertificateRefresh.handler(
      { step: { run } } as never,
      { publicAddressCertificates: { refreshDueAddresses } } as never,
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe('refresh-certificates');
    expect(refreshDueAddresses).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 3, changed: 1 });
  });
});
