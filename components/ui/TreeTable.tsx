'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// TreeTable — the reusable, presentational tree-grid primitive (Subtask 2.5.2).
// The issue-list route (2.5.3) composes it, but it is GENERIC: it takes typed
// `columns` (header + per-row `cell` render-prop) and a nested `rows` model and
// emits the WAI-ARIA `treegrid` markup the design's hierarchical issue table
// needs (design/work-items/tree.png). There is no other table primitive in
// components/ui — JobsDashboard / WorkflowEditor each hand-roll a local
// `<table>`; this is the shared one a tree view reaches for.
//
// PURELY PRESENTATIONAL: it renders already-shaped data + render-props and
// issues NO queries and imports NO Server Actions (the CLAUDE.md layer rule).
// Expansion is controllable by the consumer (the 2.5.3 route holds it in URL/
// client state); an uncontrolled mode with `defaultExpandedIds` backs the
// specimen + simple callers. Inline editable cells (2.5.5) drop their controls
// into a column's `cell` render-prop and raise them above the row's stretched
// navigation link with `relative z-10`.
//
// A11y — the WAI-ARIA treegrid pattern (hand-rolled like Combobox):
//   role="treegrid" › rowgroup › row[aria-level/posinset/setsize/expanded] ›
//   gridcell. Exactly ONE row is in the tab sequence (roving tabindex); arrow
//   keys move focus and expand/collapse, Enter activates the row's link. Inner
//   controls (the chevron) are tabIndex=-1 — operated via the row keyboard +
//   mouse, never a second tab stop.

/** A column definition. The FIRST column is the tree column (indent + chevron). */
export interface TreeTableColumn<Row> {
  /** Stable key (React key for the cell + a11y id seed). */
  key: string;
  /** Column header content (rendered uppercase by the table). */
  header: ReactNode;
  /** Accessible header text when `header` is not a plain string. */
  headerLabel?: string;
  /** Render the cell body for a row. */
  cell: (row: Row) => ReactNode;
  /**
   * Fixed pixel width. Omit for the flexible tree column (there must be exactly
   * one flexible column — the first/tree column by convention).
   */
  width?: number;
  /** Right-align the cell + header (for the trailing meta columns if wanted). */
  align?: 'start' | 'end';
}

/** A node in the nested rows model. `children` may be omitted/empty for a leaf. */
export interface TreeTableRow<Row> {
  id: string;
  data: Row;
  children?: TreeTableRow<Row>[];
}

export interface TreeTableProps<Row> {
  /** The accessible name of the grid (e.g. "Issues"). */
  label: string;
  /** Column set; the first column renders the tree (indent + chevron + cell). */
  columns: TreeTableColumn<Row>[];
  /** The nested rows. */
  rows: TreeTableRow<Row>[];
  /** Controlled expansion: the set of expanded row ids. Pair with onExpandedChange. */
  expandedIds?: ReadonlySet<string>;
  /** Called with the next expanded set when the user toggles a row (controlled mode). */
  onExpandedChange?: (next: Set<string>) => void;
  /** Uncontrolled initial expansion (ignored when `expandedIds` is supplied). */
  defaultExpandedIds?: Iterable<string>;
  /** Whole-row navigation target; when set the row becomes a link to this href. */
  getRowHref?: (row: Row) => string | undefined;
  /** Accessible label for the row link — REQUIRED whenever getRowHref is set. */
  getRowLabel?: (row: Row) => string;
  /** Optional per-row `data-testid` (handy for E2E hooks). */
  getRowTestId?: (row: Row) => string | undefined;
  /** Extra classes on the outer container. */
  className?: string;
}

const INDENT_PX = 22; // per-level indent (design/work-items/tree.pen)

/** A row flattened for rendering, carrying the tree metadata aria needs. */
interface FlatRow<Row> {
  id: string;
  data: Row;
  depth: number; // 1 = root
  hasChildren: boolean;
  expanded: boolean;
  posinset: number; // 1-based among siblings
  setsize: number;
  parentId: string | null;
}

/** Depth-first flatten of the visible rows, honoring the expanded set. */
function flattenVisible<Row>(
  rows: TreeTableRow<Row>[],
  expanded: ReadonlySet<string>,
  depth: number,
  parentId: string | null,
  out: FlatRow<Row>[],
): void {
  rows.forEach((row, i) => {
    const hasChildren = !!row.children && row.children.length > 0;
    const isExpanded = hasChildren && expanded.has(row.id);
    out.push({
      id: row.id,
      data: row.data,
      depth,
      hasChildren,
      expanded: isExpanded,
      posinset: i + 1,
      setsize: rows.length,
      parentId,
    });
    if (isExpanded) flattenVisible(row.children!, expanded, depth + 1, row.id, out);
  });
}

export function TreeTable<Row>({
  label,
  columns,
  rows,
  expandedIds,
  onExpandedChange,
  defaultExpandedIds,
  getRowHref,
  getRowLabel,
  getRowTestId,
  className,
}: TreeTableProps<Row>) {
  const isControlled = expandedIds !== undefined;
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    () => new Set(defaultExpandedIds ?? []),
  );
  const expanded = isControlled ? expandedIds : internalExpanded;

  const visible = useMemo(() => {
    const out: FlatRow<Row>[] = [];
    flattenVisible(rows, expanded, 1, null, out);
    return out;
  }, [rows, expanded]);

  // Roving tabindex: exactly one row sits in the tab sequence. `focusedId` is
  // the user's last explicit focus; `activeId` DERIVES the actually-tabbable row
  // — it falls back to the first visible row when the focused one was collapsed
  // away (so we never need to reconcile state inside an effect).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const activeId = useMemo(() => {
    if (focusedId && visible.some((r) => r.id === focusedId)) return focusedId;
    return visible[0]?.id ?? null;
  }, [focusedId, visible]);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());

  const setExpanded = useCallback(
    (next: Set<string>) => {
      if (isControlled) onExpandedChange?.(next);
      else setInternalExpanded(next);
    },
    [isControlled, onExpandedChange],
  );

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExpanded(next);
    },
    [expanded, setExpanded],
  );

  const focusRowAt = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, visible.length - 1));
      const target = visible[clamped];
      if (!target) return;
      setFocusedId(target.id);
      rowRefs.current.get(target.id)?.focus();
    },
    [visible],
  );

  const onRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, row: FlatRow<Row>, index: number) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusRowAt(index + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          focusRowAt(index - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusRowAt(0);
          break;
        case 'End':
          e.preventDefault();
          focusRowAt(visible.length - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (row.hasChildren && !row.expanded) toggle(row.id);
          else if (row.hasChildren && row.expanded) focusRowAt(index + 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (row.hasChildren && row.expanded) {
            toggle(row.id);
          } else if (row.parentId) {
            const parentIndex = visible.findIndex((r) => r.id === row.parentId);
            if (parentIndex >= 0) focusRowAt(parentIndex);
          }
          break;
        case 'Enter':
          // Activate the row's stretched link (if any). Space is intentionally
          // NOT bound — it scrolls, and inner controls own their own keys.
          if (getRowHref) {
            const link = linkRefs.current.get(row.id);
            if (link) {
              e.preventDefault();
              link.click();
            }
          }
          break;
        default:
          break;
      }
    },
    [focusRowAt, toggle, visible, getRowHref],
  );

  const treeColumn = columns[0];
  const restColumns = columns.slice(1);
  // The grid template: the tree column flexes, the rest take their fixed widths.
  const gridTemplate = [
    'minmax(0,1fr)',
    ...restColumns.map((c) => (c.width ? `${c.width}px` : 'max-content')),
  ].join(' ');

  return (
    <div className={cn('overflow-hidden rounded-xl border border-(--el-border)', className)}>
      <div role="treegrid" aria-label={label} className="w-full text-sm">
        {/* Header */}
        <div role="rowgroup">
          <div
            role="row"
            className="sticky top-0 z-20 grid items-center border-b border-(--el-border) bg-(--el-surface-soft) pr-7 pl-4"
            style={{ gridTemplateColumns: gridTemplate, height: 40 }}
          >
            {columns.map((col) => (
              <div
                key={col.key}
                role="columnheader"
                className={cn(
                  'truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase',
                  col.align === 'end' && 'text-right',
                )}
              >
                {col.header}
              </div>
            ))}
          </div>
        </div>

        {/* Body — omitted entirely when there are no rows (the consumer renders
            its own empty state; an empty rowgroup adds nothing to convey). */}
        {visible.length > 0 ? (
          <div role="rowgroup">
            {visible.map((row, index) => {
              const href = getRowHref?.(row.data);
              const rowLabel = getRowLabel?.(row.data);
              const testId = getRowTestId?.(row.data);
              return (
                <div
                  key={row.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.id, el);
                    else rowRefs.current.delete(row.id);
                  }}
                  role="row"
                  aria-level={row.depth}
                  aria-posinset={row.posinset}
                  aria-setsize={row.setsize}
                  aria-expanded={row.hasChildren ? row.expanded : undefined}
                  tabIndex={row.id === activeId ? 0 : -1}
                  data-testid={testId}
                  onKeyDown={(e) => onRowKeyDown(e, row, index)}
                  onFocus={() => setFocusedId(row.id)}
                  className="group relative grid items-center border-b border-(--el-border) pr-7 pl-4 last:border-b-0 hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:-outline-offset-2"
                  style={{ gridTemplateColumns: gridTemplate, height: 40 }}
                >
                  {/* Tree column — indent + chevron slot + the consumer's cell. */}
                  <div
                    role="gridcell"
                    className="flex min-w-0 items-center gap-2"
                    style={{ paddingLeft: (row.depth - 1) * INDENT_PX }}
                  >
                    {/* Stretched link covers the whole ROW (row is the positioned
                      ancestor); the cell is static so inset-0 escapes it. */}
                    {href ? (
                      <a
                        ref={(el) => {
                          if (el) linkRefs.current.set(row.id, el);
                          else linkRefs.current.delete(row.id);
                        }}
                        href={href}
                        aria-label={rowLabel}
                        tabIndex={-1}
                        className="absolute inset-0 z-0 focus:outline-none"
                      />
                    ) : null}

                    {row.hasChildren ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={row.expanded ? 'Collapse row' : 'Expand row'}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggle(row.id);
                        }}
                        className="relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded text-(--el-text-muted) hover:text-(--el-text)"
                      >
                        <ChevronRight
                          className={cn(
                            'h-3 w-3 transition-transform',
                            row.expanded && 'rotate-90',
                          )}
                          aria-hidden
                        />
                      </button>
                    ) : (
                      // Reserved 16px slot so leaf rows align with parents' content.
                      <span className="h-4 w-4 shrink-0" aria-hidden />
                    )}

                    {/* The tree cell's content stays BELOW the stretched link
                        (no z-raise) so clicking the title/identifier navigates
                        the row — only genuinely interactive bits (the chevron
                        above; inline-edit controls in 2.5.5) raise themselves
                        with `relative z-10` to intercept their own clicks. */}
                    <div className="flex min-w-0 flex-1 items-center">
                      {treeColumn?.cell(row.data)}
                    </div>
                  </div>

                  {/* The remaining fixed columns. */}
                  {restColumns.map((col) => (
                    <div
                      key={col.key}
                      role="gridcell"
                      className={cn(
                        'flex min-w-0 items-center',
                        col.align === 'end' && 'justify-end',
                      )}
                    >
                      {col.cell(row.data)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
