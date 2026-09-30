import type { OpenRepairRunDto } from '@/lib/dto/workItemRepair';
import { dispatchRunLabel } from '@/lib/howToTest/author';
import type { RunningDispatchRunForItems } from '@/lib/repositories/dispatchRunRepository';

/**
 * The OPEN `fix` runs a page read → each card's open repair (Story MOTIR-1626 ·
 * MOTIR-6930), keyed by work item id. The runs arrive newest first, so a card two open
 * runs hold (never, under the one-repair lock) names the newer. A card no open run holds
 * is absent.
 */
export function toOpenRepairRuns(
  runs: readonly RunningDispatchRunForItems[],
  viewerId: string,
): Map<string, OpenRepairRunDto> {
  const open = new Map<string, OpenRepairRunDto>();
  for (const run of runs) {
    for (const leg of run.cards) {
      if (!leg.workItemId || open.has(leg.workItemId)) continue;
      open.set(leg.workItemId, {
        id: run.id,
        label: dispatchRunLabel('fix', run.startedAt),
        // `instance` is not hosted: a repair is never opened into an agent
        // (MOTIR-7023) — only the server's `run` start opens an `instance` run.
        hosted: run.origin === 'hosted',
        holder: run.createdBy,
        byViewer: run.createdById === viewerId,
        startedAt: run.startedAt.toISOString(),
      });
    }
  }
  return open;
}
