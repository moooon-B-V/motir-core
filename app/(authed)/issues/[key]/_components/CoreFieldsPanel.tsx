import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Calendar, Clock, Minus } from 'lucide-react';
import type { WorkItemDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import { Card } from '@/components/ui/Card';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { PRIORITY_LABELS } from '@/lib/issues/priority';
import { formatDateTime, formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';

// The issue detail metadata rail (Story 2.4 · Subtask 2.4.2). Layout follows the
// design mockup `design/work-items/detail.png`: a vertical STACK of individual
// bordered field boxes (NOT one "Details" card with a dl), each a small
// uppercase label over a value rendered with its icon / pill. DISPLAY only —
// the interactive status + assignee controls (2.4.4), the parent box (2.4.3),
// and the archive action are added by their own subtasks; this fills the
// read-only fields. The page's <aside> is the complementary landmark.

/** A resolved person reference for assignee/reporter display. */
export interface PersonRef {
  name: string;
  email: string;
}

export interface CoreFieldsPanelProps {
  item: WorkItemDto;
  /** Assignee resolved to a member, or null when unassigned / not a member. */
  assignee: PersonRef | null;
  /** Reporter resolved to a member, or null when not resolvable. */
  reporter: PersonRef | null;
  /** True when the reporter is the signed-in viewer (renders a "You" chip). */
  reporterIsSelf?: boolean;
}

// One field box — a compact Card (its --radius-card / hairline tokens, padding
// tightened from the default 24px to field scale). Mirrors the mockup's rail.
function FieldBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card className="px-3.5 py-2.5">
      {/* 11px uppercase secondary-text label → --color-slate clears AA on the
          untinted card (muted-foreground would not on a tint; see #35). */}
      <div className="font-sans text-[11px] font-semibold tracking-wide text-(--color-slate) uppercase">
        {label}
      </div>
      <div className="text-foreground mt-1.5 font-sans text-sm">{children}</div>
    </Card>
  );
}

function Person({ person, selfChip }: { person: PersonRef | null; selfChip?: boolean }) {
  if (!person) {
    return <span className="text-(--color-slate) italic">Unassigned</span>;
  }
  const initial = (person.name || person.email).charAt(0).toUpperCase();
  return (
    <span className="flex items-center gap-2">
      <span
        className="bg-foreground text-background inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        aria-hidden
      >
        {initial}
      </span>
      <span className="truncate">{person.name}</span>
      {selfChip ? <Pill tone="neutral">You</Pill> : null}
    </span>
  );
}

// Priority renders as a colored pill with a direction arrow (mockup: "↑ High"
// in a warning tint). Tones are the AA-safe Pill variants (#35).
const PRIORITY_PILL: Record<
  WorkItemPriorityDto,
  { pill: Partial<PillProps>; icon: typeof ArrowUp }
> = {
  highest: { pill: { severity: 'danger' }, icon: ArrowUp },
  high: { pill: { severity: 'warning' }, icon: ArrowUp },
  medium: { pill: { tone: 'neutral' }, icon: Minus },
  low: { pill: { severity: 'info' }, icon: ArrowDown },
  lowest: { pill: { tone: 'neutral' }, icon: ArrowDown },
};

function PriorityValue({ priority }: { priority: WorkItemPriorityDto }) {
  const { pill, icon: Icon } = PRIORITY_PILL[priority];
  return (
    <Pill {...pill}>
      <Icon className="h-3 w-3" aria-hidden />
      {PRIORITY_LABELS[priority]}
    </Pill>
  );
}

export function CoreFieldsPanel({
  item,
  assignee,
  reporter,
  reporterIsSelf,
}: CoreFieldsPanelProps) {
  const typeMeta = ISSUE_TYPE_META[item.kind];
  const TypeIcon = typeMeta.icon;

  return (
    <div className="flex flex-col gap-3">
      <FieldBox label="Type">
        <span className="flex items-center gap-1.5">
          <TypeIcon className="h-4 w-4" aria-hidden />
          {typeMeta.label}
        </span>
      </FieldBox>

      <FieldBox label="Priority">
        <PriorityValue priority={item.priority} />
      </FieldBox>

      <FieldBox label="Assignee">
        <Person person={assignee} />
      </FieldBox>

      <FieldBox label="Reporter">
        <Person person={reporter} selfChip={reporterIsSelf} />
      </FieldBox>

      <FieldBox label="Due date">
        {item.dueDate ? (
          <span className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-(--color-slate)" aria-hidden />
            {formatDate(item.dueDate)}
          </span>
        ) : (
          <span className="text-(--color-slate) italic">No due date</span>
        )}
      </FieldBox>

      <FieldBox label="Estimate">
        {item.estimateMinutes != null ? (
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-(--color-slate)" aria-hidden />
            {formatDurationMinutes(item.estimateMinutes)}
          </span>
        ) : (
          <span className="text-(--color-slate) italic">No estimate</span>
        )}
      </FieldBox>

      {/* Created / updated are lower-emphasis audit fields (the mockup keeps
          them out of the boxed rail) — a compact labelled footer, rendered
          through the deterministic en-US/UTC formatter (no hydration drift). */}
      <dl className="text-(--color-slate) flex flex-col gap-1 px-1 pt-1 font-sans text-xs">
        <div className="flex justify-between gap-2">
          <dt>Created</dt>
          <dd className="text-foreground">{formatDateTime(item.createdAt)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Updated</dt>
          <dd className="text-foreground">{formatDateTime(item.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}
