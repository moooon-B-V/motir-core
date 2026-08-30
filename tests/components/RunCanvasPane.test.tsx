// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunCanvasPane } from '@/app/(authed)/runs/_components/RunCanvasPane';
import type { RoadmapLevel } from '@/components/planning/ProjectRoadmapCanvas';
import type { DispatchRunCardDto, DispatchRunDto } from '@/lib/dto/dispatchRuns';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';

// THE RUN'S SET ON THE SHARED CANVAS (Story MOTIR-1789 · MOTIR-3895).
//
// ⚠️ THIS FILE DRIVES `loadLevel` DIRECTLY rather than asserting on pixels, and
// that is deliberate. The failure it is written against — bug MOTIR-3152 — is
// INVISIBLE, not red: a level built by casting a wire DTO renders every node
// into a 0x0 box, so a DOM assertion sees an element and passes while the canvas
// shows nothing. What distinguishes a good level from that one is the SHAPE of
// what `loadLevel` returns, so that is what is measured.
//
// The canvas is captured rather than rendered: it measures its own container,
// which happy-dom has no layout for.

let captured: {
  loadLevel: (parentId: string | null) => Promise<RoadmapLevel>;
  searchable?: boolean;
  fullScreenable?: boolean;
  locatable?: boolean;
  reloadKey?: number;
} | null = null;

vi.mock('@/components/planning/ProjectRoadmapCanvas', () => ({
  ProjectRoadmapCanvas: (props: {
    loadLevel: (parentId: string | null) => Promise<RoadmapLevel>;
  }) => {
    captured = props;
    return <div data-testid="canvas" />;
  },
}));

const fetchRoadmapLevel = vi.fn();
vi.mock('@/lib/planning/roadmapClient', () => ({
  fetchRoadmapLevel: (...args: unknown[]) => fetchRoadmapLevel(...args),
}));

beforeEach(() => {
  captured = null;
  fetchRoadmapLevel.mockReset();
});
afterEach(cleanup);

/** Two work items under DIFFERENT parents, one blocking the other. */
function roadmap(): RoadmapLevelData {
  return {
    items: [
      {
        id: 'wi_a',
        parentId: 'story_1',
        identifier: 'MOTIR-1791',
        title: 'The ingest route',
        kind: 'subtask',
        status: 'in_progress',
        statusLabel: 'In Progress',
        statusCategory: 'in_progress',
        hasChildren: false,
      },
      {
        id: 'wi_b',
        // ⚠️ A DIFFERENT PARENT — the batch shape, and the one that used to turn
        // the running edge into a `cross` flag.
        parentId: 'story_2',
        identifier: 'MOTIR-1793',
        title: 'The run modal',
        kind: 'subtask',
        status: 'todo',
        statusLabel: 'To Do',
        statusCategory: 'todo',
        hasChildren: false,
      },
    ] as RoadmapLevelData['items'],
    edges: [{ blockerId: 'wi_a', blockedId: 'wi_b' }],
    offLevelBlockers: [],
  };
}

function leg(over: Partial<DispatchRunCardDto> = {}): DispatchRunCardDto {
  return {
    id: 'leg',
    key: 'MOTIR-1791',
    workItemId: 'wi_a',
    position: 0,
    disposition: 'running',
    skipReason: null,
    sessionBranch: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    ...over,
  };
}

function run(cards: DispatchRunCardDto[]): DispatchRunDto {
  return {
    id: 'run_1',
    projectId: 'prj',
    command: 'batch',
    origin: 'local',
    scopeWorkItemId: null,
    scopeLabel: null,
    status: 'running',
    stopReason: null,
    agent: 'claude',
    model: null,
    startedAt: '2026-08-30T14:02:00.000Z',
    endedAt: null,
    createdById: null,
    cards,
    seq: 3,
  };
}

async function levelFor(cards: DispatchRunCardDto[]): Promise<RoadmapLevel> {
  fetchRoadmapLevel.mockResolvedValue(roadmap());
  render(
    <RunCanvasPane run={run(cards)} projectKey="MOTIR" onSelectWorkItem={vi.fn()} reloadKey={0} />,
  );
  await act(async () => {});
  return captured!.loadLevel(null);
}

describe('⚠️ the MOTIR-3152 shape — every node is BUILT, never cast', () => {
  it('every node carries non-empty content and a defined drillable', async () => {
    const level = await levelFor([
      leg(),
      leg({ id: 'leg2', key: 'MOTIR-1793', workItemId: 'wi_b', disposition: 'queued' }),
    ]);

    expect(level.nodes).toHaveLength(2);
    for (const n of level.nodes) {
      // The two fields a cast silently leaves undefined. `content` undefined is
      // the 0x0 box; `drillable` undefined is the missing way down.
      expect(n.content).toBeTruthy();
      expect(typeof n.drillable).toBe('boolean');
      expect(n.searchText).toBeTruthy();
    }
  });

  it('asks for the run’s MEMBERS by id, in the run’s own stored order', async () => {
    await levelFor([
      leg({ id: 'l1', workItemId: 'wi_b', position: 0 }),
      leg({ id: 'l2', workItemId: 'wi_a', position: 1 }),
    ]);

    const call = fetchRoadmapLevel.mock.calls.at(-1)!;
    // (projectKey, parentId, scope, signal, all, ids)
    expect(call[1]).toBeNull();
    expect(call[5]).toEqual(['wi_b', 'wi_a']);
  });

  it('a leg whose work item was DELETED asks for nothing on its behalf', async () => {
    await levelFor([leg(), leg({ id: 'l2', workItemId: null })]);
    expect(fetchRoadmapLevel.mock.calls.at(-1)![5]).toEqual(['wi_a']);
  });
});

describe('⚠️ THE RUNNING EDGE — only from what is being worked, and only while it is', () => {
  it('marks the edge FROM the running work item to the one it blocks', async () => {
    const level = await levelFor([
      leg({ workItemId: 'wi_a', disposition: 'running' }),
      leg({ id: 'l2', workItemId: 'wi_b', disposition: 'queued' }),
    ]);

    expect(level.deps).toHaveLength(1);
    expect(level.deps[0]).toMatchObject({ from: 'wi_a', to: 'wi_b', variant: 'running' });
  });

  it('a FINISHED run is a still graph — no edge flows', async () => {
    const level = await levelFor([
      leg({ workItemId: 'wi_a', disposition: 'implemented' }),
      leg({ id: 'l2', workItemId: 'wi_b', disposition: 'implemented' }),
    ]);

    expect(level.deps.some((d) => d.variant === 'running')).toBe(false);
  });

  it('an edge INTO the running work item does not flow — direction is the signal', async () => {
    // `wi_b` is running and `wi_a` blocks it: the edge runs a→b, so it points AT
    // the running node rather than out of it. Nothing flows.
    const level = await levelFor([
      leg({ workItemId: 'wi_a', disposition: 'implemented' }),
      leg({ id: 'l2', workItemId: 'wi_b', disposition: 'running' }),
    ]);

    expect(level.deps.some((d) => d.variant === 'running')).toBe(false);
  });

  it('⚠️ members under DIFFERENT parents still flow — the set IS the level', async () => {
    // The regression this guards: `computeLevel` overrides a variant to `cross`
    // when the two ends sit under different parents, which on a batch run they
    // genuinely do — and `cross` wins over `running`. One shared synthetic
    // parent is what stops the one edge this surface exists to show from being
    // repainted as a bad-plan flag.
    const level = await levelFor([
      leg({ workItemId: 'wi_a', disposition: 'running' }),
      leg({ id: 'l2', workItemId: 'wi_b', disposition: 'queued' }),
    ]);

    const parents = new Set(level.nodes.map((n) => n.parentId));
    expect(parents.size).toBe(1);
  });
});

describe('the opt-in canvas props are a decision', () => {
  it('search is on; full-screen is OFF inside a dialog that is already full screen', async () => {
    await levelFor([leg()]);
    expect(captured!.searchable).toBe(true);
    // A Fullscreen-API escalation nested in a modal is two overlays and two ESC
    // handlers — the collision the design flags.
    expect(captured!.fullScreenable).toBeUndefined();
    expect(captured!.locatable).toBeUndefined();
  });
});

describe('a DRILL leaves the run’s set', () => {
  it('reads the ordinary parent level, with no ids and no run facts', async () => {
    await levelFor([leg()]);
    fetchRoadmapLevel.mockClear();
    fetchRoadmapLevel.mockResolvedValue(roadmap());

    const level = await captured!.loadLevel('wi_a');

    const call = fetchRoadmapLevel.mock.calls.at(-1)!;
    expect(call[1]).toBe('wi_a');
    expect(call[5]).toBeUndefined();
    // A child of a member is not itself a member, so it carries no disposition
    // and the level keeps its real parents.
    expect(level.nodes.every((n) => n.parentId !== '__run-level__')).toBe(true);
  });
});
