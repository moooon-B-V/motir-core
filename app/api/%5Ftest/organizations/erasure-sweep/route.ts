import { NextResponse } from 'next/server';
import { organizationErasureSweepService } from '@/lib/services/organizationErasureSweepService';
import { productionGate, requireContext } from '../../_helpers';

// `_test` door for the organization-deletion E2E walk (Story MOTIR-6306 ·
// MOTIR-6405). See ../../_helpers.ts for the three invariants every `_test`
// handler keeps (the production gate, a session, service-only).
//
//   POST → 200 + the sweep's summary `{ scanned, claimed, erased, failed, … }`
//
// It runs the hourly `system.organization-erasure-sweep` ONCE, synchronously, IN
// THE SERVER PROCESS — the one whose motir-ai boundary mock (`E2E_TEST_BILLING`)
// answers the sweep's offboard call. A spec moves a deletion's due date into the
// past and presses this, so "a deletion left to run erases the organization" is
// shown in a browser without waiting an hour for the cron. The SCHEDULED path is
// the Vitest gate's (`tests/integration/organizations/organizationDeletionLifecycle.test.ts`).
//
// The lane had no job-trigger door before this one: the monitor poll door
// (`../../monitors/poll`) is the precedent it follows.

export async function POST(): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  return NextResponse.json(await organizationErasureSweepService.runDue());
}
