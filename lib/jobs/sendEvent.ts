import { inngest } from './client';
import type { WorkspaceScopedEventName, JobEventData } from './types';

// The canonical way to emit a background-job event (Story 1.6 · Subtask
// 1.6.2, extended in 1.6.3). Routes and services call THIS — never
// `inngest.send()` directly — so the workspace-scoping invariant is enforced
// in one place. It accepts only WORKSPACE-SCOPED events (the `system.*`
// namespace is excluded at the type level — system jobs are cron/harness
// triggered, never enqueued here).
//
// DURABLE INVARIANT: every dispatched event carries an EXPLICIT `workspaceId`.
// The field is required by each event's payload type, so an event that simply
// forgot it is a compile error. The value is normally a real workspace id;
// the ONE event whose type permits `null` is `email.send`, where `null` means
// a genuinely cross-workspace / system email (a password reset is
// identity-scoped, not workspace-scoped). The runtime guard rejects the two
// shapes the type system can't catch at an untyped boundary — `undefined`
// (missing) and `''` (empty) — while allowing an explicit `null`. So no event
// is *accidentally* untenanted, but a *deliberately* cross-workspace email is
// still expressible.
export async function sendEvent<N extends WorkspaceScopedEventName>(
  name: N,
  data: JobEventData<N>,
): Promise<void> {
  const workspaceId = (data as { workspaceId?: string | null }).workspaceId;
  if (workspaceId === undefined || workspaceId === '') {
    throw new Error(
      `sendEvent("${name}") requires an explicit workspaceId — a workspace id, ` +
        `or null for a cross-workspace/system event.`,
    );
  }
  await inngest.send({ name, data });
}
