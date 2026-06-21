// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SidebarSection } from '@/components/ui/Sidebar';

// AppLayout composes SidebarDrawer indirectly only through consumers, but the
// Sidebar tree pulls in nothing from next/navigation. We still stub it so any
// transitive import is satisfied and stays inert here.
const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const SECTIONS: SidebarSection[] = [
  {
    id: 'primary',
    items: [
      { icon: <span />, label: 'Dashboard', href: '/dashboard' },
      { icon: <span />, label: 'Work Items', href: '/items', active: true },
    ],
  },
];

const STORAGE_KEY = 'motir.shell.sidebar.collapsed';

/** Re-import the shell modules fresh so each test gets a pristine store. */
async function loadShell() {
  const { AppLayout } = await import('@/components/ui/AppLayout');
  const { Sidebar } = await import('@/components/ui/Sidebar');
  const { SidebarToggle } = await import('@/components/ui/SidebarToggle');
  function Shell({ children = 'Main content' }: { children?: ReactNode }) {
    return (
      <AppLayout
        topNav={<div data-testid="topnav">nav</div>}
        sidebar={<Sidebar sections={SECTIONS} footer={<SidebarToggle variant="footer" />} />}
      >
        {children}
      </AppLayout>
    );
  }
  return { Shell };
}

beforeEach(() => {
  nav.pathname = '/';
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => cleanup());

describe('AppLayout', () => {
  it('renders a skip-link whose target #main is present and focusable', async () => {
    const { Shell } = await loadShell();
    render(<Shell />);

    const link = screen.getByRole('link', { name: 'Skip to content' });
    expect(link.getAttribute('href')).toBe('#main');

    const main = document.getElementById('main');
    expect(main?.tagName).toBe('MAIN');
    // tabIndex=-1 makes the landmark a programmatic focus target for the link.
    expect(main?.getAttribute('tabindex')).toBe('-1');
    main?.focus();
    expect(document.activeElement).toBe(main);
  });

  it('toggles the rail on Mod+\\ (⌘/Ctrl)', async () => {
    const { Shell } = await loadShell();
    render(<Shell />);

    const railOf = () => screen.getByRole('navigation');
    expect(railOf().getAttribute('data-collapsed')).toBeNull();

    // Send both modifiers so the assertion is platform-agnostic (the hook
    // reads metaKey on Mac, ctrlKey elsewhere).
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, metaKey: true, bubbles: true }),
      );
    });
    expect(railOf().getAttribute('data-collapsed')).toBe('true');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, metaKey: true, bubbles: true }),
      );
    });
    expect(railOf().getAttribute('data-collapsed')).toBeNull();
  });

  it('persists collapse across an unmount + fresh remount', async () => {
    const first = await loadShell();
    const { unmount } = render(<first.Shell />);

    // Expanded → the footer toggle is labelled "Collapse sidebar".
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
    unmount();
    cleanup();

    // Simulate a brand-new page load: drop the in-memory store, re-import so it
    // re-reads localStorage via its lazy initializer.
    vi.resetModules();
    const second = await loadShell();
    render(<second.Shell />);

    expect(screen.getByRole('navigation').getAttribute('data-collapsed')).toBe('true');
    // Collapsed → the same control now offers to expand.
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });
});
