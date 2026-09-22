// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type { ApprovalGateDTO, GateDecision } from '@/lib/dto/approvalGate';

// THE APPROVAL FRAME'S SETTINGS DOOR (Story MOTIR-4882 · Subtask MOTIR-5513),
// `design/work-items/approval-control.mock.html` panel `S` and
// `design-notes.md` § AMENDED 2026-09-13 — the SETTINGS DOOR.
//
// A KIND-SUPPLIED affordance, not a fourth band and not a verb: an optional
// `settingsDoor` the frame renders in band 3's LEFT column, UNDER the consequence
// line. A kind that supplies none renders band 3 byte-identical to state `A`.

const AWAITING: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'pull_request_merge',
  subjectId: 'pr-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: 'moooon-B-V/motir-core#2845@9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-14T04:00:00.000Z',
  updatedAt: '2026-09-14T04:00:00.000Z',
};

const VERBS: GateVerb[] = [
  { decision: 'request_changes', label: 'Request changes', variant: 'secondary', confirms: false },
  { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
];

function render(
  props: Partial<React.ComponentProps<typeof ApprovalGateControl>> = {},
  onDecide: (d: GateDecision) => Promise<GateRefusal | null> = async () => null,
) {
  return renderWithIntl(
    <ApprovalGateControl
      gate={AWAITING}
      canDecide
      kindLabel="Pull request · merge"
      subjectMeta="motir-core#2845"
      port={<div data-testid="the-port">the subject, rendered</div>}
      verbs={VERBS}
      consequence="Approving lets Motir merge this pull request."
      confirmConsequences={['records it', 'merges it']}
      onDecide={onDecide}
      {...props}
    />,
  );
}

/**
 * Band 3 — found from the Approve verb, not from the tree's shape: the verbs'
 * `span` sits directly inside band 3's row, so two hops up is the band whatever
 * wrappers the frame renders above it.
 */
function bandThree(): Element {
  const band = screen.getByRole('button', { name: 'Approve' }).parentElement?.parentElement;
  if (!band) throw new Error('the frame rendered no band 3');
  return band;
}

afterEach(cleanup);

describe('no door supplied — band 3 is byte-identical to state A', () => {
  // ⚠️ RECORDED BEFORE THE DOOR EXISTED. This snapshot was written against the
  // frame as MOTIR-4792 shipped it, and only then was the optional prop added — so
  // a match after the change is evidence that a kind supplying no door renders
  // exactly what every call site rendered before, not a snapshot of whatever the
  // new code happens to draw.
  it('renders band 3 exactly as the shipped state A', () => {
    render();
    expect(bandThree().outerHTML).toMatchSnapshot();
  });
});

describe('a door supplied — a link under the consequence line that decides nothing', () => {
  const DOOR = {
    href: '/settings/project/approvals#merge-mode',
    label: 'Change how this project merges pull requests →',
  };

  it('renders a LINK, not a button, in band 3 — after the consequence line and before the verbs', () => {
    render({ settingsDoor: DOOR });

    const link = screen.getByRole('link', { name: DOOR.label });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(DOOR.href);
    // Same tab — coming back is the browser's Back (panel `S`).
    expect(link.getAttribute('target')).toBeNull();
    expect(screen.queryByRole('button', { name: DOOR.label })).toBeNull();

    // In band 3, in its LEFT column: after the consequence sentence, and before the
    // verbs — never in the header, never beside the verbs.
    expect(bandThree().contains(link)).toBe(true);
    const consequence = screen.getByText('Approving lets Motir merge this pull request.');
    expect(
      consequence.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(link.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(consequence.parentElement).toBe(link.parentElement);
  });

  it('decides nothing when it is activated — the gate stays awaiting', () => {
    const onDecide = vi.fn(async () => null);
    render({ settingsDoor: DOOR }, onDecide);

    fireEvent.click(screen.getByRole('link', { name: DOOR.label }));

    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByText('Awaiting you')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });
});
