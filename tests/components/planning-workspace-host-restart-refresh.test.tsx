// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// THE CARRY'S REFRESH WAITS FOR THE ADDRESS (bug MOTIR-8212).
//
// When an ended session is carried into a new one, the host rewrites the
// `planSession` address and refreshes the server-rendered surfaces. The address
// rewrite is itself a router navigation, so a refresh in the same tick overlaps
// it — and under CI load the pair hard-reloaded the page, aborting the carried
// turn's submit. So the refresh must wait until the router has committed the new
// address (the launch names the new session), and fire exactly once then.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const hook = vi.hoisted(() => ({
  state: null as unknown as PlanChangeConversationState,
  onRestarted: null as ((sessionId: string) => void) | null,
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: (opts: { onRestarted?: (sessionId: string) => void }) => {
    hook.onRestarted = opts.onRestarted ?? null;
    return {
      state: hook.state,
      send: vi.fn(),
      retry: vi.fn(),
      correctTurn: vi.fn(),
      approve: vi.fn(),
      discard: vi.fn(),
      dismissError: vi.fn(),
      stop: vi.fn(),
      startCopied: vi.fn(),
      requestRestart: vi.fn(),
      answerRestartConfirm: vi.fn(),
      answerRunPause: vi.fn(),
      planAgain: vi.fn(),
      showEarlierNarration: vi.fn(),
    };
  },
}));
vi.mock('@/components/planning/PlanChangeRail', () => ({
  PlanChangeRail: () => <div data-testid="rail-stub" />,
}));
vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: () => <div data-testid="canvas-stub" />,
}));
vi.mock('@/components/planning/AuditCoverageBanner', () => ({
  AuditCoverageBanner: () => null,
}));

const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');
const { parsePlanningLaunch } = await import('@/lib/planning/launcher');

beforeEach(() => {
  vi.clearAllMocks();
  hook.onRestarted = null;
  hook.state = {
    phase: 'idle',
    turns: [],
    review: null,
    decided: null,
    jobId: null,
    planId: null,
    progress: null,
    errorCode: null,
    approved: null,
    queued: [],
  } as unknown as PlanChangeConversationState;
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function host(sessionId: string | null) {
  const launch = parsePlanningLaunch({ mode: 'replan', from: 'project' });
  return (
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={sessionId ? { ...launch, sessionId } : launch}
      anchorId={null}
      onClose={vi.fn()}
    />
  );
}

describe('PlanningWorkspaceHost — the carry’s refresh waits for the address (MOTIR-8212)', () => {
  it('rewrites the address at once and refreshes only after the router names the new session', () => {
    window.history.replaceState(null, '', '/workbench?planning=replan&planSession=s1');
    const view = renderWithIntl(host('s1'));
    refresh.mockClear();

    act(() => hook.onRestarted?.('s2'));

    expect(new URL(window.location.href).searchParams.get('planSession')).toBe('s2');
    // The address swap is a navigation of its own — no refresh may overlap it.
    expect(refresh).not.toHaveBeenCalled();

    view.rerender(host('s2'));
    expect(refresh).toHaveBeenCalledTimes(1);

    // Settled: a later render naming the same session asks for nothing more.
    view.rerender(host('s2'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes at once when there is no session address to rewrite', () => {
    window.history.replaceState(null, '', '/workbench?planning=replan');
    renderWithIntl(host(null));
    refresh.mockClear();

    act(() => hook.onRestarted?.('s2'));

    expect(new URL(window.location.href).searchParams.has('planSession')).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
