// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSection, DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { ApprovalGateDTO, PullRequestApprovalMemberDTO } from '@/lib/dto/approvalGate';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR } from '../helpers/howToTestFixtures';

// THE PEEK READS THE SAME ROW OUTCOME THE ITEM PAGE DOES (Bug MOTIR-5650).
//
// A queued pull request read *Queued to merge* on the item page and *Checks passing* in the
// quick view: the row's second pill slot took its outcome only from the approval frame, and
// the peek draws no frame. The peek now takes the persisted member facts and shows the same
// pill — read-only, so *Not merged yet* carries no Retry.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
});

const pra = en.approvalGate.pullRequestApproval;
const CORE_V = `moooon/motir-core#131@3f2a91c0000000000000000000000000000000aa`;
const GATEWAY_V = `moooon/motir-gateway#57@aa11bb2000000000000000000000000000000000`;

const APPROVED: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  subjectVersion: [CORE_V, GATEWAY_V].sort().join(','),
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-15T14:22:00.000Z',
  outcomeRef: 'approved',
};

const NO_EXIT = {
  exit: null,
  exitAtApprovedHead: false,
  requeueable: false,
  refusal: null,
  retryDecidesGateId: null,
} as const;
const MEMBERS: PullRequestApprovalMemberDTO[] = [
  { subjectVersion: CORE_V, pullRequestId: CORE_PR.id, queued: true, retryable: false, ...NO_EXIT },
  {
    subjectVersion: GATEWAY_V,
    pullRequestId: GATEWAY_PR.id,
    queued: false,
    retryable: true,
    ...NO_EXIT,
  },
];

/** The gateway member the merge queue removed, at the approved head (MOTIR-5635). */
const exited = (disposition: 'failure' | 'neutral', atHead: boolean) =>
  [
    MEMBERS[0]!,
    {
      ...MEMBERS[1]!,
      retryable: false,
      exitAtApprovedHead: atHead,
      // ⚠️ NO VERB ON A SPENT APPROVAL, whatever the disposition (MOTIR-5802): the
      // re-asked gate is what the row's press decides, and this fixture is the DECIDED
      // gate's read.
      requeueable: false,
      exit: {
        rawReason: disposition === 'failure' ? 'CI_FAILURE' : 'MANUAL',
        disposition,
        headSha: 'aa11bb2000000000000000000000000000000000',
        exitedAt: '2026-09-15T15:00:00.000Z',
        requeuedAt: null,
        failingCheckName: null,
        failingCheckUrl: null,
      },
    },
  ] satisfies PullRequestApprovalMemberDTO[];

const rowOf = (title: string) => screen.getByText(title).closest('li')!;

/** The row's pills, in order — the state pill, then the second slot. */
const pillsOf = (title: string) =>
  Array.from(rowOf(title).querySelectorAll('span'))
    .filter((el) => el.children.length > 0 && el.querySelector('svg'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean);

function renderPeek(mergeMembers?: PullRequestApprovalMemberDTO[]) {
  return render(
    <DevelopmentSection
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      mergeMembers={mergeMembers}
    />,
  );
}

describe('the quick view reads the persisted merge outcome (MOTIR-5650)', () => {
  it('reads Queued to merge — not the CI pill — for a member the press queued', () => {
    renderPeek(MEMBERS);
    const core = rowOf(CORE_PR.title);
    expect(within(core).getByText(pra.outcome.queued)).toBeTruthy();
    expect(within(core).queryByText(en.github.development.ciState.passing)).toBeNull();
  });

  it('reads Not merged yet for a retryable member, and offers NO Retry — the peek is read-only', () => {
    renderPeek(MEMBERS);
    const gateway = rowOf(GATEWAY_PR.title);
    expect(within(gateway).getByText(pra.outcome.notMergedYet)).toBeTruthy();
    expect(screen.queryByRole('button', { name: pra.outcome.retry })).toBeNull();
  });

  it('with no member facts the rows are exactly as before — the CI pill', () => {
    renderPeek();
    expect(
      within(rowOf(CORE_PR.title)).getByText(en.github.development.ciState.passing),
    ).toBeTruthy();
    expect(screen.queryByText(pra.outcome.queued)).toBeNull();
  });

  it('draws the SAME pills per row as the item page does for the same facts', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        mergeGate={{
          gate: APPROVED,
          canDecide: false,
          routedToLabel: null,
          members: MEMBERS,
          stamp: null,
        }}
      />,
    );
    const detail = [pillsOf(CORE_PR.title), pillsOf(GATEWAY_PR.title)];
    cleanup();

    renderPeek(MEMBERS);
    const peek = [pillsOf(CORE_PR.title), pillsOf(GATEWAY_PR.title)];

    expect(peek).toEqual(detail);
    expect(peek[0]).toContain(pra.outcome.queued);
    expect(peek[1]).toContain(pra.outcome.notMergedYet);
  });

  it.each([
    ['failure', true, pra.outcome.leftQueue],
    ['neutral', true, pra.outcome.removedFromQueue],
    ['failure', false, pra.outcome.newCommits],
  ] as const)(
    'reads an ejected member (%s, at the approved head %s) as the item page does, with NO Queue again (MOTIR-5635)',
    (disposition, atHead, label) => {
      const members = exited(disposition, atHead);
      render(
        <DevelopmentSectionBody
          pullRequests={[CORE_PR, GATEWAY_PR]}
          itemIdentifier="ACME-12"
          mergeGate={{
            gate: APPROVED,
            canDecide: false,
            routedToLabel: null,
            members,
            stamp: null,
          }}
        />,
      );
      const detail = pillsOf(GATEWAY_PR.title);
      cleanup();

      renderPeek(members);
      expect(pillsOf(GATEWAY_PR.title)).toEqual(detail);
      expect(within(rowOf(GATEWAY_PR.title)).getByText(label)).toBeTruthy();
      expect(screen.queryByRole('button', { name: pra.outcome.queueAgain })).toBeNull();
    },
  );
});
