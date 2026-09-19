// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import { CORE_PR } from '../helpers/howToTestFixtures';

// THE REPAIR READ IS CONTAINED (Story MOTIR-5460 · MOTIR-5466). The item page's
// late tier reads the Development block's repair state beside its siblings, and a
// read that THROWS must leave the block rendering without the fix part — never an
// error in a card whose rows still read fine. Every other late read is stubbed; the
// repair read is made to throw, and the result is rendered through the real stack.

const repairView = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
}));
vi.mock('@/lib/services/workItemRepairService', () => ({
  workItemRepairService: { getRepairView: repairView },
}));
vi.mock('@/lib/services/workItemsService', () => ({
  workItemsService: { listLinkedPullRequests: async () => [CORE_PR] },
}));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: {
    getCommentCapabilities: async () => ({}),
    getAttachmentCapabilities: async () => ({}),
  },
}));
vi.mock('@/lib/services/commentsService', () => ({ commentsService: {} }));
vi.mock('@/lib/services/activityService', () => ({
  activityService: { listAll: async () => null },
}));
vi.mock('@/lib/services/attachmentsService', () => ({
  attachmentsService: { listForWorkItem: async () => null },
}));
vi.mock('@/lib/services/acceptanceEvidenceService', () => ({ acceptanceEvidenceService: {} }));
vi.mock('@/lib/services/acceptanceVideoEligibilityService', () => ({
  acceptanceVideoEligibilityService: {},
}));
vi.mock('@/lib/services/designEvidenceService', () => ({
  designEvidenceService: { getCurrentForWorkItem: async () => null },
}));
vi.mock('@/lib/services/approvalGatesService', () => ({
  approvalGatesService: {
    getForWorkItem: async () => ({
      gate: null,
      canDecide: false,
      routedToLabel: null,
      settingsDoor: null,
      movedSince: [],
    }),
  },
}));
vi.mock('@/lib/services/pullRequestMergeService', () => ({ pullRequestMergeService: {} }));
vi.mock('@/lib/services/dispatchRunService', () => ({
  dispatchRunService: { listRunsForWorkItemKey: async () => [] },
}));
vi.mock('@/lib/services/howToTestService', () => ({
  howToTestService: { getForWorkItem: async () => null },
}));
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

import { readLateSections } from '@/app/(authed)/items/[key]/_components/lateReads';
import { LateUpperSections } from '@/app/(authed)/items/[key]/_components/LateSections';

afterEach(() => {
  cleanup();
  repairView.mockReset();
});

const input = {
  itemId: 'wi-acme-12',
  itemType: 'code',
  itemStatus: 'implemented',
  itemKind: 'task',
  projectId: 'proj-acme',
  ctx: { userId: 'u-viewer', workspaceId: 'ws-acme' },
  fullCtx: { userId: 'u-viewer', workspaceId: 'ws-acme' } as never,
  activityTab: 'all' as const,
  canEdit: true,
  itemIdentifier: 'ACME-12',
  projectKey: 'ACME',
  hasChildren: false,
};

async function renderStack(reads: ReturnType<typeof readLateSections>) {
  return render(
    await LateUpperSections({
      reads,
      itemId: 'wi-acme-12',
      itemIdentifier: 'ACME-12',
      currentUserId: 'u-viewer',
      canEdit: true,
      repoDelivery: [],
      deliveries: [],
    }),
  );
}

describe('the late tier — the repair read is contained', () => {
  it('a repair read that THROWS resolves to null, and the block renders without the fix part', async () => {
    repairView.mockRejectedValue(new Error('the read failed'));

    const reads = readLateSections(input);
    await expect(reads).resolves.toMatchObject({ repair: null });
    const { container } = await renderStack(reads);

    expect(
      screen.queryByRole('group', { name: messages.github.development.fix.aria.part }),
    ).toBeNull();
    expect(container.textContent).toContain(CORE_PR.title);
    expect(repairView).toHaveBeenCalledWith('wi-acme-12', input.ctx);
  });

  it('a repair read that ANSWERS is carried through to the block', async () => {
    repairView.mockResolvedValue({
      state: 'offer',
      failing: [{ repo: CORE_PR.repo, number: CORE_PR.number }],
      lastGaveUp: null,
    });

    await renderStack(readLateSections(input));

    expect(
      screen.getByRole('group', { name: messages.github.development.fix.aria.part }),
    ).toBeTruthy();
  });
});
