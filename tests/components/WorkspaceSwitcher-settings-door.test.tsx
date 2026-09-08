// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-4843 · MOTIR-4847 — THE DOOR ARRIVES
// (`design/settings/workspace-settings.mock.html` panel 5).
//
// `Workspace settings` used to live under the avatar, beside Sign out, as though
// configuring the container a team works in were a personal preference. It is
// now a row on the control that already carries the workspace's NAME. This file
// is the arrival; `workspace-tier-entry-points.test.tsx` is the departure, and
// the two together are what make it a MOVE rather than two independent edits.
//
// The assertions are on the href, not on the label: the property that matters is
// which room the row opens onto, and a label assertion would also pass for a row
// pointing somewhere else.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));
vi.mock('@/app/(authed)/_actions', () => ({
  createWorkspaceAction: vi.fn(),
  switchWorkspaceAction: vi.fn(),
}));
vi.mock('@/components/ui/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/Toast')>()),
  useToast: () => ({ toast: vi.fn() }),
}));

import { WorkspaceSwitcher } from '@/app/(authed)/_components/WorkspaceSwitcher';

const WORKSPACES = [
  { id: 'ws0', name: 'Acme', slug: 'acme', organizationId: 'org-1' },
  { id: 'ws1', name: 'Side Project Crew', slug: 'side', organizationId: 'org-1' },
] as unknown as WorkspaceSummaryDTO[];

afterEach(cleanup);

function openSwitcher(workspaces = WORKSPACES) {
  renderWithIntl(<WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId="ws0" />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch workspace' }));
}

/** Every anchor in the popover, in DOM order, as [label, href]. */
function popoverLinks(): [string, string | null][] {
  return [...document.querySelectorAll('[data-surface="popover"] a')].map((a) => [
    (a.textContent ?? '').trim(),
    a.getAttribute('href'),
  ]);
}

describe('the workspace switcher carries the settings door', () => {
  it('renders a row targeting the workspace AREA — its own href, not a sub-route', () => {
    openSwitcher();
    const row = screen.getByRole('link', { name: 'Workspace settings' });
    expect(row.getAttribute('href')).toBe('/settings/workspace');
  });

  it('sits in the LAST group, ABOVE `Invite teammates` (panel 5)', () => {
    // The order is the substantive half of the design decision, not styling:
    // `Invite teammates` already points INTO the area this row opens
    // (`/settings/workspace#members`), so the general door goes above the
    // shortcut through it, never the other way round. Asserting the pair as a
    // sequence is what makes a later insertion between them fail.
    openSwitcher();
    expect(popoverLinks()).toEqual([
      ['Workspace settings', '/settings/workspace'],
      ['Invite teammates', '/settings/workspace#members'],
    ]);
  });

  it('leaves `Invite teammates` untouched — the card ADDS a row, it substitutes none', () => {
    openSwitcher();
    expect(screen.getByRole('link', { name: 'Invite teammates' }).getAttribute('href')).toBe(
      '/settings/workspace#members',
    );
  });

  it('names the area NOWHERE until the popover is opened', () => {
    // The trigger is a bare workspace name; the door is inside. This pins that
    // the row rides the popover rather than the bar, which is what makes
    // `ShellTierNav`'s reveal gate on the whole switcher sufficient (below).
    renderWithIntl(<WorkspaceSwitcher workspaces={WORKSPACES} activeWorkspaceId="ws0" />);
    expect(document.body.innerHTML).not.toContain('href="/settings/workspace"');
  });

  it('⚠️ the EMPTY state carries no door — there is no workspace to configure', () => {
    // Zero memberships renders a bare `Create workspace` CTA, not a popover. A
    // settings row there would point at a workspace the reader does not have.
    renderWithIntl(<WorkspaceSwitcher workspaces={[]} activeWorkspaceId={null} />);
    expect(document.body.innerHTML).not.toContain('/settings/workspace');
  });
});
