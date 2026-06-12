'use client';

import { useMemo, useState, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { UserX } from 'lucide-react';
import { DatePicker } from '@/components/ui/DatePicker';
import { MultiSelectPicker, type MultiSelectOption } from '@/components/ui/MultiSelectPicker';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import type { FilterConditionValue } from '@/lib/filters/ast';
import type { FilterFieldDef, FilterValueEditorKind } from '@/lib/filters/registry';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import { cn } from '@/lib/utils/cn';

// The per-operator VALUE editor of an advanced-filter condition row (Subtask
// 6.1.4), per design/work-items/filter-builder.mock.html panel 1 — one editor
// per `FilterValueEditorKind` the registry resolves for the row's (field,
// operator) pair, each the SHIPPED primitive (no new size variants):
//
//   kind/status/priority/member/sprint-select → MultiSelectPicker (5.4.8),
//     options drawn with the same glyph vocabulary as the 2.5.4 facet rows
//     (IssueTypeIcon hue, status dot, PRIORITY_META direction icon, member
//     avatar); the assignee list puts the Unassigned sentinel FIRST and the
//     sprint list Backlog first (the registry's empty-bucket sentinels);
//   text / number / days → the input grammar (`--height-input`), days with
//     the "days" unit suffix; number/days hold a local raw string so partial
//     keystrokes don't fight the parsed value;
//   date → the shipped DatePicker trigger; date-range → two, joined by "and";
//   none (is empty / is not empty) → the value slot COLLAPSES (renders null).
//
// Epic-5 editor kinds (label / component / CF-option pickers) are Subtask
// 6.1.5's rows — a URL-carried condition renders the degraded read-only count
// box until those land (the row's pickers are disabled by the caller).

const PRIORITIES: readonly WorkItemPriorityDto[] = ['highest', 'high', 'medium', 'low', 'lowest'];

const KIND_GLYPHS = Object.fromEntries(
  ISSUE_TYPES.map((type) => [
    type,
    function KindGlyph({ className }: { className?: string }) {
      return <IssueTypeIcon type={type} className={className} />;
    },
  ]),
) as Record<IssueType, ComponentType<{ className?: string }>>;

// Mirrors the 2.5.4 facet bar's status dot (per-status hex override, else the
// category's semantic token) at glyph size.
const STATUS_CATEGORY_EL: Record<string, string> = {
  todo: '--el-text-faint',
  in_progress: '--el-info',
  done: '--el-success',
};

function statusGlyph(status: WorkflowStatusDto): ComponentType<{ className?: string }> {
  const color = status.color ?? `var(${STATUS_CATEGORY_EL[status.category] ?? '--el-text-faint'})`;
  return function StatusGlyph({ className }: { className?: string }) {
    return (
      <span
        aria-hidden
        className={cn('shrink-0 rounded-full border border-(--el-border)', className)}
        style={{ backgroundColor: color }}
      />
    );
  };
}

function memberGlyph(name: string): ComponentType<{ className?: string }> {
  const initial = name.charAt(0).toUpperCase();
  return function MemberGlyph({ className }: { className?: string }) {
    return (
      <span
        aria-hidden
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[8px] font-semibold text-(--el-text-inverted)',
          className,
        )}
      >
        {initial}
      </span>
    );
  };
}

function UnassignedGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-(--el-border) text-(--el-text-muted)',
        className,
      )}
    >
      <UserX className="h-[70%] w-[70%]" aria-hidden />
    </span>
  );
}

function filterByQuery(options: MultiSelectOption[], query: string): MultiSelectOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return options;
  return options.filter((o) => o.label.toLowerCase().includes(q));
}

const INPUT_CLASS =
  'h-(--height-input) rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) font-sans text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-(--el-surface-soft)';

/** A numeric input holding the raw keystrokes locally (so "5." doesn't snap
 * back to "5") while pushing the parsed value — or null while unparseable
 * (the pending state) — to the row. */
function NumberValueInput({
  value,
  onChange,
  integer,
  label,
  disabled,
  className,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  /** Day windows are integers; number comparisons accept decimals. */
  integer?: boolean;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const [raw, setRaw] = useState(value === null ? '' : String(value));
  // Reconcile when the row's value changes EXTERNALLY (operator carry-over,
  // URL resync) — the guarded adjust-during-render pattern; a user-driven
  // change already matches and is a no-op.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const parsed = integer ? Number.parseInt(raw, 10) : Number(raw);
    if (value === null || raw.trim() === '' || parsed !== value) {
      setRaw(value === null ? '' : String(value));
    }
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      value={raw}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        const next = e.target.value;
        setRaw(next);
        const trimmed = next.trim();
        if (trimmed === '') {
          onChange(null);
          return;
        }
        const parsed = integer ? Number.parseInt(trimmed, 10) : Number(trimmed);
        onChange(Number.isFinite(parsed) && String(parsed) === trimmed ? parsed : null);
      }}
      className={cn(INPUT_CLASS, 'w-[110px] tabular-nums', className)}
    />
  );
}

export interface AdvancedFilterValueEditorProps {
  def: FilterFieldDef;
  editorKind: FilterValueEditorKind;
  value: FilterConditionValue | null;
  /** `debounce: true` marks free-typing edits (text/number/days) so the
   * parent delays the live-apply URL push; discrete edits apply at once. */
  onChange: (value: FilterConditionValue | null, opts?: { debounce?: boolean }) => void;
  /** The field's display name — names the editor for SR users. */
  fieldLabel: string;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  disabled?: boolean;
  /** Extra classes for the editor's BORDERED control — the row passes the
   * dashed pending treatment through here (mock panel 3). */
  className?: string;
}

export function AdvancedFilterValueEditor({
  def,
  editorKind,
  value,
  onChange,
  fieldLabel,
  statuses,
  members,
  sprints,
  disabled,
  className,
}: AdvancedFilterValueEditorProps) {
  const t = useTranslations('issueViews');
  const tType = useTranslations('labels.issueType');
  const tStatus = useTranslations('labels.defaultStatus');
  const tPriority = useTranslations('labels.priority');
  const [query, setQuery] = useState('');

  const enumOptions = useMemo<MultiSelectOption[]>(() => {
    switch (editorKind) {
      case 'kind-select':
        return ISSUE_TYPES.map((type) => ({
          id: type,
          label: tType(type),
          glyph: KIND_GLYPHS[type],
        }));
      case 'status-select':
        return statuses.map((s) => ({
          id: s.key,
          label: DEFAULT_STATUS_KEYS.has(s.key) ? tStatus(s.key) : s.label,
          glyph: statusGlyph(s),
        }));
      case 'priority-select':
        return PRIORITIES.map((p) => ({
          id: p,
          label: tPriority(p),
          glyph: PRIORITY_META[p].icon,
        }));
      case 'member-select': {
        const options = members.map((m) => ({
          id: m.userId,
          label: m.name,
          glyph: memberGlyph(m.name),
        }));
        // The empty-bucket sentinel (assignee → Unassigned) leads the list.
        return def.emptySentinel
          ? [{ id: def.emptySentinel, label: t('unassigned'), glyph: UnassignedGlyph }, ...options]
          : options;
      }
      case 'sprint-select': {
        const options = sprints.map((s) => ({ id: s.id, label: s.name }));
        return def.emptySentinel
          ? [{ id: def.emptySentinel, label: t('advancedBacklog') }, ...options]
          : options;
      }
      default:
        return [];
    }
  }, [editorKind, def.emptySentinel, statuses, members, sprints, t, tType, tStatus, tPriority]);

  const valuesAria = t('advancedValuesAria', { field: fieldLabel });

  switch (editorKind) {
    case 'none':
      // is empty / is not empty — the value slot collapses (mock panel 1).
      return <div />;

    case 'kind-select':
    case 'status-select':
    case 'priority-select':
    case 'member-select':
    case 'sprint-select': {
      const ids = Array.isArray(value) ? value : [];
      const byId = new Map(enumOptions.map((o) => [o.id, o]));
      // An id with no option (a deleted member/sprint in a shared URL) keeps
      // its chip with the raw id label — removable, matches nothing (the
      // 2.5.4 open-id rule; the designed stale grammar lands with 6.1.5).
      const values = ids.map((id) => byId.get(id) ?? { id, label: id });
      const toggle = (option: MultiSelectOption) => {
        const next = ids.includes(option.id)
          ? ids.filter((id) => id !== option.id)
          : [...ids, option.id];
        onChange(next.length > 0 ? next : null);
      };
      return (
        <MultiSelectPicker
          values={values}
          options={filterByQuery(enumOptions, query)}
          onToggle={toggle}
          onRemove={toggle}
          query={query}
          onQueryChange={setQuery}
          label={valuesAria}
          placeholder={t('advancedAddValuePlaceholder')}
          removeLabel={(label) => t('advancedRemoveValue', { value: label })}
          emptyText={t('advancedNoMatches')}
          disabled={disabled}
          className={className}
        />
      );
    }

    case 'text':
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-label={valuesAria}
          onChange={(e) => onChange(e.target.value, { debounce: true })}
          className={cn(INPUT_CLASS, 'w-full', className)}
        />
      );

    case 'number':
      return (
        <NumberValueInput
          value={typeof value === 'number' ? value : null}
          onChange={(next) => onChange(next, { debounce: true })}
          label={valuesAria}
          disabled={disabled}
          className={className}
        />
      );

    case 'days':
      return (
        <div className="flex min-w-0 items-center gap-2">
          <NumberValueInput
            value={typeof value === 'number' ? value : null}
            onChange={(next) => onChange(next, { debounce: true })}
            integer
            label={t('advancedDayCountAria')}
            disabled={disabled}
            className={cn('w-[84px]', className)}
          />
          <span className="shrink-0 text-[13px] text-(--el-text-muted)">{t('advancedDays')}</span>
        </div>
      );

    case 'date':
      return (
        <DatePicker
          value={typeof value === 'string' ? value : null}
          onChange={(next) => onChange(next)}
          aria-label={t('advancedPickDateAria', { field: fieldLabel })}
          placeholder={t('advancedPickDate')}
          disabled={disabled}
          className={className}
        />
      );

    case 'date-range': {
      const [from, to] = Array.isArray(value) && value.length === 2 ? value : ['', ''];
      const update = (nextFrom: string, nextTo: string) =>
        onChange(nextFrom === '' && nextTo === '' ? null : [nextFrom, nextTo]);
      return (
        <div className="flex min-w-0 items-center gap-2">
          <DatePicker
            value={typeof from === 'string' && from !== '' ? from : null}
            onChange={(next) => update(next ?? '', typeof to === 'string' ? to : '')}
            aria-label={t('advancedPickFromDateAria', { field: fieldLabel })}
            placeholder={t('advancedPickDate')}
            disabled={disabled}
            className={className}
          />
          <span className="shrink-0 text-[13px] text-(--el-text-muted)">{t('advancedAnd')}</span>
          <DatePicker
            value={typeof to === 'string' && to !== '' ? to : null}
            onChange={(next) => update(typeof from === 'string' ? from : '', next ?? '')}
            aria-label={t('advancedPickToDateAria', { field: fieldLabel })}
            placeholder={t('advancedPickDate')}
            disabled={disabled}
            className={className}
          />
        </div>
      );
    }

    // The Epic-5 editors (label / component / CF options) are Subtask 6.1.5's
    // rows — a shared-URL condition renders read-only until they land (it
    // still filters through the shipped 6.1.2 compile path).
    case 'label-select':
    case 'component-select':
    case 'cf-option-select': {
      const count = Array.isArray(value) ? value.length : 0;
      return (
        <div
          className="flex min-h-(--height-input) w-full items-center gap-1.5 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)"
          aria-label={valuesAria}
        >
          <span className="inline-flex items-center rounded-(--radius-badge) border border-(--el-border) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-secondary)">
            {t('advancedValueCount', { count })}
          </span>
        </div>
      );
    }
  }
}
