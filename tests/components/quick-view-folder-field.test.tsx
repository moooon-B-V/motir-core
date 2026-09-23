// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// The quick view's FOLDER field (Story MOTIR-5308 · MOTIR-5316): the value it
// shows, the note before a filing clears a work-item parent, the write through
// the rail's own optimistic path, the placement report to the tree, the refused
// revert, and the read-only row. Server Actions are stubbed at their boundary;
// `fileWorkItemAction` is proven on real Postgres in
// tests/integration/folders/fileWorkItemAction.test.ts.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams('peek=PROD-7'),
}));

const mocks = vi.hoisted(() => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
  fileWorkItemAction: vi.fn(),
  setWorkItemSprint: vi.fn(),
  listCandidateParentsAction: vi.fn(),
  listProjectFoldersAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: mocks.updateIssueAction,
  changeStatusAction: mocks.changeStatusAction,
  fileWorkItemAction: mocks.fileWorkItemAction,
}));
vi.mock('@/components/issues/actions/workItemActionsClient', () => ({
  setWorkItemSprint: mocks.setWorkItemSprint,
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  listCandidateParentsAction: mocks.listCandidateParentsAction,
  listProjectFoldersAction: mocks.listProjectFoldersAction,
}));
vi.mock('@/app/(authed)/items/[key]/labelComponentActions', () => ({
  addLabelAction: vi.fn(),
  removeLabelAction: vi.fn(),
  addComponentAction: vi.fn(),
  removeComponentAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/customFieldActions', () => ({
  setCustomFieldValueAction: vi.fn(),
}));

import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import {
  FolderCommandsProvider,
  useFolderCommands,
  type WorkItemPlacement,
} from '@/app/(authed)/items/_components/FolderCommands';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';

function status(key: string, label: string, category: WorkflowStatusDto['category']) {
  return {
    id: `st_${key}`,
    projectId: 'p1',
    key,
    label,
    category,
    color: null,
    position: key,
    isInitial: key === 'todo',
  };
}

function data(over: Partial<QuickViewData> = {}): QuickViewData {
  return {
    folderId: null,
    folderPath: [],
    id: 'wi_7',
    identifier: 'PROD-7',
    title: 'Email + password sign-in',
    projectIdentifier: 'PROD',
    workItemRefs: {},
    kind: 'story',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    descriptionMd: null,
    explanationMd: null,
    type: null,
    executor: null,
    difficulty: null,
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
    deliveries: [],
    hasChildren: false,
    canPlan: true,
    status: 'todo',
    assigneeId: null,
    parentId: null,
    sprintId: null,
    dueDate: null,
    estimateMinutes: null,
    workflow: {
      statuses: [status('todo', 'To Do', 'todo'), status('done', 'Done', 'done')],
      transitions: [],
      policyMode: 'open',
    },
    members: [],
    sprints: [],
    projectComponents: [],
    estimation: {
      estimationStatistic: 'story_points' as const,
      pointScale: 'fibonacci' as const,
      customScaleValues: [],
      canEdit: true,
    },
    ...over,
  };
}

const FOLDERS = {
  ok: true,
  data: {
    truncated: false,
    folders: [
      { id: 'later', parentFolderId: null, name: 'Later', position: 'a0', path: ['Later'] },
      {
        id: 'y2025',
        parentFolderId: 'later',
        name: '2025',
        position: 'a0',
        path: ['Later', '2025'],
      },
    ],
  },
};

/** Registers a placement handler, as the tree does, so the report can be observed. */
function PlacementSpy({ onReport }: { onReport: (p: WorkItemPlacement) => void }) {
  const commands = useFolderCommands();
  useEffect(() => {
    commands!.registerPlacementHandler(onReport);
    return () => commands!.registerPlacementHandler(null);
  }, [commands, onReport]);
  return null;
}

function renderPanel(view: QuickViewData, { readOnly = false } = {}) {
  const onReport = vi.fn();
  const panel = (
    <FolderCommandsProvider>
      <PlacementSpy onReport={onReport} />
      <IssueQuickViewPanel state="ready" data={view} />
    </FolderCommandsProvider>
  );
  render(
    readOnly ? <ProjectAccessProvider permissions={[]}>{panel}</ProjectAccessProvider> : panel,
  );
  return { onReport };
}

/** The rail row whose caption is `label`. */
function row(label: string) {
  return screen.getByText(label, { selector: 'dt' }).parentElement as HTMLElement;
}

async function openFolder() {
  await act(async () => {
    fireEvent.click(within(row('Folder')).getByRole('button', { name: 'Edit Folder' }));
  });
  return screen.findByRole('listbox', { name: 'Folders' });
}

beforeEach(() => {
  mocks.listProjectFoldersAction.mockResolvedValue(FOLDERS);
  mocks.listCandidateParentsAction.mockResolvedValue({ ok: true, candidates: [] });
  mocks.fileWorkItemAction.mockResolvedValue({ ok: true, updatedAt: '2026-06-11T00:00:00.000Z' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the quick view’s Folder field', () => {
  it('reads the folder path, and No folder when the item is not filed', () => {
    renderPanel(data({ folderId: 'y2025', folderPath: ['Later', '2025'] }));
    expect(within(row('Folder')).getByText('Later ▸ 2025')).toBeTruthy();
    cleanup();

    renderPanel(data());
    expect(within(row('Folder')).getByText('No folder')).toBeTruthy();
  });

  it('says, before any save, that filing removes the item from its work-item parent', async () => {
    renderPanel(
      data({
        parentId: 'wi_epic',
        parent: { identifier: 'PROD-2', title: 'Auth', kind: 'epic' },
      }),
    );

    await openFolder();

    expect(within(row('Folder')).getByText('Filing it removes it from PROD-2 Auth.')).toBeTruthy();
    expect(mocks.fileWorkItemAction).not.toHaveBeenCalled();
  });

  it('picking a folder files the item once, shows the path, clears Parent, and reports the placement', async () => {
    const { onReport } = renderPanel(
      data({
        parentId: 'wi_epic',
        parent: { identifier: 'PROD-2', title: 'Auth', kind: 'epic' },
      }),
    );

    const listbox = await openFolder();
    await act(async () => {
      fireEvent.click(within(listbox).getByRole('option', { name: '2025' }));
    });

    expect(mocks.fileWorkItemAction).toHaveBeenCalledTimes(1);
    expect(mocks.fileWorkItemAction).toHaveBeenCalledWith({
      workItemId: 'wi_7',
      folderId: 'y2025',
    });
    await waitFor(() => expect(within(row('Folder')).getByText('Later ▸ 2025')).toBeTruthy());
    expect(within(row('Parent')).queryByText('Auth')).toBeNull();
    await waitFor(() => expect(onReport).toHaveBeenCalledTimes(1));
    expect(onReport).toHaveBeenCalledWith({
      workItemId: 'wi_7',
      folderId: 'y2025',
      parentId: null,
    });
  });

  it('picking the folder the item is already in writes nothing', async () => {
    const { onReport } = renderPanel(data({ folderId: 'later', folderPath: ['Later'] }));

    const listbox = await openFolder();
    const current = within(listbox)
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')!;
    expect(current.textContent).toContain('Later');
    await act(async () => {
      fireEvent.click(current);
    });

    expect(mocks.fileWorkItemAction).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
  });

  it('a refused save reverts the value and puts the reason on the row', async () => {
    mocks.fileWorkItemAction.mockResolvedValue({
      ok: false,
      error: 'That folder belongs to another project, so this work item stayed where it was.',
    });
    const { onReport } = renderPanel(data());

    const listbox = await openFolder();
    await act(async () => {
      fireEvent.click(within(listbox).getByRole('option', { name: 'Later' }));
    });

    await waitFor(() =>
      expect(
        within(row('Folder')).getByText(
          'That folder belongs to another project, so this work item stayed where it was.',
        ),
      ).toBeTruthy(),
    );
    expect(within(row('Folder')).getByText('No folder')).toBeTruthy();
    expect(onReport).not.toHaveBeenCalled();
  });

  it('a viewer without work_item:edit sees the value with no edit chevron', () => {
    renderPanel(data({ folderId: 'later', folderPath: ['Later'] }), { readOnly: true });

    expect(within(row('Folder')).getByText('Later')).toBeTruthy();
    expect(within(row('Folder')).queryByRole('button', { name: 'Edit Folder' })).toBeNull();
  });
});
