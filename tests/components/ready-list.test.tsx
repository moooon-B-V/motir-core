// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { ReadyItemDto } from '@/lib/dto/ready';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// ReadyRow (Subtask 7.0.6) builds the per-row clipboard command. Bug 8.8.3: a
// container kind (epic / story) — which enters the ready set only while childless
// — is *planned/deepened*, so its copy button must dispatch `motir plan <key>`;
// executable leaves (task / subtask / bug) stay `motir run <key>`. The toast body
// and tooltip both interpolate that same command, so the copied string and the
// confirmation surface stay in lockstep. These cover both verb branches.

// No real router under happy-dom — the row's whole-card peek uses next/navigation.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/ready',
  useSearchParams: () => new URLSearchParams(),
}));

// The cursor-driven "load more" Server Action pulls server-only deps; the list
// never calls it with initialCursor=null, so stub it to keep this test DB-free.
vi.mock('@/app/(authed)/ready/_actions', () => ({
  loadMoreReadyAction: vi.fn(),
}));

import { ReadyList } from '@/app/(authed)/ready/_components/ReadyList';

function item(over: Partial<ReadyItemDto> & { key: string; kind: WorkItemKindDto }): ReadyItemDto {
  return {
    id: `id-${over.key}`,
    title: `Item ${over.key}`,
    priority: 'medium',
    status: { key: 'todo', category: 'todo' },
    assignee: null,
    descriptionExcerpt: null,
    type: null,
    executor: null,
    descriptionMd: null,
    ...over,
  };
}

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(cleanup);

function renderRows(items: ReadyItemDto[]) {
  return renderWithIntl(
    <ToastProvider>
      <ReadyList initialItems={items} initialCursor={null} />
    </ToastProvider>,
  );
}

describe('ReadyList copy command verb', () => {
  it.each([
    { kind: 'epic' as const, key: 'PROD-1', verb: 'plan' },
    { kind: 'story' as const, key: 'PROD-2', verb: 'plan' },
    { kind: 'task' as const, key: 'PROD-3', verb: 'run' },
    { kind: 'subtask' as const, key: 'PROD-4', verb: 'run' },
    { kind: 'bug' as const, key: 'PROD-5', verb: 'run' },
  ])('copies `motir $verb $key` for a $kind row', async ({ kind, key, verb }) => {
    renderRows([item({ kind, key })]);

    fireEvent.click(screen.getByRole('button', { name: `Copy run command for ${key}` }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`motir ${verb} ${key}`);
  });

  it('shows the actual copied command in the confirmation toast (plan branch)', async () => {
    renderRows([item({ kind: 'story', key: 'PROD-2' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Copy run command for PROD-2' }));

    // The success toast body interpolates the same command the clipboard got.
    await waitFor(() =>
      expect(screen.getByText('Paste motir plan PROD-2 into your terminal.')).toBeTruthy(),
    );
  });

  it('shows the actual copied command in the confirmation toast (run branch)', async () => {
    renderRows([item({ kind: 'task', key: 'PROD-3' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Copy run command for PROD-3' }));

    await waitFor(() =>
      expect(screen.getByText('Paste motir run PROD-3 into your terminal.')).toBeTruthy(),
    );
  });
});

describe('ReadyList work-type chip (8.8.10)', () => {
  it('renders the type chip when the row has a `type`', () => {
    renderRows([item({ kind: 'subtask', key: 'PROD-7', type: 'code', executor: 'coding_agent' })]);
    // The chip label is the i18n type gloss (`labels.workItemType.code`).
    expect(screen.getByText('Code')).toBeTruthy();
  });

  it('omits the chip when `type` is null (a childless story/epic in the set)', () => {
    renderRows([item({ kind: 'story', key: 'PROD-2', type: null })]);
    // No work-type gloss rendered for a null type — no placeholder filler.
    expect(screen.queryByText('Code')).toBeNull();
    expect(screen.queryByText('Manual')).toBeNull();
  });
});

describe('ReadyList manual *Show instruction* variant (8.8.10)', () => {
  const manual = (over: Partial<ReadyItemDto> = {}) =>
    item({
      kind: 'subtask',
      key: 'PROD-9',
      type: 'manual',
      executor: 'human',
      descriptionMd: 'Provision the **blob store** in the dashboard.',
      ...over,
    });

  it('swaps the copy button for *Show instruction* on a manual row', () => {
    renderRows([manual()]);
    // No agent copy affordance — a human task has no run command.
    expect(screen.queryByRole('button', { name: 'Copy run command for PROD-9' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show instruction for PROD-9' })).toBeTruthy();
  });

  it('treats a human-executor row with no `type` as manual', () => {
    renderRows([manual({ type: null, executor: 'human' })]);
    expect(screen.getByRole('button', { name: 'Show instruction for PROD-9' })).toBeTruthy();
  });

  it('opens the instruction modal rendering the item descriptionMd as Markdown', async () => {
    renderRows([manual()]);

    fireEvent.click(screen.getByRole('button', { name: 'Show instruction for PROD-9' }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const dialog = screen.getByRole('dialog');
    // Title = the item title; the body renders the Markdown (bold → <strong>).
    expect(within(dialog).getByText('Item PROD-9')).toBeTruthy();
    expect(within(dialog).getByText('blob store')).toBeTruthy();
    expect(within(dialog).getByText('Human task · unassigned')).toBeTruthy();
  });

  it('shows the empty state when a manual row has no instruction body', async () => {
    renderRows([manual({ descriptionMd: null })]);

    fireEvent.click(screen.getByRole('button', { name: 'Show instruction for PROD-9' }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(within(screen.getByRole('dialog')).getByText('No instruction yet')).toBeTruthy();
  });
});
