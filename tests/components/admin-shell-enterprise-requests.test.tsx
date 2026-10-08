// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PlatformRole } from '@/generated/prisma/client';
import en from '@/messages/en.json';

/**
 * The console rail's ENTERPRISE REQUESTS row (Story MOTIR-7602 · MOTIR-7609,
 * design `platform-admin` § Enterprise requests Panel 1): every staff role sees
 * it, as the LAST row of the Platform group after Users, and it is lit on the
 * list and on a request's detail.
 */

let pathname = '/admin';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const { AdminShell } = await import('@/app/(admin)/_components/AdminShell');

const shell = en.platformAdmin.shell;
const LABELS = {
  brand: shell.brand,
  area: shell.area,
  groupPlatform: shell.groupPlatform,
  groupOperations: shell.groupOperations,
  navOverview: en.platformAdmin.nav.overview,
  navUsage: en.platformAdmin.nav.usage,
  navTenants: en.platformAdmin.nav.tenants,
  navUsers: en.platformAdmin.nav.users,
  navEnterpriseRequests: shell.navEnterpriseRequests,
  navMonitoring: en.platformAdmin.nav.monitoring,
  navAiPlanning: shell.navAiPlanning,
  navPlanningLessons: shell.navPlanningLessons,
  navIdeas: shell.navIdeas,
  navRunModels: shell.navRunModels,
  navAuditLog: en.platformAdmin.nav.auditLog,
  staffMarkTitle: 'Platform staff',
  staffMarkSubtitle: 'All reads audited',
  searchPlaceholder: 'Search the estate',
  footerStaff: shell.footerStaff,
  exitToApp: shell.exitToApp,
};

afterEach(cleanup);

function renderShell(role: PlatformRole, at: string) {
  pathname = at;
  render(
    <AdminShell operator={{ email: 'ops@moooon.net', role }} labels={LABELS}>
      <p>page</p>
    </AdminShell>,
  );
  return screen.getByRole('navigation', { name: shell.area });
}

describe('the Enterprise requests row', () => {
  it('is labelled from the catalogue', () => {
    expect(shell.navEnterpriseRequests).toBe('Enterprise requests');
  });

  it.each(['support', 'operator', 'superadmin'] as const)('is on the rail for %s', (role) => {
    const rail = renderShell(role, '/admin');
    const row = within(rail).getByRole('link', { name: 'Enterprise requests' });
    expect(row.getAttribute('href')).toBe('/admin/enterprise-requests');
    expect(row.getAttribute('aria-current')).toBeNull();
  });

  it('is the last Platform row — after Users, before the Operations group', () => {
    const rail = renderShell('operator', '/admin');
    const names = within(rail)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim());
    const users = names.indexOf(LABELS.navUsers);
    expect(names[users + 1]).toBe('Enterprise requests');
    expect(names[users + 2]).toBe(LABELS.navMonitoring);
  });

  it('is lit on the list and on a request’s detail, and Users is not', () => {
    for (const at of ['/admin/enterprise-requests', '/admin/enterprise-requests/cm123']) {
      const rail = renderShell('support', at);
      expect(
        within(rail)
          .getByRole('link', { name: 'Enterprise requests' })
          .getAttribute('aria-current'),
      ).toBe('page');
      expect(
        within(rail).getByRole('link', { name: LABELS.navUsers }).getAttribute('aria-current'),
      ).toBeNull();
      cleanup();
    }
  });
});
