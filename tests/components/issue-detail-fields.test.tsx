// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WorkItemDto, WorkItemPlacementDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';

// The inline rail commits through the edit Server Actions + refreshes the route;
// stub those, the parent-candidates fetch, the router, and the toast so the
// panel drives in isolation.
const {
  updateSpy,
  statusSpy,
  refreshSpy,
  toastSpy,
  setSprintSpy,
  placementSpy,
  candidatesSpy,
  fileSpy,
  foldersSpy,
} = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  statusSpy: vi.fn(),
  refreshSpy: vi.fn(),
  toastSpy: vi.fn(),
  setSprintSpy: vi.fn(),
  placementSpy: vi.fn(),
  candidatesSpy: vi.fn(),
  fileSpy: vi.fn(),
  foldersSpy: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: updateSpy,
  changeStatusAction: statusSpy,
  getWorkItemPlacementAction: placementSpy,
  fileWorkItemAction: fileSpy,
}));
// The Sprint field commits through the assign route via this client helper
// (2.4.14) — stub the fetch so the panel drives in isolation.
vi.mock('@/components/issues/actions/workItemActionsClient', () => ({
  setWorkItemSprint: setSprintSpy,
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  listCandidateParentsAction: candidatesSpy,
  listProjectFoldersAction: foldersSpy,
}));
// CoreFieldsPanel composes CustomFieldsSection (5.3.7), whose Server Action
// would pull the real db module into this unit suite — stub it out (its own
// behaviour is covered by custom-fields-section.test.tsx).
vi.mock('@/app/(authed)/items/[key]/customFieldActions', () => ({
  setCustomFieldValueAction: vi.fn().mockResolvedValue({ ok: true }),
}));
// Same for the Labels/Components cards' actions (5.4.8) — the panel imports
// the cards statically even when the optional `labelsComponents` prop is
// absent (their behaviour is covered by labels-components-cards.test.tsx).
vi.mock('@/app/(authed)/items/[key]/labelComponentActions', () => ({
  addLabelAction: vi.fn().mockResolvedValue({ ok: true, labels: [] }),
  removeLabelAction: vi.fn().mockResolvedValue({ ok: true, labels: [] }),
  addComponentAction: vi.fn().mockResolvedValue({ ok: true, components: [] }),
  removeComponentAction: vi.fn().mockResolvedValue({ ok: true, components: [] }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
  // The held-status notice's Review & approve link addresses the overlay over the
  // current page (MOTIR-5528).
  usePathname: () => '/items/PROD-7',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

import { CoreFieldsPanel } from '@/app/(authed)/items/[key]/_components/CoreFieldsPanel';
import { IssueExplanation } from '@/app/(authed)/items/[key]/_components/IssueExplanation';
import { PlacementProvider } from '@/app/(authed)/items/[key]/_components/PlacementProvider';
import { PlacementBreadcrumb } from '@/app/(authed)/items/[key]/_components/PlacementBreadcrumb';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';

beforeEach(() => {
  candidatesSpy.mockResolvedValue({ ok: true, candidates: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const members: WorkspaceMemberDTO[] = [
  { userId: 'u_assignee', name: 'Ada Lovelace', email: 'ada@example.com', role: 'member' },
  { userId: 'u_reporter', name: 'Grace Hopper', email: 'grace@example.com', role: 'owner' },
];

const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'proj_1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
    {
      id: 's2',
      projectId: 'proj_1',
      key: 'in_progress',
      label: 'In Progress',
      category: 'in_progress',
      color: null,
      position: 'a1',
      isInitial: false,
    },
    {
      id: 's3',
      projectId: 'proj_1',
      key: 'done',
      label: 'Done',
      category: 'done',
      color: null,
      position: 'a2',
      isInitial: false,
    },
  ],
  transitions: [],
  policyMode: 'open',
};

// A fully-populated work item; per-test overrides exercise the empty states.
function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'proj_1',
    parentId: null,
    kind: 'story',
    key: 7,
    identifier: 'PROD-7',
    title: 'Ship the detail page',
    descriptionMd: '# Hello',
    explanationMd: null,
    explanationSource: 'user_authored',
    status: 'todo',
    priority: 'high',
    assigneeId: 'u_assignee',
    reporterId: 'u_reporter',
    dueDate: '2026-06-10T00:00:00.000Z',
    estimateMinutes: 90,
    type: null,
    executor: null,
    difficulty: null,
    storyPoints: null,
    position: 'a0',
    sprintId: null,
    backlogRank: 'a0',
    publicChildrenHidden: false,
    sessionBranch: null,
    targetRepo: null,
    targetRepos: [],
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    subject: null,
    archivedAt: null,
    createdAt: '2026-06-01T14:45:00.000Z',
    updatedAt: '2026-06-03T09:30:00.000Z',
    ...overrides,
  };
}

function renderPanel(item = makeItem()) {
  return render(
    <CoreFieldsPanel
      item={item}
      members={members}
      workflow={workflow}
      parent={null}
      reporterIsSelf
    />,
  );
}

describe('CoreFieldsPanel (inline rail)', () => {
  it('DISPLAYS each field value (controls are hidden until the chevron is clicked)', () => {
    renderPanel();

    // Displayed values: status pill (To Do), type, priority pill (High),
    // reporter, due date, estimate, created/updated.
    expect(screen.getByText('To Do')).toBeTruthy();
    expect(screen.getByText('Story')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.getByText('Jun 10, 2026')).toBeTruthy();
    expect(screen.getByText('1h 30m')).toBeTruthy();
    expect(screen.getByText('Jun 1, 02:45 PM UTC')).toBeTruthy();

    // No edit control is mounted until its chevron is used.
    expect(screen.queryByLabelText('Priority')).toBeNull();
    expect(screen.queryByLabelText('Estimate (minutes)')).toBeNull();

    // Each editable field exposes an "Edit <field>" chevron; reporter does not.
    expect(screen.getByRole('button', { name: 'Edit Priority' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Type' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Edit Reporter/i })).toBeNull();
  });

  it('says a held move ON the status card without opening it, and locks it in the picker (MOTIR-5528)', async () => {
    render(
      <CoreFieldsPanel
        item={makeItem()}
        members={members}
        workflow={workflow}
        parent={null}
        reporterIsSelf
        heldTransitions={[
          {
            statusKey: 'done',
            statusLabel: 'Done',
            waitingOn: 'decision',
            kind: 'design_result',
            gateId: 'g1',
            canDecide: true,
            routedToLabel: 'Grace Hopper',
          },
        ]}
      />,
    );

    const notice = screen.getByTestId('status-held-notice');
    expect(notice.textContent).toContain("Status can't be moved to Done directly");
    expect(within(notice).getByRole('link', { name: 'Review & approve' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Status' }));
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: /Done/ }));
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('a hold that arrives on commit REVERTS the status and says so on the card — not a toast (MOTIR-5528)', async () => {
    statusSpy.mockResolvedValue({
      ok: false,
      error: 'held',
      field: 'status',
      code: 'APPROVAL_GATE_PENDING',
      gate: {
        itemKey: 'PROD-7',
        kind: 'design_result',
        waitingOn: 'decision',
        gateRaised: true,
        canDecide: false,
        routedToLabel: 'Grace Hopper',
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Status' }));
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));
    await act(async () => {});

    expect(statusSpy).toHaveBeenCalledWith({ id: 'wi_1', toStatusKey: 'done' });
    expect(toastSpy).not.toHaveBeenCalled();
    expect(screen.getByText('To Do')).toBeTruthy();
    expect(screen.getByTestId('status-held-notice').textContent).toContain(
      'a design approval is waiting on Grace Hopper.',
    );
  });

  it('reveals + commits a priority change through updateIssueAction', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    expect(screen.queryByLabelText('Priority')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Priority' }));
    // Priority now uses the shared Combobox picker (like Type/Assignee), not a
    // native <select> — drive it the same way: open, pick the option.
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wi_1', priority: 'low' }),
    );

    // The action above resolves asynchronously; flush that pass so its
    // state update lands inside the test rather than after it.
    await act(async () => {});
  });

  it('reveals + commits a type change (kind is editable) through updateIssueAction', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Type' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Task' }));

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'wi_1', kind: 'task' }));

    // The action above resolves asynchronously; flush that pass so its
    // state update lands inside the test rather than after it.
    await act(async () => {});
  });

  it('KEEPS the optimistic value on success without a whole-tree refresh', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    // The picked value stays on the rail — the 200 IS the confirmation, so the
    // success path must NOT router.refresh() (the inline-edit revert bug).
    await waitFor(() => expect(screen.getByText('Low')).toBeTruthy());
    expect(screen.queryByText('High')).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('commits an estimate edit on blur (and not on every keystroke)', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Estimate' }));
    const estimate = screen.getByLabelText('Estimate (minutes)');
    fireEvent.change(estimate, { target: { value: '120' } });
    expect(updateSpy).not.toHaveBeenCalled(); // no per-keystroke patch
    fireEvent.blur(estimate);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ estimateMinutes: 120 }));

    // The action above resolves asynchronously; flush that pass so its
    // state update lands inside the test rather than after it.
    await act(async () => {});
  });
});

// A parent change MOVES the item, and the breadcrumb that draws where it sits is a
// different island (Story MOTIR-5309 · MOTIR-5381). The rail reports a SUCCESSFUL
// parent change to the page's placement channel; the channel re-reads and the
// breadcrumb repaints — no whole-page refresh.
describe('CoreFieldsPanel → placement channel', () => {
  const oldEpic = {
    id: 'wi_old',
    parentId: null,
    kind: 'epic',
    key: 1,
    identifier: 'PROD-1',
    title: 'Old epic',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: null,
    archivedAt: null,
  } as unknown as WorkItemSummaryDto;
  const newEpic = {
    ...oldEpic,
    id: 'wi_new',
    key: 2,
    identifier: 'PROD-2',
    title: 'New epic',
  } as WorkItemSummaryDto;

  function renderOnPage() {
    candidatesSpy.mockResolvedValue({ ok: true, candidates: [oldEpic, newEpic] });
    return render(
      <PlacementProvider
        serverPlacement={{
          folderId: null,
          parent: oldEpic,
          ancestors: [oldEpic],
          placementFolder: null,
        }}
      >
        <PlacementBreadcrumb />
        <CoreFieldsPanel
          item={makeItem({ parentId: oldEpic.id })}
          members={members}
          workflow={workflow}
          parent={oldEpic}
          reporterIsSelf
        />
      </PlacementProvider>,
    );
  }

  async function pickNewParent() {
    fireEvent.click(screen.getByRole('button', { name: 'Edit Parent' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Parent' }));
    fireEvent.click(await screen.findByRole('option', { name: /New epic/ }));
    await act(async () => {});
  }

  it('repaints the breadcrumb from the re-read after a successful parent change', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    placementSpy.mockResolvedValue({
      ok: true,
      placement: { folderId: null, parent: newEpic, ancestors: [newEpic], placementFolder: null },
    });
    renderOnPage();
    const crumbs = screen.getByRole('navigation', { name: 'Parent work items' });
    expect(within(crumbs).getByRole('link', { name: /Old epic/ })).toBeTruthy();

    await pickNewParent();

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'wi_new' }));
    expect(placementSpy).toHaveBeenCalledTimes(1);
    expect(placementSpy).toHaveBeenCalledWith('wi_1');
    const repainted = screen.getByRole('navigation', { name: 'Parent work items' });
    expect(within(repainted).getByRole('link', { name: /New epic/ })).toBeTruthy();
    expect(within(repainted).queryByRole('link', { name: /Old epic/ })).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not report a refused parent change', async () => {
    updateSpy.mockResolvedValue({ ok: false, error: 'Nope', field: 'parent' });
    renderOnPage();

    await pickNewParent();

    expect(updateSpy).toHaveBeenCalled();
    expect(placementSpy).not.toHaveBeenCalled();
  });

  it('does not report a stale parent change (the refresh re-reads instead)', async () => {
    updateSpy.mockResolvedValue({ ok: false, error: 'Changed', stale: true });
    renderOnPage();

    await pickNewParent();

    expect(placementSpy).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('does not report a change to a field that cannot move the item', async () => {
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-03T10:00:00.000Z' });
    renderOnPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    await act(async () => {});

    expect(updateSpy).toHaveBeenCalled();
    expect(placementSpy).not.toHaveBeenCalled();
  });
});

// The page's FOLDER field (Story MOTIR-5309 · MOTIR-5377): below Parent, reading
// the placement channel, filing through the quick view's control and
// `fileWorkItemAction`, reverting both cards on a refusal, and reporting a
// successful filing so the breadcrumb follows.
describe('CoreFieldsPanel · Folder field', () => {
  const epic = {
    id: 'wi_epic',
    parentId: null,
    kind: 'epic',
    key: 12,
    identifier: 'PROD-12',
    title: 'Old import',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: null,
    archivedAt: null,
  } as unknown as WorkItemSummaryDto;
  const otherEpic = {
    ...epic,
    id: 'wi_other',
    key: 40,
    identifier: 'PROD-40',
    title: 'Q3 launch',
  } as WorkItemSummaryDto;

  const FOLDERS = {
    ok: true,
    data: {
      truncated: false,
      folders: [
        { id: 'parked', parentFolderId: null, name: 'Parked', position: 'a0', path: ['Parked'] },
        {
          id: 'y2025',
          parentFolderId: 'parked',
          name: '2025',
          position: 'a0',
          path: ['Parked', '2025'],
        },
      ],
    },
  };

  const filedDirectly: WorkItemPlacementDto = {
    folderId: 'y2025',
    parent: null,
    ancestors: [],
    placementFolder: { folderId: 'y2025', path: ['Parked', '2025'], via: null },
  };
  const inherited: WorkItemPlacementDto = {
    folderId: null,
    parent: epic,
    ancestors: [epic],
    placementFolder: { folderId: 'y2025', path: ['Parked', '2025'], via: epic },
  };
  const unfiled: WorkItemPlacementDto = {
    folderId: null,
    parent: otherEpic,
    ancestors: [otherEpic],
    placementFolder: null,
  };

  beforeEach(() => {
    foldersSpy.mockResolvedValue(FOLDERS);
    placementSpy.mockResolvedValue({ ok: false, error: 'not read' });
  });

  function renderFolder(placement: WorkItemPlacementDto, { readOnly = false } = {}) {
    const tree = (
      <PlacementProvider serverPlacement={placement}>
        <CoreFieldsPanel
          item={makeItem({ parentId: placement.parent?.id ?? null })}
          members={members}
          workflow={workflow}
          parent={placement.parent}
          reporterIsSelf
        />
      </PlacementProvider>
    );
    return render(
      readOnly ? <ProjectAccessProvider permissions={[]}>{tree}</ProjectAccessProvider> : tree,
    );
  }

  /** The rail card whose caption is `label` (caption div → header row → card). */
  function card(label: string) {
    return screen.getAllByText(label, { selector: 'div' })[0]!.parentElement!
      .parentElement as HTMLElement;
  }

  async function openFolder() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit Folder' }));
    });
    return screen.findByRole('listbox', { name: 'Folders' });
  }

  it('reads the path when filed directly, the path through its root when inherited, and No folder otherwise', () => {
    renderFolder(filedDirectly);
    expect(within(card('Folder')).getByText('Parked ▸ 2025')).toBeTruthy();
    expect(within(card('Folder')).queryByText(/^Through/)).toBeNull();
    expect(within(card('Parent')).getByText('None')).toBeTruthy();
    cleanup();

    renderFolder(inherited);
    expect(within(card('Folder')).getByText('Parked ▸ 2025')).toBeTruthy();
    expect(within(card('Folder')).getByText('Through PROD-12 Old import')).toBeTruthy();
    cleanup();

    renderFolder(unfiled);
    expect(within(card('Folder')).getByText('No folder')).toBeTruthy();
  });

  it('says, before any save, that filing removes the item from its parent', async () => {
    renderFolder(inherited);

    await openFolder();

    expect(
      within(card('Folder')).getByText('Filing it removes it from PROD-12 Old import.'),
    ).toBeTruthy();
    expect(fileSpy).not.toHaveBeenCalled();
  });

  it('filing writes once, shows the path and Parent None while it saves, then reports the placement', async () => {
    let resolveFile!: (v: unknown) => void;
    fileSpy.mockReturnValue(new Promise((r) => (resolveFile = r)));
    placementSpy.mockResolvedValue({
      ok: true,
      placement: {
        folderId: 'parked',
        parent: null,
        ancestors: [],
        placementFolder: { folderId: 'parked', path: ['Parked'], via: null },
      },
    });
    renderFolder(inherited);

    const listbox = await openFolder();
    await act(async () => {
      fireEvent.click(within(listbox).getByRole('option', { name: 'Parked' }));
    });

    expect(fileSpy).toHaveBeenCalledTimes(1);
    expect(fileSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', folderId: 'parked' });
    expect(within(card('Folder')).getByText('Parked')).toBeTruthy();
    expect(within(card('Parent')).getByText('None')).toBeTruthy();
    expect(placementSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveFile({ ok: true, updatedAt: '2026-06-04T00:00:00.000Z' });
    });

    expect(placementSpy).toHaveBeenCalledTimes(1);
    expect(placementSpy).toHaveBeenCalledWith('wi_1');
    expect(within(card('Folder')).getByText('Parked')).toBeTruthy();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('the next inline edit after a filing sends the filing’s updatedAt', async () => {
    fileSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-04T00:00:00.000Z' });
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-05T00:00:00.000Z' });
    renderFolder(filedDirectly);

    const listbox = await openFolder();
    await act(async () => {
      fireEvent.click(within(listbox).getByRole('option', { name: 'Parked' }));
    });

    // Status goes through the un-tokened transition path, so the proof is the
    // next token-carrying edit.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Priority' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    await act(async () => {});

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'low', expectedUpdatedAt: '2026-06-04T00:00:00.000Z' }),
    );
  });

  it('picking the folder the item is already in writes nothing', async () => {
    renderFolder(filedDirectly);

    const listbox = await openFolder();
    const current = within(listbox)
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')!;
    expect(current.textContent).toContain('2025');
    await act(async () => {
      fireEvent.click(current);
    });

    // The invariant the rail's own same-folder guard rests on: the picker DISMISSES
    // on its current option rather than handing it back (CoreFieldsPanel's v8 ignore).
    expect(screen.queryByRole('listbox', { name: 'Folders' })).toBeNull();
    expect(fileSpy).not.toHaveBeenCalled();
    expect(placementSpy).not.toHaveBeenCalled();
  });

  it('un-filing reads No folder while it saves, and leaves Parent as it is', async () => {
    let resolveFile!: (v: unknown) => void;
    fileSpy.mockReturnValue(new Promise((r) => (resolveFile = r)));
    renderFolder(filedDirectly);

    const listbox = await openFolder();
    await act(async () => {
      fireEvent.click(within(listbox).getByRole('option', { name: 'No folder' }));
    });

    expect(fileSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', folderId: null });
    expect(within(card('Folder')).getByText('No folder')).toBeTruthy();
    expect(within(card('Parent')).getByText('None')).toBeTruthy();

    await act(async () => {
      resolveFile({ ok: true, updatedAt: '2026-06-04T00:00:00.000Z' });
    });
    expect(placementSpy).toHaveBeenCalledWith('wi_1');
  });

  it('a refused filing reverts Folder AND Parent, toasts the reason, and reports nothing', async () => {
    const reason = 'That folder belongs to another project, so this work item stayed where it was.';
    fileSpy.mockResolvedValue({ ok: false, error: reason });
    renderFolder(inherited);

    const listbox = await openFolder();
    await act(async () => {
      fireEvent.click(within(listbox).getByRole('option', { name: 'Parked' }));
    });

    expect(toastSpy).toHaveBeenCalledWith({ variant: 'error', title: reason });
    expect(within(card('Folder')).getByText('Parked ▸ 2025')).toBeTruthy();
    expect(within(card('Folder')).getByText('Through PROD-12 Old import')).toBeTruthy();
    expect(within(card('Parent')).getByText('Old import')).toBeTruthy();
    expect(placementSpy).not.toHaveBeenCalled();
  });

  it('a Parent change reported through the channel makes the Folder read No folder', async () => {
    candidatesSpy.mockResolvedValue({ ok: true, candidates: [epic, otherEpic] });
    updateSpy.mockResolvedValue({ ok: true, updatedAt: '2026-06-04T00:00:00.000Z' });
    placementSpy.mockResolvedValue({ ok: true, placement: unfiled });
    renderFolder(inherited);
    expect(within(card('Folder')).getByText('Parked ▸ 2025')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Parent' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Parent' }));
    fireEvent.click(await screen.findByRole('option', { name: /Q3 launch/ }));
    await act(async () => {});

    expect(fileSpy).not.toHaveBeenCalled();
    expect(within(card('Folder')).getByText('No folder')).toBeTruthy();
  });

  it('a viewer without work_item:edit sees the value with no edit chevron', () => {
    renderFolder(filedDirectly, { readOnly: true });

    expect(within(card('Folder')).getByText('Parked ▸ 2025')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Folder' })).toBeNull();
  });

  it('renders no Folder card outside the page’s placement channel', () => {
    renderPanel();
    expect(screen.queryByText('Folder', { selector: 'div' })).toBeNull();
  });
});

const EDIT_HREF = '/items/PROD-7/edit';

describe('IssueExplanation', () => {
  it('renders the AI-drafted badge for an ai_draft explanation', () => {
    render(
      <IssueExplanation
        explanationMd="Because it matters."
        explanationSource="ai_draft"
        editHref={EDIT_HREF}
      />,
    );
    expect(screen.getByText('AI-drafted')).toBeTruthy();
    expect(screen.getByText('Because it matters.')).toBeTruthy();
  });

  it('omits the badge for a user_authored explanation', () => {
    render(
      <IssueExplanation
        explanationMd="Human-written rationale."
        explanationSource="user_authored"
        editHref={EDIT_HREF}
      />,
    );
    expect(screen.queryByText('AI-drafted')).toBeNull();
    expect(screen.getByText('Human-written rationale.')).toBeTruthy();
  });

  it('shows the always-present section with an empty state when there is no explanation', () => {
    render(
      <IssueExplanation
        explanationMd={null}
        explanationSource="user_authored"
        editHref={EDIT_HREF}
      />,
    );
    // The section header is always present; the body is the empty state.
    expect(screen.getByRole('heading', { name: 'Explanation' })).toBeTruthy();
    expect(screen.getByText('No explanation yet.')).toBeTruthy();
  });
});

// ── Sprint field (Subtask 2.4.14) ──────────────────────────────────────────
const sprintFixture = (over: Partial<SprintDto> = {}): SprintDto => ({
  id: 'sp',
  name: 'Sprint',
  goal: null,
  state: 'planned',
  startDate: null,
  endDate: null,
  completedAt: null,
  sequence: 1,
  issueCount: 0,
  committedPoints: null,
  committedIssueCount: null,
  ...over,
});

const sprints: SprintDto[] = [
  sprintFixture({ id: 'sp_active', name: 'Sprint 7', state: 'active', sequence: 7 }),
  sprintFixture({ id: 'sp_planned', name: 'Sprint 8', state: 'planned', sequence: 8 }),
  sprintFixture({ id: 'sp_done', name: 'Sprint 6', state: 'complete', sequence: 6 }),
];

function renderWithSprints(item = makeItem()) {
  return render(
    <CoreFieldsPanel
      item={item}
      members={members}
      workflow={workflow}
      parent={null}
      reporterIsSelf
      sprints={sprints}
    />,
  );
}

describe('CoreFieldsPanel — Sprint field (2.4.14)', () => {
  it('shows muted "Backlog" when an ACTIVE item is in no sprint', () => {
    renderWithSprints(makeItem({ sprintId: null, status: 'todo' }));
    expect(screen.getByText('Backlog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Sprint' })).toBeTruthy();
  });

  it('shows "None" (not "Backlog") for a DONE item with no sprint — done is excluded from the backlog', () => {
    renderWithSprints(makeItem({ sprintId: null, status: 'done' }));
    // The Parent card also renders "None", so scope to the Sprint field card
    // (its "Edit Sprint" toggle → header row → Card content wrapper).
    const sprintCard = screen.getByRole('button', { name: 'Edit Sprint' }).parentElement!
      .parentElement!;
    expect(within(sprintCard).getByText('None')).toBeTruthy();
    expect(within(sprintCard).queryByText('Backlog')).toBeNull();
  });

  it('shows the sprint name when committed to a sprint', () => {
    renderWithSprints(makeItem({ sprintId: 'sp_active' }));
    expect(screen.getByText('Sprint 7')).toBeTruthy();
  });

  it('marks a completed current sprint with "(completed)"', () => {
    renderWithSprints(makeItem({ sprintId: 'sp_done' }));
    expect(screen.getByText('Sprint 6')).toBeTruthy();
    expect(screen.getByText('(completed)')).toBeTruthy();
  });

  it('is HIDDEN for an epic (epics span sprints)', () => {
    renderWithSprints(makeItem({ kind: 'epic', sprintId: null }));
    expect(screen.queryByRole('button', { name: 'Edit Sprint' })).toBeNull();
  });

  it('commits a sprint pick through setWorkItemSprint (Backlog-first sentinel)', async () => {
    setSprintSpy.mockResolvedValue({
      updatedAt: '2026-06-17T10:00:00.000Z',
      sprintId: 'sp_active',
    });
    renderWithSprints(makeItem({ sprintId: null }));

    // The picker autoOpens on edit (no second click — that would toggle it shut).
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sprint' }));
    // Backlog sentinel is the first option; the active + planned sprints follow.
    expect(screen.getByRole('option', { name: 'Backlog' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Sprint 7/ }));

    expect(setSprintSpy).toHaveBeenCalledWith('wi_1', 'sp_active');

    // The action above resolves asynchronously; flush that pass so its
    // state update lands inside the test rather than after it.
    await act(async () => {});
  });

  it('clearing to Backlog commits null', async () => {
    setSprintSpy.mockResolvedValue({ updatedAt: '2026-06-17T10:00:00.000Z', sprintId: null });
    renderWithSprints(makeItem({ sprintId: 'sp_active' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit Sprint' }));
    fireEvent.click(screen.getByRole('option', { name: 'Backlog' }));

    expect(setSprintSpy).toHaveBeenCalledWith('wi_1', null);

    // The action above resolves asynchronously; flush that pass so its
    // state update lands inside the test rather than after it.
    await act(async () => {});
  });

  it('picker sentinel reads "None" (not "Backlog") for a done item', () => {
    renderWithSprints(makeItem({ sprintId: null, status: 'done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sprint' }));
    // The null sentinel mirrors the read value — "None", since a done item is
    // excluded from the backlog.
    expect(screen.getByRole('option', { name: 'None' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Backlog' })).toBeNull();
  });
});
