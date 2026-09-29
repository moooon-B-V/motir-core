import { INSTANCE_MAX_PER_USER } from '@/lib/agentInstances/config';
import type { AgentInstanceState } from '@/lib/dto/agentInstances';
import type { RunTone } from '@/lib/runs/timeline';

// HOW THE MY AGENTS PAGE PRESENTS AN AGENT (Story MOTIR-6860 · MOTIR-6874) — the
// pure half of `design/my-agents/design-notes.md` panels 3 and 4, kept out of the
// component so the tone table, the row menu's enablement and the time format are
// each decided once and tested without a DOM.

/**
 * Panel 4's tones, as the run area's tone vocabulary (`RunTonePill`) — the design
 * reuses it rather than adding a hue: starting and waking are the in-progress sky,
 * running the done mint, hibernating and deleting the neutral queued ground,
 * hibernated the cancelled dot (a rest, not a fault), failed the only danger.
 */
export const AGENT_STATE_TONE: Record<AgentInstanceState, RunTone> = {
  starting: 'running',
  running: 'implemented',
  hibernating: 'queued',
  hibernated: 'cancelled',
  waking: 'running',
  failed: 'failed',
  deleting: 'queued',
};

/**
 * How many agents the list reads — all of them. The page is NOT paginated (a
 * person keeps at most `INSTANCE_MAX_PER_USER` agents, so the whole list always
 * fits); this is that cap, spelled here so the client island and the server page
 * share it. Lives here, not in the client island: a constant exported from a
 * `'use client'` module is a client REFERENCE on the server, so the page's first
 * read would hand Prisma a function for `take`.
 */
export const MY_AGENTS_LIST_LIMIT = INSTANCE_MAX_PER_USER;

/** The states still moving on their own — the page polls while any row is in one. */
export const AGENT_STATES_IN_MOTION: ReadonlySet<AgentInstanceState> = new Set([
  'starting',
  'hibernating',
  'waking',
  'deleting',
]);

/** The row menu's three moves. */
export type AgentMove = 'wake' | 'hibernate' | 'delete';

/**
 * Panel 3: the moves `agent-instances.md` §4 allows from each state. A move the
 * state does not allow is shown DISABLED, never hidden, so the menu keeps one shape.
 */
export function allowedAgentMoves(state: AgentInstanceState): ReadonlySet<AgentMove> {
  switch (state) {
    case 'running':
      return new Set(['hibernate', 'delete']);
    case 'hibernated':
    case 'failed':
      return new Set(['wake', 'delete']);
    default:
      return new Set();
  }
}

/**
 * Machine time as the list shows it: `0m`, `38m`, `1h 12m`, `2h 03m` — whole
 * minutes, rounded down, the minutes zero-padded once there are hours.
 */
export function formatMachineTime(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}
