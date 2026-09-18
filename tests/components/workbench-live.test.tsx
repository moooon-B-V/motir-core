// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { mergeHeldRows, arrivedRowIds } from '@/lib/workbench/liveRows';
import { announceGateDecided } from '@/lib/approvals/decidedGates';

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
    /** A frame exactly as written — including shapes a server would never send. */
    async sendRaw(data: string) {
      await act(async () => {
        controller?.enqueue(encoder.encode(`event: watermark\ndata: ${data}\n\n`));
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

describe('the CONNECTION\u2019s own arms — what a percentage cannot see', () => {
  it('treats a non-OK response as a drop: it says reconnecting and tries again', async () => {
    const calls: string[] = [];
    let attempt = 0;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input));
        attempt += 1;
        // The FIRST connection is refused outright — a 503 from a proxy, the
        // ordinary shape of a deploy. The hook must treat it as a drop rather
        // than as a stream it can read.
        if (attempt === 1) return Promise.resolve(new Response('nope', { status: 503 }));
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                controller = c;
              },
            }),
            { status: 200 },
          ),
        );
      }),
    );

    await act(async () => {
      renderWithIntl(
        <WorkbenchLive>
          <WorkbenchReconnecting />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    expect(screen.getByTestId('workbench-reconnecting')).toBeTruthy();

    // The backoff is real time; the retry lands, and the chip clears.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(calls.length).toBeGreaterThan(1);
    await act(async () => {
      controller?.enqueue(
        encoder.encode(
          `event: watermark\ndata: ${JSON.stringify({ moved: [], cursor: 'w1.x' })}\n\n`,
        ),
      );
      await Promise.resolve();
    });
    expect(screen.queryByTestId('workbench-reconnecting')).toBeNull();
  });

  it('RESUMES from the cursor it was last given', async () => {
    const stream = controllableStream();
    await act(async () => {
      renderWithIntl(
        <WorkbenchLive>
          <WorkbenchReconnecting />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });
    // The first connection carries no `since` — this reader has seen nothing.
    expect(stream.calls[0]).not.toContain('since=');

    await stream.send({ moved: ['toDo'], cursor: 'w1.held' });
    await stream.drop();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    // ⚠️ THE RECONNECT PRESENTS THE WATERMARK, which is what makes it neither a
    // replay nor a gap: the server compares rather than replaying a position.
    expect(stream.calls.at(-1)).toContain(`since=${encodeURIComponent('w1.held')}`);
  });

  it('ignores a frame it cannot read rather than nudging on it', async () => {
    const stream = controllableStream();
    await act(async () => {
      renderWithIntl(
        <WorkbenchLive>
          <WorkbenchReconnecting />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    // A frame whose `moved` is not a list, and one naming a tab that is not a
    // tab. Neither is a nudge: this surface re-reads on what it understands.
    await stream.sendRaw(JSON.stringify({ moved: 'everything', cursor: 'w1.a' }));
    await stream.sendRaw(JSON.stringify({ moved: ['not-a-tab'], cursor: 'w1.b' }));
    expect(refresh).not.toHaveBeenCalled();

    // And a frame with no cursor still nudges — the cursor is how a RECONNECT
    // resumes, not a condition for applying what a frame says.
    await stream.sendRaw(JSON.stringify({ moved: ['toDo'] }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stays reconnecting across a SECOND failure, and backs off further', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        attempts += 1;
        return Promise.resolve(new Response('nope', { status: 503 }));
      }),
    );

    await act(async () => {
      renderWithIntl(
        <WorkbenchLive>
          <WorkbenchReconnecting />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId('workbench-reconnecting')).toBeTruthy();

    // ⚠️ THE SECOND DROP MUST NOT RE-ANNOUNCE. The chip is already up, so the
    // state is left exactly as it is — a surface that re-rendered the whole
    // Workbench on every failed retry would be paying for the outage twice.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(attempts).toBeGreaterThan(1);
    expect(screen.getAllByTestId('workbench-reconnecting')).toHaveLength(1);
  });

  it('ABORTS on unmount — nothing is left reading for a reader who has gone', async () => {
    const stream = controllableStream();
    let view!: ReturnType<typeof renderWithIntl>;
    await act(async () => {
      view = renderWithIntl(
        <WorkbenchLive>
          <WorkbenchReconnecting />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });
    const opened = stream.calls.length;

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });

    // The abort ends the pump; no reconnect is attempted for an unmounted host.
    expect(stream.calls.length).toBe(opened);
  });
});

describe('a row THIS READER decided survives a frame, with its state pill', () => {
  it('keeps the settled row in place when the re-read no longer returns it', async () => {
    controllableStream();
    const rows = [row('gate-1', 5147, 'The first'), row('gate-2', 4942, 'The second')];
    let view!: ReturnType<typeof renderWithIntl>;
    await act(async () => {
      view = renderWithIntl(
        <WorkbenchLive>
          <ApprovalsList rows={rows} label="To approve" pagination={PAGE} />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    // THE READER DECIDES IT — in the overlay, which announces through the store
    // the list watches (`lib/approvals/decidedGates.ts`). The row settles where
    // it is, with the state it reached.
    await act(async () => {
      // The store keys on the GATE's id, which is the row's `gateId`.
      announceGateDecided({
        gate: {
          id: 'gate-2',
          workItemId: 'wi-4942',
          kind: 'design_result',
          state: 'approved',
          subjectId: 'ev-4942',
          subjectVersion: '9840d00ea1b2',
          decidedAt: new Date().toISOString(),
          decidedByLabel: 'Zhu Yue',
          noteMd: null,
          createdAt: new Date().toISOString(),
          outcomeRef: null,
        } as never,
        filesKept: true,
      });
      await Promise.resolve();
    });
    expect(screen.getByText('Approved')).toBeTruthy();

    // NOW THE SERVER RE-READS, and no longer returns it — the tab reads
    // `state = awaiting`. § 20's rule is that the row stays until the next LOAD,
    // and this is the path that would otherwise delete it.
    await act(async () => {
      view.rerender(
        <WorkbenchLive>
          <ApprovalsList rows={[rows[0]!]} label="To approve" pagination={{ ...PAGE, total: 1 }} />
        </WorkbenchLive>,
      );
      await Promise.resolve();
    });

    expect(screen.getByTestId('approval-row-gate-2')).toBeTruthy();
    // ⚠️ AND IT KEEPS THE STATE IT REACHED, not the colourless *Decided
    // elsewhere*: this reader knows what they did, and the announcement is what
    // the row shows. The held treatment is for a row whose outcome this surface
    // never learned.
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByText('Decided elsewhere')).toBeNull();
  });
});
