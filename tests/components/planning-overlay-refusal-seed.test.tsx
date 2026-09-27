// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import type { PlanningSeedDTO } from '@/lib/dto/planningSeed';

// MOTIR-6210 — the planning OVERLAY resolves a `refused-gate` launch (story
// MOTIR-6068; design MOTIR-6206 sheets 2–8). What this file holds in place:
//
//   · while the seed is read, the ONE skeleton window shows — no composer, no
//     re-plan placeholder, no host (sheet 6);
//   · a seed with no seeded session opens a `work-item` re-plan on the refused
//     card, through the SAME anchor read, with the turn as the host's draft;
//   · a seed WITH one opens that session as a RESUME, with no draft (sheet 7);
//   · a 404 or any failure opens a plain PROJECT launch — no draft, no error,
//     no gate id and no reason anywhere in the DOM (sheet 8).

let params = new URLSearchParams();
let pathname = '/items/ACME-44';
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

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

// The host stands in for itself: every assertion is about what the OVERLAY hands
// it. A per-MOUNT id (seeded once, like the real host's props) proves the host
// mounts ONCE, with the draft already in its first render.
let mountSeq = 0;
const firstRenderDraft: (string | undefined)[] = [];
vi.mock('@/components/planning/PlanningWorkspaceHost', () => ({
  PlanningWorkspaceHost: ({
    launch,
    anchorId,
    initialTarget,
    initialDraft,
    seedGateId,
    sessionIsResume,
    onClose,
  }: {
    launch: {
      mode: string;
      from: string;
      itemKey: string | null;
      sessionId?: string | null;
      gateId?: string;
    };
    anchorId: string | null;
    initialTarget?: { identifier: string } | null;
    initialDraft?: string;
    seedGateId?: string | null;
    sessionIsResume?: boolean;
    onClose?: () => void;
  }) => {
    const [mountId] = useState(() => {
      firstRenderDraft.push(initialDraft);
      return ++mountSeq;
    });
    return (
      <div
        data-testid="host"
        data-mount={String(mountId)}
        data-mode={launch.mode}
        data-from={launch.from}
        data-item={launch.itemKey ?? ''}
        data-session={launch.sessionId ?? ''}
        data-anchor-id={anchorId ?? ''}
        data-target={initialTarget?.identifier ?? ''}
        data-resume={String(sessionIsResume ?? false)}
        {...(seedGateId ? { 'data-seed-gate': seedGateId } : {})}
        {...('gateId' in launch ? { 'data-launch-gate': String(launch.gateId) } : {})}
      >
        {initialDraft ? <textarea readOnly aria-label="composer" value={initialDraft} /> : null}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    );
  },
}));

const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');

const GATE = 'cmg7k2q0';
const REASON = 'Keep the download page for large files — only the retention rule should change.';
const FIRST_TURN = `ACME-44 · Where exports live\n\nChanges were requested on this decision.\n\nThe reason given:\n“${REASON}”\n\nRe-plan this work item from that reason.`;
const SEED: PlanningSeedDTO = {
  gateId: GATE,
  gateKind: 'decision_approval',
  intent: 'replan',
  anchorKey: 'ACME-44',
  firstTurn: FIRST_TURN,
  seededSessionId: null,
};
const ANCHOR = {
  anchor: {
    id: 'wi_44',
    identifier: 'ACME-44',
    title: 'Where exports live',
    kind: 'story' as const,
  },
  ancestors: [{ id: 'wi_1', identifier: 'ACME-1', title: 'Exports' }],
};
const SEEDED_ADDRESS = withPlanningOverlay('/items/ACME-44', {
  kind: 'refused-gate',
  gateId: GATE,
});

function openAt(href: string) {
  const [path, qs = ''] = href.split('?');
  pathname = path!;
  params = new URLSearchParams(qs);
}

function mount() {
  return render(<PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />);
}

beforeEach(() => {
  openAt('/items/ACME-44');
  push.mockReset();
  shallowPush.mockReset();
  fetchPlanningAnchor.mockReset().mockResolvedValue(ANCHOR);
  fetchPlanningSeed.mockReset().mockResolvedValue(SEED);
  resolveOnboardingRouting.mockReset().mockReturnValue(new Promise(() => {}));
  mountSeq = 0;
  firstRenderDraft.length = 0;
});
afterEach(cleanup);

describe('LOADING — the seed read sits in the one skeleton window (sheet 6)', () => {
  it('shows the skeleton while the read is pending: no host, no textbox, no re-plan placeholder', async () => {
    fetchPlanningSeed.mockReturnValue(new Promise(() => {}));
    openAt(SEEDED_ADDRESS);
    mount();
    await act(async () => {});

    expect(fetchPlanningSeed).toHaveBeenCalledWith(GATE, expect.any(AbortSignal));
    expect(screen.queryByTestId('host')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.body.textContent).not.toContain('What’s wrong? What should change?');
    // The anchor read waits for the seed to name the card.
    expect(fetchPlanningAnchor).not.toHaveBeenCalled();
  });

  it('then the anchor read, still behind the skeleton — and the host mounts ONCE, draft in its first render', async () => {
    let settleAnchor: (v: typeof ANCHOR) => void = () => {};
    fetchPlanningAnchor.mockReturnValue(new Promise((r) => (settleAnchor = r)));
    openAt(SEEDED_ADDRESS);
    mount();
    await act(async () => {});

    expect(fetchPlanningAnchor).toHaveBeenCalledWith('ACME-44', expect.any(AbortSignal));
    expect(screen.queryByTestId('host')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();

    await act(async () => settleAnchor(ANCHOR));
    expect(screen.getAllByTestId('host')).toHaveLength(1);
    expect(firstRenderDraft).toEqual([FIRST_TURN]);
  });
});

describe('SEEDED — a refused gate with no seeded session (sheets 2–5)', () => {
  it('opens a work-item RE-PLAN on the refused card, with the turn as the draft and the gate for the first send', async () => {
    openAt(SEEDED_ADDRESS);
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('replan');
    expect(host.getAttribute('data-from')).toBe('work-item');
    expect(host.getAttribute('data-item')).toBe('ACME-44');
    expect(host.getAttribute('data-anchor-id')).toBe('wi_44');
    expect(host.getAttribute('data-target')).toBe('ACME-44');
    expect(host.getAttribute('data-seed-gate')).toBe(GATE);
    expect(host.getAttribute('data-resume')).toBe('false');
    expect(host.getAttribute('data-session')).toBe('');
    // The workspace's launch is the RESOLVED one — the gate id is not on it.
    expect(host.hasAttribute('data-launch-gate')).toBe(false);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(FIRST_TURN);
  });

  it('a card the anchor read cannot see gets NO draft — nothing to re-plan on screen', async () => {
    fetchPlanningAnchor.mockResolvedValue(null);
    openAt(SEEDED_ADDRESS);
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.hasAttribute('data-seed-gate')).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('Close strips the gate with the rest, and keeps the host page', async () => {
    openAt(`${SEEDED_ADDRESS.replace('?', '?tab=activity&')}`);
    mount();
    await act(async () => {});
    await act(async () => screen.getByRole('button', { name: 'Close' }).click());
    expect(shallowPush).toHaveBeenCalledWith('/items/ACME-44?tab=activity');
  });

  it('closing and reopening the same gate READS IT AGAIN — a send in between made a session to return to', async () => {
    openAt(SEEDED_ADDRESS);
    const view = mount();
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-seed-gate')).toBe(GATE);

    openAt('/items/ACME-44');
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});
    expect(screen.queryByTestId('host')).toBeNull();

    let settle: (v: PlanningSeedDTO) => void = () => {};
    fetchPlanningSeed.mockReturnValue(new Promise((r) => (settle = r)));
    openAt(SEEDED_ADDRESS);
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});
    // The earlier seed is NOT reused while the fresh read is in flight.
    expect(screen.queryByTestId('host')).toBeNull();
    expect(fetchPlanningSeed).toHaveBeenCalledTimes(2);

    await act(async () => settle({ ...SEED, seededSessionId: 's7' }));
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-session')).toBe('s7');
    expect(host.hasAttribute('data-seed-gate')).toBe(false);
  });
});

describe('RETURNING — the viewer’s own recent seeded session (sheet 7)', () => {
  it('opens THAT session as a RESUME on the card, with no draft and no seed', async () => {
    fetchPlanningSeed.mockResolvedValue({ ...SEED, seededSessionId: 's7' });
    openAt(SEEDED_ADDRESS);
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-from')).toBe('work-item');
    expect(host.getAttribute('data-item')).toBe('ACME-44');
    expect(host.getAttribute('data-session')).toBe('s7');
    expect(host.getAttribute('data-resume')).toBe('true');
    expect(host.hasAttribute('data-seed-gate')).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the UNSEEDED fall-back — silent, and indistinguishable from Plan with AI (sheet 8)', () => {
  for (const [label, arrange] of [
    [
      'a 404 (unknown, unreadable, foreign or not-refused gate)',
      () => fetchPlanningSeed.mockResolvedValue(null),
    ],
    ['a failed read', () => fetchPlanningSeed.mockRejectedValue(new Error('500'))],
  ] as const) {
    it(`${label} opens a PROJECT launch — no draft, no error, no gate id, no reason`, async () => {
      arrange();
      openAt(SEEDED_ADDRESS);
      mount();
      await act(async () => {});

      const host = screen.getByTestId('host');
      expect(host.getAttribute('data-mode')).toBe('project');
      expect(host.getAttribute('data-from')).toBe('project');
      expect(host.getAttribute('data-item')).toBe('');
      expect(host.getAttribute('data-anchor-id')).toBe('');
      expect(host.hasAttribute('data-seed-gate')).toBe(false);
      expect(host.hasAttribute('data-launch-gate')).toBe(false);
      expect(fetchPlanningAnchor).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.body.innerHTML).not.toContain(GATE);
      expect(document.body.innerHTML).not.toContain(REASON);
    });
  }

  it('a refused-gate address with NO gate id opens the project launch without reading anything', async () => {
    openAt('/items/ACME-44?plan=replan&planFrom=refused-gate');
    mount();
    await act(async () => {});
    expect(fetchPlanningSeed).not.toHaveBeenCalled();
    expect(screen.getByTestId('host').getAttribute('data-from')).toBe('project');
  });
});

describe('every UNSEEDED launch is untouched', () => {
  it('a work-item launch reads no seed', async () => {
    openAt('/items/ACME-44?plan=replan&planFrom=work-item&planItem=ACME-44');
    mount();
    await act(async () => {});
    expect(fetchPlanningSeed).not.toHaveBeenCalled();
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-from')).toBe('work-item');
    expect(host.hasAttribute('data-seed-gate')).toBe(false);
    expect(host.getAttribute('data-resume')).toBe('false');
  });
});

describe('a CLOSE while the seed read is in flight drops its answer (MOTIR-6212)', () => {
  for (const [label, outcome] of [
    ['the seed', 'resolve'],
    ['the failure', 'reject'],
  ] as const) {
    it(`${label} arriving after the close mounts nothing`, async () => {
      let settle: (v: PlanningSeedDTO) => void = () => {};
      let fail: (e: Error) => void = () => {};
      fetchPlanningSeed.mockReturnValue(
        new Promise<PlanningSeedDTO>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        }),
      );
      openAt(SEEDED_ADDRESS);
      const view = mount();
      await act(async () => {});
      const signal = fetchPlanningSeed.mock.calls[0]![1] as AbortSignal;

      openAt('/items/ACME-44');
      view.rerender(
        <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
      );
      await act(async () => {});
      expect(signal.aborted).toBe(true);

      await act(async () => (outcome === 'resolve' ? settle(SEED) : fail(new Error('500'))));
      expect(screen.queryByTestId('host')).toBeNull();
      expect(fetchPlanningAnchor).not.toHaveBeenCalled();
    });
  }
});
