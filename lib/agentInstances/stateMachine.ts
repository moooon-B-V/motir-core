import type { AgentInstanceState } from '@/generated/prisma/client';

// THE AGENT INSTANCE LIFECYCLE (Story MOTIR-6860 · MOTIR-6870) — the legal
// transitions of `docs/decisions/agent-instances.md` §4, as data. Pure: no
// Prisma client, no IO, so the service, the sweep and a test read the same table.
//
// ⚠️ THIS TABLE SAYS WHICH PAIRS ARE LEGAL; IT DOES NOT MAKE A TRANSITION SAFE.
// Safety is the repository's guarded compare-and-set
// (`agentInstanceRepository.transition`): one conditional UPDATE that applies
// only while the row is still in the prior state the caller read, so two clicks —
// or a click racing the sweep — cannot both win. A caller asks this table first
// and the database second, and only the database's answer is final.

/** Every state an instance can be in, in the order §4 lists them. */
export const AGENT_INSTANCE_STATES = [
  'starting',
  'running',
  'hibernating',
  'hibernated',
  'waking',
  'failed',
  'deleting',
] as const satisfies readonly AgentInstanceState[];

/**
 * §4's table: for each state, the states it may move to. `deleting` has no
 * successor STATE — its end is the row's `deletedAt`, which the repository's
 * `markDeleted` writes — so its list is empty. Every pair absent here is illegal.
 */
export const AGENT_INSTANCE_TRANSITIONS: Readonly<
  Record<AgentInstanceState, readonly AgentInstanceState[]>
> = {
  // create's first boot: the machine reports running, or the boot fails.
  starting: ['running', 'failed'],
  // Hibernate (owner, idle sweep, backstop, credit refusal); the reconcile
  // finding the machine already stopped; the reconcile finding it gone; Delete.
  running: ['hibernating', 'hibernated', 'failed', 'deleting'],
  // The machine reports stopped; or the reconcile finds it gone.
  hibernating: ['hibernated', 'failed'],
  // Wake (or a later story's door into the instance); Delete.
  hibernated: ['waking', 'deleting'],
  // The machine reports running; the start fails or the reconcile finds it gone.
  waking: ['running', 'failed'],
  // Wake, while the machine and volume still exist; Delete.
  failed: ['waking', 'deleting'],
  deleting: [],
};

/** Whether §4 allows `from → to`. */
export function isLegalTransition(from: AgentInstanceState, to: AgentInstanceState): boolean {
  return AGENT_INSTANCE_TRANSITIONS[from].includes(to);
}

/** Every state from which `to` may be entered — the prior-state set a guarded update names. */
export function statesThatMayEnter(to: AgentInstanceState): AgentInstanceState[] {
  return AGENT_INSTANCE_STATES.filter((from) => isLegalTransition(from, to));
}

/**
 * The states that COUNT as a running instance for §6's caps: every state in
 * which the instance holds, or is about to hold, a fleet slot and a machine.
 * `hibernated`, `failed` and `deleting` hold none.
 */
export const RUNNING_STATES = [
  'starting',
  'running',
  'hibernating',
  'waking',
] as const satisfies readonly AgentInstanceState[];

/**
 * An interval's billable seconds (§5): `⌈endedAt − startedAt⌉`, never negative.
 * A clock that ran backwards bills nothing rather than a negative amount.
 */
export function intervalBillableSeconds(startedAt: Date, endedAt: Date): number {
  return Math.max(0, Math.ceil((endedAt.getTime() - startedAt.getTime()) / 1000));
}

/** The idempotency key an interval is debited under (§5) — disjoint from a dispatch run id. */
export function intervalChargeReference(intervalId: string): string {
  return `agent-instance-interval:${intervalId}`;
}
