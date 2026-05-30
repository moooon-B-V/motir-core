'use client';

import { useState } from 'react';
import { FolderOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { CreateProjectModal } from './CreateProjectModal';

// Empty-state surface shown when the active workspace has zero projects.
// The literal "PROD-1" in the description is intentional — there is no
// project yet, so there's no real identifier to interpolate.

export function ProjectsEmptyState() {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <EmptyState
        icon={<FolderOpen className="h-12 w-12" aria-hidden />}
        title="Create your first project"
        description="Projects group your work items and give them a key like PROD-1. Create one to start planning."
        action={
          <Button
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setCreateOpen(true)}
          >
            Create project
          </Button>
        }
      />
      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
