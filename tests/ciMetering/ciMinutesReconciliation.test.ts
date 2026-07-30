import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ciMinutesReconciliationService,
  reconcileTotals,
  toleranceFor,
} from '@/lib/services/ciMinutesReconciliationService';
import { previousPeriodStart } from '@/lib/jobs/definitions/ciMinutesReconcile';

// The monthly reconciliation (Story MOTIR-1775 · MOTIR-1896) —
// `docs/decisions/ci-minutes-allowance.md` §5.8's audit half. The comparison is
// pure and tested directly; the one host read is stubbed at the `fetch` boundary.

const MOTIR_ORG = 'motir-projects';

function usageLine(repositoryName: string, quantity: number, sku = 'Actions Linux') {
  return { repositoryName, sku, quantity, unitType: 'minutes', date: '2026-07-15' };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('reconcileTotals', () => {
  it('reports no drift when the meter matches the bill', () => {
    const rows = reconcileTotals(
      [{ repoName: 'acme-web', billableMinutes: 100 }],
      [usageLine('acme-web', 100)],
    );
    expect(rows).toEqual([
      {
        repoName: 'acme-web',
        meteredMinutes: 100,
        reportedMinutes: 100,
        driftMinutes: 0,
        exceedsTolerance: false,
      },
    ]);
  });

  it('tolerates small divergence — per-job ceil vs per-day SKU rollup differ by rounding', () => {
    const rows = reconcileTotals(
      [{ repoName: 'acme-web', billableMinutes: 103 }],
      [usageLine('acme-web', 100)],
    );
    expect(rows[0]?.driftMinutes).toBe(3);
    expect(rows[0]?.exceedsTolerance).toBe(false); // 3 < max(5, 5% of 100)
  });

  it('FLAGS an under-count — the shape a run of dropped webhooks produces', () => {
    const rows = reconcileTotals(
      [{ repoName: 'acme-web', billableMinutes: 400 }],
      [usageLine('acme-web', 1000)],
    );
    expect(rows[0]?.driftMinutes).toBe(-600);
    expect(rows[0]?.exceedsTolerance).toBe(true);
  });

  it('FLAGS an over-count too — drift is not trusted in either direction', () => {
    const rows = reconcileTotals(
      [{ repoName: 'acme-web', billableMinutes: 1000 }],
      [usageLine('acme-web', 400)],
    );
    expect(rows[0]?.driftMinutes).toBe(600);
    expect(rows[0]?.exceedsTolerance).toBe(true);
  });

  it('surfaces a repo GitHub billed that the meter NEVER SAW', () => {
    // The most valuable signal the reconciliation has: deliveries were lost.
    const rows = reconcileTotals([], [usageLine('ghost-repo', 500)]);
    expect(rows).toEqual([
      {
        repoName: 'ghost-repo',
        meteredMinutes: 0,
        reportedMinutes: 500,
        driftMinutes: -500,
        exceedsTolerance: true,
      },
    ]);
  });

  it('surfaces a repo the meter counted that GitHub did not bill', () => {
    const rows = reconcileTotals([{ repoName: 'phantom', billableMinutes: 500 }], []);
    expect(rows[0]).toMatchObject({
      reportedMinutes: 0,
      driftMinutes: 500,
      exceedsTolerance: true,
    });
  });

  it('sums MULTIPLE report lines for one repo (the report is per SKU per day)', () => {
    const rows = reconcileTotals(
      [{ repoName: 'acme-web', billableMinutes: 300 }],
      [usageLine('acme-web', 100), usageLine('acme-web', 100), usageLine('acme-web', 100)],
    );
    expect(rows[0]?.reportedMinutes).toBe(300);
    expect(rows[0]?.exceedsTolerance).toBe(false);
  });

  it('IGNORES non-compute lines — storage and packages are not Actions minutes', () => {
    const rows = reconcileTotals(
      [{ repoName: 'acme-web', billableMinutes: 100 }],
      [
        usageLine('acme-web', 100),
        {
          repositoryName: 'acme-web',
          sku: 'Shared Storage',
          quantity: 9000,
          unitType: 'GB-hours',
          date: '2026-07-15',
        },
        {
          repositoryName: 'acme-web',
          sku: 'Packages',
          quantity: 500,
          unitType: 'GB',
          date: '2026-07-15',
        },
      ],
    );
    expect(rows[0]?.reportedMinutes).toBe(100);
  });

  it('counts every Actions runner SKU, not just Linux', () => {
    const rows = reconcileTotals(
      [{ repoName: 'acme-web', billableMinutes: 30 }],
      [usageLine('acme-web', 10, 'Actions Linux'), usageLine('acme-web', 20, 'Actions macOS')],
    );
    expect(rows[0]?.reportedMinutes).toBe(30);
  });

  it('orders repos deterministically', () => {
    const rows = reconcileTotals(
      [
        { repoName: 'zeta', billableMinutes: 1 },
        { repoName: 'alpha', billableMinutes: 1 },
      ],
      [usageLine('mid', 1)],
    );
    expect(rows.map((r) => r.repoName)).toEqual(['alpha', 'mid', 'zeta']);
  });
});

describe('toleranceFor', () => {
  it('is 5% of the reported minutes above the floor', () => {
    expect(toleranceFor(1000)).toBe(50);
  });

  it('never falls below the 5-minute floor, so a tiny month does not alarm on rounding', () => {
    expect(toleranceFor(10)).toBe(5);
    expect(toleranceFor(0)).toBe(5);
  });
});

describe('ciMinutesReconciliationService.reconcileMonth', () => {
  it('SKIPS when metering is disabled — never an error', () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    return expect(ciMinutesReconciliationService.reconcileMonth(2026, 7, [])).resolves.toEqual({
      outcome: 'skipped',
      reason: 'metering_disabled',
    });
  });

  it('SKIPS with no billing credential — the normal state until MOTIR-1779 runs', async () => {
    // The operational meter does not depend on this credential, so its absence
    // must never look like a failure.
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    vi.stubEnv('GITHUB_BILLING_TOKEN', undefined);
    expect(await ciMinutesReconciliationService.reconcileMonth(2026, 7, [])).toEqual({
      outcome: 'skipped',
      reason: 'no_billing_credential',
    });
  });

  it('reads the enhanced-billing endpoint and reports discrepancies', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    vi.stubEnv('GITHUB_BILLING_TOKEN', 'ghp_audit');
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            usageItems: [usageLine('acme-web', 1000), usageLine('quiet-repo', 10)],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ciMinutesReconciliationService.reconcileMonth(2026, 7, [
      { repoName: 'acme-web', billableMinutes: 400 },
      { repoName: 'quiet-repo', billableMinutes: 10 },
    ]);

    expect(result).toMatchObject({ outcome: 'reconciled', org: MOTIR_ORG, year: 2026, month: 7 });
    const reconciled = result as Extract<typeof result, { outcome: 'reconciled' }>;
    expect(reconciled.repos).toHaveLength(2);
    expect(reconciled.discrepancies.map((d) => d.repoName)).toEqual(['acme-web']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('drifted from GitHub billing'),
      expect.objectContaining({ org: MOTIR_ORG }),
    );

    // The usage endpoint, addressed for the right org and period.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/organizations/${MOTIR_ORG}/settings/billing/usage?year=2026&month=7`,
    );
  });

  it('does not log when everything is within tolerance', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    vi.stubEnv('GITHUB_BILLING_TOKEN', 'ghp_audit');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ usageItems: [usageLine('acme-web', 100)] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ciMinutesReconciliationService.reconcileMonth(2026, 7, [
      { repoName: 'acme-web', billableMinutes: 101 },
    ]);

    expect((result as { discrepancies: unknown[] }).discrepancies).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns no metered totals when no provisioning org is configured', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', undefined);
    expect(
      await ciMinutesReconciliationService.meteredTotalsForMonth(
        new Date('2026-07-01T00:00:00.000Z'),
      ),
    ).toEqual([]);
  });
});

describe('previousPeriodStart — the month the job reconciles', () => {
  it('reconciles the PREVIOUS calendar month, not the current one', () => {
    // The job runs on the 3rd: GitHub's report is not complete the instant a
    // month ends, so reconciling immediately would report reporting lag as drift.
    expect(previousPeriodStart(new Date('2026-08-03T04:00:00.000Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('rolls back across a year boundary', () => {
    expect(previousPeriodStart(new Date('2027-01-03T04:00:00.000Z')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });
});
