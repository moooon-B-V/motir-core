// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch, planningLaunchBackHref } from '@/lib/planning/launcher';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// The established-project planning HOST (Subtask MOTIR-1729, extended by
// MOTIR-1730) — what "Plan with AI" opens once a project has a plan. These lock
// in what the host itself owns: the launcher's mode + originating context
// reaching the surface, the exit chrome (Close / `Esc`) a shell with no app nav
// must carry, and — since MOTIR-1730 — the wiring between the conversation, the
// canvas diff and the confirm-to-persist gate.
//
// The canvas is STUBBED: `PlanChangeCanvas` fetches its own levels, and its
// decoration is covered by `plan-change-level.test.tsx`. What matters here is
// that the host mounts it for a populated project (with the proposal it should
// draw), and swaps in the empty state otherwise.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: ({
    projectKey,
    ariaLabel,
    diffKey,
  }: {
    projectKey: string;
    ariaLabel?: string;
    diffKey: string | number;
  }) => (
    <div
      data-testid="canvas-stub"
      data-project={projectKey}
      data-diff-key={String(diffKey)}
      aria-label={ariaLabel}
    />
  ),
}));

const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as PlanChangeConversationState | null,
    send: vi.fn(),
    retry: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
    onApproved: null as ((r: unknown) => void) | null,
  },
}));

vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: ({ onApproved }: { onApproved?: (r: unknown) => void } = {}) => {
    conversation.onApproved = onApproved ?? null;
    return conversation;
  },
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';

const IDLE: PlanChangeConversationState = {
  phase: 'idle',
  session: {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    createdAt: '',
    updatedAt: '',
    turns: [],
  },
  progress: null,
  delta: null,
  jobId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
};

afterEach(() => {
  cleanup();
  push.mockReset();
  refresh.mockReset();
  conversation.state = null;
  conversation.approve.mockReset();
  conversation.discard.mockReset();
});

/** Render the host exactly as the page does — parse the query, derive the href. */
function renderHost(
  searchParams: Record<string, string | string[] | undefined>,
  {
    hasItems = true,
    state = IDLE,
  }: { hasItems?: boolean; state?: PlanChangeConversationState } = {},
) {
  const launch = parsePlanningLaunch(searchParams);
  conversation.state = state;
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

  it('mounts the CONVERSATION in the chat pane — the surface can be talked to', () => {
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
      'Reply, or refine further…',
    );
  });

  it('shows an empty canvas state when the project has nothing to draw', () => {
    renderHost({ mode: 'replan', from: 'project' }, { hasItems: false });

    expect(screen.queryByTestId('canvas-stub')).toBeNull();
    expect(screen.getByText('Nothing on the canvas yet')).toBeTruthy();
  });
});

describe('PlanningWorkspaceHost — the proposal is reviewed on the CANVAS', () => {
  const REVIEWING: PlanChangeConversationState = {
    ...IDLE,
    phase: 'review',
    jobId: 'job-1',
    delta: {
      operations: [
        { op: 'create', kind: 'story', fields: { title: 'Recurring invoices' } },
        { op: 'update', targetKey: 'PAY-21', fields: { title: 'Email reminders' } },
      ],
    },
  };

  it('shows NO confirm gate while nothing is proposed', () => {
    renderHost({ mode: 'replan', from: 'project' });
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();
  });

  it('hands the proposal to the canvas and raises the confirm-to-persist gate', () => {
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    const bar = screen.getByTestId('plan-change-confirm-bar');
    expect(bar.textContent).toContain('1 added, 1 changed');
    expect(bar.textContent).toContain('Nothing is saved until you approve.');
    // The canvas is re-keyed on the proposal, so the level redraws with the diff.
    const key = screen.getByTestId('canvas-stub').getAttribute('data-diff-key')!;
    expect(key).toContain('job-1');
    expect(key).toContain('1-1');
  });

  it('routes Approve and Discard to the one conversation both panes share', () => {
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });

    fireEvent.click(screen.getByRole('button', { name: /Approve changes/ }));
    expect(conversation.approve).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!);
    expect(conversation.discard).toHaveBeenCalledTimes(1);
  });

  it('page state after approve: the SERVER surfaces refresh AND the canvas island re-keys', () => {
    renderHost({ mode: 'replan', from: 'project' }, { state: REVIEWING });
    const before = screen.getByTestId('canvas-stub').getAttribute('data-diff-key')!;

    // What the hook calls once the commit lands.
    fireEvent.click(screen.getByRole('button', { name: /Approve changes/ }));
    conversation.state = { ...REVIEWING, phase: 'idle', delta: null, jobId: null };
    act(() => conversation.onApproved?.({ created: ['PAY-30'], updated: [], unchanged: [] }));

    // `router.refresh()` reaches the server-rendered surfaces behind the overlay…
    expect(refresh).toHaveBeenCalledTimes(1);
    // …and the canvas — a client island the refresh CANNOT reach — is re-keyed.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-diff-key')).not.toBe(before);
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
