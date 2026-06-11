'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import {
  ApiError,
  changeOwner,
  listProjectMembers,
  type ProjectMemberOption,
  type SavedFilterSummaryDto,
} from './savedFiltersClient';

// Change-owner dialog (Story 6.2 · Subtask 6.2.4, admin tier) — reuses the
// 6.4.1 add-member Combobox grammar (referenced, not redrawn) over the
// project's members, per design/work-items/saved-filters.mock.html panel 3.
// The new owner must be able to browse the project; the 6.2.1 service rejects
// an ineligible target (422 INVALID_SAVED_FILTER_OWNER) — surfaced inline.

export function ChangeOwnerDialog({
  projectKey,
  filter,
  onClose,
  onSaved,
}: {
  projectKey: string;
  filter: SavedFilterSummaryDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('savedFilters');
  const { toast } = useToast();

  const [members, setMembers] = useState<ProjectMemberOption[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    listProjectMembers(projectKey)
      .then((list) => {
        if (active) setMembers(list.filter((m) => m.userId !== filter.owner.id));
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [projectKey, filter.owner.id]);

  const options: ComboboxOption<string>[] = (members ?? []).map((m) => ({
    value: m.userId,
    label: m.name,
    secondary: m.email,
    keywords: m.email,
  }));

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await changeOwner(projectKey, filter.id, selected);
      toast({
        variant: 'success',
        title: t('changeOwnerDialog.savedToast', { name: updated.owner.name }),
      });
      onSaved();
    } catch (err) {
      const invalid = err instanceof ApiError && err.code === 'INVALID_SAVED_FILTER_OWNER';
      toast({
        variant: 'error',
        title: t('changeOwnerDialog.errorTitle'),
        description: invalid
          ? t('changeOwnerDialog.errorInvalidOwner')
          : t('changeOwnerDialog.errorGeneric'),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('changeOwnerDialog.title', { name: filter.name })}
      description={t('changeOwnerDialog.description')}
      size="md"
    >
      <div className="flex flex-col gap-4">
        <Combobox
          options={options}
          value={selected}
          onChange={setSelected}
          label={t('changeOwnerDialog.pickerLabel')}
          placeholder={t('changeOwnerDialog.pickerPlaceholder')}
          searchable
          loading={members === null && !loadError}
        />
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('changeOwnerDialog.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={saving}
            disabled={!selected}
            onClick={() => void save()}
          >
            {t('changeOwnerDialog.save')}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}
