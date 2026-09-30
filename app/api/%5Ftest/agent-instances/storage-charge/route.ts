import { NextResponse } from 'next/server';
import { agentInstanceStorageChargeService } from '@/lib/services/agentInstanceStorageChargeService';
import { productionGate, requireContext } from '../../_helpers';

// `POST /api/_test/agent-instances/storage-charge` — RUN THE DAILY STORAGE CHARGE
// NOW (Story MOTIR-6914 · MOTIR-6924, the E2E walk's "after a charged day").
//
// The charge is an hourly job (`system.agent-instance-storage-charge`), and an
// acceptance clip cannot wait for its next fire. This door runs the REAL pass —
// `agentInstanceStorageChargeService.chargeDays`, exactly what the job's one step
// calls — so each agent that exists today is written and debited once through
// `agent_storage`, and a second call the same day charges nothing. Nothing about
// the charge is faked; the ledger it debits is the lane's motir-ai mock.
//
// Gated like every `_test` door: `productionGate()` 404s it in a production build,
// and it needs a signed-in session.

export async function POST(): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const summary = await agentInstanceStorageChargeService.chargeDays();
  return NextResponse.json({ summary });
}
