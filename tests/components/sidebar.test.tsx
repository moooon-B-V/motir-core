// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SidebarSection } from '@/components/ui/Sidebar';

// SidebarDrawer reads usePathname; stub it with a mutable pathname so the
// route-change auto-close can be driven from the test.
const nav = vi.hoisted(() => ({ pathname: '/issues' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const SECTIONS: SidebarSection[] = [
  {
    id: 'primary',
    items: [
      { icon: <span />, label: 'Dashboard', href: '/dashboard' },
      { icon: <span />, label: 'Work Items', href: '/issues', active: true },
      { icon: <span />, label: 'Boards', href: '/boards' },
    ],
  },
  {
    id: 'meta',
    items: [{ icon: <span />, label: 'Settings', href: '/settings' }],
  },
];

beforeEach(() => {
  nav.pathname = '/issues';
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => cleanup());

describe('Sidebar', () => {
  it('marks the active item with aria-current="page"', async () => {
    const { Sidebar } = await import('@/components/ui/Sidebar');
    render(<Sidebar collapsed={false} sections={SECTIONS} />);

    const issues = screen.getByRole('link', { name: 'Work Items' });
    expect(issues.getAttribute('aria-current')).toBe('page');

    const boards = screen.getByRole('link', { name: 'Boards' });
    expect(boards.getAttribute('aria-current')).toBeNull();
  });

  it('renders section labels and an inter-section divider when expanded', async () => {
    const { Sidebar } = await import('@/components/ui/Sidebar');
    const { container } = render(
      <Sidebar
        collapsed={false}
        sections={[
          { id: 'primary', label: 'Workspace', items: SECTIONS[0]!.items },
          { id: 'meta', label: 'More', items: SECTIONS[1]!.items },
        ]}
      />,
    );
    expect(screen.getByText('Workspace')).toBeTruthy();
    // One <hr> separates the two sections.
    expect(container.querySelectorAll('hr')).toHaveLength(1);
  });

  it('wraps each collapsed row in a Radix Tooltip trigger (icon-only mode)', async () => {
    const { Sidebar } = await import('@/components/ui/Sidebar');
    render(<Sidebar collapsed sections={SECTIONS} />);

    // The accessible name comes from aria-label (no visible text in collapsed
    // mode), and Radix's Tooltip.Trigger stamps data-state on the wrapped <a>.
    const issues = screen.getByRole('link', { name: 'Work Items' });
    expect(issues.getAttribute('data-state')).not.toBeNull();
    expect(issues.getAttribute('aria-current')).toBe('page');
  });

  it('does NOT wrap rows in a Tooltip trigger when expanded', async () => {
    const { Sidebar } = await import('@/components/ui/Sidebar');
    render(<Sidebar collapsed={false} sections={SECTIONS} />);
    const issues = screen.getByRole('link', { name: 'Work Items' });
    expect(issues.getAttribute('data-state')).toBeNull();
  });
});

describe('SidebarDrawer', () => {
  async function loadDrawer() {
    const { SidebarDrawer } = await import('@/components/ui/SidebarDrawer');
    const { SidebarToggle } = await import('@/components/ui/SidebarToggle');
    const { Sidebar } = await import('@/components/ui/Sidebar');
    function Harness() {
      return (
        <>
          <SidebarToggle variant="hamburger" />
          <SidebarDrawer header={<span>Acme Inc.</span>}>
            <Sidebar collapsed={false} sections={SECTIONS} />
          </SidebarDrawer>
        </>
      );
    }
    return { Harness };
  }

  it('opens on the hamburger trigger and closes on route change', async () => {
    nav.pathname = '/issues';
    const { Harness } = await loadDrawer();
    const { rerender } = render(<Harness />);

    // Closed: Radix renders nothing.
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Navigate: the auto-close effect fires when the pathname changes.
    act(() => {
      nav.pathname = '/boards';
      rerender(<Harness />);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', async () => {
    const { Harness } = await loadDrawer();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
