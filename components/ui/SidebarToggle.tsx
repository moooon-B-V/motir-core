'use client';

import { forwardRef } from 'react';
import { ChevronsLeft, ChevronsRight, Menu } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from './Button';
import { Tooltip } from './Tooltip';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';
import { useSidebarDrawer } from '@/lib/hooks/useSidebarDrawer';

/**
 * SidebarToggle — the two buttons that drive the shell's nav visibility.
 *
 * Not a new primitive shape — both variants are a `<Button variant="ghost">`,
 * composed here so 1.5.3 doesn't re-derive the icon/aria/wiring at every
 * call site.
 *
 *   - **`footer`** — the desktop rail's collapse control. A `Tooltip`-wrapped
 *     ghost button carrying `ChevronsLeft` (expanded → collapse) /
 *     `ChevronsRight` (collapsed → expand). Reads + writes the shared
 *     `useSidebarCollapsed` store. Pass it to `<Sidebar footer={…} />`.
 *   - **`hamburger`** — the mobile top-nav trigger. A ghost button with the
 *     `Menu` icon that opens the off-canvas `SidebarDrawer` via the shared
 *     `useSidebarDrawer` store. Render it in the top nav, shown only `<md`.
 *
 * @example
 * <Sidebar footer={<SidebarToggle variant="footer" />} … />
 * <div className="md:hidden"><SidebarToggle variant="hamburger" /></div>
 */
export interface SidebarToggleProps {
  variant: 'footer' | 'hamburger';
  className?: string;
}

export const SidebarToggle = forwardRef<HTMLButtonElement, SidebarToggleProps>(
  function SidebarToggle({ variant, className }, ref) {
    const [collapsed, , toggleCollapsed] = useSidebarCollapsed();
    const [, setDrawerOpen] = useSidebarDrawer();

    if (variant === 'hamburger') {
      return (
        <Button
          ref={ref}
          variant="ghost"
          size="sm"
          aria-label="Open navigation"
          onClick={() => setDrawerOpen(true)}
          className={cn('w-9 px-0', className)}
        >
          <Menu className="h-5 w-5" />
        </Button>
      );
    }

    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    return (
      <Tooltip content={label} side="right">
        <Button
          ref={ref}
          variant="ghost"
          size="sm"
          aria-label={label}
          // Disclosure semantics (W3C APG): this control shows/hides the
          // sidebar rail, so `aria-expanded` reflects the rail's state
          // (expanded when NOT collapsed) — the canonical pattern for a
          // region show/hide toggle. `aria-controls` points AT was considered
          // but the rail/drawer share this component, so we keep the name +
          // state on the control itself.
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
          className={cn(collapsed ? 'mx-auto w-9 px-0' : 'w-9 px-0', className)}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        </Button>
      </Tooltip>
    );
  },
);
