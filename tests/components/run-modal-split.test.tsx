// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '../../messages/en.json';
import { RunModal } from '@/app/(authed)/runs/_components/RunModal';
import {
  RUN_FRAME_STACKED_ROWS,
  RUN_LOG_WIDTH_STORAGE_KEY,
} from '@/app/(authed)/runs/_components/runFrameRows';
import { __resetPersistedPaneWidthsForTests } from '@/lib/hooks/usePersistedPaneWidth';
import {
  clampRailWidth,
  defaultRailWidth,
  railBounds,
  RAIL_KEYBOARD_COARSE_STEP_PX,
  RAIL_KEYBOARD_STEP_PX,
  RAIL_WIDTH_STORAGE_KEY,
  SPLIT_MIN_CONTAINER_PX,
} from '@/lib/planning/railWidth';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';

// MOTIR-9072 — the run overlay's two panes ride the shared split. This is a
// WIRING lane: the drag, keyboard and storage behaviour belong to
// `resizable-split.test.tsx`; what only this host can get wrong is the pane
// ORDER (`--rail-w` sizes the SECOND child), the storage key, the seam's single
// edge and the stacked template. The real `RunModal` mounts with only its panes
// stubbed. happy-dom lays nothing out, so no assertion here reads a measured size.

vi.mock('@/app/(authed)/runs/_components/RunLogPane', () => ({
  RunLogPane: () => <div data-testid="stub-log-pane" />,
}));
vi.mock('@/app/(authed)/runs/_components/RunFindings', () => ({
  RunFindings: () => <div data-testid="stub-findings" />,
}));
vi.mock('@/app/(authed)/runs/_components/RunCanvasPane', () => ({
  RunCanvasPane: () => <div data-testid="stub-canvas" />,
}));

let containerWidth = 1440;
const observers = new Set<{ cb: ResizeObserverCallback; el: Element }>();

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset?.testid === 'resizable-split' ? containerWidth : 0;
    },
  });
  class RO implements ResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      observers.add({ cb: this.cb, el });
    }
    unobserve() {}
    disconnect() {
      for (const o of observers) if (o.cb === this.cb) observers.delete(o);
    }
  }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  globalThis.matchMedia ??= ((q: string) =>
    ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof matchMedia;
});

const fetchMock = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  containerWidth = 1440;
  observers.clear();
  window.localStorage.clear();
  __resetPersistedPaneWidthsForTests();
  fetchMock.mockReset();
  onClose.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DTO: DispatchRunDto = {
  id: 'run_a91f',
  projectId: 'prj_1',
  command: 'run',
  origin: 'local',
  scopeWorkItemId: 'wi_scope',
  scopeLabel: 'MOTIR-1789',
  status: 'succeeded',
  stopReason: 'drained',
  agent: 'claude',
  model: 'claude-opus-5',
  startedAt: '2026-08-30T14:02:00.000Z',
  endedAt: '2026-08-30T14:20:04.000Z',
  createdById: null,
  lastHeartbeatAt: null,
  reportedBy: 'cli',
  agentInstance: null,
  cards: [
    {
      id: 'leg_1',
      key: 'MOTIR-1791',
      workItemId: 'wi_1',
      position: 0,
      disposition: 'implemented',
      skipReason: null,
      sessionBranch: null,
      startedAt: '2026-08-30T14:02:00.000Z',
      endedAt: '2026-08-30T14:20:00.000Z',
      exitCode: 0,
      model: null,
    },
  ],
  seq: 12,
};

async function mount(): Promise<ReturnType<typeof render>> {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).includes('/stream')
      ? { ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } }
      : { ok: true, status: 200, json: async () => DTO },
  );
  const view = render(<RunModal runId="run_a91f" projectKey="MOTIR" onClose={onClose} />);
  await act(async () => {});
  return view;
}

function resizeTo(width: number) {
  containerWidth = width;
  act(() => {
    for (const o of observers) {
      o.cb(
        [{ contentRect: { width } } as unknown as ResizeObserverEntry],
        null as unknown as ResizeObserver,
      );
    }
  });
}

const frame = () => screen.getByTestId('resizable-split');
const divider = () => screen.getByTestId('split-divider');
const railVar = () => frame().style.getPropertyValue('--rail-w');
const paneSet = () => screen.getByLabelText(en.runs.paneSet);
const logRegion = () => screen.getByTestId('run-modal-log-region');

function dragTo(clientX: number) {
  fireEvent.pointerDown(divider(), { button: 0, pointerId: 1, clientX: 960 });
  act(() => {
    fireEvent.pointerMove(window, { pointerId: 1, clientX });
  });
  act(() => {
    fireEvent.pointerUp(window, { pointerId: 1, clientX });
  });
}

describe('the panes ride the shared frame, pane-set first and log second', () => {
  it('puts the pane-set section, the log region and the divider in that order', async () => {
    await mount();
    resizeTo(1440);
    expect(frame().children[0]).toBe(paneSet());
    expect(frame().children[1]).toBe(logRegion());
    expect(frame().children[2]).toBe(divider());
  });

  it('wears the host’s className and its own stacked template', async () => {
    await mount();
    expect(frame().className).toContain('min-h-0');
    expect(frame().className).toContain('flex-1');
    expect(frame().className).toContain(RUN_FRAME_STACKED_ROWS);
  });

  it('lets the left pane shrink and the log take its width from the track', async () => {
    await mount();
    const left = paneSet().className.split(/\s+/);
    expect(left).toContain('min-w-0');
    expect(left).not.toContain('flex-1');
    expect(left).not.toContain('lg:border-r');
    const right = logRegion().className.split(/\s+/);
    for (const gone of ['lg:w-[26rem]', 'w-full', 'shrink-0']) expect(right).not.toContain(gone);
  });

  it('draws the seam’s one resting edge on the log region, and only from md up', async () => {
    await mount();
    expect(logRegion().className).toContain('md:border-l');
    expect(logRegion().className).toContain('border-(--el-border-soft)');
  });

  it('keeps the selection hook the left pane drives', async () => {
    await mount();
    expect(logRegion().getAttribute('data-selected-work-item')).toBe('');
  });
});

describe('the divider', () => {
  it('is a focusable separator named from the runs catalogue', async () => {
    await mount();
    resizeTo(1440);
    expect(divider().getAttribute('role')).toBe('separator');
    expect(divider().getAttribute('tabindex')).toBe('0');
    expect(divider().getAttribute('aria-label')).toBe(en.runs.logDividerAria);
  });

  it('opens at the shared default, inside the shared bounds', async () => {
    await mount();
    resizeTo(1440);
    const { min, max } = railBounds(1440);
    expect(divider().getAttribute('aria-valuenow')).toBe(
      String(Math.round(defaultRailWidth(1440))),
    );
    expect(divider().getAttribute('aria-valuemin')).toBe(String(Math.round(min)));
    expect(divider().getAttribute('aria-valuemax')).toBe(String(Math.round(max)));
  });

  it('drags the log pane and stores the width under the run overlay’s own key', async () => {
    await mount();
    resizeTo(1440);
    dragTo(900);
    const expected = Math.round(clampRailWidth(1440 - 900, 1440));
    expect(railVar()).toBe(`${expected}px`);
    expect(window.localStorage.getItem(RUN_LOG_WIDTH_STORAGE_KEY)).toBe(String(expected));
  });

  it('steps by the shared keyboard steps and lands on the bounds', async () => {
    await mount();
    resizeTo(1440);
    const { min, max } = railBounds(1440);
    const start = Math.round(defaultRailWidth(1440));
    const now = () => Number(divider().getAttribute('aria-valuenow'));
    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    expect(now()).toBe(start + RAIL_KEYBOARD_STEP_PX);
    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    expect(now()).toBe(start);
    fireEvent.keyDown(divider(), { key: 'ArrowLeft', shiftKey: true });
    expect(now()).toBe(start + RAIL_KEYBOARD_COARSE_STEP_PX);
    fireEvent.keyDown(divider(), { key: 'Home' });
    expect(now()).toBe(Math.round(min));
    fireEvent.keyDown(divider(), { key: 'End' });
    expect(now()).toBe(Math.round(max));
    fireEvent.keyDown(divider(), { key: 'Enter' });
    expect(now()).toBe(start);
  });

  it('survives closing and reopening the overlay', async () => {
    const first = await mount();
    resizeTo(1440);
    dragTo(900);
    const chosen = railVar();
    first.unmount();
    __resetPersistedPaneWidthsForTests();
    await mount();
    resizeTo(1440);
    expect(railVar()).toBe(chosen);
  });
});

describe('the planning workspace’s width is not this host’s', () => {
  it('neither reads nor writes motir.planning.railWidth', async () => {
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, '600');
    __resetPersistedPaneWidthsForTests();
    await mount();
    resizeTo(1440);
    expect(divider().getAttribute('aria-valuenow')).toBe(
      String(Math.round(defaultRailWidth(1440))),
    );
    dragTo(900);
    expect(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY)).toBe('600');
  });

  it('declares the key once, with the agreed value', () => {
    expect(RUN_LOG_WIDTH_STORAGE_KEY).toBe('motir.runs.logWidth');
  });
});

describe('below the split breakpoint the panes stack and lose nothing', () => {
  it('renders no divider, and both panes in order', async () => {
    containerWidth = SPLIT_MIN_CONTAINER_PX - 1;
    await mount();
    resizeTo(SPLIT_MIN_CONTAINER_PX - 1);
    expect(screen.queryByTestId('split-divider')).toBeNull();
    expect(frame().children[0]).toBe(paneSet());
    expect(frame().children[1]).toBe(logRegion());
  });
});
