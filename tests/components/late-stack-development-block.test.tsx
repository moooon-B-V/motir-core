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
  DesignResultSection: () => null,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DevelopmentLinkControl', () => ({
  DevelopmentLinkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LinkPullRequestDoor: () => null,
  LinkPullRequestForm: () => null,
  RemovePullRequestLinkButton: () => null,
}));

import { LateUpperSections } from '@/app/(authed)/items/[key]/_components/LateSections';
import type { LateReads } from '@/app/(authed)/items/[key]/_components/lateReads';

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
