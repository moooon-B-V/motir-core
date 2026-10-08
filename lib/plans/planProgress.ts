// THE ONE PROGRESS DERIVATION for a `generating` plan (Story MOTIR-7820 ·
// Subtask MOTIR-7825; design `design/ai-planning/design-notes.md` Part XXV).
//
// ⚠️ EVERY SURFACE THAT SHOWS A PLAN'S PROGRESS READS IT FROM HERE, BY NAME.
// The progress line (pane and compact form), the canvas cues and the Workbench ›
// Planning row all take a `PlanProgressSnapshot` built by
// `buildPlanProgressSnapshot` and read it through `readPlanProgress`. NONE of
// them may compare a timestamp to the threshold, filter the raw `inFlightSteps`,
// choose a step phrase, or count `add`s on its own — that is exactly how the tab
// row and the plan surface would come to disagree (a dead session drafting on
// the canvas while the line says stalled; "3 of 7" on the tab and "4 of 7" on
// the plan). A new surface imports these two functions; it does not grow a
// third derivation.
//
// The account is TWO HALVES on purpose:
//   1. a SNAPSHOT, built on the server and independent of time — the resolved
//      steps (each with its PHRASE, its target's title and canvas node id),
//      "N of M authored", the plan's start, its last activity, and the server
//      instant it was built at. Titles and counts need the rows, so they cannot
//      be computed in a browser for the tab's list.
//   2. a CLOCK READING, a pure function of (snapshot, now) — the state, the steps
//      still live at `now`, elapsed, time since last activity. Stalled and
//      elapsed keep moving between 2.5 s polls (and across a dropped one), so
//      they cannot be frozen into the server's answer. A ticking client calls it
//      with `serverNow(…)`; the server calls it with server time.
//
// PURE AND ISOMORPHIC: no `db`, no `Date.now()` default, no React, no copy. The
// words a phrase reads as are the design's copy keys (`PLAN_STEP_PHRASE_MESSAGE_KEY`),
// rendered by the progress line through `next-intl`.
//
// SERVER TIME IS THE ONLY CLOCK. `startedAt`, `lastActivityAt`, `observedAt` and
// every step's `startedAt` are server instants; a client reads them through
// `serverNow`, never against its raw `Date.now()`, so a skewed laptop clock can
// neither make a live plan read stalled nor a stalled one read live.

import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { PlanStepDto, PlanStepKindDto } from '@/lib/dto/plans';

/**
 * THE stalled threshold — design Part XXV §25.9: **15 minutes**, measured (the
 * longest healthy quiet stretch observed on real walks was 582 s, so the
 * story's assumed 10 minutes left 3 % headroom). It has TWO uses and they are
 * deliberately the same number:
 *   1. the plan is `stalled` when `now − lastActivityAt > PLAN_STALLED_AFTER_MS`
 *      (equal is NOT stalled; +1 ms is);
 *   2. a single step is dropped as QUIET when `now − step.startedAt >
 *      PLAN_STALLED_AFTER_MS` — a session that died without clearing stops
 *      naming an item even while its siblings keep the plan alive.
 * Re-measure and change THIS constant; never a surface.
 */
export const PLAN_STALLED_AFTER_MS = 900_000;

/**
 * WHICH words a step reads as. A derivation, not a string — it depends on the
 * step's kind, on whether a target exists, and on whether it still resolves —
 * so it is chosen once, here, and rendered by the line in the reader's locale.
 *
 * | kind     | targetRef           | phrase              |
 * | -------- | ------------------- | ------------------- |
 * | settle   | null                | `settling`          |
 * | lay      | null                | `layingTopLevel`    |
 * | lay      | resolves            | `layingChildrenOf`  |
 * | author   | null                | `draftingNew`       |
 * | author   | resolves            | `authoring`         |
 * | lay/auth | set, resolves to ∅  | — DROPPED           |
 */
export type PlanStepPhrase =
  | 'settling'
  | 'layingTopLevel'
  | 'layingChildrenOf'
  | 'authoring'
  | 'draftingNew';

/**
 * The design's copy key for each phrase (Part XXV §25.13). TOTAL over
 * {@link PlanStepPhrase}, so a sixth phrase fails the compiler here rather than
 * rendering a blank on the line.
 */
export const PLAN_STEP_PHRASE_MESSAGE_KEY: Record<PlanStepPhrase, string> = {
  settling: 'planReview.progress.settling',
  layingTopLevel: 'planReview.progress.layingTopLevel',
  layingChildrenOf: 'planReview.progress.layingChildrenOf',
  authoring: 'planReview.progress.authoring',
  draftingNew: 'planReview.progress.draftingNew',
};

/** One in-flight step, resolved. `targetNodeId` / `targetTitle` are null
 *  EXACTLY for `settling`, `layingTopLevel` and `draftingNew`. */
export interface PlanProgressStep {
  sessionKey: string;
  kind: PlanStepKindDto;
  phrase: PlanStepPhrase;
  /** The ref exactly as the planner sent it (`planItem:<id>`, a work-item id, or null). */
  targetRef: string | null;
  /** The canvas node the step names — `PlanReviewItemDto.nodeId`'s rule. */
  targetNodeId: string | null;
  targetTitle: string | null;
  /** Server instant (ISO). */
  startedAt: string;
}

/** The time-independent half — built once, on the server. */
export interface PlanProgressSnapshot {
  /** `Plan.createdAt` (ISO) — elapsed counts from here (design §25.2). */
  startedAt: string;
  /** `Plan.lastActivityAt` (ISO). */
  lastActivityAt: string;
  /** The SERVER instant this snapshot was built at (ISO) — `serverNow`'s anchor. */
  observedAt: string;
  /** N — the `add`s that pass the authored test ({@link countAuthored}). */
  authored: number;
  /** M — the plan's `add`s. */
  proposed: number;
  /** Ordered by `startedAt`, ties by `sessionKey` — the design's "earliest in words" order. */
  steps: PlanProgressStep[];
}

export type PlanProgressState = 'starting' | 'working' | 'writing' | 'stalled';

/** The time-dependent half — `readPlanProgress(snapshot, now)`. */
export interface PlanProgressReading {
  state: PlanProgressState;
  /** The steps still live at `now` (none when stalled), in the snapshot's order. */
  liveSteps: PlanProgressStep[];
  authored: number;
  proposed: number;
  elapsedMs: number;
  sinceActivityMs: number;
  lastActivityAt: string;
}

/**
 * What the derivation needs from ONE `add` row — flags, never bodies. The SAME
 * shape `planItemRepository.findProgressRowsByPlanIds` computes in SQL and
 * {@link progressRowOfAdd} computes from an in-memory plan item, so both paths
 * feed one predicate.
 */
export interface PlanProgressAddRow {
  id: string;
  workItemId: string | null;
  parentRef: string | null;
  kind: string | null;
  title: string;
  hasDescription: boolean;
  hasExplanation: boolean;
  hasType: boolean;
  hasExecutor: boolean;
  hasStoryPoints: boolean;
  hasEstimate: boolean;
  hasDifficulty: boolean;
}

// ── The authored test ─────────────────────────────────────────────────────────
//
// MIRRORED, NOT IMPORTED, from motir-ai `src/llm/walkCompleteness.ts`
// (`isLeafSized`, `AUTHOR_REQUIRED_ALWAYS`, `AUTHOR_REQUIRED_ON_LEAF`, and the
// ADR §5 amendment MOTIR-3975: `explanationMd` is required exactly when the pass
// was asked for explanations). motir-ai is a separate, closed repository, so the
// predicate is restated here; a change there is a change here.
//
// ⚠️ DELIBERATELY OMITTED: the `## Scope BOUNDARY` heading check
// (`AUTHOR_REQUIRED_ON_LEAF_BOUNDARY`) and the `manual` leaf's `todos`. "N
// authored" answers *has its author session written it*, not *is it
// walk-complete*: an item missing only its boundary heading HAS been through
// authoring, and counting it as unauthored would freeze N below M on a finished
// plan.

/** Container kinds — never leaf-sized however empty (motir-ai `CONTAINER_KINDS`). */
const CONTAINER_KINDS: ReadonlySet<string> = new Set(['epic', 'story']);

/** motir-ai's `isLeafSized`: not a container, and nothing proposed beneath it.
 *  CHILDLESS, not the word `subtask`. */
function isLeafSized(kind: string | null, hasProposedChildren: boolean): boolean {
  if (kind !== null && CONTAINER_KINDS.has(kind)) return false;
  return !hasProposedChildren;
}

/**
 * N of M. **M** = the plan's `add` rows (pass ONLY adds — a `modify` / `remove`
 * is in neither number). **N** = those with a non-empty `descriptionMd`, a
 * non-empty `explanationMd` when `requireExplanation`, and — when LEAF-SIZED —
 * a non-null `type`, `executor`, `storyPoints`, `estimateMinutes` and
 * `difficulty`.
 */
export function countAuthored(
  addRows: readonly PlanProgressAddRow[],
  requireExplanation: boolean,
): { authored: number; proposed: number } {
  const parents = new Set<string>();
  for (const row of addRows) {
    if (row.parentRef?.startsWith(TEMP_REF_PREFIX)) {
      parents.add(row.parentRef.slice(TEMP_REF_PREFIX.length));
    }
  }
  let authored = 0;
  for (const row of addRows) {
    if (!row.hasDescription) continue;
    if (requireExplanation && !row.hasExplanation) continue;
    if (
      isLeafSized(row.kind, parents.has(row.id)) &&
      !(
        row.hasType &&
        row.hasExecutor &&
        row.hasStoryPoints &&
        row.hasEstimate &&
        row.hasDifficulty
      )
    ) {
      continue;
    }
    authored += 1;
  }
  return { authored, proposed: addRows.length };
}

/**
 * Whether an `add` owes `explanationMd` to count as authored. `mcp` → always
 * (its runbook owes both bodies); every other source — `native`, a cadence plan,
 * `null` — → the project's `aiGenerateExplanations`. Without this a hosted plan
 * on a project with explanations OFF (the schema default) would read "0 of 7
 * authored" forever.
 */
export function requireExplanationFor(args: {
  authorSource: string | null;
  projectAiGenerateExplanations: boolean;
}): boolean {
  return args.authorSource === 'mcp' ? true : args.projectAiGenerateExplanations;
}

const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
/** motir-ai's leaf-field test: `undefined`, `null` and `''` are missing. */
const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * The in-memory twin of `findProgressRowsByPlanIds`'s SQL — the review read
 * already holds the plan's items, so it derives the same flags without a query.
 * Kept beside the predicate so the two stay one definition.
 */
export function progressRowOfAdd(item: {
  id: string;
  workItemId: string | null;
  parentRef: string | null;
  proposedFields: Record<string, unknown> | null;
}): PlanProgressAddRow {
  const f = item.proposedFields ?? {};
  return {
    id: item.id,
    workItemId: item.workItemId,
    parentRef: item.parentRef,
    kind: typeof f.kind === 'string' ? f.kind : null,
    title: typeof f.title === 'string' ? f.title : '',
    hasDescription: nonEmptyString(f.descriptionMd),
    hasExplanation: nonEmptyString(f.explanationMd),
    hasType: present(f.type),
    hasExecutor: present(f.executor),
    hasStoryPoints: present(f.storyPoints),
    hasEstimate: present(f.estimateMinutes),
    hasDifficulty: present(f.difficulty),
  };
}

// ── The snapshot ──────────────────────────────────────────────────────────────

const iso = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());

/**
 * Build the time-independent half. Each step resolves by the phrase table:
 * - a NULL target is KEPT with its untargeted phrase — a real state of both
 *   walks (an untargeted plan's root lay, a no-id author session), never a
 *   missing value;
 * - `planItem:<id>` → that `add`'s title, node id = its `workItemId` if
 *   materialized, else the PlanItem id (`PlanReviewItemDto.nodeId`'s rule);
 * - a work-item id → its title from `committedTitles`, node id = that id;
 * - a SET target that no longer resolves is DROPPED: a withdrawn `planItem:`
 *   (withdrawal deletes the row) or a committed id with no title. Naming it
 *   would point the canvas at nothing.
 * Steps are ordered by `startedAt`, ties by `sessionKey`.
 */
export function buildPlanProgressSnapshot(args: {
  plan: { createdAt: string | Date; lastActivityAt: string | Date };
  steps: readonly PlanStepDto[];
  addRows: readonly PlanProgressAddRow[];
  committedTitles: ReadonlyMap<string, string>;
  requireExplanation: boolean;
  observedAt: string | Date;
}): PlanProgressSnapshot {
  const addById = new Map(args.addRows.map((r) => [r.id, r]));
  const resolved: PlanProgressStep[] = [];
  for (const step of args.steps) {
    const base = {
      sessionKey: step.sessionKey,
      kind: step.kind,
      targetRef: step.targetRef,
      startedAt: iso(step.startedAt),
    };
    if (step.kind === 'settle' || step.targetRef === null) {
      const phrase: PlanStepPhrase =
        step.kind === 'settle'
          ? 'settling'
          : step.kind === 'lay'
            ? 'layingTopLevel'
            : 'draftingNew';
      resolved.push({ ...base, phrase, targetNodeId: null, targetTitle: null });
      continue;
    }
    let target: { nodeId: string; title: string } | null = null;
    if (step.targetRef.startsWith(TEMP_REF_PREFIX)) {
      const add = addById.get(step.targetRef.slice(TEMP_REF_PREFIX.length));
      if (add) target = { nodeId: add.workItemId ?? add.id, title: add.title };
    } else {
      const title = args.committedTitles.get(step.targetRef);
      if (title !== undefined) target = { nodeId: step.targetRef, title };
    }
    if (!target) continue; // withdrawn / gone — dropped
    resolved.push({
      ...base,
      phrase: step.kind === 'lay' ? 'layingChildrenOf' : 'authoring',
      targetNodeId: target.nodeId,
      targetTitle: target.title,
    });
  }
  resolved.sort((a, b) => {
    const d = Date.parse(a.startedAt) - Date.parse(b.startedAt);
    if (d !== 0) return d;
    return a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0;
  });
  const { authored, proposed } = countAuthored(args.addRows, args.requireExplanation);
  return {
    startedAt: iso(args.plan.createdAt),
    lastActivityAt: iso(args.plan.lastActivityAt),
    observedAt: iso(args.observedAt),
    authored,
    proposed,
    steps: resolved,
  };
}

// ── The clock reading ─────────────────────────────────────────────────────────

/**
 * Read a snapshot at `nowMs` (a SERVER-time instant — `serverNow(…)` on a
 * client). Precedence: `stalled` (quiet past the threshold; no live steps) →
 * `working` (any live step) → `starting` (nothing proposed yet) → `writing`
 * (a planner between steps, or one that never signals: counts and times, no
 * step words, no cue).
 */
export function readPlanProgress(
  snapshot: PlanProgressSnapshot,
  nowMs: number,
): PlanProgressReading {
  const sinceActivityMs = Math.max(0, nowMs - Date.parse(snapshot.lastActivityAt));
  const elapsedMs = Math.max(0, nowMs - Date.parse(snapshot.startedAt));
  const common = {
    authored: snapshot.authored,
    proposed: snapshot.proposed,
    elapsedMs,
    sinceActivityMs,
    lastActivityAt: snapshot.lastActivityAt,
  };
  if (sinceActivityMs > PLAN_STALLED_AFTER_MS) {
    return { ...common, state: 'stalled', liveSteps: [] };
  }
  // The QUIET drop — a session that died without clearing stops naming an item.
  const liveSteps = snapshot.steps.filter(
    (s) => nowMs - Date.parse(s.startedAt) <= PLAN_STALLED_AFTER_MS,
  );
  const state: PlanProgressState =
    liveSteps.length > 0 ? 'working' : snapshot.proposed === 0 ? 'starting' : 'writing';
  return { ...common, state, liveSteps };
}

/**
 * The client's clock, held to SERVER time: the snapshot's `observedAt` advanced
 * by how long the client has held it (`clientNowMs − receivedAtMs`, both on the
 * client's own clock, so its skew cancels). Pass the result to
 * {@link readPlanProgress}.
 */
export function serverNow(observedAt: string, receivedAtMs: number, clientNowMs: number): number {
  return Date.parse(observedAt) + Math.max(0, clientNowMs - receivedAtMs);
}
