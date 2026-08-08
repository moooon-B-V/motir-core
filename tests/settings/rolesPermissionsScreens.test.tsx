// @vitest-environment happy-dom
import axe from 'axe-core';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { toRoleCatalogDTO } from '@/lib/mappers/permissionMappers';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { PERMISSIONS } from '@/lib/permissions/catalog';
import { RoleList } from '@/app/(authed)/settings/project/roles/_components/RoleList';
import { RoleDetail } from '@/app/(authed)/settings/project/roles/_components/RoleDetail';

// The Roles & permissions SCREENS (Story MOTIR-2282 · Subtask MOTIR-2263), built
// to `design/projects/roles-permissions.mock.html` panels 0 and 1.
//
// ⚠️ RENDERED WITH THE REAL `messages/en.json`, NOT A KEY-ECHO STUB. The card's
// acceptance criterion is that no row renders a raw catalog key — a stub that
// returns the key on a miss makes that criterion unfalsifiable, because a missing
// string and a present one produce the same green. With the real catalog a
// missing key is a visible `permissions.work_item_edit.label` in the DOM, which
// is exactly what these tests look for.

const CATALOG = toRoleCatalogDTO({ admin: 3, member: 12, viewer: 0 });

function renderWith(ui: React.ReactElement, messages: Record<string, unknown> = enMessages) {
  return renderWithIntl(ui, { messages });
}

afterEach(cleanup);

describe('the role LIST (screen 1)', () => {
  it('renders one row per role, each linking into its own detail route', () => {
    renderWith(<RoleList catalog={CATALOG} />);
    const rows = screen.getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      '/settings/project/roles/admin',
      '/settings/project/roles/member',
      '/settings/project/roles/viewer',
    ]);
  });

  it('activation is a real control — a link, focusable and keyboard-operable', () => {
    renderWith(<RoleList catalog={CATALOG} />);
    for (const row of screen.getAllByRole('link')) {
      // An <a href> is in the tab order and activates on Enter by construction —
      // which a div with an onClick is not, whatever it looks like.
      expect(row.tagName).toBe('A');
      expect(row.getAttribute('href')).toBeTruthy();
    }
  });

  it("shows each role's name, purpose, Built-in chip, N of M and headcount", () => {
    renderWith(<RoleList catalog={CATALOG} />);
    const admin = screen.getByRole('link', { name: /Admin/ });
    expect(within(admin).getByText('Built-in')).toBeTruthy();
    expect(within(admin).getByText(/Runs the project/)).toBeTruthy();
    // Admin holds the whole role-gated set — asserted against the constant, so
    // the expectation grows with the model instead of pinning a stale 28.
    expect(
      within(admin).getByText(
        `${ROLE_GATED_PERMISSIONS.length} of ${ROLE_GATED_PERMISSIONS.length} permissions`,
      ),
    ).toBeTruthy();
    expect(within(admin).getByText('3 members')).toBeTruthy();

    const member = screen.getByRole('link', { name: /Member/ });
    expect(within(member).getByText('12 members')).toBeTruthy();
  });

  it('says "0 members" for a role nobody holds, rather than dropping the line', () => {
    renderWith(<RoleList catalog={CATALOG} />);
    const viewer = screen.getByRole('link', { name: /Viewer/ });
    expect(within(viewer).getByText('0 members')).toBeTruthy();
  });

  it('pluralises the headcount — one member, not "1 members"', () => {
    renderWith(<RoleList catalog={toRoleCatalogDTO({ admin: 1 })} />);
    expect(screen.getByText('1 member')).toBeTruthy();
  });

  it('explains that the built-in roles cannot be changed', () => {
    renderWith(<RoleList catalog={CATALOG} />);
    expect(screen.getByText(/three built-in roles can’t be changed/)).toBeTruthy();
  });

  it('draws the level-gated permissions as their OWN card, never as role rows', () => {
    renderWith(<RoleList catalog={CATALOG} />);
    expect(screen.getByText('Public requests')).toBeTruthy();
    expect(screen.getByText('Access level')).toBeTruthy();
    const levelGated = PERMISSIONS.filter((key) => !ROLE_GATED_PERMISSIONS.includes(key));
    expect(levelGated.length).toBeGreaterThan(0);
    for (const key of levelGated) {
      const row = document.querySelector(`[data-permission="${key}"]`);
      expect(row, `${key} must appear on the access-level card`).toBeTruthy();
      // Marked as granted by the LEVEL — never as a permission a role withholds.
      expect(
        within(row as HTMLElement)
          .getByRole('img')
          .getAttribute('aria-label'),
      ).toBe('Granted by access level');
    }
  });

  it('renders NO write affordance — the built-ins are immutable for everyone', () => {
    renderWith(<RoleList catalog={CATALOG} />);
    // No Create role / Edit / Delete on this card: those arrive with custom
    // roles (MOTIR-2257). The absence is the read-only contract, so assert it.
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByText(/Create role/)).toBeNull();
    expect(screen.queryByText(/^Delete$/)).toBeNull();
  });

  it('renders no raw catalog key anywhere', () => {
    const { container } = renderWith(<RoleList catalog={CATALOG} />);
    expectNoRawKeys(container);
  });
});

describe('the role DETAIL (screen 2)', () => {
  const member = CATALOG.roles.find((role) => role.role === 'member')!;

  it('renders every role-gated permission, grouped under its domain heading', () => {
    renderWith(<RoleDetail role={member} catalog={CATALOG} projectName="motir" />);
    for (const key of ROLE_GATED_PERMISSIONS) {
      expect(document.querySelector(`[data-permission="${key}"]`), `${key} missing`).toBeTruthy();
    }
    const domainLabels = enMessages.permissions.domain as Record<string, string | undefined>;
    for (const group of CATALOG.domains) {
      const heading = domainLabels[group.domain];
      expect(heading, `no en label for domain ${group.domain}`).toBeTruthy();
      expect(screen.getByText(heading as string)).toBeTruthy();
    }
  });

  it('marks exactly the permissions the role holds — the marks come from its set', () => {
    renderWith(<RoleDetail role={member} catalog={CATALOG} projectName="motir" />);
    for (const key of ROLE_GATED_PERMISSIONS) {
      const row = document.querySelector(`[data-permission="${key}"]`) as HTMLElement;
      const mark = within(row).getByRole('img').getAttribute('aria-label');
      expect(mark, `${key}`).toBe(member.permissions.includes(key) ? 'Held' : 'Not held');
    }
  });

  it('never carries state by colour alone — every mark has an accessible name', () => {
    renderWith(<RoleDetail role={member} catalog={CATALOG} projectName="motir" />);
    const marks = screen.getAllByRole('img');
    expect(marks.length).toBe(ROLE_GATED_PERMISSIONS.length);
    for (const mark of marks) {
      expect(mark.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('leaves a withheld row fully legible — a mark, never a dimmed row', () => {
    renderWith(<RoleDetail role={member} catalog={CATALOG} projectName="motir" />);
    const withheld = ROLE_GATED_PERMISSIONS.find((key) => !member.permissions.includes(key))!;
    const row = document.querySelector(`[data-permission="${withheld}"]`) as HTMLElement;
    // The state lives on the MARK, not on the row's opacity.
    expect(row.className).not.toMatch(/opacity-|text-\(--el-text-faint\)/);
    expect(within(row).getByRole('img').getAttribute('aria-label')).toBe('Not held');
  });

  it('carries BOTH the crumb trail and the back link, and the link returns to the list', () => {
    renderWith(<RoleDetail role={member} catalog={CATALOG} projectName="motir" />);
    expect(screen.getByText('Settings · motir · Roles & permissions · Member')).toBeTruthy();
    const back = screen.getByRole('link', { name: 'All roles' });
    expect(back.getAttribute('href')).toBe('/settings/project/roles');
  });

  it('states the holding as N of M and locks a built-in with no control at all', () => {
    renderWith(<RoleDetail role={member} catalog={CATALOG} projectName="motir" />);
    expect(screen.getByText('Built-in · can’t be changed')).toBeTruthy();
    expect(screen.getByText('12 members')).toBeTruthy();
    expect(screen.getByText(String(member.permissions.length))).toBeTruthy();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('renders no raw catalog key anywhere', () => {
    const { container } = renderWith(
      <RoleDetail role={member} catalog={CATALOG} projectName="m" />,
    );
    expectNoRawKeys(container);
  });
});

describe('the zh catalog carries every string these screens render', () => {
  it('renders both screens in zh with no missing-key fallback', () => {
    const { container: list } = renderWith(<RoleList catalog={CATALOG} />, zhMessages);
    expectNoRawKeys(list);
    cleanup();
    const member = CATALOG.roles.find((role) => role.role === 'member')!;
    const { container: detail } = renderWith(
      <RoleDetail role={member} catalog={CATALOG} projectName="motir" />,
      zhMessages,
    );
    expectNoRawKeys(detail);
  });
});

/**
 * Fails on any rendered text that is an i18n PATH rather than a translation —
 * next-intl echoes the key when a message is missing, so this is what turns a
 * silent gap in either catalog into a red test.
 */
function expectNoRawKeys(container: HTMLElement) {
  const text = container.textContent ?? '';
  expect(text.length).toBeGreaterThan(0);
  expect(text, 'a permissions.* i18n path leaked into the DOM').not.toMatch(
    /permissions\.[a-z_]+\.(label|description)/,
  );
  expect(text, 'a settings.* i18n path leaked into the DOM').not.toMatch(/settings\.roles/);
  // A raw `resource:action` catalog key must never be user-visible either.
  for (const key of PERMISSIONS) {
    expect(text, `raw key ${key} rendered`).not.toContain(key);
  }
}

// Zero axe violations on BOTH screens (the card's a11y criterion). `color-contrast`
// is disabled because happy-dom resolves no `--el-*` custom property, so every
// token-driven colour reads as transparent — the contrast axis is owned by the
// palette's own AA guard, not by a DOM-less renderer. `region` is off for the same
// reason the sibling settings suites turn it off: a component rendered in
// isolation has no landmark ancestor, which the app shell supplies.
describe('a11y — zero axe violations on both screens', () => {
  const AXE = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };

  it('the role list', async () => {
    const { container } = renderWith(<RoleList catalog={CATALOG} />);
    expect((await axe.run(container, AXE)).violations).toEqual([]);
  });

  it('the role detail', async () => {
    const member = CATALOG.roles.find((role) => role.role === 'member')!;
    const { container } = renderWith(
      <RoleDetail role={member} catalog={CATALOG} projectName="motir" />,
    );
    expect((await axe.run(container, AXE)).violations).toEqual([]);
  });
});
