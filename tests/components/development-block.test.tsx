// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';
import messages from '@/messages/en.json';

// THE DEVELOPMENT BLOCK IS THE ONE APPROVE-TO-MERGE GATE (Story MOTIR-4906 ·
// Subtask MOTIR-5336, design/github §20 · Panels 12a–12c). The rows and How to
// test are one block; when a `pull_request_approval` gate awaits, that block is
// the PORT of ONE `ApprovalGateControl` — composed exactly as Design result
// composes its gate. NO GATE ⇒ NO FRAME.
//
// The gate kind is unregistered until MOTIR-4909, so no live tenant reaches the
// frame arm; these fixtures are the only proof it is built.

// The frame reads the router for its post-decision refresh (MOTIR-5484); nothing here presses.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);

const htt = messages.github.development.howToTest;
const PORT_LABEL = messages.approvalGate.port.label;

const TWO_REPO_STORY = recordDto();

function renderBlock(mergeGate: { gate: ApprovalGateDTO; canDecide: boolean } | null) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      manualLinkable
      howToTest={TWO_REPO_STORY}
      mergeGate={
        mergeGate ? { stamp: 'v1.stamp-on-screen', ...mergeGate, routedToLabel: 'Mara S.' } : null
      }
    />,
  );
}

describe('no gate ⇒ no frame (Panels 12a / 12b)', () => {
  it('renders the rows, then How to test, and no approval frame', () => {
    const { container } = renderBlock(null);
    expect(screen.queryByRole('group', { name: PORT_LABEL })).toBeNull();
    expect(screen.queryByText(messages.approvalGate.state.awaitingYou)).toBeNull();

    const rows = screen.getAllByRole('listitem');
    const part = screen.getByRole('group', { name: htt.title });
    // Order: every row precedes the How to test part.
    for (const row of rows.slice(0, 2)) {
      expect(row.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(container.textContent).toContain(CORE_PR.title);
    expect(container.textContent).toContain(GATEWAY_PR.title);
  });

  it('a DECIDED gate KEEPS its frame — what the merges did is drawn after the decision (MOTIR-5484)', () => {
    renderBlock({
      gate: { ...AWAITING_MERGE_GATE, state: 'approved', decidedAt: '2026-09-13T15:00:00.000Z' },
      canDecide: true,
    });
    const port = screen.getByRole('group', { name: PORT_LABEL });
    expect(within(port).getByRole('group', { name: htt.title })).toBeTruthy();
    expect(screen.getByText(messages.approvalGate.state.approved)).toBeTruthy();
  });

  it("re-inks the rows' caption to --el-text-secondary (AA on the port's surface)", () => {
    renderBlock(null);
    const caption = screen.getByText(/Link pull request here/).closest('p')!;
    expect(caption.className).toContain('text-(--el-text-secondary)');
    expect(caption.className).not.toContain('--el-text-muted');
  });
});

describe('an awaiting approve-and-merge gate on a two-repository story (Panel 12c)', () => {
  it('renders exactly ONE frame whose port holds BOTH rows and How to test', () => {
    renderBlock({ gate: AWAITING_MERGE_GATE, canDecide: true });
    const ports = screen.getAllByRole('group', { name: PORT_LABEL });
    expect(ports).toHaveLength(1);
    const port = ports[0]!;
    expect(within(port).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(port).getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(within(port).getByRole('group', { name: htt.title })).toBeTruthy();
    // ONE state pill — one frame, never one per row.
    expect(screen.getAllByText(messages.approvalGate.state.awaitingYou)).toHaveLength(1);
  });

  it('renders NO verb — none inside How to test, and none in a frame handed no actions', () => {
    renderBlock({ gate: AWAITING_MERGE_GATE, canDecide: true });
    const part = screen.getByRole('group', { name: htt.title });
    const verbish = /approve|merge|request changes/i;
    expect(within(part).queryByRole('button', { name: verbish })).toBeNull();
    expect(screen.queryByRole('button', { name: verbish })).toBeNull();
  });

  it('a reader who may not decide sees the same port and who it waits on', () => {
    renderBlock({ gate: AWAITING_MERGE_GATE, canDecide: false });
    expect(screen.getAllByRole('group', { name: PORT_LABEL })).toHaveLength(1);
    expect(document.body.textContent).toContain('Mara S.');
  });
});

describe('the diff is a link OUT, from each row only', () => {
  it.each([
    ['without a gate', null],
    ['inside the frame', { gate: AWAITING_MERGE_GATE, canDecide: true }],
  ] as const)('%s: a pull-request URL appears only as its own row link-out', (_name, gate) => {
    const { container } = renderBlock(gate);
    for (const pr of [CORE_PR, GATEWAY_PR]) {
      const anchors = [...container.querySelectorAll(`a[href="${pr.url}"]`)];
      expect(anchors).toHaveLength(1);
      expect(anchors[0]!.getAttribute('aria-label')).toBe(messages.github.development.openOnGithub);
      expect(anchors[0]!.closest('li')).not.toBeNull();
    }
    const part = screen.getByRole('group', { name: htt.title });
    for (const a of part.querySelectorAll('a')) {
      expect(a.getAttribute('href')).not.toMatch(/github\.com/);
    }
  });
});

describe('the NARROW row — pills wrap under the title below a 30rem column (MOTIR-5351, Panel 12n)', () => {
  it('the rows sit in a size container, and each row wraps its pill group to its own indented line at @max-[30rem]', () => {
    const { container } = renderBlock(null);
    const row = container.querySelector(`a[href="${CORE_PR.url}"]`)!.closest('li')!;
    // The query is against the rows' LIST, not the viewport: the peek and a narrow
    // late-stack column are narrow on a wide screen.
    expect(row.closest('ul')!.className.split(' ')).toContain('@container');
    const rowClasses = row.className.split(' ');
    expect(rowClasses).toContain('@max-[30rem]:flex-wrap');
    // The title block keeps the first line: it still grows and truncates.
    const title = within(row).getByText(CORE_PR.title);
    expect(title.parentElement!.className).toContain('min-w-0 flex-1');
    // The pill group is the element carrying the state pill.
    const pills = within(row)
      .getByText(messages.github.development.prState.open)
      .closest('span.flex')!;
    for (const cls of [
      '@max-[30rem]:order-last',
      '@max-[30rem]:basis-full',
      '@max-[30rem]:flex-wrap',
      '@max-[30rem]:pl-[27px]',
    ]) {
      expect(pills.className.split(' '), cls).toContain(cls);
    }
    // The link-out stays on line 1, after the title.
    const linkOut = row.querySelector(`a[href="${CORE_PR.url}"]`)!;
    expect(linkOut.className.split(' ')).toContain('@max-[30rem]:order-2');
  });

  it('at desktop width nothing wraps: the only row classes that change layout are behind the container variant', () => {
    const { container } = renderBlock(null);
    const row = container.querySelector(`a[href="${CORE_PR.url}"]`)!.closest('li')!;
    const unconditional = row.className.split(' ').filter((c) => !c.startsWith('@'));
    expect(unconditional).not.toContain('flex-wrap');
    expect(unconditional).toEqual(expect.arrayContaining(['flex', 'items-center', 'gap-2.5']));
  });
});

// ── THE DESIGN RESULT'S SLOT (Story MOTIR-5488 · MOTIR-5498) ────────────────
// `design-result.md` AMENDMENT 4 Q8, design `design-result--what-to-review.mock.html`
// states 7a–7c: on a card whose open linked pull requests carry the design's
// decision, the result is the block's FIRST part — then How to test, then every
// row — rendered once however many pull requests the card links.
describe('the design result inside the Development block (Q8)', () => {
  const SLOT = <div role="group" aria-label="Design result" data-testid="slot" />;
  const PR_GROUP = messages.github.development.pullRequestsGroup;

  function renderWithDesign(mergeGate: { gate: ApprovalGateDTO; canDecide: boolean } | null) {
    return render(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={TWO_REPO_STORY}
        designResult={SLOT}
        mergeGate={
          mergeGate ? { stamp: 'v1.stamp-on-screen', ...mergeGate, routedToLabel: 'Mara S.' } : null
        }
      />,
    );
  }

  const follows = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('orders the block design → How to test → every pull-request row, the design ONCE', () => {
    renderWithDesign(null);
    const slots = screen.getAllByTestId('slot');
    expect(slots).toHaveLength(1);
    const part = screen.getByRole('group', { name: htt.title });
    const prs = screen.getByRole('group', { name: PR_GROUP });
    expect(follows(slots[0]!, part)).toBe(true);
    expect(follows(part, prs)).toBe(true);
    // Both repositories' rows sit in the pull-request group, below How to test.
    expect(within(prs).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(prs).getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(within(prs).getByText(/Link pull request here/)).toBeTruthy();
  });

  it('wraps the slot, How to test and the rows in ONE frame while the merge gate awaits', () => {
    renderWithDesign({ gate: AWAITING_MERGE_GATE, canDecide: true });
    const ports = screen.getAllByRole('group', { name: PORT_LABEL });
    expect(ports).toHaveLength(1);
    expect(within(ports[0]!).getByTestId('slot')).toBeTruthy();
    expect(within(ports[0]!).getByRole('group', { name: htt.title })).toBeTruthy();
    expect(within(ports[0]!).getByText(GATEWAY_PR.title)).toBeTruthy();
  });

  it('a block WITHOUT a design result keeps rows, then How to test, and no pull-request group', () => {
    renderBlock(null);
    expect(screen.queryByRole('group', { name: PR_GROUP })).toBeNull();
    const rows = screen.getAllByRole('listitem');
    expect(follows(rows[0]!, screen.getByRole('group', { name: htt.title }))).toBe(true);
  });
});

describe('hasOpenPullRequest — the condition the slot is shown on', () => {
  it('is true for any open row, from either list, and false when every row is merged or closed', async () => {
    const { hasOpenPullRequest } = await import('@/components/github/DevelopmentSection');
    const merged = { ...CORE_PR, state: 'merged' as const };
    const closed = { ...GATEWAY_PR, state: 'closed' as const };
    expect(hasOpenPullRequest([merged, closed], [])).toBe(false);
    expect(hasOpenPullRequest([], [])).toBe(false);
    expect(hasOpenPullRequest([merged, GATEWAY_PR], [])).toBe(true);
    expect(
      hasOpenPullRequest(
        [merged],
        [{ pullRequest: GATEWAY_PR, baseRef: 'main', defaultBranch: 'main', queueExit: null }],
      ),
    ).toBe(true);
  });
});
