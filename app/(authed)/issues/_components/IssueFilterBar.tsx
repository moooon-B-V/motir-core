'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Check, Search, SlidersHorizontal, UserX, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { buildIssueListHref, type IssueListView, type IssueSort } from '@/lib/issues/issueListView';
import {
  EMPTY_FILTER,
  countActiveFilters,
  isFilterActive,
  setFilterText,
  toggleAssignee,
  toggleKind,
  toggleStatus,
  toggleUnassigned,
  type IssueFilter,
} from '@/lib/issues/issueListFilter';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { cn } from '@/lib/utils/cn';
import { Avatar } from './issueColumns';

// The /issues FILTER bar (Subtask 2.5.4) — the [Filter] toolbar control wired
// into a working, URL-driven, multi-select filter over the issue tree (and the
// flat List). Matches design/work-items/filter.mock.html: an enabled
// ToolbarButton (active ring + count badge when ≥1 value is set) opening a
// Popover dialog of four facets — text · kind · status · assignee — each a
// multi-select listbox reusing the Combobox option-row vocabulary (leading glyph
// · label · trailing Check). No new picker primitive.
//
// Filters apply LIVE and serialize to the URL (?kind=&status=&assignee=&q=, the
// assignee=unassigned token = the Unassigned bucket) — there is NO Apply button.
// Every edit recomputes the whole filter and router.push()es the canonical href
// (buildIssueListHref, preserving the active view + sort), so the Server
// Component re-reads the pruned, context-preserving tree (getProjectTree). The
// popover stays open across selections (multi-select); "Clear filters" resets to
// the full tree. The status dot mirrors StatusPicker (s.color ?? category var).

// The status dot colour: a per-status hex override when set, else the category's
// semantic --el-* token (per the design-notes — the swap-layer equivalents of
// StatusPicker's category vars, so the dot re-skins with a palette change).
const STATUS_CATEGORY_EL: Record<string, string> = {
  todo: '--el-text-faint',
  in_progress: '--el-info',
  done: '--el-success',
};

function StatusDot({ status }: { status: WorkflowStatusDto }) {
  const color = status.color ?? `var(${STATUS_CATEGORY_EL[status.category] ?? '--el-text-faint'})`;
  return (
    <span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 rounded-full border border-(--el-border)"
      style={{ backgroundColor: color }}
    />
  );
}

/** A multi-select option row (the Combobox option vocabulary, made selectable). */
function OptionRow({
  selected,
  onToggle,
  glyph,
  label,
  secondary,
}: {
  selected: boolean;
  onToggle: () => void;
  glyph: React.ReactNode;
  label: string;
  secondary?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none',
        selected && 'bg-(--el-surface)',
      )}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">{glyph}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {secondary ? (
        <span className="max-w-[130px] shrink-0 truncate text-xs text-(--el-text-muted)">
          {secondary}
        </span>
      ) : null}
      <Check
        aria-hidden
        className={cn(
          'h-4 w-4 shrink-0 text-(--el-accent)',
          selected ? 'opacity-100' : 'opacity-0',
        )}
      />
    </button>
  );
}

function FacetLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 font-mono text-[11px] font-semibold tracking-wider text-(--el-text-faint) uppercase">
      {label}
      {count > 0 ? <span className="text-(--el-text-muted)">· {count}</span> : null}
    </div>
  );
}

export interface IssueFilterBarProps {
  filter: IssueFilter;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  view: IssueListView;
  sort: IssueSort;
}

export function IssueFilterBar({ filter, statuses, members, view, sort }: IssueFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');

  // The text quick-filter is locally controlled for responsiveness, then pushed
  // to the URL debounced (live-apply without a router.push per keystroke).
  const [text, setText] = useState(filter.text ?? '');

  // Re-sync the input when the URL's text changes elsewhere (Clear, browser
  // back/forward): the React-endorsed "adjust state during render on a prop
  // change" pattern (a guarded setState, no effect) — when the user drives the
  // value the guard is a no-op (local text already equals filter.text).
  const [urlText, setUrlText] = useState(filter.text);
  if (filter.text !== urlText) {
    setUrlText(filter.text);
    setText(filter.text ?? '');
  }

  // The debounced push must thread the LATEST facets (a kind toggle mid-type
  // must not be clobbered), so read the current filter through an effect-synced
  // ref rather than the keystroke's stale closure.
  const filterRef = useRef(filter);
  useEffect(() => {
    filterRef.current = filter;
  });
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (textTimer.current) clearTimeout(textTimer.current);
    };
  }, []);

  function apply(next: IssueFilter) {
    router.push(buildIssueListHref(pathname, { view, sort, filter: next }));
  }

  function onTextChange(value: string) {
    setText(value);
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      apply(setFilterText(filterRef.current, value));
    }, 300);
  }

  const active = isFilterActive(filter);
  const count = countActiveFilters(filter);
  const memberMatches = members.filter((m) => {
    if (memberQuery.trim() === '') return true;
    const q = memberQuery.trim().toLowerCase();
    return m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={active ? `Filter — ${count} active` : 'Filter'}
          className={cn(
            'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border px-3 font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
            active ? 'border-(--el-accent) bg-(--el-tint-lavender)' : 'border-(--el-border)',
          )}
        >
          <SlidersHorizontal
            className={cn('h-4 w-4', active ? 'text-(--el-accent)' : 'text-(--el-text-muted)')}
            aria-hidden
          />
          Filter
          {active ? (
            <span
              aria-hidden
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-(--radius-badge) bg-(--el-accent) px-1.5 text-[11px] font-semibold text-(--el-accent-text) tabular-nums"
            >
              {count}
            </span>
          ) : null}
        </button>
      </Popover.Trigger>

      <Popover.Content
        role="dialog"
        aria-label="Filter issues"
        align="start"
        width={320}
        className="p-0"
      >
        {/* Header — title + Clear (disabled until something is selected) */}
        <div className="flex items-center justify-between gap-2 border-b border-(--el-border) px-3 py-2.5">
          <span className="font-mono text-[11px] font-semibold tracking-wider text-(--el-text-muted) uppercase">
            Filter
          </span>
          <button
            type="button"
            disabled={!active}
            onClick={() => {
              setMemberQuery('');
              apply(EMPTY_FILTER);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-(--radius-control) px-1 py-0.5 text-sm focus-visible:outline-none',
              active
                ? 'text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)'
                : 'cursor-default text-(--el-text-faint)',
            )}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Clear filters
          </button>
        </div>

        <div className="max-h-[440px] overflow-y-auto p-1.5">
          {/* TEXT quick-filter */}
          <div className="relative mx-1 mt-1.5 mb-2">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 h-[15px] w-[15px] -translate-y-1/2 text-(--el-text-muted)"
              aria-hidden
            />
            <input
              type="text"
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              placeholder="Find by ID or title…"
              aria-label="Filter by text"
              className="h-(--height-control) w-full rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) pr-2.5 pl-8 font-sans text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            />
          </div>

          {/* KIND */}
          <div className="border-t border-(--el-border) py-1.5 first:border-t-0">
            <FacetLabel label="Kind" count={filter.kinds.length} />
            <div role="listbox" aria-label="Kind" aria-multiselectable="true">
              {ISSUE_TYPES.map((type: IssueType) => (
                <OptionRow
                  key={type}
                  selected={filter.kinds.includes(type)}
                  onToggle={() => apply(toggleKind(filter, type))}
                  glyph={<IssueTypeIcon type={type} className="h-4 w-4" />}
                  label={ISSUE_TYPE_META[type].label}
                />
              ))}
            </div>
          </div>

          {/* STATUS */}
          <div className="border-t border-(--el-border) py-1.5">
            <FacetLabel label="Status" count={filter.statuses.length} />
            <div role="listbox" aria-label="Status" aria-multiselectable="true">
              {statuses.map((s) => (
                <OptionRow
                  key={s.id}
                  selected={filter.statuses.includes(s.key)}
                  onToggle={() => apply(toggleStatus(filter, s.key))}
                  glyph={<StatusDot status={s} />}
                  label={s.label}
                />
              ))}
            </div>
          </div>

          {/* ASSIGNEE */}
          <div className="border-t border-(--el-border) py-1.5">
            <FacetLabel
              label="Assignee"
              count={filter.assigneeIds.length + (filter.includeUnassigned ? 1 : 0)}
            />
            <div className="relative mx-1 mt-0.5 mb-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-(--el-text-muted)"
                aria-hidden
              />
              <input
                type="text"
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
                placeholder="Search members…"
                aria-label="Search members"
                className="h-8 w-full rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) pr-2.5 pl-[30px] font-sans text-[13px] text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              />
            </div>
            <div role="listbox" aria-label="Assignee" aria-multiselectable="true">
              <OptionRow
                selected={filter.includeUnassigned}
                onToggle={() => apply(toggleUnassigned(filter))}
                glyph={
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-dashed border-(--el-border) text-(--el-text-muted)">
                    <UserX className="h-3.5 w-3.5" aria-hidden />
                  </span>
                }
                label="Unassigned"
              />
              {memberMatches.map((m) => (
                <OptionRow
                  key={m.userId}
                  selected={filter.assigneeIds.includes(m.userId)}
                  onToggle={() => apply(toggleAssignee(filter, m.userId))}
                  glyph={<Avatar name={m.name} />}
                  label={m.name}
                  secondary={m.email}
                />
              ))}
              {memberMatches.length === 0 ? (
                <p className="px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-muted)">
                  No matching members.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </Popover.Content>
    </Popover>
  );
}
