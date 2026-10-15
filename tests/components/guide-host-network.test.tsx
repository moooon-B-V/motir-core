// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { GuideTurnRecord } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// THE GUIDE OVERLAY AT THE NETWORK BOUNDARY (Story MOTIR-7459 · MOTIR-7468).
//
// `guide-overlay.test.tsx` pins the two panes against a handed-in view. This file
// removes that: the host, the REAL `useGuideConversation` and the REAL
// `guideClient` run, and the only fakes are `fetch` (the guide door, the stream
// relay and the settle) and the page's to-do Server Actions, which the host
// injects. So "opens once", "lands, then re-reads the rows" and "Try again re-runs
// the same turn" are counted as requests leaving the browser.

const { refresh, reread } = vi.hoisted(() => ({ refresh: vi.fn(), reread: vi.fn() }));
vi.mock('@/lib/workbench/workbenchReread', () => ({ useRequestWorkbenchReread: () => reread }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/PROD-7',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn(), prefetch: vi.fn() }),
}));

const { listTodosAction, setTodoDoneAction } = vi.hoisted(() => ({
  listTodosAction: vi.fn(),
  setTodoDoneAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/todoActions', () => ({ listTodosAction, setTodoDoneAction }));

import { GuideWorkspaceHost } from '@/components/planning/GuideWorkspaceHost';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function todo(id: string, text: string, done = false): WorkItemTodoDto {
  return {
    id,
    text,
    notesMd: null,
    commandText: null,
    executor: null,
    position: id,
    done,
    doneAt: done ? '2026-10-03T10:00:00.000Z' : null,
    doneBy: done ? { id: 'u1', name: 'Owner' } : null,
  } as WorkItemTodoDto;
}
const progressOf = (rows: WorkItemTodoDto[]) => ({
  done: rows.filter((r) => r.done).length,
  total: rows.length,
});

function turn(seq: number, over: Partial<PlanChangeTurnDto>): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role: 'user',
    body: 'Guide me through PROD-7.',
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'guide',
    intentCorrected: false,
    citations: [],
    authorId: 'u1',
    createdAt: '2026-10-03T10:00:00.000Z',
    ...over,
  } as PlanChangeTurnDto;
}
function thread(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['PROD-7'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-03T10:00:00.000Z',
    origin: 'guide',
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    turns,
    workItemRefs: {},
  } as PlanChangeSessionDto;
}
const record = (actions: GuideTurnRecord['actions'], outcome = 'landed'): GuideTurnRecord => ({
  actions,
  outcomes: actions.map((a) => ({ type: a.type, outcome: outcome as 'landed' })),
  temporary: false,
});

const OPENING = turn(0, { jobId: 'job-1' });
const ANSWER = turn(1, {
  role: 'assistant',
  body: 'Step 1 is done. Next, rotate the key.',
  authorId: null,
  guide: record([{ type: 'tick', rowId: 'r1' }]),
});

// ── The network ───────────────────────────────────────────────────────────────

interface Sent {
  method: string;
  path: string;
  body: unknown;
}
const sent: Sent[] = [];
const posted = (path: string) => sent.filter((r) => r.method === 'POST' && r.path === path);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (frame: string) =>
  new Response(frame, { headers: { 'content-type': 'text/event-stream' } });

type Handler = (method: string, path: string, body: unknown) => Response | undefined;
let handler: Handler;

async function server(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  sent.push({ method, path: url.pathname, body });
  return handler(method, url.pathname, body) ?? json({ code: 'NOT_FOUND' }, 404);
}

/** The ordinary server: a card with two rows, an opening turn whose job ticks
 *  step 1 when it settles. */
function ordinary(rows: { before: WorkItemTodoDto[]; after: WorkItemTodoDto[] }): Handler {
  let settled = false;
  listTodosAction.mockImplementation(async () => {
    const items = settled ? rows.after : rows.before;
    return { ok: true, items, progress: progressOf(items) };
  });
  return (method, path) => {
    if (method === 'POST' && path === '/api/ai/guide') {
      return json({
        outcome: 'guiding',
        jobId: 'job-1',
        turnId: 't0',
        started: true,
        session: thread([OPENING]),
      });
    }
    if (method === 'GET' && path === '/api/ai/ask/job-1/stream') {
      return sse('event: done\ndata: {}\n\n');
    }
    if (method === 'POST' && path === '/api/ai/guide/settle') {
      settled = true;
      return json({
        outcome: 'guided',
        session: thread([OPENING, ANSWER]),
        record: ANSWER.guide,
      });
    }
    return undefined;
  };
}

const CARD = { id: 'wi-7', identifier: 'PROD-7', title: 'Rotate the key', kind: 'task' as const };
const onClose = vi.fn();

function renderHost(card = CARD) {
  return renderWithIntl(<GuideWorkspaceHost projectName="Acme" card={card} onClose={onClose} />);
}

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(server));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  listTodosAction.mockReset();
  setTodoDoneAction.mockReset();
  refresh.mockReset();
  reread.mockReset();
  onClose.mockReset();
});

const rowsDone = () =>
  screen.getAllByTestId('guide-row').map((r) => r.getAttribute('data-todo-done') === 'true');

describe('opening the guide', () => {
  it('opens ONCE, runs the opening turn, lands it and re-reads the rows', async () => {
    const before = [todo('r1', 'Open the vault'), todo('r2', 'Rotate the key')];
    handler = ordinary({ before, after: [todo('r1', 'Open the vault', true), before[1]!] });
    renderHost({ ...CARD, identifier: 'PROD-71' });

    await waitFor(() => expect(screen.getByTestId('guide-outcome')).toBeTruthy());
    expect(posted('/api/ai/guide')).toHaveLength(1);
    expect(posted('/api/ai/guide')[0]!.body).toEqual({ itemKey: 'PROD-71' });
    expect(posted('/api/ai/guide/settle')[0]!.body).toEqual({ sessionId: 's1', jobId: 'job-1' });
    await waitFor(() => expect(rowsDone()).toEqual([true, false]));
    expect(screen.getByTestId('guide-outcome').getAttribute('data-outcome')).toBe('ticked');
    expect(screen.getByTestId('guide-crumb').textContent).toContain('PROD-71');
  });

  it('a refused door says why, and offers no Try again', async () => {
    listTodosAction.mockResolvedValue({ ok: true, items: [], progress: { done: 0, total: 0 } });
    handler = (method, path) =>
      method === 'POST' && path === '/api/ai/guide'
        ? json({ code: 'GUIDE_CARD_NOT_MANUAL' }, 422)
        : undefined;
    renderHost({ ...CARD, identifier: 'PROD-72' });
    await waitFor(() => expect(screen.getByTestId('guide-error')).toBeTruthy());
    expect(screen.getByTestId('guide-error').textContent).toContain(
      'this work item is for an agent',
    );
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('a door that failed outright opens again on Try again', async () => {
    listTodosAction.mockResolvedValue({ ok: true, items: [], progress: { done: 0, total: 0 } });
    let attempts = 0;
    handler = (method, path) => {
      if (method === 'POST' && path === '/api/ai/guide') {
        attempts += 1;
        return attempts === 1
          ? json({}, 500)
          : json({
              outcome: 'guiding',
              jobId: null,
              turnId: null,
              started: false,
              session: thread([]),
            });
      }
      return undefined;
    };
    renderHost({ ...CARD, identifier: 'PROD-73' });
    await waitFor(() => expect(screen.getByTestId('guide-error')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.queryByTestId('guide-error')).toBeNull());
    expect(posted('/api/ai/guide')).toHaveLength(2);
  });

  it('a resume that reopened mid-turn follows the unanswered turn’s job', async () => {
    handler = ordinary({ before: [todo('r1', 'One')], after: [todo('r1', 'One', true)] });
    const resume = handler;
    handler = (method, path, body) =>
      method === 'POST' && path === '/api/ai/guide'
        ? json({
            outcome: 'guiding',
            jobId: null,
            turnId: null,
            started: false,
            session: thread([OPENING]),
          })
        : resume(method, path, body);
    renderHost({ ...CARD, identifier: 'PROD-74' });
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    await waitFor(() => expect(rowsDone()).toEqual([true]));
  });
});

describe('the canvas pane', () => {
  // MOTIR-8232: the canvas is the resizable frame's `1fr` grid item. Without `min-w-0` its
  // automatic minimum is its min-content — a long, non-wrapping card title in the crumb
  // stretched the track and pushed the chat column (and the divider) off-screen. happy-dom
  // has no layout, so the guard is the class that removes the automatic minimum.
  it('may shrink below its content, so a long card title cannot push the chat pane out', async () => {
    handler = ordinary({ before: [], after: [] });
    renderHost({ ...CARD, identifier: 'PROD-88', title: 'A very long card title '.repeat(20) });
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    const frame = screen.getByTestId('planning-resizable-frame');
    const canvasPane = screen.getByTestId('guide-crumb').parentElement?.parentElement;
    expect(canvasPane?.parentElement).toBe(frame);
    expect(canvasPane?.className).toContain('min-w-0');
  });
});

describe('a turn that does not finish', () => {
  it('a failed stream is the guarantee line, and Try again re-runs the SAME turn', async () => {
    listTodosAction.mockResolvedValue({
      ok: true,
      items: [todo('r1', 'One')],
      progress: { done: 0, total: 1 },
    });
    let streams = 0;
    handler = (method, path, body) => {
      if (method === 'POST' && path === '/api/ai/guide') {
        const b = body as { turnId?: string };
        return json({
          outcome: 'guiding',
          jobId: b.turnId ? 'job-2' : 'job-1',
          turnId: 't0',
          started: !b.turnId,
          session: thread([OPENING]),
        });
      }
      if (method === 'GET' && /\/stream$/.test(path)) {
        streams += 1;
        return streams === 1
          ? sse('event: error\ndata: {"code":"ai_job_failed"}\n\n')
          : sse('event: done\ndata: {}\n\n');
      }
      if (method === 'POST' && path === '/api/ai/guide/settle') {
        return json({
          outcome: 'guided',
          session: thread([OPENING, ANSWER]),
          record: ANSWER.guide,
        });
      }
      return undefined;
    };
    renderHost({ ...CARD, identifier: 'PROD-75' });
    await waitFor(() => expect(screen.getByTestId('guide-error')).toBeTruthy());
    expect(screen.getByTestId('guide-error').textContent).toContain(
      'nothing on the work item changed',
    );
    expect(posted('/api/ai/guide/settle')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    expect(posted('/api/ai/guide').at(-1)!.body).toEqual({ sessionId: 's1', turnId: 't0' });
    await waitFor(() => expect(screen.queryByTestId('guide-error')).toBeNull());
  });

  it('an out-of-credits stream draws the paywall, not the failure line', async () => {
    listTodosAction.mockResolvedValue({ ok: true, items: [], progress: { done: 0, total: 0 } });
    handler = (method, path) => {
      if (method === 'POST' && path === '/api/ai/guide') {
        return json({
          outcome: 'guiding',
          jobId: 'job-1',
          turnId: 't0',
          started: true,
          session: thread([OPENING]),
        });
      }
      if (method === 'GET' && /\/stream$/.test(path)) {
        return sse('event: error\ndata: {"code":"MOTIR_AI_OUT_OF_CREDITS"}\n\n');
      }
      return undefined;
    };
    renderHost({ ...CARD, identifier: 'PROD-76' });
    await waitFor(() => expect(screen.getByTestId('guide-progress-line').textContent).toBe(''));
    expect(screen.queryByTestId('guide-error')).toBeNull();
  });

  it('a settle refused out of credits draws no failure line either', async () => {
    listTodosAction.mockResolvedValue({ ok: true, items: [], progress: { done: 0, total: 0 } });
    handler = (method, path) => {
      if (method === 'POST' && path === '/api/ai/guide') {
        return json({
          outcome: 'guiding',
          jobId: 'job-1',
          turnId: 't0',
          started: true,
          session: thread([OPENING]),
        });
      }
      if (method === 'GET' && /\/stream$/.test(path)) return sse('event: done\ndata: {}\n\n');
      if (method === 'POST' && path === '/api/ai/guide/settle') {
        return json({ code: 'MOTIR_AI_OUT_OF_CREDITS' }, 402);
      }
      return undefined;
    };
    renderHost({ ...CARD, identifier: 'PROD-77' });
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('guide-progress-line').textContent).toBe(''));
    expect(screen.queryByTestId('guide-error')).toBeNull();
  });

  it('a settle that reports the job failed is the guarantee line', async () => {
    listTodosAction.mockResolvedValue({ ok: true, items: [], progress: { done: 0, total: 0 } });
    handler = (method, path) => {
      if (method === 'POST' && path === '/api/ai/guide') {
        return json({
          outcome: 'guiding',
          jobId: 'job-1',
          turnId: 't0',
          started: true,
          session: thread([OPENING]),
        });
      }
      if (method === 'GET' && /\/stream$/.test(path)) return sse('event: done\ndata: {}\n\n');
      if (method === 'POST' && path === '/api/ai/guide/settle') {
        return json({ outcome: 'failed', session: thread([OPENING]) });
      }
      return undefined;
    };
    renderHost({ ...CARD, identifier: 'PROD-78' });
    await waitFor(() => expect(screen.getByTestId('guide-error')).toBeTruthy());
  });
});

describe('the person on the canvas and in the rail', () => {
  it('a tick goes through the to-do action and leaves a marker in the rail', async () => {
    const before = [todo('r1', 'Open the vault'), todo('r2', 'Rotate the key')];
    handler = ordinary({ before, after: [todo('r1', 'Open the vault', true), before[1]!] });
    setTodoDoneAction.mockImplementation(
      async ({ todoId, done }: { todoId: string; done: boolean }) => ({
        ok: true,
        todo: todo(todoId, 'Rotate the key', done),
        progress: { done: 2, total: 2 },
      }),
    );
    renderHost({ ...CARD, identifier: 'PROD-79' });
    await waitFor(() => expect(rowsDone()).toEqual([true, false]));

    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    expect(setTodoDoneAction).toHaveBeenCalledWith({ todoId: 'r2', done: true });
    await waitFor(() => expect(screen.getByTestId('guide-person-marker')).toBeTruthy());
    expect(screen.getByTestId('guide-person-marker').textContent).toContain('You ticked step 2');
    expect(rowsDone()).toEqual([true, true]);
  });

  it('a tick the card refuses reverts the row and says why', async () => {
    const before = [todo('r1', 'One')];
    handler = ordinary({ before, after: before });
    setTodoDoneAction.mockResolvedValue({ ok: false, error: 'That step is locked.' });
    renderHost({ ...CARD, identifier: 'PROD-80' });
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    await waitFor(() => expect(screen.getByText('That step is locked.')).toBeTruthy());
    expect(rowsDone()).toEqual([false]);
    expect(screen.queryByTestId('guide-person-marker')).toBeNull();
  });

  it('a tick whose action throws reverts the row', async () => {
    const before = [todo('r1', 'One')];
    handler = ordinary({ before, after: before });
    setTodoDoneAction.mockRejectedValue(new Error('offline'));
    renderHost({ ...CARD, identifier: 'PROD-81' });
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(rowsDone()).toEqual([false]);
  });

  it('a reply button sends its words as the next turn, which runs and lands', async () => {
    const proposal = turn(1, {
      role: 'assistant',
      body: 'Here is a list.',
      authorId: null,
      guide: record(
        [
          {
            type: 'propose_todos',
            rows: [{ id: 'tmp-1', text: 'Open', notesMd: null, commandText: null, executor: null }],
          },
        ],
        'recorded',
      ),
    });
    listTodosAction.mockResolvedValue({ ok: true, items: [], progress: { done: 0, total: 0 } });
    handler = (method, path, body) => {
      if (method === 'POST' && path === '/api/ai/guide') {
        const text = (body as { text?: string }).text;
        return text
          ? json({
              outcome: 'guiding',
              jobId: 'job-2',
              turnId: 't2',
              started: false,
              session: thread([OPENING, proposal, turn(2, { body: text, jobId: 'job-2' })]),
            })
          : json({
              outcome: 'guiding',
              jobId: null,
              turnId: null,
              started: false,
              session: thread([OPENING, proposal]),
            });
      }
      if (method === 'GET' && /\/stream$/.test(path)) return sse('event: done\ndata: {}\n\n');
      if (method === 'POST' && path === '/api/ai/guide/settle') {
        return json({ outcome: 'silent', session: thread([OPENING, proposal]) });
      }
      return undefined;
    };
    renderHost({ ...CARD, identifier: 'PROD-82' });
    await waitFor(() => expect(screen.getByTestId('guide-reply-walk')).toBeTruthy());
    fireEvent.click(screen.getByTestId('guide-reply-walk'));
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    expect(posted('/api/ai/guide').at(-1)!.body).toEqual({
      sessionId: 's1',
      text: 'Walk it without saving.',
    });
  });

  it('the band’s Save sends the save turn', async () => {
    const walk = turn(1, {
      role: 'assistant',
      body: 'Walking it.',
      authorId: null,
      guide: record(
        [
          {
            type: 'propose_todos',
            rows: [{ id: 'tmp-1', text: 'Open', notesMd: null, commandText: null, executor: null }],
          },
        ],
        'recorded',
      ),
    });
    const later = turn(3, {
      role: 'assistant',
      body: 'Go on.',
      authorId: null,
      guide: record([], 'recorded'),
    });
    listTodosAction.mockResolvedValue({ ok: true, items: [], progress: { done: 0, total: 0 } });
    handler = (method, path, body) => {
      if (method === 'POST' && path === '/api/ai/guide') {
        const text = (body as { text?: string }).text;
        return json({
          outcome: 'guiding',
          jobId: text ? 'job-3' : null,
          turnId: null,
          started: false,
          session: thread([OPENING, walk, turn(2, { body: 'Walk it.' }), later]),
        });
      }
      return undefined;
    };
    renderHost({ ...CARD, identifier: 'PROD-83' });
    const band = await screen.findByTestId('guide-temporary-band');
    fireEvent.click(within(band).getByRole('button', { name: 'Save to the work item' }));
    await waitFor(() => expect(posted('/api/ai/guide')).toHaveLength(2));
    expect(posted('/api/ai/guide')[1]!.body).toEqual({
      sessionId: 's1',
      text: 'Save this list to the work item.',
    });
  });

  it('Reload the work item re-reads the rows; so does coming back to the window', async () => {
    const before = [todo('r1', 'One')];
    handler = ordinary({ before, after: before });
    renderHost({ ...CARD, identifier: 'PROD-84' });
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    const reads = listTodosAction.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(listTodosAction.mock.calls.length).toBe(reads + 1);
    expect(listTodosAction).toHaveBeenLastCalledWith({ workItemId: 'wi-7' });
  });

  it('Close closes; the host asks a Workbench reread and refreshes nothing itself (MOTIR-8576)', async () => {
    handler = ordinary({ before: [], after: [] });
    const { unmount } = renderHost({ ...CARD, identifier: 'PROD-85' });
    await waitFor(() => expect(posted('/api/ai/guide/settle')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reread).not.toHaveBeenCalled();
    unmount();
    expect(reread).toHaveBeenCalledTimes(1);
    // The card's own page is re-read by the overlay's close, not by the host.
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('a re-plan offer (Story MOTIR-8684 · MOTIR-8694)', () => {
  const OFFER = {
    reason: 'The key was already rotated.',
    requestMd: 'SECRET-REQUEST-TEXT: re-plan PROD-7.',
    requestedTargetKey: null,
    targetKey: 'PROD-7',
    targetResolution: 'guided_card' as const,
    declinedAt: null,
    declinedById: null,
    confirmedAt: null,
    confirmedById: null,
    confirmedSessionId: null,
  };
  const OFFER_TURN = turn(1, {
    role: 'assistant',
    body: 'PROD-7 is wrong.',
    authorId: null,
    guide: { ...record([{ type: 'needs_replan', reason: OFFER.reason }]), replanOffer: OFFER },
  });

  /** The ordinary server, except the opening turn lands the offer. */
  function offered(extra?: Handler): Handler {
    listTodosAction.mockResolvedValue({
      ok: true,
      items: [todo('r1', 'One', true), todo('r2', 'Two')],
      progress: { done: 1, total: 2 },
    });
    return (method, path, body) => {
      if (method === 'POST' && path === '/api/ai/guide') {
        return json({
          outcome: 'guiding',
          jobId: 'job-1',
          turnId: 't0',
          started: true,
          session: thread([OPENING]),
          planning: { canPlan: true, reason: null },
        });
      }
      if (method === 'GET' && path === '/api/ai/ask/job-1/stream') {
        return sse('event: done\ndata: {}\n\n');
      }
      if (method === 'POST' && path === '/api/ai/guide/settle') {
        return json({
          outcome: 'guided',
          session: thread([OPENING, OFFER_TURN]),
          record: OFFER_TURN.guide,
        });
      }
      return extra?.(method, path, body);
    };
  }

  it('Decline posts once with the session and turn ids, then the offer reads Declined', async () => {
    handler = offered((method, path) =>
      method === 'POST' && path === '/api/ai/guide/offer/decline'
        ? json(
            thread([
              OPENING,
              {
                ...OFFER_TURN,
                guide: {
                  ...OFFER_TURN.guide!,
                  replanOffer: { ...OFFER, declinedAt: '2026-10-15T11:00:00.000Z' },
                },
              },
            ]),
          )
        : undefined,
    );
    renderHost({ ...CARD, identifier: 'PROD-81' });
    fireEvent.click(await screen.findByTestId('guide-offer-decline'));
    await waitFor(() =>
      expect(screen.getByTestId('guide-offer').getAttribute('data-offer-state')).toBe('declined'),
    );
    expect(posted('/api/ai/guide/offer/decline')).toHaveLength(1);
    expect(posted('/api/ai/guide/offer/decline')[0]!.body).toEqual({
      sessionId: 's1',
      turnId: 't1',
    });
    // Declining plans nothing: no turn ran for it.
    expect(posted('/api/ai/guide')).toHaveLength(1);
    expect(screen.getByTestId('guide-offer-resume').textContent).toContain('step 2');
  });

  it('Confirm rewrites the address to the offer launch: the turn id, never the request text', async () => {
    handler = offered();
    renderHost({ ...CARD, identifier: 'PROD-82' });
    fireEvent.click(await screen.findByTestId('guide-offer-confirm'));
    const href = decodeURIComponent(window.location.href);
    expect(href).toContain('planFrom=guide-offer');
    expect(href).toContain('planOffer=t1');
    expect(href).not.toContain('SECRET-REQUEST-TEXT');
    // Navigation, not a write: the rail made no planning request of its own.
    expect(sent.filter((r) => /plan/.test(r.path) && r.method === 'POST')).toEqual([]);
  });

  it('a refused decline (the offer was already decided) speaks in the closed words', async () => {
    handler = offered((method, path) =>
      method === 'POST' && path === '/api/ai/guide/offer/decline'
        ? json({ code: 'GUIDE_REPLAN_OFFER_NOT_OPEN' }, 409)
        : undefined,
    );
    renderHost({ ...CARD, identifier: 'PROD-83' });
    fireEvent.click(await screen.findByTestId('guide-offer-decline'));
    await waitFor(() => expect(screen.getByTestId('guide-error').textContent).toContain('decided'));
    expect(screen.getByTestId('guide-offer').getAttribute('data-offer-state')).toBe('undecided');
  });

  it('Motir AI not configured: the reason line, no Confirm, Decline stays', async () => {
    const base = offered();
    handler = (method, path, body) =>
      method === 'POST' && path === '/api/ai/guide'
        ? json({
            outcome: 'guiding',
            jobId: 'job-1',
            turnId: 't0',
            started: true,
            session: thread([OPENING]),
            planning: { canPlan: false, reason: 'ai_not_configured' },
          })
        : base(method, path, body);
    renderHost({ ...CARD, identifier: 'PROD-84' });
    expect((await screen.findByTestId('guide-offer-cannot-plan')).textContent).toContain(
      'isn’t set up',
    );
    expect(screen.queryByTestId('guide-offer-confirm')).toBeNull();
    expect(screen.getByTestId('guide-offer-decline')).toBeTruthy();
  });
});
