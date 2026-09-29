import { describe, expect, it, vi } from 'vitest';
import {
  publicAddressCertificateRefresh,
  PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON,
} from '@/lib/jobs/definitions/publicAddressCertificateRefresh';
import { SUB_HOURLY_CADENCE } from '@/lib/jobs/schedules';

// THE CERTIFICATE-REFRESH JOB (Story MOTIR-3878 · MOTIR-4223, over MOTIR-4219).
//
// ⚠️ THE HANDLER HAD NEVER BEEN INVOKED — the gate measured this file at 50%
// lines and **0% functions**. Its declaration was covered by the registry
// guards; the body was covered by nothing, which means the one thing it does —
// hand a step to the sweep — was never observed.

describe('the schedule', () => {
  it('fires every 5 minutes — the cadence the card recommended', () => {
    // MOTIR-4219 asked for five minutes on the in-flight statuses; the :00/:30
    // cluster withheld it until MOTIR-6893 retired the cluster. A domain now
    // reaches `issued` within five minutes of the platform issuing it.
    expect(PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON).toBe('*/5 * * * *');
    expect(PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON).toBe(SUB_HOURLY_CADENCE);
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
