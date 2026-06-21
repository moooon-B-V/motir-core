'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { VisibilityRadioCards } from '@/app/(authed)/filters/_components/VisibilityRadioCards';
import {
  ApiError,
  createFilter,
  type SavedFilterSummaryDto,
  type Viewer,
} from '@/app/(authed)/filters/_components/savedFiltersClient';

// The save / Save-as dialog (Story 6.2 · Subtask 6.2.3) — name / description /
// visibility, per design/work-items/saved-filters.mock.html panel 1. It POSTs
// the CURRENT builder AST (the `?filter=v1:` param) as a NEW saved-filter row
// (one codec, two carriers). "Save as" always opens this — for a fresh filter,
// or to fork an applied one (prefilled with the source name). The owner's
// in-place overwrite-Save (the 6.2.1 PATCH) shows no dialog and lives on the
// applied chip; this dialog only ever CREATES.
//
// Default visibility is Private (the safe default; the Jira default share). A
// duplicate name surfaces the designed inline error (the 6.2.1 409 — per-project
// case-insensitive); the primary is disabled until it clears. The viewer's
// Project card renders visible-but-disabled under the info note (VisibilityRadio-
// Cards owns that, the 6.4.6 affordance rule).

type Visibility = 'private' | 'project';

export function SaveFilterDialog({
  projectKey,
  viewer,
  filterParam,
  initialName = '',
  onClose,
  onSaved,
}: {
  projectKey: string;
  viewer: Viewer;
  /** The `?filter=v1:` param of the current builder AST to persist. */
  filterParam: string;
  /** Prefill (the source filter's name when forking via Save as). */
  initialName?: string;
  onClose: () => void;
  onSaved: (filter: SavedFilterSummaryDto) => void;
}) {
  const t = useTranslations('savedFilters');
  const { toast } = useToast();
  const nameId = useId();
  const descId = useId();

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setNameError(null);
    setSaving(true);
    try {
      const created = await createFilter(projectKey, {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        visibility,
        filter: filterParam,
      });
      toast({ variant: 'success', title: t('save.savedToast') });
      onSaved(created);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SAVED_FILTER_NAME_CONFLICT') {
        setNameError(t('save.duplicateName', { name: name.trim() }));
      } else {
        toast({
          variant: 'error',
          title: t('save.errorTitle'),
          description: t('save.errorGeneric'),
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
      title={t('save.title')}
      size="md"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving && name.trim()) void save();
        }}
      >
        <Input
          id={nameId}
          label={t('save.nameLabel')}
          placeholder={t('save.namePlaceholder')}
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
          label={t('save.descriptionLabel')}
          placeholder={t('save.descriptionPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
        <VisibilityRadioCards
          value={visibility}
          onChange={setVisibility}
          canShare={viewer.canShare}
          legend={t('save.visibilityLegend')}
        />

        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('save.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>
            {t('save.submit')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
