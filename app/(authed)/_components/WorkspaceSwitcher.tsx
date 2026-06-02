'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Mail, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { Pill } from '@/components/ui/Pill';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import { createWorkspaceAction, switchWorkspaceAction } from '../_actions';

export interface WorkspaceSwitcherProps {
  workspaces: WorkspaceSummaryDTO[];
  activeWorkspaceId: string | null;
}

export function WorkspaceSwitcher({ workspaces, activeWorkspaceId }: WorkspaceSwitcherProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [isPending, startTransition] = useTransition();

  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  function handleSwitch(workspaceId: string) {
    if (workspaceId === activeWorkspaceId) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      await switchWorkspaceAction(workspaceId);
      setOpen(false);
      // Re-render server components against the new workspace context.
      router.refresh();
    });
  }

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    startTransition(async () => {
      try {
        await createWorkspaceAction(name);
        setCreateOpen(false);
        setNewName('');
        toast({ variant: 'success', title: 'Workspace created' });
        router.refresh();
      } catch {
        toast({ variant: 'error', title: 'Could not create workspace' });
      }
    });
  }

  function openCreate() {
    setOpen(false);
    setCreateOpen(true);
  }

  // Empty state — no memberships yet (cold start before the 1.2.4 signup
  // hook lands). Surface a direct "Create workspace" CTA instead of a name.
  if (workspaces.length === 0) {
    return (
      <>
        <Button
          variant="ghost"
          size="md"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={openCreate}
        >
          Create workspace
        </Button>
        <CreateWorkspaceModal
          open={createOpen}
          onOpenChange={setCreateOpen}
          value={newName}
          onChange={setNewName}
          onSubmit={handleCreate}
          pending={isPending}
        />
      </>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="md"
            rightIcon={<ChevronDown className="h-4 w-4" />}
            aria-label="Switch workspace"
          >
            <span className="max-w-[24ch] truncate">{active?.name ?? 'Select workspace'}</span>
          </Button>
        </Popover.Trigger>
        <Popover.Content align="start" width={320} className="py-1">
          <div className="px-3 pb-1 pt-2">
            <span className="text-muted-foreground font-mono text-xs uppercase tracking-wider">
              Workspaces
            </span>
          </div>
          <ul role="list" className="px-1">
            {workspaces.map((w) => {
              const isActive = w.id === activeWorkspaceId;
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => handleSwitch(w.id)}
                    disabled={isPending}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left',
                      'hover:bg-surface focus-visible:bg-surface focus-visible:outline-none',
                      'disabled:pointer-events-none disabled:opacity-50',
                      isActive && 'bg-surface',
                    )}
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                      {isActive ? (
                        <Check className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'flex-1 truncate font-sans text-sm text-foreground',
                        isActive && 'font-semibold',
                      )}
                    >
                      {w.name}
                    </span>
                    {/* Role label = metadata → neutral tone (AA-safe; #35). */}
                    <Pill tone="neutral">member</Pill>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="my-1 h-px bg-(--color-hairline)" />
          <div className="px-1">
            <button
              type="button"
              onClick={openCreate}
              className="hover:bg-surface focus-visible:bg-surface flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left font-sans text-sm text-foreground focus-visible:outline-none"
            >
              <Plus className="text-muted-foreground h-4 w-4" aria-hidden />
              Create workspace
            </button>
          </div>
          <div className="my-1 h-px bg-(--color-hairline)" />
          <div className="px-1 pb-1">
            <a
              href="/settings/workspace#members"
              onClick={() => setOpen(false)}
              className="hover:bg-surface focus-visible:bg-surface flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left font-sans text-sm text-foreground focus-visible:outline-none"
            >
              <Mail className="text-muted-foreground h-4 w-4" aria-hidden />
              Invite teammates
            </a>
          </div>
        </Popover.Content>
      </Popover>

      <CreateWorkspaceModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        value={newName}
        onChange={setNewName}
        onSubmit={handleCreate}
        pending={isPending}
      />
    </>
  );
}

function CreateWorkspaceModal({
  open,
  onOpenChange,
  value,
  onChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Create workspace" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <Input
          label="Workspace name"
          placeholder="My workspace"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={pending} disabled={!value.trim()}>
            Create
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
