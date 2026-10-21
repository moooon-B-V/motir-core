'use client';

import { FixInMyAgentControl } from '@/components/agentRuns/FixInMyAgentControl';
import { useHostedRun } from './HostedRunProvider';

// FIX IN MY AGENT IN THE DEVELOPMENT FRAME'S FIX PART (Story MOTIR-8981 · MOTIR-9053).
//
// ⚠️ THE ITEM PAGE'S PLACEMENT OF THE SHARED CONTROL, as `FixHostedDoor` places the hosted
// door. It is mounted only where the Run section's *Send to my agent* is (a viewer who may
// run the card AND use agents on the project), and the fix part draws it only in the
// offer state for a red-checks repair. A start, and a stale-page refusal, change a SERVER
// read (the fix part, the To fix banner) and a CLIENT island (the Run section's history),
// so both go through the provider's `notifyRunsChanged` — the page-state contract's two
// remedies at once.
export function FixInMyAgentDoor() {
  const door = useHostedRun();
  if (!door) return null;
  return (
    <FixInMyAgentControl
      itemKey={door.itemKey}
      viewerId={door.viewerId}
      onStarted={door.notifyRunsChanged}
      onStateMoved={door.notifyRunsChanged}
    />
  );
}
