// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { mergeHeldRows, arrivedRowIds } from '@/lib/workbench/liveRows';

// THE WORKBENCH, LIVE (Story MOTIR-5238 · Subtask MOTIR-5242) — the client half.
//
// Four of this card's guarantees are invisible to a test that only renders once,
// and each is a defect that ships green without one:
//
//   · ONE CONNECTION with every consumer mounted. Two components each opening
//     their own is "a fan-out wearing a different name" (`useRunEvents.ts`), and
//     nothing about the rendered output would show it — so the assertion counts
//     `fetch` calls to the stream URL rather than inspecting a tree.
//   · A NUDGE RE-READS ONCE, and a frame that names nothing re-reads NOT AT ALL.
//     The opening frame of every connection names nothing; counting it would
//     re-read the page on every reconnect.
//   · A HELD ROW STAYS. The tab reads `state = awaiting`, so a row somebody else
//     decided is absent from the next read and the naive list removes it — § 20's
//     settled rule overturned by a mechanism. Only two prop sets can show it.
//   · RECONNECTING IS NOT LOADING. It says so with the rows at full ink.

const { refresh, push } = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { WorkbenchLive, WorkbenchReconnecting } =
  await import('../../app/(authed)/workbench/_components/WorkbenchLive');
const { ApprovalsList } = await import('../../app/(authed)/workbench/_components/ApprovalsList');
const { WORKBENCH_STREAM_PATH } =
  await import('../../app/(authed)/workbench/_components/useWorkbenchLive');

type Row = import('@/lib/dto/approvalGate').ApprovalQueueRowDto;

function row(gateId: string, key: number, title: string): Row {
  return {
    gateId,
    kind: 'design_result',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Mara S.',
    waitingSince: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    workItem: {
      id: `wi-${key}`,
      key,
      identifier: `MOTIR-${key}`,
      title,
      kind: 'subtask',
      type: 'design',
    },
    subject: {
      kind: 'design_result',
      designEvidenceId: `ev-${key}`,
      producedByKey: `MOTIR-${key}`,
      commitSha: '9840d00ea1b2',
      assetCount: 3,
      noteExcerpt: null,
      publishedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    },
  } as Row;
}

/**
 * A stream under the test's control: `open()` resolves the fetch, `send()`
 * writes one frame, `drop()` ends the body so the hook backs off.
 */
function controllableStream() {
  const calls: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    calls.push(String(input));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    async send(frame: { moved: string[]; cursor: string }) {
      await act(async () => {
        controller?.enqueue(encoder.encode(`event: watermark\ndata: ${JSON.stringify(frame)}\n\n`));
        await Promise.resolve();
      });
    },
    async drop() {
      await act(async () => {
        controller?.close();
        await Promise.resolve();
      });
    },
  };
}

const PAGE = { total: 2, page: 1, pageSize: 25 };

beforeEach(() => {
  refresh.mockClear();
  push.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ONE STREAM, HELD BY THE HOST', () => {
  it('opens exactly ONE connection with every consumer mounted', async () => {
    const stream = controllableStream();

    await act(async () => {
      renderWithIntl(
        <WorkbenchLive>
          {/* Three consumers of the signal, which is more than the surface had
              when the fan-out defect was first paid for. */}
          <WorkbenchReconnecting />
          <WorkbenchReconnecting />
          <ApprovalsList rows={[row('gate-1', 5147, 'One')]} label="To approve" pagination={PAGE} />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    const streamCalls = stream.calls.filter((url) => url.includes(WORKBENCH_STREAM_PATH));
    expect(streamCalls).toHaveLength(1);
  });
});

describe('A NUDGE RE-READS — once, and only when something moved', () => {
  it('does NOT re-read on the opening frame, which names nothing', async () => {
    const stream = controllableStream();
    await act(async () => {
      renderWithIntl(
        <WorkbenchLive>
          <WorkbenchReconnecting />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    await stream.send({ moved: [], cursor: 'w1.aaa' });

    // ⚠️ THE ASSERTION IS ZERO. Every connection opens with a frame that names
    // nothing — it exists to hand the client its cursor — so counting it would
    // re-read the whole page on every reconnect, for ever.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('re-reads ONCE per frame that names a tab', async () => {
    const stream = controllableStream();
    await act(async () => {
      renderWithIntl(
        <WorkbenchLive>
          <WorkbenchReconnecting />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    await stream.send({ moved: [], cursor: 'w1.aaa' });
    await stream.send({ moved: ['approvals'], cursor: 'w1.bbb' });
    expect(refresh).toHaveBeenCalledTimes(1);

    // A SECOND frame naming the SAME tab is a second change, not a repeat — the
    // watermark moved again, so the surface is stale again.
    await stream.send({ moved: ['approvals'], cursor: 'w1.ccc' });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('RECONNECTING says so — and is not a loading state', () => {
  it('appears when the connection drops and the rows keep their ink', async () => {
    const stream = controllableStream();
    await act(async () => {
      renderWithIntl(
        <WorkbenchLive>
          <WorkbenchReconnecting />
          <ApprovalsList
            rows={[row('gate-1', 5147, 'Still perfectly readable')]}
            label="To approve"
            pagination={PAGE}
          />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });
    expect(screen.queryByTestId('workbench-reconnecting')).toBeNull();

    await stream.drop();

    expect(screen.getByTestId('workbench-reconnecting')).toBeTruthy();
    // ⚠️ THE ROWS ARE STILL THERE, AT FULL INK. Reconnecting means *what you can
    // see is real and may be a few seconds old* — the opposite claim from
    // loading, which means *there is nothing here yet*. A skeleton, a pulse or a
    // greyed list would be saying the wrong one.
    expect(screen.getByText('Still perfectly readable')).toBeTruthy();
    expect(screen.queryByText('Loading')).toBeNull();
  });
});

describe('THE HELD ROW — § 20’s settled rule survives a live re-read', () => {
  it('KEEPS a row the re-read dropped, in place, and says it was decided elsewhere', async () => {
    controllableStream();
    const first = [row('gate-1', 5147, 'The first'), row('gate-2', 4942, 'The second')];
    let view!: ReturnType<typeof renderWithIntl>;
    await act(async () => {
      view = renderWithIntl(
        <WorkbenchLive>
          <ApprovalsList rows={first} label="To approve" pagination={PAGE} />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    // The re-read: somebody else decided `gate-2`, so the server no longer
    // returns it. The naive list removes the row; this one must not.
    await act(async () => {
      view.rerender(
        <WorkbenchLive>
          <ApprovalsList rows={[first[0]!]} label="To approve" pagination={{ ...PAGE, total: 1 }} />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    expect(screen.getByTestId('approval-row-gate-2')).toBeTruthy();
    expect(screen.getByText('Decided elsewhere')).toBeTruthy();
    // And it kept its POSITION: a held row that jumped to the bottom is the same
    // disappearance in a different costume.
    const ids = screen
      .getAllByRole('row')
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string => id !== null && id.startsWith('approval-row-'));
    expect(ids).toEqual(['approval-row-gate-1', 'approval-row-gate-2']);
  });

  it('marks a row that ARRIVED, and marks nothing on the first reading', async () => {
    controllableStream();
    const first = [row('gate-1', 5147, 'The first')];
    let view!: ReturnType<typeof renderWithIntl>;
    await act(async () => {
      view = renderWithIntl(
        <WorkbenchLive>
          <ApprovalsList rows={first} label="To approve" pagination={PAGE} />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });
    // NOTHING is new to a reader who has just landed.
    expect(screen.queryByText('New')).toBeNull();

    await act(async () => {
      view.rerender(
        <WorkbenchLive>
          <ApprovalsList
            rows={[...first, row('gate-9', 5239, 'Arrived under the reader')]}
            label="To approve"
            pagination={PAGE}
          />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    expect(screen.getByText('New')).toBeTruthy();
  });

  it('DROPS its held rows on a LOAD — a pager move is not a nudge', async () => {
    controllableStream();
    const first = [row('gate-1', 5147, 'The first'), row('gate-2', 4942, 'The second')];
    let view!: ReturnType<typeof renderWithIntl>;
    await act(async () => {
      view = renderWithIntl(
        <WorkbenchLive>
          <ApprovalsList rows={first} label="To approve" pagination={PAGE} />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      view.rerender(
        <WorkbenchLive>
          <ApprovalsList rows={[first[0]!]} label="To approve" pagination={PAGE} />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId('approval-row-gate-2')).toBeTruthy();

    // PAGE 2 — a view the reader asked for. § 26: a held row leaves on the next
    // LOAD, which is exactly this.
    await act(async () => {
      view.rerender(
        <WorkbenchLive>
          <ApprovalsList
            rows={[row('gate-7', 5008, 'Page two')]}
            label="To approve"
            pagination={{ ...PAGE, page: 2 }}
          />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    expect(screen.queryByTestId('approval-row-gate-2')).toBeNull();
    expect(screen.queryByText('Decided elsewhere')).toBeNull();
  });
});

describe('the RULE itself, without React', () => {
  const id = (r: { id: string }) => r.id;

  it('holds a dropped row IN PLACE and splices arrivals at their own position', () => {
    const previous = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const incoming = [{ id: 'a' }, { id: 'c' }, { id: 'd' }];
    const { rows, heldIds } = mergeHeldRows(previous, incoming, id);

    expect(rows.map(id)).toEqual(['a', 'b', 'c', 'd']);
    expect([...heldIds]).toEqual(['b']);
  });

  it('takes the server’s version of a row it still returns', () => {
    const previous = [{ id: 'a', title: 'old' }];
    const incoming = [{ id: 'a', title: 'new' }];
    expect(mergeHeldRows(previous, incoming, id).rows[0]!.title).toBe('new');
  });

  it('names no arrivals on a first reading, and only the new ones after', () => {
    expect([...arrivedRowIds(null, [{ id: 'a' }], id)]).toEqual([]);
    expect([...arrivedRowIds([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }], id)]).toEqual(['b']);
  });
});
