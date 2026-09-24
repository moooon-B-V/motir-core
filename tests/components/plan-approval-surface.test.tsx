// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../helpers/planReview';
import { closeLosesProposal } from '@/lib/planning/planPending';
import { planGateView } from '@/lib/planning/planGateView';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanReviewDto, PlanReviewGateDto } from '@/lib/dto/planReview';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// THE PLANNING SURFACE IS WHERE A PLAN IS DECIDED (Story MOTIR-6012 · MOTIR-6037;
// `design/ai-planning/design-notes.md` Part XX §20.4–§20.6, `plan-review--decide.mock.html`
// Panels 2–7 and 9). The host is rendered with the REAL bar and the REAL rail, so each
// state is asserted on both of the surface's decision places at once — the gate on the
// canvas bar, and its mirror in the rail's review block — and the close guard's veto is
// read off the same render.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const conversation = vi.hoisted(() => ({
  state: null as unknown as PlanChangeConversationState,
  approve: vi.fn(),
  discard: vi.fn(),
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => ({
    state: conversation.state,
    send: vi.fn(),
    retry: vi.fn(),
    correctTurn: vi.fn(),
    approve: conversation.approve,
    discard: conversation.discard,
    dismissError: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: () => <div data-testid="canvas-stub" />,
}));
vi.mock('@/components/planning/AuditCoverageBanner', () => ({
  AuditCoverageBanner: () => null,
}));

const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');
const { parsePlanningOverlay } = await import('@/lib/planning/launcher');

const GATE: PlanReviewGateDto = {
  id: 'gate_1',
  state: 'awaiting',
  stamp: 'stamp_1',
  held: null,
  canDecide: true,
  routedToName: 'Dana Ortiz',
};

function review(gate: Partial<PlanReviewGateDto> | null = {}, over: Partial<PlanReviewDto> = {}) {
  return planReview(
    [
      planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', title: 'Invoices' }),
      planReviewItem({ planItemId: 'pi_2', nodeId: 'pi_2', title: 'Dunning' }),
    ],
    { gate: gate === null ? null : { ...GATE, ...gate }, ...over },
  );
}

function session(): PlanChangeSessionDto {
  return {
    id: 's_41',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-09-23T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-09-23T09:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    turns: [],
    workItemRefs: {},
  };
}

function stateWith(over: Partial<PlanChangeConversationState> = {}): PlanChangeConversationState {
  return {
    phase: 'review',
    session: session(),
    progress: null,
    acts: [],
    review: null,
    decided: null,
    jobId: null,
    planId: 'plan_1',
    approved: null,
    errorCode: null,
    outOfCredits: false,
    stopping: false,
    stopped: false,
    queued: [],
    earlier: null,
    reopened: null,
    readOnly: false,
    ...over,
  };
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  conversation.approve.mockReset().mockResolvedValue(undefined);
  conversation.discard.mockReset().mockResolvedValue(undefined);
  conversation.state = stateWith();
  // The rail's paywall self-reads the AI entitlement; keep it off the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderHost(query = 'plan=project&planFrom=project') {
  const closeGuardRef = { current: null as null | (() => boolean) };
  const onClose = vi.fn();
  const view = renderWithIntl(
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={parsePlanningOverlay(new URLSearchParams(query))!}
      anchorId={null}
      onClose={onClose}
      closeGuardRef={closeGuardRef}
    />,
  );
  return { view, closeGuardRef, onClose };
}

const bar = () => screen.getByTestId('plan-change-confirm-bar');
const block = () => screen.getByTestId('plan-change-review');

describe('READY — Approve and Decline, where the surface already had them (Panel 2)', () => {
  beforeEach(() => {
    conversation.state = stateWith({ review: review() });
  });

  it('the bar and the review block both read Decline · Approve with the consequence line', () => {
    renderHost();
    for (const place of [bar(), block()]) {
      const scope = within(place);
      expect(scope.getByRole('button', { name: 'Approve' })).toBeTruthy();
      expect(scope.getByRole('button', { name: 'Decline' })).toBeTruthy();
      expect(
        scope.getByText(
          'Approving adds these to your backlog. Declining ends the plan and changes nothing.',
        ),
      ).toBeTruthy();
      // The shipped words are for a proposal nobody has been asked about.
      expect(scope.queryByRole('button', { name: 'Discard' })).toBeNull();
      expect(scope.queryByRole('button', { name: /Approve changes/ })).toBeNull();
    }
  });

  it('offers NO Request changes, anywhere on the surface (ADR §11.4)', () => {
    const { view } = renderHost();
    expect(view.container.textContent).not.toMatch(/request changes/i);
    expect(screen.queryByRole('button', { name: /request changes/i })).toBeNull();
  });

  it('Approve asks nothing — one press decides, from either place', () => {
    renderHost();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(block()).getByRole('button', { name: 'Approve' }));
    expect(conversation.approve).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('plan-decline-confirm')).toBeNull();
  });
});

describe('DECLINE asks once, with an OPTIONAL reason (Panel 3)', () => {
  beforeEach(() => {
    conversation.state = stateWith({ review: review() });
  });

  it('on the bar: the band stacks above it and the bar’s verbs step aside', () => {
    renderHost();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Decline' }));

    const band = screen.getByTestId('plan-decline-confirm');
    expect(band.textContent).toContain('Declining this plan will:');
    expect(band.textContent).toContain('End it — it cannot be approved afterwards.');
    expect(band.textContent).toContain('Leave your backlog exactly as it is.');
    expect(band.textContent).toContain('Take it out of To approve.');
    expect(within(bar()).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(conversation.discard).not.toHaveBeenCalled();

    // The field is labelled, described by its helper, and never invalid.
    const field = within(band).getByLabelText('Why are you declining it?');
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(band.textContent).toContain('Optional. It is kept with the decision.');
  });

  it('Yes, decline is live with the field EMPTY — and sends no reason', async () => {
    renderHost();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Decline' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, decline' }));
    });
    expect(conversation.discard).toHaveBeenCalledWith(null);
  });

  it('a reason, when given, travels with the decline', async () => {
    renderHost();
    fireEvent.click(within(block()).getByRole('button', { name: 'Decline' }));
    // In the rail, the band REPLACES the review block's verbs.
    expect(within(block()).getByTestId('plan-decline-confirm')).toBeTruthy();
    expect(within(block()).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.change(within(block()).getByLabelText('Why are you declining it?'), {
      target: { value: 'Reporting waits for next quarter' },
    });
    await act(async () => {
      fireEvent.click(within(block()).getByRole('button', { name: 'Yes, decline' }));
    });
    expect(conversation.discard).toHaveBeenCalledWith('Reporting waits for next quarter');
  });

  it('Cancel takes the band down and decides nothing', () => {
    renderHost();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Decline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('plan-decline-confirm')).toBeNull();
    expect(within(bar()).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(conversation.discard).not.toHaveBeenCalled();
  });
});

describe('HELD — the planner is writing a new version (Panel 4, §11.5c)', () => {
  it('both verbs are DISABLED, not removed, and the reason replaces the consequence line', () => {
    conversation.state = stateWith({
      review: review({ held: { reason: 'revision_in_flight', heldBy: null, expiresAt: 'x' } }),
    });
    renderHost();
    const reason =
      'Motir AI is writing a new version of this plan. Approve and Decline come back when it finishes — it stays in To approve meanwhile.';
    for (const place of [bar(), block()]) {
      const scope = within(place);
      const approve = scope.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
      const decline = scope.getByRole('button', { name: 'Decline' }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      expect(decline.disabled).toBe(true);
      // Described by the held line beside them (§20.9).
      expect(approve.getAttribute('aria-describedby')).toBeTruthy();
      expect(scope.getByText(reason)).toBeTruthy();
      expect(scope.queryByText(/Approving adds these/)).toBeNull();
    }
  });

  it('names the harness when an agent holds the lease', () => {
    conversation.state = stateWith({
      review: review({
        held: { reason: 'revision_in_flight', heldBy: 'Claude Code', expiresAt: 'x' },
      }),
    });
    renderHost();
    expect(within(bar()).getByText(/^Claude Code is writing a new version/)).toBeTruthy();
  });

  it('is held while THIS surface’s own run rewrites the plan in hand — and the hand-off says so', () => {
    conversation.state = stateWith({ phase: 'streaming', review: review(), planId: 'plan_1' });
    renderHost();
    expect(
      (within(bar()).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const handoff = screen.getByTestId('plan-handoff');
    expect(handoff.textContent).toContain('I’m writing a new version of this plan.');
    expect(within(handoff).getByRole('link', { name: 'To approve' }).getAttribute('href')).toBe(
      '/workbench?tab=approvals',
    );
  });

  it('once the lease ends the SAME surface decides again', () => {
    conversation.state = stateWith({
      review: review({ held: { reason: 'revision_in_flight', heldBy: null, expiresAt: 'x' } }),
    });
    const { view } = renderHost();
    conversation.state = stateWith({ review: review() });
    view.rerender(
      <PlanningWorkspaceHost
        projectKey="ACME"
        projectName="Acme"
        launch={parsePlanningOverlay(new URLSearchParams('plan=project&planFrom=project'))!}
        anchorId={null}
        onClose={vi.fn()}
      />,
    );
    expect(
      (within(bar()).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('REFUSED AS STALE — said beside the verbs it refused (Panel 5)', () => {
  const title = 'This plan changed while you were reading it.';

  it('a press from the BAR is answered above the bar, as an alert — not a failure', () => {
    conversation.state = stateWith({ review: review() });
    const { view } = renderHost();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Approve' }));
    conversation.state = stateWith({ review: review({ stamp: 'stamp_2' }), errorCode: 'stale' });
    view.rerender(
      <PlanningWorkspaceHost
        projectKey="ACME"
        projectName="Acme"
        launch={parsePlanningOverlay(new URLSearchParams('plan=project&planFrom=project'))!}
        anchorId={null}
        onClose={vi.fn()}
      />,
    );
    const band = screen.getByTestId('plan-decide-stale');
    expect(band.getAttribute('role')).toBe('alert');
    expect(band.textContent).toContain(title);
    expect(band.textContent).toContain(
      'Nothing was approved or declined. The canvas now shows the new version — look it over, then decide again.',
    );
    // Once: in the bar's column, not in the review block, and not as the rose error.
    expect(screen.getAllByText(title)).toHaveLength(1);
    expect(within(block()).queryByText(title)).toBeNull();
    // The verbs are live against the new stamp.
    expect(
      (within(bar()).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('a press from the REVIEW BLOCK is answered in the review block', () => {
    conversation.state = stateWith({ review: review() });
    const { view } = renderHost();
    fireEvent.click(within(block()).getByRole('button', { name: 'Approve' }));
    conversation.state = stateWith({ review: review(), errorCode: 'stale' });
    view.rerender(
      <PlanningWorkspaceHost
        projectKey="ACME"
        projectName="Acme"
        launch={parsePlanningOverlay(new URLSearchParams('plan=project&planFrom=project'))!}
        anchorId={null}
        onClose={vi.fn()}
      />,
    );
    expect(within(block()).getByRole('alert').textContent).toContain(title);
    expect(within(bar()).queryByText(title)).toBeNull();
  });
});

describe('DECIDED in place (Panel 6)', () => {
  it('declined: the shipped centred marker, and the bar leaves', () => {
    conversation.state = stateWith({ review: review(), decided: 'declined', planId: null });
    renderHost();
    expect(screen.getByTestId('plan-declined-marker').textContent).toBe(
      'You declined this plan. Nothing in your backlog changed, and it has left To approve.',
    );
    expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull();
  });

  it('decided by somebody else first: the shipped refusal, verbatim', () => {
    conversation.state = stateWith({ review: review(), errorCode: 'decided' });
    renderHost();
    expect(within(block()).getByRole('alert').textContent).toBe(
      'Someone decided this a moment ago.',
    );
    expect(
      within(block()).getByText('Your decision was not recorded. Reload to see theirs.'),
    ).toBeTruthy();
  });

  it('an UNASKED plan keeps the shipped failure line for the same refusal', () => {
    conversation.state = stateWith({ review: review(null), errorCode: 'decided' });
    renderHost();
    expect(screen.getByText(/already decided/)).toBeTruthy();
  });
});

describe('SEE BUT NOT DECIDE — no verbs at all (Panel 7)', () => {
  it('names who the question waits on, in both places, with no Approve or Decline', () => {
    conversation.state = stateWith({ review: review({ canDecide: false }) });
    renderHost();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    const lines = screen.getAllByTestId('plan-decide-see-only');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.textContent).toBe(
        'Waiting on Dana Ortiz to approve or decline this plan. Deciding a plan needs permission to decide plans.',
      );
    }
  });

  it('falls back to a generic name when nobody resolves', () => {
    conversation.state = stateWith({ review: review({ canDecide: false, routedToName: null }) });
    renderHost();
    expect(screen.getAllByTestId('plan-decide-see-only')[0]!.textContent).toMatch(
      /^Waiting on someone/,
    );
  });
});

describe('NOT DECIDABLE YET — a planned plan nobody has been asked about', () => {
  it('keeps the shipped words, and the door’s refusal is said in the rail', () => {
    conversation.state = stateWith({ review: review(null), errorCode: 'notDecidable' });
    renderHost();
    expect(within(bar()).getByRole('button', { name: 'Discard' })).toBeTruthy();
    expect(within(bar()).getByRole('button', { name: /Approve changes/ })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('can’t be decided yet');
  });
});

describe('the HAND-OFF before generation (Panel 9)', () => {
  it('when a plan run starts writing, the planner says the reader may leave, and where to come back', () => {
    conversation.state = stateWith({ phase: 'streaming', review: null, planId: 'plan_9' });
    renderHost();
    const handoff = screen.getByTestId('plan-handoff');
    expect(handoff.textContent).toBe(
      'I have what I need — I’m writing the plan now. You don’t have to wait here: close this whenever you like, and the plan will be waiting for you in To approve.',
    );
    expect(within(handoff).getByRole('link', { name: 'To approve' }).getAttribute('href')).toBe(
      '/workbench?tab=approvals',
    );
    // Inside the rail's log (§20.9).
    expect(handoff.closest('[role="log"]')).not.toBeNull();
  });

  it('says nothing for an ASK run — it writes no plan', () => {
    conversation.state = stateWith({ phase: 'streaming', review: null, planId: null });
    renderHost();
    expect(screen.queryByTestId('plan-handoff')).toBeNull();
  });
});

describe('CLOSING raises NO discard guard for a gated or a generating plan (§20.6, §20.11 flag 1)', () => {
  it('an ASKED plan closes straight through, and nothing is discarded', () => {
    conversation.state = stateWith({ review: review() });
    const { closeGuardRef } = renderHost();
    let allowed: boolean | undefined;
    act(() => {
      allowed = closeGuardRef.current?.();
    });
    expect(allowed).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(conversation.discard).not.toHaveBeenCalled();
  });

  it('a plan being WRITTEN closes straight through — the run is a server job', () => {
    conversation.state = stateWith({ phase: 'streaming', review: review(null), planId: 'plan_1' });
    const { closeGuardRef } = renderHost();
    expect(closeGuardRef.current?.()).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('an UNASKED planned proposal still raises the guard', () => {
    conversation.state = stateWith({ review: review(null) });
    const { closeGuardRef } = renderHost();
    let allowed: boolean | undefined;
    act(() => {
      allowed = closeGuardRef.current?.();
    });
    expect(allowed).toBe(false);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('the predicate, case by case', () => {
    const index = { isEmpty: false };
    const base = { phase: 'review' as const, decided: null };
    expect(closeLosesProposal({ ...base, review: review() }, index)).toBe(false);
    expect(closeLosesProposal({ ...base, review: review(null) }, index)).toBe(true);
    expect(
      closeLosesProposal({ ...base, review: review(null, { status: 'generating' }) }, index),
    ).toBe(false);
    expect(closeLosesProposal({ ...base, phase: 'streaming', review: review(null) }, index)).toBe(
      false,
    );
    expect(closeLosesProposal({ ...base, review: null }, index)).toBe(false);
    // A gate that was already decided asks nobody anything — the plain rule applies.
    expect(closeLosesProposal({ ...base, review: review({ state: 'approved' }) }, index)).toBe(
      true,
    );
  });
});

describe('REOPENED FROM TO APPROVE — the row’s `planVia=approvals` (§20.2, §20.5)', () => {
  const reopened = {
    startedBy: { id: 'u1', name: 'Dana Ortiz' },
    mine: true,
    lastActivityAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  };

  it('the rail says it came from To approve', () => {
    conversation.state = stateWith({ review: review(), reopened });
    renderHost('plan=project&planFrom=project&planSession=s_41&planVia=approvals');
    const line = screen.getByTestId('planning-reopened-from-approvals');
    expect(line.textContent).toMatch(/^Reopened from To approve · started by you · last active/);
    expect(screen.queryByTestId('planning-reopened-session')).toBeNull();
  });

  it('names the starter when it is somebody else’s', () => {
    conversation.state = stateWith({ review: review(), reopened: { ...reopened, mine: false } });
    renderHost('plan=project&planFrom=project&planSession=s_41&planVia=approvals');
    expect(screen.getByTestId('planning-reopened-from-approvals').textContent).toMatch(
      /started by Dana Ortiz/,
    );
  });

  it('without it, the Plans-page line is unchanged', () => {
    conversation.state = stateWith({ review: review(), reopened });
    renderHost('plan=project&planFrom=project&planSession=s_41');
    expect(screen.getByTestId('planning-reopened-session')).toBeTruthy();
    expect(screen.queryByTestId('planning-reopened-from-approvals')).toBeNull();
  });
});

describe('planGateView — the one derivation both places read', () => {
  it('is ungated for no review, no gate, or a gate no longer awaiting', () => {
    expect(planGateView({ review: null, rewriting: false })).toEqual({ kind: 'ungated' });
    expect(planGateView({ review: review(null), rewriting: false })).toEqual({ kind: 'ungated' });
    expect(planGateView({ review: review({ state: 'declined' }), rewriting: false })).toEqual({
      kind: 'ungated',
    });
  });

  it('see-only outranks held: a reader who may not decide sees no verbs at all', () => {
    expect(
      planGateView({
        review: review({
          canDecide: false,
          held: { reason: 'revision_in_flight', heldBy: null, expiresAt: 'x' },
        }),
        rewriting: false,
      }),
    ).toEqual({ kind: 'seeOnly', waitingOn: 'Dana Ortiz' });
  });

  it('a gate with no routed name reads as nobody named', () => {
    const r = review({ canDecide: false });
    delete (r.gate as Partial<PlanReviewGateDto>).routedToName;
    expect(planGateView({ review: r, rewriting: false })).toEqual({
      kind: 'seeOnly',
      waitingOn: null,
    });
  });
});
