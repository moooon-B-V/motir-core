// The monitor SYNC vocabularies (Story MOTIR-4931 · Subtask MOTIR-5701) — the
// closed sets the `monitor_issue` sync columns store. Stored as TEXT, like
// `last_poll_status`, because the ingestion columns set that precedent; the
// union below is what keeps a caller from writing anything else.

/**
 * A link's resolve-back state. `null` on the row means "never attempted" and is
 * deliberately NOT a member: the claim treats it as claimable, and nothing
 * writes it back.
 *
 * | state      | meaning                                  | re-claimable       |
 * |------------|------------------------------------------|--------------------|
 * | `pending`  | claimed, provider call in flight          | only once STALE    |
 * | `resolved` | the provider accepted Motir's resolve     | never              |
 * | `failed`   | the provider refused; reason recorded     | yes (the sweep)    |
 * | `gone`     | the provider no longer has the issue      | never              |
 */
export const MONITOR_RESOLVE_STATES = ['pending', 'resolved', 'failed', 'gone'] as const;

export type MonitorResolveState = (typeof MONITOR_RESOLVE_STATES)[number];

/** Is `value` a resolve state? */
export function isMonitorResolveState(value: unknown): value is MonitorResolveState {
  return typeof value === 'string' && (MONITOR_RESOLVE_STATES as readonly string[]).includes(value);
}

/** Why a provider assignment was recorded WITHOUT being applied. */
export const MONITOR_ASSIGNEE_SYNC_NOTES = ['team_assignee', 'no_matching_member'] as const;

export type MonitorAssigneeSyncNote = (typeof MONITOR_ASSIGNEE_SYNC_NOTES)[number];
