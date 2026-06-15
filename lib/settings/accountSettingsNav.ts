import { Bell, KeyRound, Languages, Palette, User } from 'lucide-react';
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
// a real one): 7.8.3 lights up the reserved API-tokens slot below, and the
// Profile / Appearance slots wait on their own future stories. The asset of
// record is `design/settings/account-settings.mock.html` (7.8.2).
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
   * route↔registry totality assertion and from the command palette). The reserved
   * slots: Profile (a future personal-details story) and Appearance (deliberately
   * not designed in 7.8.2 — its own future story owns it). (API tokens WAS such a
   * slot until Story 7.8.3 shipped its pane + route and flipped it to a real
   * entry.)
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
    href: '',
    icon: User,
    labelKey: 'profile',
    // Reserved "Soon": name / avatar / password land in a future personal-details
    // story (like the project area's Automation slot before 6.6).
    placeholder: true,
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
    href: '',
    icon: Palette,
    labelKey: 'appearance',
    // Reserved "Soon": theme / accent / font / display style are NOT designed in
    // 7.8.2 (the scope guard — a mocked control set we won't build would mislead);
    // their own future story owns it.
    placeholder: true,
  },
  {
    id: 'apiTokens',
    group: 'security',
    href: '/settings/account/api-tokens',
    icon: KeyRound,
    labelKey: 'apiTokens',
    // Lit up by Story 7.8.3 (the API-tokens pane + its route page): 7.8.12
    // reserved this as a "Soon" placeholder, and flipping it to a real entry
    // here keeps the route↔registry totality test green by construction (the new
    // pane has an on-disk route now).
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
