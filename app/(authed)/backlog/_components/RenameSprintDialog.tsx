'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';

// Rename-sprint dialog (bug MOTIR-1493 — the sprint `⋯` menu's Rename action; the
// menu was enabled + Delete wired in MOTIR-1492, rename lands here as the sibling
// the design-notes enumerate: "`⋯` menu — sprint actions (rename · edit dates ·
// delete · start)"). The backend already ships — `sprintsService.updateSprint`
// takes `name` (`validateName`), a `complete` sprint is frozen — and
// `PATCH /api/sprints/[id]` accepts `{ name }`; the ONLY gap was UI, so this is a
// thin dialog over that route. Reuses the shipped `Modal` (focus-trapped, Radix),
// the `Input` primitive (which composes `FormField`'s label + error stack), and
// `Button` — colour via `--el-*`, shape via element-semantic tokens; error
// treatments are text + `--el-danger`, never colour alone (finding #35). Mirrors
// the sibling `DeleteSprintDialog` structure (open modal → confirm → route call →
// success toast → parent refetch).

export interface RenameSprintDialogProps {
  sprint: SprintDto;
  onClose: () => void;
  /** Run after a successful rename — the backlog refetches its `/api/sprints`
   *  metadata so the new name re-renders across the sprint header + its region
   *  aria-label (the page-state-after-mutation contract: the sprint list is a
   *  client island seeded once, so it needs an explicit refetch, not
   *  `router.refresh()`). */
  onRenamed: () => void | Promise<void>;
}

export function RenameSprintDialog({ sprint, onClose, onRenamed }: RenameSprintDialogProps) {
  const t = useTranslations('backlog');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const [name, setName] = useState(sprint.name);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const trimmed = name.trim();
  // Save is inert until the name is non-empty AND actually changed — a no-op
  // rename should not round-trip (mirrors the `validateName` empty guard the
  // service enforces, surfaced client-side so the button reflects it).
  const canSave = trimmed.length > 0 && trimmed !== sprint.name && !saving;

  async function confirm() {
    if (!canSave) return;
    setSaving(true);
    setFieldError(null);
    try {
      const res = await fetch(`/api/sprints/${sprint.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        // An empty name is guarded client-side, but keep the server verdict as a
        // field-level error backstop; the other codes are surfaced as a toast.
        if (data.code === 'INVALID_SPRINT_NAME') {
          setFieldError(t('renameSprintFlow.errorEmpty'));
          setSaving(false);
          return;
        }
        const description =
          data.code === 'NOT_SPRINT_ADMIN'
            ? t('renameSprintFlow.errorNotAdmin')
            : data.code === 'CANNOT_MODIFY_COMPLETED_SPRINT'
              ? t('renameSprintFlow.errorCompleted')
              : t('renameSprintFlow.errorDescription');
        toast({ variant: 'error', title: t('renameSprintFlow.errorTitle'), description });
        setSaving(false);
        return;
      }
      toast({
        variant: 'success',
        title: t('renameSprintFlow.renamedToast', { name: trimmed }),
      });
      await onRenamed();
      onClose();
    } catch {
      toast({
        variant: 'error',
        title: t('renameSprintFlow.errorTitle'),
        description: t('renameSprintFlow.errorDescription'),
      });
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('renameSprintFlow.title')}
      size="md"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <Input
          label={t('renameSprintFlow.label')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (fieldError) setFieldError(null);
          }}
          error={fieldError ?? undefined}
          autoFocus
          maxLength={120}
          data-testid={`sprint-rename-input-${sprint.id}`}
        />

        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>
            {tc('save')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
