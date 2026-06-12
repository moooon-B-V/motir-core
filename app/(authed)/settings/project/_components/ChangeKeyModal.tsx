'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, Key, Link as LinkIcon } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import type { ProjectDTO } from '@/lib/dto/projects';
import { changeProjectKeyAction } from '../actions';

// The change-key modal (Story 6.8 · Subtask 6.8.4) — the guarded flow per
// `design/projects/details.mock.html` panel 3. The key is NOT a free-typing
// field on the card (a guard against an accidental whole-project re-key); this
// modal validates STRICTLY (`/^[A-Z0-9]{3,5}$/`, never coercing — the 6.8.1
// contract) and spells out the consequence verbatim. On submit the action runs
// the atomic 6.8.1 `changeKey` tx; its typed failure code maps to distinct copy
// (live collision vs reserved alias have distinct remedies). Success → toast +
// `router.refresh()` so every issue identifier re-renders without a reload.

const KEY_RE = /^[A-Z0-9]{3,5}$/;

export interface ChangeKeyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentKey: string;
  projectName: string;
  onSuccess?: (project: ProjectDTO) => void;
}

export function ChangeKeyModal({
  open,
  onOpenChange,
  currentKey,
  projectName,
  onSuccess,
}: ChangeKeyModalProps) {
  const t = useTranslations('settings.details');
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();
  const [value, setValue] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setValue('');
      setServerError(null);
    }
    onOpenChange(next);
  }

  const validFormat = KEY_RE.test(value);
  const isUnchanged = value === currentKey;
  // The optimistic "looks good" gate — format-valid + actually different.
  // Real availability is confirmed by the atomic tx on submit.
  const ready = validFormat && !isUnchanged;
  // Format error shows only once the user has typed enough to be wrong.
  const formatError = value.length > 0 && !validFormat ? t('errKeyFormat', { value }) : null;
  const shownError = serverError ?? formatError;

  function codeToMessage(code: string): string {
    switch (code) {
      case 'IDENTIFIER_TAKEN':
        return t('errKeyTaken', { value });
      case 'IDENTIFIER_RESERVED':
        return t('errKeyReserved', { value });
      case 'INVALID_IDENTIFIER':
        return t('errKeyFormat', { value });
      case 'IDENTIFIER_UNCHANGED':
        return t('errKeyUnchanged', { value });
      default:
        return t('errKeyUnknown');
    }
  }

  function handleSubmit() {
    if (!ready || isPending) return;
    setServerError(null);
    startTransition(async () => {
      const result = await changeProjectKeyAction(value);
      if (result.ok) {
        const newKey = result.project.identifier;
        handleOpenChange(false);
        toast({ variant: 'success', title: t('successToast', { newKey, oldKey: currentKey }) });
        onSuccess?.(result.project);
        router.refresh();
      } else {
        setServerError(codeToMessage(result.code));
      }
    });
  }

  return (
    <Modal open={open} onOpenChange={handleOpenChange} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="mb-3 flex items-center gap-3">
          <span
            aria-hidden
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-tint-lavender)"
          >
            <Key className="h-5 w-5 text-(--el-text-strong)" />
          </span>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">{t('modalTitle')}</h2>
        </div>
        <p className="mb-(--spacing-md) font-sans text-sm text-(--el-text-secondary)">
          {isPending ? t('inflightLede', { newKey: value }) : t('modalLede', { projectName })}
        </p>

        <Input
          label={t('newKeyLabel')}
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase());
            setServerError(null);
          }}
          error={shownError ?? undefined}
          className="font-mono uppercase tracking-wider"
          autoFocus
          disabled={isPending}
          maxLength={5}
          aria-label={t('newKeyLabel')}
        />

        {ready && !shownError && !isPending ? (
          <>
            <p
              role="status"
              className="mt-1.5 flex items-center gap-1.5 font-sans text-xs font-medium text-(--el-success)"
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              {t('available')}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
                <Check className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-success)" aria-hidden />
                <span>{t('consequenceIds', { newKey: value })}</span>
              </p>
              <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
                <LinkIcon
                  className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-text-muted)"
                  aria-hidden
                />
                <span>{t('consequenceLinks', { oldKey: currentKey })}</span>
              </p>
            </div>
          </>
        ) : null}

        <Modal.Footer>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={isPending}>
            {isPending ? t('changingKey') : t('changeKeyButton')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
