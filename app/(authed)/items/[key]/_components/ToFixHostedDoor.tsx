'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { FixHostedControl } from '@/components/hosted/FixHostedControl';
import { HostedModelsProvider } from '@/components/hosted/HostedModelsProvider';
import { announceRunsChanged } from '@/components/hosted/runsChangedSignal';

// FIX ON THE HOSTED AGENT ON THE TO FIX BANNER (Story MOTIR-1626 · MOTIR-6930; design
// `design/workbench` § 32 Panel 4). The banner sits at the top of the main column, above
// the late stack whose `HostedRunProvider` holds the Development frame's door, so it reads
// the model list through its own provider.
//
// ⚠️ A START CHANGES TWO KINDS OF SURFACE (CLAUDE.md § Page state after a mutation): the
// banner and the Development frame's fix part are SERVER-rendered (`router.refresh()`
// re-reads them into the running state), and the Run section's history is a CLIENT island
// the refresh cannot reach — it is announced, and its provider bumps its own tick.
export function ToFixHostedDoor({
  itemKey,
  viewerId,
}: {
  itemKey: string;
  viewerId: string | null;
}) {
  const router = useRouter();
  const changed = useCallback(() => {
    router.refresh();
    announceRunsChanged(itemKey);
  }, [itemKey, router]);
  return (
    <HostedModelsProvider>
      <FixHostedControl
        itemKey={itemKey}
        viewerId={viewerId}
        onStarted={changed}
        onStateMoved={changed}
      />
    </HostedModelsProvider>
  );
}
