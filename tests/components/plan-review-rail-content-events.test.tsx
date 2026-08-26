// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import type { PlanHistoryEventDto, PlanReviewDto } from '@/lib/dto/planReview';

// The review rail's timeline, once it carries CONTENT events (Story MOTIR-3532 ·
// Subtask MOTIR-3536) — the render half of
// `design/ai-planning/design-notes.md` Part X.
//
// What is pinned here is the ASSET's decisions, not the component's current
// shape: one sequence and one row grammar (§2), which party a row names and that
// an agent is never styled as a person (§4), a collapsed run reading as a span
// (§5), and — the assertion every pre-existing plan depends on — a plan with NO
// content rows rendering exactly as it did before this shipped (§6).

afterEach(cleanup);

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned',
    title: "A plan's timeline",
    summary: null,
    itemCount: 5,
    createdAt: '2026-08-26T08:23:10.000Z',
    plannedAt: '2026-08-26T08:26:13.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    ...over,
  };
}

function renderRail(over: Partial<PlanReviewDto> = {}) {
  return renderWithIntl(
    <PlanReviewRail
      review={review(over)}
      onApprove={() => {}}
      onDecline={() => {}}
      busy={false}
      errorCode={null}
    />,
  );
}

/** The timeline's rows, in order, as the flattened text a reader sees. */
function rows(): string[] {
  const list = screen.getAllByRole('list')[0]!;
  return within(list)
    .getAllByRole('listitem')
    .map((li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

const LIFECYCLE: PlanHistoryEventDto[] = [
  { id: 'lifecycle:created', kind: 'created', at: '2026-08-26T08:23:10.000Z' },
  { id: 'lifecycle:planned', kind: 'planned', at: '2026-08-26T08:26:13.000Z' },
];

describe('a CONTENT row reads in the same grammar as a lifecycle row', () => {
  it('renders the count, the noun and the actor on one clause', () => {
    renderRail({
      history: [
        LIFECYCLE[0]!,
        {
          id: 'rev_1',
          kind: 'appended',
          at: '2026-08-26T08:23:40.000Z',
          count: 6,
          actorSource: 'mcp',
          actorHarness: 'Claude Code',
          actorModel: 'claude-opus-5',
        },
        LIFECYCLE[1]!,
      ],
    });

    expect(rows()[1]).toContain('6 proposals appended');
    expect(rows()[1]).toContain('· Claude Code');
  });

  it('singularises a one-proposal event', () => {
    renderRail({
      history: [{ id: 'rev_1', kind: 'edited', at: '2026-08-26T08:24:00.000Z', count: 1 }],
    });
    expect(rows()[0]).toContain('1 proposal edited');
  });

  it('keeps ONE list — content and lifecycle rows are not two blocks', () => {
    renderRail({
      history: [
        LIFECYCLE[0]!,
        { id: 'rev_1', kind: 'appended', at: '2026-08-26T08:23:40.000Z', count: 2 },
        LIFECYCLE[1]!,
      ],
    });
    // Three events plus the pending row, all in the SAME <ol>.
    expect(rows()).toHaveLength(4);
    expect(rows()[0]).toContain('Generation started');
    expect(rows()[2]).toContain('Plan ready');
  });
});

describe('the actor — an agent is named, and is never styled as a person', () => {
  it('names the HARNESS for an `mcp` actor, and no model on the row', () => {
    renderRail({
      history: [
        {
          id: 'rev_1',
          kind: 'appended',
          at: '2026-08-26T08:23:40.000Z',
          count: 3,
          actorSource: 'mcp',
          actorHarness: 'Claude Code',
          actorModel: 'claude-opus-5',
        },
      ],
    });
    expect(rows()[0]).toContain('· Claude Code');
    // The MODEL costs every row a second line at the rail's width, so it rides
    // the title rather than the clause.
    expect(rows()[0]).not.toContain('claude-opus-5');
    expect(screen.getByTitle('claude-opus-5')).toBeTruthy();
  });

  it('names Motir for a `native` actor', () => {
    renderRail({
      history: [
        {
          id: 'rev_1',
          kind: 'appended',
          at: '2026-08-26T08:23:40.000Z',
          count: 1,
          actorSource: 'native',
        },
      ],
    });
    expect(rows()[0]).toContain('· Motir');
  });

  it('carries NO avatar or initial disc on any timeline row — the disc is the human’s mark', () => {
    const { container } = renderRail({
      history: [
        {
          id: 'rev_1',
          kind: 'appended',
          at: '2026-08-26T08:23:40.000Z',
          count: 1,
          byName: 'Zhu Yue',
        },
      ],
    });
    const list = container.querySelector('ol')!;
    expect(list.querySelector('img')).toBeNull();
    // The header's disc is a rounded-full ink chip; nothing like it is in the list.
    expect(list.querySelector('.rounded-full:not([class*="size-1.5"])')).toBeNull();
    expect(rows()[0]).toContain('· Zhu Yue');
  });

  it('omits the actor clause entirely when nobody acted — never the project owner', () => {
    renderRail({
      history: [{ id: 'rev_1', kind: 'appended', at: '2026-08-26T08:23:40.000Z', count: 4 }],
    });
    expect(rows()[0]).toContain('4 proposals appended');
    expect(rows()[0]).not.toContain('·');
  });
});

describe('a collapsed run reads as a SPAN in the timestamp slot', () => {
  it('renders `from – to` and no second line, badge or chip', () => {
    renderRail({
      history: [
        {
          id: 'rev_1',
          kind: 'edited',
          at: '2026-08-26T08:24:00.000Z',
          until: '2026-08-26T08:26:00.000Z',
          count: 6,
          actorSource: 'mcp',
          actorHarness: 'Claude Code',
        },
      ],
    });
    const row = rows()[0]!;
    expect(row).toContain('6 proposals edited');
    expect(row).toMatch(/Aug 26, 2026, 8:24 AM – Aug 26, 2026, 8:26 AM/);
  });
});

describe('the LEGACY plan — no content rows, and no visual change at all', () => {
  it('renders exactly the four-event timeline it rendered before this shipped', () => {
    renderRail({
      status: 'approved',
      decidedAt: '2026-08-26T09:02:44.000Z',
      decidedByName: 'Zhu Yue',
      history: [
        LIFECYCLE[0]!,
        LIFECYCLE[1]!,
        {
          id: 'lifecycle:approved',
          kind: 'approved',
          at: '2026-08-26T09:02:44.000Z',
          byName: 'Zhu Yue',
        },
      ],
    });

    expect(rows()).toEqual([
      'Generation startedAug 26, 2026, 8:23 AM',
      'Plan readyAug 26, 2026, 8:26 AM',
      'Approved · Zhu YueAug 26, 2026, 9:02 AM',
    ]);
  });

  it('adds NO empty state, placeholder or caption for a plan with no content rows', () => {
    renderRail({ history: LIFECYCLE });
    // Three rows: the two lifecycle events and the shipped pending row. Nothing
    // apologises for the absence, because nothing is missing.
    expect(rows()).toHaveLength(3);
    expect(rows()[2]).toContain('Awaiting your review');
    expect(screen.queryByText(/no changes/i)).toBeNull();
  });
});

describe('the row KEY is the event, not its kind', () => {
  it('renders repeated kinds without a duplicate-key warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderRail({
      history: [
        { id: 'rev_1', kind: 'appended', at: '2026-08-26T08:23:40.000Z', count: 1 },
        { id: 'rev_2', kind: 'appended', at: '2026-08-26T08:23:50.000Z', count: 1 },
        { id: 'rev_3', kind: 'appended', at: '2026-08-26T08:24:00.000Z', count: 1 },
      ],
    });

    expect(rows()).toHaveLength(4);
    // The measurement that produced this change: the shipped rail keyed rows by
    // `kind`, and three `appended` rows logged "Encountered two children with the
    // same key". A per-event id is what removes it.
    const warnings = spy.mock.calls.map((c) => String(c[0] ?? ''));
    expect(warnings.filter((w) => w.includes('same key'))).toEqual([]);
    spy.mockRestore();
  });
});
