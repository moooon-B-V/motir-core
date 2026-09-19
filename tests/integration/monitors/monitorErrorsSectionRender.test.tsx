// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { db } from '@/lib/db';
import type { MonitorProvider } from '@/lib/monitors/provider';
import { fakeMonitorProvider, resetFakeMonitorProvider } from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import messages from '@/messages/en.json';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { renderWithIntl as render } from '../../helpers/renderWithIntl';
import {
  card,
  memberWithPermissions,
  monitorLinkScenario,
  plantLink,
  type MonitorLinkScenario,
} from './_monitorLinkFixtures';

// THE WORK-ITEM PAGE SHOWS ITS ERRORS (Story MOTIR-4932 · Subtask MOTIR-5732) —
// the page's REAL late read on real Postgres, rendered through the REAL late
// stack. The monitor provider is armed to THROW on every method and count, so
// "loading the page makes no provider call" is a measurement of this render,
// not a reading of the code.

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
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

const { readLateSections } = await import('@/app/(authed)/items/[key]/_components/lateReads');
const { LateUpperSections } = await import('@/app/(authed)/items/[key]/_components/LateSections');

const errorsMsg = messages.monitorErrors;
let providerCalls: string[] = [];

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  providerCalls = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  cleanup();
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The page's own derivation of `canEdit` (`page.tsx`: `held.has('work_item:edit')`). */
async function canEditFor(s: MonitorLinkScenario, ctx: ServiceContext): Promise<boolean> {
  return (await projectAccessService.getPermissions(s.fx.projectId, ctx)).has('work_item:edit');
}

/** From here on, every provider method THROWS and counts — armed after the
 *  fixture has connected its grant, immediately before the page reads. */
function armProviderToThrow(): void {
  const throwing = Object.fromEntries(
    Object.keys(fakeMonitorProvider)
      .filter((key) => key !== 'id')
      .map((key) => [
        key,
        async () => {
          providerCalls.push(key);
          throw new Error(`the page called the monitor (${key})`);
        },
      ]),
  ) as unknown as MonitorProvider;
  registerMonitorProvider({ ...throwing, id: 'fake' }, 'sentry');
}

async function renderPage(s: MonitorLinkScenario, itemId: string, ctx: ServiceContext) {
  armProviderToThrow();
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: itemId } });
  const canEdit = await canEditFor(s, ctx);
  const reads = await readLateSections({
    itemId,
    itemType: null,
    itemStatus: item.status,
    itemKind: item.kind,
    projectId: s.fx.projectId,
    ctx,
    fullCtx: ctx,
    activityTab: 'comments',
    canEdit,
    itemIdentifier: item.identifier,
    projectKey: s.fx.projectIdentifier,
    hasChildren: false,
  });
  const ui = await LateUpperSections({
    reads: Promise.resolve(reads),
    itemId,
    itemIdentifier: item.identifier,
    currentUserId: ctx.userId,
    canEdit,
    repoDelivery: [],
    deliveries: [],
  });
  return { reads, ...render(ui) };
}

const errorsHeading = () => screen.queryByRole('heading', { name: errorsMsg.title });

describe('the Errors section on the real page', () => {
  it('one link: every panel-1 field renders from the store, and the page makes ZERO provider calls', async () => {
    const s = await monitorLinkScenario('Render');
    const item = await card(s.fx, 'Checkout breaks');
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'one',
      workItemId: item.id,
      lastSeenAt: new Date(Date.now() - 5 * 60_000),
      eventCount: 40_112,
      extra: { environment: 'production', release: '2026.09.18-1' },
    });

    const { reads } = await renderPage(s, item.id, s.fx.ctx);

    expect(providerCalls).toEqual([]);
    expect(reads.monitorHasConnection).toBe(true);
    expect(errorsHeading()).not.toBeNull();
    const [row] = screen.getAllByTestId('error-row');
    const title = within(row!).getByRole('link', { name: 'Error one' });
    expect(title.getAttribute('href')).toBe('https://fake.invalid/issues/one');
    expect(title.getAttribute('target')).toBe('_blank');
    expect(row!.textContent).toContain('fake-org / web · production · 2026.09.18-1');
    expect(within(row!).getByTestId('error-count').textContent).toBe('40,112');
    expect(within(row!).getByTestId('error-level').textContent).toBe('error');
    expect(row!.textContent).toMatch(/last seen .*minutes? ago/);
    expect(within(row!).getByRole('link', { name: errorsMsg.openInSentry })).toBeTruthy();
  });

  it('three links from two connections render three rows, most recently seen first, each naming its connection', async () => {
    const s = await monitorLinkScenario('Render');
    const item = await card(s.fx);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'old',
      workItemId: item.id,
      lastSeenAt: at(300),
    });
    await plantLink(s, {
      connectionId: s.workerConnectionId,
      externalIssueId: 'new',
      workItemId: item.id,
      lastSeenAt: at(3),
    });
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'mid',
      workItemId: item.id,
      lastSeenAt: at(60),
    });

    await renderPage(s, item.id, s.fx.ctx);

    const rows = screen.getAllByTestId('error-row');
    expect(rows.map((r) => within(r).getAllByRole('link')[0]!.textContent)).toEqual([
      'Error new',
      'Error mid',
      'Error old',
    ]);
    expect(rows[0]!.textContent).toContain('fake-org / worker');
    expect(rows[1]!.textContent).toContain('fake-org / web');
    expect(providerCalls).toEqual([]);
  });

  it('a work item with NO link renders no Errors section — the upper tier is what it was', async () => {
    const s = await monitorLinkScenario('Render');
    const item = await card(s.fx);

    const { container } = await renderPage(s, item.id, s.fx.ctx);

    expect(errorsHeading()).toBeNull();
    expect(screen.queryByTestId('errors-list')).toBeNull();
    expect(screen.queryByText(errorsMsg.loadFailedTitle)).toBeNull();
    const withMonitor = container.innerHTML;
    cleanup();

    // The BASELINE: the same card as a page with no monitor feature at all would
    // read it — no links, no connection. The tier must be byte-identical.
    vi.spyOn(monitorIssueService, 'listForWorkItem').mockResolvedValueOnce([]);
    vi.spyOn(monitorIssueService, 'projectHasConnection').mockResolvedValueOnce(false);
    const baseline = await renderPage(s, item.id, s.fx.ctx);
    expect(baseline.container.innerHTML).toBe(withMonitor);
  });

  it('the × shows for an editor and NOT for a custom role holding only item-read — the rows show for both', async () => {
    const s = await monitorLinkScenario('Render');
    const item = await card(s.fx);
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'x',
      workItemId: item.id,
      lastSeenAt: new Date(),
    });
    const unlinkName = errorsMsg.unlink.aria.replace('{title}', 'Error x');

    await renderPage(s, item.id, s.fx.ctx);
    expect(screen.getAllByTestId('error-row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: unlinkName })).not.toBeNull();
    cleanup();

    const reader = await memberWithPermissions(s.fx, ['project:browse'], 'reader@ex.com');
    await renderPage(s, item.id, reader);
    expect(screen.getAllByTestId('error-row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: unlinkName })).toBeNull();
  });

  it('a failed read renders the section’s ErrorState and leaves Development rendering', async () => {
    const s = await monitorLinkScenario('Render');
    const item = await card(s.fx);
    vi.spyOn(monitorIssueService, 'listForWorkItem').mockRejectedValueOnce(new Error('db down'));

    const { reads } = await renderPage(s, item.id, s.fx.ctx);

    expect(reads.monitorIssueLinks).toBeNull();
    expect(screen.getByText(errorsMsg.loadFailedTitle)).toBeTruthy();
    expect(screen.getByRole('heading', { name: messages.github.development.title })).toBeTruthy();
  });

  it('a failed read in a project with NO connection draws nothing — there was no link to fail to read', async () => {
    const s = await monitorLinkScenario('Render');
    const item = await card(s.fx);
    await adminDb.monitorConnection.deleteMany({ where: { projectId: s.fx.projectId } });
    vi.spyOn(monitorIssueService, 'listForWorkItem').mockRejectedValueOnce(new Error('db down'));

    const { reads } = await renderPage(s, item.id, s.fx.ctx);

    expect(reads.monitorHasConnection).toBe(false);
    expect(errorsHeading()).toBeNull();
    expect(screen.queryByText(errorsMsg.loadFailedTitle)).toBeNull();
  });
});
