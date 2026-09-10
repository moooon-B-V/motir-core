// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import { REFUSAL_TAGS_ARE_TOTAL, type GateRefusal } from '@/lib/approvalGates/refusals';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// THE UNIVERSAL APPROVAL FRAME (Story MOTIR-4778 · Subtask MOTIR-4792), built to
// `design/work-items/approval-control.mock.html`. This suite pins the SEVEN
// states this card draws and every member of the refusal union, because the
// frame's whole claim is that approving means one thing everywhere — a state it
// renders wrongly is a second approval language, and a refusal it cannot render
// is a blank box on the surface built to explain refusals in place.
//
// The two states this card does NOT draw are MOTIR-5032's (`X`, the port failed)
// and MOTIR-5033's (`E`'s pinned port, and `G`, superseded).
//
// happy-dom + the repo's own matchers (there is no jest-dom here), so assertions
// read `.toBeTruthy()` / `.textContent`, never `.toBeInTheDocument()`.

const AWAITING: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

const VERBS: GateVerb[] = [
  {
    decision: 'request_changes',
    label: 'Request changes',
    variant: 'secondary',
    confirms: false,
  },
  { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
];

/** The frame with its design-result props; overrides go on top. */
function render(
  props: Partial<React.ComponentProps<typeof ApprovalGateControl>> = {},
  onDecide: (d: 'approve' | 'request_changes') => Promise<GateRefusal | null> = async () => null,
) {
  return renderWithIntl(
    <ApprovalGateControl
      gate={AWAITING}
      canDecide
      kindLabel="Design result"
      subjectMeta="version 9840d00e"
      port={<div data-testid="the-port">the subject, rendered</div>}
      verbs={VERBS}
      consequence="Approving moves MOTIR-4321 to Done."
      confirmConsequences={['records it', 'keeps the files', 'moves it to Done']}
      onDecide={onDecide}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('the three bands', () => {
  it('renders the PORT in every state it draws, and the verbs BELOW it', () => {
    const { container } = render();

    const port = screen.getByTestId('the-port');
    expect(port).toBeTruthy();

    // ⚠️ THE ORDER IS THE DESIGN'S WHOLE CORRECTION — "you decide after you
    // look". A refactor that hoists the verbs above the port passes every other
    // assertion in this file, so the ordering is pinned here explicitly:
    // `compareDocumentPosition` says the Approve button FOLLOWS the port.
    const approve = screen.getByRole('button', { name: 'Approve' });
    const relation = port.compareDocumentPosition(approve);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(container.textContent).toContain('Design result');
    expect(container.textContent).toContain('version 9840d00e');
  });
});

describe('A · awaiting, yours to decide', () => {
  it('renders both verbs and what approving will DO', () => {
    const { container } = render();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeTruthy();
    expect(container.textContent).toContain('Approving moves MOTIR-4321 to Done.');
    expect(container.textContent).toContain('Awaiting you');
  });
});

describe('B · awaiting, NOT yours to decide', () => {
  it('keeps the port and renders NO verbs at all — absent, not disabled', () => {
    render({ canDecide: false, routedToLabel: 'Mara S.' });

    // The port is still there: a reader who may not decide can still SEE what is
    // being decided.
    expect(screen.getByTestId('the-port')).toBeTruthy();

    // ⚠️ ASSERTED ON ABSENCE, not on a disabled attribute. A greyed-out button
    // tells a reader the control is theirs and broken; the design's `B` has no
    // verbs at all, and `queryAllByRole` returning [] is the only way to say so.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/Waiting on Mara S\./)).toBeTruthy();
  });

  it('names the assignee generically when the routed-to label is unknown', () => {
    const { container } = render({ canDecide: false, routedToLabel: null });
    expect(container.textContent).toContain("this work item's assignee");
  });
});

describe('C · confirming', () => {
  it('opens an INLINE band over the verbs — never a modal — listing what approving does', async () => {
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(screen.getByText('Approving this will:')).toBeTruthy());
    expect(screen.getByText('records it')).toBeTruthy();
    expect(screen.getByText('keeps the files')).toBeTruthy();

    // ⚠️ NOT A MODAL. A modal would take the port off screen at exactly the
    // moment the reader wants one last look, so the port must still be rendered
    // and there must be no dialog role anywhere.
    expect(screen.getByTestId('the-port')).toBeTruthy();
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  });

  it('cancels back to the verbs without deciding', async () => {
    const onDecide = vi.fn(async () => null);
    render({}, onDecide);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('Approving this will:')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('does NOT confirm a verb whose `confirms` is false — request changes goes straight through', async () => {
    const onDecide = vi.fn(async () => null);
    render({}, onDecide);

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('request_changes'));
    expect(screen.queryByText('Approving this will:')).toBeFalsy();
  });
});

describe('D · in flight', () => {
  it('disables the verbs and says the decision is being recorded', async () => {
    let release: (r: GateRefusal | null) => void = () => {};
    const pending = new Promise<GateRefusal | null>((r) => {
      release = r;
    });
    const { container } = render({}, () => pending);

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(container.textContent).toContain('Recording');

    release(null);
  });
});

describe('E / F · the decided record', () => {
  it('renders the provenance strip and no verbs once the gate is approved', () => {
    render({
      gate: {
        ...AWAITING,
        state: 'approved',
        decidedByLabel: 'Zhu Yue',
        decidedAt: '2026-09-08T04:12:00.000Z',
      },
    });
    expect(screen.getByText('Zhu Yue')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('the-port')).toBeTruthy();
  });

  it('says the agent will republish when changes were requested', () => {
    const { container } = render({
      gate: {
        ...AWAITING,
        state: 'changes_requested',
        decidedByLabel: 'Zhu Yue',
        decidedAt: '2026-09-08T03:58:00.000Z',
      },
    });
    expect(container.textContent).toContain('the agent will publish a new version');
  });

  it('says so rather than inventing a name when attribution did not survive', () => {
    const { container } = render({
      gate: { ...AWAITING, state: 'approved', decidedByLabel: null, decidedAt: null },
    });
    expect(container.textContent).toContain('No longer attributable');
  });
});

describe('H · refused — every member of the union renders in place, with a next action', () => {
  // ⚠️ ONE CASE PER MEMBER. The union is total over the service's
  // `ApprovalGateErrorTag`, so this list is what makes "adding a member without
  // handling it fails" a fact at RUNTIME as well as at compile time.
  const REFUSALS: Array<{ refusal: GateRefusal; expect: RegExp }> = [
    {
      refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Mara S.' },
      expect: /Mara S\. decided this a moment ago\./,
    },
    {
      refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: null },
      expect: /Someone decided this a moment ago\./,
    },
    { refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' }, expect: /newer version was published/ },
    { refusal: { tag: 'APPROVAL_GATE_NOT_AUTHORISED' }, expect: /not yours to make/ },
    { refusal: { tag: 'APPROVAL_GATE_NOT_FOUND' }, expect: /no longer here/ },
    { refusal: { tag: 'APPROVAL_GATE_KIND_UNREGISTERED' }, expect: /cannot decide this kind/ },
    { refusal: { tag: 'APPROVAL_GATE_ALREADY_AWAITING' }, expect: /already waiting/ },
    { refusal: { tag: 'APPROVAL_GATE_DECIDED_IMMUTABLE' }, expect: /cannot be changed/ },
    { refusal: { tag: 'UNEXPECTED' }, expect: /could not be recorded/ },
  ];

  it.each(REFUSALS)(
    'draws $refusal.tag in place, keeping the port',
    async ({ refusal, expect: re }) => {
      render({}, async () => refusal);

      fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(re);
      // Every refusal carries a NEXT ACTION — a refusal that only says no is a
      // dead end on the one surface built to explain itself.
      expect(alert.textContent!.length).toBeGreaterThan(
        alert.textContent!.split('.')[0].length + 5,
      );
      // The subject stays readable while the refusal is shown.
      expect(screen.getByTestId('the-port')).toBeTruthy();
    },
  );
});

describe('band 3 is a SLOT the kind fills', () => {
  it('renders the verb SET it is given, so a pair is one case and not the shape', () => {
    // ⚠️ A THREE-VERB SET, which `design_result` never uses. The choice gate
    // (MOTIR-4914) hands the same band N options, and this asserts the band
    // follows the DATA rather than a hard-coded pair.
    render({
      verbs: [
        { decision: 'request_changes', label: 'Send back', variant: 'secondary', confirms: false },
        { decision: 'approve', label: 'Ship it', variant: 'primary', confirms: false },
      ],
    });
    expect(screen.getByRole('button', { name: 'Send back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ship it' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeFalsy();
  });
});

describe('the refusal union is TOTAL over the service tags', () => {
  it('compiles its own proof', () => {
    // `REFUSAL_TAGS_ARE_TOTAL` is typed `Exclude<ApprovalGateErrorTag,
    // GateRefusalTag> extends never ? true : never`. A tag added to the service
    // and not handled in `refusals.ts` makes that type `never`, and the
    // assignment in that module stops compiling — so this file failing to
    // typecheck IS the assertion. The runtime check is the reminder.
    expect(REFUSAL_TAGS_ARE_TOTAL).toBe(true);
  });
});
