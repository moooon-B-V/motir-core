// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import type { RoadmapLevelData, RoadmapLevelItem } from '@/lib/planning/roadmapClient';

// The roadmap LEVEL → canvas-node adapter, focused on the Subtask 7.20.6 /
// MOTIR-1013 markers it adds for the persistent roadmap: the planning-origin
// cluster at the road's start, the "you are here" current-position marker, and
// the per-container progress meter passed through to each node. (The cross-story
// ghost-anchor behaviour is covered by WorkItemRoadmap.test.) No jest-dom — plain
// vitest assertions + getAttribute.

afterEach(() => cleanup());

function item(over: Partial<RoadmapLevelItem> & { id: string }): RoadmapLevelItem {
  return {
    parentId: null,
    identifier: over.id,
    title: `Title ${over.id}`,
    kind: 'epic',
    status: 'todo',
    hasChildren: false,
    progress: null,
    ...over,
  };
}

function level(items: RoadmapLevelItem[]): RoadmapLevelData {
  return { items, edges: [], offLevelBlockers: [] };
}

const ORIGIN_ID = '__planning_origin__';

describe('buildWorkItemLevel — roadmap markers (MOTIR-1013)', () => {
  it('pins the planning-origin cluster LEFT of the epics when includeOrigin + items exist', () => {
    const { nodes } = buildWorkItemLevel(level([item({ id: 'E1', hasChildren: true })]), {
      includeOrigin: true,
    });
    const origin = nodes.find((n) => n.id === ORIGIN_ID);
    expect(origin).toBeTruthy();
    // Fixed-position (excluded from the auto-layout) and LEFT of the layout origin
    // so the road reads from its completed-planning start; not drillable.
    expect(origin!.x).toBeLessThan(0);
    expect(origin!.drillable).toBeFalsy();
    // It renders the 7.3 stages as milestones.
    render(<>{origin!.content}</>);
    expect(screen.getByTestId('planning-origin')).toBeTruthy();
    expect(screen.getByText('Idea')).toBeTruthy();
    expect(screen.getByText('Plan')).toBeTruthy();
  });

  it('omits the origin without includeOrigin, or when the level has no items', () => {
    expect(
      buildWorkItemLevel(level([item({ id: 'E1' })])).nodes.some((n) => n.id === ORIGIN_ID),
    ).toBe(false);
    expect(
      buildWorkItemLevel(level([]), { includeOrigin: true }).nodes.some((n) => n.id === ORIGIN_ID),
    ).toBe(false);
  });

  it('marks the FIRST in-progress item "you are here" when markActive', () => {
    const { nodes } = buildWorkItemLevel(
      level([
        item({ id: 'E1', status: 'done' }),
        item({ id: 'E2', status: 'in_progress' }),
        item({ id: 'E3', status: 'in_progress' }), // a later in-progress is NOT the marker
      ]),
      { markActive: true },
    );
    const byId = new Map(nodes.map((n) => [n.id, n]));
    render(<>{byId.get('E2')!.content}</>);
    expect(screen.getByText('You are here')).toBeTruthy();
    cleanup();
    render(<>{byId.get('E3')!.content}</>);
    expect(screen.queryByText('You are here')).toBeNull();
  });

  it('does NOT mark "you are here" without markActive (e.g. onboarding)', () => {
    const { nodes } = buildWorkItemLevel(level([item({ id: 'E1', status: 'in_progress' })]));
    render(<>{nodes[0]!.content}</>);
    expect(screen.queryByText('You are here')).toBeNull();
  });

  it('passes a container progress roll-up through to its node meter', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'E1', kind: 'epic', hasChildren: true, progress: { done: 3, total: 4 } })]),
    );
    render(<>{nodes[0]!.content}</>);
    expect(screen.getByTestId('progress-meter')).toBeTruthy();
    expect(screen.getByText('3 / 4')).toBeTruthy();
  });
});

// The off-level dependency signal (MOTIR-1331 cross-story tangle; MOTIR-1379
// sprint validity). In PROJECT scope an off-level blocker is always the bad-plan
// tangle, flagged "blocked elsewhere" (MOTIR-1568 — the label is level-agnostic,
// since one pill can't name a mix of story/epic/bug parents). In SPRINT scope it
// becomes a sprint-validity signal: a DONE or IN-sprint blocker is satisfied (not
// drawn), and only an out-of-sprint, NOT-done blocker is flagged — as "not in
// sprint", not "blocked elsewhere".
function levelWithOffBlocker(stub: {
  isDone?: boolean;
  inActiveSprint?: boolean;
}): RoadmapLevelData {
  return {
    items: [item({ id: 'A1', kind: 'subtask' })],
    edges: [{ blockedId: 'A1', blockerId: 'X' }],
    offLevelBlockers: [
      { id: 'X', identifier: 'PROD-9', title: 'External dep', parentTitle: 'Story Z', ...stub },
    ],
  };
}
const A1_FLAG = 'cross-blocked-flag';

describe('buildWorkItemLevel — off-level dependency signal', () => {
  it('PROJECT scope: an off-level blocker is the bad-plan tangle (red edge + anchor + "blocked elsewhere" flag)', () => {
    const { nodes, deps } = buildWorkItemLevel(levelWithOffBlocker({ isDone: false }));
    expect(deps).toContainEqual({ from: 'X', to: 'A1', variant: 'cross' });
    expect(nodes.some((n) => n.id === 'X')).toBe(true); // ghost anchor
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).textContent).toContain('blocked elsewhere');
  });

  it('SPRINT scope: an out-of-sprint, NOT-done blocker is flagged "not in sprint"', () => {
    const { nodes, deps } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: false }),
      { scope: 'sprint' },
    );
    expect(deps).toContainEqual({ from: 'X', to: 'A1', variant: 'cross' });
    const anchor = nodes.find((n) => n.id === 'X');
    expect(anchor).toBeTruthy();
    render(<>{anchor!.content}</>);
    expect(screen.getByText(/not in this sprint/)).toBeTruthy();
    cleanup();
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).textContent).toContain('not in sprint');
  });

  it('SPRINT scope: a DONE off-level blocker is satisfied — no edge, no anchor, no flag', () => {
    const { nodes, deps } = buildWorkItemLevel(levelWithOffBlocker({ isDone: true }), {
      scope: 'sprint',
    });
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'X')).toBe(false);
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });

  it('SPRINT scope: an IN-sprint off-level blocker is satisfied — no edge, no anchor, no flag', () => {
    const { nodes, deps } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: true }),
      { scope: 'sprint' },
    );
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'X')).toBe(false);
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });
});

// The per-NODE "not in sprint" signal (MOTIR-1379 follow-up). In SPRINT scope the
// root level shows only in-sprint members, but drilling into a committed root
// reveals its WHOLE subtree — so a drilled-in node the sprint did not commit to
// (`inActiveSprint: false`) is rendered with a neutral dashed edge + a "not in
// sprint" tag, keeping the committed unit distinct from the rest of the subtree.
// Never flags in PROJECT scope (no sprint resolved), and never the red chrome.
const NOT_IN_SPRINT_TAG = 'not-in-sprint-tag';

describe('buildWorkItemLevel — not-in-sprint node signal (MOTIR-1379)', () => {
  it('SPRINT scope: a NON-member drilled-in node shows the "not in sprint" tag + card state', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'S1', kind: 'subtask', parentId: 'P1', inActiveSprint: false })]),
      { scope: 'sprint' },
    );
    render(<>{nodes.find((n) => n.id === 'S1')!.content}</>);
    expect(screen.getByTestId(NOT_IN_SPRINT_TAG).textContent).toContain('not in sprint');
    // A neutral, informational state — NOT the red cross-blocked chrome.
    expect(document.querySelector('[data-node-state="not-in-sprint"]')).toBeTruthy();
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });

  it('SPRINT scope: an IN-sprint member is NOT flagged', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'S1', kind: 'subtask', parentId: 'P1', inActiveSprint: true })]),
      { scope: 'sprint' },
    );
    render(<>{nodes.find((n) => n.id === 'S1')!.content}</>);
    expect(screen.queryByTestId(NOT_IN_SPRINT_TAG)).toBeNull();
    expect(document.querySelector('[data-node-state="not-in-sprint"]')).toBeNull();
  });

  it('PROJECT scope: a non-member is NEVER flagged (the flag is sprint-scope only)', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'S1', kind: 'subtask', parentId: 'P1', inActiveSprint: false })]),
    );
    render(<>{nodes.find((n) => n.id === 'S1')!.content}</>);
    expect(screen.queryByTestId(NOT_IN_SPRINT_TAG)).toBeNull();
    expect(document.querySelector('[data-node-state="not-in-sprint"]')).toBeNull();
  });

  it('a cross-blocked non-member shows ONLY the cross-blocked flag (no double tag)', () => {
    // A1 in levelWithOffBlocker has no `inActiveSprint` → defaults to a non-member;
    // in sprint scope it is BOTH cross-blocked and not-in-sprint. The red flag wins
    // the slot; the neutral tag is suppressed so the card never carries two tags.
    const { nodes } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: false }),
      { scope: 'sprint' },
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).textContent).toContain('not in sprint');
    expect(screen.queryByTestId(NOT_IN_SPRINT_TAG)).toBeNull();
  });
});

describe('buildWorkItemLevel — ready highlight (MOTIR-1417 / MOTIR-1422)', () => {
  it('a ready node shows the "Ready" pill + the card mint wash', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'subtask', status: 'todo', ready: true })]),
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId('ready-pill')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    // The ready signal is now the whole-card wash (MOTIR-1422), not a 3px bar.
    expect(document.querySelector('[data-node-state="ready"]')).toBeTruthy();
  });

  it('a NOT-ready node shows the normal status pill, no ready treatment', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'subtask', status: 'todo', ready: false })]),
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId('ready-pill')).toBeNull();
    expect(document.querySelector('[data-node-state="ready"]')).toBeNull();
  });

  it('the "you are here" frontier suppresses the ready treatment', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'story', status: 'in_progress', ready: true })]),
      { markActive: true },
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByText('You are here')).toBeTruthy();
    expect(screen.queryByTestId('ready-pill')).toBeNull();
    expect(document.querySelector('[data-node-state="ready"]')).toBeNull();
  });

  it('a DONE node shows the neutral "Done" pill + the recessed/done card state (distinct from ready)', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'story', status: 'done', ready: false })]),
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId('done-pill')).toBeTruthy();
    expect(document.querySelector('[data-node-state="done"]')).toBeTruthy();
    expect(document.querySelector('[data-node-state="ready"]')).toBeNull();
  });
});
