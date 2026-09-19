'use client';

import { type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { ComboboxOption } from '@/components/ui/Combobox';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import { statusDotColor } from '@/lib/workflows/statusColor';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import { AUTOMATION_PRIORITIES } from '@/lib/automation/fields';
import { cn } from '@/lib/utils/cn';

// Shared presentational bits for the automation editor + list (Story 6.6 ·
// Subtask 6.6.5). Kept together so the rule list and the editor render the same
// avatar and picker-option grammar (the design-notes' shared vocabulary: Avatar,
// the status dot, the priority direction icon). The enable switch is the design
// system's `Switch`, not a local copy (MOTIR-5735).

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

/** The per-status colour dot — a per-status hex override, else the per-status
 * `--el-status-*` token via shared `statusDotColor` (re-skins with the palette;
 * differentiates in_review / blocked / cancelled). `rounded-full` is a genuine
 * circle (the shape-rule carve-out). */
export function StatusDot({ status }: { status: WorkflowStatusDto }) {
  const color = statusDotColor(status);
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
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

/** The priority direction-icon colour (finding #54 — hue, not flat grey).
 *
 * Routed through the dedicated `--el-priority-*` ramp (MOTIR-2107), not the raw
 * semantics it used to borrow. Two reasons: the semantics gave `medium` and
 * `lowest` ONE token (`--el-text-muted`), so this picker could not tell the
 * ramp's two quiet steps apart at all — the collapse MOTIR-1273 fixed for the
 * chip and missed here; and this icon is the ramp's only UNDILUTED consumer, so
 * routing it here is what gives `familyHueSeparation.test.ts`'s ΔE 10 glyph
 * floor a surface to speak for. A palette that tunes its priority ramp now moves
 * this picker with it. */
const PRIORITY_ICON_EL: Record<WorkItemPriorityDto, string> = {
  highest: 'text-(--el-priority-highest)',
  high: 'text-(--el-priority-high)',
  medium: 'text-(--el-priority-medium)',
  low: 'text-(--el-priority-low)',
  lowest: 'text-(--el-priority-lowest)',
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
