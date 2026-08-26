import { Bell, KeyRound, Languages, Palette, ShieldCheck, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// The account-settings navigation REGISTRY (Story 7.8 · Subtask 7.8.12) — ONE
// typed entry per account-settings page. It mirrors `projectSettingsNav` (the
// shipped 6.5 area pattern) so the account surface scales the same way: a single
// source that drives three surfaces, which therefore can never drift apart:
//   1. the settings AREA nav (the rail, rendered by SidebarNav when in the area)
//   2. the command-palette deep links (AppCommandPalette)
//   3. the TOTALITY test (every real `settings/account/**/page.tsx` route has
//      EXACTLY one registry entry, and vice versa — the mistake #29 totality
//      guard; `tests/settings/accountSettingsNav.test.ts` enumerates the
//      filesystem). The area-ROOT redirect page is excluded (see that test).
//
// A later story mounts its page by ADDING an entry (or flipping a placeholder to
// a real one): 7.8.3 lit up the API-tokens slot, 7.3.58 the Appearance slot, and
// 8.8.24 the Profile slot below — every reserved slot is now a real route. The
// area asset of record is `design/settings/account-settings.mock.html` (7.8.2);
// the Profile pane's own asset is `design/settings/profile.mock.html` (8.8.20).
//
// DELIBERATE DEVIATION from `projectSettingsNav`: there is **no `access`
// predicate / capabilities axis** here. Account settings are the signed-in
// user's OWN personal preferences — there is no role/permission to gate a row on
// (every entry is always visible to its owner), so adding an `access` field would
// be complexity for nothing (the decision-ladder "no complexity without a use
// case" rule). The rest of the shape — id / group / href / icon / labelKey /
// exact? / placeholder? — matches `SettingsNavEntry` 1:1.
//
// This module is pure data + pure helpers (no JSX, no React state), so it is
// importable from both the server (the totality test) and the client (SidebarNav,
// the command palette) and is unit-testable in isolation. `icon` is the lucide
// COMPONENT (not a rendered element); the consumer renders `<entry.icon />`.

export type AccountSettingsNavGroup = 'general' | 'preferences' | 'security';

/** Rail order of the groups (General → Preferences → Security). */
export const ACCOUNT_SETTINGS_NAV_GROUP_ORDER: AccountSettingsNavGroup[] = [
  'general',
  'preferences',
  'security',
];

export interface AccountSettingsNavEntry {
  /** Stable id — also the command-palette action id (`account-settings-<id>`). */
  id: string;
  group: AccountSettingsNavGroup;
  /** The route this entry navigates to. Empty for a placeholder slot. */
  href: string;
  /** The lucide icon COMPONENT (the consumer renders it). */
  icon: LucideIcon;
  /** i18n key under the `settings.account.nav` namespace (e.g. `language`). */
  labelKey: string;
  /**
   * Active ONLY on an exact pathname match. Unused today (no account route is a
   * prefix of another), but kept for shape-parity with `projectSettingsNav` so a
   * future landing-at-root entry can opt in.
   */
  exact?: boolean;
  /**
   * A designed-for, not-yet-built slot — rendered as a disabled "Soon" row so the
   * area's shape is legible from day one, but NOT a real route (excluded from the
   * route↔registry totality assertion and from the command palette). No slot is
   * reserved today: API tokens (7.8.3), Appearance (7.3.58), and Profile (8.8.24)
   * each shipped its pane + route and flipped to a real entry. The field stays for
   * the NEXT designed-for-but-unbuilt account pane (shape-parity with
   * `projectSettingsNav`).
   */
  placeholder?: boolean;
}

/** The account-settings area root — a redirect to the first real pane. */
export const ACCOUNT_SETTINGS_ROOT = '/settings/account';

/**
 * The registry. Order within a group is the rail order. Icons mirror
 * `design/settings/account-settings.mock.html` (User · Languages · Bell · Palette
 * · KeyRound).
 */
export const ACCOUNT_SETTINGS_NAV: AccountSettingsNavEntry[] = [
  {
    id: 'profile',
    group: 'general',
    href: '/settings/account/profile',
    icon: User,
    labelKey: 'profile',
    // Lit up by Story 8.8.24 (the Profile pane + its route): personal details —
    // name (inline edit) + email, with avatar / email-change / password as the
    // sibling slices (8.8.24a/b/c) composing in. 7.8.2 reserved this as a "Soon"
    // placeholder; flipping it to a real entry keeps the route↔registry totality
    // test green by construction (the new pane has an on-disk route now), exactly
    // as 7.8.3 did for API tokens and 7.3.58 for Appearance.
  },
  {
    id: 'language',
    group: 'preferences',
    href: '/settings/account/language',
    icon: Languages,
    labelKey: 'language',
  },
  {
    id: 'notifications',
    group: 'preferences',
    href: '/settings/account/notifications',
    icon: Bell,
    labelKey: 'notifications',
  },
  {
    id: 'appearance',
    group: 'preferences',
    href: '/settings/account/appearance',
    icon: Palette,
    labelKey: 'appearance',
    // Lit up by Story 7.3.58 (the Appearance pane + its route): the three-axis
    // design system — theme × style × palette × type — turned on Motir itself.
    // 7.8.2 reserved this as a "Soon" placeholder; flipping it to a real entry
    // here keeps the route↔registry totality test green by construction (the new
    // pane has an on-disk route now), exactly as 7.8.3 did for API tokens.
  },
  {
    id: 'twoFactor',
    group: 'security',
    href: '/settings/account/security',
    icon: ShieldCheck,
    labelKey: 'twoFactor',
    // Story 8.11 (MOTIR-1213) · Subtask MOTIR-1220. FIRST in the Security group,
    // above API tokens: the registry renders in declaration order and a second
    // factor is the more consequential of the two things this group holds.
    //
    // This row is the pane's ONLY door — `design/settings/two-factor.mock.html`
    // draws it active in three panels, and the access-path gate is why. Adding it
    // together with its route keeps the route↔registry totality test green by
    // construction, exactly as 7.8.3 did for API tokens and 7.3.58 for Appearance.
  },
  {
    id: 'apiTokens',
    group: 'security',
    href: '/settings/account/tokens',
    icon: KeyRound,
    labelKey: 'apiTokens',
    // Lit up by Story 7.8.3 (the tokens pane + its route page): 7.8.12 reserved
    // this as a "Soon" placeholder, and flipping it to a real entry here keeps
    // the route↔registry totality test green by construction (the new pane has
    // an on-disk route now).
    //
    // MOTIR-2534 moved the ROUTE from `/settings/account/api-tokens` to
    // `/settings/account/tokens` (the reader-facing rename, Story MOTIR-2532),
    // with a permanent redirect in `next.config.ts`'s `SETTINGS_REDIRECTS`. The
    // `id` and `labelKey` deliberately did NOT move: the `id` is also the
    // command-palette action id (`account-settings-apiTokens`), the `labelKey`
    // indexes `settings.account.nav.apiTokens`, and neither is a surface a
    // reader ever sees — that story renames the LABEL, not the key.
  },
];

/**
 * The REAL route entries (placeholders excluded) — the set the totality test
 * pairs 1:1 with the on-disk `settings/account/**​/page.tsx` panes (the area-root
 * redirect aside), and the set the command palette deep-links.
 */
export const ACCOUNT_SETTINGS_ROUTES: AccountSettingsNavEntry[] = ACCOUNT_SETTINGS_NAV.filter(
  (entry) => !entry.placeholder,
);

/** Whether `pathname` is inside the account-settings area. */
export function isAccountSettingsPath(pathname: string): boolean {
  return pathname === ACCOUNT_SETTINGS_ROOT || pathname.startsWith(`${ACCOUNT_SETTINGS_ROOT}/`);
}

/** Whether a registry entry is the active route for `pathname`. */
export function isAccountSettingsEntryActive(
  entry: AccountSettingsNavEntry,
  pathname: string,
): boolean {
  if (!entry.href) return false;
  if (entry.exact) return pathname === entry.href;
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/**
 * Group a flat entry list into the rail's ordered, non-empty groups. Used by the
 * nav (one `SidebarSection` per group) and assertable in isolation.
 */
export function groupAccountSettingsNav(
  entries: AccountSettingsNavEntry[],
): { group: AccountSettingsNavGroup; entries: AccountSettingsNavEntry[] }[] {
  return ACCOUNT_SETTINGS_NAV_GROUP_ORDER.map((group) => ({
    group,
    entries: entries.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}
