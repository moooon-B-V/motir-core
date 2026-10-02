/**
 * The org page's navigation state (MOTIR-733) — the tab and where ← Tenants goes.
 * Both live in the URL, so a tab is linkable and the list the operator came from
 * (its filter, period and sort) is restored by the back button.
 */

export const ORG_TABS = ['overview', 'usage', 'billing'] as const;
export type OrgTab = (typeof ORG_TABS)[number];

export function parseOrgTab(raw: string | undefined): OrgTab {
  return ORG_TABS.includes(raw as OrgTab) ? (raw as OrgTab) : 'overview';
}

/**
 * The ← Tenants target: the `from` the list handed over, but ONLY a path into the
 * Tenants list itself — never an absolute or protocol-relative URL, so the
 * parameter cannot be used to send an operator anywhere else.
 */
export function safeTenantsHref(from: string | undefined): string {
  if (from && /^\/admin\/tenants(\?[^#\s]*)?$/.test(from)) return from;
  return '/admin/tenants';
}

/** A tab's URL, keeping `from` so every tab's ← Tenants returns to the same list. */
export function orgTabHref(orgId: string, tab: OrgTab, backHref: string): string {
  const p = new URLSearchParams();
  if (tab !== 'overview') p.set('tab', tab);
  if (backHref !== '/admin/tenants') p.set('from', backHref);
  const q = p.toString();
  return `/admin/tenants/${encodeURIComponent(orgId)}${q ? `?${q}` : ''}`;
}
