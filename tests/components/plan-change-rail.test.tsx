// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanDelta } from '@/lib/planning/planChangeDiff';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import type { PlanDelta } from '@/lib/ai/planDelta';

// The conversational RAIL (Subtask MOTIR-1730; design panels 3 + 6). It is
// presentational — the host owns the conversation state — so each of the rail's
// six states is asserted by handing it that state directly.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

function turn(seq: number, body: string, role: 'user' | 'system' = 'user'): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body,
    jobId: role === 'system' ? 'job-1' : null,
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-07-27T10:00:00.000Z',
  };
}

function session(turns: PlanChangeTurnDto[], targetKeys: string[] = []): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys,
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns,
  };
}

const DELTA: PlanDelta = {
  operations: [
    { op: 'create', kind: 'story', fields: { title: 'Recurring invoices' } },
    { op: 'create', kind: 'subtask', fields: { title: 'Monthly schedule' } },
    { op: 'update', targetKey: 'PAY-21', fields: { title: 'Email reminders' } },
  ],
};

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session([]),
  progress: null,
  delta: null,
  jobId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
};

const handlers = {
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
};

function renderRail(
  state: Partial<PlanChangeConversationState> = {},
  targets: PlanningTarget[] = [],
) {
  const merged = { ...BASE, ...state };
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanDelta(merged.delta)}
      targets={targets}
      {...handlers}
    />,
  );
}

beforeEach(() => {
  // The paywall self-reads the AI entitlement; keep it from hitting the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const fn of Object.values(handlers)) fn.mockReset();
});

describe('PlanChangeRail — empty', () => {
  it('opens with the mode, the context lead and a question — never a blank rail', () => {
    renderRail();

    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan change');
    expect(screen.getByText("Opened to change PayFlow's existing plan.")).toBeTruthy();
    expect(screen.getByText('What should change?')).toBeTruthy();
  });

  it('offers the starter chips, which PREFILL the composer rather than sending', () => {
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'Add work to an epic' }));

    expect(handlers.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox').getAttribute('value')).toBe('Add work to an epic');
  });

  it('sends what was typed and clears the composer', () => {
    renderRail();

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Add recurring invoices to Billing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(handlers.onSend).toHaveBeenCalledWith('Add recurring invoices to Billing.');
    expect(screen.getByRole('textbox').getAttribute('value')).toBe('');
  });
});

describe('PlanChangeRail — MULTI-TURN refinement', () => {
  it('numbers the turns and marks the second one a REFINEMENT of the first', () => {
    renderRail({
      session: session([
        turn(0, 'Add recurring invoices to Billing.'),
        turn(1, 'Split it into monthly and yearly.'),
      ]),
    });

    expect(screen.getByText('turn 1')).toBeTruthy();
    expect(screen.getByText('turn 2 · refine')).toBeTruthy();
    expect(screen.getByText('Add recurring invoices to Billing.')).toBeTruthy();
    expect(screen.getByText('Split it into monthly and yearly.')).toBeTruthy();
  });

  it('renders a submission marker as a thread divider, not as a chat bubble', () => {
    renderRail({
      session: session([
        turn(0, 'Add recurring invoices.'),
        turn(1, 'Add recurring invoices.', 'system'),
      ]),
    });

    expect(screen.getByTestId('plan-change-marker').textContent).toBe('Sent to Motir AI');
    // Only ONE user turn, so no second numbered bubble for the marker.
    expect(screen.queryByText('turn 2')).toBeNull();
  });

  it('hides the starter chips once the conversation has started', () => {
    renderRail({ session: session([turn(0, 'Add recurring invoices.')]) });
    expect(screen.queryByRole('button', { name: 'Add work to an epic' })).toBeNull();
  });
});

describe('PlanChangeRail — the turn shows what it was TARGETED at (MOTIR-1491)', () => {
  it('labels a turn with the THREAD’s anchor set, so the reader sees the scope', () => {
    // The keys come from the SESSION (the server's record of the thread's scope),
    // not from the composer's tray — a sent turn is scoped by where it landed.
    renderRail({
      session: session([turn(0, 'Expand billing.')], ['MOTIR-812', 'MOTIR-918']),
    });

    expect(screen.getByText('Targeting 2 items')).toBeTruthy();
    expect(screen.getAllByTestId('planning-turn-target').map((el) => el.textContent)).toEqual([
      'MOTIR-812',
      'MOTIR-918',
    ]);
  });

  it('says nothing about targets on the PROJECT-wide thread', () => {
    renderRail({ session: session([turn(0, 'Expand billing.')]) });

    expect(screen.queryByTestId('planning-turn-target')).toBeNull();
    expect(screen.queryByText(/Targeting/)).toBeNull();
  });

  it('shows the picked targets as a removable tray above the composer', () => {
    renderRail({}, [
      { id: 'w1', identifier: 'MOTIR-812', title: 'Billing — invoicing', kind: 'story' },
    ]);

    expect(screen.getByTestId('planning-target-tray')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove MOTIR-812' }));
    expect(handlers.onRemoveTarget).toHaveBeenCalledWith('MOTIR-812');
  });
});

describe('PlanChangeRail — streaming', () => {
  it('narrates the run into a polite live region and locks the composer until it settles', () => {
    renderRail({
      phase: 'streaming',
      session: session([turn(0, 'Add recurring invoices.')]),
      progress: { kind: 'proposed', count: 2 },
    });

    const live = screen.getByTestId('plan-change-progress');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toContain('2 items proposed so far…');
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('PlanChangeRail — review', () => {
  it('mirrors the canvas counts and offers approve / discard', () => {
    renderRail({
      phase: 'review',
      session: session([turn(0, 'Add recurring invoices.')]),
      delta: DELTA,
      jobId: 'job-1',
    });

    expect(
      screen.getByText(/2 added, 1 changed — it's on the canvas, nothing is saved yet\./),
    ).toBeTruthy();
    // The lock is SAID, not only drawn on the canvas.
    expect(screen.getByText(/I can't change done work/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(handlers.onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(handlers.onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('PlanChangeRail — after approve', () => {
  it('says what landed and KEEPS the conversation open (a plan change is rarely one change)', () => {
    renderRail({
      session: session([turn(0, 'Add recurring invoices.')]),
      approved: { created: ['PAY-30', 'PAY-31'], updated: ['PAY-21'], unchanged: [] },
    });

    expect(screen.getByText(/Added 2 work items, changed 1 — it's in the plan now/)).toBeTruthy();
    // The composer is still there, enabled — the thread continues.
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('plan-change-review')).toBeNull();
  });
});

describe('PlanChangeRail — error and out of credits are DIFFERENT states', () => {
  it('reports a failure as a recoverable alert with a retry that keeps the thread', () => {
    renderRail({ session: session([turn(0, 'Add recurring invoices.')]), errorCode: 'FAILED' });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Your conversation is saved');
    // The prior turn is STILL on screen — recoverable in place, not restarted.
    expect(screen.getByText('Add recurring invoices.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });

  it('explains an immutable rejection instead of a generic failure', () => {
    renderRail({ session: session([turn(0, 'x')]), errorCode: 'immutable' });
    expect(screen.getByRole('alert').textContent).toContain('already finished');
  });

  it('shows the metered paywall — NOT an error banner — when credits run out', () => {
    renderRail({ session: session([turn(0, 'x')]), outOfCredits: true });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Planning is paused/)).toBeTruthy();
  });
});
