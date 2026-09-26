// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { OrgWorkspacePageDTO, OrgWorkspaceRowDTO } from '@/lib/dto/workspaces';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The org WORKSPACES card (MOTIR-6312 ·
// `design/org-admin/org-admin--workspaces-at-org-tier.mock.html` panel 1). The
// island pages through `GET /api/organizations/[orgId]/workspaces` and removes
// through `DELETE …/[workspaceId]` (MOTIR-6309); `fetch` is the boundary here,
// stubbed per test. After a mutation it refetches ITS page and `router.refresh()`es
// the server-rendered rest (the page-state contract's two halves).
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const { reconcileActiveWorkspaceAction, createWorkspaceAction, switchWorkspaceAction } = vi.hoisted(
  () => ({
    reconcileActiveWorkspaceAction: vi.fn(async () => ({ changed: true })),
    createWorkspaceAction: vi.fn(async () => ({ ok: true })),
    switchWorkspaceAction: vi.fn(async () => {}),
  }),
);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/settings/organization',
}));
vi.mock('@/app/(authed)/settings/organization/actions', () => ({
  reconcileActiveWorkspaceAction,
}));
vi.mock('@/app/(authed)/_actions', () => ({ createWorkspaceAction, switchWorkspaceAction }));

import { OrgWorkspacesCard } from '@/app/(authed)/settings/organization/_components/OrgWorkspacesCard';

const row = (id: string, name: string, members = 2, projects = 1): OrgWorkspaceRowDTO => ({
  id,
  name,
  slug: id,
  memberCount: members,
  projectCount: projects,
  createdAt: '2026-09-25T00:00:00.000Z',
  viewerIsMember: true,
});

const page = (rows: OrgWorkspaceRowDTO[], total = rows.length, nextCursor: string | null = null) =>
  ({ workspaces: rows, total, nextCursor }) satisfies OrgWorkspacePageDTO;

const fetchMock = vi.fn();

function renderCard(initialPage: OrgWorkspacePageDTO, activeWorkspaceId: string | null = null) {
  return render(
    <ToastProvider>
      <OrgWorkspacesCard
        orgId="org_acme"
        orgName="Acme"
        initialPage={initialPage}
        activeWorkspaceId={activeWorkspaceId}
      />
    </ToastProvider>,
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('the list', () => {
  it('draws each workspace with its counts and a Remove', () => {
    renderCard(page([row('w1', 'Motir', 11, 14), row('w2', 'Taq', 1, 1)]));
    expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByText('2 workspaces')).toBeTruthy();
    expect(screen.getByText('11 members · 14 projects')).toBeTruthy();
    expect(screen.getByText('1 member · 1 project')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Motir' })).toBeTruthy();
    // One page → no pager (the footer is omitted).
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('pages at the server page size: Next fetches with the cursor, Prev walks back', async () => {
    const first = page(
      Array.from({ length: 10 }, (_, i) => row(`w${i}`, `WS ${i}`)),
      12,
      'w9',
    );
    renderCard(first);
    expect(screen.getByText('Showing 1–10 of 12')).toBeTruthy();

    fetchMock.mockResolvedValueOnce(json(page([row('w10', 'WS 10'), row('w11', 'WS 11')], 12)));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('WS 11');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/organizations/org_acme/workspaces?limit=10&cursor=w9',
    );
    expect(screen.getByText('Showing 11–12 of 12')).toBeTruthy();

    fetchMock.mockResolvedValueOnce(json(first));
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    await screen.findByText('WS 0');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/organizations/org_acme/workspaces?limit=10');
  });

  it('1d · EMPTY — No workspaces yet, with a primary New workspace', () => {
    renderCard(page([]));
    expect(screen.getByText('No workspaces yet')).toBeTruthy();
    // The header's and the empty state's both open the same dialog.
    expect(screen.getAllByRole('button', { name: 'New workspace' })).toHaveLength(2);
  });

  it('1f · ERROR — a failed page fetch shows the error with Try again, which refetches', async () => {
    renderCard(
      page(
        Array.from({ length: 10 }, (_, i) => row(`w${i}`, `WS ${i}`)),
        12,
        'w9',
      ),
    );
    fetchMock.mockResolvedValueOnce(json({ code: 'BOOM' }, 500));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Couldn’t load workspaces');

    fetchMock.mockResolvedValueOnce(json(page([row('w10', 'WS 10')], 11)));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByText('WS 10');
  });
});

describe('Remove (1g)', () => {
  async function openRemove(name: string) {
    fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    return screen.findByRole('dialog');
  }

  it('unlocks only on the exact, case-sensitive name, and states what goes', async () => {
    renderCard(page([row('w1', 'Motir', 3, 2), row('w2', 'Taq')]));
    await openRemove('Motir');
    expect(
      screen.getByText(/2 projects with their work items, sprints and boards\. Its 3 members lose/),
    ).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Remove workspace' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type Motir to confirm'), {
      target: { value: 'motir' },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type Motir to confirm'), {
      target: { value: 'Motir' },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    // Not the org's last workspace → no yellow note.
    expect(screen.queryByTestId('remove-last-workspace-note')).toBeNull();
  });

  it('removes through DELETE, drops the row, refetches its page and refreshes the server counts', async () => {
    renderCard(page([row('w1', 'Motir'), row('w2', 'Taq')]));
    await openRemove('Motir');
    fireEvent.change(screen.getByLabelText('Type Motir to confirm'), {
      target: { value: 'Motir' },
    });
    fetchMock
      .mockResolvedValueOnce(json({ ok: true })) // the DELETE
      .mockResolvedValueOnce(json(page([row('w2', 'Taq')]))); // the page refetch
    fireEvent.click(screen.getByRole('button', { name: 'Remove workspace' }));

    await screen.findByText('Motir removed');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/organizations/org_acme/workspaces/w1', {
      method: 'DELETE',
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/organizations/org_acme/workspaces?limit=10'),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText('Motir', { selector: 'span' })).toBeNull();
    // Not the active workspace → no re-point, no navigation.
    expect(reconcileActiveWorkspaceAction).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('removing the ACTIVE workspace re-points the active one the way a switch does', async () => {
    renderCard(page([row('w1', 'Motir'), row('w2', 'Taq')]), 'w1');
    await openRemove('Motir');
    fireEvent.change(screen.getByLabelText('Type Motir to confirm'), {
      target: { value: 'Motir' },
    });
    fetchMock
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json(page([row('w2', 'Taq')])));
    fireEvent.click(screen.getByRole('button', { name: 'Remove workspace' }));

    await waitFor(() => expect(reconcileActiveWorkspaceAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith(AUTHED_LANDING_PATH));
  });

  it('the org’s LAST workspace is allowed and SAID — the yellow note, not a refusal', async () => {
    renderCard(page([row('w1', 'Solo')]));
    await openRemove('Solo');
    expect(screen.getByTestId('remove-last-workspace-note').textContent).toContain(
      'This is Acme’s only workspace',
    );
    fireEvent.change(screen.getByLabelText('Type Solo to confirm'), { target: { value: 'Solo' } });
    expect(
      (screen.getByRole('button', { name: 'Remove workspace' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('a refused DELETE keeps the row and toasts the server’s reason', async () => {
    renderCard(page([row('w1', 'Motir'), row('w2', 'Taq')]));
    await openRemove('Motir');
    fireEvent.change(screen.getByLabelText('Type Motir to confirm'), {
      target: { value: 'Motir' },
    });
    fetchMock.mockResolvedValueOnce(json({ code: 'ORG_FORBIDDEN', error: 'Not allowed' }, 403));
    fireEvent.click(screen.getByRole('button', { name: 'Remove workspace' }));

    await screen.findByText('Couldn’t remove Motir');
    expect(refresh).not.toHaveBeenCalled();
    // Nothing was removed: the dialog stays open over the unchanged list.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('New workspace', () => {
  it('opens the shared create dialog; a create refetches the list and refreshes the server', async () => {
    renderCard(page([row('w1', 'Motir')]));
    fireEvent.click(screen.getByRole('button', { name: 'New workspace' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('New workspace');
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Beacon' } });
    fetchMock.mockResolvedValueOnce(json(page([row('w0', 'Beacon'), row('w1', 'Motir')])));
    fireEvent.submit(screen.getByLabelText('Workspace name').closest('form')!);

    await waitFor(() => expect(createWorkspaceAction).toHaveBeenCalledWith('Beacon'));
    await screen.findByText('Beacon');
    expect(refresh).toHaveBeenCalled();
  });
});

describe('every workspace opens for an org Owner / Admin (MOTIR-6456 panel 6b)', () => {
  it('a workspace the viewer is not on the roster of says “Manager · via organization”', () => {
    renderCard(
      page([row('ws_a', 'Sales'), { ...row('ws_b', 'Development'), viewerIsMember: false }]),
    );
    expect(screen.getAllByText('Manager · via organization')).toHaveLength(1);
  });

  it('Open switches to the workspace and lands on its settings, writing nothing to its roster', async () => {
    renderCard(page([{ ...row('ws_b', 'Development'), viewerIsMember: false }]));
    fireEvent.click(screen.getByRole('button', { name: 'Open Development' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/settings/workspace'));
    expect(switchWorkspaceAction).toHaveBeenCalledWith('ws_b');
  });
});
