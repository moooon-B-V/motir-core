import { Building2, Coins, CreditCard, GitBranch, ShieldCheck, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// The ORGANISATION-settings navigation REGISTRY (Story MOTIR-4669 · MOTIR-4710).
//
// The third and last of Motir's settings tiers to become an AREA.
// `settings/project/` and `settings/account/` each had an area layout, a
// registry and a `SidebarNav` branch; `settings/organization/` had none of the
// three. It was a single page of section cards whose four sub-routes were
// reachable ONLY from the `OrgControl` pop-over — and `SidebarNav`'s bottom
// `Settings` row points at that page whenever no project is active, so people
// DID arrive, at a page naming none of them.
//
// Two out of three establish a pattern strongly enough that the third reads as a
// convention. It was a GAP. Yue, on the design that finally asked where the door
// was:
//
//   "now organization -> setting goes to a single page with left nav setting
//    highlighted, the same setting nav as the project setting. you didn't make
//    it clear in the design where the door is"
//
// The design of record is `design/org-admin/org-admin.mock.html` panels 7a–7d
// (MOTIR-4673), which draws the rail, both filtered arms, and this table.
//
// Like its two siblings, one source drives the surfaces that therefore cannot
// drift: the area rail, and the route ↔ registry TOTALITY test
// (`tests/settings/organizationSettingsNav.test.ts`).
//
// ⚠️ TWO SURFACES, NOT THREE — the COMMAND PALETTE is deliberately not wired
// here yet, and saying so is the point. `AppCommandPalette` already carries
// hand-written org actions (`nav-settings`, `nav-org-security`) with their own
// conditions; generating a group from this registry would either duplicate them
// or silently re-decide when they appear, which is a palette decision rather
// than a registry one. The account registry drives its palette group because it
// had none to reconcile with. Wiring this one means retiring those two actions
// in the same change.
//
// ── THE `Git` ROW ARRIVED WITH ITS PAGE (MOTIR-4680) ────────────────────────
// MOTIR-4710 built this registry deliberately WITHOUT it, because
// `/settings/organization/git` did not exist yet and `accountSettingsNav.ts`
// records what happens when a row precedes its pane: the "reserved slot"
// mechanism was RETIRED (MOTIR-4324) once the last one flipped, leaving a flag, a
// rail branch and a filter unreachable from the product. MOTIR-4680 added the
// entry in the SAME COMMIT as the page, which is what keeps the route↔registry
// totality test green by construction — the move every account row since has
// made.
//
// ── ⚠️ WHAT THIS REGISTRY DOES *NOT* DECIDE ─────────────────────────────────
// Nothing moves. The four existing sub-routes become rows and the index becomes
// the `Organisation` row; no page's content changes. `WorkspaceFoldInSection` in
// particular stays on the index page — below the workspace-tier reveal that page
// hosts TWO tiers' sections (`docs/decisions/organization-tier.md` §6d) and
// relocating them is a §6 decision this card has no mandate for. The registry
// filters ROWS; the index page keeps its own per-SECTION gating, untouched.
//
// Pure data + pure helpers (no JSX, no React state), so it is importable from
// both the server (the totality test) and the client (SidebarNav, the palette).
// `icon` is the lucide COMPONENT; the consumer renders `<entry.icon />`.

export type OrganizationSettingsNavGroup = 'general' | 'access' | 'billing';

/**
 * Rail order of the groups (General → Access → Billing).
 *
 * It reads **configuration → people → money**, which is the order the org menu
 * already had — `OrgControl`'s own reasoning for putting `Security` directly
 * under `Settings` is that it is *a settings-shaped destination* and that keeping
 * it above `Members` *holds the two account-level concerns together*. Two doors
 * onto one set of rooms that disagreed about their order would be two mental
 * models of one organisation.
 */
export const ORGANIZATION_SETTINGS_NAV_GROUP_ORDER: OrganizationSettingsNavGroup[] = [
  'general',
  'access',
  'billing',
];

/**
 * What the ACTOR holds at the ORG tier. One boolean rather than a permission-key
 * set, because the org tier has no per-surface permission vocabulary — §6d's
 * table is written on ROLES (`owner`/`admin` vs plain `member`), and inventing a
 * second vocabulary to express a two-valued answer would be complexity without a
 * use case.
 */
export interface OrganizationSettingsNavActor {
  /** `isOrgAdminRole(role)` — owner or admin. */
  isOrgAdmin: boolean;
}

/**
 * What this BUILD has. Mirrors `SettingsNavAvailability` on the project
 * registry, including the part that matters most: it DEFAULTS CLOSED, so a
 * surface that forgets to thread it drops the row rather than offering a door
 * onto a route that `notFound()`s.
 */
export interface OrganizationSettingsNavAvailability {
  /** `isCloud()`, resolved on the SERVER and threaded to the client surfaces. */
  billingAvailable: boolean;
}

const NO_CLOUD: OrganizationSettingsNavAvailability = { billingAvailable: false };
const NO_ADMIN: OrganizationSettingsNavActor = { isOrgAdmin: false };

export interface OrganizationSettingsNavEntry {
  /** Stable id — also the command-palette action id (`org-settings-<id>`). */
  id: string;
  group: OrganizationSettingsNavGroup;
  /** The route this entry navigates to. Every entry is a real route. */
  href: string;
  /** The lucide icon COMPONENT (the consumer renders it). */
  icon: LucideIcon;
  /** i18n key under the `settings.organization.nav` namespace. */
  labelKey: string;
  /**
   * Requires org owner/admin. §6d's table is the authority for which rows carry
   * it: the org-scoped surfaces (the org roster, billing, the org danger zone)
   * are owner/admin only.
   *
   * ⚠️ ABSENT means "any org member", and that is a REAL disposition rather than
   * a default. §6 forbids a relocation that narrows an audience, so a surface
   * moving to this tier keeps the gate it had — which for a workspace-scoped
   * read is no role at all.
   */
  orgAdminOnly?: true;
  /**
   * Cloud builds only — the route `notFound()`s on a self-host build, so a row
   * would point at a 404. Same flag, same default-closed handling, as the project
   * registry's `cloudOnly`.
   */
  cloudOnly?: true;
  /** Active ONLY on an exact pathname match — the area root needs this. */
  exact?: true;
}

/** The organisation-settings area root — a real page, not a redirect. */
export const ORGANIZATION_SETTINGS_ROOT = '/settings/organization';

/**
 * The registry. Order within a group is the rail order; the labels are the org
 * menu's own words in full (`Usage & cost`, `Billing & plans`), never truncated
 * to fit a rail — two doors onto one room that disagree about its name are two
 * rooms to the person using them.
 */
export const ORGANIZATION_SETTINGS_NAV: OrganizationSettingsNavEntry[] = [
  {
    id: 'organization',
    group: 'general',
    href: ORGANIZATION_SETTINGS_ROOT,
    icon: Building2,
    labelKey: 'organization',
    // EXACT, because every other entry's href is a prefix-sibling under this one:
    // without it the area root would read as active on all five routes at once.
    exact: true,
    // NOT `orgAdminOnly`. Below the workspace-tier reveal this page hosts the
    // FOLDED-IN workspace sections (§6d), and a workspace member who is a plain
    // org member reaches Leave workspace through it — the one capability with no
    // alternative surface anywhere in the product. Hiding the row would close the
    // only route to it, which is precisely the defect §6d was written to repair.
    // The page keeps gating PER SECTION; the row is the door to the page.
  },
  {
    id: 'git',
    group: 'general',
    href: '/settings/organization/git',
    icon: GitBranch,
    labelKey: 'git',
    // ⚠️ NOT `orgAdminOnly`, and §6 of `docs/decisions/organization-tier.md` is
    // why: "a hidden tier may not remove a capability … relocating a surface
    // preserves its gate." The surface this page relocates FROM,
    // `/settings/workspace/github`, checks a session and a workspace context and
    // NO ROLE AT ALL — every workspace member reads it today, and every workspace
    // member is an org member by §5's upward invariant. Admin-gating the row
    // would have taken a shipped capability away silently.
    //
    // The owner/admin gate lives on the page's WRITE controls instead, and in the
    // service beneath them (`organizationRepoService.disconnectFromOrganisation`).
    //
    // `general`, beside `Organisation`, for the reason the project rail puts
    // `repositories` there: it is the tenant's own resources, not a permission
    // and not money.
  },
  {
    id: 'members',
    group: 'access',
    href: '/settings/organization/members',
    icon: Users,
    labelKey: 'members',
    orgAdminOnly: true,
  },
  {
    id: 'security',
    group: 'access',
    href: '/settings/organization/security',
    icon: ShieldCheck,
    labelKey: 'security',
    orgAdminOnly: true,
  },
  {
    id: 'usage',
    group: 'billing',
    href: '/settings/organization/usage',
    icon: Coins,
    labelKey: 'usage',
    orgAdminOnly: true,
  },
  {
    id: 'billing',
    group: 'billing',
    href: '/settings/organization/billing',
    icon: CreditCard,
    labelKey: 'billing',
    orgAdminOnly: true,
    cloudOnly: true,
  },
];

/** The destinations — what the totality test pairs 1:1 with the on-disk panes,
 *  and what the command palette deep-links. Every entry is a real route. */
export const ORGANIZATION_SETTINGS_ROUTES: OrganizationSettingsNavEntry[] =
  ORGANIZATION_SETTINGS_NAV;

/** Whether `pathname` is inside the organisation-settings area. */
export function isOrganizationSettingsPath(pathname: string): boolean {
  return (
    pathname === ORGANIZATION_SETTINGS_ROOT || pathname.startsWith(`${ORGANIZATION_SETTINGS_ROOT}/`)
  );
}

/** Whether a registry entry is the active route for `pathname`. */
export function isOrganizationSettingsEntryActive(
  entry: OrganizationSettingsNavEntry,
  pathname: string,
): boolean {
  if (!entry.href) return false;
  if (entry.exact) return pathname === entry.href;
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/** Whether `entry` exists at all on a deployment with these capabilities. */
function isAvailable(
  entry: OrganizationSettingsNavEntry,
  available: OrganizationSettingsNavAvailability,
): boolean {
  return !entry.cloudOnly || available.billingAvailable;
}

/**
 * The rows this actor may see, on this build — the registry filtered on BOTH
 * axes, which is the same shape `visibleSettingsNav` has and defaults closed for
 * the same reason.
 *
 * A row that filters away is ABSENT, never disabled: an entry point is a promise
 * about a room, and a disabled row is a promise the product then refuses
 * (MOTIR-2468). The rows below it close up and nothing marks the gap.
 */
export function visibleOrganizationSettingsNav(
  actor: OrganizationSettingsNavActor = NO_ADMIN,
  entries: OrganizationSettingsNavEntry[] = ORGANIZATION_SETTINGS_NAV,
  available: OrganizationSettingsNavAvailability = NO_CLOUD,
): OrganizationSettingsNavEntry[] {
  return entries.filter(
    (entry) => isAvailable(entry, available) && (!entry.orgAdminOnly || actor.isOrgAdmin),
  );
}

/**
 * Group a flat entry list into the rail's ordered, NON-EMPTY groups.
 *
 * A group whose rows all filtered away is not rendered — no empty heading. A
 * group with SOME survivors keeps its heading and closes up. Both are the
 * siblings' behaviour; neither is new here.
 */
export function groupOrganizationSettingsNav(
  entries: OrganizationSettingsNavEntry[],
): { group: OrganizationSettingsNavGroup; entries: OrganizationSettingsNavEntry[] }[] {
  return ORGANIZATION_SETTINGS_NAV_GROUP_ORDER.map((group) => ({
    group,
    entries: entries.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}
