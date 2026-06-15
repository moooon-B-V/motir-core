'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import type { TokenScopeOrgDTO } from '@/lib/dto/apiTokens';
import { createToken, type ApiTokenDto, type ExpiryChoice } from './apiTokensClient';

// Create + shown-once modal (Story 7.8 · Subtask 7.8.3, + bug 7.21 scope) —
// design `account-settings.mock.html` Panels 4 + 5. ONE Modal, two phases:
//   * FORM — a label Input + the SCOPE picker (organization → workspace the
//     token is bound to, bug 7.21) + an expiry Combobox (default 90 days). The
//     scope pre-selects the active org+workspace and is progressively disclosed:
//     a single org / single workspace shows as a read-only field (the lone
//     workspace reads "Default"); ≥2 are Comboboxes. The CTA needs a non-empty
//     label + a selected workspace.
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

/** The org + workspace the scope picker opens on: the one containing the active
 * workspace, else the first org's first workspace. */
function initialScope(
  scopeOrgs: TokenScopeOrgDTO[],
  activeWorkspaceId: string | null,
): { orgId: string; workspaceId: string } {
  for (const org of scopeOrgs) {
    if (org.workspaces.some((w) => w.id === activeWorkspaceId)) {
      return { orgId: org.id, workspaceId: activeWorkspaceId as string };
    }
  }
  const first = scopeOrgs[0];
  return { orgId: first?.id ?? '', workspaceId: first?.workspaces[0]?.id ?? '' };
}

export function CreateTokenModal({
  open,
  onOpenChange,
  onCreated,
  scopeOrgs,
  activeWorkspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: ApiTokenDto) => void;
  scopeOrgs: TokenScopeOrgDTO[];
  activeWorkspaceId: string | null;
}) {
  const t = useTranslations('settings.apiTokens');
  const { toast } = useToast();
  const labelId = useId();
  const expiryId = useId();
  const orgFieldId = useId();
  const workspaceFieldId = useId();

  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<ExpiryValue>('90');
  const [scope, setScope] = useState(() => initialScope(scopeOrgs, activeWorkspaceId));
  const [creating, setCreating] = useState(false);
  // Non-null once the token is minted — flips the modal to the shown-once phase.
  const [secret, setSecret] = useState<string | null>(null);

  const expiryOptions: ComboboxOption<ExpiryValue>[] = [
    { value: '30', label: t('expiry.d30') },
    { value: '90', label: t('expiry.d90') },
    { value: '365', label: t('expiry.d365') },
    { value: 'never', label: t('expiry.never') },
  ];

  const multiOrg = scopeOrgs.length > 1;
  const selectedOrg = useMemo(
    () => scopeOrgs.find((o) => o.id === scope.orgId) ?? scopeOrgs[0],
    [scopeOrgs, scope.orgId],
  );
  const workspaces = selectedOrg?.workspaces ?? [];
  const multiWorkspace = workspaces.length > 1;
  const orgOptions: ComboboxOption<string>[] = scopeOrgs.map((o) => ({
    value: o.id,
    label: o.name,
  }));
  const workspaceOptions: ComboboxOption<string>[] = workspaces.map((w) => ({
    value: w.id,
    label: w.name,
  }));

  // Switching org re-homes the workspace to that org's first one (a workspace
  // belongs to exactly one org), so the bound workspace is always valid.
  function handleOrgChange(nextOrgId: string) {
    const org = scopeOrgs.find((o) => o.id === nextOrgId);
    setScope({ orgId: nextOrgId, workspaceId: org?.workspaces[0]?.id ?? '' });
  }

  function close() {
    onOpenChange(false);
    // Reset so the secret never lingers and the next open starts clean.
    setLabel('');
    setExpiry('90');
    setScope(initialScope(scopeOrgs, activeWorkspaceId));
    setSecret(null);
    setCreating(false);
  }

  async function submit() {
    const trimmed = label.trim();
    if (!trimmed || !scope.workspaceId || creating) return;
    setCreating(true);
    try {
      const result = await createToken({
        label: trimmed,
        expiresInDays: EXPIRY_DAYS[expiry],
        workspaceId: scope.workspaceId,
      });
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
          {/* Scope — the organization → workspace this token is bound to (bug
              7.21). Pre-selects the active org+workspace; a single org / single
              workspace shows read-only (the lone workspace reads "Default"). */}
          {multiOrg ? (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor={orgFieldId}
                className="font-sans text-sm font-medium text-(--el-text)"
              >
                {t('createModal.orgField')}
              </label>
              <Combobox
                id={orgFieldId}
                label={t('createModal.orgField')}
                options={orgOptions}
                value={scope.orgId}
                onChange={handleOrgChange}
              />
            </div>
          ) : (
            <ReadonlyField
              id={orgFieldId}
              label={t('createModal.orgField')}
              value={selectedOrg?.name ?? ''}
            />
          )}
          <div className="flex flex-col gap-1.5">
            {multiWorkspace ? (
              <>
                <label
                  htmlFor={workspaceFieldId}
                  className="font-sans text-sm font-medium text-(--el-text)"
                >
                  {t('createModal.workspaceField')}
                </label>
                <Combobox
                  id={workspaceFieldId}
                  label={t('createModal.workspaceField')}
                  options={workspaceOptions}
                  value={scope.workspaceId}
                  onChange={(wid) => setScope((s) => ({ ...s, workspaceId: wid }))}
                />
              </>
            ) : (
              <ReadonlyField
                id={workspaceFieldId}
                label={t('createModal.workspaceField')}
                value={t('createModal.defaultWorkspace')}
              />
            )}
            <span className="font-sans text-xs text-(--el-text-muted)">
              {t('createModal.scopeHelper')}
            </span>
          </div>
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
            <Button
              type="submit"
              variant="primary"
              loading={creating}
              disabled={!label.trim() || !scope.workspaceId}
            >
              {t('createModal.submit')}
            </Button>
          </Modal.Footer>
        </form>
      )}
    </Modal>
  );
}

/** A labelled, read-only field styled like the form's inputs — used for the
 * scope fields when there's only one organization / workspace to pick (bug
 * 7.21: a single workspace reads "Default"). */
function ReadonlyField({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-sans text-sm font-medium text-(--el-text)">
        {label}
      </label>
      <div
        id={id}
        className="flex h-(--height-input) items-center rounded-(--radius-input) border border-(--el-border) bg-(--el-muted) px-(--spacing-input-x) font-sans text-sm text-(--el-text-secondary)"
      >
        {value}
      </div>
    </div>
  );
}
