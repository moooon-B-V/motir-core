import type {
  DispatchEventKind,
  DispatchRunHostedEndDto,
  DispatchRunStatus,
} from '@/lib/dto/dispatchRuns';

// A HOSTED run's timeline and end, as the run surfaces draw them (Story MOTIR-683
// · MOTIR-691; `design/runs/design-notes.md` § Hosted runs). Pure, so the run
// section and the run modal read one definition, and so its tests need no DOM.
//
// ⚠️ NO NEW STATUS AND NO NEW EVENT KIND. Each phase is written by an event the
// shared vocabulary already has, or by the run's own terminal status — the
// decision's rule (`hosted-agent-run.md` §2). The kinds are this module's mapping
// and are never rendered.

/** The six hosted phases, in the order the timeline draws them. */
export const HOSTED_PHASES = [
  'starting',
  'cloned',
  'running',
  'finished',
  'pullRequest',
  'done',
] as const;

export type HostedPhase = (typeof HOSTED_PHASES)[number];

/** The event kinds that mark a phase reached. `starting` and `done` are the run's
 *  own facts (it exists; it is terminal), and `pullRequest` is its delivery set. */
const PHASE_EVENT: Partial<Record<DispatchEventKind, HostedPhase>> = {
  run_opened: 'starting',
  checkout_ready: 'cloned',
  agent_started: 'running',
  log: 'running',
  agent_exited: 'finished',
  delivery_linked: 'pullRequest',
};

export interface HostedPhaseRead {
  /** Every phase the run has reached. */
  reached: ReadonlySet<HostedPhase>;
  /** The phase it is in now — the last reached — or null once it has ended. */
  current: HostedPhase | null;
  /** 1-based position of the last reached phase, for "{phase} · {i} of 6". */
  position: number;
}

/**
 * Which phases a hosted run has reached.
 *
 * ⚠️ A `log` line counts as RUNNING only once the run has been cloned: the end
 * path's own closing line is a `log` too, and a run that failed before it ever
 * cloned must not read as having started its agent.
 */
export function readHostedPhases(input: {
  events: readonly { kind: DispatchEventKind }[];
  status: DispatchRunStatus;
  /** The run's legs have at least one linked pull request. */
  hasPullRequest: boolean;
}): HostedPhaseRead {
  const reached = new Set<HostedPhase>(['starting']);
  for (const ev of input.events) {
    const phase = PHASE_EVENT[ev.kind];
    if (!phase) continue;
    if (ev.kind === 'log' && !reached.has('cloned')) continue;
    reached.add(phase);
  }
  if (input.hasPullRequest) reached.add('pullRequest');
  const ended = input.status !== 'running';
  if (ended && input.status === 'succeeded') {
    for (const phase of HOSTED_PHASES) reached.add(phase);
  } else if (ended) {
    reached.add('done');
  }
  let last = 0;
  HOSTED_PHASES.forEach((phase, i) => {
    if (reached.has(phase) && phase !== 'done') last = i;
  });
  if (reached.has('done')) last = HOSTED_PHASES.length - 1;
  return {
    reached,
    current: ended ? null : HOSTED_PHASES[last]!,
    position: last + 1,
  };
}

/** The phase a run that did NOT succeed stopped in — the last one it reached
 *  before `done` — where the timeline puts its failed or ran-out-of-time mark. */
export function stoppedInPhase(read: HostedPhaseRead): HostedPhase {
  let at: HostedPhase = 'starting';
  for (const phase of HOSTED_PHASES) {
    if (phase !== 'done' && read.reached.has(phase)) at = phase;
  }
  return at;
}

/**
 * The END line's kind — which sentence the run panel says under the pill.
 *
 * ⚠️ TIMED OUT AND STALLED SHARE A STATUS AND DIFFER ONLY BY THE REASON (§2); the
 * end path's recorded outcome is what tells them apart, and it is quoted, never
 * reconstructed from a clock. A run the CLI closed itself carries no outcome: a
 * failure then reads from the agent's exit code.
 */
export type HostedEndKind =
  | 'succeeded'
  | 'failed'
  | 'crashed'
  | 'cancelled'
  | 'stalled'
  | 'timedOut'
  | 'lostSupervision';

export function hostedEndKind(
  status: DispatchRunStatus,
  end: DispatchRunHostedEndDto | undefined,
): HostedEndKind | null {
  if (status === 'running') return null;
  if (status === 'succeeded') return 'succeeded';
  if (status === 'cancelled') return 'cancelled';
  const outcome = end?.outcome ?? null;
  if (status === 'timed_out') {
    if (outcome === 'stall') return 'stalled';
    if (outcome === 'lost_supervision') return 'lostSupervision';
    return 'timedOut';
  }
  return outcome === 'exited' ? 'crashed' : 'failed';
}

/** A duration in whole seconds as its non-zero `h` / `min` / `s` units — the
 *  machine-time figure's shape (zero units dropped; `0 s` for nothing). */
export function machineTimeParts(totalSeconds: number): { unit: 'h' | 'min' | 's'; n: number }[] {
  const s = Math.max(0, Math.floor(totalSeconds));
  const parts: { unit: 'h' | 'min' | 's'; n: number }[] = [];
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) parts.push({ unit: 'h', n: h });
  if (m > 0) parts.push({ unit: 'min', n: m });
  if (sec > 0 || parts.length === 0) parts.push({ unit: 's', n: sec });
  return parts;
}
