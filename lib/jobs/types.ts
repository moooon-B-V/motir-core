// The type surface for background-job events (Story 1.6 · Subtask 1.6.2).
//
// `JobEventDataMap` is the single source of truth for "which events exist and
// what payload each carries." It powers compile-time safety in two places:
//   - `sendEvent(name, data)` constrains `name` to a known key and `data` to
//     that key's payload shape — `sendEvent('typo.event', …)` is a type error.
//   - `defineJob({ id })` constrains `id` to a known key, and the handler's
//     `event.data` is typed to the matching payload.
//
// CONVENTION (per the Subtask card): a job's `id` and its triggering event
// name are the SAME string (1:1). So the keys of this map ARE both the event
// names and the job ids. `email.send` (1.6.3) and the rest land as new keys.
//
// WORKSPACE-SCOPING INVARIANT: business events MUST carry a `workspaceId`
// (`sendEvent` enforces it at runtime) — no untenanted background work. The
// ONE exception is SYSTEM events (the `system.*` namespace), which are
// untenanted by design and are NOT dispatched through `sendEvent` (they're
// triggered by crons in 1.6.4 or, here, by the in-process test harness). The
// `system.ping` payload therefore makes `workspaceId` optional.

export interface SystemPingData {
  /**
   * System events are untenanted, so this is optional. When present it's
   * recorded on the job_run row; when absent the row's workspace_id is null.
   */
  workspaceId?: string;
  /** Optional free-form note echoed back in the static payload. */
  note?: string;
}

/**
 * Map of event-name → payload. Each key is simultaneously a job id and the
 * event name that triggers it. Grows one entry per job.
 */
export interface JobEventDataMap {
  'system.ping': SystemPingData;
}

/** Every registered event/job name. */
export type JobEventName = keyof JobEventDataMap;

/** The payload type for a given event name. */
export type JobEventData<N extends JobEventName> = JobEventDataMap[N];

/**
 * The names of events that are workspace-scoped (everything OUTSIDE the
 * `system.*` namespace). `sendEvent` is typed to accept only these — system
 * events never go through `sendEvent`. Today the map holds only `system.ping`,
 * so this resolves to `never`; 1.6.3's `email.send` makes it non-empty.
 */
export type WorkspaceScopedEventName = Exclude<JobEventName, `system.${string}`>;
