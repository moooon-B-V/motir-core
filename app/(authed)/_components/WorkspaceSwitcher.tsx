'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('shell');
  const tl = useTranslations('labels');
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
        toast({ variant: 'success', title: t('workspaceSwitcher.created') });
        router.refresh();
      } catch {
        toast({ variant: 'error', title: t('workspaceSwitcher.createError') });
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
          {t('workspaceSwitcher.create')}
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
            aria-label={t('workspaceSwitcher.switch')}
          >
            {/* font-serif: the workspace name is a header IDENTITY label — headline
                role so the `data-type` axis re-types the header chrome (see
                ProjectSwitcher). */}
            <span className="max-w-[24ch] truncate font-serif">
              {active?.name ?? t('workspaceSwitcher.select')}
            </span>
          </Button>
        </Popover.Trigger>
        <Popover.Content align="start" width={320} className="py-1">
          <div className="px-3 pb-1 pt-2">
            <span className="text-(--el-text-muted) font-mono text-xs uppercase tracking-wider">
              {t('workspaceSwitcher.heading')}
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
                      'hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none',
                      'disabled:pointer-events-none disabled:opacity-50',
                      isActive && 'bg-(--el-surface)',
                    )}
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                      {isActive ? (
                        <Check className="h-4 w-4" style={{ color: 'var(--el-accent)' }} />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'flex-1 truncate font-sans text-sm text-(--el-text)',
                        isActive && 'font-semibold',
                      )}
                    >
                      {w.name}
                    </span>
                    {/* Role label = metadata → neutral tone (AA-safe; #35). */}
                    <Pill tone="neutral">{tl('role.member')}</Pill>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="my-1 h-px bg-(--el-border)" />
          <div className="px-1">
            <button
              type="button"
              onClick={openCreate}
              className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
            >
              <Plus className="text-(--el-text-muted) h-4 w-4" aria-hidden />
              {t('workspaceSwitcher.create')}
            </button>
          </div>
          <div className="my-1 h-px bg-(--el-border)" />
          <div className="px-1 pb-1">
            <a
              href="/settings/workspace#members"
              onClick={() => setOpen(false)}
              className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
            >
              <Mail className="text-(--el-text-muted) h-4 w-4" aria-hidden />
              {t('workspaceSwitcher.invite')}
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
  const t = useTranslations('shell');
  const tc = useTranslations('common');
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('workspaceSwitcher.create')} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <Input
          label={t('workspaceSwitcher.nameLabel')}
          placeholder={t('workspaceSwitcher.namePlaceholder')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" type="submit" loading={pending} disabled={!value.trim()}>
            {t('workspaceSwitcher.submit')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
