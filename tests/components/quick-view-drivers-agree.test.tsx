// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/lib/dto/quickView';

// MOTIR-2567 — BOTH PEEK DRIVERS AGREE.
//
// The peek has two hosts. `IssueQuickViewController` drives it from `?peek` over
// /items · /ready · /boards, where the surface behind the modal is
// server-rendered, so it settles with `router.refresh()`. `WorkItemQuickView`
// drives it from local state on the planning canvas, which is a CLIENT ISLAND a
// route refresh cannot reach (the page-state contract), so it settles by calling
// the `onEdited` callback its host passes down.
//
// Different mechanisms, ONE contract — and that contract is the design's panel
// 12 decision: re-read on CLOSE, exactly once, and NOT AT ALL when nothing was
// written. Each driver's own suite covers its own mechanism; nothing until now
// asserted the two answer the same way. A signal added to one and not the other
// is precisely how the canvas peek silently becomes a different product, and it
// would not fail a single existing test.

const refresh = vi.fn();
let searchParamsString = 'peek=PROD-7';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}));

const updateIssueAction = vi.fn();
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: (...args: unknown[]) => updateIssueAction(...args),
  changeStatusAction: vi.fn(),
}));

// The client-island tick (MOTIR-2604). Stubbed at the accessor rather than by
// mounting the real provider, which would drag the create-issue modal and its
// whole dependency tree into a test about one callback.
const notifyIssuesChanged = vi.fn();
vi.mock('@/app/(authed)/_components/CreateIssueProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/(authed)/_components/CreateIssueProvider')>();
  return { ...actual, useNotifyIssuesChanged: () => notifyIssuesChanged };
});

import { IssueQuickViewController } from '@/app/(authed)/items/_components/IssueQuickViewController';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';

const DATA: QuickViewData = {
  id: 'cmqvitem00000000000000p7',
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  descriptionMd: 'Sign in with email and password.',
  type: 'code',
  executor: 'coding_agent',
  assigneeName: null,
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  archived: null,
  parent: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  hasChildren: false,
  canPlan: true,
  status: 'todo',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points',
    pointScale: 'fibonacci',
    customScaleValues: [],
    canEdit: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  searchParamsString = 'peek=PROD-7';
  updateIssueAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => DATA })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(label: string) {
  return screen.getByText(label, { selector: 'dt' }).parentElement as HTMLElement;
}

/** Edit Priority through the rail — the same gesture on either driver. */
async function editPriority() {
  await screen.findByText('Priority', { selector: 'dt' });
  fireEvent.click(within(row('Priority')).getByRole('button', { name: 'Edit Priority' }));
  fireEvent.click(await screen.findByRole('option', { name: 'High' }));
  await waitFor(() => expect(updateIssueAction).toHaveBeenCalledTimes(1));
}

// ── The URL-driven driver (/items · /ready · /boards) ───────────────────────
// Its "settle" is `router.refresh()`, fired when `?peek` clears.

async function renderUrlDriver() {
  const view = render(<IssueQuickViewController />);
  await screen.findByText('Priority', { selector: 'dt' });
  return view;
}

/** Clear `?peek` and re-render — what a close does to this driver. */
async function closeUrlDriver(rerender: (ui: React.ReactElement) => void) {
  searchParamsString = '';
  await act(async () => {
    rerender(<IssueQuickViewController />);
  });
}

// ── The local-state driver (the planning canvas) ────────────────────────────
// Its "settle" is the `onEdited` callback; a route refresh cannot reach the
// canvas, which owns its own state.

describe('both peek drivers settle the surface behind them the SAME way', () => {
  it('URL driver: an edit then a close re-reads the host ONCE — BOTH of its halves', async () => {
    const { rerender } = await renderUrlDriver();

    await editPriority();
    // NOT per edit — that fan-out is `bug-inline-status-revert-on-second-edit`.
    expect(refresh).not.toHaveBeenCalled();
    expect(notifyIssuesChanged).not.toHaveBeenCalled();

    await closeUrlDriver(rerender);
    expect(refresh).toHaveBeenCalledTimes(1);
    // MOTIR-2604 — the refresh alone reaches only the SERVER-rendered bits. The
    // rows on /items and the cards on /boards are client islands seeded once
    // from props, and they watch this tick instead; without it the row behind
    // the modal kept its pre-edit value until the user reloaded by hand.
    expect(notifyIssuesChanged).toHaveBeenCalledTimes(1);
  });

  it('URL driver: a close with NO edit re-reads nothing, by either mechanism', async () => {
    const { rerender } = await renderUrlDriver();
    await closeUrlDriver(rerender);
    expect(refresh).not.toHaveBeenCalled();
    expect(notifyIssuesChanged).not.toHaveBeenCalled();
  });

  it('local-state driver: an edit then a close signals the host ONCE', async () => {
    const onClose = vi.fn();
    const onEdited = vi.fn();
    render(<WorkItemQuickView peekKey="PROD-7" onClose={onClose} onEdited={onEdited} />);

    await editPriority();
    // Same rule as the URL driver: nothing fires while the peek is still open.
    expect(onEdited).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onEdited).toHaveBeenCalledTimes(1);
  });

  it('local-state driver: a close with NO edit signals nothing', async () => {
    const onClose = vi.fn();
    const onEdited = vi.fn();
    render(<WorkItemQuickView peekKey="PROD-7" onClose={onClose} onEdited={onEdited} />);
    await screen.findByText('Priority', { selector: 'dt' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // The host is not re-read for a peek that only LOOKED — the third half of
    // the panel-12 decision, and the easiest one to lose in one driver.
    expect(onEdited).not.toHaveBeenCalled();
  });

  it('both drivers remount the panel per ITEM, so a swap cannot inherit the last one’s state', async () => {
    // The rail's editors seed from the payload once (`useState(initial)`), so a
    // blocker swap inside an unkeyed panel would carry the previous item's
    // overrides and acknowledged token onto the new item. Both drivers key the
    // panel by identifier; asserting it on ONE of them is how the canvas drifts.
    for (const src of [
      'app/(authed)/items/_components/IssueQuickViewController.tsx',
      'components/planning/WorkItemQuickView.tsx',
    ]) {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      expect(readFileSync(join(process.cwd(), src), 'utf8')).toContain(
        'key={showing.data.identifier}',
      );
    }
  });
});
