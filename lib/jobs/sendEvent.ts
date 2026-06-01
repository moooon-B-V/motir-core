import { inngest } from './client';
import type { JobEventName, JobEventData } from './types';

// The canonical way to emit a background-job event (Story 1.6 · Subtask
// 1.6.2). Routes and services call THIS — never `inngest.send()` directly — so
// the workspace-scoping invariant is enforced in one place.
//
// DURABLE INVARIANT: every business event is workspace-scoped. The signature
// requires `data.workspaceId: string` at COMPILE time (a system-only event
// whose payload makes workspaceId optional simply can't be passed here — and
// system events aren't dispatched via sendEvent anyway), and the runtime guard
// rejects an empty/falsy id as belt-and-suspenders. No untenanted background
// work slips through.
export async function sendEvent<N extends JobEventName>(
  name: N,
  data: JobEventData<N> & { workspaceId: string },
): Promise<void> {
  if (!data.workspaceId) {
    throw new Error(
      `sendEvent("${name}") requires a workspaceId — every background event is workspace-scoped.`,
    );
  }
  await inngest.send({ name, data });
}
