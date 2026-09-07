// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SettingsSidebarHeader } from '@/app/(authed)/_components/SettingsSidebarHeader';
import { AccountSidebarHeader } from '@/app/(authed)/_components/AccountSidebarHeader';
import { OrganizationSidebarHeader } from '@/app/(authed)/_components/OrganizationSidebarHeader';

// MOTIR-3171 — the two rail heads' "← Back to …" link goes to the PROJECT HOME,
// and the project home is `/home`.
//
// The defect this guards against is not a wrong link; it is a link that goes
// stale. `BACK_HREF` was CORRECT when both files were written — `/dashboard` was
// the post-auth landing until MOTIR-2654 moved it — and nothing failed when the
// product moved its home out from under the constant. Nothing could: until this
// file existed, no test in `tests/` or `tests/e2e/` read either back link, so the
// destination was asserted by the comment above it and by nothing else.
//
// Two properties are load-bearing, and both come from the card:
//
//   * Assert off the RENDERED anchor, never the exported constant. Each header
//     draws the link TWICE — an expanded row and a collapsed (56px) icon button —
//     from one constant, so a test that reads the constant proves one thing about
//     two branches and would keep passing if either branch stopped using it.
//   * Assert EVERY head. They are one pattern written repeatedly (the account head
//     is the settings head "retargeted", in its own words), which is why they
//     carried the same wrong value under the same wrong sentence; fixing one and
//     leaving the other is how the set diverges. There are THREE now — MOTIR-4710
//     added the organisation head when organisation settings became an area — and
//     a fourth must be added here in the commit that writes it.

const PROJECT = {
  id: 'p1',
  identifier: 'MOTIR',
  name: 'Motir',
  image: null,
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };

const ORG = { name: 'moooon' };

const HOME = '/home';

afterEach(cleanup);

describe('the rail-head back link points at the project home (MOTIR-3171)', () => {
  it.each([
    ['expanded', false],
    ['collapsed', true],
  ])('settings rail head — %s', (_name, collapsed) => {
    renderWithIntl(<SettingsSidebarHeader activeProject={PROJECT} collapsed={collapsed} />);

    // The catalogue string is unchanged by this card — the label still names the
    // project, and it is the DESTINATION that moved to match it.
    const link = screen.getByRole('link', { name: 'Back to Motir' });
    expect(link.getAttribute('href')).toBe(HOME);
  });

  it.each([
    ['expanded', false],
    ['collapsed', true],
  ])('account rail head — %s', (_name, collapsed) => {
    renderWithIntl(<AccountSidebarHeader user={USER} collapsed={collapsed} />);

    const link = screen.getByRole('link', { name: 'Back to Motir' });
    expect(link.getAttribute('href')).toBe(HOME);
  });

  it.each([
    ['expanded', false],
    ['collapsed', true],
  ])('organisation rail head — %s (MOTIR-4710)', (_name, collapsed) => {
    renderWithIntl(<OrganizationSidebarHeader organization={ORG} collapsed={collapsed} />);

    const link = screen.getByRole('link', { name: 'Back to Motir' });
    expect(link.getAttribute('href')).toBe(HOME);
  });

  it('NO head links to /dashboard any more — the retired landing', () => {
    const { container: settings } = renderWithIntl(
      <SettingsSidebarHeader activeProject={PROJECT} />,
    );
    const { container: account } = renderWithIntl(<AccountSidebarHeader user={USER} />);
    const { container: organization } = renderWithIntl(
      <OrganizationSidebarHeader organization={ORG} />,
    );

    for (const container of [settings, account, organization]) {
      expect(container.querySelector('a[href="/dashboard"]')).toBeNull();
    }
  });
});
