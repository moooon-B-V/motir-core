import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for the OPERATOR CONSOLE — motir-core's half of Story MOTIR-727 (10.1),
// its integration gate MOTIR-7296: the audited platform reads, the spend
// vocabulary, the console's client-side tables and the fleet meter reporter.
//
// ⚠️ MEASURED: the files the story's code cards ADDED, plus the two shared
// repositories they extended most. NOT measured: the server PAGES (rendered by the
// E2E walk, MOTIR-735, not by a unit suite) and the shared files changed by a few
// lines each (`motirAiClient.ts`, `billingService.ts`, `ciFleetCostMeterService.ts`,
// the job registry), which already sit under their own lanes and suites.
//
// The floors are the MEASURED reading over the lane's suites, rounded DOWN, PER FILE,
// and they are a RATCHET. CI: the `story-727-coverage` job, which needs Postgres.

const MEASURED = [
  'lib/services/platformReadService.ts',
  'lib/services/platformUsageService.ts',
  'lib/services/platformOrgPageService.ts',
  'lib/services/platformOrgBillingService.ts',
  'lib/services/platformMeterReportService.ts',
  'lib/platform/spend.ts',
  'lib/platform/orgBill.ts',
  'lib/repositories/platformEstateRepository.ts',
  'lib/jobs/definitions/platformMeterReport.ts',
  'app/*/admin/_components/spendFormat.ts',
  'app/*/admin/tenants/[[]orgId]/_components/orgNav.ts',
  'app/*/admin/tenants/[[]orgId]/_components/CategoryModelSheet.tsx',
  'app/*/admin/tenants/[[]orgId]/_components/SpendChildrenTable.tsx',
  'app/*/admin/tenants/[[]orgId]/_components/PaymentInvoicesCard.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/platform/platformReadService.test.ts',
      'tests/platform/platformOverview.test.ts',
      'tests/platform/platformEstateUsage.test.ts',
      'tests/platform/spend.test.ts',
      'tests/platform/platformTenantList.test.ts',
      'tests/platform/platformOrgOverview.test.ts',
      'tests/platform/orgNav.test.ts',
      'tests/platform/categoryModelSheet.test.tsx',
      'tests/platform/spendChildrenTable.test.tsx',
      'tests/platform/orgBill.test.ts',
      'tests/platform/platformOrgBilling.test.ts',
      'tests/platform/paymentInvoicesCard.test.tsx',
      'tests/platform/consoleGate.test.ts',
      'tests/platform/motirAiSeams.test.ts',
      'tests/ciFleet/platformMeterReport.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: MEASURED,
      // PER FILE, MEASURED 2026-10-02 at MOTIR-7296 over this lane's suites, rounded DOWN.
      thresholds: {
        'app/*/admin/_components/spendFormat.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/CategoryModelSheet.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/PaymentInvoicesCard.tsx': {
          statements: 100,
          branches: 80,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/SpendChildrenTable.tsx': {
          statements: 100,
          branches: 77,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/orgNav.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/jobs/definitions/platformMeterReport.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/platform/orgBill.ts': { statements: 96, branches: 80, functions: 100, lines: 96 },
        'lib/platform/spend.ts': { statements: 97, branches: 100, functions: 85, lines: 96 },
        'lib/repositories/platformEstateRepository.ts': {
          statements: 100,
          branches: 87,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformMeterReportService.ts': {
          statements: 96,
          branches: 89,
          functions: 100,
          lines: 98,
        },
        'lib/services/platformOrgBillingService.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformOrgPageService.ts': {
          statements: 97,
          branches: 91,
          functions: 97,
          lines: 98,
        },
        'lib/services/platformReadService.ts': {
          statements: 100,
          branches: 96,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformUsageService.ts': {
          statements: 100,
          branches: 88,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
