'use client';

import { FixHostedControl } from '@/components/hosted/FixHostedControl';
import { useHostedRun } from './HostedRunProvider';

// FIX ON THE HOSTED AGENT IN THE DEVELOPMENT FRAME'S FIX PART (Story MOTIR-1626 ·
// MOTIR-6930; design `design/github` § 30 Panels 3–3e).
//
// ⚠️ THE ITEM PAGE'S PLACEMENT OF THE SHARED CONTROL, as `ContinueHostedDoor` places
// Continue hosted. It is mounted only where `LateUpperSections` draws the Run hosted door
// (a viewer who may run the card — the Run hosted rule), and the fix part draws it only
// for a card a REVIEW sent back, in the offer state. A start, and a stale-page refusal,
// change a SERVER read (the fix part, the To fix banner) and a CLIENT island (the Run
// section's history), so both go through the provider's `notifyRunsChanged` — the
// page-state contract's two remedies at once.
export function FixHostedDoor() {
  const door = useHostedRun();
  if (!door) return null;
  return (
    <FixHostedControl
      itemKey={door.itemKey}
      viewerId={door.viewerId}
      onStarted={door.notifyRunsChanged}
      onStateMoved={door.notifyRunsChanged}
    />
  );
}
