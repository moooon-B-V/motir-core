// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch, planningLaunchBackHref } from '@/lib/planning/launcher';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanningTarget } from '@/lib/planning/planningTargets';

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
    targetIds,
    loadingFallback,
    emptyRoot,
  }: {
    projectKey: string;
    ariaLabel?: string;
    diffKey: string | number;
    targetIds?: readonly string[];
    loadingFallback?: ReactNode;
    emptyRoot?: ReactNode;
  }) => (
    <div
      data-testid="canvas-stub"
      data-project={projectKey}
      data-diff-key={String(diffKey)}
      data-targets={(targetIds ?? []).join(',')}
      aria-label={ariaLabel}
    >
      {/* The two states the host DELEGATES to the canvas (MOTIR-2069). The real
          canvas picks between them off the level it reads itself; the stub
          renders both so the host's side of that contract is assertable. */}
      <div data-testid="canvas-loading-slot">{loadingFallback}</div>
      <div data-testid="canvas-empty-slot">{emptyRoot}</div>
    </div>
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
    anchorId: null as string | null,
  },
}));

vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: ({
    onApproved,
    anchorId,
  }: { onApproved?: (r: unknown) => void; anchorId?: string | null } = {}) => {
    conversation.onApproved = onApproved ?? null;
    conversation.anchorId = anchorId ?? null;
    return conversation;
  },
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';
import { planReview, planReviewItem } from '../helpers/planReview';

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
  review: null,
  jobId: null,
  planId: null,
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
  conversation.send.mockReset();
});

/** Render the host exactly as the page does — parse the query, derive the href.
 *  Note what is NOT passed: the host takes no roadmap data at all (MOTIR-2069). */
function renderHost(
  searchParams: Record<string, string | string[] | undefined>,
  {
    state = IDLE,
    anchorId = null,
    initialTarget = null,
  }: {
    state?: PlanChangeConversationState;
    anchorId?: string | null;
    initialTarget?: PlanningTarget | null;
  } = {},
) {
  const launch = parsePlanningLaunch(searchParams);
  conversation.state = state;
  return renderWithIntl(
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={launch}
      anchorId={anchorId}
      backHref={planningLaunchBackHref(launch)}
      initialTarget={initialTarget}
    />,
  );
}

describe('PlanningWorkspaceHost — the item ANCHOR (MOTIR-910)', () => {
  it('hands the resolved anchor to the conversation, so the turn rides the ITEM’s thread', () => {
    renderHost({ mode: 'replan', from: 'work-item', item: 'MOTIR-5' }, { anchorId: 'wi_123' });
    expect(conversation.anchorId).toBe('wi_123');
  });

  it('falls back to the PROJECT conversation when no anchor resolved', () => {
    // A hand-edited `?item=` for something deleted or in another tenant must not
    // dead-end the workspace — the page resolves it to no anchor and the surface
    // still opens, talking to the project thread.
    renderHost({ mode: 'contextual', from: 'work-item', item: 'GONE-9' });
    expect(conversation.anchorId).toBeNull();
  });
});

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

  it('gives the canvas the workspace’s own empty-canvas statement to show', () => {
    // The honest empty canvas for an established-but-emptied project survived
    // the move (MOTIR-2069): the host no longer DECIDES it — the canvas does,
    // off the level it reads itself — but the copy is still the workspace's,
    // not the raw canvas's bare "nothing here" panel.
    renderHost({ mode: 'replan', from: 'project' });

    const empty = screen.getByTestId('canvas-empty-slot');
    expect(empty.textContent).toContain('Nothing on the canvas yet');
    expect(empty.textContent).toContain('This project has no work items to draw');
  });
});

describe('PlanningWorkspaceHost — the frame opens BEFORE any canvas data (MOTIR-2069)', () => {
  // The bug: `/planning` painted nothing at all until the root roadmap read had
  // resolved. The page awaited that read to compute a `hasItems` boolean before
  // returning a single element, on a segment with no instant-loading UI — so the
  // user sat on the PREVIOUS surface and the whole workspace then appeared at
  // once, already populated. The read was also a duplicate of the one the canvas
  // performs itself. These lock in that the host waits on nothing.

  it('takes NO roadmap data — the frame cannot be held hostage by a read', () => {
    // Rendered with no data prop of any kind, the entire frame is there: exit
    // chrome, project name, mode, and a live conversation. This is the assertion
    // the old shape could not make — the host could not render at all without
    // the page having already awaited the roots.
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.getByRole('link', { name: /Back to roadmap/ })).toBeTruthy();
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan change');
    // The conversation is live immediately — it depends on no roadmap data, so a
    // user can start typing before the canvas has drawn a single node.
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
      'Reply, or refine further…',
    );
  });

  it('hands the canvas a SKELETON for its pending level, in the same box the level fills', () => {
    const { container } = renderHost({ mode: 'replan', from: 'project' });

    // The canvas is the only child of the flex-sized slot whether it is loading,
    // empty or drawn — so nothing around it moves when the level arrives (the
    // no-layout-shift requirement).
    const slot = container.querySelector('.min-h-0.flex-1.overflow-hidden')!;
    expect(slot).toBeTruthy();
    expect(slot.childElementCount).toBe(1);
    expect(slot.firstElementChild!.getAttribute('data-testid')).toBe('canvas-stub');

    // …and what it shows while the level is in flight is a skeleton, not a
    // blank pane and not a bare spinner.
    const loading = screen.getByTestId('canvas-loading-slot');
    expect(loading.firstElementChild).toBeTruthy();
    expect(loading.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(loading.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

describe('PlanningWorkspaceHost — the proposal is reviewed on the CANVAS', () => {
  const REVIEWING: PlanChangeConversationState = {
    ...IDLE,
    phase: 'review',
    jobId: 'job-1',
    planId: 'plan-1',
    review: planReview([
      planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
      planReviewItem({
        planItemId: 'pi_2',
        op: 'modify',
        nodeId: 'wi_21',
        identifier: 'PAY-21',
        title: 'Email reminders',
        changes: [{ field: 'title', from: 'Payment reminders', to: 'Email reminders' }],
      }),
    ]),
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
    expect(key).toContain('1-1-0');
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
    conversation.state = { ...REVIEWING, phase: 'idle', review: null, jobId: null, planId: null };
    act(() => conversation.onApproved?.({ created: ['wi_30'], updated: [], removed: [] }));

    // `router.refresh()` reaches the server-rendered surfaces behind the overlay…
    expect(refresh).toHaveBeenCalledTimes(1);
    // …and the canvas — a client island the refresh CANNOT reach — is re-keyed.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-diff-key')).not.toBe(before);
  });
});

describe('PlanningWorkspaceHost — the TARGET set is shared by both panes (MOTIR-1491)', () => {
  const TARGET: PlanningTarget = {
    id: 'wi-812',
    identifier: 'MOTIR-812',
    title: 'Billing — invoicing',
    kind: 'story',
  };

  it('pre-fills the entrance’s item as the INITIAL target — the chat and the map agree', () => {
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-812' },
      {
        initialTarget: TARGET,
      },
    );

    expect(screen.getByTestId('planning-target-chip').getAttribute('data-target-key')).toBe(
      'MOTIR-812',
    );
    // The same set reaches the canvas, which rings it.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('wi-812');
  });

  it('the pre-filled target is INITIAL, not locked — it can be removed', () => {
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-812' },
      {
        initialTarget: TARGET,
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove MOTIR-812' }));

    expect(screen.queryByTestId('planning-target-chip')).toBeNull();
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');
  });

  it('sends the turn WITH the target set, so the rail never has to know how a turn is scoped', () => {
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-812' },
      {
        initialTarget: TARGET,
      },
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Expand this.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(conversation.send).toHaveBeenCalledWith('Expand this.', [TARGET]);
  });

  it('a project-scoped launch opens with NO target — the picker is opt-in', () => {
    renderHost({ mode: 'replan', from: 'project' });

    expect(screen.queryByTestId('planning-target-tray')).toBeNull();
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');
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
