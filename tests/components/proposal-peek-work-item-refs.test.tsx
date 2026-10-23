// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { WorkItemRefSummaryDto } from '@/lib/dto/workItems';

// Bug MOTIR-9355 — the proposal peek drew every work-item link in a PROPOSED
// body as a deleted card. An `add` rendered with an empty ref map, and a
// `modify` with its target's map, resolved from the target's STORED description
// only. The peek now reads the map the plan review resolved for the proposal's
// own bodies, and draws a `motir-ref:planItem:` link as the sibling proposal.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { ProposalPeek } from '@/components/planning/ProposalPeek';

function live(id: string, identifier: string, title: string): WorkItemRefSummaryDto {
  return {
    accessible: true,
    id,
    identifier,
    title,
    kind: 'story',
    archived: false,
    status: { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
    type: null,
    assignee: null,
  };
}

const LIVE_A = live('wi_live_a', 'MOTIR-8953', 'The provider-neutral fleet pool layer');
const LIVE_B = live('wi_live_b', 'MOTIR-9270', 'Run the CI runner fleet on AWS');
const LIVE_TARGET_OWN = live('wi_live_t', 'MOTIR-100', 'Linked from the stored body');

const ADD: PlanReviewItemDto = planReviewItem({
  planItemId: 'pi_add',
  nodeId: 'pi_add',
  title: 'An added card',
  descriptionMd:
    'Builds on [MOTIR-8953](motir:wi_live_a), not on [MOTIR-1](motir:wi_gone). ' +
    'Hands off to [the AWS pool](motir-ref:planItem:pi_sibling).',
  explanationMd: 'Waits on [MOTIR-9270](motir:wi_live_b).',
  workItemRefs: { wi_live_a: LIVE_A, wi_live_b: LIVE_B },
});

const SIBLING: PlanReviewItemDto = planReviewItem({
  planItemId: 'pi_sibling',
  nodeId: 'pi_sibling',
  title: 'The AWS pool',
  descriptionMd: 'The sibling body.',
});

const MODIFY: PlanReviewItemDto = planReviewItem({
  planItemId: 'pi_modify',
  op: 'modify',
  nodeId: 'wi_target',
  identifier: 'MOTIR-7',
  title: 'A modified card',
  kind: 'story',
  descriptionMd:
    'Still cites [MOTIR-100](motir:wi_live_t), now also [MOTIR-8953](motir:wi_live_a).',
  explanationMd: 'Because of [MOTIR-9270](motir:wi_live_b).',
  workItemRefs: { wi_live_a: LIVE_A, wi_live_b: LIVE_B },
  proposal: {
    op: 'modify',
    identifier: 'MOTIR-7',
    changedFields: ['description', 'explanation'],
    settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
    todos: null,
  },
});

/** The target's payload, whose map covers ONLY the target's stored body. */
const PEEK_RESPONSE = {
  folderId: null,
  folderPath: [],
  id: 'wi_target',
  identifier: 'MOTIR-7',
  title: 'A modified card',
  projectIdentifier: 'MOTIR',
  workItemRefs: { wi_live_t: LIVE_TARGET_OWN, 'MOTIR-100': LIVE_TARGET_OWN },
  kind: 'story',
  status: 'todo',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  descriptionMd: 'Still cites [MOTIR-100](motir:wi_live_t).',
  explanationMd: null,
  type: null,
  executor: null,
  assigneeName: null,
  assigneeId: null,
  reporterName: 'Zhu Yue',
  priority: 'high',
  labels: [],
  components: [],
  dueLabel: null,
  dueDate: null,
  sprintName: null,
  sprintId: null,
  storyPoints: 3,
  estimateMinutes: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  archived: null,
  parent: null,
  parentId: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: false,
  workflow: { statuses: [], transitions: [], policyMode: 'open' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points',
    pointScale: 'fibonacci',
    customScaleValues: [],
    canEdit: false,
  },
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => PEEK_RESPONSE }) as unknown as Response),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** The chip a `motir:` link rendered as, found by the key it shows. */
function chipFor(peek: HTMLElement, key: string): Element {
  const keyEl = [...peek.querySelectorAll('.wi-key')].find((el) => el.textContent === key);
  if (!keyEl) throw new Error(`no chip for ${key}`);
  return keyEl.closest('.wi-chip') as Element;
}

describe('the proposal peek resolves the links in a PROPOSED body (bug MOTIR-9355)', () => {
  it("an `add`'s description and explanation links render as LIVE chips", () => {
    render(<ProposalPeek item={ADD} onClose={() => {}} />);
    const peek = screen.getByTestId('proposal-peek');
    const a = chipFor(peek, 'MOTIR-8953');
    expect(a.classList.contains('is-deleted')).toBe(false);
    expect(a.textContent).toContain('The provider-neutral fleet pool layer');
    const b = chipFor(peek, 'MOTIR-9270');
    expect(b.classList.contains('is-deleted')).toBe(false);
    expect(b.textContent).toContain('Run the CI runner fleet on AWS');
  });

  it('a link to a card that really is gone still renders struck through', () => {
    render(<ProposalPeek item={ADD} onClose={() => {}} />);
    const gone = chipFor(screen.getByTestId('proposal-peek'), 'MOTIR-1');
    expect(gone.classList.contains('is-deleted')).toBe(true);
  });

  it("a `modify` resolves a link only the PROPOSED body adds, and keeps the target's own", async () => {
    render(<ProposalPeek item={MODIFY} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const peek = screen.getByTestId('proposal-peek');
    for (const key of ['MOTIR-8953', 'MOTIR-9270', 'MOTIR-100']) {
      expect(chipFor(peek, key).classList.contains('is-deleted')).toBe(false);
    }
    expect(chipFor(peek, 'MOTIR-100').textContent).toContain('Linked from the stored body');
  });

  it('an intra-plan link opens the sibling proposal', () => {
    const onOpenProposal = vi.fn();
    render(<ProposalPeek item={ADD} onClose={() => {}} onOpenProposal={onOpenProposal} />);
    const ref = within(screen.getByTestId('proposal-peek')).getByTestId('plan-change-proposal-ref');
    expect(ref.getAttribute('data-plan-item')).toBe(SIBLING.planItemId);
    expect(ref.textContent).toContain('the AWS pool');
    fireEvent.click(within(ref).getByRole('button'));
    expect(onOpenProposal).toHaveBeenCalledWith('pi_sibling');
  });
});
