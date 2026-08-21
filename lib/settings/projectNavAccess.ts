import type { PermissionKey } from '@/lib/permissions/catalog';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// THE PROJECT-NAV GATING MAP (Story MOTIR-2258 · Subtask MOTIR-2471).
//
// The settings area is not the only place the shell offers rooms an actor cannot
// enter. The project nav lists ten destinations and the command palette lists its
// own navigations and actions, and both were gated on nothing more than "is
// there an active project". A viewer was offered **Plans**, whose page answers
// with the no-access state.
//
// ⚠️ ONE MAP, CONSUMED TWICE — and that is the whole design. It would be quicker
// to add a condition beside each row in the sidebar and another beside each entry
// in the palette, and it would work on the day it shipped. It would also
// guarantee the two disagree eventually, because they are edited by different
// people for different reasons and nothing makes them compare notes. The
// settings area already learned this (`projectSettingsNav.ts`: one registry,
// three consumers, a test that fails the build on drift), and this mirrors its
// shape deliberately.
//
// ⚠️ EVERY KEY WAS READ OFF THE DESTINATION, never inferred from the row's name.
// A row named Reports and a key named `report:view` look like an obvious pair;
// the risk is not that the guess is wrong so much as that nobody checks — and a
// wrong guess here fails in the direction that hides a room the person could
// have used, which nobody reports as a bug because they never knew it existed.
// The evidence for each pairing is on its own line below.
//
// ⚠️ `browse-only` IS A REAL ANSWER, not a gap. Most of the project nav genuinely
// is browse-gated, and a map that forced every row to name a permission would
// invite someone to invent one. A destination whose own page and services assert
// nothing beyond browse is recorded as `browse-only` and stays visible.

/**
 * What a nav destination requires: a catalog key, or `browse-only` for a
 * destination that asserts nothing past `project:browse` — which every actor who
 * reaches this shell already holds.
 */
export type NavRequirement = PermissionKey | 'browse-only';

export interface NavAccessEntry {
  /** The route this row navigates to — the join key both surfaces resolve on. */
  href: string;
  requires: NavRequirement;
  /** WHERE the key was read from. Prose, so the next reader can re-check it. */
  evidence: string;
}

/**
 * Every project-scoped destination the shell offers, with what it requires.
 *
 * NOT the settings area: its rail, its deep links and its area door are
 * `projectSettingsNav.ts`'s, and this map must not re-decide them.
 */
export const PROJECT_NAV_ACCESS: NavAccessEntry[] = [
  {
    // Home (Story MOTIR-2649 · Subtask MOTIR-2654) is the one row here that is
    // NOT project-scoped: it reads the workspace, resolves the actor's own
    // browsable-project set through `projectAccessService`, and asserts nothing
    // past it. So the requirement is genuinely `browse-only` — and it is in this
    // map anyway, because `canOfferNavDestination` answers FALSE for an href it
    // does not carry. That default is the right one (a room nobody vouched for
    // is not offered), and it means an omission here does not fail loudly: it
    // silently drops the row from the rail, which is the failure mode this file's
    // own header warns about. The totality guard in
    // `tests/settings/projectNavAccess.test.ts` is what makes that unmissable.
    href: AUTHED_LANDING_PATH,
    requires: 'browse-only',
    evidence:
      'app/(authed)/home/page.tsx resolves the session + workspace context and calls homeService, which filters to the browsable-project set itself. No permission is asserted, and none could be: the surface spans projects rather than sitting in one.',
  },
  {
    href: '/dashboard',
    requires: 'browse-only',
    evidence: 'The page resolves the session and the active project and asserts nothing further.',
  },
  {
    href: '/items',
    requires: 'browse-only',
    evidence: 'The page gates on `canBrowse` (6.4.6) and renders the no-access state below it.',
  },
  {
    href: '/ready',
    requires: 'browse-only',
    evidence: '`workItemsService.listReady` / `countReady` assert no key past the browse gate.',
  },
  {
    href: '/boards',
    requires: 'browse-only',
    evidence: 'The page gates on `canBrowse`; the board WRITES are gated in `boardsService`.',
  },
  {
    href: '/roadmap',
    requires: 'browse-only',
    evidence: 'The page gates on `canBrowse` (its own header comment says so).',
  },
  {
    href: '/plans',
    requires: 'ai:view_plan',
    evidence:
      '`plansService` asserts `ai:view_plan` on its AUTHOR writes and `ai:decide_plan` on ' +
      'approve / decline (MOTIR-3188 split the two); the plan READ itself is `canBrowse`. ' +
      'The row keeps `ai:view_plan` deliberately: both keys resolve to exactly the same ' +
      'actors under every built-in role, so the offer is unchanged, and it is the WIDER of ' +
      'the two — a custom role that can author but not decide still has a plans page to use.',
  },
  {
    href: '/backlog',
    requires: 'browse-only',
    evidence:
      '`backlogService` asserts no catalog key; the sprint writes live in `sprintsService`.',
  },
  {
    href: '/triage',
    requires: 'work_item:triage',
    evidence:
      '`triageService` asserts `work_item:triage` (MOTIR-2354, which moved it OFF `project:browse`). ' +
      "The page's own shipped gate is the older `canBrowse && canEdit` pair — this row follows the service.",
  },
  {
    href: '/reports',
    requires: 'report:view',
    evidence: '`reportsService` and `sprintsService` both assert `report:view`.',
  },
  {
    href: '/code-health',
    requires: 'ai:configure',
    evidence:
      '`aiConventionService.getAudit` / `.getConvention` assert `ai:configure` — and their own ' +
      'comments record that mapping them to `ai:plan` would have WIDENED an admin-only operation.',
  },
  {
    href: '/filters',
    requires: 'browse-only',
    evidence:
      'The page gates on `canBrowse`; `saved_filter:manage` gates AUTHORING a filter, not reading the list.',
  },
];

/** The AI planning entry point (`plan-with-ai`, and the sprint-planning door). */
export const AI_PLANNING_REQUIREMENT: NavRequirement = 'ai:plan';

const BY_HREF = new Map(PROJECT_NAV_ACCESS.map((entry) => [entry.href, entry]));

/**
 * Whether `href` may be OFFERED to an actor holding `held`.
 *
 * ⚠️ An href this map does not carry answers `false`, deliberately. A row added
 * later without a map entry disappears rather than shipping ungated by
 * omission — noisy, and the totality test above it fails first anyway, but the
 * failure direction is the safe one.
 */
export function canOfferNavDestination(href: string, held: ReadonlySet<PermissionKey>): boolean {
  const entry = BY_HREF.get(href);
  if (!entry) return false;
  if (entry.requires === 'browse-only') return true;
  return held.has(entry.requires);
}

/** Whether a requirement (e.g. {@link AI_PLANNING_REQUIREMENT}) is satisfied. */
export function satisfiesRequirement(
  requires: NavRequirement,
  held: ReadonlySet<PermissionKey>,
): boolean {
  return requires === 'browse-only' || held.has(requires);
}
