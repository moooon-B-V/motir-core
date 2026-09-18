// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import {
  CORE_PR,
  GATEWAY_PR,
  coreRepo,
  gatewayRepo,
  recordDto,
} from '../helpers/howToTestFixtures';

// THE LATE STACK GAINS NO HOW TO TEST SECTION (Story MOTIR-4906 · Subtask
// MOTIR-5336, design/github §20). How to test renders INSIDE the Development
// section card, below the rows — "never a section card or section header of its
// own". This renders the item page's real `LateUpperSections` over a fixture
// read, so a second `ContentSectionCard` for it anywhere in the stack fails here.

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
}));
vi.mock('@/app/(authed)/items/[key]/_components/lateReads', () => ({ RUN_HISTORY_PAGE: 20 }));
vi.mock('@/app/(authed)/items/[key]/_components/runTimes', () => ({ formatRunTimes: () => ({}) }));
vi.mock('@/app/(authed)/items/[key]/_components/RunSection', () => ({ RunSection: () => null }));
vi.mock('@/app/(authed)/items/[key]/_components/AcceptancePanel', () => ({
  AcceptancePanel: () => null,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DesignResultSection', () => ({
  // A marker, so a test can see whether the STANDALONE section rendered.
  DesignResultSection: () => <div data-testid="standalone-design-result" />,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DecidedGateStatusBridge', () => ({
  // A marker, so a test can see whether the page listens for an overlay decision.
  DecidedGateStatusBridge: ({ gateId }: { gateId: string }) => (
    <div data-testid="decided-gate-status-bridge" data-gate-id={gateId} />
  ),
}));
vi.mock('@/app/(authed)/items/[key]/_components/DevelopmentLinkControl', () => ({
  DevelopmentLinkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LinkPullRequestDoor: () => null,
  LinkPullRequestForm: () => null,
  RemovePullRequestLinkButton: () => null,
}));

import { LateUpperSections } from '@/app/(authed)/items/[key]/_components/LateSections';
import type { LateReads } from '@/app/(authed)/items/[key]/_components/lateReads';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

afterEach(cleanup);

const htt = messages.github.development.howToTest;

function reads(): LateReads {
  return {
    pullRequests: [CORE_PR, GATEWAY_PR],
    commentCaps: {} as LateReads['commentCaps'],
    attachmentCaps: {} as LateReads['attachmentCaps'],
    initialComments: null,
    initialHistory: null,
    initialAll: null,
    initialAttachments: null,
    acceptanceEligibility: null,
    acceptanceEvidence: null,
    canDecideAcceptance: false,
    projectId: 'proj-acme',
    designEvidence: null,
    isDesignCard: false,
    designGate: {
      gate: null,
      canDecide: false,
      routedToLabel: null,
      settingsDoor: null,
      stamp: null,
      subject: null,
    },
    runs: [],
    // No scoped run on this fixture's item (MOTIR-5363) — the Run section is
    // mocked here, and `null` is what the read answers for such an item.
    scopeRun: null,
    howToTest: recordDto({ repos: [coreRepo(), gatewayRepo()] }),
    mergeGate: {
      gate: null,
      canDecide: false,
      routedToLabel: null,
      settingsDoor: null,
      stamp: null,
      members: [],
      autoQueueExits: [],
    },
    // No repair to show — also what a FAILED repair read answers (MOTIR-5466).
    repair: null,
  };
}

describe('the late stack — How to test is part of the Development card (MOTIR-5336)', () => {
  it('renders the rows and How to test inside ONE section card, and no How to test section', async () => {
    const ui = await LateUpperSections({
      reads: Promise.resolve(reads()),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    });
    const { container } = render(ui);

    // Section titles in the stack are `h2`s; How to test is never one of them.
    const sectionTitles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(sectionTitles).toContain(messages.github.development.title);
    expect(sectionTitles).not.toContain(htt.title);

    const cards = [...container.querySelectorAll('[data-surface="card"]')];
    const development = cards.filter((card) =>
      within(card as HTMLElement).queryByRole('heading', {
        level: 2,
        name: messages.github.development.title,
      }),
    );
    expect(development).toHaveLength(1);
    const card = development[0] as HTMLElement;
    expect(within(card).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(card).getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(within(card).getByRole('heading', { level: 4, name: htt.title })).toBeTruthy();

    // Exactly one How to test on the whole stack, and it is that card's.
    const parts = screen.getAllByRole('group', { name: htt.title });
    expect(parts).toHaveLength(1);
    expect(card.contains(parts[0]!)).toBe(true);
    // The gloss is the replaced one.
    expect(card.textContent).toContain(messages.github.development.gloss);
    expect(messages.github.development.gloss).toBe(
      'Pull requests and how to test them · live PR and CI status',
    );
  });
});

// ── The FIX PART (Story MOTIR-5460 · MOTIR-5466, design/github § 21) ─────────
describe('the late stack — the fix part sits inside the Development card', () => {
  const fix = messages.github.development.fix;
  const render_ = async (repair: LateReads['repair']) =>
    render(
      await LateUpperSections({
        reads: Promise.resolve({ ...reads(), repair }),
        itemId: 'wi-acme-12',
        itemIdentifier: 'ACME-12',
        currentUserId: 'u-viewer',
        canEdit: true,
        repoDelivery: [],
        deliveries: [],
      }),
    );

  it('draws the part below the rows and above How to test, in the same card', async () => {
    await render_({
      state: 'offer',
      failing: [{ repo: CORE_PR.repo, number: CORE_PR.number }],
      lastGaveUp: null,
    });

    const part = screen.getByRole('group', { name: fix.aria.part });
    const howToTest = screen.getByRole('group', { name: htt.title });
    expect(part.compareDocumentPosition(howToTest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = screen.getByText(CORE_PR.title);
    expect(row.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(part).getByText('motir fix ACME-12')).toBeTruthy();
  });

  it('a failed repair read (null) renders the block WITHOUT the part — never an error', async () => {
    const { container } = await render_(null);

    expect(screen.queryByRole('group', { name: fix.aria.part })).toBeNull();
    expect(container.textContent).toContain(CORE_PR.title);
    expect(screen.getByRole('group', { name: htt.title })).toBeTruthy();
  });
});

// ── Q8 (Story MOTIR-5488 · MOTIR-5498) ───────────────────────────────────────
// A design card whose open linked pull requests carry the decision renders its
// result INSIDE the Development card and no standalone Design result section;
// the same card with no open pull request gets the section back.
describe('the late stack — a design result with open linked pull requests (Q8)', () => {
  const EVIDENCE: DesignEvidenceDTO = {
    id: 'ev-1',
    workItemId: 'wi-acme-12',
    noteMd: null,
    noteTruncated: false,
    assets: [
      {
        id: 'a-mock',
        kind: 'mock',
        url: '/api/attachments/att-mock/content',
        mimeType: 'text/html',
        sizeBytes: 10,
        sourcePath: 'design/work-items/x--change.mock.html',
        position: 0,
      },
      {
        id: 'a-note',
        kind: 'note_file',
        url: '/api/attachments/att-note/content',
        mimeType: 'text/markdown',
        sizeBytes: 10,
        sourcePath: 'design/work-items/design-notes.md',
        position: 1,
      },
    ],
    commitSha: 'cafe1234567',
    ciRunUrl: null,
    producedByKey: 'ACME-12',
    createdAt: '2026-09-14T00:00:00.000Z',
    withdrawnAt: null,
    withdrawnById: null,
    withdrawnReason: null,
  };

  async function renderStack(pullRequests: LateReads['pullRequests']) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 })),
    );
    const base = reads();
    const ui = await LateUpperSections({
      reads: Promise.resolve({
        ...base,
        pullRequests,
        designEvidence: EVIDENCE,
        isDesignCard: true,
        // ⚠️ THE CARD HOLDS ITS DESIGN GATE (MOTIR-5667, reversing AMENDMENT 4 Q8).
        // These fixtures carried NO design gate because a card with an open pull
        // request raised none — which is MOTIR-5652, and the state the product no
        // longer produces. The placement is derived from the gate now, so a fixture
        // without one is describing a card that cannot exist.
        designGate: {
          ...base.designGate,
          gate: {
            id: 'gate-design-1',
            workItemId: 'wi-acme-12',
            kind: 'design_result' as const,
            subjectId: EVIDENCE.id,
            state: 'awaiting' as const,
            decidedById: null,
            decidedAt: null,
            noteMd: null,
            supersededCause: null,
            subjectVersion: EVIDENCE.commitSha,
            decidedByLabel: null,
            routedToId: 'u-viewer',
            decidedUnderAuthority: null,
            decisionSource: null,
            outcomeRef: null,
            createdAt: '2026-09-14T00:00:00.000Z',
            updatedAt: '2026-09-14T00:00:00.000Z',
          },
        },
      }),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    });
    return render(ui);
  }

  afterEach(() => vi.unstubAllGlobals());

  it('two open pull requests in two repositories: ONE Development card holds the design once, no standalone section', async () => {
    const { container } = await renderStack([CORE_PR, GATEWAY_PR]);
    expect(screen.queryByTestId('standalone-design-result')).toBeNull();

    const slots = screen.getAllByRole('group', { name: messages.designResult.title });
    expect(slots).toHaveLength(1);
    const card = slots[0]!.closest('[data-surface="card"]') as HTMLElement;
    expect(
      within(card).getByRole('heading', { level: 2, name: messages.github.development.title }),
    ).toBeTruthy();
    expect(within(card).getByRole('link', { name: /Open note/ })).toBeTruthy();
    expect(within(card).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(card).getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(card.textContent).toContain(messages.github.development.glossWithDesign);
    expect(container.querySelectorAll('[data-testid="development-design-result"]')).toHaveLength(1);
  });

  it('every pull request merged or closed: the standalone section is back, no slot', async () => {
    await renderStack([
      { ...CORE_PR, state: 'merged' },
      { ...GATEWAY_PR, state: 'closed' },
    ]);
    expect(screen.getByTestId('standalone-design-result')).toBeTruthy();
    expect(screen.queryByTestId('development-design-result')).toBeNull();
    expect(document.body.textContent).toContain(messages.github.development.gloss);
  });
});

// ── MOTIR-5570 ────────────────────────────────────────────────────────────────
// The approval overlay decides outside this page's optimistic status provider, so
// the page mounts a listener beside the Design result section whenever it has a
// `design_result` gate to hear about — and none when it has no gate.
describe('the late stack — the page listens for a decision made in the overlay (MOTIR-5570)', () => {
  function designCard(gate: ApprovalGateDTO | null): LateReads {
    const base = reads();
    return {
      ...base,
      pullRequests: [],
      isDesignCard: true,
      designGate: { ...base.designGate, gate },
    };
  }

  async function renderStack(r: LateReads) {
    const ui = await LateUpperSections({
      reads: Promise.resolve(r),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    });
    return render(ui);
  }

  it('mounts the listener for the card’s design gate, beside the section', async () => {
    await renderStack(designCard({ id: 'gate-42', state: 'awaiting' } as ApprovalGateDTO));
    const bridge = screen.getByTestId('decided-gate-status-bridge');
    expect(bridge.getAttribute('data-gate-id')).toBe('gate-42');
    expect(screen.getByTestId('standalone-design-result')).toBeTruthy();
  });

  it('mounts no listener on a design card with no gate', async () => {
    await renderStack(designCard(null));
    expect(screen.getByTestId('standalone-design-result')).toBeTruthy();
    expect(screen.queryByTestId('decided-gate-status-bridge')).toBeNull();
  });
});
