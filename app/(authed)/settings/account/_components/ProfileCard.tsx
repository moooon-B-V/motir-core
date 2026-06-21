'use client';

import { useState, useTransition, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { AvatarField } from './AvatarField';
import { updateProfileNameAction } from '../profile/actions';

// The "Profile" card on the Account › Profile pane (Story 8.8 · Subtask 8.8.24,
// the scaffold). Renders the personal-details rows in the settings-row grammar
// (label + description left, control right, hairline-separated) per
// `design/settings/profile.mock.html`. This scaffold owns the NAME row (inline
// edit, wired to usersService.updateProfile via updateProfileNameAction) and the
// EMAIL row (display). The Photo row (AvatarField, 8.8.24a) composes in ABOVE
// Name; the remaining sibling slices compose INTO this card too: the "Change
// email" control (8.8.24b) on the Email row, and the "Password & security" card
// (8.8.24c) below this one.
//
// Page-state contract (CLAUDE.md): the name cell is a client island holding its
// own optimistic state, so on save we KEEP the returned value here (no revert)
// AND call router.refresh() — the only surface that needs it is the SERVER-
// rendered rail identity header (AccountSidebarHeader), which re-reads the new
// name. router.refresh() cannot reach this island's useState, so the cell is safe.

export interface ProfileCardProps {
  initialName: string;
  initialImage: string | null;
  email: string;
}

export function ProfileCard({ initialName, initialImage, email }: ProfileCardProps) {
  const t = useTranslations('settings.profile');
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState(initialName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function startEdit() {
    setDraft(name);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
  }

  function save() {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError(t('name.empty'));
      return;
    }
    if (trimmed === name) {
      cancel();
      return;
    }
    startTransition(async () => {
      const result = await updateProfileNameAction(trimmed);
      if (result.ok) {
        setName(result.name);
        setEditing(false);
        setError(null);
        toast({ variant: 'success', title: t('name.saved') });
        // Update the server-rendered rail identity header; the island keeps its
        // own optimistic `name` (router.refresh can't reach useState).
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }

  return (
    <Card
      header={
        <div>
          <h3 className="font-sans text-base font-semibold text-(--el-text)">{t('card.title')}</h3>
          <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">{t('card.subtitle')}</p>
        </div>
      }
    >
      {/* Photo row — avatar upload + remove (slice 8.8.24a). */}
      <AvatarField initialImage={initialImage} name={name} />

      {/* Name row — display value + inline edit. */}
      <div className="flex items-start justify-between gap-4 border-t border-(--el-border-soft) pb-4 pt-4">
        <div className="min-w-0">
          <div className="font-sans text-sm font-medium text-(--el-text)">{t('name.label')}</div>
          <div className="mt-0.5 font-sans text-xs leading-snug text-(--el-text-muted)">
            {t('name.desc')}
          </div>
        </div>
        {editing ? (
          <div className="flex shrink-0 items-start gap-2">
            <div className="w-[15rem]">
              <Input
                aria-label={t('name.label')}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={onKeyDown}
                error={error ?? undefined}
                disabled={isPending}
                autoFocus
              />
            </div>
            <Button variant="primary" size="sm" onClick={save} loading={isPending}>
              {t('name.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel} disabled={isPending}>
              {t('name.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="font-sans text-sm text-(--el-text)">{name}</span>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
              onClick={startEdit}
            >
              {t('name.edit')}
            </Button>
          </div>
        )}
      </div>

      {/* Email row — display only; the "Change email" control is slice 8.8.24b. */}
      <div className="flex items-center justify-between gap-4 border-t border-(--el-border-soft) pt-4">
        <div className="min-w-0">
          <div className="font-sans text-sm font-medium text-(--el-text)">{t('email.label')}</div>
          <div className="mt-0.5 font-sans text-xs leading-snug text-(--el-text-muted)">
            {t('email.desc')}
          </div>
        </div>
        <span className="shrink-0 font-sans text-sm text-(--el-text)">{email}</span>
      </div>
    </Card>
  );
}
