// The "Plan with AI" universal launcher — the reusable entrance that summons the
// AI planning workspace (the canvas + chat surface; design @
// `design/ai-chat/planning-workspace.mock.html`, MOTIR-1193) from anywhere in
// the PM core, so the planner is callable any time — not only during onboarding
// (MOTIR-1299 / Story 7.20).
//
// This module is the launcher's PURE core: it maps the surface the user invoked
// the launcher FROM (the originating context) to the planning MODE the workspace
// should open in, and composes the OVERLAY ADDRESS that carries that context —
// the current page's own href plus four namespaced parameters, since MOTIR-4725
// made the workspace a layer rather than a place. It is deliberately framework-free (no React, no `server-only`) so
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
 * - `work-item` — a specific work item (its detail page / a row action). Its
 *   `hasPlan` is the item's OWN plan-vs-re-plan split (MOTIR-910): an item that
 *   already has children is being RE-planned, one without is being planned for
 *   the first time. Same shape as the project context's `hasPlan`, one level
 *   down; omitted (the coarse case) it degrades to the contextual default.
 * - `roadmap` — the Board↔Roadmap surface.
 * - `convention-refine` — refine a coding convention in the universal chat
 *   (MOTIR-1663: the Code-health page's "Refine with Motir" entry).
 */
export type PlanningLaunchContext =
  | { kind: 'project'; hasPlan?: boolean }
  | { kind: 'work-item'; itemKey: string; hasPlan?: boolean }
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
/* ⚠️ THREE ROUTE-ERA EXPORTS WERE DELETED HERE (MOTIR-4732, story MOTIR-4725),
 * and this note is what a reader meeting an old citation lands on.
 *
 *   · `PLANNING_WORKSPACE_PATH` — `'/planning'`, the workspace's entry path.
 *   · `planningWorkspaceHref(context)` — the DESTINATION a door navigated to.
 *   · `planningLaunchBackHref(launch)` — where Close RETURNED to, resolved from
 *     the origin: the item page, `/code-health`, or `/roadmap`.
 *
 * The workspace is an OVERLAY now: it opens ON the page you are already on and
 * closes by removing four query parameters from that page's own address. So
 * there is no destination to build and no return route to resolve —
 * `withPlanningOverlay` and `withoutPlanningOverlay` below are what replaced
 * them, and `parsePlanningOverlay` is what reads the result back.
 *
 * The return MAPPING survives in one place, because an old link still needs a
 * page to land on: `app/(authed)/planning/page.tsx`, the forward, inlines it.
 */

/** Resolve the originating context to the planning mode the workspace opens in. */
export function resolvePlanningMode(context: PlanningLaunchContext): PlanningMode {
  switch (context.kind) {
    case 'work-item':
      // The per-item entrance's two faces (MOTIR-910): an item that already has
      // children opens the workspace in RE-PLAN (the composer asks what's wrong
      // first); one that does not opens the plain contextual planning turn. An
      // absent `hasPlan` is the coarse case — contextual, as before.
      return context.hasPlan ? 'replan' : 'contextual';
    case 'roadmap':
      return 'roadmap';
    case 'convention-refine':
      return 'contextual';
    case 'project':
      if (context.hasPlan === undefined) return 'project';
      return context.hasPlan ? 'replan' : 'generation';
  }
}

// ─── The INVERSE: reading the launch context back off the host's query ────────
//
// `planningOverlaySearch` writes the context; the overlay reads it back. Both
// halves live here, in the launcher's pure core, so the two can never drift
// apart and both are unit-testable without a route.
//
// `parsePlanningLaunch` still reads the ROUTE-ERA names (`mode` / `from` /
// `item` / `repo`) — it has exactly one caller left, the `/planning` FORWARD
// (MOTIR-4732), which is what an old bookmark lands on. It is kept for that and
// nothing else; `parsePlanningOverlay` is what every live surface uses.

/** The origin kinds an overlay address carries as `planFrom`. */
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

/* ────────────────────────────────────────────────────────────────────────────
 * THE OVERLAY ADDRESS (MOTIR-4728, under story MOTIR-4725)
 *
 * The workspace is a full-screen OVERLAY on the page you are already on, not a
 * route (`design/ai-chat/design-notes.md` § *Opening & exiting — a full-screen
 * overlay ON TOP of the app (sheet 6)*). So the launcher's job changes shape:
 * instead of building a destination href, it MERGES a namespaced query onto the
 * caller's CURRENT address, STRIPS that query for Close, and PARSES it back.
 *
 * ⚠️ THE NAMES ARE THE DESIGN'S, NOT THIS MODULE'S. They are recorded in
 * `design/ai-chat/design-notes.md` § *The ADDRESS — a NAMESPACED query, settled
 * here because three cards read it*, exactly as `design/runs/design-notes.md`
 * records `/runs?run=<id>`, because THREE files have to agree on them: this
 * module writes and parses them, the overlay reads them off `useSearchParams`,
 * and the retiring `/planning` forward rewrites the old `mode`/`from`/`item`/
 * `repo` onto them. `OVERLAY_PARAM_NAMES` below is the single copy in code, and
 * `tests/planning/launcher.test.ts` asserts it against those names verbatim so a
 * rename in either home fails a test.
 *
 * WHY NAMESPACED, measured at `origin/main` `71896757c`: the overlay can open on
 * ANY authed route, so its query rides beside the host page's own — and the
 * obvious names are taken. `?item=` on `/roadmap` is the drilled LEVEL
 * (MOTIR-3836's `resolveArrivalTrail`), `?peek=` is the quick view on `/items`,
 * `/ready` and `/boards`, `?run=` is the run modal, and `?mode=` / `?from=` are
 * generic enough to collide with anything. A merge that clobbered one of those
 * would silently change the page underneath the overlay.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The four parameters the overlay's address carries.
 *
 * `plan` is BOTH the presence switch and the mode — the way `?run=` and `?peek=`
 * each own one word. Its presence is what opens the overlay, so "is the overlay
 * open?" is one lookup; and because the mode is already total (anything
 * unrecognised falls back to `project`), it can ride that key without a second
 * degradation path.
 */
export const OVERLAY_PARAM_NAMES = {
  /** the presence switch AND the resolved {@link PlanningMode}. */
  mode: 'plan',
  /** the {@link PlanningOrigin} — what decides which of the two below may be read. */
  origin: 'planFrom',
  /** the anchor work-item key; written ONLY for a `work-item` origin. */
  item: 'planItem',
  /** the repository key; written ONLY for a `convention-refine` origin. */
  repo: 'planRepo',
} as const;

/** Every overlay parameter name, for the strip and the collision guards. */
const OVERLAY_PARAMS: readonly string[] = Object.values(OVERLAY_PARAM_NAMES);

/**
 * The overlay's parameters for a launch context — the mode, the origin, and the
 * origin's own payload.
 *
 * The payload is gated on the ORIGIN on the way OUT as well as on the way back
 * (`parsePlanningLaunch`'s own rule), so the two halves cannot disagree about
 * which contexts may carry a target.
 */
export function planningOverlaySearch(context: PlanningLaunchContext): URLSearchParams {
  const params = new URLSearchParams({
    [OVERLAY_PARAM_NAMES.mode]: resolvePlanningMode(context),
    [OVERLAY_PARAM_NAMES.origin]: context.kind,
  });
  if (context.kind === 'work-item') params.set(OVERLAY_PARAM_NAMES.item, context.itemKey);
  if (context.kind === 'convention-refine') params.set(OVERLAY_PARAM_NAMES.repo, context.repoKey);
  return params;
}

/**
 * Split an href into its path (with any hash) and its query, WITHOUT resolving
 * it against an origin.
 *
 * `new URL(href)` needs a base and would normalise the path; these hrefs are the
 * app-relative ones `usePathname()` + `useSearchParams()` hand a client, and the
 * one thing this module must not do is change the host page's address in any way
 * other than adding or removing the four parameters above.
 */
function splitHref(href: string): { path: string; query: URLSearchParams; hash: string } {
  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const withoutHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  return {
    path: queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
    query: new URLSearchParams(queryAt === -1 ? '' : withoutHash.slice(queryAt + 1)),
    hash,
  };
}

/** Re-assemble, leaving NO dangling `?` when the query came out empty. */
function joinHref(path: string, query: URLSearchParams, hash: string): string {
  const qs = query.toString();
  return `${path}${qs ? `?${qs}` : ''}${hash}`;
}

/**
 * The OPEN address: `href` — the page the reader is on, with its own query — plus
 * the overlay's parameters.
 *
 * **Every host parameter survives byte for byte.** `/roadmap?item=MOTIR-12` keeps
 * its drilled level and `/items?peek=MOTIR-12` keeps its quick view, which is the
 * whole reason the names are namespaced.
 *
 * **Launching over an ALREADY-OPEN overlay REPLACES its parameters** rather than
 * appending a second set — re-targeting from the canvas's own per-item entrance
 * is a same-address navigation, and two `plan=` values would make the parse
 * order-dependent.
 */
export function withPlanningOverlay(href: string, context: PlanningLaunchContext): string {
  const { path, query, hash } = splitHref(href);
  for (const name of OVERLAY_PARAMS) query.delete(name);
  for (const [name, value] of planningOverlaySearch(context)) query.set(name, value);
  return joinHref(path, query, hash);
}

/**
 * The CLOSE address: `href` with ONLY the overlay's parameters removed.
 *
 * This is what Close, `Esc`, the scrim and the guard's *Discard* all write. The
 * host page's own query is untouched, so the filter and the drilled level the
 * reader had are exactly what they come back to — and an href that carried
 * nothing else comes back with no trailing `?`.
 */
export function withoutPlanningOverlay(href: string): string {
  const { path, query, hash } = splitHref(href);
  for (const name of OVERLAY_PARAMS) query.delete(name);
  return joinHref(path, query, hash);
}

/**
 * What a `searchParams` looks like from either side of the render boundary: a
 * `URLSearchParams` (what `useSearchParams()` hands a client component) or the
 * plain record a Server Component's `searchParams` prop carries. The `/planning`
 * forward (MOTIR-4732) parses on the server, so both are accepted here rather
 * than at each call site.
 */
export type PlanningOverlayParams = URLSearchParams | Record<string, RawParam>;

function readParam(params: PlanningOverlayParams, name: string): RawParam {
  /* v8 ignore next -- `URLSearchParams.getAll` returns an ARRAY for an absent
     name, never null or undefined, so the `??` arm is unreachable by the Web
     API's own contract. It is kept because the value crosses into `RawParam`,
     which admits `undefined`, and dropping it would make the type lie about a
     shape nothing produces. `tests/planning/planning-overlay-story-gate.test.ts`
     pins the invariant it stands on. */
  return params instanceof URLSearchParams ? (params.getAll(name) ?? undefined) : params[name];
}

/**
 * Read the launch back off an address — **`null` when the overlay is not in it**,
 * which is the shell's mount predicate: presence of `plan` is what opens the
 * workspace.
 *
 * When it IS present the result is the same total {@link PlanningLaunch}
 * `parsePlanningLaunch` produces — an absent or unrecognised value degrades to
 * the coarse project default rather than erroring, because this is parsed from a
 * user-editable URL — including the anti-smuggling rule: `itemKey` survives only
 * for a `work-item` origin and `repoKey` only for `convention-refine`, so a
 * hand-edited `?plan=project&planFrom=roadmap&planItem=MOTIR-1` opens the project
 * conversation and carries no target.
 */
export function parsePlanningOverlay(params: PlanningOverlayParams): PlanningLaunch | null {
  if (first(readParam(params, OVERLAY_PARAM_NAMES.mode)) === null) return null;
  const from = parsePlanningOrigin(readParam(params, OVERLAY_PARAM_NAMES.origin));
  return {
    mode: parsePlanningMode(readParam(params, OVERLAY_PARAM_NAMES.mode)),
    from,
    itemKey: from === 'work-item' ? first(readParam(params, OVERLAY_PARAM_NAMES.item)) : null,
    repoKey:
      from === 'convention-refine' ? first(readParam(params, OVERLAY_PARAM_NAMES.repo)) : null,
  };
}
