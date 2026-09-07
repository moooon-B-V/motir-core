import {
  Bell,
  Database,
  GitBranch,
  KeyRound,
  Languages,
  Palette,
  ShieldCheck,
  User,
} from 'lucide-react';
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
// A later story mounts its page by ADDING an entry here. Three entries below
// arrived the other way — a slot RESERVED ahead of its pane and lit up when the
// pane landed (7.8.3 API tokens, 7.3.58 Appearance, 8.8.24 Profile). That
// reservation mechanism is RETIRED (MOTIR-4324): the last slot flipped in
// 8.8.24, leaving the flag, its rail rendering and its filter unreachable from
// the product, so all three were removed rather than left standing. Reserving a
// slot again is a deliberate re-introduction with its first real user, not a
// field to set. The
// area asset of record is `design/settings/account-settings.mock.html` (7.8.2);
// the Profile pane's own asset is `design/settings/profile.mock.html` (8.8.20).
//
// DELIBERATE DEVIATION from `projectSettingsNav`: there is **no `access`
// predicate / capabilities axis** here. Account settings are the signed-in
// user's OWN personal preferences — there is no role/permission to gate a row on
// (every entry is always visible to its owner), so adding an `access` field would
// be complexity for nothing (the decision-ladder "no complexity without a use
// case" rule). The rest of the shape — id / group / href / icon / labelKey /
// exact? — matches `SettingsNavEntry` 1:1.
//
// This module is pure data + pure helpers (no JSX, no React state), so it is
// importable from both the server (the totality test) and the client (SidebarNav,
// the command palette) and is unit-testable in isolation. `icon` is the lucide
// COMPONENT (not a rendered element); the consumer renders `<entry.icon />`.

export type AccountSettingsNavGroup = 'general' | 'preferences' | 'security' | 'data';

/**
 * Rail order of the groups (General → Preferences → Security → Data).
 *
 * `data` is FOURTH and LAST, and that placement is the design's own argument
 * (`design/settings/design-notes.md` → `Data & privacy` → *The ACCESS PATH*):
 * the rail renders groups in array order, so an entry appended to `general`
 * would land SECOND overall — an irreversible account action three rows above
 * the language picker. A fourth group ordered last is the only shape this
 * registry offers that puts account deletion at the BOTTOM, where every mirror
 * product puts it. It costs one member on the union above and one i18n key.
 */
export const ACCOUNT_SETTINGS_NAV_GROUP_ORDER: AccountSettingsNavGroup[] = [
  'general',
  'preferences',
  'security',
  'data',
];

export interface AccountSettingsNavEntry {
  /** Stable id — also the command-palette action id (`account-settings-<id>`). */
  id: string;
  group: AccountSettingsNavGroup;
  /** The route this entry navigates to. Every entry is a real route. */
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
    // sibling slices (8.8.24a/b/c) composing in. 7.8.2 had reserved this slot
    // ahead of its pane; flipping it to a real entry keeps the route↔registry
    // totality test green by construction (the new pane has an on-disk route
    // now), exactly as 7.8.3 did for API tokens and 7.3.58 for Appearance.
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
    // 7.8.2 had reserved this slot ahead of its pane; flipping it to a real entry
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
    // Lit up by Story 7.8.3 (the tokens pane + its route page): 7.8.12 had
    // reserved this slot ahead of its pane, and flipping it to a real entry here
    // keeps the route↔registry totality test green by construction (the new pane
    // has an on-disk route now).
    //
    // MOTIR-2534 moved the ROUTE from `/settings/account/api-tokens` to
    // `/settings/account/tokens` (the reader-facing rename, Story MOTIR-2532),
    // with a permanent redirect in `next.config.ts`'s `SETTINGS_REDIRECTS`. The
    // `id` and `labelKey` deliberately did NOT move: the `id` is also the
    // command-palette action id (`account-settings-apiTokens`), the `labelKey`
    // indexes `settings.account.nav.apiTokens`, and neither is a surface a
    // reader ever sees — that story renames the LABEL, not the key.
  },
  {
    id: 'gitAccounts',
    group: 'security',
    href: '/settings/account/git',
    icon: GitBranch,
    labelKey: 'gitAccounts',
    // Story MOTIR-4669 · MOTIR-4682 — the member's own git identity, moved DOWN
    // a tier while everything else in that story moves UP. `GithubIdentity` is
    // `userId @unique`: it has never belonged to a workspace, and
    // `projectSettingsNav.ts` already calls connecting it "the one action nobody
    // can take on [a member's] behalf."
    //
    // SECURITY group, THIRD — and both halves are read off this registry rather
    // than chosen. The group, because this is a CREDENTIAL and credentials live
    // here (`twoFactor`, `apiTokens`); it is not a preference and not data. The
    // ORDER, by extending the rule the group already states on `twoFactor`
    // ("above API tokens: a second factor is the more consequential of the two
    // things this group holds"): a second factor PROTECTS the account, an API
    // token ACTS AS YOU inside Motir, and a git identity grants Motir nothing
    // about your account at all. Third.
    //
    // ⚠️ `GitBranch` is the SAME glyph the organisation's `Git` row carries
    // (MOTIR-4673), deliberately: two rows in two navigations, of one family, so
    // a reader who has seen one recognises the other as *the git surface at the
    // tier they are standing on*. The LABEL is what tells them apart —
    // `Git accounts`, plural and account-scoped, never the org's bare `Git`.
    //
    // Landed in the SAME commit as `app/(authed)/settings/account/git/page.tsx`,
    // which keeps the route↔registry totality assertion green by construction —
    // the move every row since MOTIR-4324 has made.
  },
  {
    id: 'data',
    group: 'data',
    href: '/settings/account/data',
    icon: Database,
    labelKey: 'data',
    // Story 8.4 · Subtask MOTIR-1136 — the `Data › Data & privacy` pane: export
    // your personal data, and close your account. This row is the pane's ONLY
    // door (`design/settings/account-data.mock.html` draws it active in panels
    // 1, 4, 5 and 6), and the reason it opens a FOURTH group rather than joining
    // `general` is recorded on ACCOUNT_SETTINGS_NAV_GROUP_ORDER above.
    //
    // Landed in the SAME commit as `app/(authed)/settings/account/data/page.tsx`,
    // which is what keeps the route↔registry totality assertion in
    // `tests/settings/accountSettingsNav.test.ts` green by construction — the
    // same move 7.8.3 (API tokens), 7.3.58 (Appearance) and 8.11 (Two-factor)
    // each made.
  },
];

/**
 * The route entries — the set the totality test pairs 1:1 with the on-disk
 * `settings/account/**​/page.tsx` panes (the area-root redirect aside), and the
 * set the command palette deep-links.
 *
 * This USED to be `ACCOUNT_SETTINGS_NAV` minus the reserved-slot entries, and it
 * is now the whole registry: MOTIR-4324 retired the reservation mechanism, so
 * every entry is a real route by construction. The name is kept because it is
 * what its ~10 call sites read it AS — "the destinations", the question the
 * totality test and the palette are asking — and because a route/row distinction
 * returning is a filter to restore here rather than a symbol to re-thread.
 */
export const ACCOUNT_SETTINGS_ROUTES: AccountSettingsNavEntry[] = ACCOUNT_SETTINGS_NAV;

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
