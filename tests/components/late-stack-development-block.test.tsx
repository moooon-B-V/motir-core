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
vi.mock('@/app/(authed)/items/[key]/_components/DevelopmentLinkControl', () => ({
  DevelopmentLinkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LinkPullRequestDoor: () => null,
  LinkPullRequestForm: () => null,
  RemovePullRequestLinkButton: () => null,
}));

import { LateUpperSections } from '@/app/(authed)/items/[key]/_components/LateSections';
import type { LateReads } from '@/app/(authed)/items/[key]/_components/lateReads';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';

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
    designGate: { gate: null, canDecide: false, routedToLabel: null, subject: null },
    runs: [],
    // No scoped run on this fixture's item (MOTIR-5363) — the Run section is
    // mocked here, and `null` is what the read answers for such an item.
    scopeRun: null,
    howToTest: recordDto({ repos: [coreRepo(), gatewayRepo()] }),
    mergeGate: { gate: null, canDecide: false, routedToLabel: null },
  };
}

describe('the late stack — How to test is part of the Development card (MOTIR-5336)', () => {
  it('renders the rows and How to test inside ONE section card, and no How to test section', async () => {
    const ui = await LateUpperSections({
      reads: Promise.resolve(reads()),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
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
    const ui = await LateUpperSections({
      reads: Promise.resolve({
        ...reads(),
        pullRequests,
        designEvidence: EVIDENCE,
        isDesignCard: true,
      }),
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
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
