// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type {
  PlacementFolderDto,
  WorkItemPlacementDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';

// The item page's PLACEMENT CHANNEL and its breadcrumb (Story MOTIR-5309 ·
// MOTIR-5381). The re-read is stubbed at the action boundary, so what is under
// test is the channel: it draws the server's seed, repaints from the server's
// answer to a report, lets only the LATEST report's answer apply, keeps its last
// value on a refusal, and yields to a fresher server render.

const { placementSpy } = vi.hoisted(() => ({ placementSpy: vi.fn() }));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  getWorkItemPlacementAction: placementSpy,
}));

import {
  PlacementProvider,
  usePlacementReporter,
} from '@/app/(authed)/items/[key]/_components/PlacementProvider';
import { PlacementBreadcrumb } from '@/app/(authed)/items/[key]/_components/PlacementBreadcrumb';
import { ParentBreadcrumb } from '@/app/(authed)/items/[key]/_components/ParentBreadcrumb';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function summary(overrides: Partial<WorkItemSummaryDto>): WorkItemSummaryDto {
  return {
    id: 'wi',
    parentId: null,
    kind: 'epic',
    key: 1,
    identifier: 'PROD-1',
    title: 'Item',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: null,
    archivedAt: null,
    ...overrides,
  } as WorkItemSummaryDto;
}

const oldImport = summary({ id: 'e1', identifier: 'PROD-12', title: 'Old import' });
const q3 = summary({ id: 'e2', identifier: 'PROD-40', title: 'Q3 launch' });

function folder(path: string[], via: WorkItemSummaryDto | null = null): PlacementFolderDto {
  return { folderId: `f-${path.join('-')}`, path, via };
}

const filedDirectly: WorkItemPlacementDto = {
  folderId: 'f-Parked-2025',
  parent: null,
  ancestors: [],
  placementFolder: folder(['Parked', '2025']),
};
const inherited: WorkItemPlacementDto = {
  folderId: null,
  parent: oldImport,
  ancestors: [oldImport],
  placementFolder: folder(['Parked', '2025'], oldImport),
};
const unfiled: WorkItemPlacementDto = {
  folderId: null,
  parent: q3,
  ancestors: [q3],
  placementFolder: null,
};

function Reporter() {
  const report = usePlacementReporter();
  return (
    <button type="button" onClick={() => report('wi')}>
      report
    </button>
  );
}

function page(seed: WorkItemPlacementDto) {
  return (
    <PlacementProvider serverPlacement={seed}>
      <PlacementBreadcrumb />
      <Reporter />
    </PlacementProvider>
  );
}

describe('the placement breadcrumb — seeded by the server', () => {
  it('a directly filed item leads with its folder path and has no ancestor segment', () => {
    render(page(filedDirectly));
    const nav = screen.getByRole('navigation', { name: 'Folder and parent work items' });
    expect(nav.textContent).toContain('Parked ▸ 2025');
    expect(within(nav).getByText('Folder:')).toBeTruthy();
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });

  it('an item placed through its root shows the folder path, THEN its epic', () => {
    render(page(inherited));
    const nav = screen.getByRole('navigation', { name: 'Folder and parent work items' });
    const epic = within(nav).getByRole('link', { name: /Epic: Old import/ });
    expect(epic.getAttribute('href')).toBe('/items/PROD-12');
    const text = nav.textContent ?? '';
    expect(text.indexOf('Parked ▸ 2025')).toBeLessThan(text.indexOf('Epic: Old import'));
  });

  it('an unfiled item renders exactly the DOM ParentBreadcrumb renders today', () => {
    const { container: channel } = render(page(unfiled));
    const nav = channel.querySelector('nav')!;
    cleanup();
    const { container: today } = render(<ParentBreadcrumb ancestors={[q3]} />);
    expect(nav.outerHTML).toBe(today.querySelector('nav')!.outerHTML);
    expect(nav.getAttribute('aria-label')).toBe('Parent work items');
  });
});

describe('the placement channel — a report repaints from the server’s answer', () => {
  it('calls the action once and repaints the breadcrumb from its answer', async () => {
    placementSpy.mockResolvedValue({ ok: true, placement: unfiled });
    render(page(inherited));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'report' }));
    });

    expect(placementSpy).toHaveBeenCalledTimes(1);
    expect(placementSpy).toHaveBeenCalledWith('wi');
    const nav = screen.getByRole('navigation', { name: 'Parent work items' });
    expect(within(nav).getByRole('link', { name: /Epic: Q3 launch/ })).toBeTruthy();
    expect(nav.textContent).not.toContain('Parked');
  });

  it('two reports whose answers resolve in reverse order: the LATER report’s answer renders', async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    placementSpy
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
    render(page(unfiled));

    fireEvent.click(screen.getByRole('button', { name: 'report' }));
    fireEvent.click(screen.getByRole('button', { name: 'report' }));
    await act(async () => {
      resolveSecond({ ok: true, placement: filedDirectly });
    });
    await act(async () => {
      resolveFirst({ ok: true, placement: inherited });
    });

    const nav = screen.getByRole('navigation', { name: 'Folder and parent work items' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
    expect(nav.textContent).toContain('Parked ▸ 2025');
  });

  it('a refused answer leaves the breadcrumb unchanged and throws nothing', async () => {
    placementSpy.mockResolvedValue({ ok: false, error: 'Work item not found.' });
    render(page(inherited));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'report' }));
    });

    const nav = screen.getByRole('navigation', { name: 'Folder and parent work items' });
    expect(within(nav).getByRole('link', { name: /Epic: Old import/ })).toBeTruthy();
  });

  it('a failed read (the action rejects) also keeps the last value', async () => {
    placementSpy.mockRejectedValue(new Error('network'));
    render(page(filedDirectly));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'report' }));
    });

    expect(
      screen.getByRole('navigation', { name: 'Folder and parent work items' }).textContent,
    ).toContain('Parked ▸ 2025');
  });

  it('a fresher server render wins over a standing answer', async () => {
    placementSpy.mockResolvedValue({ ok: true, placement: unfiled });
    const { rerender } = render(page(inherited));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'report' }));
    });
    expect(screen.getByRole('navigation', { name: 'Parent work items' })).toBeTruthy();

    rerender(page(filedDirectly));

    const nav = screen.getByRole('navigation', { name: 'Folder and parent work items' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('ParentBreadcrumb outside the channel', () => {
  it('an unfiled top-level item still renders nothing', () => {
    const { container } = render(<ParentBreadcrumb ancestors={[]} placementFolder={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('PlacementBreadcrumb outside a provider renders nothing', () => {
    const { container } = render(<PlacementBreadcrumb />);
    expect(container.firstChild).toBeNull();
  });

  it('a reporter outside a provider is a no-op — it asks the server nothing and throws nothing', () => {
    // The rail's unit call sites and any surface without a breadcrumb report into
    // this: a parent change there must neither crash nor fire a placement read.
    function LoneReporter() {
      const report = usePlacementReporter();
      return (
        <button type="button" onClick={() => report('wi_7')}>
          report
        </button>
      );
    }
    render(<LoneReporter />);

    expect(() => fireEvent.click(screen.getByRole('button', { name: 'report' }))).not.toThrow();
    expect(placementSpy).not.toHaveBeenCalled();
  });
});
