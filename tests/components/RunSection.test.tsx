// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunSection } from '@/app/(authed)/items/[key]/_components/RunSection';
import type { DispatchRunDto, DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';

// THE RUN SECTION (Story MOTIR-1789 · MOTIR-1796) — the panel that shows what
// an agent did to THIS card.
//
// ⚠️ THE FIRST DESCRIBE IS THE LOAD-BEARING ONE, and it asserts an ABSENCE.
// `design/runs/design-notes.md` § The CONNECTION decides that the section opens
// no stream unless this card has a LIVE run, because the obvious implementation
// — subscribe on mount — opens one on every item page anyone opens, on the most
// visited surface in the product, for cards that are overwhelmingly not being
// worked. Nothing about a page that wrongly holds a connection LOOKS wrong: it
// renders correctly, it passes every other assertion here, and the cost is
// invisible until somebody counts sockets. So the test counts requests.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every request this render made, as URLs. */
const requested = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));
const streamCalls = (): string[] => requested().filter((u) => u.includes('/stream'));

function run(over: Partial<DispatchRunDto> = {}): DispatchRunDto {
  return {
    id: 'run_1',
    projectId: 'prj_1',
    command: 'run',
    origin: 'local',
    scopeWorkItemId: null,
    scopeLabel: null,
    status: 'succeeded',
    stopReason: 'drained',
    agent: 'claude',
    model: 'claude-opus-5',
    startedAt: '2026-08-29T14:02:11.000Z',
    endedAt: '2026-08-29T14:23:11.000Z',
    createdById: 'usr_1',
    seq: 12,
    cards: [
      {
        id: 'leg_1',
        key: 'PROD-42',
        workItemId: 'itm_1',
        position: 0,
        disposition: 'implemented',
        skipReason: null,
        sessionBranch: null,
        startedAt: '2026-08-29T14:02:11.000Z',
        endedAt: '2026-08-29T14:23:11.000Z',
        exitCode: 0,
      },
    ],
    ...over,
  };
}

const times = (runs: DispatchRunDto[]) =>
  Object.fromEntries(runs.map((r) => [r.id, '29 Aug, 14:02 UTC']));

function mount(runs: DispatchRunDto[], cursor: string | null = null) {
  return render(
    <RunSection
      initialRuns={runs}
      initialCursor={cursor}
      itemKey="PROD-42"
      formattedTimes={times(runs)}
    />,
  );
}

describe('⚠️ it opens NO stream unless this card has a LIVE run', () => {
  it('a card that has never run opens nothing', async () => {
    mount([]);
    await Promise.resolve();
    expect(streamCalls()).toEqual([]);
    expect(requested()).toEqual([]);
  });

  it('a card whose every run has FINISHED opens nothing', async () => {
    // The commonest state on the busiest page in the product: a card that was
    // worked at some point and is not being worked now.
    mount([run({ status: 'succeeded' }), run({ id: 'run_0', status: 'failed' })]);
    await Promise.resolve();
    expect(streamCalls()).toEqual([]);
  });

  it('a TIMED-OUT run opens nothing — the reap wrote it, the process is gone', async () => {
    // The trap in this row: the run never reported a clean ending, so a naive
    // "is it finished?" written as `endedAt !== null` or `stopReason !== null`
    // reads it as still going and reconnects for ever.
    mount([run({ status: 'timed_out', stopReason: 'abandoned', endedAt: null })]);
    await Promise.resolve();
    expect(streamCalls()).toEqual([]);
  });

  it('a RUNNING run opens exactly one stream, resuming from its seq', async () => {
    mount([run({ status: 'running', stopReason: null, endedAt: null, seq: 12 })]);
    await Promise.resolve();
    expect(streamCalls()).toHaveLength(1);
    expect(streamCalls()[0]).toContain('/api/dispatch-runs/run_1/stream');
    // ⚠️ RESUMING, not replaying: the cursor is the run's own `seq`, and the
    // schema's `@@unique([dispatchRunId, seq])` is what makes that neither a
    // gap nor a duplicate.
    expect(streamCalls()[0]).toContain('since=12');
  });
});

describe('the states the design draws', () => {
  it('the empty state reads as “nothing has run”, never as an error', async () => {
    mount([]);
    expect(screen.getByText('Nothing has run yet.')).toBeTruthy();
    // No alert role, no danger copy — an absent run is not a failure.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the leg’s disposition and the run’s status as SEPARATE facts', () => {
    mount([run()]);
    // Two different questions with two different answers: what happened to THIS
    // CARD (`implemented` — its own pull request is open) and what happened to
    // the RUN (`succeeded` — it drained its ready set). A surface that showed
    // one of them would be answering the other by implication.
    expect(screen.getByText('Implemented')).toBeTruthy();
    // ⚠️ TWICE, and that is the design rather than a duplicate: the run's status
    // is in the header AND on its history row, because THE FIRST HISTORY ROW IS
    // THE CURRENT RUN — which is exactly why there is no second "latest run"
    // read to keep in step with this one.
    expect(screen.getAllByText('Succeeded')).toHaveLength(2);
  });

  it('a SKIPPED leg always carries its reason — a bare “skipped” says nothing', () => {
    mount([
      run({
        cards: [
          {
            ...run().cards[0]!,
            disposition: 'skipped',
            skipReason: 'blocked_in_scope',
            endedAt: null,
          },
        ],
      }),
    ]);
    expect(screen.getByText(/blockers inside this scope did not land/i)).toBeTruthy();
  });

  it('a re-planned run is drawn as a SUCCESS, with the leg saying it was refused', () => {
    mount([
      run({
        status: 'succeeded',
        stopReason: 'replanned',
        cards: [{ ...run().cards[0]!, disposition: 'replanned' }],
      }),
    ]);
    // The run SUCCEEDED — the service derives status from the stop reason and
    // only `halted` is a failure, so an agent that refused its card and
    // submitted a plan did the right thing. The LEG is what says it was refused.
    expect(screen.getAllByText('Succeeded').length).toBeGreaterThan(0);
    expect(screen.getByText('Re-planned')).toBeTruthy();
  });

  it('a REPORTING-OFFLINE run says the RECORD is incomplete, not the run', () => {
    mount([run({ status: 'timed_out', stopReason: 'abandoned', endedAt: null })]);
    expect(screen.getByText(/record is incomplete, not the run/i)).toBeTruthy();
  });
});

describe('the line that says this card is one of N', () => {
  it('appears when the run covers more than this card, and links to the run', () => {
    const many = run({
      cards: [
        run().cards[0]!,
        { ...run().cards[0]!, id: 'leg_2', key: 'PROD-43', position: 1 },
        { ...run().cards[0]!, id: 'leg_3', key: 'PROD-44', position: 2 },
      ],
    });
    mount([many]);
    expect(screen.getByText(/1 of 3/)).toBeTruthy();
    // `design/runs/design-notes.md` § The DEEP LINK is `/runs?run=<id>`: the run
    // view is a modal over the runs index, not a route, so `/runs/<id>` is a 404
    // (bug MOTIR-5398 — this assertion used to pin that 404).
    const link = screen.getByRole('link', { name: /See the whole run/ });
    expect(link.getAttribute('href')).toBe('/runs?run=run_1');
  });

  it('URI-encodes the run id in the deep link', () => {
    const odd = run({
      id: 'run 1/&x',
      cards: [run().cards[0]!, { ...run().cards[0]!, id: 'leg_2', key: 'PROD-43', position: 1 }],
    });
    mount([odd]);
    const link = screen.getByRole('link', { name: /See the whole run/ });
    expect(link.getAttribute('href')).toBe('/runs?run=run%201%2F%26x');
  });

  it('does NOT appear for a set of one — there is no other card to discover', () => {
    mount([run()]);
    expect(screen.queryByText(/ of 1 in this run/)).toBeNull();
    expect(screen.queryByRole('link', { name: /See the whole run/ })).toBeNull();
  });
});

describe('every run-history row opens that run', () => {
  it('links each row to the run modal at `/runs?run=<id>`, never a `/runs/<id>` route', () => {
    const older = run({ id: 'run_0', command: 'batch' });
    mount([run(), older]);
    expect(screen.getByRole('link', { name: 'motir run' }).getAttribute('href')).toBe(
      '/runs?run=run_1',
    );
    expect(screen.getByRole('link', { name: 'motir batch' }).getAttribute('href')).toBe(
      '/runs?run=run_0',
    );
  });
});

// ── THE SCOPE BLOCK (Story MOTIR-5363 · design MOTIR-5402 panels 1–3) ────────
//
// ⚠️ A CONTAINER THAT WAS RUN AS A SCOPE HAS NO LEG OF ITS OWN, so its leg
// history is empty — and the empty state used to say *No runs yet* on the one
// page a person opens to ask what happened to that story.

function scoped(over: Partial<DispatchRunListItemDto> = {}): DispatchRunListItemDto {
  return {
    id: 'run_s',
    command: 'run',
    origin: 'local',
    scopeWorkItemId: 'itm_1',
    scopeLabel: 'PROD-42',
    status: 'succeeded',
    stopReason: 'drained',
    agent: 'claude',
    model: 'opus-5',
    startedAt: '2026-08-29T14:02:11.000Z',
    endedAt: '2026-08-29T14:40:11.000Z',
    createdById: 'usr_1',
    cardCount: 3,
    legs: {
      queued: 0,
      running: 0,
      integrated: 0,
      implemented: 2,
      failed: 0,
      replanned: 0,
      skipped: 1,
      not_reached: 0,
    },
    ...over,
  };
}

function mountWithScope(runs: DispatchRunDto[], scopeRun: DispatchRunListItemDto | null) {
  return render(
    <RunSection
      initialRuns={runs}
      initialCursor={null}
      itemKey="PROD-42"
      formattedTimes={times(runs)}
      scopeRun={scopeRun}
      scopeRunTime="29 Aug, 14:02 UTC"
    />,
  );
}

describe('⚠️ a container run as a SCOPE is not “nothing has run”', () => {
  it('scope only: no empty state, the block, the row and the door', () => {
    mountWithScope([], scoped());
    expect(screen.queryByText('Nothing has run yet.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Run as a scope' })).toBeTruthy();
    expect(screen.getByText('An agent worked this work item’s children as one run.')).toBeTruthy();
    // The row's outcome is the index's own sentence, not a second wording of it.
    expect(screen.getByText(/2 of 3 done · 1 skipped/)).toBeTruthy();
    // Both links KEEP the scope: the row opens the run over the narrowed list.
    expect(screen.getByRole('link', { name: 'motir run' }).getAttribute('href')).toBe(
      '/runs?scope=PROD-42&run=run_s',
    );
    expect(
      screen.getByRole('link', { name: 'See every run of PROD-42 →' }).getAttribute('href'),
    ).toBe('/runs?scope=PROD-42');
    // No step timeline — steps belong to a LEG, and this item has none.
    expect(screen.queryByText('Claimed')).toBeNull();
  });

  it('a LIVE scoped run says so, and still opens NO stream from this section', async () => {
    mountWithScope([], scoped({ status: 'running', stopReason: null, endedAt: null }));
    expect(
      screen.getByText('An agent is working this work item’s children as one run.'),
    ).toBeTruthy();
    await Promise.resolve();
    // Watching a scoped run live is the modal's job, one click away.
    expect(requested()).toEqual([]);
  });

  it('BOTH: the leg content comes first and is unchanged, the block follows', () => {
    mountWithScope([run()], scoped({ id: 'run_s2' }));
    const html = document.body.innerHTML;
    expect(screen.getByText('Implemented')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Run as a scope' })).toBeTruthy();
    expect(html.indexOf('Run as a scope')).toBeGreaterThan(html.indexOf('Implemented'));
    expect(
      screen.getByRole('link', { name: 'See every run of PROD-42 →' }).getAttribute('href'),
    ).toBe('/runs?scope=PROD-42');
  });

  it('NEITHER: the shipped empty state, and no block', () => {
    mountWithScope([], null);
    expect(screen.getByText('Nothing has run yet.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Run as a scope' })).toBeNull();
  });
});

describe('it renders no pull request and derives no CI state', () => {
  it('shows no PR number and no CI verdict — those are the Development section’s', () => {
    // The section names a pull request as an EVENT in its timeline and draws no
    // state for it. A second CI verdict on one page is how a person ends up with
    // two answers to *is it green*.
    mount([run()]);
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/#\d{3,}/);
    expect(html.toLowerCase()).not.toContain('checks passed');
    expect(html.toLowerCase()).not.toContain('ci ');
  });
});
