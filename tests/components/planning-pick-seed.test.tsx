// @vitest-environment happy-dom
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanningSeedDTO, PlanningSeedPickDTO } from '@/lib/dto/planningSeed';

// MOTIR-6435 — a PICK's yes STARTS the planning (story MOTIR-6069;
// `docs/decisions/picked-option-planning-starts.md`; design MOTIR-6432 rev. 3).
//
//  · THE RAIL sends the pick's first turn ONCE, as the person's first message,
//    the first moment the conversation is idle and empty — never twice across a
//    StrictMode double effect, a remount or a second open (`claimPickAutoSend`),
//    never on a resume, and a failed send puts the turn back in the composer.
//    It frames the conversation as the FOLLOW-UP to the choice.
//  · THE OVERLAY resolves a pick seed to a forward launch on the anchor, or the
//    project, and hands the host the turn to send — or, with a recent seeded
//    session, that session and nothing to send.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
let params = new URLSearchParams();
let pathname = '/items/ACME-42';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { fetchPlanningAnchor, fetchPlanningSeed, resolveOnboardingRouting } = vi.hoisted(() => ({
  fetchPlanningAnchor: vi.fn(),
  fetchPlanningSeed: vi.fn(),
  resolveOnboardingRouting: vi.fn(),
}));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));
vi.mock('@/lib/planning/planningSeedClient', () => ({ fetchPlanningSeed }));
vi.mock('@/lib/planning/onboardingRoutingClient', () => ({ resolveOnboardingRouting }));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: (key: string) => key === 'project:browse' }),
}));

// The host stands in for itself in the OVERLAY tests: they assert what the
// overlay hands it.
vi.mock('@/components/planning/PlanningWorkspaceHost', () => ({
  PlanningWorkspaceHost: ({
    launch,
    initialDraft,
    autoSendTurn,
    seedGateId,
    followUp,
    sessionIsResume,
  }: {
    launch: { mode: string; from: string; itemKey: string | null; sessionId?: string | null };
    initialDraft?: string;
    autoSendTurn?: string;
    seedGateId?: string | null;
    followUp?: PlanningSeedPickDTO | null;
    sessionIsResume?: boolean;
  }) => {
    const [mountId] = useState(() => Math.random());
    return (
      <div
        data-testid="host"
        data-mount={String(mountId)}
        data-mode={launch.mode}
        data-from={launch.from}
        data-item={launch.itemKey ?? ''}
        data-session={launch.sessionId ?? ''}
        data-resume={String(sessionIsResume ?? false)}
        data-draft={initialDraft ?? ''}
        data-auto-send={autoSendTurn ?? ''}
        data-seed-gate={seedGateId ?? ''}
        data-follow-up={followUp?.choiceKey ?? ''}
      />
    );
  },
}));

const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');
const { PlanChangeRail } = await import('@/components/planning/PlanChangeRail');
const { withPlanningOverlay } = await import('@/lib/planning/launcher');
const { indexPlanReview } = await import('@/lib/planning/planChangeDiff');
const { resetPickAutoSendClaimsForTests } = await import('@/lib/planning/pickAutoSend');
const { renderWithIntl } = await import('../helpers/renderWithIntl');
type ConversationState =
  import('@/lib/hooks/usePlanChangeConversation').PlanChangeConversationState;

const GATE = 'cmpick01';
const TURN = [
  'ACME-42 · Choose where exports live',
  'I just chose an option on this choice — this is the follow-up planning it was waiting for.',
  'The option chosen: Managed object storage\nBest if you want: less to operate',
  'What this choice gates:\nReport exports.',
  'Plan this work with the option chosen.',
].join('\n\n');
const PICK: PlanningSeedPickDTO = {
  choiceKey: 'ACME-42',
  choiceTitle: 'Choose where exports live',
  label: 'Managed object storage',
  bestFor: 'less to operate',
  decidedAt: new Date().toISOString(),
  decidedByLabel: 'Yue',
};
const PICK_SEED: PlanningSeedDTO = {
  gateId: GATE,
  gateKind: 'decision_choice',
  intent: 'plan',
  anchorKey: 'ACME-40',
  firstTurn: TURN,
  seededSessionId: null,
  pick: PICK,
};

// ── THE RAIL ──────────────────────────────────────────────────────────────────

const BASE: ConversationState = {
  phase: 'idle',
  session: null,
  progress: null,
  acts: [],
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
};

function withTurns(bodies: string[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-40'],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-09-26T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-09-26T09:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    turns: bodies.map((body, seq) => ({
      id: `t${seq}`,
      seq,
      role: 'user' as const,
      body,
      jobId: null,
      question: null,
      isAnswer: false,
      intent: null,
      intentCorrected: false,
      citations: [],
      authorId: 'u1',
      createdAt: '2026-09-26T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

const onSend = vi.fn();

function rail(
  state: Partial<ConversationState> = {},
  opts: { itemKey?: string | null; autoSend?: boolean; key?: string } = {},
) {
  const merged = { ...BASE, ...state };
  const itemKey = opts.itemKey === undefined ? 'ACME-40' : opts.itemKey;
  return (
    <PlanChangeRail
      key={opts.key}
      launch={{
        mode: itemKey ? 'contextual' : 'project',
        from: itemKey ? 'work-item' : 'project',
        itemKey,
        repoKey: null,
      }}
      projectName="Acme"
      {...(opts.autoSend === false ? {} : { autoSendTurn: TURN, autoSendKey: GATE })}
      followUp={PICK}
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onSend={onSend}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
    />
  );
}

describe('the rail — a pick’s first turn is SENT once, never pre-filled', () => {
  beforeEach(() => {
    onSend.mockReset();
    resetPickAutoSendClaimsForTests();
  });
  afterEach(cleanup);

  it('sends the turn once when the conversation is idle and empty, and leaves the composer empty', () => {
    renderWithIntl(rail());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(TURN);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('waits while the thread is LOADING, then sends once it is idle', () => {
    const { rerender } = renderWithIntl(rail({ phase: 'loading' }));
    expect(onSend).not.toHaveBeenCalled();
    rerender(rail({ phase: 'idle' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('sends ONCE under a StrictMode double effect', () => {
    renderWithIntl(<StrictMode>{rail()}</StrictMode>);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('sends ONCE across a remount and a second open of the same gate on this page', () => {
    const first = renderWithIntl(rail({}, { key: 'a' }));
    first.unmount();
    renderWithIntl(rail({}, { key: 'b' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('never sends into a conversation that already has a user turn (a resume)', () => {
    renderWithIntl(rail({ session: withTurns([TURN]) }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('never sends for a reader who cannot plan (read-only)', () => {
    renderWithIntl(rail({ readOnly: true }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a FAILED send puts the turn back in the composer, unsent, with nothing lost', () => {
    const { rerender } = renderWithIntl(rail());
    expect(onSend).toHaveBeenCalledTimes(1);
    rerender(rail({ phase: 'idle', errorCode: 'SEED_NOT_APPLICABLE' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(TURN);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('the rail — the FOLLOW-UP framing (design MOTIR-6432)', () => {
  beforeEach(() => {
    onSend.mockReset();
    resetPickAutoSendClaimsForTests();
  });
  afterEach(cleanup);

  it('on a parent anchor: the follow-up chip, the lead naming the choice, the opener line and the card', () => {
    renderWithIntl(rail({ session: withTurns([TURN]) }, { autoSend: false }));
    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('follow-up');
    expect(screen.getByText('Opened to plan the follow-up to ACME-42, on ACME-40.')).toBeTruthy();
    expect(
      screen.getByText(
        'You just chose Managed object storage. Motir AI is planning what it gates.',
      ),
    ).toBeTruthy();
    const card = screen.getByTestId('pick-followup-card');
    expect(card.textContent).toContain('Follow-up to a choice');
    expect(card.textContent).toContain('ACME-42 · Choose where exports live');
    expect(card.textContent).toContain('Managed object storage');
    expect(card.textContent).toContain('less to operate');
    expect(card.textContent).toContain('Chosen by Yue');
    expect(document.body.textContent).not.toMatch(/re-plan|What should change/i);
  });

  it('at the project: the lead names the project', () => {
    renderWithIntl(rail({ session: withTurns([TURN]) }, { itemKey: null, autoSend: false }));
    expect(screen.getByText('Opened on Acme to plan the follow-up to ACME-42.')).toBeTruthy();
  });
});

// ── THE OVERLAY ───────────────────────────────────────────────────────────────

const ADDRESS = withPlanningOverlay('/items/ACME-42', { kind: 'refused-gate', gateId: GATE });
const ANCHOR_40 = {
  anchor: { id: 'wi_40', identifier: 'ACME-40', title: 'Reporting', kind: 'story' as const },
  ancestors: [],
};

function openAt(href: string) {
  const [path, qs = ''] = href.split('?');
  pathname = path!;
  params = new URLSearchParams(qs);
}

function mountOverlay() {
  return renderWithIntl(
    <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
  );
}

describe('the overlay — a pick seed opens FORWARD, with the turn to send', () => {
  beforeEach(() => {
    openAt(ADDRESS);
    fetchPlanningAnchor.mockReset().mockResolvedValue(ANCHOR_40);
    fetchPlanningSeed.mockReset();
    resolveOnboardingRouting.mockReset().mockReturnValue(new Promise(() => {}));
  });
  afterEach(cleanup);

  it('on the PARENT: a contextual work-item launch on ACME-40, the turn to SEND, no draft, the follow-up', async () => {
    fetchPlanningSeed.mockResolvedValue(PICK_SEED);
    mountOverlay();
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('contextual');
    expect(host.getAttribute('data-from')).toBe('work-item');
    expect(host.getAttribute('data-item')).toBe('ACME-40');
    expect(host.getAttribute('data-auto-send')).toBe(TURN);
    expect(host.getAttribute('data-seed-gate')).toBe(GATE);
    expect(host.getAttribute('data-draft')).toBe('');
    expect(host.getAttribute('data-follow-up')).toBe('ACME-42');
  });

  it('at the PROJECT: a project launch with the turn to send, no anchor read', async () => {
    fetchPlanningSeed.mockResolvedValue({ ...PICK_SEED, anchorKey: null });
    mountOverlay();
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('project');
    expect(host.getAttribute('data-item')).toBe('');
    expect(host.getAttribute('data-auto-send')).toBe(TURN);
    expect(host.getAttribute('data-follow-up')).toBe('ACME-42');
    expect(fetchPlanningAnchor).not.toHaveBeenCalled();
  });

  it('with a recent pick session: RESUMES it, sends nothing, keeps the follow-up framing', async () => {
    fetchPlanningSeed.mockResolvedValue({ ...PICK_SEED, seededSessionId: 's9' });
    mountOverlay();
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-session')).toBe('s9');
    expect(host.getAttribute('data-resume')).toBe('true');
    expect(host.getAttribute('data-auto-send')).toBe('');
    expect(host.getAttribute('data-draft')).toBe('');
    expect(host.getAttribute('data-follow-up')).toBe('ACME-42');
  });

  it('a REFUSAL seed is unchanged: a re-plan on its card with the turn PRE-FILLED, nothing sent', async () => {
    fetchPlanningSeed.mockResolvedValue({
      gateId: GATE,
      gateKind: 'decision_choice',
      intent: 'replan',
      anchorKey: 'ACME-42',
      firstTurn: 'ACME-42 · Choose where exports live\n\nNone of the options…',
      seededSessionId: null,
    });
    fetchPlanningAnchor.mockResolvedValue({
      anchor: { id: 'wi_42', identifier: 'ACME-42', title: 'Choose', kind: 'subtask' as const },
      ancestors: [],
    });
    mountOverlay();
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('replan');
    expect(host.getAttribute('data-item')).toBe('ACME-42');
    expect(host.getAttribute('data-draft')).toContain('None of the options');
    expect(host.getAttribute('data-auto-send')).toBe('');
    expect(host.getAttribute('data-follow-up')).toBe('');
  });
});
