// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SidebarSection } from '@/components/ui/Sidebar';

// SidebarDrawer reads usePathname; stub it with a mutable pathname so the
// route-change auto-close can be driven from the test.
const nav = vi.hoisted(() => ({ pathname: '/items' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const SECTIONS: SidebarSection[] = [
  {
    id: 'primary',
    items: [
      { icon: <span />, label: 'Dashboard', href: '/dashboard' },
      { icon: <span />, label: 'Work Items', href: '/items', active: true },
      { icon: <span />, label: 'Boards', href: '/boards' },
    ],
  },
  {
    id: 'meta',
    items: [{ icon: <span />, label: 'Settings', href: '/settings' }],
  },
];

beforeEach(() => {
  nav.pathname = '/items';
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
    // One separator between the two sections. It MUST be a div.border-t (role
    // separator), NOT an <hr>: the Hand-Drawn style roughens dividers via an
    // `::after` overlay, which Chromium never renders on <hr> — so an <hr>
    // splitter stays machine-straight under that style (MOTIR-1315). The div
    // carries the border-t the rough rule targets.
    expect(container.querySelectorAll('hr')).toHaveLength(0);
    const separators = container.querySelectorAll('[role="separator"]');
    expect(separators).toHaveLength(1);
    expect(separators[0]!.className).toContain('border-t');
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
    nav.pathname = '/items';
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

  // ⚠️ THIS ASSERTION'S *MEANING* CHANGED WITH MOTIR-4326, and the change is the
  // point rather than a fixture repair. It used to press the key by calling
  // `window.dispatchEvent`, which reaches `window` listeners and NOTHING else —
  // an event dispatched on `window` never propagates down through `document`. So
  // the only handler it could ever have exercised was the drawer's own
  // `useShortcut('esc', …)` window listener, i.e. exactly the listener that was
  // the defect. Radix's handler is a `document` CAPTURE listener and was
  // invisible to it, which is why a test named "closes on Escape" stayed green
  // while `Escape` was closing two surfaces at once in the browser.
  //
  // A real key press targets the focused element and passes through `document`
  // in both phases, so that is what these dispatch now: from inside the panel.
  it('closes on Escape (dispatched the way a real key press arrives)', async () => {
    const { Harness } = await loadDrawer();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });

    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });

  // The `whenInputFocused: true` the removed shortcut carried, held as a
  // behaviour rather than as an option: `Escape` must still close the drawer
  // while a field INSIDE it has focus. Radix covers it for a reason that is
  // structural rather than incidental — its listener is on `document` in the
  // CAPTURE phase, so it runs before the focused field is reached at all.
  it('closes on Escape while a field inside it is focused', async () => {
    const { SidebarDrawer } = await import('@/components/ui/SidebarDrawer');
    const { SidebarToggle } = await import('@/components/ui/SidebarToggle');
    function Harness() {
      return (
        <>
          <SidebarToggle variant="hamburger" />
          <SidebarDrawer header={<input aria-label="Search" />}>
            <span>body</span>
          </SidebarDrawer>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();

    const field = screen.getByRole('textbox', { name: 'Search' }) as HTMLInputElement;
    field.focus();
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });

  // MOTIR-4326 — the LAYERING, at the tier that can afford to run on every PR.
  //
  // The card's own acceptance criterion asks for a browser-level reproduction
  // (`tests/e2e/shell-keyboard.spec.ts`), because a component test of EITHER
  // surface alone cannot see this. This one mounts BOTH, which is the composition
  // the defect lives in: a dismissable layer opened from the drawer's utility
  // strip, with the drawer under it. Before the fix the first `Escape` took both.
  it('peels one surface at a time — a layer opened inside it takes the first Escape', async () => {
    const { SidebarDrawer } = await import('@/components/ui/SidebarDrawer');
    const { SidebarToggle } = await import('@/components/ui/SidebarToggle');
    const { Popover } = await import('@/components/ui/Popover');

    function Harness() {
      const [menuOpen, setMenuOpen] = useState(false);
      return (
        <>
          <SidebarToggle variant="hamburger" />
          <SidebarDrawer
            footer={
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <Popover.Trigger asChild>
                  <button type="button" aria-label="Help" />
                </Popover.Trigger>
                <Popover.Content aria-label="Help">
                  <span>rows</span>
                </Popover.Content>
              </Popover>
            }
          >
            <span>body</span>
          </SidebarDrawer>
        </>
      );
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });

    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    const menu = screen.getByRole('dialog', { name: 'Help' });

    // ONE Escape peels the MENU only. The drawer is still standing, and the
    // strip that opened the menu is still reachable — asserted through the
    // trigger rather than through the panel, because "the drawer is gone" and
    // "the menu closed" are otherwise the same missing element.
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBe(drawer);
    expect(screen.getByRole('button', { name: 'Help' })).toBeTruthy();

    // The SECOND Escape closes the drawer — the behaviour that was traded away
    // if the fix had simply stopped the drawer listening.
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });
});
