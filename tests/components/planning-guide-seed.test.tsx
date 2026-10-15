// @vitest-environment happy-dom
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanningGuideSeedDTO, PlanningSeedGuideDTO } from '@/lib/dto/planningSeed';

// MOTIR-8693 — the planning overlay STARTS from a guide's re-plan offer (Story
// MOTIR-8684; design MOTIR-8686 sheet 9). Three halves, transport mocked:
//
//   · THE HOOK sends the guide's request once with `seedGuideTurnId`, never after a
//     session, and answers the offer's three refusals without a retry;
//   · THE RAIL frames the conversation as *from a guide* and sends the turn once;
//   · THE OVERLAY reads the seed in the skeleton window, resolves it to a launch on the
//     target with the guided card joining the scope, and falls back silently.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
let params = new URLSearchParams();
let pathname = '/items/ACME-31';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { fetchPlanningAnchor, fetchGuidePlanningSeed, resolveOnboardingRouting } = vi.hoisted(
  () => ({
    fetchPlanningAnchor: vi.fn(),
    fetchGuidePlanningSeed: vi.fn(),
    resolveOnboardingRouting: vi.fn(),
  }),
);
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));
vi.mock('@/lib/planning/planningSeedClient', () => ({
  fetchPlanningSeed: vi.fn(),
  fetchGuidePlanningSeed,
}));
vi.mock('@/lib/planning/onboardingRoutingClient', () => ({ resolveOnboardingRouting }));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: (key: string) => key === 'project:browse' }),
}));

const { resume, getNamed, resumeAnchored, submitAnchored, streamAnchored } = vi.hoisted(() => ({
  resume: vi.fn(),
  getNamed: vi.fn(),
  resumeAnchored: vi.fn(),
  submitAnchored: vi.fn(),
  streamAnchored: vi.fn(),
}));
vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: resume,
  getPlanChangeSession: getNamed,
  resumeContextualSession: resumeAnchored,
  submitContextualPlan: submitAnchored,
}));
vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return { ...actual, streamContextualPlanJob: streamAnchored };
});

// The host stands in for itself in the OVERLAY tests: they assert what the overlay
// hands it.
vi.mock('@/components/planning/PlanningWorkspaceHost', () => ({
  PlanningWorkspaceHost: ({
    launch,
    initialDraft,
    autoSendTurn,
    autoSendKey,
    seedGateId,
    seedGuideTurnId,
    guideOrigin,
    extraInitialTargets,
    sessionIsResume,
  }: {
    launch: { mode: string; from: string; itemKey: string | null; sessionId?: string | null };
    initialDraft?: string;
    autoSendTurn?: string;
    autoSendKey?: string | null;
    seedGateId?: string | null;
    seedGuideTurnId?: string | null;
    guideOrigin?: PlanningSeedGuideDTO | null;
    extraInitialTargets?: { identifier: string }[];
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
        data-auto-key={autoSendKey ?? ''}
        data-seed-gate={seedGateId ?? ''}
        data-seed-guide={seedGuideTurnId ?? ''}
        data-guided={guideOrigin?.guidedKey ?? ''}
        data-extra={(extraInitialTargets ?? []).map((t) => t.identifier).join(',')}
      />
    );
  },
}));

import {
  GUIDE_OFFER_CLOSED,
  usePlanChangeConversation,
  type PlanChangeConversationState,
} from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { PlanningWorkspaceOverlay } from '@/components/planning/PlanningWorkspaceOverlay';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { resetPickAutoSendClaimsForTests } from '@/lib/planning/pickAutoSend';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { renderWithIntl } from '../helpers/renderWithIntl';

const OFFER = 't1';
const REQUEST = '## Re-plan ACME-12\n\n- the “export” step is wrong\n\n  日本語 · déjà vu';
const GUIDE: PlanningSeedGuideDTO = {
  guidedKey: 'ACME-31',
  guidedTitle: 'Publish the export',
  targetResolution: 'as_asked',
  confirmedAt: null,
};
const SEED: PlanningGuideSeedDTO = {
  source: 'guide',
  guideTurnId: OFFER,
  intent: 'plan',
  anchorKey: 'ACME-12',
  firstTurn: REQUEST,
  offerState: 'undecided',
  seededSessionId: null,
  seededSessionOpen: false,
  guide: GUIDE,
};

// ── THE HOOK ─────────────────────────────────────────────────────────────────

const TARGET: PlanningTarget = {
  id: 'wi_12',
  identifier: 'ACME-12',
  title: 'Exports',
  kind: 'story',
};
const GUIDED: PlanningTarget = {
  id: 'wi_31',
  identifier: 'ACME-31',
  title: 'Publish',
  kind: 'task',
};

function session(
  bodies: string[],
  extra: Partial<PlanChangeSessionDto> = {},
): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-12'],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-15T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-10-15T09:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
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
      createdAt: '2026-10-15T10:00:00.000Z',
    })),
    workItemRefs: {},
    ...extra,
  };
}

describe('the hook — a GUIDE-seeded first turn', () => {
  beforeEach(() => {
    for (const m of [resume, getNamed, resumeAnchored, submitAnchored, streamAnchored])
      m.mockReset();
  });
  afterEach(cleanup);

  it('opens EMPTY: no resumable read, no named read, nothing written until the send', async () => {
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_12', seedGuideTurnId: OFFER }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.session).toBeNull();
    expect(resumeAnchored).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(getNamed).not.toHaveBeenCalled();
    expect(submitAnchored).not.toHaveBeenCalled();
  });

  it('the FIRST send carries the offer and both targets, byte for byte; the next carries none', async () => {
    submitAnchored.mockResolvedValue({ jobId: 'j1', sessionId: 's1', session: session([REQUEST]) });
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_12', seedGuideTurnId: OFFER }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    await act(async () => {
      await result.current.send(REQUEST, [TARGET, GUIDED]);
    });
    expect(submitAnchored).toHaveBeenCalledTimes(1);
    expect(submitAnchored).toHaveBeenLastCalledWith(
      'wi_12',
      REQUEST,
      ['ACME-31'],
      expect.anything(),
      false,
      null,
      null,
      OFFER,
    );
    await waitFor(() => expect(result.current.state.session?.id).toBe('s1'));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    await act(async () => {
      await result.current.send('And keep the audit log.', [TARGET, GUIDED]);
    });
    expect(submitAnchored.mock.calls[1]).toEqual([
      'wi_12',
      'And keep the audit log.',
      ['ACME-31'],
      expect.anything(),
      false,
      's1',
    ]);
  });

  it('409 GUIDE_REPLAN_OFFER_CONFIRMED tells the caller the session, sends nothing more, draws no error', async () => {
    submitAnchored.mockRejectedValue(
      new PlanEditsClientError(409, 'GUIDE_REPLAN_OFFER_CONFIRMED', { sessionId: 's9' }),
    );
    const onConfirmed = vi.fn();
    const { result } = renderHook(() =>
      usePlanChangeConversation({
        anchorId: 'wi_12',
        seedGuideTurnId: OFFER,
        onGuideOfferConfirmed: onConfirmed,
      }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    await act(async () => {
      await result.current.send(REQUEST, [TARGET]);
    });
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith('s9');
    expect(submitAnchored).toHaveBeenCalledTimes(1);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.session).toBeNull();
  });

  it.each([
    [409, 'GUIDE_REPLAN_OFFER_NOT_OPEN'],
    [422, 'SEED_NOT_APPLICABLE'],
  ])('%s %s ends the send as "offer closed": no turn, no retry', async (status, code) => {
    submitAnchored.mockRejectedValue(new PlanEditsClientError(status, code));
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_12', seedGuideTurnId: OFFER }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    await act(async () => {
      await result.current.send(REQUEST, [TARGET]);
    });
    expect(result.current.state.errorCode).toBe(GUIDE_OFFER_CLOSED);
    expect(result.current.state.session).toBeNull();
    expect(submitAnchored).toHaveBeenCalledTimes(1);
  });

  it('out of credits is the shipped paywall state, with no retry', async () => {
    submitAnchored.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_12', seedGuideTurnId: OFFER }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    await act(async () => {
      await result.current.send(REQUEST, [TARGET]);
    });
    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
    expect(submitAnchored).toHaveBeenCalledTimes(1);
  });

  it('an outage keeps the seed for the next send', async () => {
    submitAnchored.mockRejectedValueOnce(new PlanEditsClientError(500, null));
    submitAnchored.mockResolvedValue({ jobId: 'j', sessionId: 's1', session: session([REQUEST]) });
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_12', seedGuideTurnId: OFFER }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    await act(async () => {
      await result.current.send(REQUEST, [TARGET]);
    });
    await act(async () => {
      await result.current.send(REQUEST, [TARGET]);
    });
    expect(submitAnchored.mock.calls.map((c) => c[7])).toEqual([OFFER, OFFER]);
  });
});

// ── THE RAIL ─────────────────────────────────────────────────────────────────

const BASE: PlanChangeConversationState = {
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
const onSend = vi.fn();

function rail(state: Partial<PlanChangeConversationState> = {}, opts: { key?: string } = {}) {
  const merged = { ...BASE, ...state };
  return (
    <PlanChangeRail
      key={opts.key}
      launch={{ mode: 'contextual', from: 'work-item', itemKey: 'ACME-12', repoKey: null }}
      projectName="Acme"
      autoSendTurn={REQUEST}
      autoSendKey={`guide:${OFFER}`}
      guideOrigin={GUIDE}
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

describe('the rail — the FROM A GUIDE framing', () => {
  beforeEach(() => {
    onSend.mockReset();
    resetPickAutoSendClaimsForTests();
  });
  afterEach(cleanup);

  it('sends the request once, leaves the composer empty, and survives a remount and StrictMode', () => {
    const first = renderWithIntl(<StrictMode>{rail({}, { key: 'a' })}</StrictMode>);
    expect(onSend).toHaveBeenCalledExactlyOnceWith(REQUEST);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    first.unmount();
    renderWithIntl(rail({}, { key: 'b' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('draws the chip, the lead and the card with the guided card’s key and title', () => {
    renderWithIntl(rail({ session: session([REQUEST]) }));
    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('from a guide');
    expect(screen.getByText('Opened on ACME-12 from Motir AI’s guide on ACME-31.')).toBeTruthy();
    const card = screen.getByTestId('guide-origin-card');
    expect(card.textContent).toContain('From a guide');
    expect(card.textContent).toContain('ACME-31 · Publish the export');
    expect(card.textContent).toContain('Planning');
    expect(card.textContent).toMatch(/Confirmed by you/);
    expect(document.body.textContent).not.toMatch(/re-plan this|What should change/i);
  });

  it('a session already holding a user turn (a reopen) sends nothing but keeps the framing', () => {
    renderWithIntl(rail({ session: session([REQUEST]) }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('guide-origin-card')).toBeTruthy();
  });

  it('says the offer is no longer open, in place, with nothing to retry', () => {
    renderWithIntl(rail({ errorCode: GUIDE_OFFER_CLOSED }));
    expect(screen.getByRole('alert').textContent).toBe(
      'This re-plan offer is no longer open. Go back to the guide to see where it stands.',
    );
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });
});

// ── THE OVERLAY ──────────────────────────────────────────────────────────────

const ADDRESS = withPlanningOverlay('/items/ACME-31', { kind: 'guide-offer', guideTurnId: OFFER });
const ANCHOR_12 = {
  anchor: { id: 'wi_12', identifier: 'ACME-12', title: 'Exports', kind: 'story' as const },
  ancestors: [],
  hasChildren: true,
};
const ANCHOR_31 = {
  anchor: {
    id: 'wi_31',
    identifier: 'ACME-31',
    title: 'Publish the export',
    kind: 'task' as const,
  },
  ancestors: [],
  hasChildren: false,
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

describe('the overlay — a guide offer opens on its target with the request to send', () => {
  beforeEach(() => {
    openAt(ADDRESS);
    fetchPlanningAnchor
      .mockReset()
      .mockImplementation(async (key: string) => (key === 'ACME-31' ? ANCHOR_31 : ANCHOR_12));
    fetchGuidePlanningSeed.mockReset();
    resolveOnboardingRouting.mockReset().mockReturnValue(new Promise(() => {}));
    shallowPush.mockReset();
  });
  afterEach(cleanup);

  it('holds the skeleton until the seed settles, then mounts the host on the target, once', async () => {
    let release: (seed: PlanningGuideSeedDTO) => void = () => {};
    fetchGuidePlanningSeed.mockReturnValue(new Promise((r) => (release = r)));
    mountOverlay();
    await act(async () => {});
    expect(screen.queryByTestId('host')).toBeNull();
    await act(async () => release(SEED));
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('contextual');
    expect(host.getAttribute('data-from')).toBe('work-item');
    expect(host.getAttribute('data-item')).toBe('ACME-12');
    expect(host.getAttribute('data-auto-send')).toBe(REQUEST);
    expect(host.getAttribute('data-auto-key')).toBe(`guide:${OFFER}`);
    expect(host.getAttribute('data-seed-guide')).toBe(OFFER);
    expect(host.getAttribute('data-seed-gate')).toBe('');
    expect(host.getAttribute('data-draft')).toBe('');
    expect(host.getAttribute('data-guided')).toBe('ACME-31');
    // The guided card joins the scope beside the target.
    expect(host.getAttribute('data-extra')).toBe('ACME-31');
    expect(fetchGuidePlanningSeed).toHaveBeenCalledTimes(1);
    expect(fetchGuidePlanningSeed.mock.calls[0]![0]).toBe(OFFER);
  });

  it('when the guided card IS the target, it is in the scope once', async () => {
    fetchGuidePlanningSeed.mockResolvedValue({ ...SEED, anchorKey: 'ACME-31' });
    fetchPlanningAnchor.mockResolvedValue(ANCHOR_31);
    mountOverlay();
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-item')).toBe('ACME-31');
    expect(host.getAttribute('data-extra')).toBe('');
  });

  it('a seed with a session is a named reopen: that session, nothing sent, framing kept', async () => {
    fetchGuidePlanningSeed.mockResolvedValue({
      ...SEED,
      offerState: 'confirmed',
      seededSessionId: 's9',
      seededSessionOpen: true,
      guide: { ...GUIDE, confirmedAt: new Date().toISOString() },
    });
    mountOverlay();
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-session')).toBe('s9');
    expect(host.getAttribute('data-resume')).toBe('true');
    expect(host.getAttribute('data-auto-send')).toBe('');
    expect(host.getAttribute('data-seed-guide')).toBe('');
    expect(host.getAttribute('data-guided')).toBe('ACME-31');
  });

  it('a null seed opens the plain project workspace and sends nothing', async () => {
    fetchGuidePlanningSeed.mockResolvedValue(null);
    mountOverlay();
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('project');
    expect(host.getAttribute('data-item')).toBe('');
    expect(host.getAttribute('data-auto-send')).toBe('');
    expect(host.getAttribute('data-guided')).toBe('');
    expect(document.body.textContent).not.toMatch(/offer/i);
  });

  it('a FAILED seed read is the same silent project workspace', async () => {
    fetchGuidePlanningSeed.mockRejectedValue(new Error('boom'));
    mountOverlay();
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('project');
    expect(host.getAttribute('data-auto-send')).toBe('');
    expect(document.body.textContent).not.toMatch(/offer|boom/i);
  });

  it('a target the viewer cannot see sends nothing', async () => {
    fetchGuidePlanningSeed.mockResolvedValue(SEED);
    fetchPlanningAnchor.mockImplementation(async (key: string) =>
      key === 'ACME-31' ? ANCHOR_31 : null,
    );
    mountOverlay();
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-auto-send')).toBe('');
  });

  it('an address with no offer id opens the plain project workspace', async () => {
    openAt('/items/ACME-31?plan=contextual&planFrom=guide-offer');
    mountOverlay();
    await act(async () => {});
    expect(fetchGuidePlanningSeed).not.toHaveBeenCalled();
    expect(screen.getByTestId('host').getAttribute('data-mode')).toBe('project');
  });

  it('opening the same address twice reads the seed on each open and sends nothing it already claimed', async () => {
    fetchGuidePlanningSeed.mockResolvedValue(SEED);
    const first = mountOverlay();
    await act(async () => {});
    first.unmount();
    mountOverlay();
    await act(async () => {});
    // The overlay hands the SAME claim key both times; the rail's claim (tested above)
    // is what keeps the second from sending.
    expect(screen.getByTestId('host').getAttribute('data-auto-key')).toBe(`guide:${OFFER}`);
  });
});
