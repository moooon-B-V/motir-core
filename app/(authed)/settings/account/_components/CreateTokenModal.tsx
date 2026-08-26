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
import {
  permissionSlug,
  type PermissionDomain,
  type PermissionKey,
} from '@/lib/permissions/catalog';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createToken, type ApiTokenDto, type ExpiryChoice } from './apiTokensClient';
import { permissionColumnsForTokens, type PermissionMeta } from './permissionMeta';

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
//     WIDTH buys the scope grid; it does not buy HEIGHT. The fields therefore
//     live in `Modal.Body` and the footer is pinned beside it (MOTIR-2488):
//     the Modal panel is `max-h-[90vh] overflow-hidden`, so a bare <form> as
//     its flex child cannot shrink (`min-height: auto`) and the whole footer —
//     Cancel AND Create token — gets clipped outside the panel with no
//     scrollbar anywhere. This is the tallest form in the app and it grows
//     further on a ≥2-org / ≥2-workspace account, which is exactly the shape
//     the single-tenant E2E fixture never rendered.
//   * SHOWN-ONCE — after the create POST returns the plaintext secret (7.8.1
//     returns it exactly once), the modal flips to a read-only monospace secret
//     field + Copy + the peach one-time warning. "Done" closes; the secret is
//     wiped on close and never shown again. This phase is the ONLY moment the
//     secret is legible anywhere, so the field is sized and wrapped to show all
//     53 of its characters at every viewport (MOTIR-3545): the panel keeps the
//     form phase's 42rem rather than narrowing back to `md`, and the field
//     BREAKS at any character. The two halves are not interchangeable — width
//     answers the desktop reader, `break-all` answers the `w-[90vw]` floor a
//     narrow viewport imposes. See the comments at each.
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
  // The permission LABELS + DESCRIPTIONS are the shipped catalogue copy, so the

  // picker, the list row and the /device screen say the same words.

  const tp = useTranslations('permissions');

  const lockedWhy = t('scopes.lockedWhy');

  // The domain groups, split so each column carries half the ROWS — MOTIR-2578's

  // measured 3/3 composition. Balancing by group COUNT instead would put 4 rows

  // against 2 and make the modal taller than the asset was measured at.

  const [leftColumn, rightColumn] = permissionColumnsForTokens();
  const { toast } = useToast();
  const labelId = useId();
  const expiryId = useId();
  const orgFieldId = useId();
  const workspaceFieldId = useId();
  const projectFieldId = useId();
  const permLabelId = useId();

  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<ExpiryValue>('90');
  const [scope, setScope] = useState(() => initialScope(scopeOrgs, activeWorkspaceId));
  // The PROJECT the token binds to (MOTIR-2606). Required: a chosen grant must
  // name the project it applies to, because permissions resolve per project.
  const [projectId, setProjectId] = useState<string | null>(null);
  // The granted PERMISSION scopes (7.7.16) — default all-on-except-delete.
  const [grantedScopes, setGrantedScopes] = useState<Set<PermissionKey>>(
    () => new Set(DEFAULT_TOKEN_GRANT),
  );
  const [creating, setCreating] = useState(false);

  // The projects in the chosen workspace, and the OFFER for the chosen one —
  // shipped with the options, so switching project recomputes the picker with
  // no round-trip and the offer can never disagree with what `create` accepts.
  const projectsHere =
    scopeOrgs.flatMap((o) => o.workspaces).find((w) => w.id === scope.workspaceId)?.projects ?? [];
  const selectedProject = projectsHere.find((p) => p.id === projectId) ?? projectsHere[0] ?? null;
  const conferrable = new Set<PermissionKey>(selectedProject?.grantable ?? []);
  const projectOptions: ComboboxOption<string>[] = projectsHere.map((p) => ({
    value: p.id,
    label: `${p.key} — ${p.name}`,
  }));
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
  function toggleScope(s: PermissionKey) {
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
    setGrantedScopes(new Set(DEFAULT_TOKEN_GRANT));
    setSecret(null);
    setCreating(false);
  }

  async function submit() {
    const trimmed = label.trim();
    // A token must grant at least one permission (7.7.18 Panel 3).
    if (!trimmed || !scope.workspaceId || !selectedProject || creating) return;
    if (grantedScopes.size === 0) return;
    setCreating(true);
    try {
      const result = await createToken({
        label: trimmed,
        expiresInDays: EXPIRY_DAYS[expiry],
        workspaceId: scope.workspaceId,
        permissions: [...grantedScopes].filter((k) => conferrable.has(k)),
        projectId: selectedProject.id,
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
  function renderScopeRow(meta: PermissionMeta) {
    // A permission this actor cannot confer HERE is DISABLED with its reason,
    // never hidden (MOTIR-2578 panel 1c): a vanished row reads as a missing
    // feature and sends someone hunting, while a disabled one teaches the rule
    // the helper text already states. A workspace owner sees none of these.
    const locked = !conferrable.has(meta.key);
    const checked = grantedScopes.has(meta.key) && !locked;
    // ⚠️ The SHIPPED catalogue copy, not a table written for this screen — the
    // same strings Roles & permissions renders (MOTIR-2579/-2580).
    const name = tp(`${permissionSlug(meta.key)}.label`);
    const desc = tp(`${permissionSlug(meta.key)}.description`);
    const Icon = meta.Icon;
    if (meta.danger) {
      return (
        <div
          key={meta.key}
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
              disabled={locked}
              onCheckedChange={() => toggleScope(meta.key)}
              aria-label={name}
            />
          </div>
          {locked ? (
            <p className="mt-1 font-sans text-xs text-(--el-text-strong)">{lockedWhy}</p>
          ) : null}
        </div>
      );
    }
    return (
      <div key={meta.key} className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-(--el-text-muted)" />
        <div className="min-w-0 flex-1">
          <span
            className={`font-sans text-sm font-medium ${locked ? 'text-(--el-text-faint)' : 'text-(--el-text)'}`}
          >
            {name}
          </span>
          <p
            className={`mt-0.5 font-sans text-xs ${locked ? 'text-(--el-text-faint)' : 'text-(--el-text-muted)'}`}
          >
            {desc}
          </p>
          {locked ? (
            <p className="mt-0.5 font-sans text-xs text-(--el-text-secondary)">{lockedWhy}</p>
          ) : null}
        </div>
        <Switch
          checked={checked}
          disabled={locked}
          onCheckedChange={() => toggleScope(meta.key)}
          aria-label={name}
        />
      </div>
    );
  }

  // One capability group — a mono/uppercase caption over its hairline-separated
  // safe rows, then any danger row (its own card) below.
  function renderScopeGroup(domain: PermissionDomain, metas: PermissionMeta[]) {
    const safe = metas.filter((m) => !m.danger);
    const danger = metas.filter((m) => m.danger);
    return (
      // ⚠️ AA: the domain heading is INFORMATIONAL, so it takes
      // `--el-text-secondary`, never `--el-text-faint` (2.61 on the white
      // panel) — the correction MOTIR-2578 made in the asset.
      <div key={domain} className="flex flex-col gap-2">
        <div className="font-mono text-[0.625rem] tracking-wide text-(--el-text-secondary) uppercase">
          {tp(`domain.${domain}`)}
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
      // BOTH phases are ~42rem. The form phase widened first, so all six
      // permission scopes show at once — width, not scroll (Yue, 2026-06-16).
      // The shown-once phase kept the 7.7.2 `md` width until MOTIR-3545, where
      // 28rem was measured too narrow for the secret it exists to show: a PAT
      // is ALWAYS 53 chars (`motir_pat_` + 43 base64url), which needs ~360px of
      // monospace against the ~245px `md` leaves once the Copy button and the
      // panel padding are taken out. At 42rem the field gets ~471px and the
      // secret lands on one line — and the two phases no longer resize under
      // the reader between Create and the reveal. tailwind-merge lets this
      // className override the size variant's `max-w`.
      className="max-w-[42rem]"
    >
      {shown ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-sm font-medium text-(--el-text)">
              {t('created.secretLabel')}
            </span>
            <div className="flex items-stretch gap-2">
              {/* `break-all` is what actually guarantees the whole secret is
                  READABLE, and the width above is not a substitute for it
                  (MOTIR-3545). The panel is `w-[90vw]` UNDER a `max-w`, so a
                  narrow viewport gets a field far below the ~360px 53 chars
                  need whatever the cap says. Without a break rule the string
                  has no break opportunity except a `-`, which base64url
                  supplies in about half of all secrets — and a `-` is the
                  WORST case, not the mild one: the line breaks after it, the
                  over-long run before it is clipped, and the result reads as a
                  neatly wrapped, complete token with characters missing.
                  `overflow-x-auto` used to sit here and never helped: an
                  overlay scrollbar is invisible at rest, so it turned a visible
                  cut into a silent one. */}
              <code
                data-testid="api-token-secret"
                className="min-w-0 flex-1 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) px-(--spacing-input-x) py-(--spacing-input-y) font-mono text-xs leading-relaxed break-all text-(--el-text)"
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
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Modal.Body className="gap-4">
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
              {/* The PROJECT binding (MOTIR-2606). Required, not optional: a
                  chosen grant must name the project it applies to. Changing it
                  recomputes the offer below, because a different project is a
                  different set of permissions this actor can confer. */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={projectFieldId}
                  className="font-sans text-sm font-medium text-(--el-text)"
                >
                  {t('createModal.projectField')}
                </label>
                <Combobox
                  id={projectFieldId}
                  label={t('createModal.projectField')}
                  options={projectOptions}
                  value={selectedProject?.id ?? ''}
                  onChange={(pid) => setProjectId(pid)}
                />
                <span className="font-sans text-xs text-(--el-text-muted)">
                  {t('createModal.projectHelper')}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={expiryId}
                  className="font-sans text-sm font-medium text-(--el-text)"
                >
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
                {/* Two columns, split so neither drives the height alone — the
                    design's 3/3 (MOTIR-2578). The GROUPS are the catalog's
                    domains, derived, so a permission added to the grantable set
                    lands in a column without an edit here. */}
                <div className="flex flex-col gap-4">
                  {leftColumn.map((g) => renderScopeGroup(g.domain, g.permissions))}
                </div>
                <div className="flex flex-col gap-4">
                  {rightColumn.map((g) => renderScopeGroup(g.domain, g.permissions))}
                </div>
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
          </Modal.Body>
          <Modal.Footer className="shrink-0">
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
