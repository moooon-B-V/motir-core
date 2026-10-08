import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for ENTERPRISE REQUESTS — Story MOTIR-7602 (Contact sales reaches
// platform staff), its integration gate MOTIR-7610: the request record and its
// org route (MOTIR-7605), the staff email (7606), the Contact-sales form and its
// browser client (7607), the console service and actions (7608), and the console
// pages (7609).
//
// ⚠️ MEASURED: the files the story's code cards ADDED. NOT measured: the shared
// files the story extended by a few lines each — the billing / platform mappers,
// DTO and error modules, `errorResponse.ts`, the audit-log, staff and repository
// repositories it grew by one method, `emailService.ts`, `BillingClient.tsx` and
// the billing page — which already sit under their own lanes and suites; their
// story lines are driven by the suites below all the same.
//
// The suites are each card's own plus the gate's two
// (`tests/billing/enterpriseRequestStoryGate.test.ts` — the seams, the
// create-vs-close race and the cross-tenant / audit / no-price guards on the real
// Postgres — and `tests/components/enterprise-request-story-gate.test.tsx`).
//
// The floors are the MEASURED reading over this lane's suites, rounded DOWN, PER
// FILE, and they are a RATCHET. CI: the `story-7602-coverage` job, which needs
// Postgres.

const FULL = { statements: 100, branches: 100, functions: 100, lines: 100 };

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/api-billing-enterprise-request-route.test.ts',
      'tests/billing/enterprise-request-email-template.test.ts',
      'tests/billing/enterprise-request-notify.test.ts',
      'tests/billing/enterprise-request-service.test.ts',
      'tests/components/BillingContactSales.test.tsx',
      'tests/components/admin-shell-enterprise-requests.test.tsx',
      'tests/components/enterprise-requests-console.test.tsx',
      'tests/platform/enterpriseRequestActions.test.ts',
      'tests/platform/enterpriseRequestMappers.test.ts',
      'tests/platform/enterpriseRequestsConsolePage.test.tsx',
      'tests/platform/platformEnterpriseRequestService.test.ts',
      // The story's integration gate (MOTIR-7610).
      'tests/billing/enterpriseRequestStoryGate.test.ts',
      'tests/components/enterprise-request-story-gate.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: [
        'lib/services/enterpriseRequestService.ts',
        'lib/services/platformEnterpriseRequestService.ts',
        'lib/repositories/enterpriseRequestRepository.ts',
        'lib/emailTemplates/enterpriseRequestReceived.tsx',
        'lib/billing/enterpriseRequestClient.ts',
        'lib/dto/platformEnterpriseRequest.ts',
        'app/api/organizations/[[]orgId]/billing/enterprise-request/route.ts',
        'app/*/settings/organization/billing/_components/ContactSalesDialog.tsx',
        'app/*/admin/enterprise-requests/actions.ts',
        'app/*/admin/enterprise-requests/page.tsx',
        'app/*/admin/enterprise-requests/[[]id]/page.tsx',
        'app/*/admin/enterprise-requests/_components/*.{ts,tsx}',
      ],
      // PER FILE, MEASURED 2026-10-08 at MOTIR-7610 over this lane's suites, rounded DOWN.
      thresholds: {
        // The two arms left are a defensive fallback each: `notifyStaff`'s
        // requester read for a request with no sender (create always sets one)
        // and `create`'s org-name fallback inside its own transaction.
        'lib/services/enterpriseRequestService.ts': {
          statements: 100,
          branches: 90,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformEnterpriseRequestService.ts': {
          statements: 100,
          branches: 95,
          functions: 100,
          lines: 100,
        },
        'lib/repositories/enterpriseRequestRepository.ts': FULL,
        'lib/emailTemplates/enterpriseRequestReceived.tsx': FULL,
        'lib/billing/enterpriseRequestClient.ts': FULL,
        'lib/dto/platformEnterpriseRequest.ts': FULL,
        'app/api/organizations/[[]orgId]/billing/enterprise-request/route.ts': FULL,
        // The arms left are guards a render cannot reach: a count already
        // refused before the send, and the send button's own disabled state
        // shielding the in-flight re-press.
        'app/*/settings/organization/billing/_components/ContactSalesDialog.tsx': {
          statements: 97,
          branches: 93,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/enterprise-requests/actions.ts': FULL,
        'app/*/admin/enterprise-requests/page.tsx': FULL,
        'app/*/admin/enterprise-requests/[[]id]/page.tsx': FULL,
        'app/*/admin/enterprise-requests/_components/EnterpriseRequestBits.tsx': FULL,
        'app/*/admin/enterprise-requests/_components/EnterpriseRequestDetailView.tsx': FULL,
        // The hint's false arm: every state that shows moves is an open one.
        'app/*/admin/enterprise-requests/_components/EnterpriseRequestStateCard.tsx': {
          statements: 100,
          branches: 95,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/enterprise-requests/_components/EnterpriseRequestsCard.tsx': FULL,
        'app/*/admin/enterprise-requests/_components/EnterpriseRequestsSkeleton.tsx': FULL,
        'app/*/admin/enterprise-requests/_components/EnterpriseRequestsUnavailable.tsx': FULL,
        'app/*/admin/enterprise-requests/_components/RequestStateFilter.tsx': FULL,
        'app/*/admin/enterprise-requests/_components/requestListQuery.ts': FULL,
      },
    },
  },
});
