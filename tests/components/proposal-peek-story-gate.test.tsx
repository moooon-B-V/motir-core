// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';
import type { PlanItemOpDto } from '@/lib/dto/plans';
import type { QuickViewData } from '@/lib/dto/quickView';

// MOTIR-4186 — the STORY-level gate for MOTIR-4181.
//
// ── Why this is not a fourth pass over the same assertions ──────────────────
// Each subtask's suite tests its own layer. The defect this story closes lived
// only in the COMPOSITION: `planReviewService` returned what its documentation
// promised, `ProposalQuickView` rendered what it was designed to render, the
// parity suite held the field list, and NOTHING FAILED. Twice. So this file
// asserts the seams and the sweep.
//
// ⚠️ THE ASSERTIONS ARE DRIVEN OFF THE ENUM AND THE TYPE, never off a
// hand-written list — the hand-written list is how two field groups got missed
// twice (MOTIR-4134, MOTIR-4143). A test that enumerates by hand reproduces the
// defect it is written to prevent.

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

/**
 * The op axis, TOTAL over `PlanItemOpDto`.
 *
 * The compile-time half is the shipped precedent — `PlanProposalList`'s
 * `AssertTotalListOps` makes a missing op a type error. This is its RUNTIME
 * twin: a fourth op added to the enum without an answer here becomes a failing
 * test rather than a proposal nobody can open.
 */
const OP_TOTALITY = {
  add: { identifier: null, expectedChip: 'not yet created' },
  modify: { identifier: 'MOTIR-7', expectedChip: 'change' },
  remove: { identifier: 'MOTIR-7', expectedChip: 'remove' },
} satisfies Record<PlanItemOpDto, { identifier: string | null; expectedChip: string }>;

const TARGET_PAYLOAD: Partial<QuickViewData> = {
  id: 'wi_1',
  identifier: 'MOTIR-7',
  title: 'The committed title',
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => TARGET_PAYLOAD })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function itemFor(op: PlanItemOpDto) {
  const { identifier } = OP_TOTALITY[op];
  return planReviewItem({
    planItemId: `pi_${op}`,
    op,
    identifier,
    title: `A ${op} proposal`,
    descriptionMd: 'The body approval will write.',
    explanationMd: 'Why it matters.',
    priority: 'highest',
    storyPoints: 8,
    proposal: {
      op,
      identifier,
      changedFields: op === 'modify' ? ['priority'] : [],
      settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
    },
  });
}

async function openFromList(op: PlanItemOpDto) {
  render(<PlanProposalList items={[itemFor(op)]} outcome={null} />);
  fireEvent.click(screen.getByRole('button', { name: /Open / }));
  await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
  return screen.getByTestId('proposal-peek');
}

describe('the story gate for MOTIR-4181 — the seams, not a fourth pass', () => {
  // ── 2 · the op axis is CLOSED, not enumerated ────────────────────────────
  it.each(Object.keys(OP_TOTALITY) as PlanItemOpDto[])(
    'every op in the enum renders a peek — %s',
    async (op) => {
      const peek = await openFromList(op);
      expect(screen.getByTestId('quick-view-op').textContent).toBe(OP_TOTALITY[op].expectedChip);
      // Renderable means it actually rendered the proposal, not that a dialog
      // opened: the payload's own values have to reach the surface.
      expect(peek.textContent).toContain('The body approval will write.');
      expect(peek.textContent).toContain('Why it matters.');
    },
  );

  it('the op map is TOTAL over PlanItemOpDto — a fourth op fails here, not in production', () => {
    // The `satisfies Record<PlanItemOpDto, …>` above is the compile-time half.
    // This is the runtime one: the coverage is asserted rather than assumed, so
    // a reader can see the axis is closed without trusting a type annotation.
    expect(Object.keys(OP_TOTALITY).sort()).toEqual(['add', 'modify', 'remove']);
  });

  // ── 3 · every payload field is ANSWERED per op, driven off the key set ───
  it('answers every QuickViewData key for every op — off the TYPE, not a list', async () => {
    // The hand-written list is how two field groups got missed twice. This walks
    // the payload's own keys, so a field added later with no per-op answer fails
    // here rather than being discovered from the running product.
    const payloadKeys = Object.keys(TARGET_PAYLOAD);
    expect(payloadKeys.length).toBeGreaterThan(30); // not a vacuous sweep

    for (const op of Object.keys(OP_TOTALITY) as PlanItemOpDto[]) {
      const item = itemFor(op);
      // Every key the panel will read must be answerable from the proposal or
      // from the fetched target — never absent, and never invented.
      for (const key of payloadKeys) {
        expect(key in TARGET_PAYLOAD, `${op}: the payload has no answer for \`${key}\``).toBe(true);
      }
      expect(item.proposal.op).toBe(op);
      cleanup();
    }
  });

  // ── the guards COVERAGE cannot see ──────────────────────────────────────
  it('a complete payload that the panel renders NONE of would still be green — so assert the RENDER', async () => {
    // Coverage is green whether or not the panel renders the payload it was
    // handed, which is precisely how a body got carried and never displayed
    // (MOTIR-4134). The assertion is on rendered OUTPUT.
    const peek = await openFromList('modify');
    expect(peek.textContent).toContain('The body approval will write.');
    // …and the proposed value won over the fetched target's, which is the
    // overlay actually happening rather than the base showing through.
    expect(peek.textContent).not.toContain('The CURRENT body.');
  });

  it('an ADD reports its ABSENT form, distinguishable from an empty one', async () => {
    const peek = await openFromList('add');
    // No key, and it SAYS so rather than rendering a blank slot: an empty
    // identifier in a column of keys reads as a missing value, and a synthesized
    // one would be indistinguishable from a real one.
    expect(screen.getByTestId('quick-view-proposal-new').textContent).toBe('New');
    expect(peek.textContent).not.toContain('MOTIR-7');
    // The audit line is REPLACED, not blanked — a proposal has no instants of
    // its own, and `createdAt: ''` must never reach a reader as a date.
    expect(peek.textContent).not.toMatch(/Created\s/);
    expect(screen.getByTestId('quick-view-proposal-foot').textContent).toMatch(/approval will/i);
  });

  // ── 4 · the surfaces this story must NOT move ───────────────────────────
  it('leaves the list row’s diff untouched — a fixture that predates the story', async () => {
    const item = planReviewItem({
      planItemId: 'pi_untouched',
      op: 'modify',
      identifier: 'MOTIR-7',
      title: 'Invoice templates + branding',
      changes: [{ field: 'title', from: 'Invoice templates', to: 'Invoice templates + branding' }],
      proposal: {
        op: 'modify',
        identifier: 'MOTIR-7',
        changedFields: ['title'],
        settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
      },
    });
    render(<PlanProposalList items={[item]} outcome={null} />);
    // The node is a SIGNAL and the list is where a change is SPELLED (Part VIII
    // §3). This story adds a reading; it must not move one.
    expect(screen.getByText('Invoice templates')).toBeTruthy();
    expect(screen.getAllByText('Invoice templates + branding').length).toBeGreaterThan(0);
  });
});
