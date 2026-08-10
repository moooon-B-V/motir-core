// The SURFACES Motir documents — the one list, read by both renderers (Story
// MOTIR-2315 · Subtask MOTIR-2522 · ADR `public-api-conventions.md` Amendment
// 19 Q3).
//
// ── Why this module exists ──────────────────────────────────────────────────
// Two places render "the things Motir documents": the docs rail's FIRST TIER
// (`app/(public)/docs/_components/CatalogueNav.tsx`, one row per surface on
// every page in the area — Amendment 11 Q1) and the area's index page at
// `/docs`, whose whole body is that same list with a line of description each.
//
// Before this module the rail held the list inline, and the index would have
// been the SECOND place the same fact lived. Nothing fails when two such lists
// disagree: a fifth surface gets added to whichever file its author opened, both
// renderers keep rendering, and the front door is quietly incomplete. So the
// list has one home and both read it — adding a surface is one entry here plus
// its route.
//
// ── What belongs here, and what does NOT ────────────────────────────────────
// A SURFACE is a product surface Motir documents, and it is not the same thing
// as a route: `/docs/api/stability` is a route and not a surface, and so is
// `/docs/mcp/tools`. A surface's own pages are its sub-area's second tier, which
// stays in `CatalogueNav`'s `SUB_AREAS` because it describes navigation rather
// than the surface set.
//
// ── English lives in the catalogs, not here ─────────────────────────────────
// Unlike `guide.ts` / `sandbox.ts` / `cli.ts` / `mcp.ts` — long-form prose kept
// out of `messages/*.json` for the reason `guide.ts` records — a surface's label
// and its one-line description are CHROME: short, per-surface, and localized.
// So this module carries i18n KEYS in the `apiDocs` namespace and no prose. A
// reader of this file cannot see the words; that is the trade the catalogs make
// everywhere else in this area's chrome too.
//
// ── The ORDER is the shipped rail's order ───────────────────────────────────
// API reference, agent sandbox, CLI, MCP server — unchanged from what the rail
// rendered before this list was extracted, deliberately. Amendment 19 Q2 keeps
// it: the list is now shared, so re-ordering it would re-order the navigation of
// every page in the area, which is a UX decision with its own reasons and its
// own card. This change moves WHERE the rows come from and nothing else.

/** A documented product surface — the key the rail marks `aria-current` with. */
export type DocsSurfaceKey = 'reference' | 'sandbox' | 'cli' | 'mcp';

export interface DocsSurface {
  /** Stable id; also the rail's `aria-current` target and the React key. */
  readonly key: DocsSurfaceKey;
  /** The surface's INDEX route — where a reader lands when they pick it. */
  readonly route: string;
  /** `apiDocs` key for the surface's name. Shared with the rail's row label. */
  readonly labelKey: string;
  /** `apiDocs` key for the one line saying what it is and who it is for. */
  readonly descriptionKey: string;
}

/**
 * Every surface the documentation area covers, in the order both renderers show
 * them. Adding one here puts it in the rail AND on the index with no further
 * edit to either — which is the property this module exists to buy.
 */
export const DOC_SURFACES: readonly DocsSurface[] = [
  {
    key: 'reference',
    route: '/docs/api',
    labelKey: 'navReference',
    descriptionKey: 'surfaceReferenceDesc',
  },
  {
    key: 'sandbox',
    route: '/docs/sandbox',
    labelKey: 'navSandbox',
    descriptionKey: 'surfaceSandboxDesc',
  },
  {
    key: 'cli',
    route: '/docs/cli',
    labelKey: 'navCli',
    descriptionKey: 'surfaceCliDesc',
  },
  {
    key: 'mcp',
    route: '/docs/mcp',
    labelKey: 'navMcp',
    descriptionKey: 'surfaceMcpDesc',
  },
];

/**
 * Each surface's index route, by key — the half of `ROUTE_BY_PAGE` the rail no
 * longer spells out for itself. Derived, so a route cannot be stated twice.
 */
export const DOC_SURFACE_ROUTES = Object.fromEntries(
  DOC_SURFACES.map((surface) => [surface.key, surface.route]),
) as Record<DocsSurfaceKey, string>;
