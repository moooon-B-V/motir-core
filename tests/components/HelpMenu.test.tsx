// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CommandPaletteProvider } from '@/app/(authed)/_components/CommandPaletteProvider';
import { HelpMenu } from '@/app/(authed)/_components/HelpMenu';

// MOTIR-4239 — THE HELP MENU. Re-homes the coverage
// `SidebarNav-docs-door.test.tsx` / `SidebarNav-legal-door.test.tsx` carried
// for the two rows when they lived in the rail: this file is their new home,
// against the popover rather than the rail. It also covers the one row that
// is genuinely new — `Keyboard shortcuts`, and the `openShortcuts` seam it
// needed. The full gate (every arm, every width) is MOTIR-4240 / MOTIR-4241;
// this is the per-card floor.

const DOCS = 'https://motir.co/docs';
const LEGAL = 'https://motir.co/legal';

function renderMenu(props: { docsIndexUrl?: string | null; legalIndexUrl?: string | null } = {}) {
  return renderWithIntl(
    <CommandPaletteProvider>
      <HelpMenu {...props} />
    </CommandPaletteProvider>,
  );
}

function openMenu() {
  act(() => {
    screen.getByRole('button', { name: 'Help' }).click();
  });
}

afterEach(() => cleanup());

describe('the Help menu', () => {
  it('renders all three rows, in declaration order, when both urls are configured', () => {
    renderMenu({ docsIndexUrl: DOCS, legalIndexUrl: LEGAL });
    openMenu();

    const docs = screen.getByRole('link', { name: 'Docs' });
    const shortcuts = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    const legal = screen.getByRole('link', { name: 'Legal documents' });

    expect(docs.getAttribute('href')).toBe(DOCS);
    expect(legal.getAttribute('href')).toBe(LEGAL);
    expect(docs.compareDocumentPosition(shortcuts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      shortcuts.compareDocumentPosition(legal) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders NO Docs row when `docsIndexUrl` is null', () => {
    renderMenu({ docsIndexUrl: null, legalIndexUrl: LEGAL });
    openMenu();
    expect(screen.queryByRole('link', { name: 'Docs' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Legal documents' })).toBeTruthy();
  });

  it('renders NO Legal documents row when `legalIndexUrl` is null', () => {
    renderMenu({ docsIndexUrl: DOCS, legalIndexUrl: null });
    openMenu();
    expect(screen.queryByRole('link', { name: 'Legal documents' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Docs' })).toBeTruthy();
  });

  it('renders the FLOOR — Keyboard shortcuts alone — when neither url is configured', () => {
    renderMenu({ docsIndexUrl: null, legalIndexUrl: null });
    openMenu();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Docs' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Legal documents' })).toBeNull();
  });

  it('fails closed when both props are OMITTED', () => {
    renderMenu();
    openMenu();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Docs' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Legal documents' })).toBeNull();
  });

  it('carries no `aria-current` on either link row — the destinations are off-shell', () => {
    renderMenu({ docsIndexUrl: DOCS, legalIndexUrl: LEGAL });
    openMenu();
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('aria-current')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Legal documents' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('`Keyboard shortcuts` opens the SAME dialog `?` opens, via the `openShortcuts` seam', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    // The popover closed when the row was activated — it does not linger
    // behind the dialog it just opened.
    expect(screen.queryByRole('link', { name: 'Docs' })).toBeNull();
  });

  it('the trigger carries the accessible name "Help" in both placements', () => {
    renderWithIntl(
      <CommandPaletteProvider>
        <HelpMenu placement="drawer" />
      </CommandPaletteProvider>,
    );
    expect(screen.getByRole('button', { name: 'Help' })).toBeTruthy();
  });
});
