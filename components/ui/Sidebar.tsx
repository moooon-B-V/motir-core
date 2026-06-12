'use client';

import { forwardRef, type ReactNode } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Tooltip } from './Tooltip';
import { SectionLabel } from './SectionLabel';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';

/**
 * Sidebar — the app shell's primary navigation rail.
 *
 * Data-agnostic and presentational: it renders whatever `header`/`footer`
 * JSX you hand it (the ProjectSwitcher, the collapse toggle) and a flat list
 * of `sections`. It knows NOTHING about projects, workspaces, or routes —
 * per PRODECT_FINDINGS #29 the empty/archived/null-active states are the
 * consumer's (1.5.3) job. The only state it reads is the shared
 * desktop-collapse boolean.
 *
 * Two render modes:
 *   - **Expanded** (240px): icon + label rows, section labels visible.
 *   - **Collapsed** (56px): icon-only rows, each wrapped in a `Tooltip`
 *     (`side="right"`) that surfaces the label on hover/focus.
 *
 * The collapsed mode is normally driven by the shared `useSidebarCollapsed`
 * store. Pass the optional `collapsed` prop to override it — `SidebarDrawer`
 * passes `collapsed={false}` so the mobile drawer always renders expanded
 * regardless of the desktop rail's persisted state.
 *
 * The active row gets `aria-current="page"` and the inset active treatment
 * (`--el-sidebar-item-bg-active` on the `--el-sidebar-bg` rail).
 *
 * Collapse-toggle composition (documented here so 1.5.3 doesn't ad-hoc it):
 * the footer toggle is NOT a new primitive — it's
 * `<SidebarToggle variant="footer" />`, which is a `<Tooltip>`-wrapped
 * `<Button variant="ghost" size="sm">` carrying `ChevronsLeft` (expanded) /
 * `ChevronsRight` (collapsed) from lucide-react. Pass it as `footer`.
 *
 * @example
 * <Sidebar
 *   header={<ProjectSwitcher />}
 *   sections={[
 *     { id: 'primary', items: [{ icon: <LayoutDashboard />, label: 'Dashboard', href: '/' }] },
 *     { id: 'meta', items: [{ icon: <Settings />, label: 'Settings', href: '/settings' }] },
 *   ]}
 *   footer={<SidebarToggle variant="footer" />}
 * />
 */
export interface SidebarItem {
  /** A lucide-react icon element (the caller sizes it). */
  icon: ReactNode;
  label: string;
  href: string;
  /** Optional keyboard hint shown right-aligned in the expanded row. */
  kbd?: string;
  /**
   * Optional trailing count badge shown right-aligned in the EXPANDED row
   * (hidden when collapsed, like `kbd`). The caller supplies the fully-styled
   * node so the primitive stays presentation-agnostic — e.g. the "Ready" entry's
   * neutral readiness count (Subtask 7.0.6).
   */
  badge?: ReactNode;
  /** Marks the current route — gets `aria-current="page"` + active styling. */
  active?: boolean;
  /**
   * A designed-for, not-yet-built row (e.g. the settings area's Automation
   * "Soon" slot). Renders as a non-interactive `<span aria-disabled>` with faint
   * ink and no hover — its state is conveyed by the row's `badge`, not colour
   * alone. The `href` is ignored.
   */
  disabled?: boolean;
}

export interface SidebarSection {
  /** Stable key for the section frame. */
  id: string;
  /** Optional uppercase-mono caption (hidden in collapsed mode). */
  label?: string;
  items: SidebarItem[];
  /** Opt into a Radix Collapsible disclosure (expanded mode only). */
  collapsible?: boolean;
  /** Initial open state for a `collapsible` section. Default `true`. */
  defaultOpen?: boolean;
}

export interface SidebarProps {
  /** Top slot — typically the ProjectSwitcher. Rendered as-is. */
  header?: ReactNode;
  sections: SidebarSection[];
  /** Bottom slot — typically `<SidebarToggle variant="footer" />`. */
  footer?: ReactNode;
  /**
   * Controlled collapse override. When omitted, the shared
   * `useSidebarCollapsed` store drives it. The drawer passes `false`.
   */
  collapsed?: boolean;
  /** Accessible name for the `<nav>`. Default `"Primary"`. */
  'aria-label'?: string;
  className?: string;
}

/** One nav row. Internal — composes Tooltip in collapsed mode. */
function SidebarNavItem({ item, collapsed }: { item: SidebarItem; collapsed: boolean }) {
  const isActive = Boolean(item.active);
  const isDisabled = Boolean(item.disabled);
  const glyph = (
    <span aria-hidden className="inline-flex [&_svg]:h-[18px] [&_svg]:w-[18px]">
      {item.icon}
    </span>
  );

  if (collapsed) {
    // A disabled row is a non-interactive span (no href, no focus, no hover);
    // the tooltip still surfaces its label so the icon-only rail stays legible.
    const row = isDisabled ? (
      <span
        aria-disabled="true"
        aria-label={item.label}
        className={cn(
          'mx-auto flex h-(--height-control) w-(--height-control) cursor-default select-none items-center justify-center rounded-(--radius-control)',
          'text-(--el-text-faint)',
        )}
      >
        {glyph}
      </span>
    ) : (
      <a
        href={item.href}
        aria-current={isActive ? 'page' : undefined}
        aria-label={item.label}
        className={cn(
          'mx-auto flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control)',
          'text-(--el-text-muted) transition-colors',
          'hover:bg-(--el-sidebar-item-bg-hover) hover:text-(--el-text)',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
          isActive &&
            'bg-(--el-sidebar-item-bg-active) text-(--el-accent) shadow-(--shadow-subtle) border border-(--el-sidebar-border)',
        )}
      >
        {glyph}
      </a>
    );
    return (
      <Tooltip content={item.label} side="right">
        {row}
      </Tooltip>
    );
  }

  // Expanded, disabled — a faint non-interactive row; the badge ("Soon") carries
  // the state in text, not colour alone (a11y).
  if (isDisabled) {
    return (
      <span
        aria-disabled="true"
        className={cn(
          'flex h-(--height-control) cursor-default select-none items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x)',
          'font-sans text-sm text-(--el-text-faint)',
        )}
      >
        <span
          aria-hidden
          className="inline-flex shrink-0 text-(--el-text-faint) [&_svg]:h-[18px] [&_svg]:w-[18px]"
        >
          {item.icon}
        </span>
        <span className="flex-1 truncate">{item.label}</span>
        {item.badge ? <span className="shrink-0">{item.badge}</span> : null}
      </span>
    );
  }

  return (
    <a
      href={item.href}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'flex h-(--height-control) items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x)',
        'font-sans text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
        isActive
          ? 'bg-(--el-sidebar-item-bg-active) font-medium text-(--el-text) shadow-(--shadow-subtle) border border-(--el-sidebar-border)'
          : 'text-(--el-text-secondary) hover:bg-(--el-sidebar-item-bg-hover) hover:text-(--el-text)',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-flex shrink-0 [&_svg]:h-[18px] [&_svg]:w-[18px]',
          isActive ? 'text-(--el-accent)' : 'text-(--el-text-muted)',
        )}
      >
        {item.icon}
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge ? <span className="shrink-0">{item.badge}</span> : null}
      {item.kbd ? (
        <kbd className="rounded-(--radius-kbd) border border-(--el-sidebar-border) bg-(--el-page-bg) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[10px] text-(--el-text-muted)">
          {item.kbd}
        </kbd>
      ) : null}
    </a>
  );
}

/** A section's rows, optionally wrapped in a Radix Collapsible. */
function SidebarSectionFrame({
  section,
  collapsed,
}: {
  section: SidebarSection;
  collapsed: boolean;
}) {
  const rows = (
    <div className="flex flex-col gap-0.5">
      {section.items.map((item) => (
        <SidebarNavItem key={item.href || item.label} item={item} collapsed={collapsed} />
      ))}
    </div>
  );

  // Collapsible disclosure only makes sense with labels visible.
  if (section.collapsible && !collapsed && section.label) {
    return (
      <Collapsible.Root defaultOpen={section.defaultOpen ?? true} className="flex flex-col gap-1.5">
        <Collapsible.Trigger
          className={cn(
            'group flex items-center justify-between rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)',
            'hover:bg-(--el-sidebar-item-bg-hover)',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
          )}
        >
          {/* Section captions sit on the sidebar surface (#f6f5f4), where the
              default --el-text-muted undershoots WCAG AA at 11px; --el-text-secondary
              is the AA-safe sidebar caption color. */}
          <SectionLabel label={section.label} className="text-(--el-text-secondary)" />
          <ChevronDown
            aria-hidden
            className="h-3.5 w-3.5 text-(--el-text-muted) transition-transform group-data-[state=closed]:-rotate-90"
          />
        </Collapsible.Trigger>
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-out data-[state=open]:animate-in">
          {rows}
        </Collapsible.Content>
      </Collapsible.Root>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {section.label && !collapsed ? (
        // AA-safe sidebar caption color (see the collapsible branch above).
        <SectionLabel label={section.label} className="px-2 text-(--el-text-secondary)" />
      ) : null}
      {rows}
    </div>
  );
}

export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { header, sections, footer, collapsed: collapsedProp, className, ...rest },
  ref,
) {
  const [collapsedFromStore] = useSidebarCollapsed();
  // Controlled override (drawer) wins; otherwise follow the shared store.
  const collapsed = collapsedProp ?? collapsedFromStore;
  const ariaLabel = rest['aria-label'] ?? 'Primary';

  return (
    <nav
      ref={ref}
      aria-label={ariaLabel}
      data-collapsed={collapsed || undefined}
      className={cn(
        'flex h-full flex-col bg-(--el-sidebar-bg)',
        'border-r border-(--el-sidebar-border)',
        collapsed ? 'px-2 py-3' : 'px-3 py-3',
        className,
      )}
    >
      {header ? <div className={cn('shrink-0', collapsed ? 'mb-2' : 'mb-3')}>{header}</div> : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {sections.map((section, index) => (
          <div key={section.id} className="flex flex-col gap-3">
            {index > 0 ? <hr className="border-0 border-t border-(--el-sidebar-border)" /> : null}
            <SidebarSectionFrame section={section} collapsed={collapsed} />
          </div>
        ))}
      </div>

      {footer ? <div className="mt-3 shrink-0">{footer}</div> : null}
    </nav>
  );
});
