// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  TransferOwnershipControl,
  TRANSFER_PICKER_PAGE_SIZE,
} from '@/app/(authed)/settings/organization/_components/TransferOwnershipControl';
import type { OrgMemberDTO, OrgMemberPageDTO } from '@/lib/dto/organizations';

// The Owner's Transfer ownership button + dialog (MOTIR-6313, design MOTIR-6303
// panel 4, states 4a–4e). The two HTTP calls it makes — the roster page and the
// transfer — are the component's boundary, so `fetch` is stubbed per URL; the
// server half (the lock, the typed refusals) is MOTIR-6310's and tested there.

const refresh = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace, push: vi.fn() }) }));

function member(n: number, role: 'admin' | 'member' = 'member'): OrgMemberDTO {
  return { userId: `u${n}`, name: `Person ${n}`, email: `p${n}@acme.test`, role, workspaces: [] };
}

const MARA: OrgMemberDTO = {
  userId: 'mara',
  name: 'Mara Chen',
  email: 'mara@acme.test',
  role: 'admin',
  workspaces: [],
};

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(handler: Handler) {
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input), 'http://localhost'), init)),
  );
  vi.stubGlobal('fetch', fetchMock);
}

function page(members: OrgMemberDTO[], total = members.length, nextCursor: string | null = null) {
  return { members, total, nextCursor } satisfies OrgMemberPageDTO;
}

function renderControl(initialOpen = false) {
  return render(
    <ToastProvider>
      <TransferOwnershipControl orgId="org1" orgName="acme" initialOpen={initialOpen} />
    </ToastProvider>,
  );
}

function memberCalls(): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((u) => u.pathname.endsWith('/members'));
}

async function openAndPickMara() {
  fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership…' }));
  const radio = await screen.findByRole('radio', { name: /Mara Chen/ });
  fireEvent.click(radio);
  return radio;
}

function confirmButton() {
  return screen.getByRole('button', { name: 'Transfer ownership' });
}

beforeEach(() => {
  refresh.mockReset();
  replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TransferOwnershipControl', () => {
  it('opens on the button and reads the roster page Owner-less, five at a time', async () => {
    installFetch(() => json(page([MARA, member(2)], 2)));
    renderControl();
    expect(screen.queryByRole('dialog')).toBeNull();

    await openAndPickMara();

    const [first] = memberCalls();
    expect(first!.pathname).toBe('/api/organizations/org1/members');
    expect(first!.searchParams.get('excludeOwner')).toBe('1');
    expect(first!.searchParams.get('limit')).toBe(String(TRANSFER_PICKER_PAGE_SIZE));
    expect(screen.getByText('Showing 1–2 of 2 · the Owner is not listed')).toBeTruthy();
  });

  it('opens on arrival when the deep link asked for it', async () => {
    installFetch(() => json(page([MARA])));
    renderControl(true);
    // Named by the org it hands over, not the generic "Dialog" fallback
    // (MOTIR-6316 found the unnamed dialog from the E2E walk).
    expect(await screen.findByRole('dialog', { name: 'Transfer ownership of acme' })).toBeTruthy();
  });

  it('opens on arrival at #transfer-ownership, the roster Owner-row link (MOTIR-6311)', async () => {
    installFetch(() => json(page([MARA])));
    window.location.hash = '#transfer-ownership';
    try {
      renderControl();
      expect(await screen.findByRole('dialog')).toBeTruthy();
    } finally {
      window.location.hash = '';
    }
  });

  it('keeps the confirm disabled until a member is picked AND the name matches exactly', async () => {
    installFetch(() => json(page([MARA])));
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership…' }));
    await screen.findByRole('radio', { name: /Mara Chen/ });

    const nameField = screen.getByLabelText('Type acme to confirm');
    fireEvent.change(nameField, { target: { value: 'acme' } });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true); // nobody picked

    fireEvent.click(screen.getByRole('radio', { name: /Mara Chen/ }));
    expect(screen.getByText('Mara Chen becomes the Owner. You become an Admin.')).toBeTruthy();
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(nameField, { target: { value: 'Acme' } }); // case-sensitive
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('transfers, toasts, closes and REFRESHES so the page redraws as the Admin view', async () => {
    let transferBody: unknown = null;
    installFetch((url, init) => {
      if (url.pathname.endsWith('/ownership-transfer')) {
        transferBody = JSON.parse(String(init?.body));
        return json({ ok: true });
      }
      return json(page([MARA]));
    });
    renderControl();
    await openAndPickMara();
    fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: 'acme' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(transferBody).toEqual({ toUserId: 'mara', confirmName: 'acme' });
    expect(screen.getByText('Mara Chen is now the owner of acme. You’re an admin.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    [
      422,
      { code: 'INVALID_OWNERSHIP_TARGET', reason: 'not_member' },
      'Couldn’t transfer ownership. Mara Chen is no longer a member of acme. Nothing changed — pick someone else.',
    ],
    [
      409,
      { code: 'OWNERSHIP_CHANGED' },
      'Couldn’t transfer ownership. You are no longer the owner of acme — ownership changed while this was open. Nothing changed here.',
    ],
    [
      400,
      { code: 'OWNERSHIP_CONFIRMATION_MISMATCH' },
      'Couldn’t transfer ownership. The name you typed doesn’t match acme. Nothing changed — type it exactly.',
    ],
    [
      500,
      { code: 'INTERNAL' },
      'Couldn’t transfer ownership. Something went wrong and nothing changed — try again.',
    ],
  ])(
    'keeps the dialog open with its own message on a %i refusal',
    async (status, body, message) => {
      installFetch((url) =>
        url.pathname.endsWith('/ownership-transfer') ? json(body, status) : json(page([MARA])),
      );
      renderControl();
      await openAndPickMara();
      fireEvent.change(screen.getByLabelText('Type acme to confirm'), {
        target: { value: 'acme' },
      });
      await act(async () => {
        fireEvent.click(confirmButton());
      });

      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it('searches server-side and pages with the cursor it was handed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installFetch((url) => {
        if (url.searchParams.get('cursor') === 'c1') return json(page([member(6)], 6, null));
        return json(page([MARA, member(2), member(3), member(4), member(5)], 6, 'c1'));
      });
      renderControl();
      fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership…' }));
      await screen.findByRole('radio', { name: /Mara Chen/ });

      fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
      await screen.findByRole('radio', { name: /Person 6/ });
      expect(memberCalls().at(-1)!.searchParams.get('cursor')).toBe('c1');
      expect(screen.getByText('Showing 6–6 of 6 · the Owner is not listed')).toBeTruthy();

      fireEvent.change(screen.getByPlaceholderText('Search members by name or email'), {
        target: { value: 'mara' },
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      await waitFor(() => expect(memberCalls().at(-1)!.searchParams.get('q')).toBe('mara'));
      expect(memberCalls().at(-1)!.searchParams.get('cursor')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when nobody else is in the organization', async () => {
    installFetch(() => json(page([], 0)));
    renderControl(true);
    expect(
      await screen.findByText('No one else is in this organization yet. Invite someone first.'),
    ).toBeTruthy();
  });
});
