// STORY MOTIR-8413's SURFACE — the ONE enumeration (Subtask MOTIR-8418).
//
// Motir at work: the drafted card turns warm orange, pops and breathes while it is
// being written, and the Motir mark in the rail header breathes beside it
// (`design/ai-chat/design-notes.md` § _Motir at work_). Two readers import this
// module, and that is its whole purpose:
//
//   • `vitest.coverage.plan-at-work.config.ts` — the coverage FLOOR, built from
//     `GATED` / `REPORTED` / `SPECS`;
//   • `tests/planning/atWorkSurfaceGuards.test.ts` — the STRUCTURAL sweeps, over
//     `SURFACE` (the same source files plus the stylesheet and the token sheet).
//
// So a file cannot be gated without being swept, or swept without being gated.
//
// ⚠️ IT IMPORTS NOTHING. The sweep runs in the structural-guard lane, whose rule
// is that a member reaches no `lib/`, `app/` or `components/` module, and a
// coverage config spreads the root `vitest.config` — so neither reader may hand
// the other a dependency. Strings and paths only.

/** The files this story WROTE — each held to the floor, whole-file. */
export const GATED = [
  // MOTIR-8417 — the mark, new.
  'components/planning/PlanAtWorkMark.tsx',
  // MOTIR-8415 — `readPlanAtWork` and `PLAN_AT_WORK_MOVES` were added to the
  // shipped derivation's own file. GATED, not reported: this lane runs that file's
  // own suite (`tests/plans/planProgress.test.ts`), so its whole-file number
  // measures it rather than inheriting older code nobody here runs.
  'lib/plans/planProgress.ts',
] as const;

/**
 * The files this story WIDENED — reported, never gated: a per-file number over
 * any of them measures pre-existing code this lane does not run. The story's own
 * arms in them are read PER FUNCTION off this lane's json report and named in
 * the config.
 */
export const REPORTED = [
  // MOTIR-8416 — `NodeCue.moving`, `leavingCuesOf`, the retained leaving cue.
  'components/planning/PlanningCanvas.tsx',
  // MOTIR-8416 — `movingSteps` → the drafting cue's `moving`.
  'components/planning/PlanReviewCanvas.tsx',
  // MOTIR-8416 — `readPlanAtWork` once, `movingSteps`, the stalled hold.
  'components/planning/PlanProposalViews.tsx',
  // MOTIR-8417 — the one `PlanAtWorkMark` mount in the header.
  'components/planning/PlanChangeRail.tsx',
] as const;

/**
 * Not instrumented by coverage (a stylesheet has no V8 counters), so the CSS half
 * of every sweep rides this list instead of the coverage lists.
 */
export const STYLESHEETS = [
  // The cue's colour and motion and the mark's breath (MOTIR-8416 / MOTIR-8417).
  'app/globals.css',
  // The two new roles, `--el-drafting` / `--el-drafting-surface` (MOTIR-8416).
  'packages/design-system/theme.css',
] as const;

/** Every source file the sweeps read. */
export const SURFACE = [...GATED, ...REPORTED, ...STYLESHEETS] as const;

/** The specs that reach the surface — the coverage lane's `include`. */
export const SPECS = [
  // MOTIR-8415 — the derivation.
  'tests/plans/planProgress.test.ts',
  // MOTIR-8416 — the cue layer, its motion, the canvas map and the hold.
  'tests/components/planning-canvas-cues.test.tsx',
  'tests/components/planning-canvas-motion.test.tsx',
  'tests/components/plan-review-canvas-cues.test.tsx',
  'tests/components/plan-proposal-views.test.tsx',
  // MOTIR-8417 — the mark, and the rail it is mounted in.
  'tests/components/plan-at-work-mark.test.tsx',
  'tests/components/plan-change-rail.test.tsx',
  // MOTIR-8418 — the seam: one snapshot, the cue and the mark.
  'tests/integration/planning/atWorkStoryGate.test.tsx',
] as const;

/** The class / attribute hooks the approved design names — what the sweeps match. */
export const HOOKS = {
  /** On `[data-node-id]`: `"at-work"` | `"leaving"` | absent. */
  cueMotion: 'data-cue-motion',
  /** The mark's wrapper class; `data-at-work` carries its form. */
  markClass: 'plan-at-work-mark',
  markAttr: 'data-at-work',
  /** The shipped cue classes the motion binds to. */
  cueRing: 'canvas-cue-ring',
  cueChip: 'canvas-cue-chip',
} as const;

/** The two colour roles the story added — the only new colour vocabulary. */
export const COLOUR_ROLES = ['--el-drafting', '--el-drafting-surface'] as const;

/** The message keys the surface reads — none is new (the design adds no copy). */
export const MESSAGE_KEYS = [
  'planReview.cue.drafting',
  'planReview.cue.draftingName',
  'planReview.cue.laying',
  'planReview.cue.layingName',
  'planReview.liveWriting',
  'planReview.liveStalled',
  'planningWorkspace.railLabel',
] as const;
