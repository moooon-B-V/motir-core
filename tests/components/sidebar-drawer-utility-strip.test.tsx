// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// MOTIR-2373 — `SidebarDrawer`'s UTILITY STRIP (design/shell design-notes.md
// § *The access path — the drawer's utility strip*, Panel D).
//
// The below-`md` bar is closed at four slots, so three controls left it: the
// build-in-public slot, the report button, the theme toggle. A displaced control
// needs a DRAWN home, not a citation — this strip is that home, and the door to
// it is the hamburger the bar already carries.
//
// The strip is a footer on the drawer with the geometry of the drawer's own
// HEADER, mirrored to the bottom edge. Nothing in it is a new component: each
// control is the element that left the bar, re-homed — which is why the
// build-in-public slot arrives with its label intact (a status stripped of its
// label is not a status) while report and theme arrive as their shipped square
// icon buttons.

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));

import { SidebarDrawer } from '@/components/ui/SidebarDrawer';
import { SidebarToggle } from '@/components/ui/SidebarToggle';

/** The strip: the last child of the drawer panel. */
function strip(): HTMLElement {
  const panel = screen.getByRole('dialog', { name: 'Navigation' });
  return panel.lastElementChild as HTMLElement;
}

function openDrawer(): void {
  act(() => {
    screen.getByRole('button', { name: 'Open navigation' }).click();
  });
}

function renderDrawer(footer?: React.ReactNode) {
  return renderWithIntl(
    <>
      <SidebarToggle variant="hamburger" />
      <SidebarDrawer footer={footer}>
        <nav aria-label="Primary">body</nav>
      </SidebarDrawer>
    </>,
  );
}

afterEach(() => {
  // `useSidebarDrawer` is a MODULE-level store, so open/closed survives
  // `cleanup()`. Leaving it `true` mounts the next test's drawer already open —
  // and Radix then marks the hamburger `aria-hidden`, so the next `openDrawer()`
  // fails to find it. Close it through the UI, BEFORE unmounting.
  const close = screen.queryByRole('button', { name: 'Close navigation' });
  if (close) act(() => close.click());
  cleanup();
  vi.clearAllMocks();
});

describe('the drawer’s utility strip (MOTIR-2373)', () => {
  it('mirrors the drawer HEADER’s geometry on the bottom edge', () => {
    renderDrawer(<button type="button">displaced</button>);
    openDrawer();

    // Verbatim from the design: the same h-14 / items-center / gap-2 / px-3 the
    // header uses, with the hairline flipped from `border-b` to `border-t`.
    expect(strip().className).toBe(
      'flex h-14 shrink-0 items-center gap-2 border-t border-(--el-sidebar-border) px-3',
    );
    expect(screen.getByRole('button', { name: 'displaced' })).toBeTruthy();
  });

  it('pins the strip while the nav above it scrolls', () => {
    // `shrink-0` on the strip and `min-h-0 flex-1 overflow-y-auto` on the body:
    // a long project list must not push the displaced controls off the panel,
    // which would put them out of reach again — the exact failure the strip
    // exists to prevent.
    renderDrawer(<button type="button">displaced</button>);
    openDrawer();

    const panel = screen.getByRole('dialog', { name: 'Navigation' });
    const body = panel.querySelector('.overflow-y-auto')!;
    expect(strip().className).toContain('shrink-0');
    expect(body.className).toContain('min-h-0');
    // The strip is the LAST child, below the scrolling body — a footer, not a
    // second header.
    expect(body.compareDocumentPosition(strip()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders NO strip when nothing was displaced into it', () => {
    // The `/tokens` specimen mounts the drawer with no footer, and a bare
    // 56px-tall hairline with nothing in it is a defect, not a neutral default.
    renderDrawer();
    openDrawer();

    const panel = screen.getByRole('dialog', { name: 'Navigation' });
    expect(panel.lastElementChild!.className).toContain('overflow-y-auto');
    expect(panel.querySelector('.border-t')).toBeNull();
  });
});
