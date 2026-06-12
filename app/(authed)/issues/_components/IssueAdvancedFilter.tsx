'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { FunnelPlus, Plus, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Segmented } from '@/components/ui/Segmented';
import { buildIssueListHref, type IssueListView, type IssueSort } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import {
  advancedBuilderFields,
  astFromRows,
  carryValueAcrossOperator,
  defaultOperator,
  FILTER_ROW_CAP,
  isRowComplete,
  rowsFromAst,
  setAdvancedParam,
  type AdvancedBuilderRow,
} from '@/lib/issues/issueListAdvancedFilter';
import type {
  FilterAst,
  FilterCombinator,
  FilterFieldId,
  FilterOperatorId,
} from '@/lib/filters/ast';
import { filterFieldDef, filterValueEditorKind, type FilterFieldDef } from '@/lib/filters/registry';
import { UnknownFilterFieldError } from '@/lib/filters/errors';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import { cn } from '@/lib/utils/cn';
import { useAdvancedFilterPopover } from './AdvancedFilterContext';
import { AdvancedFilterValueEditor } from './AdvancedFilterValueEditor';
import { advancedFieldLabel, advancedOperatorLabel } from './advancedFilterLabels';

// The ADVANCED filter builder (Story 6.1 · Subtask 6.1.4), per
// design/work-items/filter-builder.mock.html panels 1–3: the [Advanced]
// ToolbarButton beside the 2.5.4 [Filter] facet button, opening a Popover
// dialog of field / operator / value condition rows under a "Match all / any"
// Segmented combinator. THE ROWS RENDER THE 6.1.1 REGISTRY — the field menu
// lists `advancedBuilderFields()` (registry order), choosing a field
// populates its operator menu from `def.operators`, and the operator resolves
// the value editor via `filterValueEditorKind` — no hard-coded field lists
// anywhere (a registry addition appears with zero UI changes; tests assert it
// by injecting one through the `fields` prop).
//
// LIVE-APPLY (no Apply button — the 2.5.4 precedent): complete rows write the
// versioned `?filter=v1:…` param as they land (composing with ?view/?sort and
// resetting ?page, all through buildIssueListHref); a row missing its value
// is PENDING — drawn dashed with the explicit not-applied line, excluded from
// the badge count, the URL, and the result set; emptying an applied row
// returns it to pending without dropping it. Free-typing editors debounce the
// push; discrete edits apply at once. Pending rows live ONLY in this client
// state: the working copy resyncs from the URL exactly when the param changes
// under us (back/forward, the facet upgrade, Clear elsewhere) — recognised by
// comparing against the param this component last pushed — so an in-flight
// pending row never gets stomped by its own navigation echo (finding #58's
// optimistic-mirror lesson, one level up).

const FIELD_TRIGGER_WIDTH = 'w-[158px] shrink-0';
const OPERATOR_TRIGGER_WIDTH = 'w-[168px] shrink-0';
const PENDING_CONTROL = 'border-dashed text-(--el-text-muted)';

export interface IssueAdvancedFilterProps {
  filter: IssueFilter;
  /** The decoded active AST (null when none / invalid — the page decodes). */
  ast: FilterAst | null;
  view: IssueListView;
  sort: IssueSort;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  /** Field-def override for tests (the registry-driven AC); defaults to the
   * registry's built-in entries. */
  fields?: FilterFieldDef[];
}

interface WorkingState {
  combinator: FilterCombinator;
  rows: AdvancedBuilderRow[];
}

function workingFromAst(ast: FilterAst | null): WorkingState {
  return { combinator: ast?.combinator ?? 'and', rows: rowsFromAst(ast) };
}

/** Resolve a row's def — from the menu set first (covers test-injected
 * entries), then the full registry (covers URL-carried rows whose editors a
 * later subtask ships, e.g. Epic-5 fields pre-6.1.5); null for a field id
 * nothing knows (can't happen for an URL-parsed AST — the page validated). */
function rowDef(menuFields: FilterFieldDef[], field: FilterFieldId): FilterFieldDef | null {
  const fromMenu = menuFields.find((f) => f.id === field);
  if (fromMenu) return fromMenu;
  try {
    return filterFieldDef(field);
  } catch (err) {
    if (err instanceof UnknownFilterFieldError) return null;
    throw err;
  }
}

export function IssueAdvancedFilter({
  filter,
  ast,
  view,
  sort,
  statuses,
  members,
  sprints,
  fields,
}: IssueAdvancedFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('issueViews');
  // Page-shared open state (the summary chips + the facet upgrade open the
  // builder from outside the toolbar); local fallback when no provider.
  const popoverCtx = useAdvancedFilterPopover();
  const [localOpen, setLocalOpen] = useState(false);
  const open = popoverCtx?.open ?? localOpen;
  const setOpen = popoverCtx?.setOpen ?? setLocalOpen;

  const menuFields = useMemo(() => advancedBuilderFields(fields), [fields]);

  // The working copy (incl. pending rows). Resync from the URL only when the
  // param changed EXTERNALLY — i.e. it differs from what we last pushed.
  // `workingRef` is the synchronous twin (the finding-#58 pattern): an edit
  // composes onto it, not the render-time closure, so two edits fired before
  // a re-render stack instead of clobbering.
  const [working, setWorking] = useState<WorkingState>(() => workingFromAst(ast));
  const workingRef = useRef(working);
  const lastPushedRef = useRef<string | null>(filter.advanced);
  // Refs can't be touched during render (the repo lint rule the filter bar
  // documents), so the external-change resync runs in an effect keyed on the
  // param: our own push echoes back equal to `lastPushedRef` and is skipped,
  // so an in-flight pending row survives its own navigation; a back/forward,
  // facet upgrade, or Clear elsewhere differs and rebuilds the rows.
  useEffect(() => {
    if (filter.advanced === lastPushedRef.current) return;
    lastPushedRef.current = filter.advanced;
    const resynced = workingFromAst(ast);
    workingRef.current = resynced;
    setWorking(resynced);
  }, [filter.advanced, ast]);

  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
  }, []);

  // Live-apply: push the complete rows' AST whenever it differs from the
  // applied param. `debounce` marks free-typing edits.
  function apply(next: WorkingState, opts?: { debounce?: boolean }) {
    workingRef.current = next;
    setWorking(next);
    const nextAst = astFromRows(next.combinator, next.rows);
    const nextFilter = setAdvancedParam(filter, nextAst);
    if (pushTimer.current) clearTimeout(pushTimer.current);
    // `lastPushedRef` starts at the URL's param and tracks every push (a
    // pushed `null` — param cleared — is a real value, hence no `??`).
    if (nextFilter.advanced === lastPushedRef.current) return;
    const push = () => {
      lastPushedRef.current = nextFilter.advanced;
      router.push(buildIssueListHref(pathname, { view, sort, filter: nextFilter }));
    };
    if (opts?.debounce) {
      pushTimer.current = setTimeout(push, 300);
    } else {
      push();
    }
  }

  function addRow() {
    const current = workingRef.current;
    const def = menuFields[0];
    if (!def || current.rows.length >= FILTER_ROW_CAP) return;
    const key = current.rows.reduce((max, r) => Math.max(max, r.key), 0) + 1;
    apply({
      ...current,
      rows: [...current.rows, { key, field: def.id, operator: defaultOperator(def), value: null }],
    });
  }

  function updateRow(key: number, patch: (row: AdvancedBuilderRow) => AdvancedBuilderRow) {
    return (opts?: { debounce?: boolean }) => {
      const current = workingRef.current;
      apply({ ...current, rows: current.rows.map((r) => (r.key === key ? patch(r) : r)) }, opts);
    };
  }

  const appliedCount = working.rows.filter(isRowComplete).length;
  const active = appliedCount > 0;
  const atCap = working.rows.length >= FILTER_ROW_CAP;

  const fieldOptions: ComboboxOption<FilterFieldId>[] = menuFields.map((def) => ({
    value: def.id,
    label: advancedFieldLabel(t, def.id),
    secondary: def.id === 'text' ? t('advancedFieldTextSecondary') : undefined,
  }));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={active ? t('advancedActiveAria', { count: appliedCount }) : t('advanced')}
          className={cn(
            'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border px-3 font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
            active ? 'border-(--el-accent) bg-(--el-tint-lavender)' : 'border-(--el-border)',
          )}
        >
          <FunnelPlus
            className={cn('h-4 w-4', active ? 'text-(--el-accent)' : 'text-(--el-text-muted)')}
            aria-hidden
          />
          {t('advanced')}
          {active ? (
            <span
              aria-hidden
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-(--radius-badge) bg-(--el-accent) px-1.5 text-[11px] font-semibold text-(--el-accent-text) tabular-nums"
            >
              {appliedCount}
            </span>
          ) : null}
        </button>
      </Popover.Trigger>

      <Popover.Content
        role="dialog"
        aria-label={t('advancedDialogLabel')}
        align="end"
        width={680}
        className="p-0"
        // Layered dismiss: with a row's field/operator menu or value listbox
        // open (they mark themselves `data-inner-dismiss`), Esc closes THAT
        // and keeps the builder open; a second Esc closes the builder. Radix
        // captures Escape at the document before the inner handlers run, so
        // the deferral must happen here, not in the inner components.
        onEscapeKeyDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('[data-inner-dismiss]')) event.preventDefault();
        }}
      >
        {/* Header — mono uppercase title + Clear all */}
        <div className="flex items-center justify-between gap-2 border-b border-(--el-border) px-3.5 py-2.5">
          <span className="font-mono text-[11px] font-semibold tracking-wider text-(--el-text-muted) uppercase">
            {t('advancedDialogLabel')}
          </span>
          <button
            type="button"
            disabled={working.rows.length === 0}
            onClick={() => apply({ combinator: 'and', rows: [] })}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-(--radius-control) px-1 py-0.5 text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
              working.rows.length > 0
                ? 'text-(--el-link) hover:underline'
                : 'cursor-default text-(--el-text-faint)',
            )}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            {t('advancedClearAll')}
          </button>
        </div>

        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto px-3.5 py-3">
          {/* The combinator — the Segmented control read as a sentence */}
          <div className="flex items-center gap-2 pb-0.5 text-[13px] text-(--el-text-secondary)">
            <span>{t('advancedMatchPrefix')}</span>
            <Segmented
              label={t('advancedCombinatorAria')}
              value={working.combinator}
              onChange={(combinator: FilterCombinator) =>
                apply({ ...workingRef.current, combinator })
              }
              options={[
                { value: 'and', label: t('advancedMatchAll') },
                { value: 'or', label: t('advancedMatchAny') },
              ]}
            />
            <span>{t('advancedMatchSuffix')}</span>
          </div>

          {working.rows.map((row, index) => {
            const def = rowDef(menuFields, row.field);
            if (def === null) return null;
            const inMenu = menuFields.some((f) => f.id === def.id);
            const editorKind = filterValueEditorKind(def, row.operator);
            const pending = !isRowComplete(row);
            const operatorOptions: ComboboxOption<FilterOperatorId>[] = def.operators.map((op) => ({
              value: op,
              label: advancedOperatorLabel(t, op),
            }));
            return (
              <div
                key={row.key}
                role="group"
                aria-label={t('advancedConditionLabel', { n: index + 1 })}
                className="grid grid-cols-[158px_168px_minmax(0,1fr)_26px] items-center gap-2"
              >
                <Combobox
                  options={fieldOptions}
                  value={inMenu ? def.id : null}
                  onChange={(field) => {
                    const nextDef = menuFields.find((f) => f.id === field);
                    if (!nextDef || field === row.field) return;
                    updateRow(row.key, (r) => ({
                      ...r,
                      field,
                      operator: defaultOperator(nextDef),
                      value: null,
                    }))();
                  }}
                  label={t('advancedFieldAria')}
                  placeholder={advancedFieldLabel(t, def.id)}
                  searchable
                  searchPlaceholder={t('advancedSearchFields')}
                  emptyText={t('advancedNoMatches')}
                  disabled={!inMenu}
                  className={cn(FIELD_TRIGGER_WIDTH, pending && PENDING_CONTROL)}
                />
                <Combobox
                  options={operatorOptions}
                  value={row.operator}
                  onChange={(operator) =>
                    updateRow(row.key, (r) => ({
                      ...r,
                      operator,
                      value: carryValueAcrossOperator(def, r.operator, operator, r.value),
                    }))()
                  }
                  label={t('advancedOperatorAria')}
                  disabled={!inMenu}
                  className={cn(OPERATOR_TRIGGER_WIDTH, pending && PENDING_CONTROL)}
                />
                <AdvancedFilterValueEditor
                  def={def}
                  editorKind={editorKind}
                  value={row.value}
                  onChange={(value, opts) => updateRow(row.key, (r) => ({ ...r, value }))(opts)}
                  fieldLabel={advancedFieldLabel(t, def.id)}
                  statuses={statuses}
                  members={members}
                  sprints={sprints}
                  disabled={!inMenu}
                  className={pending ? PENDING_CONTROL : undefined}
                />
                <button
                  type="button"
                  onClick={() =>
                    apply({
                      ...workingRef.current,
                      rows: workingRef.current.rows.filter((r) => r.key !== row.key),
                    })
                  }
                  aria-label={t('advancedRemoveCondition', { n: index + 1 })}
                  className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
                {pending ? (
                  <p className="col-span-full -mt-1 text-xs text-(--el-text-muted) italic">
                    {t('advancedPendingNote')}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Footer — Add condition · the live-apply hint / cap notice */}
        <div className="flex items-center justify-between gap-2 border-t border-(--el-border) px-3.5 py-2.5">
          <button
            type="button"
            disabled={atCap}
            onClick={addRow}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-(--radius-control) px-1 py-0.5 text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
              atCap ? 'cursor-default text-(--el-text-faint)' : 'text-(--el-link) hover:underline',
            )}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('advancedAddCondition')}
          </button>
          <span className="text-xs text-(--el-text-faint) tabular-nums">
            {atCap
              ? t('advancedCapReached', { cap: FILTER_ROW_CAP })
              : t('advancedFootHint', { count: working.rows.length, cap: FILTER_ROW_CAP })}
          </span>
        </div>
      </Popover.Content>
    </Popover>
  );
}
