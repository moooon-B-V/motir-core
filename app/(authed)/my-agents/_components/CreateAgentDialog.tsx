'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { RefusalBox, type AgentRefusal } from './agentRefusal';

// THE CREATE DIALOG (MOTIR-6868 revision 3, panel 2): the name, the project fixed
// to the page's, the coding-agent picker — exactly the six offered profiles, in
// order, each with the one line on the sign-in it will ask for — and the price
// line. Create's pending state is the button's own; a refusal lands in the dialog
// above its footer, and the dialog stays open with the input kept.

export interface OfferedProfile {
  id: string;
  name: string;
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  projectName,
  profiles,
  pending,
  refusal,
  storageCreditsPerDay = null,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  profiles: readonly OfferedProfile[];
  pending: boolean;
  refusal: AgentRefusal | null;
  /** The storage rate (`agent-instance-storage.md` §2) on a cloud build; `null`
   *  where no storage is charged (self-hosted), which drops the price's storage clause. */
  storageCreditsPerDay?: number | null;
  onCreate: (input: { name: string; profileId: string }) => void;
}) {
  const t = useTranslations('myAgents.create');
  const tp = useTranslations('myAgents.profileLine');
  const [name, setName] = useState('');
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending || name.trim() === '' || profileId === '') return;
    onCreate({ name: name.trim(), profileId });
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="lg" title={t('title')}>
      <form onSubmit={submit} className="contents">
        <Modal.Body className="gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-name" className="text-sm font-semibold text-(--el-text)">
              {t('name')}
            </label>
            <Input
              id="agent-name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
              aria-describedby="agent-name-hint"
            />
            <p id="agent-name-hint" className="text-xs text-(--el-text-secondary)">
              {t('nameHint')}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-(--el-text)">{t('project')}</span>
            <span className="flex h-(--height-input) items-center rounded-(--radius-input) border border-(--el-border) bg-(--el-muted) px-(--spacing-input-x) text-sm text-(--el-text-secondary)">
              {projectName}
            </span>
            <p className="text-xs text-(--el-text-secondary)">{t('projectHint')}</p>
          </div>

          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-semibold text-(--el-text)">
              {t('codingAgent')}
            </legend>
            <div className="flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border)">
              {profiles.map((p) => {
                const on = p.id === profileId;
                return (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-start gap-3 border-b border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) last:border-b-0 ${
                      on ? 'bg-(--el-tint-lavender)' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="profileId"
                      value={p.id}
                      checked={on}
                      onChange={() => setProfileId(p.id)}
                      className="mt-1 accent-(--el-accent)"
                    />
                    <span className="flex flex-col">
                      <span className="text-sm font-semibold text-(--el-text)">{p.name}</span>
                      <span className="text-xs text-(--el-text-secondary)">{tp(p.id)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-(--el-text-secondary)">{t('vendorHint')}</p>
          </fieldset>

          <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)">
            <Info className="mt-0.5 size-4 flex-none" aria-hidden="true" />
            <span>
              {storageCreditsPerDay === null
                ? t.rich('price', { b: (chunks) => <strong>{chunks}</strong> })
                : t.rich('priceWithStorage', {
                    perDay: storageCreditsPerDay,
                    b: (chunks) => <strong>{chunks}</strong>,
                  })}
            </span>
          </div>

          {refusal ? <RefusalBox refusal={refusal} /> : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" loading={pending} disabled={name.trim() === ''}>
            {t('submit')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
