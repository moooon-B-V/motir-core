// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { db } from '@/lib/db';
import { howToTestService } from '@/lib/services/howToTestService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import messages from '@/messages/en.json';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  API_HEAD,
  COMMAND_RUN,
  COMMAND_SETUP,
  RUN_BODY,
  WEB_HEAD,
  buildStoryRun,
} from './storyGateScenario';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — seam 9, the RENDER seam (Story MOTIR-4906 · MOTIR-5337)
// ═══════════════════════════════════════════════════════════════════════════
//
// happy-dom AND real Postgres in one file (the `searchSpendStoryGate` shape): the
// item page's REAL late read (`readLateSections`) runs against the rows a scoped
// story run left, and its REAL output is handed to the item page's REAL late
// stack (`LateUpperSections`). No hand-built DTO stands in anywhere — the
// component suites start from `howToTestFixtures.ts`, the read's suite stops at
// the DTO, and a field the read spells differently from the block would pass
// both.
//
// What is mocked, and why none of it is on the seam: `next-intl/server` has no
// request to read a locale from under Vitest, so it is answered with the same
// `en` catalogue; the Run, Acceptance and Design-result panels and the manual
// link controls are client islands that need an app router and render nothing
// this seam asserts. The Development card, `DevelopmentSectionBody`,
// `HowToTestBlock`, the Markdown pipeline and `CopyableCodeBlock` are all real.

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
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

import { LateUpperSections } from '@/app/(authed)/items/[key]/_components/LateSections';
import { readLateSections } from '@/app/(authed)/items/[key]/_components/lateReads';

const htt = messages.github.development.howToTest;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(async () => {
  await truncateAuthTables();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(cleanup);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function renderStoryPage() {
  const s = await buildStoryRun();
  // The write half is seam 1 (over `/api/mcp`); here the same service call it
  // lands on, attributed to the same running scoped run.
  await testInstructionsService.publish(
    {
      workItemId: s.story.id,
      bodyMd: RUN_BODY,
      previewPath: `/items/${s.story.identifier}`,
      repos: [
        { repoId: s.webRepo.id, commitSha: WEB_HEAD },
        { repoId: s.apiRepo.id, commitSha: API_HEAD },
      ],
      attributeToRunningDispatch: true,
    },
    s.fx.ctx,
  );

  const reads = await readLateSections({
    itemId: s.story.id,
    itemType: null,
    itemStatus: 'in_progress',
    itemKind: 'story',
    projectId: s.fx.projectId,
    ctx: s.fx.ctx,
    fullCtx: s.fx.ctx,
    activityTab: 'comments',
    canEdit: true,
    itemIdentifier: s.story.identifier,
    // A story run as a scope HAS children, so the page makes the scoped-run read
    // for it (MOTIR-5363); the real page passes exactly these two.
    projectKey: s.fx.projectIdentifier,
    hasChildren: true,
  });
  const ui = await LateUpperSections({
    reads: Promise.resolve(reads),
    itemId: s.story.id,
    itemIdentifier: s.story.identifier,
    canEdit: true,
    repoDelivery: [],
    deliveries: [],
  });
  return { s, reads, ...render(ui) };
}

describe('seam 9 — the read’s DTO, rendered by the Development block', () => {
  it('the item page reads exactly the DTO the How-to-test read answers', async () => {
    const { s, reads } = await renderStoryPage();
    expect(reads.howToTest).toEqual(await howToTestService.getForWorkItem(s.story.id, s.fx.ctx));
    expect(reads.howToTest?.record?.bodyMd).toBe(RUN_BODY);
    expect(reads.pullRequests.map((pr) => pr.id).sort()).toEqual([s.webPr.id, s.apiPr.id].sort());
  });

  it('each fenced block in the body copies its content BYTE FOR BYTE; each repository fetch copies its fetchCommand', async () => {
    const { reads } = await renderStoryPage();
    const part = screen.getByRole('group', { name: htt.title });
    const controls = within(part).getAllByRole('button', { name: htt.code.copyAria });
    // Two fences in the body, then one fetch block per repository section.
    expect(controls).toHaveLength(4);

    const copied: string[] = [];
    for (const control of controls) {
      await act(async () => {
        fireEvent.click(control);
      });
      copied.push(writeText.mock.lastCall![0]);
    }
    expect(writeText).toHaveBeenCalledTimes(4);

    expect(copied[0]).toBe(COMMAND_SETUP);
    expect(copied[1]).toBe(COMMAND_RUN);
    // Byte for byte, not merely string-equal after some normalisation.
    expect(Buffer.from(copied[0]!, 'utf8').equals(Buffer.from(COMMAND_SETUP, 'utf8'))).toBe(true);
    expect(Buffer.from(copied[1]!, 'utf8').equals(Buffer.from(COMMAND_RUN, 'utf8'))).toBe(true);
    expect(copied[1]).toContain('\t');
    expect(copied[1]).toContain('→ <ok> & done');

    const fetches = reads.howToTest!.repos.map((r) => r.fetchCommand);
    expect(fetches.every((f) => typeof f === 'string' && f.length > 0)).toBe(true);
    expect(copied.slice(2)).toEqual(fetches);
  });

  it('How to test exists ONLY inside the Development card — no section of its own anywhere in the stack', async () => {
    const { s, container } = await renderStoryPage();

    const sectionTitles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(sectionTitles).toContain(messages.github.development.title);
    expect(sectionTitles).not.toContain(htt.title);

    const parts = screen.getAllByRole('group', { name: htt.title });
    expect(parts).toHaveLength(1);
    const cards = [...container.querySelectorAll<HTMLElement>('[data-surface="card"]')];
    const holding = cards.filter((card) => card.contains(parts[0]!));
    expect(holding.length).toBeGreaterThan(0);
    const development = holding[holding.length - 1]!;
    expect(
      within(development).getByRole('heading', {
        level: 2,
        name: messages.github.development.title,
      }),
    ).toBeTruthy();
    // The same card holds the story's session pull-request rows, above the part.
    for (const title of [`Session PR motir/run-20260913-120000`]) {
      const rows = within(development).getAllByText(title);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(
          row.compareDocumentPosition(parts[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    }
    // And the body's own sections render as its headings, inside the part.
    for (const name of ['Precondition', 'Locally', 'Click-path']) {
      expect(within(parts[0]!).getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    expect(s.story.identifier).toMatch(/^PROD-\d+$/);
  });
});
