// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import type { RefObject } from 'react';
import type { PlanSessionListPageDto } from '@/lib/dto/planSessions';

// Story MOTIR-9218 · MOTIR-9308 — a History row OPENS its conversation inside the
// overlay. The overlay re-addresses itself to the shipped named reopen
// (`planSession=<id>`) with ONE `shallowPush` — a work-item origin on the row's
// first key, else the project origin, never `planVia` — after asking the same
// close guard a Close asks. A veto parks the switch until the guard's answer: its
// Discard/Confirm completes it, Keep planning drops it. The section's expanded
// flag and rows live above the host, so the remount an anchor change causes keeps
// them. The row of the conversation already shown opens nothing (the rail).
//
// The host is a stand-in exposing the props the overlay hands it; the conversation
// itself (open, read-only ended, the carry) is the shipped reopen's and is driven
// end to end by the integration test and the E2E.

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
let params = new URLSearchParams();
let pathname = '/plans';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));
vi.mock('@/lib/planning/planningSeedClient', () => ({ fetchPlanningSeed: vi.fn() }));
vi.mock('@/lib/planning/onboardingRoutingClient', () => ({
  resolveOnboardingRouting: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: (key: string) => key === 'project:browse' }),
}));

type HostProps = {
  launch: { mode: string; from: string; itemKey: string | null; sessionId?: string | null };
  onClose: () => void;
  closeGuardRef?: RefObject<(() => boolean) | null>;
  onKeepPlanningAfterBack?: () => void;
  onOpenSession?: (sessionId: string, targetKeys: readonly string[]) => void;
};

// The overlay owns the ref it hands the host; the stand-in host does not install a
// predicate, so the test writes one through the same ref the overlay reads.
const guard = vi.hoisted(() => ({ ref: null as { current: (() => boolean) | null } | null }));
function installGuard(fn: () => boolean) {
  if (!guard.ref) throw new Error('no guard ref captured');
  guard.ref.current = fn;
}

vi.mock('@/components/planning/PlanningWorkspaceHost', async () => {
  const { useState: useStateInMock } = await import('react');
  const { PlanHistorySection } = await import('@/components/planning/PlanHistorySection');
  return {
    PlanningWorkspaceHost: (props: HostProps) => {
      const [mountId] = useStateInMock(() => Math.random());
      guard.ref = (props.closeGuardRef as { current: (() => boolean) | null } | undefined) ?? null;
      return (
        <div
          data-testid="host"
          data-mount={String(mountId)}
          data-from={props.launch.from}
          data-item={props.launch.itemKey ?? ''}
          data-session={props.launch.sessionId ?? ''}
        >
          <PlanHistorySection
            currentSessionId={props.launch.sessionId ?? null}
            onOpenSession={(id, keys) => props.onOpenSession?.(id, keys)}
          />
          <button type="button" onClick={() => props.onClose()}>
            guard-answered-close
          </button>
          <button type="button" onClick={() => props.onKeepPlanningAfterBack?.()}>
            guard-keep-planning
          </button>
        </div>
      );
    },
  };
});

const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');
const { PlanChangeRail } = await import('@/components/planning/PlanChangeRail');
const { withPlanningOverlay, parsePlanningOverlay } = await import('@/lib/planning/launcher');
const { indexPlanReview } = await import('@/lib/planning/planChangeDiff');
const { renderWithIntl } = await import('../helpers/renderWithIntl');
type ConversationState =
  import('@/lib/hooks/usePlanChangeConversation').PlanChangeConversationState;

const NOW = new Date('2026-10-22T12:00:00.000Z');

const HISTORY: PlanSessionListPageDto = {
  sessions: [
    {
      id: 'sA',
      origin: 'conversation',
      targetKeys: [],
      lastActivityAt: NOW.toISOString(),
      startedBy: { id: 'u1', name: 'Yue' },
      firstTurn: 'Why is ACME-1 blocked?',
      latestPlan: null,
      planCount: 0,
      state: 'none',
      failure: null,
      endedAt: null,
      endReason: null,
      endedBy: null,
      copiedFrom: null,
      seed: null,
    },
    {
      id: 'sB',
      origin: 'conversation',
      targetKeys: ['ACME-7', 'ACME-8'],
      lastActivityAt: NOW.toISOString(),
      startedBy: { id: 'u1', name: 'Yue' },
      firstTurn: 'What does the webhook retry on?',
      latestPlan: null,
      planCount: 0,
      state: 'closed',
      failure: null,
      endedAt: NOW.toISOString(),
      endReason: 'idle',
      endedBy: null,
      copiedFrom: null,
      seed: null,
    },
  ] as PlanSessionListPageDto['sessions'],
  nextCursor: null,
  scope: 'mine',
};

const fetchMock = vi.fn(async (url: string) =>
  String(url).includes('/sessions/history')
    ? new Response(JSON.stringify(HISTORY), { status: 200 })
    : new Response('{}', { status: 404 }),
);
const historyCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes('/sessions/history')).length;

function openAt(href: string) {
  const [path, qs = ''] = href.split('?');
  pathname = path!;
  params = new URLSearchParams(qs);
}

/** The address the last `shallowPush` wrote, parsed back as the overlay reads it. */
function lastPushed() {
  const href = String(shallowPush.mock.calls.at(-1)![0]);
  const qs = new URLSearchParams(href.split('?')[1] ?? '');
  return { href, qs, launch: parsePlanningOverlay(qs) };
}

function mountOverlay() {
  return renderWithIntl(
    <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    { now: NOW },
  );
}

async function expandHistory() {
  fireEvent.click(screen.getByTestId('planning-history-toggle'));
  await act(async () => {});
}

function rowFor(id: string) {
  return screen
    .getAllByTestId('planning-history-row')
    .find((r) => r.getAttribute('data-session-id') === id)!;
}

beforeEach(() => {
  shallowPush.mockReset();
  fetchMock.mockClear();
  fetchPlanningAnchor.mockReset().mockResolvedValue({
    anchor: { id: 'wi_7', identifier: 'ACME-7', title: 'Webhooks', kind: 'story' as const },
    ancestors: [],
    hasChildren: false,
  });
  vi.stubGlobal('fetch', fetchMock);
  openAt(withPlanningOverlay('/plans', { kind: 'project', sessionId: 'sA' }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('opening a row', () => {
  it('an unanchored row writes the project origin with planSession and no planVia', async () => {
    openAt(withPlanningOverlay('/plans', { kind: 'project', sessionId: 'sB' }));
    mountOverlay();
    await expandHistory();
    fireEvent.click(rowFor('sA'));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    const { href, qs, launch } = lastPushed();
    expect(href.startsWith('/plans?')).toBe(true);
    expect(launch).toMatchObject({ mode: 'project', from: 'project', sessionId: 'sA' });
    expect(qs.has('planVia')).toBe(false);
  });

  it('an anchored row writes the work-item origin on its FIRST key', async () => {
    mountOverlay();
    await expandHistory();
    fireEvent.click(rowFor('sB'));
    const { qs, launch } = lastPushed();
    expect(launch).toMatchObject({ from: 'work-item', itemKey: 'ACME-7', sessionId: 'sB' });
    expect(qs.get('planItem')).toBe('ACME-7');
    expect(qs.get('planSession')).toBe('sB');
    expect(qs.has('planVia')).toBe(false);
  });

  it('switches with a history entry (push, never replace), so Back returns', async () => {
    const { shallowReplace } = await import('@/lib/navigation/shallowUrl');
    mountOverlay();
    await expandHistory();
    fireEvent.click(rowFor('sB'));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowReplace).not.toHaveBeenCalled();
  });
});

describe('the section survives the switch', () => {
  it('a remount on a new anchor keeps it expanded with its rows, with no new request', async () => {
    const view = mountOverlay();
    await expandHistory();
    expect(historyCalls()).toBe(1);
    const before = screen.getByTestId('host').getAttribute('data-mount');
    fireEvent.click(rowFor('sB'));
    openAt(lastPushed().href);
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mount')).not.toBe(before);
    expect(host.getAttribute('data-session')).toBe('sB');
    expect(screen.getByTestId('planning-history-toggle').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(rowFor('sB').getAttribute('aria-current')).toBe('true');
    expect(rowFor('sA').getAttribute('aria-current')).toBeNull();
    expect(historyCalls()).toBe(1);
  });
});

describe('the close guard', () => {
  it('a veto stops the switch; the guard’s close answer then makes it', async () => {
    mountOverlay();
    await expandHistory();
    // Stand in for the host's predicate: a pending proposal raises the guard.
    let raised = 0;
    let bypass = false;
    const guard = () => {
      if (bypass) return true;
      raised += 1;
      return false;
    };
    installGuard(guard);
    fireEvent.click(rowFor('sB'));
    expect(raised).toBe(1);
    expect(shallowPush).not.toHaveBeenCalled();
    bypass = true;
    fireEvent.click(screen.getByText('guard-answered-close'));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(lastPushed().launch).toMatchObject({ itemKey: 'ACME-7', sessionId: 'sB' });
  });

  it('Keep planning drops the parked switch: a later close closes', async () => {
    mountOverlay();
    await expandHistory();
    let bypass = false;
    installGuard(() => bypass);
    fireEvent.click(rowFor('sB'));
    fireEvent.click(screen.getByText('guard-keep-planning'));
    bypass = true;
    fireEvent.click(screen.getByText('guard-answered-close'));
    expect(lastPushed().launch).toBeNull();
  });
});

// ── the rail: the row already shown opens nothing ──────────────────────────────

const BASE = {
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
} as unknown as ConversationState;

describe('the rail', () => {
  it('opens another row, and not the one already shown', async () => {
    const onOpenSession = vi.fn();
    const state = {
      ...BASE,
      session: { id: 'sA', turns: [], targetKeys: [] },
    } as unknown as ConversationState;
    renderWithIntl(
      <PlanChangeRail
        launch={{ mode: 'project', from: 'project', itemKey: null }}
        projectName="Acme"
        state={state}
        index={indexPlanReview(null)}
        targets={[]}
        onAddTarget={vi.fn()}
        onRemoveTarget={vi.fn()}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onCorrectTurn={vi.fn()}
        onApprove={vi.fn()}
        onDiscard={vi.fn()}
        onOpenSession={onOpenSession}
      />,
      { now: NOW },
    );
    await expandHistory();
    fireEvent.click(rowFor('sA'));
    expect(onOpenSession).not.toHaveBeenCalled();
    fireEvent.click(rowFor('sB'));
    expect(onOpenSession).toHaveBeenCalledWith('sB', ['ACME-7', 'ACME-8']);
  });
});
