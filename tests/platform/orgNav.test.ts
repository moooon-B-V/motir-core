import { describe, expect, it } from 'vitest';
import {
  orgTabHref,
  parseOrgTab,
  safeTenantsHref,
} from '@/app/(admin)/admin/tenants/[orgId]/_components/orgNav';

/** The org page's tab and ← Tenants target (MOTIR-733). */
describe('safeTenantsHref', () => {
  it('returns to the list the operator came from, filter, period and sort kept', () => {
    expect(safeTenantsHref('/admin/tenants?period=all&sort=ci&q=acme')).toBe(
      '/admin/tenants?period=all&sort=ci&q=acme',
    );
    expect(safeTenantsHref('/admin/tenants')).toBe('/admin/tenants');
  });

  it('never sends the operator anywhere but the Tenants list', () => {
    for (const from of [
      undefined,
      '',
      '//evil.example',
      'https://evil.example/admin/tenants',
      '/admin/users',
      '/admin/tenantsX',
      '/admin/tenants/../users',
      '/admin/tenants?x=1#frag',
    ]) {
      expect(safeTenantsHref(from)).toBe('/admin/tenants');
    }
  });
});

describe('orgTabHref / parseOrgTab', () => {
  it('every tab keeps `from`, so ← Tenants works from any of them', () => {
    const back = '/admin/tenants?period=2026-09&sort=cost';
    expect(orgTabHref('org_1', 'usage', back)).toBe(
      `/admin/tenants/org_1?tab=usage&from=${encodeURIComponent(back)}`,
    );
    expect(orgTabHref('org_1', 'overview', '/admin/tenants')).toBe('/admin/tenants/org_1');
  });

  it('an unknown tab is the Overview', () => {
    expect(parseOrgTab('billing')).toBe('billing');
    expect(parseOrgTab('nope')).toBe('overview');
    expect(parseOrgTab(undefined)).toBe('overview');
  });
});
