// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import en from '@/messages/en.json';

// MOTIR-4472 (design Part XIV §16, MOTIR-4493) — THE DECIDED AXIS.
//
// ⚠️ THE FINDING IS NOT THAT THE PEEK IS STALE, IT IS THAT IT IS BLIND, and the
// two need different tests. The plan's status reached `PlanDetail`, forked into a
// `decided` boolean for the list and a three-valued `outcome` for the canvas, and
// reached `ProposalPeek` NOT AT ALL — `ProposalPeek({ item, onClose })`. §16.0
// measured the consequence: the peek's `outerHTML` is 11,676 bytes and
// byte-for-byte IDENTICAL across `planned` / `approved` / `declined`, through
// BOTH doors, for a `modify` and again for a `remove`.
//
// So the first assertion here is not about words. It is that the three
// renderings DIFFER — a test that only checked the strings would pass on a
// component that was still never told the plan's status, which is the state this
// card exists to leave behind.
//
// ⚠️ AMENDED FROM THE CARD'S OWN CRITERION 2, on the asset's authority (its
// criterion 1 says the asset outranks it). That criterion greps the decided peek
// for `planReview.opModify` — the word `change` — "expecting none", written
// answer-agnostically before the design chose between (a) and (b). §16.3 chose
// (b) and did NOT replace the op word: segment 1 is the shipped `Pill` BYTE FOR
// BYTE and the outcome is FUSED beside it. So the future-tense assertion moves
// onto the two elements that do carry the tense — the link out (§16.4) and the
// rail-foot line (§16.5) — plus the presence of the outcome segment.

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

const t = en.planReview;

/**
 * The LITERAL PREFIX of an ICU template — everything before its first `{`.
 *
 * `String.split()[0]` is `string | undefined` under `noUncheckedIndexedAccess`,
 * and six sites asserting on one is six casts; one helper is the honest shape.
 * A template with no placeholder is its own prefix.
 */
const prefixOf = (template: string): string => (template.split('{')[0] ?? template).trim();

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
  },
});

const REMOVE: PlanReviewItemDto = planReviewItem({
  planItemId: 'pi_remove',
  op: 'remove',
  nodeId: 'wi_1',
  identifier: 'MOTIR-7',
  title: 'Legacy CSV export',
  kind: 'task',
  proposal: {
    op: 'remove',
    identifier: 'MOTIR-7',
    changedFields: [],
    settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
  },
});

/** A DECLINED `add` keeps `identifier: null` FOR EVER — §16.6's correction. */
const DECLINED_ADD: PlanReviewItemDto = planReviewItem({
  planItemId: 'pi_add',
  op: 'add',
  nodeId: 'pi_add',
  identifier: null,
  title: 'A card the plan would have created',
  kind: 'subtask',
  proposal: {
    op: 'add',
    identifier: null,
    changedFields: [],
    settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
  },
});

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

/** When set, `/api/work-items/peek` answers 404 — the hard-deleted target. */
let targetMissing = false;

beforeEach(() => {
  targetMissing = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/work-items/peek') {
        if (targetMissing) return { ok: false, status: 404 } as unknown as Response;
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

/** Open the proposal through the LIST door at a given plan outcome. */
async function throughTheList(
  item: PlanReviewItemDto,
  outcome: PlanItemOutcome | null,
  testId = 'proposal-peek',
): Promise<string> {
  render(<PlanProposalList items={[item]} outcome={outcome} />);
  fireEvent.click(screen.getByRole('button', { name: /Open / }));
  await waitFor(() => expect(screen.getByTestId(testId)).toBeTruthy());
  const html = screen.getByTestId(testId).outerHTML;
  cleanup();
  return html;
}

/** The SAME proposal through the CANVAS door, at the same outcome. */
async function throughTheCanvas(
  item: PlanReviewItemDto,
  outcome: PlanItemOutcome | null,
): Promise<string> {
  render(<PlanReviewCanvas items={[item]} projectKey="MOTIR" version={0} outcome={outcome} />);
  const node = await waitFor(() => {
    const found = document.querySelector(`[data-node-id="${item.nodeId}"]`);
    if (!found) throw new Error('the canvas has not drawn its level yet');
    return found as HTMLElement;
  });
  fireEvent.keyDown(node, { key: 'Enter' });
  fireEvent.click(within(node).getByTestId('view-button'));
  await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
  const html = screen.getByTestId('proposal-peek').outerHTML;
  cleanup();
  return html;
}

describe('the peek is no longer BLIND to the plan’s decision (MOTIR-4472, AC 9)', () => {
  it('renders the same modify DIFFERENTLY at planned / approved / declined — both doors', async () => {
    // ⚠️ THE LOAD-BEARING ASSERTION, and it is deliberately not about words.
    // §16.0 measured all six of these as one 11,676-byte string. An assertion
    // that only checked the copy would pass on a component that was still never
    // told the status.
    const list = {
      planned: await throughTheList(MODIFY, null),
      approved: await throughTheList(MODIFY, 'accepted'),
      declined: await throughTheList(MODIFY, 'declined'),
    };
    expect(list.planned).not.toBe(list.approved);
    expect(list.planned).not.toBe(list.declined);
    expect(list.approved).not.toBe(list.declined);

    const canvas = {
      planned: await throughTheCanvas(MODIFY, null),
      approved: await throughTheCanvas(MODIFY, 'accepted'),
      declined: await throughTheCanvas(MODIFY, 'declined'),
    };
    expect(canvas.planned).not.toBe(canvas.approved);
    expect(canvas.planned).not.toBe(canvas.declined);
    expect(canvas.approved).not.toBe(canvas.declined);
  });

  it('and the SAME cell still renders identically through both doors (AC 3)', async () => {
    // MOTIR-4185's property, re-measured at both decided values — §16.7. The
    // decided arm is a property of the PEEK, not of either door.
    for (const outcome of [null, 'accepted', 'declined'] as const) {
      expect(await throughTheList(MODIFY, outcome), String(outcome)).toBe(
        await throughTheCanvas(MODIFY, outcome),
      );
    }
  });
});

describe('a DECIDED modify states nothing in the future tense (AC 2, AC 6)', () => {
  it.each([
    [
      'approved',
      'accepted',
      t.outcomeAccepted,
      en.issueViews.openFullPage,
      t.railChangeCountApplied,
    ],
    ['declined', 'declined', t.outcomeDeclined, t.openTargetAsItStands, t.railChangeCountDeclined],
  ] as const)(
    'a %s plan: the chip fuses its outcome, the link out is right, the foot line is past',
    async (_label, outcome, outcomeWord, linkLabel, footTemplate) => {
      const html = await throughTheList(MODIFY, outcome);

      // §16.3 — the op word is KEPT and the outcome is FUSED beside it.
      expect(html).toContain(t.opModify);
      expect(html).toContain(outcomeWord);
      // §16.4 — approved LIFTS the override, declined KEEPS it.
      expect(html).toContain(linkLabel);
      // §16.5 — the pinned line, in the decided arm's tense…
      expect(html).toContain(prefixOf(footTemplate));
      // …and NOT in the present one. This is the sentence the card is named
      // after: `This plan changes 1 of the 6 fields it can set.`
      expect(html).not.toContain(`${prefixOf(t.railChangeCount)} 1 of`);
    },
  );

  it('an approved plan does NOT keep the divergence warning (§16.4)', async () => {
    const html = await throughTheList(MODIFY, 'accepted');
    expect(html).not.toContain(t.openTargetAsItStands);
  });

  it('an UNDECIDED plan’s peek is byte-for-byte unchanged (AC 4)', async () => {
    // The future tense is CORRECT there, and this must not move it. Compared
    // against the same render with the prop absent entirely, which is what every
    // committed host passes.
    const withNull = await throughTheList(MODIFY, null);
    render(<PlanProposalList items={[MODIFY]} outcome={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    expect(screen.getByTestId('proposal-peek').outerHTML).toBe(withNull);
    expect(withNull).toContain(t.openTargetAsItStands);
    expect(withNull).toContain(prefixOf(t.railChangeCount));
    expect(withNull).not.toContain(t.outcomeAccepted);
    expect(withNull).not.toContain(t.outcomeDeclined);
  });
});

describe('a DECIDED remove (AC 5)', () => {
  it('approved says WHO archived it, declined says it did not (§16.5)', async () => {
    const approved = await throughTheList(REMOVE, 'accepted');
    // `This plan archived {key}.` — not `{key} is archived`, which the shipped
    // `Archived` pill and banner already say. Only this line can say who did it.
    expect(approved).toContain(prefixOf(t.railRemoveArchived));
    expect(approved).not.toContain(prefixOf(t.railRemoveArchives));
    expect(approved).toContain(t.outcomeAccepted);

    const declined = await throughTheList(REMOVE, 'declined');
    expect(declined).toContain(prefixOf(t.railRemoveDeclined));
    expect(declined).toContain(t.outcomeDeclined);
  });

  it('a target that no longer resolves keeps the shipped NOT-FOUND panel (§16.6)', async () => {
    // A deliberate limit, not an oversight: proposal mode's decided arm speaks
    // about a target it can READ, and giving the not-found panel a decided arm
    // would draw the plan's record inside a panel whose whole message is that
    // there is nothing to show.
    targetMissing = true;
    const html = await throughTheList(REMOVE, 'accepted', 'proposal-peek-missing');
    expect(html).toContain('proposal-peek-missing');
    expect(html).not.toContain(t.outcomeAccepted);
  });
});

describe('a DECLINED add is IN SCOPE (AC 8, §16.6’s correction)', () => {
  it('does NOT route to the committed peek — its identifier is null for ever', async () => {
    // The brief assigned both decided `add` cells to MOTIR-4471. That is true of
    // `approved` and false of `declined`: the routing keys on
    // `op === 'add' && identifier != null`, and a declined `add` never gets one.
    for (const html of [
      await throughTheList(DECLINED_ADD, 'declined'),
      await throughTheCanvas(DECLINED_ADD, 'declined'),
    ]) {
      expect(html).toContain('proposal-peek');
      expect(html).toContain(t.notYetCreated);
      expect(html).toContain(t.outcomeDeclined);
      // The foot line it used to read, about a plan that can never be approved.
      expect(html).not.toContain(t.railAddAll);
      expect(html).toContain(t.railAddDeclined);
    }
  });
});

describe('the copy keys §16.5 names ship in BOTH catalogs (AC 7)', () => {
  it('names the SEVEN new keys, and no key for the chip or the link out', async () => {
    // ⚠️ SEVEN, not the SIX the card's criterion 7 enumerates — the card omits
    // `railRemoveDeclined`, which §16.5's table names with its exact string and
    // panel 10 draws. Amended on the card's record, on its own criterion 1: the
    // asset outranks it. (The mock's caption says "six" too and its own panel
    // list draws seven; the drawn cells are the authority.)
    const zh = (await import('@/messages/zh.json')).default as unknown as {
      planReview: Record<string, string>;
    };
    for (const key of [
      'railChangeCountApplied',
      'railChangeCountDeclined',
      'railChangeNoneApplied',
      'railChangeNoneDeclined',
      'railRemoveArchived',
      'railRemoveDeclined',
      'railAddDeclined',
    ]) {
      expect((t as Record<string, string>)[key], `en.${key}`).toBeTruthy();
      expect(zh.planReview[key], `zh.${key}`).toBeTruthy();
    }
    // §16.3 and §16.4 add none: the chip fuses a shipped pair and the link out
    // re-reads a shipped key.
    expect(t.outcomeAccepted).toBeTruthy();
    expect(t.outcomeDeclined).toBeTruthy();
    expect(en.issueViews.openFullPage).toBeTruthy();
  });
});
