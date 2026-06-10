'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkflowDto } from '@/lib/dto/workflows';
import {
  buildStatusByKey,
  type SprintListResponse,
} from '@/app/(authed)/backlog/_components/backlogShared';
import { CompleteSprintDialog } from '@/app/(authed)/backlog/_components/CompleteSprintDialog';

// CompleteSprintEntry (Subtask 4.5.3) — the scrum header's **Complete sprint**
// ENTRY POINT. The complete-sprint FLOW itself (the confirm modal + carry-over
// chooser + sprint report) is Story **4.4**'s `CompleteSprintDialog`, which 4.4
// shipped as a self-contained, mountable flow expressly so 4.5.3 can mount the
// SAME flow here (the one-way 4.5 → 4.4 arrow). 4.5 implements NEITHER carry-over
// NOR the report; it only places the button and hands the dialog the data it needs.
//
// The board projection (4.5.2) carries a `SprintSummaryDto`, not the full
// `SprintDto` / planned-sprint list / workflow the dialog wants — so on first open
// this lazily fetches `GET /api/sprints` (the same read the backlog binds to),
// resolves the active sprint's full DTO + the project's PLANNED sprints (the
// carry-over targets), and builds `statusByKey` from the project `workflow` the
// board page already resolved. `projectName` comes from the page too. On a
// successful completion the dialog calls `onCompleted`, which reloads the board —
// the now-complete sprint drops out and the no-active-sprint state takes over.
export function CompleteSprintEntry({
  sprintId,
  projectName,
  workflow,
  onCompleted,
}: {
  /** The active sprint's id (from the board `SprintSummaryDto`). */
  sprintId: string;
  /** The active project's name — the dialog subtitle. */
  projectName: string;
  /** The project workflow — `statusByKey` for the report row pills. */
  workflow: WorkflowDto;
  /** Reload the board after the sprint completes (→ no-active-sprint state). */
  onCompleted: () => void | Promise<void>;
}) {
  const t = useTranslations('boards');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ sprint: SprintDto; plannedSprints: SprintDto[] } | null>(null);

  const statusByKey = useMemo(() => buildStatusByKey(workflow.statuses), [workflow.statuses]);

  // Lazily resolve the full active sprint + the project's planned sprints (the
  // dialog's carry-over targets) from the shipped sprint-list read, THEN open.
  async function handleOpen() {
    setLoading(true);
    try {
      const res = await fetch('/api/sprints', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`sprints ${res.status}`);
      const { sprints } = (await res.json()) as SprintListResponse;
      const sprint = sprints.find((s) => s.id === sprintId);
      if (!sprint) throw new Error('active sprint not found');
      const plannedSprints = sprints.filter((s) => s.state === 'planned');
      setData({ sprint, plannedSprints });
      setOpen(true);
    } catch {
      toast({
        variant: 'error',
        title: t('sprintCompleteLoadErrorTitle'),
        description: t('sprintCompleteLoadErrorDescription'),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<CheckCheck className="h-4 w-4" aria-hidden />}
        loading={loading}
        onClick={handleOpen}
        data-testid="scrum-complete-sprint"
      >
        {t('sprintCompleteAction')}
      </Button>
      {data ? (
        <CompleteSprintDialog
          open={open}
          onOpenChange={setOpen}
          sprint={data.sprint}
          projectName={projectName}
          plannedSprints={data.plannedSprints}
          statusByKey={statusByKey}
          onCompleted={onCompleted}
        />
      ) : null}
    </>
  );
}
