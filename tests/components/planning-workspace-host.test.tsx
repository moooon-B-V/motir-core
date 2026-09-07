// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
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
/** The host's `onClose` is REQUIRED since MOTIR-4732 — there is no `backHref`
 *  fallback left, because the reader never leaves the page. */
const noop = () => {};
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

// The `@`-mention search is the ONE network-backed thing inside the real
// composer. Stubbed so the picker can be driven without a debounce and a
// endpoint — what is under test is that the HOST adds what the composer hands
// it, not what the search returns. Inert unless a test types an `@` query.
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: (query: string, enabled: boolean) => ({
    results:
      enabled && query.trim().length >= 2
        ? [{ id: 'wi_9', identifier: 'MOTIR-9', title: 'Billing', kind: 'story' }]
        : [],
    loading: false,
    tooShort: query.trim().length < 2,
  }),
}));

vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: ({
    projectKey,
    ariaLabel,
    diffKey,
    outcome,
    targetIds,
    initialTrail,
    loadingFallback,
    emptyRoot,
  }: {
    projectKey: string;
    ariaLabel?: string;
    diffKey: string | number;
    outcome?: string | null;
    targetIds?: readonly string[];
    initialTrail?: readonly { id: string; label: string }[];
    loadingFallback?: ReactNode;
    emptyRoot?: ReactNode;
  }) => (
    <div
      data-testid="canvas-stub"
      data-project={projectKey}
      data-diff-key={String(diffKey)}
      data-outcome={outcome ?? ''}
      data-targets={(targetIds ?? []).join(',')}
      data-trail={(initialTrail ?? []).map((c) => c.id).join(',')}
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
    workItemRefs: {},
  },
  progress: null,
  review: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  acts: [],
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
    initialCanvasTrail,
    canManage = false,
    onClose,
  }: {
    state?: PlanChangeConversationState;
    anchorId?: string | null;
    initialTarget?: PlanningTarget | null;
    initialCanvasTrail?: readonly { id: string; label: string }[];
    canManage?: boolean;
    onClose?: () => void;
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
      onClose={onClose ?? noop}
      initialTarget={initialTarget}
      initialCanvasTrail={initialCanvasTrail}
      canManage={canManage}
    />,
  );
}

/** The same element `renderHost` mounts, for a RE-render — the way a test walks
 *  a thread turn by turn without unmounting the surface between them, which is
 *  the whole property the footer slot is asserted on. */
function hostElement(searchParams: Record<string, string | string[] | undefined>) {
  const launch = parsePlanningLaunch(searchParams);
  return (
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={launch}
      anchorId={null}
      onClose={noop}
      initialTarget={null}
      canManage={false}
    />
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

    expect(screen.getByRole('button', { name: /Close/ })).toBeTruthy();
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

  // ── MOTIR-3162 (bug MOTIR-3154) — the overlay SURVIVES the decision ────────
  //
  // The host derives its ENTIRE diff index from `state.review`, so the hooks
  // nulling that field on approve and on discard erased the canvas overlay in
  // the same tick the decision landed.

  it.each(['accepted', 'declined'] as const)(
    'keeps a NON-EMPTY diff index after a plan is %s, and hands the outcome to the canvas',
    (decided) => {
      renderHost(
        { mode: 'replan', from: 'project' },
        { state: { ...REVIEWING, phase: 'idle', decided } },
      );

      const canvas = screen.getByTestId('canvas-stub');
      // Non-empty: the counts the index derives are still in the key, so there
      // is something for the canvas to draw.
      expect(canvas.getAttribute('data-diff-key')).toContain('1-1-0');
      expect(canvas.getAttribute('data-outcome')).toBe(decided);
    },
  );

  // ── MOTIR-1820 · the FOOTER SLOT ──────────────────────────────────────────
  //
  // The gate used to MOUNT and UNMOUNT, and it is a `shrink-0` sibling below a
  // `min-h-0 flex-1` canvas box — so the box grew and shrank by its full height
  // every time. The canvas anchors three control clusters to the BOTTOM of that
  // box, so all three hopped. Now one slot is always mounted and only its
  // CONTENT changes, which is what makes alternating between a question and a
  // change feel like one surface rather than two.

  it('keeps a footer slot when there is nothing to confirm, and says the canvas is SAVED', () => {
    renderHost({ mode: 'replan', from: 'project' });

    const footer = screen.getByTestId('plan-change-canvas-footer');
    expect(footer.textContent).toContain('Roadmap — as saved');
    // The ask's own promise, made visible at the one moment somebody might
    // wonder whether their question moved something.
    expect(footer.textContent).toContain('Nothing proposed. The conversation has changed nothing.');
    // …and it carries NO control: there is nothing to decide.
    expect(within(footer).queryByRole('button')).toBeNull();
  });

  it('swaps the slot CONTENT for the gate — the two are never both present', () => {
    const { rerender } = renderHost({ mode: 'replan', from: 'project' });
    expect(screen.getByTestId('plan-change-canvas-footer')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();

    conversation.state = REVIEWING;
    rerender(hostElement({ mode: 'replan', from: 'project' }));

    expect(screen.getByTestId('plan-change-confirm-bar')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-canvas-footer')).toBeNull();
  });

  it('⭐ chrome follows the LATEST TURN across an alternating thread', () => {
    // ask → change → ask. The rail is the same rail throughout and the user
    // changed no mode; only what the last turn produced decides the footer.
    const { rerender } = renderHost({ mode: 'replan', from: 'project' });
    expect(screen.getByTestId('plan-change-canvas-footer')).toBeTruthy();

    conversation.state = REVIEWING;
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.getByTestId('plan-change-confirm-bar')).toBeTruthy();

    // A question after a change does NOT discard the pending proposal — asking
    // mid-review is a lookup, not an abandonment — so the gate STAYS.
    conversation.state = { ...REVIEWING, phase: 'idle' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.getByTestId('plan-change-confirm-bar')).toBeTruthy();

    // …and once it is decided, the slot rests again.
    conversation.state = { ...REVIEWING, phase: 'idle', decided: 'accepted' };
    rerender(hostElement({ mode: 'replan', from: 'project' }));
    expect(screen.getByTestId('plan-change-canvas-footer')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();
  });

  it('drops the confirm gate once decided — a review is no longer a pending decision', () => {
    // The gate used to be keyed on "there IS a review", which was a safe proxy
    // only while a decision threw the review away. It is keyed on `decided` now.
    renderHost(
      { mode: 'replan', from: 'project' },
      { state: { ...REVIEWING, phase: 'idle', decided: 'accepted' } },
    );
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();
    // …and the canvas is still there, drawing what was accepted.
    expect(screen.getByTestId('canvas-stub')).toBeTruthy();
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
    conversation.state = {
      ...REVIEWING,
      phase: 'idle',
      review: null,
      decided: null,
      jobId: null,
      planId: null,
    };
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

describe('PlanningWorkspaceHost — the anchor reaches the CANVAS too (MOTIR-2070)', () => {
  const TRAIL = [
    { id: 'wi-464', label: 'MOTIR-464 · Epic 7: AI Planning Layer' },
    { id: 'wi-812', label: 'MOTIR-812 · Contextual planning from each work item' },
  ];

  it('hands the anchor’s ancestor trail to the canvas, so it opens on the anchor’s level', () => {
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-909' },
      { anchorId: 'wi-909', initialCanvasTrail: TRAIL },
    );

    // The whole bug in one assertion: before this, the anchor reached the
    // conversation and NOTHING reached the canvas, which seeded itself at the root.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-trail')).toBe('wi-464,wi-812');
    expect(conversation.anchorId).toBe('wi-909');
  });

  it('leaves the canvas at the root when there is no trail — project launch, or an epic', () => {
    renderHost({ mode: 'replan', from: 'project' });
    expect(screen.getByTestId('canvas-stub').getAttribute('data-trail')).toBe('');

    cleanup();
    renderHost(
      { mode: 'replan', from: 'work-item', item: 'MOTIR-464' },
      { anchorId: 'wi-464', initialCanvasTrail: [] },
    );
    expect(screen.getByTestId('canvas-stub').getAttribute('data-trail')).toBe('');
  });
});

describe('PlanningWorkspaceHost — the shell carries its own exit chrome', () => {
  // ⚠️ RE-POINTED (MOTIR-4729). These asserted a `<Link>` labelled with the
  // ORIGIN — *Back to roadmap* / *Back to MOTIR-7* — and a `keydown` listener on
  // `document`. Both belonged to the ROUTE: an overlay has no destination to
  // name, and the dialog owns `Esc` (one handler, not two — the collision
  // `design/runs/design-notes.md` warned about). The tests are re-pointed at
  // what replaced them rather than deleted, because the property they were
  // protecting — the shell carries its OWN way out, since it has no app nav —
  // is unchanged.

  it('renders ONE Close control, as a button, labelled without a destination', () => {
    renderHost({ mode: 'replan', from: 'project' });

    const close = screen.getByRole('button', { name: /Close/ });
    // Not a link: there is nowhere to go. The reader is already on the page.
    expect(close.tagName).toBe('BUTTON');
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
    // The `Esc` hint stays beside it — the key still closes, from the dialog.
    expect(within(close).getByText('Esc')).toBeTruthy();
  });

  it('says the same thing whatever the launch was — the label names no origin', () => {
    const project = renderHost({ mode: 'replan', from: 'project' });
    const projectLabel = screen.getByRole('button', { name: /Close/ }).textContent;
    project.unmount();

    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' });
    const close = screen.getByRole('button', { name: /Close/ });
    expect(close.textContent).toBe(projectLabel);
    // The RAIL still says which item the turn is about — that is its job. The
    // exit chrome is what stopped naming a destination.
    expect(close.textContent).not.toContain('MOTIR-7');
  });

  it('calls `onClose` — the seam the overlay routes every vector through', () => {
    const onClose = vi.fn();
    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' }, { onClose });

    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // It does NOT navigate: the page underneath must not unmount.
    expect(push).not.toHaveBeenCalled();
  });

  it('has NO navigation fallback left — closing never routes anywhere', () => {
    // ⚠️ RE-POINTED (MOTIR-4732). This asserted the `backHref` arm, which
    // existed for one caller: the `(planning)` page, a Server Component that
    // could not hand a callback across the boundary. That page is deleted, the
    // prop with it, and `onClose` is required — there is nowhere to navigate
    // BACK to, because the reader never left.
    const onClose = vi.fn();
    renderHost({ mode: 'contextual', from: 'work-item', item: 'MOTIR-7' }, { onClose });

    fireEvent.click(screen.getByRole('button', { name: /Close/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('no longer listens for `Esc` itself — the dialog owns the key', () => {
    const onClose = vi.fn();
    renderHost({ mode: 'replan', from: 'project' }, { onClose });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('mounts the workspace CHROME-FITTED, not viewport-sized', () => {
    // Inside a `h-dvh` dialog panel a second `h-dvh` child overflows by whatever
    // the panel's own box costs. `PlanningWorkspace`'s own docstring offers this
    // variant for exactly a chrome-fitted container.
    const { container } = renderHost({ mode: 'replan', from: 'project' });
    const frame = container.querySelector('.grid');
    expect(frame?.className).toContain('h-full');
    expect(frame?.className).not.toContain('h-dvh');
  });
});

// ── The audit-coverage banner's HOST gate (MOTIR-2250) ──────────────────────
//
// ⚠️ `/planning` lives in the `(planning)` route group, OUTSIDE `(authed)`, so
// `ProjectAccessProvider` is NOT mounted here and `useProjectAccess()` would
// return its documented PERMISSIVE default — showing an admin-only prompt to
// every member. The capability is therefore threaded as an explicit prop, and
// these pin that the gate is real rather than inherited from that default.
describe('PlanningWorkspaceHost — the audit-coverage banner is admin-only', () => {
  const coverage = { repos: [], notAuditedCount: 2 };

  function stubCoverage() {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (input: string) => {
      calls.push(String(input));
      return Promise.resolve({ ok: true, json: async () => coverage } as unknown as Response);
    });
    return calls;
  }

  it('renders it for a viewer who CAN manage the project', async () => {
    stubCoverage();
    renderHost({ mode: 'replan', from: 'project' }, { canManage: true });
    await act(async () => {});

    expect(screen.getByRole('status').textContent).toContain('2 repositories have no code-health');
    vi.unstubAllGlobals();
  });

  it('renders NOTHING for a viewer who cannot — and never even asks', async () => {
    const calls = stubCoverage();
    renderHost({ mode: 'replan', from: 'project' }, { canManage: false });
    await act(async () => {});

    expect(screen.queryByRole('status')).toBeNull();
    // The member's browser does not even issue the read: the banner is not
    // mounted, so there is no request for the server gate to refuse.
    expect(calls.filter((c) => c.includes('audit-coverage'))).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('defaults to NOT rendering when the capability is not supplied at all', async () => {
    stubCoverage();
    renderHost({ mode: 'replan', from: 'project' });
    await act(async () => {});

    expect(screen.queryByRole('status')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('coverage · the TARGET SET the host owns (MOTIR-4733)', () => {
  it('ADDS a target the composer’s `@` picker hands it', async () => {
    // The other half of the set the host owns. The composer's mention picker is
    // its only producer, so it is driven for real — only the search is stubbed
    // (see the mock at the top of this file), because a candidate list is not
    // what this asserts.
    renderHost({ mode: 'replan', from: 'project' });
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');

    const composer = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(composer, { target: { value: '@Billing' } });
    });

    const option = screen.queryByRole('option', { name: /MOTIR-9/ });
    // If the listbox did not open, say so rather than passing on a missing
    // element — a `queryBy` that finds nothing is not a green test.
    expect(option, 'the mention listbox did not open').not.toBeNull();
    // ⚠️ `mouseDown`, not `click`: the option commits on POINTER DOWN so the
    // composer's input never loses focus to it (`TargetSearchListbox`). A
    // `click` here would assert nothing and pass silently.
    await act(async () => {
      fireEvent.mouseDown(option!);
    });

    // The CANVAS rings it — which is the point of the set living on the host
    // rather than in the rail: both panes read it.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('wi_9');
  });

  it('removes the entrance’s pre-filled target when the chip’s ⨉ is pressed', () => {
    // `addTarget` / `removeTarget` live on the HOST, not the rail, because both
    // panes read the set: the composer collects it and the canvas rings it. They
    // are handed to the real composer, so this drives the real chip — the only
    // place either is reachable from.
    const target = { id: 'wi_7', identifier: 'MOTIR-7', title: 'The anchor', kind: 'subtask' };
    renderHost(
      { mode: 'contextual', from: 'work-item', item: 'MOTIR-7' },
      { initialTarget: target as PlanningTarget },
    );

    // The canvas RINGS it while it is in the set…
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('wi_7');

    const remove = screen.getByRole('button', { name: /MOTIR-7/ });
    fireEvent.click(remove);

    // …and stops the moment it leaves. The entrance's item is a SEED, not a
    // lock: the user can drop it and plan about something else.
    expect(screen.getByTestId('canvas-stub').getAttribute('data-targets')).toBe('');
    expect(screen.queryByTestId('planning-target-chip')).toBeNull();
  });
});
