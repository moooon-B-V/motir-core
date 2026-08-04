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
            // Rule 2's input (MOTIR-2098): the list/tree reads project a BOOLEAN
            // `hasDescription` — never the Markdown body — so this surface asks
            // the shared rule with the same state the detail page and the peek
            // hand it. No degrade left here.
            hasDescription: row.hasDescription,
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
