// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// THE FRAME'S DECIDED AND WITHDRAWN STATES (Story MOTIR-4778 · Subtask
// MOTIR-5033), built to `design/work-items/approval-control.mock.html` panels
// `E` and `G` and to `design-notes.md` § The UNIVERSAL APPROVAL FRAME.
//
// MOTIR-4792's suite pins the seven states that card drew; this one pins the
// two it left, and every assertion here is about a claim rather than a pixel:
//
//   · `E` SHOWS WHAT WAS APPROVED. The version identifier comes off the audit
//     column, and the port shows the PINNED row — a decided gate rendered over
//     whatever is current now says *somebody approved a design*, which is a
//     claim about nothing. This is the assertion that stops a later refactor
//     "simplifying" the port back to the card's current design.
//   · THE "FILES KEPT" LINE TELLS THE TRUTH IN BOTH DIRECTIONS. An
//     unconditional reassurance on the one surface built to be checkable is
//     worse than no line at all, so the NOT-kept arm is asserted as hard as the
//     kept one — and the not-asked arm renders neither.
//   · `E` CARRIES NO VERBS, asserted on their ABSENCE rather than on a disabled
//     attribute. A decided gate is immutable (ADR §6a); a greyed Approve would
//     say the control is yours and broken.
//   · `G` IS NOT A DECISION. Colourless, verb-less, nobody named, and a DEAD
//     port that does not render the subject at all. The audit must never read a
//     withdrawal as somebody's answer (ADR §6b), and before this state existed
//     a superseded gate fell through to the awaiting arm and drew LIVE VERBS.
//
// happy-dom + the repo's own matchers (there is no jest-dom here), so assertions
// read `.toBeTruthy()` / `.textContent`, never `.toBeInTheDocument()`.

const BASE: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
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
  confirmedRecord: null,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

const APPROVED: ApprovalGateDTO = {
  ...BASE,
  state: 'approved',
  decidedById: 'user-1',
  decidedAt: '2026-09-08T04:12:00.000Z',
  subjectVersion: '9840d00ea1b2c3d4',
  decidedByLabel: 'Zhu Yue',
  decidedUnderAuthority: 'assignee',
  decisionSource: 'ui',
  outcomeRef: 'done',
};

const WITHDRAWN: ApprovalGateDTO = {
  ...BASE,
  state: 'superseded',
  subjectVersion: '9840d00ea1b2c3d4',
  updatedAt: '2026-09-08T04:20:00.000Z',
};

const VERBS: GateVerb[] = [
  { decision: 'request_changes', label: 'Request changes', variant: 'secondary', confirms: false },
  { decision: 'approve', label: 'Approve', variant: 'primary', confirms: true },
];

function render(props: Partial<React.ComponentProps<typeof ApprovalGateControl>> = {}) {
  return renderWithIntl(
    <ApprovalGateControl
      gate={BASE}
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

describe('state E — approved', () => {
  it('renders WHO decided, WHEN, and the VERSION the audit column carries', () => {
    const { container } = render({ gate: APPROVED, filesKept: true });

    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Zhu Yue')).toBeTruthy();
    // The version is the audit column's, abbreviated for the strip — never the
    // subject id, and never re-derived from a current design result.
    expect(container.textContent).toContain('version 9840d00e');
    expect(container.textContent).not.toContain('9840d00ea1b2c3d4');
  });

  it('keeps the PORT — the version that was approved is still on screen', () => {
    // ⚠️ The frame renders whatever port it is HANDED; which bytes those are is
    // the caller's read (`DesignResultSection` feeds it the gate's own subject
    // for a decided gate). What this asserts is that the frame does not drop
    // the port when the question is over — the failure the design calls "a row
    // of metadata about something nobody can look at any more".
    render({ gate: APPROVED, filesKept: true });
    expect(screen.getByTestId('the-port')).toBeTruthy();
  });

  it('says the files are KEPT when the pin holds', () => {
    const { container } = render({ gate: APPROVED, filesKept: true });
    expect(container.textContent).toContain('Files kept');
    expect(container.textContent).not.toContain('Files not kept');
  });

  it('says the files are NOT kept when they are not — the honest opposite case', () => {
    // The arm that matters. `filesKept` is `design_evidence.pinned_at` off the
    // row, not `state === 'approved'` off the gate, so an approval whose pin
    // never landed says so instead of reassuring the reader.
    const { container } = render({ gate: APPROVED, filesKept: false });
    expect(container.textContent).toContain('Files not kept');
  });

  it('renders NEITHER line when the kind was not asked', () => {
    const { container } = render({ gate: APPROVED, filesKept: null });
    expect(container.textContent).not.toContain('Files kept');
    expect(container.textContent).not.toContain('Files not kept');
  });

  it('draws no retention line on a REJECTION — only an approval pins', () => {
    const { container } = render({
      gate: { ...APPROVED, state: 'changes_requested', outcomeRef: null },
      filesKept: true,
    });
    expect(container.textContent).not.toContain('Files kept');
  });

  it('carries NO VERBS — absent, not disabled', () => {
    render({ gate: APPROVED, filesKept: true });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
    // Not merely unpressable — not there at all.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('a DECLINED plan gate (Story MOTIR-6012 · MOTIR-6032)', () => {
  // A person ended the plan a `plan_approval` gate asked about — terminal, and a
  // decision, so it takes the decided treatment: who, when, the state, and no verbs.
  const DECLINED: ApprovalGateDTO = {
    ...APPROVED,
    kind: 'plan_approval',
    workItemId: null,
    subjectId: 'plan-1',
    state: 'declined',
    outcomeRef: null,
  };

  it('names the state Declined, and who decided it', () => {
    render({ gate: DECLINED });
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText('Zhu Yue')).toBeTruthy();
    expect(screen.queryByText('Changes requested')).toBeNull();
  });

  it('carries NO VERBS — a declined plan is not asked again', () => {
    render({ gate: DECLINED });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('state G — superseded', () => {
  it('says the question was withdrawn', () => {
    const { container } = render({ gate: WITHDRAWN });
    expect(screen.getByText('Withdrawn')).toBeTruthy();
    expect(container.textContent).toContain('This question was withdrawn');
  });

  it('names its REAL cause, one true sentence per value (MOTIR-5667)', () => {
    // ⚠️ THE OTHER SIDE OF MOTIR-5586, and the reason that bug could only make
    // the sentence VAGUER: the row recorded `state` and nothing else, so the
    // frame could not tell six writers apart and *a newer design was published*
    // was true of one of them. MOTIR-5659 gave the row its cause; this renders it.
    const sentences: Array<[ApprovalGateDTO['supersededCause'], string]> = [
      ['republished', 'A newer design was published, so this question was withdrawn.'],
      ['withdrawn', 'The design result was withdrawn, so this question went with it.'],
      ['head_moved', 'A push moved the commits, so this question was withdrawn.'],
      ['member_closed', 'A pull request closed, so this question was withdrawn.'],
      ['member_drafted', 'A pull request went back to draft, so this question was withdrawn.'],
      [
        'conflict',
        'A pull request conflicts with its base branch, so this question was withdrawn.',
      ],
      ['set_changed', 'The pull requests changed, so this question was withdrawn.'],
      ['pulled_back', 'The work was pulled back out of review, so this question was withdrawn.'],
    ];
    for (const [cause, sentence] of sentences) {
      cleanup();
      const { container } = render({ gate: { ...WITHDRAWN, supersededCause: cause } });
      expect(`${cause}: ${container.textContent?.includes(sentence)}`).toBe(`${cause}: true`);
    }
  });

  it('a row that PREDATES the column says the reason was not recorded — and names no cause', () => {
    // ⚠️ `unknown` IS NOT A FALLBACK TO THE REPUBLISH SENTENCE. Reconstructing a
    // cause from a row's shape manufactures evidence, and this sentence is shown
    // to a person as fact. A null cause reads the same way, for the same reason.
    for (const cause of ['unknown', null] as const) {
      cleanup();
      const { container } = render({ gate: { ...WITHDRAWN, supersededCause: cause } });
      expect(container.textContent).toContain(
        'This question was withdrawn. The reason was not recorded.',
      );
      expect(container.textContent).not.toContain('A newer design was published');
      expect(container.textContent).not.toContain('A push moved the commits');
    }
  });

  it('claims NO cause and NO current version — four writers supersede, one publishes (Bug MOTIR-5586)', () => {
    // ⚠️ THE ASSERTION IS ON WHAT THE COPY DOES **NOT** SAY, and that is the
    // whole of this bug. `superseded` is written by FOUR product paths and only
    // one of them publishes anything: a republish (MOTIR-4913), a WITHDRAWAL
    // (MOTIR-5574), a hand pull-back out of review or to Cancelled
    // (MOTIR-5527), and linking an OPEN pull request (MOTIR-5534). The row
    // records `state` and nothing else (ADR `approval-gates.md` §6b), so the
    // frame cannot tell them apart — which makes a sentence that NAMES a cause
    // false three times out of four, and the pointer "the current version is
    // above" false over a dead port with nothing above it.
    //
    // This gate is the withdrawal case: no current evidence, nothing newer.
    const { container } = render({ gate: WITHDRAWN });
    expect(container.textContent).not.toContain('A newer design was published');
    expect(container.textContent).not.toContain('The current version is above');
    // What survives is the fact every writer leaves true.
    expect(container.textContent).toContain('This question was withdrawn');
    expect(container.textContent).toContain('Nobody decided it');
  });

  it('renders a DEAD port — the subject is NOT shown', () => {
    // The whole of `G`: the bytes it asks about are not current and were never
    // approved, so they are not pinned and are reclaimed. Showing them would
    // contradict the state's only message.
    render({ gate: WITHDRAWN });
    expect(screen.queryByTestId('the-port')).toBeNull();
  });

  it('carries NO VERBS — absent, not disabled', () => {
    render({ gate: WITHDRAWN });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('reads as a decision NOBODY made — no actor, and no decision time', () => {
    const { container } = render({
      // Even handed an actor label it must not name one: a `superseded` row
      // carries none by construction, and printing the decided-state fallback
      // ("No longer attributable") would say somebody decided and we lost who.
      gate: { ...WITHDRAWN, decidedByLabel: 'Zhu Yue', decidedById: 'user-1' },
    });
    expect(container.textContent).not.toContain('Zhu Yue');
    expect(container.textContent).not.toContain('No longer attributable');
    expect(container.textContent).toContain('No decision');
    expect(container.textContent).toContain('no one to attribute');
    // The only time shown is when the question was WITHDRAWN, said in those
    // words — `decidedAt` is null here and nothing pretends otherwise.
    expect(container.textContent).toContain('withdrawn');
  });

  it('is COLOURLESS — the withdrawn chip is not one of the decided severities', () => {
    const { container } = render({ gate: WITHDRAWN });
    const html = container.innerHTML;
    expect(html).toContain('--el-archived-pill-bg');
    expect(html).not.toContain('--el-tint-mint');
    expect(html).not.toContain('--el-tint-peach');
    expect(html).not.toContain('--el-tint-yellow');
  });
});
