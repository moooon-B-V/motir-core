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

const MEMBERS: PullRequestApprovalMemberDTO[] = [
  { subjectVersion: CORE_V, pullRequestId: CORE_PR.id, queued: true, retryable: false },
  { subjectVersion: GATEWAY_V, pullRequestId: GATEWAY_PR.id, queued: false, retryable: true },
];

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
        mergeGate={{ gate: APPROVED, canDecide: false, routedToLabel: null, members: MEMBERS }}
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
});
