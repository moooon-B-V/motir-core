'use client';

import { type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { ComboboxOption } from '@/components/ui/Combobox';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import { AUTOMATION_PRIORITIES } from '@/lib/automation/fields';
import { cn } from '@/lib/utils/cn';

// Shared presentational bits for the automation editor + list (Story 6.6 ·
// Subtask 6.6.5). Kept together so the rule list and the editor render the same
// avatar, switch, and picker-option grammar (the design-notes' shared
// vocabulary: Avatar, Switch, the status dot, the priority direction icon).

/** Up-to-two-letter initials for the owner / member avatar (the mockup's `ZY`
 * grammar — first letter of the first two whitespace-separated words). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** The initials avatar — a filled disc (the shipped members-page grammar). */
export function MemberAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-(--el-text) font-sans font-semibold text-(--el-text-inverted)',
        className ?? 'size-6 text-[10px]',
      )}
    >
      {initials(name)}
    </span>
  );
}

/** The per-status colour dot — a per-status hex override, else the category's
 * semantic `--el-*` token (the shipped StatusDot grammar; re-skins with the
 * palette). `rounded-full` is a genuine circle (the shape-rule carve-out). */
const STATUS_CATEGORY_EL: Record<string, string> = {
  todo: '--el-text-faint',
  in_progress: '--el-info',
  done: '--el-success',
};

export function StatusDot({ status }: { status: WorkflowStatusDto }) {
  const color = status.color ?? `var(${STATUS_CATEGORY_EL[status.category] ?? '--el-text-faint'})`;
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

/** A sliding enable/disable switch (`role="switch"`). No extracted primitive
 * exists; this matches the mockup's `.sw` control, keyboard-operable, with the
 * knob + track as genuine pills (the shape-rule carve-out for the Switch knob). */
export function RuleSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-default disabled:opacity-60',
        checked
          ? 'border-(--el-accent) bg-(--el-accent)'
          : 'border-(--el-border-strong) bg-(--el-muted)',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-3.5 rounded-full bg-(--el-surface) shadow-(--shadow-subtle) transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/** Status-target Combobox options (each with its colour dot). The value is the
 * status KEY, not the row id: a rule's stored `triggerConfig.toStatusId` /
 * `fromStatusId` and a `transition` action's `toStatusId` all hold the status
 * KEY — that's the unit the engine narrows transitioned events by
 * (`config.toStatusId === event.toStatusKey`, automationEngineService) and the
 * unit `workItemsService.updateStatus` accepts. Storing the row id here meant a
 * UI-authored transitioned rule never matched and a transition action always
 * failed (the key/id mismatch). */
export function statusOptions(statuses: WorkflowStatusDto[]): ComboboxOption<string>[] {
  return statuses.map((s) => ({
    value: s.key,
    label: s.label,
    icon: <StatusDot status={s} />,
  }));
}

/** Member Combobox options (each with its initials avatar). */
export function memberOptions(members: WorkspaceMemberDTO[]): ComboboxOption<string>[] {
  return members.map((m) => ({
    value: m.userId,
    label: m.name,
    secondary: m.email,
    icon: <MemberAvatar name={m.name} className="size-4 text-[8px]" />,
  }));
}

/** The priority direction-icon colour (finding #54 — hue, not flat grey). */
const PRIORITY_ICON_EL: Record<WorkItemPriorityDto, string> = {
  highest: 'text-(--el-danger)',
  high: 'text-(--el-warning)',
  medium: 'text-(--el-text-muted)',
  low: 'text-(--el-info)',
  lowest: 'text-(--el-text-muted)',
};

/** Priority Combobox options (direction icon in its hue). `label` resolves via
 * the caller's `labels.priority` translator so the copy stays one source. */
export function priorityOptions(
  labelFor: (priority: WorkItemPriorityDto) => string,
): ComboboxOption<string>[] {
  return AUTOMATION_PRIORITIES.map((p) => {
    const Icon = PRIORITY_META[p].icon;
    return {
      value: p,
      label: labelFor(p),
      icon: <Icon className={cn('h-4 w-4', PRIORITY_ICON_EL[p])} aria-hidden />,
    } satisfies ComboboxOption<string>;
  });
}

/** The auto-disabled banner (Subtask 6.6.6) — shared by the rule LIST and the
 * EDITOR (when editing a rule the engine switched off after the failure
 * threshold). Rose tint with AA `--el-text-strong` text (finding #35), names
 * the failure count, and offers Re-enable — wired to the same enable toggle the
 * list uses (enabling resets the failure counter). `onReEnable` omitted hides
 * the button (the list renders its own inline Re-enable next to the row). */
export function AutoDisabledBanner({
  name,
  count,
  onReEnable,
}: {
  name: string;
  count: number;
  onReEnable?: () => void;
}) {
  const t = useTranslations('settings.automation');
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding)"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-danger)" aria-hidden />
      <p className="min-w-0 flex-1 font-sans text-sm text-(--el-text-strong)">
        {t('autoDisabledBanner', { name, count })}
      </p>
      {onReEnable ? (
        <Button variant="ghost" size="sm" onClick={onReEnable}>
          {t('row.reEnable')}
        </Button>
      ) : null}
    </div>
  );
}

/** A small labelled wedge marker (the When/If/Then block glyph chip). */
export function BlockWedge({ tint, children }: { tint: string; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-strong)"
      style={{ backgroundColor: `var(${tint})` }}
    >
      {children}
    </span>
  );
}
