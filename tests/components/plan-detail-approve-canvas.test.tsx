// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import { planReview, planReviewItem } from '../helpers/planReview';

// bug MOTIR-3439 — APPROVE, driven through the REAL control, on the REAL canvas.
//
// `tests/components/plan-review-canvas.test.tsx` holds the same defect at the
// `PlanReviewCanvas` seam, hand-feeding it the two item sets. This file closes
// the other half of the claim — that the shipped approve path actually produces
// that transition — because every step between the button and the canvas is a
// place the reasoning could have been wrong: `runAction` could have remounted
// the canvas, the establish band appearing above it could have changed its
// position in the tree, `router.refresh()` could have reached it.
//
// None of them do: approve is `await action() → refetch() → setReview + version++`,
// and `PlanReviewCanvas` is mounted with no `key`. So the reviewer's level is
// re-rendered with every node id changed underneath it.
//
// ⚠️ `PlanReviewCanvas` is NOT stubbed here, deliberately — that is the whole
// point of this file, and it is what distinguishes it from
// `plan-detail-decided.test.tsx`, which stubs the canvas because its subject is
// which pane renders rather than what the canvas draws.

vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: () => <div data-testid="repository-set-step" />,
}));

// `?view=canvas` is PINNED. A plan that proposes a container AND its contents
// straddles two containers, so `defaultPlanView` opens it in the LIST
// (MOTIR-3262) — the canvas is where a reviewer goes to see WHERE the story
// lands, which is exactly the reader this bug stranded.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/plans/plan_1',
  useSearchParams: () => new URLSearchParams('view=canvas'),
}));

const PARENT_ID = 'wi_parent';
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
              id: PARENT_ID,
              kind: 'epic',
              identifier: 'MOTIR-2200',
              title: 'The Motir agent loop',
              hasChildren: true,
            }),
          ],
          edges: [],
          offLevelBlockers: [],
        },
        [PARENT_ID]: { nodes: [], edges: [], offLevelBlockers: [] },
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
    parentNodeId: PARENT_ID,
    parentIdentifier: 'MOTIR-2200',
    parentTitle: 'The Motir agent loop',
    parentKind: 'epic',
    parentTrail: [{ id: PARENT_ID, identifier: 'MOTIR-2200', title: 'The Motir agent loop' }],
    kind: 'subtask',
    ...over,
  });
}

/** The plan as REVIEWED: one story under the epic, two subtasks under it. */
const PENDING: PlanReviewItemDto[] = [
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
];

/** …and as `materialize` re-keys it: every `add` on the work item it became. */
const APPROVED: PlanReviewItemDto[] = [
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
];

const PLANNED: PlanReviewDto = planReview(PENDING, { status: 'planned', itemCount: 3 });
const DECIDED: PlanReviewDto = planReview(APPROVED, {
  status: 'approved',
  itemCount: 3,
  decidedAt: '2026-08-25T00:00:00.000Z',
  decidedByName: 'Yue',
});

const approvePlanRequest = vi.fn(() => Promise.resolve({}));
const fetchPlanReview = vi.fn(() => Promise.resolve(DECIDED));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    approvePlanRequest: (...args: unknown[]) => approvePlanRequest(...(args as [])),
    declinePlanRequest: vi.fn(() => Promise.resolve({})),
    fetchPlanReview: (...args: unknown[]) => fetchPlanReview(...(args as [])),
  };
});

import { PlanDetail } from '@/components/planning/PlanDetail';

describe('PlanDetail — approving from the canvas (bug MOTIR-3439)', () => {
  beforeEach(() => {
    materialized = false;
    approvePlanRequest.mockClear();
    fetchPlanReview.mockClear();
    stubRoadmap();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('leaves the reviewer on the level they approved, holding the cards it created', async () => {
    renderWithIntl(<PlanDetail initialReview={PLANNED} projectKey="MOTIR" repositorySet={null} />);

    // Arrival: drilled into the proposed story, its proposed subtasks on screen.
    expect(await screen.findByText('The first subtask')).toBeTruthy();
    expect(screen.getByText('The second subtask')).toBeTruthy();

    materialized = true;
    fireEvent.click(screen.getByRole('button', { name: /Approve — add 3 items/ }));
    await waitFor(() => expect(approvePlanRequest).toHaveBeenCalledWith('plan_1'));

    // The same level, now the RECORD Part VI says this pane becomes: the real
    // work items, with the keys they were given.
    expect(await screen.findByText('MOTIR-501')).toBeTruthy();
    expect(screen.getByText('MOTIR-502')).toBeTruthy();
    expect(screen.queryByText('No items at this level')).toBeNull();
  });
});
