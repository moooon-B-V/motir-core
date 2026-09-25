// The planning canvas's MOTION model (MOTIR-6297 · `design/ai-planning/design-notes.md`
// Part XXIII §23.3–§23.5) — the PURE half: what changed between two snapshots,
// and in what order the change plays. `PlanningCanvas` owns the timers and the
// classes; the stylesheet (`app/globals.css`, beside `.canvas-edge-running`) owns
// every interpolation. Directive-free so a test (or a server module) can import it
// without pulling in a client component.
//
// ⚠️ A CHANGE IS DECIDED BY DIFFING TWO SNAPSHOTS BY ID, never by reading an event
// (§23.4): the live poll REPLACES its set on every read (MOTIR-6295), so the
// snapshot is the only unit there is.

/** The fields of a node the motion reads. `CanvasNode` satisfies it. */
export interface MotionNode {
  id: string;
  x: number;
  y: number;
  /** Caller-supplied content signature; a change on a kept id is a DEEPEN. */
  changeKey?: string;
}

/** The fields of an edge the motion reads. `CanvasEdge` satisfies it. */
export interface MotionEdge {
  from: string;
  to: string;
}

export interface MotionSnapshot<
  N extends MotionNode = MotionNode,
  E extends MotionEdge = MotionEdge,
> {
  nodes: readonly N[];
  edges: readonly E[];
}

/** An edge's identity across snapshots: its two ends. A variant change is not motion. */
export const edgeKey = (e: MotionEdge): string => `${e.from}~${e.to}`;

export interface MotionDiff {
  /** ARRIVAL — ids new in `next`, in `next`'s order (the stagger order). */
  enters: string[];
  /** EXIT (or a MOVE OUT, which this level cannot tell apart) — ids gone from `next`. */
  exits: string[];
  /** RE-LAY — kept ids whose cell changed. */
  movers: string[];
  /** DEEPEN — kept ids whose `changeKey` changed. */
  cues: string[];
  /** Edge keys new in `next`. */
  edgeEnters: string[];
  /** Edge keys gone from `next`. */
  edgeExits: string[];
  /** KEPT edge keys touching a mover: hidden for the glide, drawn back on the final route. */
  hiddenEdges: string[];
  /**
   * Something the snapshot tracks changed even though nothing PLAYS — a node the
   * reader is dragging (its move is the reader's own, not a re-lay). The caller
   * adopts `next` as its baseline silently.
   */
  dirty: boolean;
}

/**
 * Diff two consecutive snapshots. `ignoreMoves` names ids whose position change is
 * NOT a re-lay (a node under the reader's own drag).
 */
export function diffSnapshots(
  prev: MotionSnapshot,
  next: MotionSnapshot,
  ignoreMoves: ReadonlySet<string> = new Set(),
): MotionDiff {
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const after = new Set(next.nodes.map((n) => n.id));
  const enters: string[] = [];
  const movers: string[] = [];
  const cues: string[] = [];
  let dirty = false;
  for (const n of next.nodes) {
    const p = before.get(n.id);
    if (!p) {
      enters.push(n.id);
      continue;
    }
    if (p.x !== n.x || p.y !== n.y) {
      if (ignoreMoves.has(n.id)) dirty = true;
      else movers.push(n.id);
    }
    if (p.changeKey !== n.changeKey) cues.push(n.id);
  }
  const exits = prev.nodes.filter((n) => !after.has(n.id)).map((n) => n.id);

  const beforeEdges = new Set(prev.edges.map(edgeKey));
  const afterEdges = new Set(next.edges.map(edgeKey));
  const moving = new Set(movers);
  const edgeEnters: string[] = [];
  const hiddenEdges: string[] = [];
  for (const e of next.edges) {
    const k = edgeKey(e);
    if (!beforeEdges.has(k)) edgeEnters.push(k);
    else if (moving.has(e.from) || moving.has(e.to)) hiddenEdges.push(k);
  }
  const edgeExits = [...beforeEdges].filter((k) => !afterEdges.has(k));
  return {
    enters,
    exits,
    movers,
    cues,
    edgeEnters: [...new Set(edgeEnters)],
    edgeExits,
    hiddenEdges: [...new Set(hiddenEdges)],
    dirty,
  };
}

/** True when the diff has nothing to PLAY (§23.4: "a read that changes nothing plays nothing"). */
export function isQuietDiff(d: MotionDiff): boolean {
  return (
    d.enters.length === 0 &&
    d.exits.length === 0 &&
    d.movers.length === 0 &&
    d.cues.length === 0 &&
    d.edgeEnters.length === 0 &&
    d.edgeExits.length === 0
  );
}

/**
 * The STAGES of one change, in order (§23.3): the leaving and the making-room
 * first (`out` — an exiting card fades, and the arrows of every card about to
 * move fade just before it), then the GLIDE, then the ENTRANCE into the cells
 * that are now free, then the ARROWS on their final routes.
 *
 * A removed arrow is not a stage: it fades from the start of the change, so a
 * pure REWIRE (no card changes cell) fades the old arrow and draws the new one at
 * the same time, as the table says. A DEEPEN is not a stage either: it plays in
 * place, from the start.
 */
export type MotionStage = 'out' | 'glide' | 'enter' | 'arrows';

export function planStages(d: MotionDiff): MotionStage[] {
  const stages: MotionStage[] = [];
  if (d.exits.length > 0 || d.movers.length > 0) stages.push('out');
  if (d.movers.length > 0) stages.push('glide');
  if (d.enters.length > 0) stages.push('enter');
  if (d.edgeEnters.length > 0 || d.hiddenEdges.length > 0) stages.push('arrows');
  return stages;
}

/** The design system's three duration tokens, resolved to milliseconds. */
export interface MotionDurations {
  /** `--transition-fast` */
  fast: number;
  /** `--transition-duration` */
  base: number;
  /** `--transition-slow` */
  slow: number;
}

/** The theme's own defaults — used when the tokens cannot be read (no layout, SSR, a test DOM). */
export const DEFAULT_DURATIONS: MotionDurations = { fast: 100, base: 150, slow: 250 };

/** Several arrivals in one batch stagger by this, capped (§23.4). */
export const ENTER_STAGGER_MS = 40;
export const ENTER_STAGGER_CAP_MS = 160;
/** The DEEPEN outline's hold before it fades (§23.4). */
export const DEEPEN_HOLD_MS = 600;
/** Reduced motion's outline hold, for an arrival and a deepen alike (§23.5). */
export const REDUCED_HOLD_MS = 1200;
/** A retained exit is removed on its animation's end, or after its duration plus this (§23.4). */
export const EXIT_FALLBACK_SLACK_MS = 50;

/** The entrance delay of the i-th arrival in a batch. */
export const enterDelayMs = (i: number): number =>
  Math.min(i * ENTER_STAGGER_MS, ENTER_STAGGER_CAP_MS);

/** How long one stage holds before the next begins. */
export function stageMs(stage: MotionStage, d: MotionDiff, dur: MotionDurations): number {
  switch (stage) {
    case 'out':
      // A leaving card fades over the base duration; a glide with nothing leaving
      // waits only for its arrows' `--transition-fast` fade.
      return d.exits.length > 0 ? dur.base : dur.fast;
    case 'glide':
      return dur.slow;
    case 'enter':
      return dur.slow + enterDelayMs(Math.max(0, d.enters.length - 1));
    case 'arrows':
      return dur.base;
  }
}

/** Parse a CSS `<time>` (`150ms`, `.25s`) to ms; anything unreadable is `fallback`. */
export function parseDurationMs(value: string | null | undefined, fallback: number): number {
  const m = /^\s*(-?[\d.]+)\s*(ms|s)\s*$/i.exec(value ?? '');
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return m[2]?.toLowerCase() === 's' ? n * 1000 : n;
}

/** Resolve the three duration tokens from a computed style (the canvas's own, so a `[data-style]` pace applies). */
export function readDurations(
  style: Pick<CSSStyleDeclaration, 'getPropertyValue'> | null,
): MotionDurations {
  if (!style) return DEFAULT_DURATIONS;
  return {
    fast: parseDurationMs(style.getPropertyValue('--transition-fast'), DEFAULT_DURATIONS.fast),
    base: parseDurationMs(style.getPropertyValue('--transition-duration'), DEFAULT_DURATIONS.base),
    slow: parseDurationMs(style.getPropertyValue('--transition-slow'), DEFAULT_DURATIONS.slow),
  };
}
