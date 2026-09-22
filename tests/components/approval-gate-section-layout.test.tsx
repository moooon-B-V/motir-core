// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// THE FRAME'S SECTION FORM (Story MOTIR-5215 · Subtask MOTIR-5569) — the frame
// flush inside a container someone else owns
// (`design/work-items/design-notes.md` § *The item page HANDS THE DECISION OVER*,
// *The kept states, flush in the section*).
//
// The design was sent back for drawing the frame's own bordered box and its own
// *Design result* label inside the section card that already carries both. The
// rule it settled is ONE container, ONE label, and it is what this suite pins:
// under `section` the frame draws no box and no kind label, and everything
// INSIDE the bands still renders. The frame's other suites are not edited — they
// render `inline`, and passing unchanged is their half of the proof.

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/MOTIR-4321',
  useSearchParams: () => new URLSearchParams(),
}));

import { DesignResultSection } from '@/app/(authed)/items/[key]/_components/DesignResultSection';
import { OptimisticStatusProvider } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';

afterEach(() => {
  cleanup();
});

const KIND_LABEL = en.approvalGate.designResult.kindLabel;

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
  confirmedRecord: null,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

const decided = (state: 'approved' | 'changes_requested'): ApprovalGateDTO => ({
  ...AWAITING,
  state,
  decidedById: 'user-2',
  decidedAt: '2026-09-08T05:00:00.000Z',
  decidedByLabel: 'Ada Lovelace',
  decidedUnderAuthority: 'assignee',
  decisionSource: 'ui',
});

const SUPERSEDED: ApprovalGateDTO = { ...AWAITING, state: 'superseded' };

const VERBS: GateVerb[] = [
  { decision: 'request_changes', label: 'Request changes', variant: 'secondary', confirms: false },
  { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
];

function renderFrame(
  gate: ApprovalGateDTO,
  layout?: 'inline' | 'fill' | 'section',
  canDecide = true,
) {
  return renderWithIntl(
    <ApprovalGateControl
      {...(layout ? { layout } : {})}
      gate={gate}
      canDecide={canDecide}
      kindLabel={KIND_LABEL}
      subjectMeta="version 9840d00e"
      port={<div data-testid="the-port">the subject, rendered</div>}
      verbs={VERBS}
      consequence="Approving moves MOTIR-4321 to Done."
      confirmConsequences={['records it']}
      routedToLabel="Ada Lovelace"
      filesKept={gate.state === 'approved' ? true : null}
      onDecide={async () => null}
    />,
  );
}

/** The frame's outer box — the element carrying the card chrome, or not. */
function frameBox(container: HTMLElement): HTMLElement {
  // The frame renders its (hidden) scrim first and the frame second.
  return container.children[1] as HTMLElement;
}

/** Every element in the frame drawing the card's own box. */
function cardChrome(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[class]')).filter((el) =>
    el.className.includes('rounded-(--radius-card)'),
  );
}

describe('ApprovalGateControl layout="section" (MOTIR-5569)', () => {
  it.each([
    ['awaiting', AWAITING],
    ['approved', decided('approved')],
    ['changes_requested', decided('changes_requested')],
    ['superseded', SUPERSEDED],
  ] as const)('%s — draws no box of its own and no kind label', (_state, gate) => {
    const { container } = renderFrame(gate, 'section');
    expect(cardChrome(container)).toHaveLength(0);
    expect(frameBox(container).className).not.toMatch(/(^|\s)border(\s|$)/);
    expect(screen.queryByText(KIND_LABEL, { exact: true })).toBeNull();
    // Band 1 keeps what the section title does not say: the version and the state.
    // (A decided record repeats the version from the audit column, hence `All`.)
    expect(screen.getAllByText('version 9840d00e').length).toBeGreaterThan(0);
  });

  it('awaiting — the port, the consequence and both verbs still render, with no band padding', () => {
    renderFrame(AWAITING, 'section');
    expect(screen.getByTestId('the-port')).toBeTruthy();
    expect(screen.getByText('Approving moves MOTIR-4321 to Done.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' });
    // Band 3's row: the host card's padding supplies the sides.
    const row = approve.closest('div.flex-wrap') as HTMLElement;
    expect(row.className).toContain('border-t');
    expect(row.className).not.toContain('px-4');
    const port = screen.getByRole('group', { name: en.approvalGate.port.label });
    expect(port.className).not.toContain('px-4');
    expect(port.className).toContain('min-h-[12.25rem]');
  });

  it('approved — the record and Files kept still render', () => {
    renderFrame(decided('approved'), 'section');
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText(en.approvalGate.record.filesKept)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('changes requested — the record says the agent will republish', () => {
    renderFrame(decided('changes_requested'), 'section');
    expect(screen.getByText(en.approvalGate.record.willRepublish)).toBeTruthy();
  });

  it('superseded — the dead port, and no verb', () => {
    renderFrame(SUPERSEDED, 'section');
    // MOTIR-5667: no cause on this fixture reads as `unknown` — the reason was
    // not recorded, which is what a row predating the column honestly is.
    expect(screen.getByText(en.approvalGate.withdrawn.cause.unknown)).toBeTruthy();
    expect(screen.queryByTestId('the-port')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('see but not decide (B) — who it waits on, and no verb', () => {
    renderFrame(AWAITING, 'section', false);
    expect(screen.getByText('Waiting on Ada Lovelace.', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it.each([undefined, 'inline', 'fill'] as const)(
    'layout=%s still draws the kind label — the section branch does not leak',
    (layout) => {
      renderFrame(AWAITING, layout);
      expect(screen.getByText(KIND_LABEL, { exact: true })).toBeTruthy();
    },
  );

  it('inline (the default) still draws the card box', () => {
    const { container } = renderFrame(AWAITING);
    expect(frameBox(container).className).toContain('rounded-(--radius-card)');
  });
});

/** A reachable note FILE is the smallest subject the port can SHOW (MOTIR-5498). */
const PUBLISHED: DesignEvidenceDTO = {
  id: 'ev-1',
  workItemId: 'wi-1',
  noteMd: '## The approvals room',
  noteTruncated: false,
  assets: [
    {
      id: 'a-note',
      kind: 'note_file',
      url: '/api/attachments/att-note/content',
      mimeType: 'text/markdown',
      sizeBytes: 64,
      sourcePath: 'design/approvals/design-notes.md',
      position: 0,
    },
  ],
  commitSha: 'cafe1234567',
  ciRunUrl: null,
  producedByKey: 'MOTIR-4320',
  createdAt: '2026-09-08T03:00:00.000Z',
  withdrawnAt: null,
  withdrawnById: null,
  withdrawnReason: null,
};

describe('DesignResultSection renders the frame flush (MOTIR-5569)', () => {
  it.each([
    ['awaiting, may decide', AWAITING, true],
    ['awaiting, may not decide', AWAITING, false],
    ['approved', decided('approved'), true],
    ['changes_requested', decided('changes_requested'), true],
    ['superseded', SUPERSEDED, true],
  ] as const)('%s — the kind label is drawn zero times inside it', (_case, gate, canDecide) => {
    const { container } = renderWithIntl(
      <OptimisticStatusProvider serverStatus="in_progress">
        <DesignResultSection
          evidence={PUBLISHED}
          isDesignCard
          gate={gate}
          canDecide={canDecide}
          subject={null}
          itemIdentifier="MOTIR-4321"
          routedToLabel="Ada Lovelace"
          routedToViewer={false}
        />
      </OptimisticStatusProvider>,
    );
    expect(screen.queryAllByText(KIND_LABEL, { exact: true })).toHaveLength(0);
    expect(cardChrome(container)).toHaveLength(0);
  });
});
