/**
 * The org page's navigation state (MOTIR-733) — the tab and where ← Tenants goes.
 * Both live in the URL, so a tab is linkable and the list the operator came from
 * (its filter, period and sort) is restored by the back button.
 */

export const ORG_TABS = ['overview', 'usage', 'billing', 'operations'] as const;
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

/**
 * The Usage & cost tab's URL for a period (MOTIR-7293) — what a month row of the
 * month-by-month table links to. Keeps the scope and `from`; a months cursor is
 * only carried when given, so choosing a period starts the series at its newest.
 */
export function orgUsageHref(
  orgId: string,
  input: { period: string; scope?: string | null; months?: string | null; backHref: string },
): string {
  const p = new URLSearchParams({ tab: 'usage', period: input.period });
  if (input.scope) p.set('scope', input.scope);
  if (input.months) p.set('months', input.months);
  if (input.backHref !== '/admin/tenants') p.set('from', input.backHref);
  return `/admin/tenants/${encodeURIComponent(orgId)}?${p.toString()}`;
}
