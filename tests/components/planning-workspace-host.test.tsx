// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch, planningLaunchBackHref } from '@/lib/planning/launcher';

// The established-project planning HOST (Subtask MOTIR-1729) — what "Plan with
// AI" opens once a project has a plan. These lock in the two things the host
// itself owns: the launcher's mode + originating context reaching the surface,
// and the exit chrome (Close / `Esc`) that a shell with no app nav must carry.
//
// The canvas is STUBBED: `WorkItemRoadmap` is the shipped component this host
// composes (it fetches its own levels) — its rendering is MOTIR-1194's contract,
// covered by the roadmap's own tests. What matters here is that the host mounts
// it for a populated project and swaps in the empty state otherwise.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/components/planning/WorkItemRoadmap', () => ({
  WorkItemRoadmap: ({ projectKey, ariaLabel }: { projectKey: string; ariaLabel?: string }) => (
    <div data-testid="canvas-stub" data-project={projectKey} aria-label={ariaLabel} />
  ),
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';

afterEach(() => {
  cleanup();
  push.mockReset();
});

/** Render the host exactly as the page does — parse the query, derive the href. */
function renderHost(
  searchParams: Record<string, string | string[] | undefined>,
  { hasItems = true }: { hasItems?: boolean } = {},
) {
  const launch = parsePlanningLaunch(searchParams);
  return renderWithIntl(
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      hasItems={hasItems}
      launch={launch}
      backHref={planningLaunchBackHref(launch)}
    />,
  );
}

describe('PlanningWorkspaceHost — the launcher context reaches the surface', () => {
  it('opens an established project in the plan-change mode with its tree on the canvas', () => {
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan change');
    expect(screen.getByText("Opened to change Acme's existing plan.")).toBeTruthy();
    // The canvas is seeded with the project's EXISTING tree (design panel 2).
    expect(screen.getByTestId('canvas-stub').getAttribute('data-project')).toBe('ACME');
  });

  it('opens in the contextual mode and names the work item it was launched from', () => {
    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' });

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('in context');
    expect(screen.getByText('Opened in the context of MOTIR-7.')).toBeTruthy();
  });

  it('opens in the roadmap mode from the roadmap door', () => {
    renderHost({ mode: 'roadmap', from: 'roadmap' });

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('roadmap');
    expect(screen.getByText('Opened from the roadmap.')).toBeTruthy();
  });

  it('falls back to the project-scoped default for an unknown mode instead of erroring', () => {
    renderHost({ mode: 'teleport', from: 'nowhere' });

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan');
    expect(screen.getByText('Opened on Acme.')).toBeTruthy();
  });

  it('is honest that the conversation is not wired up on this surface yet', () => {
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.getByText("The conversation isn't here yet")).toBeTruthy();
    // No composer to type into — the rail cannot send, so it does not pretend to.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows an empty canvas state when the project has nothing to draw', () => {
    renderHost({ mode: 'replan', from: 'project' }, { hasItems: false });

    expect(screen.queryByTestId('canvas-stub')).toBeNull();
    expect(screen.getByText('Nothing on the canvas yet')).toBeTruthy();
  });
});

describe('PlanningWorkspaceHost — the shell carries its own exit chrome', () => {
  it('closes back to the roadmap for a project-scoped launch', () => {
    renderHost({ mode: 'replan', from: 'project' });

    const close = screen.getByRole('link', { name: /Back to roadmap/ });
    expect(close.getAttribute('href')).toBe('/roadmap');
  });

  it('closes back to the work item it was launched from', () => {
    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' });

    const close = screen.getByRole('link', { name: /Back to MOTIR-7/ });
    expect(close.getAttribute('href')).toBe('/items/MOTIR-7');
  });

  it('Esc returns to the originating surface', () => {
    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(push).toHaveBeenCalledWith('/items/MOTIR-7');
  });

  it('Esc does NOT close while focus is in a text field (the field owns it first)', () => {
    renderHost({ mode: 'replan', from: 'project' });

    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(push).not.toHaveBeenCalled();
    input.remove();
  });

  it('Esc does NOT close when another surface already handled the key', () => {
    renderHost({ mode: 'replan', from: 'project' });

    // e.g. the canvas leaving full screen, or a menu closing — it preventDefaults.
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    document.dispatchEvent(event);

    expect(push).not.toHaveBeenCalled();
  });
});
