// The SERVER-side live-signal contract (Story MOTIR-8542 · Subtask MOTIR-8728).
//
// Postgres triggers `pg_notify(LIVE_SIGNAL_CHANNEL, …)` on every write to a table
// a live surface reads (MOTIR-8727), the per-process hub (`liveSignalHub.ts`)
// LISTENs on that channel, and the open streams subscribe to the hub. This file
// is the one thing all three agree on: the channel and the payload.
//
// ⚠️ NOT `lib/live/liveSignal.ts`. That file is the CLIENT seam (`'use client'`;
// `LiveSignal`, `LiveTopic`, `useLiveSignal`), and a server module importing it
// would pull a client module into the server graph. The two vocabularies are
// kept apart on purpose: a `LiveNotification` is a database HINT naming ids, a
// `LiveSignal` is what a browser island reacts to.
//
// ⚠️ THE PAYLOAD IS IDS ONLY — never a title, never content. A notification is a
// hint that something under these ids moved; the reader's own access-gated
// re-read decides what it may see. Ids also keep the payload far under
// Postgres's 8000-byte NOTIFY limit.

/** The one channel every live-signal trigger notifies and the hub LISTENs on. */
export const LIVE_SIGNAL_CHANNEL = 'live_signal';

/** A parsed notification: which workspace, project and plan a write touched. */
export interface LiveNotification {
  workspaceId: string;
  /** Null for a row that belongs to no project (or whose project could not be resolved). */
  projectId: string | null;
  /** Null for a row that is not part of a plan. */
  planId: string | null;
}

/**
 * The longest id the hub accepts. Every id Motir writes is a cuid or a uuid
 * (25–36 characters); anything longer is not one of ours and is dropped rather
 * than fanned out to every open stream.
 */
export const LIVE_NOTIFICATION_MAX_ID_LENGTH = 64;

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= LIVE_NOTIFICATION_MAX_ID_LENGTH
  );
}

function optionalId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return isId(value) ? value : undefined;
}

/**
 * Parse a raw `live_signal` payload — `{"w": <workspaceId>, "p": <projectId|null>,
 * "plan": <planId|null>}` — into a `LiveNotification`.
 *
 * Answers `null` for anything malformed (not JSON, not an object, a missing
 * workspace, a field that is not an id). A malformed payload is DROPPED by the
 * caller and never thrown: the listener is a hint source, and one bad
 * notification must not take the process's only live connection down with it.
 */
export function parseLiveNotification(raw: string): LiveNotification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!isId(record['w'])) return null;
  const projectId = optionalId(record['p']);
  const planId = optionalId(record['plan']);
  if (projectId === undefined || planId === undefined) return null;
  return { workspaceId: record['w'], projectId, planId };
}
