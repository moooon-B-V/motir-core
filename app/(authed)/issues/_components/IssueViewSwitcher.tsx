'use client';

import { useState, type ComponentType } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Check, ChevronDown, List, ListTree } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import { buildIssueListHref, type IssueListView, type IssueSort } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';

// The working [Tree ▾] view switcher (Subtask 2.5.8) — replaces the disabled
// placeholder 2.5.3 shipped as a forward-compatible seam. A Popover menu toggling
// the issue list between the nested Tree view (2.5.2/2.5.3) and the flat sortable
// List view (IssueListTable), per design/work-items/list.mock.html. The choice is
// URL-driven (`?view=`) — shareable / reload-safe — so this only navigates; the
// Server Component reads `view` and renders the matching table. The current List
// sort is preserved when toggling INTO list (so a round-trip keeps the column).

interface ViewOption {
  view: IssueListView;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}

const TREE_OPTION: ViewOption = { view: 'tree', label: 'Tree', icon: ListTree };
const LIST_OPTION: ViewOption = { view: 'list', label: 'List', icon: List };
const OPTIONS: ViewOption[] = [TREE_OPTION, LIST_OPTION];

export interface IssueViewSwitcherProps {
  view: IssueListView;
  sort: IssueSort;
  /** Preserved across the view toggle (filtering applies to both views, 2.5.4). */
  filter: IssueFilter;
}

export function IssueViewSwitcher({ view, sort, filter }: IssueViewSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const active = view === 'list' ? LIST_OPTION : TREE_OPTION;
  const ActiveIcon = active.icon;

  function select(next: IssueListView) {
    setOpen(false);
    if (next !== view) {
      // Preserve the active sort only when the List is the destination (the Tree
      // ignores sort, so its canonical URL drops the param), and the active
      // filter always (it applies to both views).
      router.push(buildIssueListHref(pathname, { view: next, sort, filter }));
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`View: ${active.label}`}
          className="inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-3 font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <ActiveIcon className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          {active.label}
          <ChevronDown className="h-3.5 w-3.5 text-(--el-text-muted)" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Content role="menu" align="end" width={180} className="p-1">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const isActive = opt.view === view;
          return (
            <button
              key={opt.view}
              type="button"
              role="menuitemradio"
              aria-checked={isActive}
              onClick={() => select(opt.view)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none',
                isActive && 'font-semibold',
              )}
            >
              <Icon className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
              <span className="flex-1">{opt.label}</span>
              {isActive ? (
                <Check className="h-4 w-4 shrink-0 text-(--el-accent)" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </Popover.Content>
    </Popover>
  );
}
