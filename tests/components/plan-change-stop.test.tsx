// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';
import type { PlanningLaunch } from '@/lib/planning/launcher';

// THE STOP (Story MOTIR-4054 · MOTIR-4068) — the control, the interval after the
// click, and the state the run lands in.
//
// What this file is FOR, stated once because it is the whole card: **a stop is a
// DECISION, not a failure.** If stopping reads as throwing work away, people wait
// runs out instead of ending them and the control ships unused — a product
// failure with no error to trace. So the assertions below are mostly about what
// the stopped state does NOT do, which is the only way to check that claim.
//
// The tokens are `design/ai-chat/plan-change-run-live.mock.html` sheet 4's, and
// its "asserted by absence" table is what the third describe block below is.

const EMPTY_INDEX = {
  isEmpty: true,
  counts: { added: 0, changed: 0, removed: 0 },
} as unknown as PlanChangeDiffIndex;

const REVIEWABLE_INDEX = {
  isEmpty: false,
  counts: { added: 3, changed: 1, removed: 0 },
} as unknown as PlanChangeDiffIndex;

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: {
    id: 's1',
    projectId: 'p1',
    turnCount: 1,
    targetKeys: [],
    lastJobId: 'job-1',
    lastSubmittedAt: '2026-09-03T09:00:00.000Z',
    turns: [
      {
        id: 't1',
        seq: 0,
        role: 'user',
        body: 'Add a stop control to the planning run.',
        createdAt: '2026-09-03T09:00:00.000Z',
        jobId: null,
        question: null,
        isAnswer: false,
        intent: 'plan_change',
        intentCorrected: false,
        citations: [],
        authorName: 'Yue',
      },
    ],
    refs: {},
  } as unknown as PlanChangeConversationState['session'],
  progress: null,
  review: null,
  decided: null,
  jobId: 'job-1',
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
};

function renderRail(
  state: Partial<PlanChangeConversationState>,
  { onStop, index = EMPTY_INDEX }: { onStop?: () => void; index?: PlanChangeDiffIndex } = {},
) {
  return renderWithIntl(
    <PlanChangeRail
      launch={{ mode: 'project' } as PlanningLaunch}
      projectName="Motir"
      state={{ ...BASE, ...state }}
      index={index}
      targets={[]}
      onAddTarget={() => {}}
      onRemoveTarget={() => {}}
      onSend={() => {}}
      onRetry={() => {}}
      onCorrectTurn={() => {}}
      onApprove={() => {}}
      onDiscard={() => {}}
      {...(onStop ? { onStop } : {})}
    />,
  );
}

let onStop: (() => void) & ReturnType<typeof vi.fn>;

beforeEach(() => {
  cleanup();
  onStop = vi.fn() as (() => void) & ReturnType<typeof vi.fn>;
});

describe('the ENTRANCE — where the stop is, and when', () => {
  it('offers Stop while the run is streaming, in the PINNED footer', () => {
    const { container } = renderRail(
      { phase: 'streaming', progress: { kind: 'searching' } },
      { onStop },
    );

    const bar = screen.getByTestId('plan-change-running-bar');
    expect(within(bar).getByRole('button', { name: 'Stop' })).toBeTruthy();

    // ⚠️ THE PLACEMENT IS THE CRITERION, not decoration. The transcript is the
    // only region that scrolls (`overflow-y-auto`); the composer form is pinned.
    // A Stop inside the transcript passes every other assertion in this file and
    // breaks the one claim the design makes — that the control is reachable at
    // the moment it is wanted, which is when the run is visibly going wrong.
    const scroller = container.querySelector('[role="log"]');
    expect(scroller).toBeTruthy();
    expect(scroller!.contains(bar)).toBe(false);
    expect(bar.closest('form')).toBeTruthy();
  });

  it('offers NO bar when the run is not streaming', () => {
    for (const phase of ['idle', 'review', 'loading', 'deciding'] as const) {
      const { unmount } = renderRail({ phase }, { onStop });
      expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
      unmount();
    }
  });

  it('offers no bar when the host supplies no `onStop` — the shipped composer, unchanged', () => {
    renderRail({ phase: 'streaming', progress: { kind: 'searching' } });
    expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
  });

  it('the bar repeats the live narration, so the run is legible from the pinned region', () => {
    renderRail({ phase: 'streaming', progress: { kind: 'proposed', count: 3 } }, { onStop });
    // The reader may be scrolled anywhere in a forty-line run; the current act
    // has to be on screen either way (the design's measured finding: nine act
    // lines fit at the 1366x768 floor).
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      '3 items proposed so far',
    );
  });

  it('raises the stop once per click', () => {
    renderRail({ phase: 'streaming', progress: { kind: 'searching' } }, { onStop });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('STOPPING — the interval is honest', () => {
  it('says STOPPING, not stopped, and disables the control', () => {
    renderRail(
      { phase: 'streaming', progress: { kind: 'proposed', count: 3 }, stopping: true },
      { onStop },
    );

    const bar = screen.getByTestId('plan-change-running-bar');
    // The click is not the stop: `runWalk` reads the flag at its NEXT phase
    // boundary, which can be a whole authoring session away. A surface that
    // claims the run is over while it is still narrating is worse than a slow
    // stop, so the bar keeps its spinner and says what is actually happening.
    expect(bar.textContent).toContain('Stopping');
    expect(bar.textContent).not.toContain('You stopped this run');
    // The spinner is DECORATIVE here (`aria-hidden`), which is correct: the bar's
    // copy carries the state in words, so a screen reader is told what is
    // happening rather than that something is spinning. Asserted structurally
    // for that reason — a role query would (rightly) not find it.
    expect(bar.querySelector('.animate-spin')).toBeTruthy();

    const button = within(bar).getByRole('button', { name: 'Stopping…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not render the terminal marker while stopping', () => {
    renderRail({ phase: 'streaming', stopping: true }, { onStop });
    expect(screen.queryByTestId('plan-change-stopped')).toBeNull();
  });

  it('a second click cannot raise a second stop', () => {
    renderRail({ phase: 'streaming', stopping: true }, { onStop });
    fireEvent.click(screen.getByRole('button', { name: 'Stopping…' }));
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('STOPPED — a decision, and asserted BY ABSENCE', () => {
  it('renders the marker in the shipped system-marker vocabulary', () => {
    renderRail({ phase: 'idle', stopped: true }, { onStop });
    const marker = screen.getByTestId('plan-change-stopped');
    expect(marker.textContent).toBe('You stopped this run.');
    // The same treatment every other marker on this surface uses — centred,
    // `text-xs`, `--el-text-secondary`. Not a bubble and not a banner.
    expect(marker.className).toContain('text-center');
    expect(marker.className).toContain('text-(--el-text-secondary)');
  });

  it('⚠️ borrows NO error affordance — the card’s load-bearing claim', () => {
    const { container } = renderRail({ phase: 'idle', stopped: true }, { onStop });
    const html = container.innerHTML;

    // Each of these is something the STOPPED state may not use, and each is
    // listed in `design/ai-chat/plan-change-run-live.mock.html` sheet 4 with the
    // reason. Asserting their ABSENCE is the only way to check the claim: a
    // stopped run that renders politely while wearing failure clothing is
    // exactly the defect the criterion exists to catch.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(html).not.toContain('--el-tint-rose');
    expect(html).not.toContain('--el-danger');
    expect(html).not.toContain('--el-destructive');
    expect(html).not.toContain('--el-warning');
    expect(html).not.toContain('lucide-triangle-alert');
    expect(html).not.toContain('lucide-circle-x');
    // …and no Retry, which would frame a deliberate act as something to undo.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('the run’s bar is GONE once it has actually stopped', () => {
    renderRail({ phase: 'idle', stopped: true }, { onStop });
    expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
  });

  it('⚠️ THE PLAN SURVIVES — Approve and Discard are both reachable from here', () => {
    renderRail(
      {
        phase: 'review',
        stopped: true,
        review: { planId: 'plan-1' } as unknown as PlanChangeConversationState['review'],
      },
      { onStop, index: REVIEWABLE_INDEX },
    );

    // The shipped review block, LIVE, under the stopped marker. This is the
    // strongest available way to say a stopped run's proposals are worth what
    // they were worth a second earlier: it is literally the same block a
    // completed run shows, reused rather than restyled.
    const review = screen.getByTestId('plan-change-review');
    expect(within(review).getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(within(review).getByRole('button', { name: /discard/i })).toBeTruthy();
    expect(review.textContent).toContain('Nothing saved yet');
    expect(screen.getByTestId('plan-change-stopped')).toBeTruthy();
  });

  it('records no failure — a stopped run carries no error line', () => {
    renderRail(
      {
        phase: 'review',
        stopped: true,
        errorCode: null,
        review: { planId: 'plan-1' } as unknown as PlanChangeConversationState['review'],
      },
      { onStop, index: REVIEWABLE_INDEX },
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
