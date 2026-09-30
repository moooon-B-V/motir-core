import type { AgentInstance } from '@/generated/prisma/client';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE ONE ACTIVITY DOOR (Story MOTIR-6860 · MOTIR-6872/6873, `agent-instances.md`
// §2) and the lifecycle's clock, in a module of their own (MOTIR-6940).
//
// WHY A SEPARATE FILE. The terminal relay (`motir-relay`, `agent-terminal.md` Q6)
// must call `touchActivity`, and it is a separate Fly app holding ONLY
// `DATABASE_URL`, the terminal master key, `MOTIR_BASE_URL` and `SENTRY_DSN`.
// `agentInstanceLifecycleService` reaches `projectsService` → … → `lib/auth`,
// which refuses to load without the web app's auth secrets — so importing it
// would make the relay need every secret motir-core has. This file reaches only
// the repository, the workspace context and the job engine's `sendEvent`. The
// lifecycle re-exports both names and delegates to them, so there is still ONE
// activity door and ONE clock seam (the same object a test spies on).

/** The clock, as a seam so a test can move time without sleeping. */
export const agentInstanceClock = {
  now: (): Date => new Date(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs: 1_000,
};

/** (Re)arm the instance's idle timer (§2) — the debounced `agent-instance/idle-check`. */
export async function armIdleTimer(row: AgentInstance): Promise<void> {
  await sendEvent('agent-instance/idle-check', {
    workspaceId: row.workspaceId,
    instanceId: row.id,
  });
}

export const agentInstanceActivityService = {
  /** Bump the idle signal (§2) — the terminal relay and later runs call it. */
  async touchActivity(instanceId: string): Promise<void> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row) return;
    const moved = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.touchActivity(row.id, agentInstanceClock.now(), tx),
    );
    if (moved === 1 && row.state === 'running') await armIdleTimer(row);
  },
};
