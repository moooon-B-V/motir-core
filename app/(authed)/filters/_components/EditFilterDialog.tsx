'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { VisibilityRadioCards } from './VisibilityRadioCards';
import {
  ApiError,
  updateFilter,
  type SavedFilterSummaryDto,
  type Viewer,
} from './savedFiltersClient';

// Edit-details dialog (Story 6.2 · Subtask 6.2.4) — name / description /
// visibility, per design/work-items/saved-filters.mock.html panel 1 (reused
// for the directory's "Edit details" action). The owner-overwrite of the
// CRITERIA is the /items-side Save (6.2.3); here we edit metadata only. A
// duplicate name surfaces the designed inline error (the 6.2.1 409); flipping
// Project → Private shows the go-private consequences note.

type Visibility = 'private' | 'project';

export function EditFilterDialog({
  projectKey,
  viewer,
  filter,
  onClose,
  onSaved,
}: {
  projectKey: string;
  viewer: Viewer;
  filter: SavedFilterSummaryDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('savedFilters');
  const { toast } = useToast();
  const nameId = useId();
  const descId = useId();

  const [name, setName] = useState(filter.name);
  const [description, setDescription] = useState(filter.description ?? '');
  const [visibility, setVisibility] = useState<Visibility>(filter.visibility);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const goingPrivate = filter.visibility === 'project' && visibility === 'private';

  async function save() {
    setNameError(null);
    setSaving(true);
    try {
      await updateFilter(projectKey, filter.id, {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        visibility,
      });
      toast({ variant: 'success', title: t('edit.savedToast') });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SAVED_FILTER_NAME_CONFLICT') {
        setNameError(t('edit.duplicateName', { name: name.trim() }));
      } else {
        toast({
          variant: 'error',
          title: t('edit.errorTitle'),
          description: t('edit.errorGeneric'),
        });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('edit.title')}
      size="md"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving && name.trim()) void save();
        }}
      >
        {/* Name, description, the two visibility cards and — when a shared
            filter is being made private — the go-private note stack to ~700px
            at a 700px-tall viewport, past the panel's 90vh cap; as a bare
            `<form>` the footer was clipped outside the panel with no scrollbar
            (MOTIR-2491, measured at 1280×700). `Modal.Body` owns the scroll
            recipe; the footer stays pinned and inside the form. */}
        <Modal.Body className="gap-4">
          <Input
            id={nameId}
            label={t('edit.nameLabel')}
            placeholder={t('edit.namePlaceholder')}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            error={nameError ?? undefined}
            errorVariant="box"
            autoFocus
            required
          />
          <Textarea
            id={descId}
            label={t('edit.descriptionLabel')}
            placeholder={t('edit.descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
          <VisibilityRadioCards
            value={visibility}
            onChange={setVisibility}
            canShare={viewer.canShare || filter.visibility === 'project'}
            legend={t('edit.visibilityLegend')}
          />
          {goingPrivate ? (
            <p className="rounded-(--radius-card) bg-(--el-tint-peach) px-3 py-2 text-xs text-(--el-text-strong)">
              {t('edit.goPrivateNote')}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('edit.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>
            {t('edit.save')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
