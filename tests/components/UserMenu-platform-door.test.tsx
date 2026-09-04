// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { UserMenu } from '@/app/(authed)/_components/UserMenu';

// The DOOR into the operator console (MOTIR-2896 · design
// `platform-admin/console.mock.html` Panel 1).
//
// The design draws the entrance, not just the room, and the asset states the
// rule beside it: for a normal user the item is *"simply absent"*, and `/admin`
// 404s. Both halves have to hold or neither is worth anything — a 404 that a
// menu row advertises is a 404 that tells you where to look.
//
// So the assertion for the non-staff case is about the MARKUP, not about
// visibility: `queryByRole` would also pass for a row rendered with `hidden`,
// and the posture this protects is that nothing in a tenant's page names the
// route at all.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));

afterEach(cleanup);

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
}

describe('the account menu for a NON-staff user', () => {
  it('renders no "Platform admin" row', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();

    expect(screen.queryByText('Platform admin')).toBeNull();
    expect(screen.queryByText('Staff only')).toBeNull();
  });

  it('leaves no /admin reference anywhere in the rendered markup', () => {
    const { container } = renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();

    // The whole document, because the menu renders through a portal.
    expect(document.body.innerHTML).not.toContain('/admin');
    expect(container.innerHTML).not.toContain('/admin');
  });

  it('is the DEFAULT — omitting the prop renders no door', () => {
    // `platformStaff` is optional and defaults to `false` on purpose: the
    // omission has to fail closed, because the failure mode of the other default
    // is a staff-only route named in every tenant's markup.
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    expect(screen.queryByText('Platform admin')).toBeNull();
  });
});

describe('the account menu for a PLATFORM-STAFF user', () => {
  it('renders the staff-only row, pointing at /admin', () => {
    renderWithIntl(<UserMenu name="Ops" email="ops@moooon.net" platformStaff />);
    openMenu();

    const row = screen.getByRole('link', { name: /platform admin/i });
    expect(row).toHaveProperty('pathname', '/admin');
    expect(screen.getByText('Staff only')).toBeTruthy();
    // The asset's sub-label — the row says what the console IS, so the door is
    // not just a word.
    expect(screen.getByText('Operator console · the whole estate')).toBeTruthy();
  });

  it('keeps the ordinary rows — the door is added, never a substitution', () => {
    // `workspaceTierRevealed` is passed explicitly because the Workspace
    // settings row became conditional in MOTIR-3502 and now defaults to hidden.
    // This case is about the staff door not DISPLACING the ordinary rows, so it
    // asks for the menu in the state where all of them exist; the tier rule
    // itself is covered by `workspace-tier-entry-points.test.tsx`.
    renderWithIntl(
      <UserMenu name="Ops" email="ops@moooon.net" platformStaff workspaceTierRevealed />,
    );
    openMenu();

    expect(screen.getByRole('link', { name: /account settings/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /workspace settings/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
  });

  it('opens the panel at the 336px the staff row is derived to need', () => {
    // ⚠️ THIS PINS A NUMBER; IT DOES NOT MEASURE THE WRAP. happy-dom has no
    // layout engine, so nothing here can see a hint line take two rows — which
    // is exactly how MOTIR-4270 shipped: `width={240}` was correct for 1.2.6's
    // one-line rows, MOTIR-2896 added this row's hint + pill, and the width was
    // never re-derived, so the hint wrapped for every staff user (a 68px row
    // where `design/shell/account-menu.mock.html` draws 52px).
    //
    // The number's derivation lives in the comment beside the prop. What this
    // test buys is that the constant cannot be quietly rounded back down — a
    // real one-line assertion needs a browser AND Inter loaded, because the
    // fallback face needs only 320px and would pass a wrong value.
    renderWithIntl(<UserMenu name="Ops" email="ops@moooon.net" platformStaff />);
    openMenu();

    const panel = document.querySelector('[data-surface="popover"]');
    expect(panel).not.toBeNull();
    expect((panel as HTMLElement).style.width).toBe('336px');
  });
});
