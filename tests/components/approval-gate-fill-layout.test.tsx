// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// THE FRAME'S FILL FORM (Story MOTIR-5214 · Subtask MOTIR-5224) — the ONE layout
// input the approval overlay composes the frame through
// (`design/workbench/design-notes.md` § 22 *THE FILL FORM*, planning flag 1).
//
// The frame's own suites are NOT edited by this card: `inline` is the default, so
// every one of them still renders what it rendered, and those suites passing
// unchanged is the assertion that it does. What is under test here is only what
// `fill` changes — the BOX — and that it changes nothing inside it.

const AWAITING: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  chosenOption: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

const VERBS: GateVerb[] = [
  { decision: 'request_changes', label: 'Request changes', variant: 'secondary', confirms: false },
  { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
];

function renderFrame(layout?: 'inline' | 'fill') {
  return renderWithIntl(
    <ApprovalGateControl
      {...(layout ? { layout } : {})}
      gate={AWAITING}
      canDecide
      kindLabel="Design result"
      subjectMeta="version 9840d00e"
      port={<div data-testid="the-port">the subject, rendered</div>}
      verbs={VERBS}
      consequence="Approving moves MOTIR-4321 to Done."
      confirmConsequences={['records it']}
      onDecide={async () => null}
    />,
  );
}

/** The frame's outer box — the element carrying the card chrome, or not. */
function frameBox(container: HTMLElement): HTMLElement {
  // The frame renders its (hidden) scrim first and the frame second.
  return container.children[1] as HTMLElement;
}

afterEach(cleanup);

describe('ApprovalGateControl layout="fill" (MOTIR-5224)', () => {
  it('defaults to inline — the card chrome, the floor, the ceiling and Expand are all there', () => {
    const { container } = renderFrame();
    expect(frameBox(container).className).toContain('rounded-(--radius-card)');
    const port = screen.getByRole('group', { name: en.approvalGate.port.label });
    expect(port.className).toContain('min-h-[12.25rem]');
    expect(port.className).toContain('max-h-[34rem]');
    expect(screen.getByRole('button', { name: en.approvalGate.port.expand })).toBeTruthy();
  });

  it('drops the card chrome: no radius, no border, a flex column that takes its height', () => {
    const { container } = renderFrame('fill');
    const box = frameBox(container);
    expect(box.className).not.toContain('rounded-(--radius-card)');
    expect(box.className).not.toMatch(/\bborder\b/);
    expect(box.className).toContain('min-h-0');
    expect(box.className).toContain('flex-1');
    expect(box.className).toContain('flex-col');
  });

  it('gives the port the viewport — the scroll-owner recipe, with no floor and no ceiling', () => {
    renderFrame('fill');
    const port = screen.getByRole('group', { name: en.approvalGate.port.label });
    for (const cls of ['min-h-0', 'flex-1', 'overflow-y-auto'])
      expect(port.className).toContain(cls);
    expect(port.className).not.toContain('min-h-[12.25rem]');
    expect(port.className).not.toContain('max-h-[34rem]');
  });

  it('offers no Expand, because the overlay already is the expanded form', () => {
    renderFrame('fill');
    expect(screen.queryByRole('button', { name: en.approvalGate.port.expand })).toBeNull();
  });

  it('changes nothing inside the box — the port, the consequence and every verb still render', () => {
    renderFrame('fill');
    expect(screen.getByTestId('the-port')).toBeTruthy();
    expect(screen.getByText('Approving moves MOTIR-4321 to Done.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByText('Design result')).toBeTruthy();
  });
});
