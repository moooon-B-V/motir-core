// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { WorkItemNode } from '@/components/planning/WorkItemNode';
import { mergePlanLevel, proposalsAtLevel } from '@/components/planning/planLevel';
import { arrivalLevel } from '@/components/planning/PlanReviewCanvas';
import type { PlanCanvasLevel } from '@/components/planning/planLevel';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// Component tests for the plan-detail op treatments (Subtask 7.4.5 / MOTIR-847)
// under happy-dom. The DTO assembly is covered by the real-DB
// planReviewService suite; here we assert the canvas node renders each `op`
// distinctly (add / modify-with-diff / remove) + the stale badge, and that the
// pure LEVEL transform merges a plan's proposals into the committed level the
// roadmap read returned (MOTIR-3083).

afterEach(cleanup);

function item(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: null,
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    parentTrail: [],
    blockedByNodeIds: [],
    identifier: null,
    title: 'A proposed item',
    kind: 'task',
    priority: null,
    type: null,
    descriptionMd: null,
    explanationMd: null,
    explanationSource: null,
    storyPoints: null,
    estimateMinutes: null,
    targetRepo: null,
    targetRepoRole: null,
    executor: null,
    planningProvenance: null,
    status: null,
    statusLabel: null,
    statusCategory: null,
    hasChildren: false,
    changes: [],
    stale: false,
    staleReasons: [],
    targetMissing: false,
    ...over,
  };
}

describe('PlanItemNode', () => {
  it('renders an add with the add badge + "New" placeholder identifier', () => {
    renderWithIntl(<PlanItemNode item={item({ op: 'add', title: 'Marketplace payouts' })} />);
    expect(screen.getByText('add')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Marketplace payouts')).toBeTruthy();
    expect(screen.getByTestId('plan-item-node').getAttribute('data-op')).toBe('add');
  });

  it('renders a modify with the change badge + an old→new diff line', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_1',
          identifier: 'PROD-14',
          title: 'Seller onboarding',
          status: 'in_progress',
          statusLabel: null,
          statusCategory: null,
          changes: [
            { field: 'priority', from: 'medium', to: 'high' },
            { field: 'title', from: 'old', to: 'new' },
          ],
        })}
      />,
    );
    expect(screen.getByText('change')).toBeTruthy();
    // ⚠️ The KEY, where an `add` shows "New" (bug MOTIR-3191). Between the two,
    // that is what lets a reviewer read "this amends PROD-14" off the node
    // without opening it — and it is the half that a `modify` drawn at the
    // project root made unreadable, because a card at the root reads as a
    // proposed EPIC whatever its badge says.
    expect(screen.getByText('PROD-14')).toBeTruthy();
    expect(screen.queryByText('New')).toBeNull();
    expect(screen.getByTestId('diff-line')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    // A second change is summarised, not dumped.
    expect(screen.getByText('+1 more')).toBeTruthy();
  });

  it('renders a remove with a struck-through title + status pill', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'remove',
          nodeId: 'wi_2',
          identifier: 'PROD-19',
          title: 'Manual payout export',
          status: 'todo',
          statusLabel: null,
          statusCategory: null,
        })}
      />,
    );
    expect(screen.getByText('remove')).toBeTruthy();
    const title = screen.getByText('Manual payout export');
    expect(title.className).toContain('line-through');
  });

  // ── The STATUS chip is the SHARED one (bug MOTIR-3170) ──────────────────
  //
  // This node used to keep its OWN six-member status literal and coerce
  // anything else to `todo`, so a `modify` whose live target had an open pull
  // request drew as "To Do" on the plan-detail canvas. There is now ONE
  // resolver — `WorkItemStatusPill` → `lib/workflows/canvasStatusMeta.ts` —
  // and these assert on the rendered TEXT, which is what a reviewer reads.
  it('renders a modify whose live target is at `implemented` as "Implemented"', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_impl',
          identifier: 'PROD-31',
          title: 'Seller onboarding',
          status: 'implemented',
          statusLabel: 'Implemented',
          statusCategory: 'in_progress',
        })}
      />,
    );
    expect(screen.getByText('Implemented')).toBeTruthy();
    expect(screen.queryByText('To Do')).toBeNull();
  });

  it("renders a target at a CUSTOM workflow status with that status's own label", () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_custom',
          identifier: 'PROD-32',
          title: 'Seller onboarding',
          status: 'awaiting_legal',
          statusLabel: 'Awaiting legal',
          statusCategory: 'todo',
        })}
      />,
    );
    expect(screen.getByText('Awaiting legal')).toBeTruthy();
    expect(screen.queryByText('To Do')).toBeNull();
  });

  it('draws the chip from the SAME resolver as the roadmap node — same key, same fill', () => {
    // The AC is "no second copy of the mapping in `components/planning/`". A
    // rendered comparison is what proves it: if this file ever grows its own map
    // again, the two fills diverge here rather than in production.
    const proposal = renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_same',
          identifier: 'PROD-33',
          title: 'Seller onboarding',
          status: 'implemented',
          statusLabel: 'Implemented',
          statusCategory: 'in_progress',
        })}
      />,
    );
    const onProposal = proposal.container.querySelector(
      '[data-status="implemented"]',
    ) as HTMLElement;
    const chipClass = onProposal.className;
    const chipText = onProposal.textContent;
    cleanup();

    const node = renderWithIntl(
      <WorkItemNode
        item={{
          id: 'wi_same',
          identifier: 'PROD-33',
          title: 'Seller onboarding',
          kind: 'subtask',
          status: 'implemented',
          statusLabel: 'Implemented',
          statusCategory: 'in_progress',
        }}
      />,
    );
    const onNode = node.container.querySelector('[data-status="implemented"]') as HTMLElement;
    expect(onNode.className).toBe(chipClass);
    expect(onNode.textContent).toBe(chipText);
  });

  it('shows a stale badge with the reasons in the tooltip', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          stale: true,
          staleReasons: [{ code: 'parent_removed', parentId: 'wi_9' }],
        })}
      />,
    );
    const badge = screen.getByTestId('stale-badge');
    expect(badge.getAttribute('title')).toContain('Parent removed');
  });

  // MOTIR-3151 — the SIZING rows. `buildChanges` has emitted `storyPoints` /
  // `estimateMinutes` since MOTIR-1532, and neither had a message in the
  // `planReview` catalog, so `DiffLine`'s `t(`field_${first.field}`)` rendered
  // the KEY PATH. `DiffLine` shows `changes[0]` only, so a patch that changes
  // ONLY the sizing put the leak first; one that also changed the title hid it.
  // Guarded on the ABSENCE of the key path as well as the presence of the word —
  // a label that renders `planReview.field_storyPoints` is the defect, and a
  // present-only assertion would pass on it.
  it.each([
    ['storyPoints', '3', '5', 'Story points'] as const,
    ['estimateMinutes', '30', '90', 'Estimate'] as const,
  ])('labels a %s-only re-scope with a word, not a message key', (field, from, to, label) => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_size',
          identifier: 'PROD-21',
          title: 'Seller onboarding',
          status: 'todo',
          statusLabel: null,
          statusCategory: null,
          changes: [{ field, from, to }],
        })}
      />,
    );
    const line = screen.getByTestId('diff-line');
    expect(line.textContent).not.toContain(`field_${field}`);
    expect(line.textContent).toContain(label);
  });

  // ⚠️ EDITING IS REMOVED (MOTIR-3084). MOTIR-1370's inline-edit pencil and its
  // modal are gone: a proposal is READ (the canvas peek) and changed by
  // re-planning, not hand-corrected. Guarded on ABSENCE, on every op — the
  // affordance must not come back on any of them.
  it('carries NO edit affordance on any op', () => {
    for (const op of ['add', 'modify', 'remove'] as const) {
      renderWithIntl(<PlanItemNode item={item({ op, nodeId: `wi_${op}`, title: op })} />);
      expect(screen.queryByTestId('edit-proposal')).toBeNull();
      cleanup();
    }
  });
});

// ── MOTIR-3161 (bug MOTIR-3154) — the DECIDED axis ──────────────────────────
//
// `design/ai-planning/design-notes.md` Part VI §3: the outcome CROSSES the three
// op languages rather than joining them (every op can be accepted and every op
// can be declined ⇒ six renderings), so the op frame is untouched and the
// outcome rides the chip's second SEGMENT plus a decorative spine.

describe('PlanItemNode — the decided outcome', () => {
  const OPS = ['add', 'modify', 'remove'] as const;

  it.each(OPS)('names the outcome in TEXT on a %s, for both decisions', (op) => {
    for (const [outcome, word] of [
      ['accepted', 'accepted'],
      ['declined', 'declined'],
    ] as const) {
      renderWithIntl(<PlanItemNode item={item({ op })} outcome={outcome} />);
      // Queried by TEXT, not by class: the word is the whole of the meaning, and
      // the a11y rule this asset holds itself to is that state is never carried
      // by colour alone.
      expect(screen.getByTestId('plan-item-outcome').textContent).toBe(word);
      // …and the op is STILL named beside it — the chip reads op × outcome.
      expect(screen.getByTestId('plan-item-op-chip').textContent).toContain(word);
      cleanup();
    }
  });

  it('leaves the op frame untouched — the axis CROSSES it, it does not replace it', () => {
    for (const op of OPS) {
      renderWithIntl(<PlanItemNode item={item({ op })} />);
      const undecided = screen.getByTestId('plan-item-node').className;
      cleanup();

      renderWithIntl(<PlanItemNode item={item({ op })} outcome="accepted" />);
      const decided = screen.getByTestId('plan-item-node').className;
      cleanup();

      // Every class the op treatment sets is still set. The only additions are
      // the ones the decided axis owns.
      for (const cls of undecided.split(/\s+/).filter((c) => c && c !== 'opacity-80')) {
        expect(decided.split(/\s+/)).toContain(cls);
      }
    }
  });

  it('renders NOTHING new while the plan is still planned', () => {
    renderWithIntl(<PlanItemNode item={item({ op: 'add' })} />);
    expect(screen.queryByTestId('plan-item-outcome')).toBeNull();
    expect(screen.queryByTestId('plan-item-outcome-spine')).toBeNull();
    // The undecided badge is the shipped one, byte for byte — no chip wrapper.
    expect(screen.queryByTestId('plan-item-op-chip')).toBeNull();
    expect(screen.getByText('add')).toBeTruthy();
  });

  it('drops the fade on a DECIDED remove, and keeps it on an undecided one', () => {
    // `opacity` means "this is about to happen"; on a decided card it either
    // already happened or never will — and it would mute the outcome spine, the
    // one signal that settles which.
    renderWithIntl(<PlanItemNode item={item({ op: 'remove' })} />);
    expect(screen.getByTestId('plan-item-node').className).toContain('opacity-80');
    cleanup();

    renderWithIntl(<PlanItemNode item={item({ op: 'remove' })} outcome="declined" />);
    const node = screen.getByTestId('plan-item-node');
    expect(node.className).not.toContain('opacity-80');
    // …and the strike stays: a declined remove is the one place a reader could be
    // misled, which is exactly why the word must be there to correct it.
    expect(screen.getByText('A proposed item').className).toContain('line-through');
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('declined');
  });

  it('carries the spine as DECORATION only', () => {
    renderWithIntl(<PlanItemNode item={item({ op: 'add' })} outcome="accepted" />);
    const spine = screen.getByTestId('plan-item-outcome-spine');
    expect(spine.getAttribute('aria-hidden')).toBe('true');
    expect(spine.textContent).toBe('');
  });
});

describe('mergePlanLevel', () => {
  /** A committed level as the roadmap read returns it. */
  function committed(ids: string[], deps: PlanCanvasLevel['deps'] = []): PlanCanvasLevel {
    return {
      nodes: ids.map((id) => ({
        id,
        parentId: 'parent_1',
        searchText: id,
        crumbLabel: id,
        drillable: false,
        content: <span>{id}</span>,
      })),
      deps,
    };
  }

  it('keeps EVERY committed sibling — including one nothing depends on', () => {
    // The point of the level model: a sibling is on the canvas because it is a
    // CHILD of the focused parent, never because something depends on it.
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b', 'wi_c']),
      [item({ planItemId: 'p1', nodeId: 'p1', op: 'add', parentNodeId: 'parent_1' })],
      'parent_1',
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['wi_a', 'wi_b', 'wi_c', 'p1']);
    // No edge anywhere, and all three siblings still render.
    expect(level.deps).toEqual([]);
  });

  it('re-skins a modify/remove IN PLACE rather than adding a ghost node', () => {
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b']),
      [item({ planItemId: 'p1', nodeId: 'wi_b', op: 'remove', parentNodeId: 'parent_1' })],
      'parent_1',
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['wi_a', 'wi_b']);
  });

  it('keeps the committed edges and adds a proposal edge when both ends are at this level', () => {
    const level = mergePlanLevel(
      committed(['wi_a'], [{ from: 'wi_a', to: 'wi_b', variant: 'firm' }]),
      [
        item({
          planItemId: 'p1',
          nodeId: 'p1',
          op: 'add',
          parentNodeId: 'parent_1',
          blockedByNodeIds: ['wi_a', 'off_level'],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([
      { from: 'wi_a', to: 'wi_b', variant: 'firm' },
      // `off_level` has no node here, so its edge is dropped — the same rule the
      // committed roadmap applies to an off-level blocker.
      { from: 'wi_a', to: 'p1', variant: 'pending' },
    ]);
  });

  it('only merges the proposals that belong at THIS level', () => {
    const items = [
      item({ planItemId: 'p1', nodeId: 'p1', op: 'add', parentNodeId: 'parent_1' }),
      item({ planItemId: 'p2', nodeId: 'p2', op: 'add', parentNodeId: 'other_parent' }),
      item({ planItemId: 'p3', nodeId: 'p3', op: 'add', parentNodeId: null }),
    ];

    expect(proposalsAtLevel(items, 'parent_1').map((i) => i.nodeId)).toEqual(['p1']);
    expect(proposalsAtLevel(items, null).map((i) => i.nodeId)).toEqual(['p3']);
    expect(mergePlanLevel(committed([]), items, 'parent_1').nodes.map((n) => n.id)).toEqual(['p1']);
  });

  it('holds exactly ONE node per approved add — on the work item it became', () => {
    // MOTIR-3160 keys a materialized `add` by its work item, so the proposal now
    // MATCHES the committed node and the treatment lands ON it. Before that it
    // never matched and was pushed out as a second, keyless node beside the real
    // one — two nodes for one thing, on a canvas whose job is the tree's shape.
    const level = mergePlanLevel(
      committed(['wi_new', 'wi_sibling']),
      [
        item({
          planItemId: 'pi_1',
          nodeId: 'wi_new',
          op: 'add',
          identifier: 'MOTIR-3166',
          parentNodeId: 'parent_1',
          status: 'todo',
        }),
      ],
      'parent_1',
      'accepted',
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['wi_new', 'wi_sibling']);
    expect(level.nodes.filter((n) => n.id === 'wi_new')).toHaveLength(1);
    expect(level.nodes.some((n) => n.id === 'pi_1')).toBe(false);

    renderWithIntl(<>{level.nodes[0]!.content}</>);
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('accepted');
    expect(screen.getByText('MOTIR-3166')).toBeTruthy();
  });

  it('draws a DECLINED plan proposals in the declined treatment, re-skinning modify/remove in place', () => {
    const level = mergePlanLevel(
      committed(['wi_mod', 'wi_untouched']),
      [
        item({ planItemId: 'pi_a', nodeId: 'pi_a', op: 'add', parentNodeId: 'parent_1' }),
        item({
          planItemId: 'pi_b',
          nodeId: 'wi_mod',
          op: 'modify',
          identifier: 'MOTIR-9',
          parentNodeId: 'parent_1',
        }),
      ],
      'parent_1',
      'declined',
    );

    // The modify re-skinned IN PLACE; the add appended; the untouched sibling
    // left alone. No ghosts.
    expect(level.nodes.map((n) => n.id)).toEqual(['wi_mod', 'wi_untouched', 'pi_a']);

    renderWithIntl(<>{level.nodes[0]!.content}</>);
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('declined');
    cleanup();

    renderWithIntl(<>{level.nodes[2]!.content}</>);
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('declined');
    cleanup();

    // The committed neighbour the plan decided NOTHING about carries no outcome.
    renderWithIntl(<>{level.nodes[1]!.content}</>);
    expect(screen.queryByTestId('plan-item-outcome')).toBeNull();
  });

  it('renders the proposals alone when the committed level is empty', () => {
    // The degraded path: a pre-project run, or a roadmap read that failed. The
    // surface still shows the plan rather than blanking.
    const level = mergePlanLevel(
      { nodes: [], deps: [] },
      [item({ planItemId: 'p1', nodeId: 'p1', op: 'add', hasChildren: true })],
      null,
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['p1']);
    expect(level.nodes[0]!.drillable).toBe(true);
  });
});

// ── bug MOTIR-3191 — where the canvas OPENS on a plan of amendments ───────────
//
// `mergePlanLevel` above has always re-skinned a `modify` in place once the
// canvas is on the right level. What decides which level that is, is
// `arrivalLevel` — and a `modify` reached it with a null parent, because it
// carries no `parentRef` and could not. So the canvas opened at the project
// ROOT, where the target is not a child, and the amendment fell through to the
// pushed branch as a node of its own beside the epics.
//
// ⚠️ These pass on `main` too, and that is the finding rather than a gap in
// them: `arrivalLevel` was never the broken half. It reads `parentNodeId` /
// `parentTrail` and does the right thing with whatever it is given — it was
// given null. So this locks the CONSUMER side of the contract the review model
// now satisfies, and the failing-without-the-fix half lives one layer down, in
// `planReviewService`'s own suite, where the null was produced.
describe('arrivalLevel', () => {
  it('opens a MODIFY-only plan at its target’s level, not at the root', () => {
    const arrival = arrivalLevel([
      item({
        planItemId: 'pi_1',
        nodeId: 'wi_target',
        op: 'modify',
        identifier: 'MOTIR-3181',
        title: 'An existing card',
        parentNodeId: 'wi_story',
        parentIdentifier: 'MOTIR-3070',
        parentTitle: 'Plan review',
        parentTrail: [
          { id: 'wi_epic', identifier: 'MOTIR-2200', title: 'The agent loop' },
          { id: 'wi_story', identifier: 'MOTIR-3070', title: 'Plan review' },
        ],
      }),
    ]);

    expect(arrival?.id).toBe('wi_story');
    // The whole committed chain, so the breadcrumb names the branch the card
    // lives on rather than starting at the level the plan does not touch.
    expect(arrival?.trail.map((c) => c.id)).toEqual(['wi_epic', 'wi_story']);
  });

  it('still opens at the ROOT when the plan genuinely proposes roots', () => {
    // A null parent is now a STATEMENT ("this card is a root"), not the absence
    // of an answer — so the root arrival has to keep working.
    expect(arrivalLevel([item({ op: 'add', parentNodeId: null })])).toBeNull();
  });

  it('takes the level carrying the MOST proposals when a mixed plan spans two', () => {
    const at = (nodeId: string, parent: string, key: string) =>
      item({
        planItemId: `pi_${nodeId}`,
        nodeId,
        parentNodeId: parent,
        parentIdentifier: key,
        parentTitle: 'A parent',
        parentTrail: [{ id: parent, identifier: key, title: 'A parent' }],
      });

    const arrival = arrivalLevel([
      at('a', 'wi_p1', 'MOTIR-1'),
      at('b', 'wi_p2', 'MOTIR-2'),
      at('c', 'wi_p2', 'MOTIR-2'),
    ]);

    expect(arrival?.id).toBe('wi_p2');
  });
});
