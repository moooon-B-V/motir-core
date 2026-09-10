// @vitest-environment happy-dom
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import {
  aggregatePortRenderStatus,
  useReportPortRenderStatus,
  type PortRenderStatus,
} from '@/components/approvals/portRenderStatus';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// THE PORT'S MECHANICS AND STATE `X` (Story MOTIR-4778 · Subtask MOTIR-5032),
// built to `design/work-items/approval-control.mock.html` (panel 1, the anatomy,
// for the box and the Expand affordance; the `X` panel for the verb-less state)
// and `design-notes.md` § The UNIVERSAL APPROVAL FRAME.
//
// The sibling suite `approval-gate-control.test.tsx` pins the SEVEN states
// MOTIR-4792 shipped and is deliberately NOT edited by this card — the frame's
// existing behaviour is a thing this card must leave alone, so the assertion
// that it did is that suite passing unchanged. What is under test here is only
// what MOTIR-5032 adds: the floor, the ceiling with its own scroll, Expand, and
// the verbs gated on the port having RENDERED.
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
  { decision: 'request_changes', label: 'Request changes', variant: 'secondary', confirms: false },
  { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
];

/**
 * A port that DECLARES its render status — the shape a failable subject has.
 * Standing in for `MockFrame`, so this suite tests the FRAME's gating rather
 * than the design port's probe (which is `design-result-panel.test.tsx`'s).
 */
function ReportingPort({ status, children }: { status: PortRenderStatus; children?: string }) {
  useReportPortRenderStatus(status);
  return <div data-testid="the-port">{children ?? 'the subject, rendered'}</div>;
}

function render(
  props: Partial<React.ComponentProps<typeof ApprovalGateControl>> = {},
  options: { messages?: Record<string, unknown> } = {},
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
      onDecide={async () => null}
      {...props}
    />,
    options.messages ? { messages: options.messages } : {},
  );
}

/** The port's own box — the element carrying the floor, ceiling and scroll. */
function portBox(): HTMLElement {
  return screen.getByRole('group', { name: 'The subject being decided' });
}

afterEach(cleanup);

describe('the port BOX — a floor, and a ceiling with its own scroll', () => {
  it('renders the subject at or above a FLOOR, so it is never a sliver', () => {
    render({ port: <div data-testid="the-port">one line</div> });

    // The design's reason, not a number for its own sake: "a floor height, so
    // the subject is never a sliver". A one-line subject still occupies a port.
    expect(portBox().className).toContain('min-h-[');
  });

  it('CAPS the port and gives it its OWN scroll, so a tall subject cannot push the verbs off screen', () => {
    const { container } = render({
      port: (
        <div data-testid="the-port">
          {Array.from({ length: 400 }, (_, i) => (
            <p key={i}>a design-notes section runs hundreds of lines — line {i}</p>
          ))}
        </div>
      ),
    });

    const box = portBox();
    expect(box.className).toContain('max-h-[');
    expect(box.className).toContain('overflow-y-auto');

    // ⚠️ THE POINT OF THE CEILING, ASSERTED AS THE DESIGN STATES IT — the verb
    // band is STILL THERE, below a subject several hundred times the ceiling's
    // height. happy-dom does not lay out, so this cannot be an assertion about
    // pixels; what it CAN pin is that the tall subject is inside a bounded,
    // self-scrolling box and the verbs are its SIBLING rather than its
    // descendant, which is the structural fact that makes the pixels follow.
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeTruthy();
    expect(box.contains(approve)).toBe(false);
    expect(box.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain('line 399');
  });

  it('is reachable by keyboard as a scroll container', () => {
    render();
    // A scrollable region with no focusable content cannot be scrolled by
    // keyboard alone unless it is itself focusable.
    expect(portBox().getAttribute('tabindex')).toBe('0');
  });
});

describe('EXPAND — for a subject that deserves the whole viewport', () => {
  it('takes the port to the viewport and a matching control returns it', () => {
    render();

    const expand = screen.getByRole('button', { name: 'Expand' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(expand);

    // Expanded: the frame is a viewport-sized panel and the port has dropped
    // its floor and ceiling — expanded, the viewport IS the ceiling.
    const collapse = screen.getByRole('button', { name: 'Collapse' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    expect(portBox().className).not.toContain('max-h-[');

    fireEvent.click(collapse);
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy();
    expect(portBox().className).toContain('max-h-[');
  });

  it('KEEPS THE VERBS REACHABLE while expanded — the port shrinks, the verbs do not', () => {
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    // ⚠️ THIS IS THE ASSERTION THE CARD IS ABOUT, and the recipe it pins is
    // `Modal.Body`'s. In a flex column a child without `min-h-0` cannot shrink
    // below its content, so the panel CLIPS the overflow, no scrollbar appears
    // anywhere, and whatever sits at the bottom — here, the verbs — becomes
    // unreachable. `tests/theme/modalScrollContainerScan.ts` exists because two
    // instances shipped that way (MOTIR-462, MOTIR-2488) and in both the thing
    // made unreachable was the primary action.
    const box = portBox();
    expect(box.className).toContain('min-h-0');
    expect(box.className).toContain('flex-1');
    expect(box.className).toContain('overflow-y-auto');

    // And the verbs are still rendered, still after the port.
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(box.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('collapses on Escape', () => {
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Collapse' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy();
  });

  it('does NOT remount the port when it is expanded — a re-probe would spend a fresh signed URL', () => {
    let mounts = 0;
    function CountingPort() {
      useReportPortRenderStatus('rendered');
      // Counts MOUNTS, not renders — an effect with an empty dep list.
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div data-testid="the-port">counted</div>;
    }
    render({ port: <CountingPort /> });
    expect(mounts).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));

    // React reconciles by POSITION, so the scrim is always rendered (hidden
    // when collapsed) and the frame keeps its index. Were it wrapped only when
    // expanded, this would be 3.
    expect(mounts).toBe(1);
  });

  it('is NOT offered where there is no decision to make — `B`, the decided record, and `X`', () => {
    // ⚠️ THE ASSET SCOPES THE AFFORDANCE, and this is the assertion that keeps
    // it scoped. `approval-control.mock.html` draws `.portExpand` in exactly
    // three frames — panel 1 (state `A`) and panel `U`'s two — all of them
    // awaiting-YOURS over a rendered port, and in none of the eight state
    // frames `B`–`X`. The frame's own shipped suite says the same thing from
    // the other side: `queryAllByRole('button')` is EMPTY in `B` and in the
    // decided record. An always-on Expand broke both.
    render({ canDecide: false, routedToLabel: 'Mara S.' });
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    cleanup();

    render({ gate: { ...AWAITING, state: 'approved', decidedByLabel: 'Zhu Yue' } });
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    cleanup();

    // And nothing to expand when the port failed — the asset's `X` draws none.
    render({ port: <ReportingPort status="failed" /> });
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
  });

  it('KEEPS the way back when the port fails while expanded', async () => {
    function FailingPort() {
      const [status, setStatus] = useState<PortRenderStatus>('rendered');
      return (
        <>
          <ReportingPort status={status} />
          <button type="button" onClick={() => setStatus('failed')}>
            break it
          </button>
        </>
      );
    }
    render({ port: <FailingPort /> });
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('button', { name: 'break it' }));

    // Whatever hides the affordance must never hide the way OUT: a reader
    // stranded in a viewport-sized panel with no Collapse is a worse failure
    // than the one that stranded them.
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeTruthy();
  });

  it('carries its accessible names from the zh catalog too', () => {
    render({}, { messages: zhMessages as unknown as Record<string, unknown> });
    expect(screen.getByRole('button', { name: '展开' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy();
  });
});

describe('state `X` — the port failed, so there are NO verbs', () => {
  it('renders NO verbs at all — asserted on ABSENCE, never on a disabled attribute', () => {
    render({ port: <ReportingPort status="failed" /> });

    // ⚠️ `queryByRole` + null, not `.disabled`. A greyed button says the
    // decision is yours and the control is broken; the truth is that the
    // SUBJECT is missing. The design's own words: "you cannot approve what
    // cannot be shown."
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
  });

  it('renders the `X` copy and its next action instead', () => {
    render({ port: <ReportingPort status="failed" /> });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('You cannot approve what cannot be shown.');
    expect(alert.textContent).toContain('Retry above, or ask the agent to republish.');
    // The asset's band-3 sentence, which replaces the consequence: there is no
    // consequence to state when nothing is pressable.
    expect(screen.getByText('The verbs return when the subject renders.')).toBeTruthy();
  });

  it('KEEPS THE PORT — the reader still sees the frame and what it is about', () => {
    const { container } = render({ port: <ReportingPort status="failed" /> });
    // `X` is not an error page that replaces the frame: band 1 still says what
    // is being decided, and band 2 is still there.
    expect(container.textContent).toContain('Design result');
    expect(screen.getByTestId('the-port')).toBeTruthy();
  });

  it('withholds the verbs while the port is still RENDERING, and returns them when it renders', async () => {
    function SettlingPort() {
      const [status, setStatus] = useState<PortRenderStatus>('rendering');
      return (
        <>
          <ReportingPort status={status} />
          <button type="button" onClick={() => setStatus('rendered')}>
            settle
          </button>
        </>
      );
    }
    render({ port: <SettlingPort /> });

    // You cannot approve what is not yet on screen either — but this is NOT
    // `X`: nothing has failed, so there is no alert and no failure copy.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settle' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
  });

  it('a port that reports NOTHING is treated as shown — a static subject has no failure mode', () => {
    // This is what keeps every state MOTIR-4792 shipped, and every existing
    // consumer, untouched: silence means rendered.
    render({ port: <div data-testid="the-port">plain markdown</div> });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('gates in the FRAME, so a consumer passing a verb set and a failing port still gets no verbs', () => {
    // Rendered DIRECTLY, not through `DesignResultSection`: the verb set is
    // supplied, `canDecide` is true, and the only thing withholding the verbs is
    // the frame's own read of the port's report. A consumer cannot forget to
    // apply a rule it is not asked to apply.
    render({ port: <ReportingPort status="failed" />, canDecide: true, verbs: VERBS });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('cannot be shown');
  });

  it('a reader who may not decide still gets THEIR sentence, not the port one', () => {
    render({ port: <ReportingPort status="failed" />, canDecide: false, routedToLabel: 'Yue' });
    expect(screen.getByText('Waiting on Yue.')).toBeTruthy();
  });
});

describe('the aggregate — one failed subject among several fails the PORT', () => {
  it('takes any failure over any success', () => {
    expect(aggregatePortRenderStatus(['rendered', 'failed', 'rendered'])).toBe('failed');
    expect(aggregatePortRenderStatus(['rendering', 'failed'])).toBe('failed');
  });

  it('reports rendering while anything is still rendering', () => {
    expect(aggregatePortRenderStatus(['rendered', 'rendering'])).toBe('rendering');
  });

  it('an EMPTY set is rendered, not rendering — silence means shown', () => {
    expect(aggregatePortRenderStatus([])).toBe('rendered');
  });

  it('withholds the verbs when ONE of three subjects failed', () => {
    render({
      port: (
        <>
          <ReportingPort status="rendered" />
          <ReportingPort status="rendered" />
          <ReportingPort status="failed" />
        </>
      ),
    });
    // A reader who saw two of three mocks did not see what they are approving.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('RELEASES a failure when the reporting subtree unmounts', async () => {
    function Vanishing() {
      const [present, setPresent] = useState(true);
      return (
        <>
          {present ? <ReportingPort status="failed" /> : <div data-testid="the-port">gone</div>}
          <button type="button" onClick={() => setPresent(false)}>
            drop it
          </button>
        </>
      );
    }
    render({ port: <Vanishing /> });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'drop it' }));
    // Deregistration is what makes this work: a stale `failed` from an unmounted
    // frame would hold the verbs off for the rest of the session.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
  });
});
