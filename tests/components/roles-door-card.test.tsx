// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RolesDoorCard } from '@/app/(authed)/settings/organization/_components/RolesDoorCard';

// The Roles DOOR on the one-workspace fold-in (Story MOTIR-6168 · MOTIR-6466;
// design panel 4b): below the reveal the workspace rail is not taught, so the
// org page carries a link to `/settings/workspace/roles`, which answers at every
// workspace count.

afterEach(() => cleanup());

describe('RolesDoorCard', () => {
  it('names the room, counts the custom roles, and opens the workspace Roles page', () => {
    render(<RolesDoorCard customRoleCount={2} />);
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/settings/workspace/roles');
    expect(document.body.textContent).toMatch(/2/);
  });

  it('reads sensibly with no custom roles', () => {
    render(<RolesDoorCard customRoleCount={0} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/settings/workspace/roles');
  });
});
