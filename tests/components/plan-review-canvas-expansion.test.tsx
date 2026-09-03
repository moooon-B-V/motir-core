// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { planReviewItem } from '../helpers/planReview';

// AN EXPANSION, READ ON THE PLAN-DETAIL CANVAS (bug MOTIR-4266).
//
// The commonest thing a planning pass produces is *this story, and these
// subtasks under it* — and until this file the review canvas drew it as a story
// with nothing under it:
//
//   1. `mergePlanLevel` copied the committed node's `drillable` through from the
//      ROADMAP read, which counts COMMITTED children only. A story with nothing
//      under it yet therefore rendered View and NO Open pill, and the subtasks
//      the plan is about were unreachable from the level the story lives on.
//   2. `trailTo` labelled every node id it found in the plan `New`, so the crumb
//      for a story the plan MODIFIES — a card that has a `MOTIR-<n>` — read
//      `New · <title>`, asserting on the review surface that a real card is not
//      real. `design/ai-planning/design-notes.md` Part IX decision 3 puts the
//      word in the key's SLOT only because an un-materialized `add` has no key
//      *"by construction"*; Part XIII names a `modify` `<identifier> · <title>`.
//
// Everything here reads on RENDERED OUTPUT driven through the real `loadLevel`
// seam — the wire `ProjectRoadmapDto` → `fetchRoadmapLevel` → `buildWorkItemLevel`
// → `mergePlanLevel` — for the reason `plan-review-canvas.test.tsx` states: a
// canvas node is a rendering contract, and an id-array assertion held while every
// node was invisible (bug MOTIR-3152).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── The committed tree the stubbed roadmap route serves ──────────────────────
//   root → MOTIR-2200 (epic)
//          ├─ MOTIR-7 (story, NO committed children)   ← the story being expanded
//          └─ MOTIR-8 (story, NO committed children)   ← nothing proposed under it
const EPIC_ID = 'wi_epic';
const STORY_ID = 'wi_story';
const QUIET_ID = 'wi_quiet';

function wireNode(over: Record<string, unknown>) {
  return {
    parentId: null,
    kind: 'subtask',
    type: null,
    executor: null,
    status: 'todo',
    statusLabel: null,
    statusCategory: null,
    isDone: false,
    hasChildren: false,
    progress: null,
    ready: false,
    ...over,
  };
}

const WIRE_LEVELS: Record<string, unknown> = {
  __root__: {
    nodes: [
      wireNode({
        id: EPIC_ID,
        kind: 'epic',
        identifier: 'MOTIR-2200',
        title: 'The Motir agent loop',
        hasChildren: true,
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [EPIC_ID]: {
    nodes: [
      wireNode({
        id: STORY_ID,
        parentId: EPIC_ID,
        kind: 'story',
        identifier: 'MOTIR-7',
        title: 'AI planning layer',
      }),
      wireNode({
        id: QUIET_ID,
        parentId: EPIC_ID,
        kind: 'story',
        identifier: 'MOTIR-8',
        title: 'A story this plan says nothing about',
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  // The story's own level is EMPTY: its children exist only in the plan.
  [STORY_ID]: { nodes: [], edges: [], offLevelBlockers: [] },
};

function stubRoadmap() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/work-items/peek')
        return Promise.resolve({ ok: false, status: 404 } as Response);
      const parentId = url.searchParams.get('parentId') ?? '__root__';
      const body = WIRE_LEVELS[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }),
  );
}

const TRAIL_TO_EPIC = [{ id: EPIC_ID, identifier: 'MOTIR-2200', title: 'The Motir agent loop' }];
const TRAIL_TO_STORY = [
  ...TRAIL_TO_EPIC,
  { id: STORY_ID, identifier: 'MOTIR-7', title: 'AI planning layer' },
];

/**
 * One proposal under the story being expanded — the shared builder
 * (`tests/helpers/planReview.ts`) with this file's committed parent filled in.
 *
 * The `proposal` ENVELOPE (MOTIR-4183) is re-derived from the item's own `op`
 * and `identifier` rather than left at the builder's `add` default, so a case
 * that overrides those — `storyModify()` below — carries an envelope that
 * agrees with the row it describes.
 */
function proposal(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  const item = planReviewItem({
    parentNodeId: STORY_ID,
    parentIdentifier: 'MOTIR-7',
    parentTitle: 'AI planning layer',
    parentKind: 'story',
    parentTrail: TRAIL_TO_STORY,
    title: 'A proposed subtask',
    kind: 'subtask',
    ...over,
  });
  return {
    ...item,
    proposal: { ...item.proposal, op: item.op, identifier: item.identifier },
  };
}

/** The three subtasks the expansion proposes under the committed story. */
function expansion(): PlanReviewItemDto[] {
  return [1, 2, 3].map((n) =>
    proposal({ planItemId: `pi_sub_${n}`, nodeId: `pi_sub_${n}`, title: `Proposed subtask ${n}` }),
  );
}

/** The `modify` the same expansion carries on the story it expands. */
function storyModify(): PlanReviewItemDto {
  return proposal({
    planItemId: 'pi_story',
    op: 'modify',
    // A `modify` keys by the WORK ITEM it targets (MOTIR-3160) and reports that
    // card's key — which is the whole point: it is not new.
    nodeId: STORY_ID,
    identifier: 'MOTIR-7',
    title: 'AI planning layer',
    kind: 'story',
    parentNodeId: EPIC_ID,
    parentIdentifier: 'MOTIR-2200',
    parentTitle: 'The Motir agent loop',
    parentKind: 'epic',
    parentTrail: TRAIL_TO_EPIC,
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    hasChildren: true,
    changes: [{ field: 'storyPoints', from: '3', to: '5' }],
  });
}

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

/** Select a node the way a user does, so the canvas surfaces its action slot. */
function selectNode(id: string) {
  fireEvent.keyDown(el(id)!, { key: 'Enter' });
}

function mount(items: PlanReviewItemDto[]) {
  return render(<PlanReviewCanvas items={items} projectKey="MOTIR" version={0} />);
}

/** Walk up to the epic's level, where the story the plan expands is drawn. */
async function goToEpicLevel() {
  const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
  fireEvent.click(within(nav).getByText('MOTIR-2200 · The Motir agent loop'));
  await screen.findByText('MOTIR-7');
}

describe('PlanReviewCanvas — a story the plan EXPANDS', () => {
  beforeEach(stubRoadmap);

  it('offers Open on the committed story, and drilling it lands on the proposed subtasks', async () => {
    mount(expansion());
    expect(await screen.findByText('Proposed subtask 1')).toBeTruthy();
    await goToEpicLevel();

    // The story has no committed child — the plan is what puts work under it.
    selectNode(STORY_ID);
    const open = within(el(STORY_ID) as HTMLElement).getByTestId('drill-button');
    fireEvent.click(open);

    expect(await screen.findByText('Proposed subtask 1')).toBeTruthy();
    expect(screen.getByText('Proposed subtask 2')).toBeTruthy();
    expect(screen.getByText('Proposed subtask 3')).toBeTruthy();
    expect(el(STORY_ID)).toBeNull(); // we left the level we drilled from
  });

  it('leaves a card the plan says nothing about undrillable — the flag is not blanket', async () => {
    mount(expansion());
    await screen.findByText('Proposed subtask 1');
    await goToEpicLevel();

    selectNode(QUIET_ID);
    // Neither committed nor proposed children: no drill affordance at all.
    expect(within(el(QUIET_ID) as HTMLElement).queryByTestId('drill-button')).toBeNull();
    // …and the story beside it, which the plan DOES expand, still has one.
    selectNode(STORY_ID);
    expect(within(el(STORY_ID) as HTMLElement).getByTestId('drill-button')).toBeTruthy();
  });

  it('names the expanded story by its KEY in the breadcrumb when the plan also MODIFIES it', async () => {
    mount([storyModify(), ...expansion()]);
    expect(await screen.findByText('Proposed subtask 1')).toBeTruthy();

    // The canvas arrives INSIDE the story, so the crumb naming it is the one the
    // reviewer reads first. A `modify` targets a card that exists.
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('MOTIR-7 · AI planning layer')).toBeTruthy();
    expect(within(nav).queryByText('New · AI planning layer')).toBeNull();
  });

  it('still says New for a proposed container that has no key yet', async () => {
    // The other half of Part IX decision 3: an un-materialized `add` has
    // `identifier: null` by construction, so the word goes in the key's slot.
    const newStory = proposal({
      planItemId: 'pi_new_story',
      nodeId: 'pi_new_story',
      title: 'A story this plan invents',
      kind: 'story',
      parentNodeId: EPIC_ID,
      parentIdentifier: 'MOTIR-2200',
      parentTitle: 'The Motir agent loop',
      parentKind: 'epic',
      parentTrail: TRAIL_TO_EPIC,
      hasChildren: true,
    });
    const children = [1, 2].map((n) =>
      proposal({
        planItemId: `pi_child_${n}`,
        nodeId: `pi_child_${n}`,
        title: `Child ${n}`,
        parentNodeId: 'pi_new_story',
        parentIdentifier: null,
        parentTitle: null,
        parentKind: null,
        parentTrail: TRAIL_TO_EPIC,
      }),
    );

    mount([newStory, ...children]);
    expect(await screen.findByText('Child 1')).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('New · A story this plan invents')).toBeTruthy();
  });
});
