'use client';

import { useCallback, useState } from 'react';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';
import { PlanEditsTrigger } from '@/components/planning/PlanEditsLauncher';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import { useNotifyIssuesChanged } from '../../_components/CreateIssueProvider';
import type { IssueRowData } from './issueRows';

export function WorkItemRowActions({ row }: { row: IssueRowData }) {
  const { canEdit, canManage } = useProjectAccess();
  const notifyIssuesChanged = useNotifyIssuesChanged();
  const [edits, setEdits] = useState<{ kind: 'expand' | 'replan'; itemKey: string } | null>(null);

  const onExpand = useCallback(() => {
    setEdits({ kind: 'expand', itemKey: row.identifier });
  }, [row.identifier]);

  const onReplan = useCallback(() => {
    setEdits({ kind: 'replan', itemKey: row.identifier });
  }, [row.identifier]);

  const onDismiss = useCallback(() => setEdits(null), []);

  return (
    <>
      <span className="flex items-center justify-end gap-0.5">
        <WorkItemActionsMenu
          itemId={row.id}
          identifier={row.identifier}
          title={row.title}
          canEdit={canEdit}
          canManage={canManage}
          planEdits={{
            kind: row.kind,
            hasChildren: row.hasChildren,
            // ⚠️ DEGRADE (MOTIR-2098) — rule 2 ("a LEAF with a description shows
            // Re-plan") cannot be evaluated here yet: the list row carries no
            // description signal, and the tree read's forest CTE projects a fixed
            // column set that excludes `descriptionMd`. So a described leaf reads
            // as undescribed and gets the Plan/Expand face on THIS surface only —
            // the detail page and the peek, which both hold the description, apply
            // rule 2 correctly. MOTIR-2098 plumbs a boolean `hasDescription`
            // through and deletes this comment.
            hasDescription: false,
            statusCategory: row.statusCategory,
            onExpand,
            onReplan,
          }}
          onDeleted={notifyIssuesChanged}
          onArchived={notifyIssuesChanged}
        />
      </span>
      {edits ? (
        <PlanEditsTrigger kind={edits.kind} itemKey={edits.itemKey} onDismiss={onDismiss} />
      ) : null}
    </>
  );
}
