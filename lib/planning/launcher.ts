// The "Plan with AI" universal launcher — the reusable entrance that summons the
// AI planning workspace (the canvas + chat surface; design @
// `design/ai-chat/planning-workspace.mock.html`, MOTIR-1193) from anywhere in
// the PM core, so the planner is callable any time — not only during onboarding
// (MOTIR-1299 / Story 7.20).
//
// This module is the launcher's PURE core: it maps the surface the user invoked
// the launcher FROM (the originating context) to the planning MODE the workspace
// should open in, and builds the href that carries that context to the
// workspace. It is deliberately framework-free (no React, no `server-only`) so
// it runs identically in the client launcher, the ⌘K command, and unit tests.
//
// The four modes are STATES of the one workspace surface (design §"The planning
// MODES"); each is owned + seeded by its own subtask — generation (7.4),
// re-plan/augment (7.11), contextual (7.12), roadmap-read (7.19). The launcher's
// job is only to OPEN the workspace in the right mode with the originating
// context; what each mode renders is those subtasks' responsibility.

/**
 * The planning mode the workspace opens in. `'project'` is the COARSE
 * project-scoped entrance used when the launch site does not (cheaply) know
 * whether a plan already exists — the workspace itself seeds generation-vs-
 * augment from the live tree. `'generation'` / `'replan'` are the resolved
 * fine split for callers that DO know (`hasPlan`).
 */
export type PlanningMode = 'project' | 'generation' | 'replan' | 'contextual' | 'roadmap';

/**
 * Where the launcher was invoked from — the originating context the workspace
 * needs to open in the right mode.
 *
 * - `project` — a project-level surface with no specific item.
 * - `work-item` — a specific work item (its detail page / a row action).
 * - `roadmap` — the Board↔Roadmap surface.
 * - `convention-refine` — refine a coding convention in the universal chat
 *   (MOTIR-1663: the Code-health page's "Refine with Motir" entry).
 */
export type PlanningLaunchContext =
  | { kind: 'project'; hasPlan?: boolean }
  | { kind: 'work-item'; itemKey: string }
  | { kind: 'roadmap' }
  | { kind: 'convention-refine'; repoKey: string };

/**
 * The shipped planning-workspace entry path — the ESTABLISHED-project host
 * (MOTIR-1729): a full-screen route outside the app shell that renders the
 * canvas+chat workspace seeded from the `mode` + `from` context below.
 *
 * It used to be `/onboarding`, which dead-ended: `app/(onboarding)/onboarding/
 * page.tsx` redirects a project whose `onboardingRanAt` is set straight to
 * `/roadmap`, so the launcher round-tripped and the workspace never opened. As
 * this module's original note promised, closing that gap changed only this
 * constant + the resolver — every call site (the TopNav pill, the FAB, ⌘K, the
 * roadmap empty state) is untouched.
 *
 * The onboarding gates are NOT relaxed: a project that never onboarded is
 * forwarded from the host to `/onboarding`, so first-run and migrate projects
 * keep their journey (the host is an ADDITIONAL surface, not a bypass).
 */
export const PLANNING_WORKSPACE_PATH = '/planning';

/** Resolve the originating context to the planning mode the workspace opens in. */
export function resolvePlanningMode(context: PlanningLaunchContext): PlanningMode {
  switch (context.kind) {
    case 'work-item':
      return 'contextual';
    case 'roadmap':
      return 'roadmap';
    case 'convention-refine':
      return 'contextual';
    case 'project':
      if (context.hasPlan === undefined) return 'project';
      return context.hasPlan ? 'replan' : 'generation';
  }
}

/**
 * Build the href that opens the planning workspace in the resolved mode,
 * carrying the originating context as query params so the workspace can seed
 * itself.
 */
export function planningWorkspaceHref(context: PlanningLaunchContext): string {
  const params = new URLSearchParams({
    mode: resolvePlanningMode(context),
    from: context.kind,
  });
  if (context.kind === 'work-item') params.set('item', context.itemKey);
  if (context.kind === 'convention-refine') params.set('repo', context.repoKey);
  return `${PLANNING_WORKSPACE_PATH}?${params.toString()}`;
}

// ─── The INVERSE: reading the launch context back off the host's query ────────
//
// `planningWorkspaceHref` writes the context; the host (MOTIR-1729) reads it.
// Both halves live here, in the launcher's pure core, so the two can never drift
// apart and both are unit-testable without a route.

/** The origin kinds `planningWorkspaceHref` writes as `?from=`. */
export type PlanningOrigin = PlanningLaunchContext['kind'];

const PLANNING_MODES: readonly PlanningMode[] = [
  'project',
  'generation',
  'replan',
  'contextual',
  'roadmap',
];

const PLANNING_ORIGINS: readonly PlanningOrigin[] = [
  'project',
  'work-item',
  'roadmap',
  'convention-refine',
];

/**
 * The launch context AS THE HOST SEES IT — the resolved mode plus whatever
 * originating detail survived the href. Every field is total: an absent or
 * unrecognized param degrades to the coarse project-scoped default rather than
 * erroring, because this is parsed from a user-editable URL.
 */
export interface PlanningLaunch {
  mode: PlanningMode;
  from: PlanningOrigin;
  /** The `work-item` origin's target key, when carried. */
  itemKey: string | null;
  /** The `convention-refine` origin's repo key, when carried. */
  repoKey: string | null;
}

/** The default a missing / unknown `?mode=` falls back to (never an error). */
export const DEFAULT_PLANNING_MODE: PlanningMode = 'project';
const DEFAULT_PLANNING_ORIGIN: PlanningOrigin = 'project';

type RawParam = string | string[] | undefined;

/** Next's `searchParams` hands a repeated key through as an array — take the first. */
function first(raw: RawParam): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Parse `?mode=`; anything unrecognized falls back to the project default. */
export function parsePlanningMode(raw: RawParam): PlanningMode {
  const value = first(raw);
  return PLANNING_MODES.find((m) => m === value) ?? DEFAULT_PLANNING_MODE;
}

/** Parse `?from=`; anything unrecognized falls back to the project origin. */
export function parsePlanningOrigin(raw: RawParam): PlanningOrigin {
  const value = first(raw);
  return PLANNING_ORIGINS.find((o) => o === value) ?? DEFAULT_PLANNING_ORIGIN;
}

/** Read the whole launch context back off the host route's query params. */
export function parsePlanningLaunch(searchParams: Record<string, RawParam>): PlanningLaunch {
  const from = parsePlanningOrigin(searchParams['from']);
  return {
    mode: parsePlanningMode(searchParams['mode']),
    from,
    // Only the origin that WRITES the param may carry it back, so a hand-edited
    // `?from=roadmap&item=X` can't smuggle a target into a non-item mode.
    itemKey: from === 'work-item' ? first(searchParams['item']) : null,
    repoKey: from === 'convention-refine' ? first(searchParams['repo']) : null,
  };
}

/**
 * Where the workspace's Close control returns to. The design's overlay "returns
 * you to the exact screen you launched from" (`planning-workspace.mock.html`
 * sheet 6); the host is a route, so the origin resolves to the surface that owns
 * that context — the project roadmap being the project-scoped default.
 */
export function planningLaunchBackHref(launch: PlanningLaunch): string {
  if (launch.from === 'work-item' && launch.itemKey) {
    return `/items/${encodeURIComponent(launch.itemKey)}`;
  }
  if (launch.from === 'convention-refine') return '/code-health';
  return '/roadmap';
}
