'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import type { TokenScopeOrgDTO } from '@/lib/dto/apiTokens';
import { DEFAULT_TOKEN_SCOPES, type TokenScope } from '@/lib/mcp/scopes';
import { createToken, type ApiTokenDto, type ExpiryChoice } from './apiTokensClient';
import { scopesInGroup, type ScopeGroup, type ScopeMeta } from './scopeMeta';

// Create + shown-once modal (Story 7.8 · Subtask 7.8.3, + bug 7.21 binding scope,
// + Subtask 7.7.19 permission scopes) — design `account-settings.mock.html`
// Panels 4 + 5 and `token-scopes.mock.html` Panels 1–3. ONE Modal, two phases:
//   * FORM — a label Input + the BINDING-scope picker (organization → workspace
//     the token is bound to, bug 7.21) + an expiry Combobox (default 90 days) +
//     the PERMISSION-scope picker (7.7.18): grouped Switch toggles for the six
//     7.7.16 capabilities, default ALL-ON-EXCEPT-DELETE, the delete scope in its
//     own rose danger row. The two senses of "scope" are distinct: BINDING scope
//     = WHERE the token acts (workspace); PERMISSION scope = WHAT it may DO. The
//     binding picker pre-selects the active org+workspace and is progressively
//     disclosed (single org/workspace → read-only, the lone workspace reads
//     "Default"; ≥2 → Comboboxes). The wide (~42rem) modal shows all six
//     permission scopes at once — width, not scroll (Yue, 2026-06-16). The CTA
//     needs a non-empty label, a selected workspace, AND ≥1 permission scope.
//   * SHOWN-ONCE — after the create POST returns the plaintext secret (7.8.1
//     returns it exactly once), the modal flips to a read-only monospace secret
//     field + Copy + the peach one-time warning. "Done" closes; the secret is
//     wiped on close and never shown again.
// On a successful create the new row (carrying its granted scopes) is handed
// back via `onCreated` so the island inserts it OPTIMISTICALLY (the
// page-state-after-mutation contract).

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
  const permLabelId = useId();

  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<ExpiryValue>('90');
  const [scope, setScope] = useState(() => initialScope(scopeOrgs, activeWorkspaceId));
  // The granted PERMISSION scopes (7.7.16) — default all-on-except-delete.
  const [grantedScopes, setGrantedScopes] = useState<Set<TokenScope>>(
    () => new Set(DEFAULT_TOKEN_SCOPES),
  );
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

  // Toggle one permission scope on/off (immutable Set update for React).
  function toggleScope(s: TokenScope) {
    setGrantedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function close() {
    onOpenChange(false);
    // Reset so the secret never lingers and the next open starts clean.
    setLabel('');
    setExpiry('90');
    setScope(initialScope(scopeOrgs, activeWorkspaceId));
    setGrantedScopes(new Set(DEFAULT_TOKEN_SCOPES));
    setSecret(null);
    setCreating(false);
  }

  async function submit() {
    const trimmed = label.trim();
    // A token must grant at least one permission (7.7.18 Panel 3).
    if (!trimmed || !scope.workspaceId || grantedScopes.size === 0 || creating) return;
    setCreating(true);
    try {
      const result = await createToken({
        label: trimmed,
        expiresInDays: EXPIRY_DAYS[expiry],
        workspaceId: scope.workspaceId,
        scopes: [...grantedScopes],
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

  // One permission-scope row — icon + name + one-line description on the left,
  // its Switch on the right. The delete scope renders as its OWN rose danger row
  // (7.7.18): rose tint + danger glyph + a "· Danger" tag + AA-strong copy, set
  // apart so granting irreversible deletion is a deliberate, visible act. These
  // are render helpers (plain functions, not nested components) so they close
  // over `grantedScopes` / `toggleScope` / `t` without remounting on each keystroke.
  function renderScopeRow(meta: ScopeMeta) {
    const checked = grantedScopes.has(meta.scope);
    const name = t(`scopes.${meta.i18nKey}.name`);
    const desc = t(`scopes.${meta.i18nKey}.desc`);
    const Icon = meta.Icon;
    if (meta.danger) {
      return (
        <div
          key={meta.scope}
          className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y)"
        >
          <div className="flex items-start gap-2.5">
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-(--el-danger)" />
            <div className="min-w-0 flex-1">
              <span className="font-sans text-sm font-medium text-(--el-text-strong)">
                {name}{' '}
                <span className="font-mono text-[0.625rem] tracking-wide text-(--el-danger) uppercase">
                  {t('scopes.dangerTag')}
                </span>
              </span>
              <p className="mt-0.5 font-sans text-xs text-(--el-text-strong)">{desc}</p>
            </div>
            <Switch
              checked={checked}
              onCheckedChange={() => toggleScope(meta.scope)}
              aria-label={name}
            />
          </div>
        </div>
      );
    }
    return (
      <div key={meta.scope} className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-(--el-text-muted)" />
        <div className="min-w-0 flex-1">
          <span className="font-sans text-sm font-medium text-(--el-text)">{name}</span>
          <p className="mt-0.5 font-sans text-xs text-(--el-text-muted)">{desc}</p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={() => toggleScope(meta.scope)}
          aria-label={name}
        />
      </div>
    );
  }

  // One capability group — a mono/uppercase caption over its hairline-separated
  // safe rows, then any danger row (its own card) below.
  function renderScopeGroup(group: ScopeGroup) {
    const metas = scopesInGroup(group);
    const safe = metas.filter((m) => !m.danger);
    const danger = metas.filter((m) => m.danger);
    return (
      <div key={group} className="flex flex-col gap-2">
        <div className="font-mono text-[0.625rem] tracking-wide text-(--el-text-faint) uppercase">
          {t(`scopes.groupLabels.${group}`)}
        </div>
        {safe.length > 0 ? (
          <div className="divide-y divide-(--el-border-soft)">{safe.map(renderScopeRow)}</div>
        ) : null}
        {danger.map(renderScopeRow)}
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (!o ? close() : undefined)}
      title={shown ? t('created.title') : t('createModal.title')}
      description={shown ? t('created.description') : t('createModal.description')}
      size="md"
      // The form phase WIDENS to ~42rem so all six permission scopes show at
      // once — width, not scroll (Yue, 2026-06-16). The shown-once phase keeps
      // the 7.7.2 `md` width. tailwind-merge lets this className override the
      // size variant's `max-w`.
      className={shown ? undefined : 'max-w-[42rem]'}
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
          {/* BINDING scope — the organization → workspace this token is bound to
              (bug 7.21). When the account spans ≥2 orgs the org picker leads as a
              full-width row; otherwise the lone org is implicit and only the
              Workspace (reading "Default") + Expires pair shows. */}
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
          ) : null}
          {/* Workspace + Expires pair up side by side (the design's `.meta-cols`,
              Yue 2026-06-16) — using the wide modal's width and saving a row. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
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
          </div>
          {/* PERMISSION scopes (7.7.18) — what the token may DO. Grouped Switch
              toggles in a 2-column grid (all six visible at once); default
              all-on-except-delete; the delete scope as its own rose danger row.
              A token must grant ≥1 permission (the empty-scope error + CTA gate). */}
          <div className="flex flex-col gap-2">
            <span id={permLabelId} className="font-sans text-sm font-medium text-(--el-text)">
              {t('scopes.permissionsLabel')}
            </span>
            <span className="font-sans text-xs text-(--el-text-muted)">
              {t('scopes.permissionsHelper')}
            </span>
            <div
              role="group"
              aria-labelledby={permLabelId}
              className="mt-1 grid grid-cols-2 gap-x-6 gap-y-4"
            >
              <div className="flex flex-col gap-4">
                {renderScopeGroup('read')}
                {renderScopeGroup('sprints')}
                {renderScopeGroup('integrations')}
              </div>
              <div className="flex flex-col gap-4">{renderScopeGroup('workItems')}</div>
            </div>
            {grantedScopes.size === 0 ? (
              <p
                role="alert"
                className="mt-1 flex items-center gap-1.5 font-sans text-xs text-(--el-danger)"
              >
                <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                {t('scopes.emptyError')}
              </p>
            ) : null}
          </div>
          <Modal.Footer>
            <Button type="button" variant="ghost" onClick={close} disabled={creating}>
              {t('createModal.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={creating}
              disabled={!label.trim() || !scope.workspaceId || grantedScopes.size === 0}
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
