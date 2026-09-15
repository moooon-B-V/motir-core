// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// The Bugs room's DESTINATION card (Story MOTIR-4927 · Subtask MOTIR-4938), built
// to `design/projects/bug-destination.mock.html` panels 0–3. The toast and `fetch`
// are the stubs; the write door itself is proven over the real stack in
// tests/settings/bug-destination-route.test.ts.
const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

import {
  BugDestinationRoom,
  draftFor,
} from '@/app/(authed)/settings/project/bugs/_components/BugDestinationRoom';
import type { FolderPickerNodeDto } from '@/lib/dto/folders';
import type { BugDestinationDto } from '@/lib/dto/projects';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const bugs = { id: 'f-bugs', name: 'Bugs', path: ['Bugs'] };
const triage = { id: 'f-triage', name: 'Triage', path: ['Bugs', 'Triage'] };
const folders: FolderPickerNodeDto[] = [
  { id: 'f-bugs', parentFolderId: null, name: 'Bugs', position: 'a0', path: ['Bugs'] },
  {
    id: 'f-triage',
    parentFolderId: 'f-bugs',
    name: 'Triage',
    position: 'a0',
    path: ['Bugs', 'Triage'],
  },
  { id: 'f-later', parentFolderId: null, name: 'Later', position: 'a1', path: ['Later'] },
];

function renderRoom(initial: BugDestinationDto = { folder: bugs, bugsFolder: bugs }) {
  return render(
    <BugDestinationRoom projectKey="MOTIR" initial={initial} folders={folders} truncated={false} />,
  );
}

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
}

const radio = (name: RegExp) => screen.getByRole('radio', { name });
const checked = (name: RegExp) => radio(name).getAttribute('aria-checked') === 'true';
const saveButton = () => screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe('BugDestinationRoom', () => {
  it('opens on the seeded Bugs folder: the first choice is checked, the folder is named with an Open link, nothing to save', () => {
    renderRoom();

    expect(checked(/This project's Bugs folder/)).toBe(true);
    expect(checked(/Another folder/)).toBe(false);
    expect(checked(/Project root/)).toBe(false);
    const open = screen.getByRole('link', { name: 'Open Bugs' });
    expect(open.getAttribute('href')).toMatch(/^\/items\?filter=v1/);
    expect(saveButton().disabled).toBe(true);
  });

  it('choosing Project root and saving writes null, renders the response, and toasts the consequence', async () => {
    renderRoom();

    await click(radio(/Project root/));
    expect(checked(/Project root/)).toBe(true);
    expect(saveButton().disabled).toBe(false);

    respond(200, { folder: null, bugsFolder: bugs });
    await click(saveButton());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/MOTIR/bug-destination',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ folderId: null }) }),
    );
    expect(mocks.toast).toHaveBeenCalledWith({
      variant: 'success',
      title: 'Bug destination saved',
      description: 'New bugs will be filed at the project root.',
    });
    expect(checked(/Project root/)).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('Another folder opens the shipped folder picker; picking a folder makes the card dirty and saves its id', async () => {
    renderRoom();

    await click(radio(/Another folder/));
    expect(screen.getByRole('option', { name: /Later/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Bugs/ }).getAttribute('aria-selected')).toBe('true');
    await click(screen.getByRole('option', { name: /Triage/ }));

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(checked(/Another folder/)).toBe(true);
    expect(screen.getByText('Bugs ▸ Triage')).toBeTruthy();

    respond(200, { folder: triage, bugsFolder: bugs });
    await click(saveButton());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/MOTIR/bug-destination',
      expect.objectContaining({ body: JSON.stringify({ folderId: 'f-triage' }) }),
    );
    expect(mocks.toast).toHaveBeenCalledWith({
      variant: 'success',
      title: 'Bug destination saved',
      description: 'New bugs will be filed into Bugs ▸ Triage.',
    });
    expect(saveButton().disabled).toBe(true);
  });

  it('the picker’s root option selects the third choice', async () => {
    renderRoom();

    await click(radio(/Another folder/));
    await click(screen.getByRole('option', { name: /Project root/ }));

    expect(checked(/Project root/)).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a refused save keeps the choice, stays dirty, and says why', async () => {
    renderRoom();
    await click(radio(/Project root/));

    respond(403, { code: 'NOT_PROJECT_ADMIN' });
    await click(saveButton());

    expect(mocks.toast).toHaveBeenCalledWith({
      variant: 'error',
      title: 'Bug destination not saved',
      description: "You can no longer change where this project's bugs are filed.",
    });
    expect(checked(/Project root/)).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });

  it('Cancel puts the stored choice back', async () => {
    renderRoom();
    await click(radio(/Project root/));

    await click(screen.getByRole('button', { name: 'Cancel' }));

    expect(checked(/This project's Bugs folder/)).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('reads a stored pointer as the choice that names it', () => {
    expect(draftFor({ folder: null, bugsFolder: bugs })).toEqual({
      choice: 'root',
      folderId: null,
      path: null,
    });
    expect(draftFor({ folder: bugs, bugsFolder: bugs }).choice).toBe('bugs');
    expect(draftFor({ folder: triage, bugsFolder: bugs })).toEqual({
      choice: 'another',
      folderId: 'f-triage',
      path: ['Bugs', 'Triage'],
    });
    // A project with no folder called Bugs still names its destination.
    expect(draftFor({ folder: triage, bugsFolder: null }).choice).toBe('another');
  });
});
