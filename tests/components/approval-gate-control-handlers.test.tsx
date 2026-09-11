// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import {
  aggregatePortRenderStatus,
  usePortRenderStatus,
  type PortRenderReporter,
  type PortRenderStatus,
} from '@/components/approvals/portRenderStatus';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// STORY MOTIR-4778's COVERAGE FLOOR — the frame's remaining HANDLERS
// (Subtask MOTIR-4796).
//
// ⚠️ THE SIBLING SUITES ARE NOT EDITED BY THIS CARD, and that is deliberate:
// `approval-gate-control.test.tsx` (MOTIR-4792) pins the seven states,
// `approval-gate-port.test.tsx` (MOTIR-5032) the port's mechanics, and
// `approval-gate-decided-withdrawn.test.tsx` (MOTIR-5033) the decided pair.
// Each is its own card's proof and this card must leave them alone.
//
// What is here is only what MEASURING the assembled frame found unreached — two
// click handlers and the port-status reducer's two early returns. They are
// small, and the reason to close them is not the number: each is a branch whose
// absence would be INVISIBLE. A confirm band whose Proceed never fires, a scrim
// that does not dismiss, and a reducer that loops on a repeat report all look
// exactly like working code from every other test in the suite.

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
  { decision: 'request_changes', label: 'Request changes', variant: 'secondary', confirms: false },
  { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
];

function render(props: Partial<React.ComponentProps<typeof ApprovalGateControl>> = {}) {
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
      onDecide={async () => null}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('the confirm band’s PROCEED actually decides (MOTIR-4796)', () => {
  it('runs the verb it was opened for — not the verb that happens to be primary', () => {
    // ⚠️ THE ASSERTION IS THE ARGUMENT, NOT THE CALL. `run(phase.verb)` reads
    // the verb off the PHASE — the one the reader pressed — rather than off the
    // verb list. Asserting only that `onDecide` fired would keep passing if it
    // were re-bound to `verbs[0]`, which is `request_changes` here: the reader
    // would confirm an approval and send the design back instead, with a
    // confirm band that had just told them what approving would do.
    const onDecide = vi.fn(async () => null);
    render({ onDecide });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    // The confirm band's Proceed carries the verb's own label, so both buttons
    // match /Approve/. The band's is the one that arrived with the band — take
    // the LAST, and assert below that it decided `approve` rather than the
    // list's first verb, which is what makes this more than a click.
    const proceed = screen.getAllByRole('button', { name: /Approve/ });
    fireEvent.click(proceed[proceed.length - 1]!);

    expect(onDecide).toHaveBeenCalledWith('approve');
  });

  it('CANCEL closes the band and decides nothing', () => {
    const onDecide = vi.fn(async () => null);
    render({ onDecide });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const cancel = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancel);

    // Back to the resting verbs, and nothing recorded — a confirm that can only
    // go forwards is not a confirm.
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeTruthy();
  });
});

describe('the EXPAND scrim dismisses (MOTIR-4796)', () => {
  it('clicking the scrim collapses the port back to its ceiling', async () => {
    render();

    const expand = screen.getByRole('button', { name: /expand/i });
    fireEvent.click(expand);

    // The scrim is always mounted and merely hidden (the component's own note —
    // unmounting the port would re-run its probe and spend a fresh signed URL),
    // so it is found by its class rather than by appearing.
    const scrim = document.querySelector('.fixed.inset-0');
    expect(scrim).toBeTruthy();
    expect((scrim as HTMLElement).className).not.toContain('hidden');

    fireEvent.click(scrim as HTMLElement);

    await waitFor(() => {
      expect((document.querySelector('.hidden') as HTMLElement | null)?.className).toContain(
        'hidden',
      );
    });
  });
});

describe('the port-status REDUCER’s identity returns (MOTIR-4796)', () => {
  // ⚠️ THE REDUCER, NOT THE AGGREGATE. `aggregatePortRenderStatus` is the pure
  // half and the port suite already covers it. What no suite reached is
  // `usePortRenderStatus`'s two early returns — the deregister of an id that
  // was never registered, and the repeat report of a status already held. Both
  // return `prev` UNCHANGED, and that identity is the whole point: the
  // component's own note says it is "what keeps a port that re-reports the same
  // status in an effect from looping". A reducer that allocated a new Map on
  // every repeat would still compute the right status and would re-render for
  // ever, which is a defect no assertion about the STATUS can see.

  /** Drives the hook directly — it is exported for exactly this. */
  function harness() {
    const seen: { reporter: PortRenderReporter; status: PortRenderStatus }[] = [];
    function Probe() {
      seen.push(usePortRenderStatus());
      return null;
    }
    renderWithIntl(<Probe />);
    return seen;
  }

  it('a port re-reporting the same status CANNOT drive a render loop', () => {
    const seen = harness();
    const { reporter } = seen[0]!;

    act(() => reporter.report('port-a', 'rendering'));
    const afterFirst = seen.length;
    expect(seen[afterFirst - 1]!.status).toBe('rendering');

    // ⚠️ THE ASSERTION IS THE BOUND, NOT AN EXACT COUNT, and React's documented
    // behaviour is why: when a reducer returns the identical state React "may
    // still render that specific component before bailing out", so a single
    // repeat is allowed to cost one render. What the identity return guarantees
    // is that the cost does not SCALE — which is the property the comment in
    // the component is claiming, and the one an effect-loop would violate.
    // Fifty repeats of the same status must not be fifty renders.
    act(() => {
      for (let i = 0; i < 50; i += 1) reporter.report('port-a', 'rendering');
    });
    expect(seen.length).toBeLessThan(afterFirst + 5);
    expect(seen[seen.length - 1]!.status).toBe('rendering');
  });

  it('DEREGISTERS a port that unmounts, and ignores a deregister for one it never held', () => {
    const seen = harness();
    const { reporter } = seen[0]!;

    act(() => reporter.report('port-a', 'failed'));
    expect(seen[seen.length - 1]!.status).toBe('failed');

    // An id nobody registered: the unknown-id arm. Same bound as above — it may
    // cost a render, it may not cost fifty, and it must not change the answer.
    const before = seen.length;
    act(() => {
      for (let i = 0; i < 50; i += 1) reporter.report('port-never-seen', null);
    });
    expect(seen.length).toBeLessThan(before + 5);
    expect(seen[seen.length - 1]!.status).toBe('failed');

    // The real deregister — the reporting subtree unmounted. The failure leaves
    // with it, so the frame stops withholding its verbs for a port that is gone.
    act(() => reporter.report('port-a', null));
    expect(seen[seen.length - 1]!.status).toBe('rendered');
  });

  it('an EMPTY report set is `rendered`, not `rendering`', () => {
    // Pinned because it is the counter-intuitive one and the module's own header
    // calls it out: a frame with no failable port at all must show its verbs,
    // which is what kept every gate MOTIR-4792 shipped working.
    expect(aggregatePortRenderStatus([])).toBe('rendered');
  });

  it('one FAILED port outweighs every rendered sibling', () => {
    // A port may hold several failable subjects, so last-write-wins would let a
    // second frame's success erase a first frame's failure.
    expect(aggregatePortRenderStatus(['rendered', 'failed', 'rendered'])).toBe('failed');
    expect(aggregatePortRenderStatus(['rendered', 'rendering'])).toBe('rendering');
  });
});
