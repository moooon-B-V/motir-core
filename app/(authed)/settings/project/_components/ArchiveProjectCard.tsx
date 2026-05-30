'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ArchiveProjectModal } from './ArchiveProjectModal';

export interface ArchiveProjectCardProps {
  projectId: string;
  projectName: string;
  projectIdentifier: string;
}

export function ArchiveProjectCard({
  projectId,
  projectName,
  projectIdentifier,
}: ArchiveProjectCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card
        className="border-2 border-(--color-destructive)"
        header={
          <h2
            className="font-sans text-base font-semibold"
            style={{ color: 'var(--color-destructive)' }}
          >
            Danger zone
          </h2>
        }
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-sans text-sm font-medium text-foreground">Archive project</p>
            <p className="text-muted-foreground font-sans text-xs">
              Hides this project from the switcher and lists. Work items and history are preserved.
            </p>
          </div>
          <Button variant="danger" onClick={() => setOpen(true)}>
            Archive
          </Button>
        </div>
      </Card>

      <ArchiveProjectModal
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        projectName={projectName}
        projectIdentifier={projectIdentifier}
      />
    </>
  );
}
