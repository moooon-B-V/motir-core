// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO, DesignGateSubjectDTO } from '@/lib/dto/designEvidence';

// THE ITEM PAGE HANDS THE DECISION OVER (Story MOTIR-5215 · Subtask MOTIR-5229) —
// `design/work-items/design-notes.md` § *The item page HANDS THE DECISION OVER*.
//
// An awaiting gate the reader may decide renders the CALL-TO-ACTION BAND: the
// version, how long it has waited, the state, and ONE control that opens the
// approval overlay over this page. Nothing on the page can submit a decision, the
// section holds no copy of its gate, and every other state keeps its record.

const { shallowPush, searchParams } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  searchParams: { current: new URLSearchParams('tab=activity') },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/MOTIR-4321',
  useSearchParams: () => searchParams.current,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush }));

import { DesignResultSection } from '@/app/(authed)/items/[key]/_components/DesignResultSection';
import { DesignResultPanel } from '@/app/(authed)/items/[key]/_components/DesignResultPanel';

afterEach(() => {
  cleanup();
  shallowPush.mockReset();
});

const NOW = new Date('2026-09-10T04:00:00.000Z');

function awaiting(id: string): ApprovalGateDTO {
  return {
    id,
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
}

function decided(gate: ApprovalGateDTO, state: ApprovalGateDTO['state']): ApprovalGateDTO {
  return {
    ...gate,
    state,
    decidedById: 'user-2',
    decidedAt: '2026-09-08T05:00:00.000Z',
    decidedByLabel: 'Ada Lovelace',
    decidedUnderAuthority: 'assignee',
    decisionSource: 'ui',
    outcomeRef: state === 'approved' ? 'done' : null,
  };
}

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

interface Props {
  gate: ApprovalGateDTO | null;
  canDecide?: boolean;
  subject?: DesignGateSubjectDTO | null;
  routedToLabel?: string | null;
  routedToViewer?: boolean;
}

function ui({
  gate,
  canDecide = true,
  subject = null,
  routedToLabel = 'Ada Lovelace',
  routedToViewer = true,
}: Props) {
  return (
    <DesignResultSection
      evidence={PUBLISHED}
      isDesignCard
      gate={gate}
      canDecide={canDecide}
      subject={subject}
      itemIdentifier="MOTIR-4321"
      routedToLabel={routedToLabel}
      routedToViewer={routedToViewer}
    />
  );
}

const renderSection = (props: Props, locale: 'en' | 'zh' = 'en') =>
  renderWithIntl(ui(props), {
    locale,
    messages: locale === 'zh' ? zh : en,
    now: NOW,
  });

const REVIEW = en.approvalGate.statusHeld.reviewAndApprove;

describe('the call-to-action band (MOTIR-5229)', () => {
  it('names the version, how long it has waited and the state — and offers exactly ONE control', () => {
    const { container } = renderSection({ gate: awaiting('band-anatomy') });

    expect(container.textContent).toContain('version 9840d00e · asked 2 days ago');
    expect(screen.getByText(en.approvalGate.state.awaitingYou, { exact: true })).toBeTruthy();
    expect(screen.getByText(en.approvalGate.cta.body)).toBeTruthy();

    const controls = [...screen.queryAllByRole('link'), ...screen.queryAllByRole('button')];
    expect(controls).toHaveLength(1);
    expect(controls[0]!.textContent).toBe(REVIEW);
    // The band mounts no port — the design is reviewed full screen.
    expect(screen.queryByRole('group', { name: en.approvalGate.port.label })).toBeNull();
    // One container, one label: the section card's title is the only one.
    expect(screen.queryByText(en.approvalGate.designResult.kindLabel, { exact: true })).toBeNull();
  });

  it('submits nothing: no approve and no request-changes control', () => {
    renderSection({ gate: awaiting('band-no-verbs') });
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.requestChanges })).toBeNull();
  });

  it('routed to somebody else, the sentence names them — and the door is the same', () => {
    const { container } = renderSection({
      gate: awaiting('band-elsewhere'),
      routedToViewer: false,
    });
    expect(container.textContent).toContain(
      'Waiting on Ada Lovelace — you can decide it too. Review it full screen first.',
    );
    expect(screen.getByRole('link', { name: REVIEW })).toBeTruthy();
  });

  it('routed elsewhere to NOBODY resolvable, the plain sentence renders — a name-less one says nothing', () => {
    renderSection({ gate: awaiting('band-nobody'), routedToViewer: false, routedToLabel: null });
    expect(screen.getByText(en.approvalGate.cta.body)).toBeTruthy();
  });

  it('the control is a real link to this page with the overlay’s address added, keeping the host query', () => {
    renderSection({ gate: awaiting('band-href') });
    const expected = withApprovalOverlay('/items/MOTIR-4321?tab=activity', {
      itemKey: 'MOTIR-4321',
      kind: 'design_result',
    });
    const link = screen.getByRole('link', { name: REVIEW });
    expect(link.getAttribute('href')).toBe(expected);
    expect(expected).toContain('tab=activity');
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('a plain click opens the overlay with shallowPush; a modifier click keeps the native link', () => {
    renderSection({ gate: awaiting('band-click') });
    const link = screen.getByRole('link', { name: REVIEW });

    fireEvent.click(link, { button: 0, metaKey: true });
    expect(shallowPush).not.toHaveBeenCalled();

    fireEvent.click(link, { button: 0 });
    expect(shallowPush).toHaveBeenCalledWith(link.getAttribute('href'));
  });

  it('speaks zh', () => {
    const { container } = renderSection({ gate: awaiting('band-zh') }, 'zh');
    expect(screen.getByRole('link', { name: '审阅并批准' })).toBeTruthy();
    expect(container.textContent).toContain('版本 9840d00e');
    expect(container.textContent).toContain('发起');
    expect(screen.getByText('等待你处理', { exact: true })).toBeTruthy();
  });
});

describe('the section holds no copy of its gate (MOTIR-5229)', () => {
  it('follows a CHANGED gate prop — the assertion `useState(gate)` failed', () => {
    const gate = awaiting('band-prop');
    const { rerender } = renderSection({ gate });
    expect(screen.getByRole('link', { name: REVIEW })).toBeTruthy();

    rerender(ui({ gate: decided(gate, 'approved') }));

    expect(screen.getByText(en.approvalGate.state.approved, { exact: true })).toBeTruthy();
    expect(screen.queryByRole('link', { name: REVIEW })).toBeNull();
  });

  it('draws a decision announced by the overlay while the prop still reads awaiting — then the prop wins', () => {
    const gate = awaiting('band-announced');
    const { rerender } = renderSection({ gate });

    act(() => announceGateDecided({ gate: decided(gate, 'approved'), filesKept: true }));

    expect(screen.getByText(en.approvalGate.state.approved, { exact: true })).toBeTruthy();
    expect(screen.getByText(en.approvalGate.record.filesKept)).toBeTruthy();
    expect(screen.queryByRole('link', { name: REVIEW })).toBeNull();

    rerender(
      ui({ gate: decided(gate, 'approved'), subject: { evidence: PUBLISHED, filesKept: false } }),
    );
    expect(screen.getByText(en.approvalGate.record.filesNotKept)).toBeTruthy();
  });

  it('ignores a decision announced for ANOTHER gate', () => {
    act(() =>
      announceGateDecided({ gate: decided(awaiting('band-other'), 'approved'), filesKept: true }),
    );
    renderSection({ gate: awaiting('band-mine') });
    expect(screen.getByRole('link', { name: REVIEW })).toBeTruthy();
  });

  it('imports neither the decide action nor the optimistic status writer, and holds no state', () => {
    const code = fs
      .readFileSync(
        path.join(process.cwd(), 'app/(authed)/items/[key]/_components/DesignResultSection.tsx'),
        'utf8',
      )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '');
    expect(code).not.toContain('decideApprovalGateAction');
    expect(code).not.toContain('useOptimisticStatusWriter');
    expect(code).not.toContain('useState');
  });
});

describe('the states the page KEEPS render in place, with no verbs (MOTIR-5229)', () => {
  it('B — may see but not decide: the port, who it waits on, no control', () => {
    renderSection({ gate: awaiting('keep-b'), canDecide: false, routedToViewer: false });
    expect(screen.getByRole('group', { name: en.approvalGate.port.label })).toBeTruthy();
    expect(screen.getByText('Waiting on Ada Lovelace.', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('link', { name: REVIEW })).toBeNull();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
  });

  it('E — approved: the record with the pinned version and Files kept', () => {
    renderSection({
      gate: decided(awaiting('keep-e'), 'approved'),
      subject: { evidence: PUBLISHED, filesKept: true },
    });
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText(en.approvalGate.record.filesKept)).toBeTruthy();
    expect(screen.queryAllByRole('link', { name: REVIEW })).toHaveLength(0);
  });

  it('F — changes requested: the record says the agent will republish', () => {
    renderSection({ gate: decided(awaiting('keep-f'), 'changes_requested') });
    expect(screen.getByText(en.approvalGate.record.willRepublish)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('G — withdrawn: the dead port and no verb, even for a reader who could have decided', () => {
    renderSection({ gate: { ...awaiting('keep-g'), state: 'superseded' } });
    expect(screen.getByText(en.approvalGate.withdrawn.port)).toBeTruthy();
    expect(screen.queryByRole('link', { name: REVIEW })).toBeNull();
  });

  it('no gate — renders exactly what the panel renders on its own', () => {
    const section = renderSection({ gate: null }).container.innerHTML;
    cleanup();
    const panel = renderWithIntl(<DesignResultPanel evidence={PUBLISHED} isDesignCard />, {
      now: NOW,
    }).container.innerHTML;
    expect(section).toBe(panel);
  });
});
