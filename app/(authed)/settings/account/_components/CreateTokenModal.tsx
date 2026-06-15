'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import { createToken, type ApiTokenDto, type ExpiryChoice } from './apiTokensClient';

// Create + shown-once modal (Story 7.8 · Subtask 7.8.3) — design
// `account-settings.mock.html` Panels 4 + 5. ONE Modal, two phases:
//   * FORM — a label Input + an expiry Combobox (30 / 90 / 365 days / Never,
//     default 90); the primary CTA is disabled until a non-empty label.
//   * SHOWN-ONCE — after the create POST returns the plaintext secret (7.8.1
//     returns it exactly once), the modal flips to a read-only monospace secret
//     field + Copy + the peach one-time warning. "Done" closes; the secret is
//     wiped on close and never shown again.
// On a successful create the new row is handed back via `onCreated` so the
// island inserts it OPTIMISTICALLY (the page-state-after-mutation contract).

type ExpiryValue = '30' | '90' | '365' | 'never';

const EXPIRY_DAYS: Record<ExpiryValue, ExpiryChoice> = {
  '30': 30,
  '90': 90,
  '365': 365,
  never: null,
};

export function CreateTokenModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: ApiTokenDto) => void;
}) {
  const t = useTranslations('settings.apiTokens');
  const { toast } = useToast();
  const labelId = useId();
  const expiryId = useId();

  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<ExpiryValue>('90');
  const [creating, setCreating] = useState(false);
  // Non-null once the token is minted — flips the modal to the shown-once phase.
  const [secret, setSecret] = useState<string | null>(null);

  const expiryOptions: ComboboxOption<ExpiryValue>[] = [
    { value: '30', label: t('expiry.d30') },
    { value: '90', label: t('expiry.d90') },
    { value: '365', label: t('expiry.d365') },
    { value: 'never', label: t('expiry.never') },
  ];

  function close() {
    onOpenChange(false);
    // Reset so the secret never lingers and the next open starts clean.
    setLabel('');
    setExpiry('90');
    setSecret(null);
    setCreating(false);
  }

  async function submit() {
    const trimmed = label.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const result = await createToken({ label: trimmed, expiresInDays: EXPIRY_DAYS[expiry] });
      onCreated(result.dto);
      setSecret(result.token);
    } catch {
      toast({
        variant: 'error',
        title: t('createModal.errorTitle'),
        description: t('createModal.errorGeneric'),
      });
      setCreating(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast({ variant: 'success', title: t('toast.title'), description: t('toast.body') });
    } catch {
      toast({ variant: 'error', title: t('createModal.copyFailed') });
    }
  }

  const shown = secret !== null;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (!o ? close() : undefined)}
      title={shown ? t('created.title') : t('createModal.title')}
      description={shown ? t('created.description') : t('createModal.description')}
      size="md"
    >
      {shown ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-sm font-medium text-(--el-text)">
              {t('created.secretLabel')}
            </span>
            <div className="flex items-stretch gap-2">
              <code
                data-testid="api-token-secret"
                className="min-w-0 flex-1 overflow-x-auto rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) px-(--spacing-input-x) py-(--spacing-input-y) font-mono text-xs leading-relaxed text-(--el-text)"
              >
                {secret}
              </code>
              <Button
                type="button"
                variant="secondary"
                leftIcon={<Copy className="size-4" />}
                onClick={() => void copySecret()}
              >
                {t('created.copy')}
              </Button>
            </div>
          </div>
          <div className="flex gap-3 rounded-(--radius-card) bg-(--el-tint-peach) p-(--spacing-card-padding)">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-(--el-warning)" />
            <p className="font-sans text-sm text-(--el-text-strong)">{t('created.warning')}</p>
          </div>
          <Modal.Footer>
            <Button type="button" variant="primary" onClick={close}>
              {t('created.done')}
            </Button>
          </Modal.Footer>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            id={labelId}
            label={t('createModal.labelField')}
            helperText={t('createModal.labelHelper')}
            placeholder={t('createModal.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
            required
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={expiryId} className="font-sans text-sm font-medium text-(--el-text)">
              {t('createModal.expiresField')}
            </label>
            <Combobox
              id={expiryId}
              label={t('createModal.expiresField')}
              options={expiryOptions}
              value={expiry}
              onChange={setExpiry}
            />
            <span className="font-sans text-xs text-(--el-text-muted)">
              {t('createModal.expiresHelper')}
            </span>
          </div>
          <Modal.Footer>
            <Button type="button" variant="ghost" onClick={close} disabled={creating}>
              {t('createModal.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={creating} disabled={!label.trim()}>
              {t('createModal.submit')}
            </Button>
          </Modal.Footer>
        </form>
      )}
    </Modal>
  );
}
