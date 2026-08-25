// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanChangeCanvas } from '@/components/planning/PlanChangeCanvas';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import { planReview, planReviewItem } from '../helpers/planReview';

// bug MOTIR-3439, the SECOND consumer — the planning-workspace canvas.
//
// `PlanReviewCanvas` and `PlanChangeCanvas` re-key their proposed nodes by two
// different rules and hit the identical defect, because the defect is not in
// either rule: it is that `ProjectRoadmapCanvas` holds a node id in mount-time
// state and nothing re-addresses it.
//
//   plan detail       a pending `add` keys by its PlanItem id; approve moves it
//                     to the work item's cuid (`planReviewService`, MOTIR-3160).
//   this surface      a pending `add` keys by `proposed:<PlanItem id>`; approve
//                     drops the prefix, because `isMaterializedAdd` is then true
//                     and the node IS the committed card (MOTIR-3206).
//
// Either way, a reviewer who has DRILLED INTO a proposed container is left
// standing on an id nothing answers to. Here that level is reached by an
// ordinary drill rather than by arrival — a proposed container is `drillable`
// the moment another proposal is parented on it — so it is one click away on
// every plan that proposes a container and its contents.
//
// Fixing one consumer and not the other would leave the same bug alive behind a
// different id scheme, which is why both are wired to the same foundation prop.

const EPIC_ID = 'wi_epic';
const NEW_STORY_ID = 'wi_new_story';
const CHILD_A = 'wi_child_a';
const CHILD_B = 'wi_child_b';

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

/** Has the plan been approved? The roadmap read genuinely changes at approve. */
let materialized = false;

function stubRoadmap() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/work-items/peek') {
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }
      const parentId = url.searchParams.get('parentId') ?? '__root__';
      const levels: Record<string, unknown> = {
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
          nodes: materialized
            ? [
                wireNode({
                  id: NEW_STORY_ID,
                  parentId: EPIC_ID,
                  kind: 'story',
                  identifier: 'MOTIR-500',
                  title: 'The new story',
                  hasChildren: true,
                }),
              ]
            : [],
          edges: [],
          offLevelBlockers: [],
        },
        ...(materialized
          ? {
              [NEW_STORY_ID]: {
                nodes: [
                  wireNode({
                    id: CHILD_A,
                    parentId: NEW_STORY_ID,
                    identifier: 'MOTIR-501',
                    title: 'The first subtask',
                  }),
                  wireNode({
                    id: CHILD_B,
                    parentId: NEW_STORY_ID,
                    identifier: 'MOTIR-502',
                    title: 'The second subtask',
                  }),
                ],
                edges: [],
                offLevelBlockers: [],
              },
            }
          : {}),
      };
      const body = levels[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }),
  );
}

function under(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
  return planReviewItem({
    parentNodeId: EPIC_ID,
    parentIdentifier: 'MOTIR-2200',
    parentTitle: 'The Motir agent loop',
    parentKind: 'epic',
    parentTrail: [{ id: EPIC_ID, identifier: 'MOTIR-2200', title: 'The Motir agent loop' }],
    kind: 'subtask',
    ...over,
  });
}

const PENDING: PlanReviewDto = planReview(
  [
    under({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      kind: 'story',
      title: 'The new story',
      hasChildren: true,
    }),
    under({
      planItemId: 'pi_a',
      nodeId: 'pi_a',
      parentNodeId: 'pi_story',
      title: 'The first subtask',
    }),
    under({
      planItemId: 'pi_b',
      nodeId: 'pi_b',
      parentNodeId: 'pi_story',
      title: 'The second subtask',
    }),
  ],
  { status: 'planned', itemCount: 3 },
);

const APPROVED: PlanReviewDto = planReview(
  [
    under({
      planItemId: 'pi_story',
      nodeId: NEW_STORY_ID,
      identifier: 'MOTIR-500',
      kind: 'story',
      title: 'The new story',
      hasChildren: true,
      status: 'todo',
    }),
    under({
      planItemId: 'pi_a',
      nodeId: CHILD_A,
      identifier: 'MOTIR-501',
      parentNodeId: NEW_STORY_ID,
      title: 'The first subtask',
      status: 'todo',
    }),
    under({
      planItemId: 'pi_b',
      nodeId: CHILD_B,
      identifier: 'MOTIR-502',
      parentNodeId: NEW_STORY_ID,
      title: 'The second subtask',
      status: 'todo',
    }),
  ],
  { status: 'approved', itemCount: 3 },
);

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

function drill(id: string) {
  fireEvent.keyDown(el(id)!, { key: 'Enter' });
  fireEvent.click(within(el(id) as HTMLElement).getByTestId('drill-button'));
}

describe('PlanChangeCanvas — the drilled level survives APPROVE (bug MOTIR-3439)', () => {
  beforeEach(() => {
    materialized = false;
    stubRoadmap();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('draws the MATERIALIZED children on the proposed level the user drilled into', async () => {
    const view = render(
      <PlanChangeCanvas
        projectKey="MOTIR"
        index={indexPlanReview(PENDING)}
        diffKey="pending"
        outcome={null}
      />,
    );

    // Down to the proposed container, then into it — an ordinary two-step drill.
    await screen.findByText('MOTIR-2200');
    drill(EPIC_ID);
    expect(await screen.findByText('The new story')).toBeTruthy();
    drill(`proposed:pi_story`);
    expect(await screen.findByText('The first subtask')).toBeTruthy();
    expect(screen.getByText('The second subtask')).toBeTruthy();

    // The host re-renders with the decided plan; nothing remounts.
    materialized = true;
    view.rerender(
      <PlanChangeCanvas
        projectKey="MOTIR"
        index={indexPlanReview(APPROVED)}
        diffKey="approved"
        outcome="accepted"
      />,
    );

    expect(await screen.findByText('MOTIR-501')).toBeTruthy();
    expect(screen.getByText('MOTIR-502')).toBeTruthy();
    expect(screen.queryByText('No items at this level')).toBeNull();
  });
});
