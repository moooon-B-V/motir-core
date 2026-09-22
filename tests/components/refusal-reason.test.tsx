// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import {
  REASON_CLAMP_CHARS,
  RefusalReasonCell,
  showsRefusalReason,
  useRefusalVerb,
  type RefusalSubject,
} from '@/components/approvals/RefusalReason';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { ApprovalRow } from '@/components/approvals/ApprovalRow';
import type { ApprovalRecordDecidedRowDto } from '@/lib/dto/approvalGate';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

// A REFUSAL SAYS WHY (Story MOTIR-6067 · Subtask MOTIR-6075; ADR `approval-gates.md`
// §10a–§10b; design `approval-control--refusal-reason.mock.html`, the row deltas).
// The frame asks every refusal for a reason and the record reads it back. The three
// frames that build a refusal verb have their own specs (`approval-overlay`,
// `development-gate-verbs`, `choice-gate`); this file holds what they SHARE.

const reason = en.approvalGate.reason;

const GATE: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: '3f9a21c07d',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-23T09:00:00.000Z',
  updatedAt: '2026-09-23T09:00:00.000Z',
};

const decided = (over: Partial<ApprovalGateDTO>): ApprovalGateDTO => ({
  ...GATE,
  state: 'changes_requested',
  decidedById: 'user-1',
  decidedAt: '2026-09-23T10:14:00.000Z',
  decidedByLabel: 'Yue',
  decisionSource: 'ui',
  ...over,
});

/** The frame, with the SHARED refusal verb built exactly as the three frames build it. */
function Frame({
  gate,
  subject = 'version',
  onDecide,
}: {
  gate: ApprovalGateDTO;
  subject?: RefusalSubject;
  onDecide: (d: string, o?: string, n?: string) => Promise<GateRefusal | null>;
}) {
  const refusalVerb = useRefusalVerb();
  const verbs: GateVerb[] = [
    refusalVerb(subject, 'ACME-51'),
    { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
  ];
  return (
    <ApprovalGateControl
      gate={gate}
      canDecide
      kindLabel="Design result"
      subjectMeta="version 3f9a21c0"
      port={<div>the subject</div>}
      verbs={verbs}
      consequence="Approving moves ACME-51 to Done."
      confirmConsequences={['records it', 'moves it to Done']}
      onDecide={onDecide as never}
    />
  );
}

afterEach(cleanup);

describe('the refusal verb ASKS WHY (ADR §10a)', () => {
  it('opens the confirm band with the reason field — the press sends nothing', () => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame gate={GATE} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));

    expect(screen.getByText(reason.title)).toBeTruthy();
    expect(screen.getByText(reason.consequence.versionBack)).toBeTruthy();
    expect(screen.getByText('Leave ACME-51 where it is — nothing moves yet.')).toBeTruthy();
    expect(screen.getByLabelText(reason.label)).toBeTruthy();
    expect(screen.getByText(reason.helper)).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('refuses an EMPTY press in place — the field’s own error, and no request', () => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame gate={GATE} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));

    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: reason.proceed }));

    expect(screen.getByText(reason.required)).toBeTruthy();
    expect(screen.getByLabelText(reason.label).getAttribute('aria-invalid')).toBe('true');
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('sends the TRIMMED reason with the press', async () => {
    const onDecide = vi.fn(async () => null);
    renderWithIntl(<Frame gate={GATE} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    fireEvent.change(screen.getByLabelText(reason.label), {
      target: { value: '  The empty state needs the illustration.  ' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: reason.proceed }));
    });

    expect(onDecide).toHaveBeenCalledWith(
      'request_changes',
      undefined,
      'The empty state needs the illustration.',
    );
  });

  it('answers the DOOR’s empty-reason refusal IN PLACE — the band reopens with the error', async () => {
    // A stale client or a race: the door refuses what the frame let through.
    const onDecide = vi.fn(async () => ({ tag: 'APPROVAL_GATE_VERB_NOT_OFFERED' }) as GateRefusal);
    renderWithIntl(<Frame gate={GATE} onDecide={onDecide} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    });
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: reason.proceed }));
    });

    expect(screen.getByText(reason.required)).toBeTruthy();
    expect(screen.getByLabelText(reason.label)).toBeTruthy();
    // Not the generic refusal alert: the answer is the field's, where the reader is.
    expect(screen.queryByText(en.approvalGate.refusal.verbNotOffered.title)).toBeNull();
  });

  it.each([
    ['commits', reason.consequence.commitsBack, reason.consequence.mergeNothing],
    ['decision', reason.consequence.decisionBack, reason.consequence.docStays],
  ] as const)('the %s refusal says what it sends back', (subject, first, second) => {
    renderWithIntl(<Frame gate={GATE} subject={subject} onDecide={vi.fn(async () => null)} />);
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    expect(screen.getByText(first)).toBeTruthy();
    expect(screen.getByText(second)).toBeTruthy();
  });

  it('speaks zh', () => {
    renderWithIntl(<Frame gate={GATE} onDecide={vi.fn(async () => null)} />, {
      locale: 'zh',
      messages: zh as unknown as Record<string, unknown>,
    });
    fireEvent.click(screen.getByRole('button', { name: zh.approvalGate.verb.requestChanges }));
    expect(screen.getByLabelText(zh.approvalGate.reason.label)).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.approvalGate.reason.proceed })).toBeTruthy();
  });
});

describe('a send that FAILS in transit is shown in place and retried (MOTIR-6077)', () => {
  it('a thrown decide is the UNEXPECTED refusal, and the verb stays pressable with the reason kept', async () => {
    const onDecide = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(null);
    renderWithIntl(<Frame gate={GATE} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: 'Too tall.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: reason.proceed }));
    });

    expect(screen.getByText(en.approvalGate.refusal.unexpected.title)).toBeTruthy();
    const verb = screen.getByRole('button', {
      name: en.approvalGate.verb.requestChanges,
    }) as HTMLButtonElement;
    expect(verb.disabled).toBe(false);

    // The retry: the band reopens with what was typed, and the second send lands.
    fireEvent.click(verb);
    expect((screen.getByLabelText(reason.label) as HTMLTextAreaElement).value).toBe('Too tall.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: reason.proceed }));
    });
    expect(onDecide).toHaveBeenLastCalledWith('request_changes', undefined, 'Too tall.');
  });

  it('any OTHER refusal still withholds the verbs — it would be refused again', async () => {
    const onDecide = vi.fn(async () => ({ tag: 'APPROVAL_GATE_SUPERSEDED' }) as GateRefusal);
    renderWithIntl(<Frame gate={GATE} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    fireEvent.change(screen.getByLabelText(reason.label), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: reason.proceed }));
    });
    expect(
      (
        screen.getByRole('button', {
          name: en.approvalGate.verb.requestChanges,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe('the DECIDED record QUOTES the reason (design Panel 4)', () => {
  const noop = vi.fn(async () => null);

  it('a short reason, quoted after who and when', () => {
    renderWithIntl(<Frame gate={decided({ noteMd: 'Needs the illustration.' })} onDecide={noop} />);
    expect(screen.getByText('“Needs the illustration.”')).toBeTruthy();
    expect(screen.queryByRole('button', { name: reason.record.showAll })).toBeNull();
  });

  it('a LONG reason clamps to three lines and Show all expands it in place', () => {
    const long = 'x'.repeat(REASON_CLAMP_CHARS + 1);
    renderWithIntl(<Frame gate={decided({ noteMd: long })} onDecide={noop} />);
    const quote = screen.getByText(`“${long}”`);
    expect(quote.className).toContain('line-clamp-3');

    fireEvent.click(screen.getByRole('button', { name: reason.record.showAll }));
    expect(quote.className).not.toContain('line-clamp-3');
    expect(
      screen.getByRole('button', { name: reason.record.showLess }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('a reason of MANY short lines clamps too', () => {
    renderWithIntl(<Frame gate={decided({ noteMd: 'a\nb\nc\nd' })} onDecide={noop} />);
    expect(screen.getByRole('button', { name: reason.record.showAll })).toBeTruthy();
  });

  it('a GitHub review’s body, quoted under the GitHub sentence', () => {
    renderWithIntl(
      <Frame
        gate={decided({
          decisionSource: 'github',
          decidedByLabel: '@ada-l',
          decidedById: null,
          noteMd: 'Add a ceiling.',
        })}
        onDecide={noop}
      />,
    );
    expect(screen.getByText('Changes requested on GitHub by @ada-l')).toBeTruthy();
    expect(screen.getByText('“Add a ceiling.”')).toBeTruthy();
  });

  it('a GitHub review with NO body says so, in words', () => {
    renderWithIntl(
      <Frame gate={decided({ decisionSource: 'github', noteMd: null })} onDecide={noop} />,
    );
    expect(screen.getByText(reason.record.noneOnGithub)).toBeTruthy();
  });

  it('a refusal recorded BEFORE the reason was required quotes nothing and reports no absence', () => {
    renderWithIntl(<Frame gate={decided({ noteMd: null })} onDecide={noop} />);
    expect(screen.queryByText(reason.record.noneOnGithub)).toBeNull();
    expect(screen.queryByText(/“/)).toBeNull();
  });

  it('an APPROVAL’s note is never quoted as a reason', () => {
    renderWithIntl(
      <Frame
        gate={decided({ state: 'approved', noteMd: 'acme/web#1@abc — approved by @ada-l' })}
        onDecide={noop}
      />,
    );
    expect(screen.queryByText(/approved by @ada-l”/)).toBeNull();
  });
});

describe('the decided ROW carries the reason’s first line', () => {
  it('shows when there is a reason, or a GitHub refusal without one — never otherwise', () => {
    expect(showsRefusalReason('changes_requested', 'why', 'ui')).toBe(true);
    expect(showsRefusalReason('changes_requested', null, 'github')).toBe(true);
    expect(showsRefusalReason('changes_requested', '  ', 'ui')).toBe(false);
    expect(showsRefusalReason('approved', 'why', 'ui')).toBe(false);
  });

  it('quotes the FIRST line and keeps the version and the whole reason in its title', () => {
    renderWithIntl(<RefusalReasonCell reason={'First line.\nSecond line.'} version="3f9a21c07d" />);
    const cell = screen.getByTestId('refusal-reason-cell');
    expect(cell.textContent).toBe('“First line.”');
    expect(cell.getAttribute('title')).toBe('on 3f9a21c0 — First line.\nSecond line.');
  });

  it('says a GitHub refusal gave no reason', () => {
    renderWithIntl(<RefusalReasonCell reason={null} version={null} />);
    const cell = screen.getByTestId('refusal-reason-cell');
    expect(cell.textContent).toBe(en.approvalGate.reason.row.noneOnGithub);
    expect(cell.getAttribute('title')).toBeNull();
  });
});

describe('ApprovalRow — the reason REPLACES the details on a refused row only', () => {
  const row = (over: Partial<ApprovalRecordDecidedRowDto>): ApprovalRecordDecidedRowDto => ({
    gateId: 'g1',
    kind: 'design_result',
    state: 'changes_requested',
    decidedAt: new Date(Date.now() - 3_600_000).toISOString(),
    decidedByLabel: 'Yue',
    decisionSource: 'ui',
    subjectVersion: '3f9a21c07d',
    waitingSince: new Date(Date.now() - 7_200_000).toISOString(),
    workItem: {
      id: 'w1',
      key: 51,
      identifier: 'ACME-51',
      title: 'Empty state for the exports list',
      kind: 'subtask',
      type: 'design',
    },
    subject: { kind: 'design_result' } as ApprovalRecordDecidedRowDto['subject'],
    chosenOption: null,
    confirmedRecord: null,
    refusalReason: 'Needs the illustration.\nAnd a heading.',
    ...over,
  });

  it('a refused row quotes its reason’s first line', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'decided', row: row({}) }} />);
    expect(screen.getByTestId('refusal-reason-cell').textContent).toBe(
      '\u201CNeeds the illustration.\u201D',
    );
  });

  it('an approved row keeps its shipped details', () => {
    renderWithIntl(
      <ApprovalRow
        record={{ section: 'decided', row: row({ state: 'approved', refusalReason: null }) }}
      />,
    );
    expect(screen.queryByTestId('refusal-reason-cell')).toBeNull();
  });
});
