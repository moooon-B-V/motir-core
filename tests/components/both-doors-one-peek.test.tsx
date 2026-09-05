// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// MOTIR-4185 (story MOTIR-4181, design Part XIV §9) — BOTH DOORS, ONE PEEK.
//
// ⚠️ AC 1 IS ONE TEST OVER BOTH HOSTS, NOT TWO THAT AGREE, and the distinction is
// the whole point of the story. Two tests that each assert their own door's
// output can both pass while the two doors render different things — which is
// exactly the state this story found: the canvas's peek showed the target's
// CURRENT values with no sign a plan was about to change them, and the list's
// showed the proposed values in a surface that was not the shipped peek. So the
// assertion below renders the SAME proposal through each host and compares the
// two renderings to each other.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';

const MODIFY: PlanReviewItemDto = planReviewItem({
  planItemId: 'pi_modify',
  op: 'modify',
  nodeId: 'wi_1',
  identifier: 'MOTIR-7',
  title: 'One peek for a PROPOSAL',
  kind: 'story',
  priority: 'highest',
  storyPoints: 8,
  descriptionMd: 'The body a reviewer reads before approving.',
  explanationMd: 'Why it matters.',
  changes: [{ field: 'priority', from: 'high', to: 'highest' }],
  proposal: {
    op: 'modify',
    identifier: 'MOTIR-7',
    changedFields: ['priority'],
    settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
    todos: null,
  },
});

/** The target's payload the peek fetches on open, for a `modify` / `remove`. */
const PEEK_RESPONSE = {
  id: 'wi_1',
  identifier: 'MOTIR-7',
  title: 'One peek for a proposal',
  projectIdentifier: 'MOTIR',
  workItemRefs: {},
  kind: 'story',
  status: 'todo',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  descriptionMd: 'The CURRENT body.',
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
  // One stub for both doors. The canvas asks for its LEVEL before it draws; the
  // peek asks for the TARGET's payload on open. Answering both from here is what
  // makes the two renderings comparable rather than accidentally different.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/work-items/peek') {
        return { ok: true, json: async () => PEEK_RESPONSE } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ nodes: [], edges: [], offLevelBlockers: [] }),
      } as unknown as Response;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** Open the proposal through the LIST door and return what the peek rendered. */
async function throughTheList(item: PlanReviewItemDto): Promise<string> {
  render(<PlanProposalList items={[item]} outcome={null} />);
  fireEvent.click(screen.getByRole('button', { name: /Open / }));
  await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
  const text = screen.getByTestId('proposal-peek').textContent ?? '';
  cleanup();
  return text;
}

/**
 * Open the SAME proposal through the CANVAS door.
 *
 * The canvas fetches its own level before it draws, and its `View` pill appears
 * only on a SELECTED node — so the door has to be driven the way a reader drives
 * it (select, then View) rather than by finding a button. `/api/work-items/peek`
 * is answered by the same stub the list side uses, which is what makes the two
 * renderings comparable at all.
 */
async function throughTheCanvas(item: PlanReviewItemDto): Promise<string> {
  render(<PlanReviewCanvas items={[item]} projectKey="MOTIR" version={0} />);
  const node = await waitFor(() => {
    const found = document.querySelector(`[data-node-id="${item.nodeId}"]`);
    if (!found) throw new Error('the canvas has not drawn its level yet');
    return found as HTMLElement;
  });
  fireEvent.keyDown(node, { key: 'Enter' });
  fireEvent.click(within(node).getByTestId('view-button'));
  await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
  const text = screen.getByTestId('proposal-peek').textContent ?? '';
  cleanup();
  return text;
}

describe('both plan-review doors open ONE peek (MOTIR-4185)', () => {
  it('renders the SAME peek for the same modify, from the list and from the canvas (AC 1)', async () => {
    const fromList = await throughTheList(MODIFY);
    const fromCanvas = await throughTheCanvas(MODIFY);

    // The load-bearing comparison: the two doors against EACH OTHER. Two tests
    // that each asserted their own door's output would both have passed on the
    // state this story exists to fix.
    expect(fromList).toBe(fromCanvas);

    // …and not vacuously equal — the peek actually rendered the proposal.
    expect(fromList).toContain('MOTIR-7');
    expect(fromList).toContain('change');
    expect(fromList).toContain('Why it matters.');
  });

  it('opens the proposed values, not the target’s current ones (AC 1)', async () => {
    const fromList = await throughTheList(MODIFY);
    // The overlay: the peek shows what the work item will BE. `The CURRENT body`
    // is what the fetched target carries, and the plan replaces it.
    expect(fromList).toContain('The body a reviewer reads before approving.');
    expect(fromList).not.toContain('The CURRENT body.');
  });

  it('opens all THREE ops from the list (AC 2)', async () => {
    for (const [op, identifier, expected] of [
      ['add', null, 'not yet created'],
      ['modify', 'MOTIR-7', 'change'],
      ['remove', 'MOTIR-7', 'remove'],
    ] as const) {
      const item = planReviewItem({
        planItemId: `pi_${op}`,
        op,
        identifier,
        title: `A ${op} proposal`,
        proposal: {
          op,
          identifier,
          changedFields: [],
          settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
          todos: null,
        },
      });
      render(<PlanProposalList items={[item]} outcome={null} />);
      fireEvent.click(screen.getByRole('button', { name: /Open / }));
      await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
      expect(screen.getByTestId('quick-view-op').textContent).toBe(expected);
      cleanup();
    }
  });

  it('keeps ONE close affordance on the new host (AC 6)', async () => {
    render(<PlanProposalList items={[MODIFY]} outcome={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const closes = screen.getAllByLabelText('Close');
    // MOTIR-4022 measured two controls named `Close` 40px apart in one dialog on
    // the surface being retired. It must not return with its replacement.
    expect(closes.length).toBe(1);
  });

  it('returns focus to the row that opened it (AC 5)', async () => {
    render(<PlanProposalList items={[MODIFY]} outcome={null} />);
    const row = screen.getByRole('button', { name: /Open / });
    row.focus();
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // The dialog is mounted INSIDE the list, so closing it unmounts the dialog in
    // the same commit that re-renders the rows — and the Modal's own restore
    // lands before the row is settled. The explicit refocus is what closes that
    // (MOTIR-4022), and it must survive the host swap.
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it('leaves the list row’s own diff rendering alone (AC 7)', () => {
    render(<PlanProposalList items={[MODIFY]} outcome={null} />);
    // The node is a SIGNAL and the list is where a change is SPELLED (Part VIII
    // §3). This story adds a reading; it must not move one.
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getAllByText('highest').length).toBeGreaterThan(0);
  });
});

describe('the target fetch has a TERMINAL state in every direction (MOTIR-4185)', () => {
  it('renders the shipped NOT-FOUND panel when the target is gone, never a stuck skeleton', async () => {
    // ⚠️ THE REGRESSION THIS PINS. The first implementation rendered the
    // proposal's own values while the target's payload was in flight and swapped
    // when it landed — which made the two doors render DIFFERENTLY under load
    // (CI caught it: the canvas peek was missing the REPORTER row the list's
    // had). Rendering the shipped skeleton instead fixed that and introduced a
    // second hole: a fetch that FAILS never settles, so the dialog sat on the
    // skeleton for ever.
    //
    // A 404 here is not an edge case — it is `targetMissing`, a `remove` or a
    // drifted `modify` whose live target is archived or hard-deleted, and Part
    // XIV §8 specifies the shipped not-found panel for it. Falling back to the
    // proposal's own fields would render a work item that may no longer exist as
    // though it did.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    render(<PlanProposalList items={[MODIFY]} outcome={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));

    expect(await screen.findByTestId('proposal-peek-missing')).toBeTruthy();
    // Neither the stuck skeleton nor a half-filled peek.
    expect(screen.queryByTestId('proposal-peek')).toBeNull();
    expect(screen.queryByTestId('proposal-peek-loading')).toBeNull();
  });

  it('an `add` needs no fetch at all — no key, so nothing to be missing', async () => {
    // The arm that must NOT reach either new state: an un-materialized `add` has
    // no target, so it renders its own values immediately and a broken network
    // changes nothing about it.
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const add = planReviewItem({
      planItemId: 'pi_add',
      op: 'add',
      identifier: null,
      title: 'A proposed work item',
      proposal: {
        op: 'add',
        identifier: null,
        changedFields: [],
        settableRailFields: [],
        todos: null,
      },
    });
    render(<PlanProposalList items={[add]} outcome={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));

    expect(await screen.findByTestId('proposal-peek')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── bug MOTIR-4471 · the LIST door on a DECIDED plan ─────────────────────────
//
// ⚠️ WHY THE SUITE ABOVE COULD NOT SEE THIS. It walks the `op` axis exhaustively
// — add, modify, remove, both doors, one assertion over both — and never varies
// the SECOND axis at all: every fixture in it is an un-materialized `add`
// (`identifier: null`) rendered with `outcome={null}`. So the arm the defect
// lives in was not weakly covered, it was structurally unreachable. The fixtures
// below are that missing second axis, and criteria 4 and 5 hold the arms that
// were already correct so the fix cannot silently widen.
//
// The invariant, stated once: `identifier != null` ON AN `add` IS "this plan has
// been approved" — approve is what materializes the proposal into a work item
// and gives it a key. The canvas has read that since MOTIR-3161; the list now
// does too.

/** A materialized `add`: approved, so it carries the key of the card it became. */
const MATERIALIZED_ADD: PlanReviewItemDto = planReviewItem({
  planItemId: 'pi_add_done',
  op: 'add',
  // At approve, `materialize` re-keys the node to the work item it became — so a
  // materialized `add`'s `nodeId` is the card's id, not its own plan-item id.
  nodeId: 'wi_1',
  identifier: 'MOTIR-7',
  title: 'A work item that now exists',
  proposal: {
    op: 'add',
    identifier: 'MOTIR-7',
    changedFields: [],
    settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
    todos: null,
  },
});

describe('a DECIDED plan’s list row opens the card that EXISTS (bug MOTIR-4471)', () => {
  it('a materialized `add` opens the ORDINARY work-item peek, not proposal mode (AC 3)', async () => {
    render(<PlanProposalList items={[MATERIALIZED_ADD]} outcome="accepted" />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));

    // The tell that the right door opened: the link out carries the COMMITTED
    // label. In proposal mode the same testid renders `Open the work item as it
    // stands`, whose whole point is the tense — and after approval that tense is
    // the lie (`design/ai-planning/design-notes.md` Part XIV §7).
    const link = await screen.findByTestId('quick-view-open-full');
    expect(link.textContent).toContain('Open full page');
    expect(link.textContent).not.toContain('Open the work item as it stands');

    // None of proposal mode's three untruths is reachable, because none of
    // proposal mode is mounted.
    expect(screen.queryByTestId('quick-view-op')).toBeNull();
    expect(screen.queryByTestId('quick-view-proposal-new')).toBeNull();
    expect(screen.queryByTestId('proposal-peek')).toBeNull();
    expect(screen.queryByText('not yet created')).toBeNull();
  });

  it('an UN-materialized `add` on an undecided plan still opens proposal mode (AC 4)', async () => {
    // The counterpart, and the arm that must NOT move: no key yet, so there is
    // no card to open and `not yet created` is the truth.
    const pending = planReviewItem({
      planItemId: 'pi_add_pending',
      op: 'add',
      identifier: null,
      title: 'A proposed work item',
      proposal: {
        op: 'add',
        identifier: null,
        changedFields: [],
        settableRailFields: [],
        todos: null,
      },
    });
    render(<PlanProposalList items={[pending]} outcome={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));

    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    expect(screen.getByTestId('quick-view-op').textContent).toBe('not yet created');
  });

  it('a `modify` and a `remove` on a DECIDED plan still open the PROPOSAL peek (AC 5)', async () => {
    // The arm this card EXCLUDES. A decided plan's `modify` / `remove` peek
    // reading in the future tense is real and is MOTIR-4472's; what must not
    // happen here is this fix widening into it by routing those rows away from
    // `ProposalPeek`. `identifier != null` is true of every `modify` and every
    // `remove` — it names their live target — so only the `op === 'add'` half of
    // the test keeps them here.
    for (const [op, expected] of [
      ['modify', 'change'],
      ['remove', 'remove'],
    ] as const) {
      const item = planReviewItem({
        planItemId: `pi_${op}_decided`,
        op,
        nodeId: 'wi_1',
        identifier: 'MOTIR-7',
        title: `A ${op} on a decided plan`,
        proposal: {
          op,
          identifier: 'MOTIR-7',
          changedFields: [],
          settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
          todos: null,
        },
      });
      render(<PlanProposalList items={[item]} outcome="accepted" />);
      fireEvent.click(screen.getByRole('button', { name: /Open / }));

      await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
      expect(screen.getByTestId('quick-view-op').textContent).toBe(expected);
      cleanup();
    }
  });

  it('returns focus to the row on the COMMITTED mount too (AC 6)', async () => {
    // MOTIR-4022's explicit refocus is wired to the ONE `closePeek`, so it has to
    // hold whichever half was open. The proposal half is covered above; this is
    // the half the fix adds, and a close that cleared only the half it knew
    // about would leave the other mounted and focus nowhere.
    render(<PlanProposalList items={[MATERIALIZED_ADD]} outcome="accepted" />);
    const row = screen.getByRole('button', { name: /Open / });
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.click(row);
    await screen.findByTestId('quick-view-open-full');

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('quick-view-open-full')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row));
  });
});
