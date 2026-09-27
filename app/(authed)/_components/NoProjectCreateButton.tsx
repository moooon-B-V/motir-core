'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CreateProjectModal } from './CreateProjectModal';

// The no-project shell's primary "Create a project" (MOTIR-6548 · S3) — the
// shipped create-project modal behind the shipped primary Button. Rendered only
// for a reader `projectsService.canOfferCreateProject` allows.
export function NoProjectCreateButton({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="primary"
        leftIcon={<Plus className="h-4 w-4" aria-hidden />}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <CreateProjectModal open={open} onOpenChange={setOpen} />
    </>
  );
}
