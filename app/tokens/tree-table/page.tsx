'use client';

import { useState } from 'react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { TreeTable, type TreeTableColumn, type TreeTableRow } from '@/components/ui/TreeTable';
import type { IssueType } from '@/lib/issues/parentRules';

/**
 * /tokens/tree-table — specimen route for the TreeTable primitive (Subtask
 * 2.5.2). Renders the hierarchical issue tree from design/work-items/tree.png
 * (populated panel) so the primitive is visually reviewable, plus an empty
 * (no rows) variant. Swept by the axe sweep in tests/e2e/shell-a11y.spec.ts.
 *
 * Kept off the big /tokens index page (like /tokens/markdown-editor) so the
 * client-only, interactive tree-grid doesn't bloat the design-system index.
 */

interface IssueRow {
  identifier: string;
  title: string;
  kind: IssueType;
  assignee: string | null;
  status: { label: string; tone: PillProps };
}

// Status → Pill tone, mirroring the lifecycle mapping the real list uses
// (category → Pill variant). All tones are AA-safe (finding #35).
const STATUS = {
  todo: { label: 'todo', tone: { tone: 'neutral' } as PillProps },
  inProgress: { label: 'in-progress', tone: { status: 'in-progress' } as PillProps },
  inReview: { label: 'in-review', tone: { severity: 'warning' } as PillProps },
  done: { label: 'done', tone: { status: 'done' } as PillProps },
};

function row(
  identifier: string,
  title: string,
  kind: IssueType,
  assignee: string | null,
  status: IssueRow['status'],
  children?: TreeTableRow<IssueRow>[],
): TreeTableRow<IssueRow> {
  return { id: identifier, data: { identifier, title, kind, assignee, status }, children };
}

// The tree from tree.png panel 1 (depth 4: epic → story → task → subtask).
const ROWS: TreeTableRow<IssueRow>[] = [
  row('PROD-12', 'Q3 launch — Auth & sign-in', 'epic', 'Alice Chen', STATUS.inProgress, [
    row('PROD-23', 'Email + password sign-in', 'story', 'Marco Ortiz', STATUS.done, [
      row('PROD-25', 'Hash passwords with argon2id', 'task', 'Marco Ortiz', STATUS.done),
    ]),
    row('PROD-31', 'Google OAuth sign-in', 'story', 'Dana Kim', STATUS.inProgress, [
      row('PROD-41', 'Set up Google Cloud OAuth credentials', 'task', 'Dana Kim', STATUS.done),
      row('PROD-42', 'Add Google OAuth to sign-in', 'task', 'Dana Kim', STATUS.inProgress, [
        row(
          'PROD-58',
          'Write E2E test: email-first user signs in with Google',
          'subtask',
          'Dana Kim',
          STATUS.todo,
        ),
      ]),
      row(
        'PROD-49',
        'OAuth callback drops the `state` param on Safari ≤16',
        'bug',
        'Jamal Tate',
        STATUS.inReview,
      ),
    ]),
    row('PROD-34', 'Password reset email — copy + template', 'task', 'Riya Shah', STATUS.inReview),
  ]),
];

function Avatar({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[10px] font-semibold text-(--el-text-inverted)"
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

const COLUMNS: TreeTableColumn<IssueRow>[] = [
  {
    key: 'title',
    header: 'Title',
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2">
        <IssueTypeIcon type={r.kind} className="h-4 w-4 shrink-0" />
        <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">{r.identifier}</span>
        <span className="min-w-0 flex-1 truncate text-(--el-text) group-hover:underline">
          {r.title}
        </span>
      </span>
    ),
  },
  {
    key: 'assignee',
    header: 'Assignee',
    width: 140,
    cell: (r) =>
      r.assignee ? (
        <span className="flex items-center gap-2">
          <Avatar name={r.assignee} />
          <span className="truncate text-(--el-text-secondary)">{r.assignee}</span>
        </span>
      ) : (
        <span className="text-(--el-text-muted)">Unassigned</span>
      ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 130,
    cell: (r) => <Pill {...r.status.tone}>{r.status.label}</Pill>,
  },
];

export default function TreeTableSpecimenPage() {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(['PROD-12', 'PROD-31', 'PROD-42']),
  );

  return (
    <main className="mx-auto max-w-[64rem] bg-background px-6 py-10 text-foreground">
      <h1 className="text-2xl font-semibold tracking-tight">Tree table</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The accessible <code>treegrid</code> primitive behind the issue list (Subtask 2.5.2) —
        nested rows, per-level indent, a chevron on parents only, a whole-row link, and full
        keyboard support (↑/↓ move, →/← expand/collapse, Enter opens).
      </p>

      <section className="mt-8 flex flex-col gap-2">
        <SectionLabel>Populated (depth 4, controlled expansion)</SectionLabel>
        <TreeTable
          label="Work Items"
          columns={COLUMNS}
          rows={ROWS}
          expandedIds={expanded}
          onExpandedChange={setExpanded}
          getRowHref={(r) => `/items/${r.identifier}`}
          getRowLabel={(r) => `${r.identifier} ${r.title}`}
          getRowTestId={(r) => `tree-row-${r.identifier}`}
        />
      </section>

      <section className="mt-10 flex flex-col gap-2">
        <SectionLabel>Empty (no rows)</SectionLabel>
        <TreeTable label="Empty tree" columns={COLUMNS} rows={[]} />
      </section>
    </main>
  );
}
