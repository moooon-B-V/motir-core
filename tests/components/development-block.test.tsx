// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import {
  AWAITING_MERGE_GATE,
  CORE_PR,
  GATEWAY_PR,
  coreRepo,
  gatewayRepo,
  recordDto,
} from '../helpers/howToTestFixtures';
import messages from '@/messages/en.json';

// THE DEVELOPMENT BLOCK IS THE ONE APPROVE-TO-MERGE GATE (Story MOTIR-4906 ·
// Subtask MOTIR-5336, design/github §20 · Panels 12a–12c). The rows and How to
// test are one block; when a `pull_request_approval` gate awaits, that block is
// the PORT of ONE `ApprovalGateControl` — composed exactly as Design result
// composes its gate. NO GATE ⇒ NO FRAME.
//
// The gate kind is unregistered until MOTIR-4909, so no live tenant reaches the
// frame arm; these fixtures are the only proof it is built.

afterEach(cleanup);

const htt = messages.github.development.howToTest;
const PORT_LABEL = messages.approvalGate.port.label;

const TWO_REPO_STORY = recordDto({ repos: [coreRepo(), gatewayRepo()] });

function renderBlock(mergeGate: { gate: ApprovalGateDTO; canDecide: boolean } | null) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      manualLinkable
      howToTest={TWO_REPO_STORY}
      mergeGate={mergeGate ? { ...mergeGate, routedToLabel: 'Mara S.' } : null}
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

  it('a DECIDED gate draws no frame either — only an awaiting one does', () => {
    renderBlock({
      gate: { ...AWAITING_MERGE_GATE, state: 'approved', decidedAt: '2026-09-13T15:00:00.000Z' },
      canDecide: true,
    });
    expect(screen.queryByRole('group', { name: PORT_LABEL })).toBeNull();
    expect(screen.getByRole('group', { name: htt.title })).toBeTruthy();
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

  it('renders NO verb — none inside How to test, and none in the frame until MOTIR-4909', () => {
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
