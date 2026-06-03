import type { WorkItemDto } from '@/lib/dto/workItems';
import { Card } from '@/components/ui/Card';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { PRIORITY_LABELS } from '@/lib/issues/priority';
import { formatDateTime, formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';

// The issue detail metadata sidebar (Story 2.4 · Subtask 2.4.2). Every
// read-only `work_item` field at a glance: type, priority, assignee, reporter,
// due date, estimate, created, updated. DISPLAY only — the two interactive
// fields (status, assignee) get their inline controls in 2.4.4, and the "Edit"
// button (2.4.1) is the path for everything else. Timestamps render through the
// deterministic en-US/UTC formatter (no hydration mismatch — the 1.6.5 fix,
// reused not re-derived).

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
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {/* Labels are 12px secondary text → --color-slate (the design-system
          "secondary text" token), which clears AA comfortably on the Card's
          untinted bg-background. */}
      <dt className="font-sans text-xs font-medium tracking-wide text-(--color-slate) uppercase">
        {label}
      </dt>
      <dd className="text-foreground font-sans text-sm">{children}</dd>
    </div>
  );
}

function Person({ person }: { person: PersonRef | null }) {
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
    </span>
  );
}

export function CoreFieldsPanel({ item, assignee, reporter }: CoreFieldsPanelProps) {
  const typeMeta = ISSUE_TYPE_META[item.kind];
  const TypeIcon = typeMeta.icon;

  // The design-system container is `Card` (the same primitive MembersCard and
  // the other settings panels use) — its default `tint="none"` sits on
  // `bg-background` with the canonical card radius / padding / hairline tokens.
  // (An earlier hand-rolled `bg-surface` section put 12px secondary text on a
  // tint at 4.16:1 — below AA; the Card's untinted surface is the correct fix,
  // not just darkening the text. The doc warns against tinting page surfaces.)
  // `role="region"` + `aria-label` keep it a labelled landmark (Card is a div).
  return (
    <Card
      role="region"
      aria-label="Details"
      header={<h2 className="text-foreground font-sans text-base font-semibold">Details</h2>}
    >
      <dl className="flex flex-col gap-4">
        <Field label="Type">
          <span className="flex items-center gap-1.5">
            <TypeIcon className="h-4 w-4" aria-hidden />
            {typeMeta.label}
          </span>
        </Field>
        <Field label="Priority">{PRIORITY_LABELS[item.priority]}</Field>
        <Field label="Assignee">
          <Person person={assignee} />
        </Field>
        <Field label="Reporter">
          <Person person={reporter} />
        </Field>
        <Field label="Due date">
          {item.dueDate ? (
            formatDate(item.dueDate)
          ) : (
            <span className="text-(--color-slate) italic">No due date</span>
          )}
        </Field>
        <Field label="Estimate">
          {item.estimateMinutes != null ? (
            formatDurationMinutes(item.estimateMinutes)
          ) : (
            <span className="text-(--color-slate) italic">No estimate</span>
          )}
        </Field>
        <Field label="Created">{formatDateTime(item.createdAt)}</Field>
        <Field label="Updated">{formatDateTime(item.updatedAt)}</Field>
      </dl>
    </Card>
  );
}
