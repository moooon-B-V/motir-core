// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import {
  ApprovalGateControl,
  type ApprovalGateControlProps,
  type GateVerb,
} from '@/components/approvals/ApprovalGateControl';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// THE FRAME'S FLUSH FORM AND ITS THREE KIND-SUPPLIED SLOTS (Story MOTIR-4909 · Subtask
// MOTIR-5484; `design/github/design-notes.md` §20 *No card inside a card*).
//
// `flush` is for a frame INSIDE a section card that is already the container: the box's
// chrome comes off as in `fill`, and the port keeps what `inline` gives it. The three slots
// are presentational too — absent, the frame renders exactly what it did, which the frame's
// own suites passing unedited assert.

const AWAITING: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'pull_request_approval',
  subjectId: 'wi-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: null,
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  chosenOption: null,
  createdAt: '2026-09-15T04:00:00.000Z',
  updatedAt: '2026-09-15T04:00:00.000Z',
};

const VERBS: GateVerb[] = [
  { decision: 'request_changes', label: 'Request changes', variant: 'secondary', confirms: false },
  { decision: 'approve', label: 'Approve and merge', variant: 'primary', confirms: true },
];

function renderFrame(props: Partial<ApprovalGateControlProps> = {}) {
  return renderWithIntl(
    <ApprovalGateControl
      layout="flush"
      gate={AWAITING}
      canDecide
      kindLabel="Pull requests"
      subjectMeta="2 pull requests"
      port={<div data-testid="the-port">the rows, rendered</div>}
      verbs={VERBS}
      consequence="Approving merges both."
      confirmConsequences={['merges both']}
      onDecide={async () => null}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('ApprovalGateControl layout="flush" (MOTIR-5484)', () => {
  it('drops the card chrome — no radius, no border — and is a flex column', () => {
    const { container } = renderFrame();
    // The frame renders its (hidden) scrim first and the frame second.
    const box = container.children[1] as HTMLElement;
    expect(box.className).toBe('flex flex-col overflow-hidden');
    expect(box.className).not.toContain('rounded-(--radius-card)');
    expect(box.className).not.toMatch(/\bborder\b/);
  });

  it('keeps the port inline: the floor, the ceiling and Expand', () => {
    renderFrame();
    const port = screen.getByRole('group', { name: en.approvalGate.port.label });
    expect(port.className).toContain('min-h-[12.25rem]');
    expect(port.className).toContain('max-h-[34rem]');
    expect(screen.getByRole('button', { name: en.approvalGate.port.expand })).toBeTruthy();
  });

  it('draws a kind-supplied ALERT between the port and band 3', () => {
    renderFrame({ alert: <div role="alert">moooon/motir-ai · #88 was not merged.</div> });
    const port = screen.getByRole('group', { name: en.approvalGate.port.label });
    const alert = screen.getByRole('alert');
    const verb = screen.getByRole('button', { name: 'Approve and merge' });
    expect(port.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(verb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('adds the kind’s RECORD DETAIL to a decided record strip, and only there', () => {
    renderFrame({ recordDetail: <span>2 commits</span> });
    expect(screen.queryByText('2 commits')).toBeNull();
    cleanup();
    renderFrame({
      gate: {
        ...AWAITING,
        state: 'approved',
        decidedByLabel: 'Ada L.',
        decidedAt: AWAITING.createdAt,
      },
      recordDetail: <span>2 commits</span>,
    });
    expect(screen.getByText('Ada L.')).toBeTruthy();
    expect(screen.getByText('2 commits')).toBeTruthy();
  });

  it('draws the kind’s WITHDRAWN words in the dead port, and the frame’s own without them', () => {
    const superseded = { ...AWAITING, state: 'superseded' as const };
    renderFrame({
      gate: superseded,
      withdrawnPort: { port: 'A push moved the head of #88.', cite: 'Nobody decided it.' },
    });
    expect(screen.getByText('A push moved the head of #88.')).toBeTruthy();
    expect(screen.queryByText(en.approvalGate.withdrawn.cause.unknown)).toBeNull();
    cleanup();
    renderFrame({ gate: superseded });
    expect(screen.getByText(en.approvalGate.withdrawn.cause.unknown)).toBeTruthy();
  });
});
