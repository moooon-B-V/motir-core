// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { PlanSessionListPageDto, PlanSessionRowDto } from '@/lib/dto/planSessions';
import zhMessages from '@/messages/zh.json';

// Story MOTIR-9218 · MOTIR-9307 — the planning overlay's HISTORY section (design
// MOTIR-9305): collapsed and request-free on open, the first page on first
// expand, the next page when the list's bottom scrolls into view (one at a time,
// merged by id), the end, empty and error states, the row's words and markers, a
// row's open, and no section at all for a Visitor. `fetch` is stubbed at the
// history route; the IntersectionObserver is a fake the test triggers.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/plans',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: (key: string) => key === 'project:browse' }),
}));

const { PlanHistorySection } = await import('@/components/planning/PlanHistorySection');
const { PlanChangeRail } = await import('@/components/planning/PlanChangeRail');
const { ReaderRoutesProvider } = await import('@/lib/visitor/useReaderRoutes');
const { indexPlanReview } = await import('@/lib/planning/planChangeDiff');
const { renderWithIntl } = await import('../helpers/renderWithIntl');
type ConversationState =
  import('@/lib/hooks/usePlanChangeConversation').PlanChangeConversationState;

const NOW = new Date('2026-10-22T12:00:00.000Z');

function row(id: string, over: Partial<PlanSessionRowDto> = {}): PlanSessionRowDto {
  return {
    id,
    origin: 'conversation',
    targetKeys: [],
    lastActivityAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    startedBy: { id: 'u1', name: 'Yue' },
    firstTurn: `Question ${id}`,
    latestPlan: null,
    planCount: 0,
    state: 'none',
    failure: null,
    endedAt: null,
    endReason: null,
    endedBy: null,
    copiedFrom: null,
    seed: null,
    ...over,
  } as PlanSessionRowDto;
}

function page(ids: string[], nextCursor: string | null): PlanSessionListPageDto {
  return { sessions: ids.map((id) => row(id)), nextCursor, scope: 'mine' };
}

// ── fetch, answered by the test ─────────────────────────────────────────────────

type Pending = { url: string; resolve: (body: unknown) => void; fail: () => void };
let requests: Pending[] = [];
const fetchMock = vi.fn((url: string) => {
  return new Promise<Response>((res) => {
    requests.push({
      url,
      resolve: (body) => res(new Response(JSON.stringify(body), { status: 200 })),
      fail: () => res(new Response(JSON.stringify({ code: 'BOOM' }), { status: 500 })),
    });
  });
});

async function answer(i: number, body: unknown) {
  await act(async () => {
    requests[i]!.resolve(body);
  });
}
async function failRequest(i: number) {
  await act(async () => {
    requests[i]!.fail();
  });
}

// ── the observer, triggered by the test ─────────────────────────────────────────

let observers: { cb: IntersectionObserverCallback; targets: Element[] }[] = [];
class FakeObserver {
  targets: Element[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    observers.push({ cb, targets: this.targets });
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  disconnect() {
    observers = observers.filter((o) => o.targets !== this.targets);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}
async function reachBottom() {
  await act(async () => {
    for (const o of [...observers]) {
      o.cb(
        o.targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
    }
  });
}

const onOpenSession = vi.fn();

function section(currentSessionId: string | null = null, opts: { zh?: boolean } = {}) {
  return renderWithIntl(
    <PlanHistorySection currentSessionId={currentSessionId} onOpenSession={onOpenSession} />,
    { now: NOW, ...(opts.zh ? { locale: 'zh', messages: zhMessages } : {}) },
  );
}

const toggle = () => screen.getByTestId('planning-history-toggle');
const rowIds = () =>
  screen.queryAllByTestId('planning-history-row').map((r) => r.getAttribute('data-session-id'));

beforeEach(() => {
  requests = [];
  observers = [];
  fetchMock.mockClear();
  onOpenSession.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the header', () => {
  it('is collapsed on open, with no request and no rows', () => {
    section();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rowIds()).toEqual([]);
  });

  it('a click expands and collapses; re-expanding keeps the rows without a refetch', async () => {
    section();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await answer(0, page(['a', 'b'], null));
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(rowIds()).toEqual([]);
    fireEvent.click(toggle());
    expect(rowIds()).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is a native button, so Enter and Space toggle it', () => {
    section();
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle().getAttribute('type')).toBe('button');
    expect(toggle().getAttribute('aria-controls')).toBeTruthy();
  });
});

describe('the first page', () => {
  it('shows the skeleton until it arrives, then its rows in the order received', async () => {
    section();
    fireEvent.click(toggle());
    expect(screen.getByTestId('planning-history-skeleton')).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ai/plan-change/sessions/history');
    const ten = Array.from({ length: 10 }, (_, i) => `s${i}`);
    await answer(0, page(ten, 'c1'));
    expect(screen.queryByTestId('planning-history-skeleton')).toBeNull();
    expect(rowIds()).toEqual(ten);
  });

  it('with no rows shows the empty state, not a list or an end marker', async () => {
    section();
    fireEvent.click(toggle());
    await answer(0, page([], null));
    const empty = screen.getByTestId('planning-history-empty');
    expect(empty.textContent).toContain('No conversations yet');
    expect(empty.textContent).toContain('Questions you ask and plans you start');
    expect(screen.queryByTestId('planning-history-list')).toBeNull();
    expect(screen.queryByTestId('planning-history-end')).toBeNull();
  });

  it('a failure shows the error with a retry that asks for the first page again', async () => {
    section();
    fireEvent.click(toggle());
    await failRequest(0);
    expect(screen.getByTestId('planning-history-error').textContent).toContain(
      'Couldn’t load your conversations.',
    );
    fireEvent.click(screen.getByTestId('planning-history-retry'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/ai/plan-change/sessions/history');
    await answer(1, page(['a'], null));
    expect(rowIds()).toEqual(['a']);
  });
});

describe('paging', () => {
  it('the bottom asks for exactly one next page on the cursor, and the footer shows meanwhile', async () => {
    section();
    fireEvent.click(toggle());
    await answer(0, page(['a', 'b'], 'cur/1'));
    await reachBottom();
    await reachBottom();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      '/api/ai/plan-change/sessions/history?cursor=cur%2F1',
    );
    expect(screen.getByTestId('planning-history-loading-more')).toBeTruthy();
    expect(rowIds()).toEqual(['a', 'b']);
    await answer(1, page(['c'], null));
    expect(rowIds()).toEqual(['a', 'b', 'c']);
  });

  it('focusing the last row asks for the next page too', async () => {
    section();
    fireEvent.click(toggle());
    await answer(0, page(['a', 'b'], 'cur1'));
    const rows = screen.getAllByTestId('planning-history-row');
    fireEvent.focus(rows[0]!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.focus(rows[1]!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a session in both pages renders once', async () => {
    section();
    fireEvent.click(toggle());
    await answer(0, page(['a', 'b'], 'cur1'));
    await reachBottom();
    await answer(1, page(['b', 'c'], null));
    expect(rowIds()).toEqual(['a', 'b', 'c']);
  });

  it('a null cursor stops paging and shows the end marker after the last row', async () => {
    section();
    fireEvent.click(toggle());
    await answer(0, page(['a'], null));
    await reachBottom();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const list = screen.getByTestId('planning-history-list');
    const end = within(list).getByTestId('planning-history-end');
    expect(end.textContent).toContain('No older conversations');
    expect(end.compareDocumentPosition(screen.getByTestId('planning-history-row'))).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
  });

  it('a failed next page keeps the rows and retries that page', async () => {
    section();
    fireEvent.click(toggle());
    await answer(0, page(['a'], 'cur1'));
    await reachBottom();
    await failRequest(1);
    expect(rowIds()).toEqual(['a']);
    expect(screen.getByTestId('planning-history-error').textContent).toContain(
      'Couldn’t load more conversations.',
    );
    fireEvent.click(screen.getByTestId('planning-history-retry'));
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/ai/plan-change/sessions/history?cursor=cur1');
    await answer(2, page(['b'], null));
    expect(rowIds()).toEqual(['a', 'b']);
  });
});

describe('a row', () => {
  async function shown(rows: PlanSessionRowDto[], current: string | null = null) {
    section(current);
    fireEvent.click(toggle());
    await answer(0, { sessions: rows, nextCursor: null, scope: 'mine' });
    return screen.getAllByTestId('planning-history-row');
  }

  it('shows its first turn, or the fallback; its anchor; when it was active; Open', async () => {
    const [first, second] = await shown([
      row('a', { targetKeys: ['ACME-1', 'ACME-2'] }),
      row('b', { firstTurn: null }),
    ]);
    expect(first!.textContent).toContain('Question a');
    expect(within(first!).getByTestId('planning-history-row-anchor').textContent).toBe(
      'ACME-1 +1',
    );
    expect(first!.textContent).toContain('active 1 hour ago');
    expect(within(first!).getByTestId('planning-history-row-status').textContent).toBe('Open');
    expect(within(second!).getByTestId('planning-history-row-title').textContent).toBe(
      'Untitled conversation',
    );
    expect(second!.textContent).toContain('Whole project');
  });

  it('an ended row reads Ended in the muted treatment; a plan adds its state', async () => {
    const [ended, planned] = await shown([
      row('a', { endedAt: NOW.toISOString(), endReason: 'idle', state: 'closed' }),
      row('b', { planCount: 1, state: 'planned' }),
    ]);
    expect(ended!.getAttribute('data-ended')).toBe('true');
    expect(within(ended!).getByTestId('planning-history-row-status').textContent).toBe('Ended');
    expect(within(ended!).getByTestId('planning-history-row-title').className).toContain(
      '--el-text-secondary',
    );
    expect(planned!.getAttribute('data-ended')).toBeNull();
    expect(planned!.textContent).toContain('Waiting for approval');
  });

  it('only the current session carries the marker', async () => {
    const [a, b] = await shown([row('a'), row('b')], 'b');
    expect(a!.getAttribute('aria-current')).toBeNull();
    expect(b!.getAttribute('aria-current')).toBe('true');
  });

  it('a click opens it, once, by id', async () => {
    const [, b] = await shown([row('a'), row('b')]);
    fireEvent.click(b!);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith('b');
  });
});

describe('in Chinese', () => {
  it('renders no History string in English', async () => {
    section(null, { zh: true });
    expect(toggle().textContent).toBe('历史记录');
    fireEvent.click(toggle());
    await answer(0, page(['a'], null));
    const r = screen.getByTestId('planning-history-row');
    expect(within(r).getByTestId('planning-history-row-status').textContent).toBe('进行中');
    expect(screen.getByTestId('planning-history-end').textContent).toContain('没有更早的对话');
    expect(screen.getByTestId('planning-history').textContent).not.toMatch(
      /History|Open|No older/,
    );
  });
});

// ── the rail mounts it for a member, never for a Visitor ───────────────────────

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

function rail() {
  return (
    <PlanChangeRail
      launch={{ mode: 'project', from: 'project', itemKey: null }}
      projectName="Acme"
      state={BASE}
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
    />
  );
}

describe('the rail', () => {
  it('draws the collapsed History header for a member, with no request', () => {
    renderWithIntl(rail(), { now: NOW });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('sessions/history'))).toBe(false);
  });

  it('draws no History for a Visitor', () => {
    renderWithIntl(<ReaderRoutesProvider identifier="ACME">{rail()}</ReaderRoutesProvider>, {
      now: NOW,
    });
    expect(screen.queryByTestId('planning-history')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('sessions/history'))).toBe(false);
  });
});
