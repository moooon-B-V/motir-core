'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate } from '@/lib/utils/datetime';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { CreateTokenModal } from './CreateTokenModal';
import { RevokeTokenDialog } from './RevokeTokenDialog';
import type { ApiTokenDto } from './apiTokensClient';
import type { TokenScopeOrgDTO } from '@/lib/dto/apiTokens';

// The API tokens pane's CLIENT ISLAND (Story 7.8 · Subtask 7.8.3) — design
// `account-settings.mock.html` Panels 3 + 7. It owns the token-list state
// (`useState(initialTokens)`) and does its OWN optimistic insert (on create) /
// mark-revoked (on revoke) from the route responses — the
// page-state-after-mutation contract: an island seeded from server props can't
// be reached by `router.refresh()`, and create/revoke fire from INSIDE the
// island, so a local update is the correct mechanism (no re-fetch).
//
// The page server-reads the initial list via `apiTokensService.listForUser`
// (account-level) + the org → workspace tree (`listScopeOptions`) the create
// modal scopes a new token within (bug 7.21).

// The MCP setup guide the empty state links to (`docs/mcp.md`, the 7.8.8 doc).
const MCP_GUIDE_HREF = 'https://github.com/moooon-B-V/motir-core/blob/main/docs/mcp.md';

const DAY_MS = 24 * 60 * 60 * 1000;
/** An expiry within this window shows the peach "expiring soon" warning chip. */
const EXPIRING_SOON_DAYS = 7;

export function ApiTokensManager({
  initialTokens,
  scopeOrgs,
  activeWorkspaceId,
}: {
  initialTokens: ApiTokenDto[];
  /** The org → workspace tree the create modal scopes a token within (bug 7.21). */
  scopeOrgs: TokenScopeOrgDTO[];
  /** The active workspace, pre-selected in the create modal (or null). */
  activeWorkspaceId: string | null;
}) {
  const t = useTranslations('settings.apiTokens');
  const locale = useLocale() as Locale;

  // A token's scope spans one org (so don't repeat the org name when the account
  // has a single org); show the workspace name, with the org as a muted prefix
  // only when there is more than one org.
  const multiOrg = scopeOrgs.length > 1;

  const [tokens, setTokens] = useState<ApiTokenDto[]>(initialTokens);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenDto | null>(null);

  // `now` is established AFTER mount so the relative "expires in N days" math is
  // hydration-safe: SSR and the first client render both see `now === null` and
  // fall back to the absolute date; the relative form appears post-hydration.
  // Reading the clock is the whole point of this effect (the mount-flag pattern),
  // so the set-state-in-effect lint is intentionally relaxed here.
  const [now, setNow] = useState<number | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => setNow(Date.now()), []);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleCreated(token: ApiTokenDto) {
    setTokens((prev) => [token, ...prev]);
  }
  function handleRevoked(revoked: ApiTokenDto) {
    setTokens((prev) => prev.map((tk) => (tk.id === revoked.id ? revoked : tk)));
    setRevokeTarget(null);
  }

  // Live tokens first, soft-revoked rows after (the design's sort — the revoked
  // row stays for audit). Stable within each group (the service returns newest
  // first; a just-revoked row drops to the bottom).
  const ordered = [...tokens].sort((a, b) => (a.revokedAt ? 1 : 0) - (b.revokedAt ? 1 : 0));

  return (
    <div className="flex flex-col gap-6">
      {tokens.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="h-12 w-12" aria-hidden />}
          title={t('empty.title')}
          description={
            <>
              {t('empty.body')}{' '}
              <a
                href={MCP_GUIDE_HREF}
                target="_blank"
                rel="noreferrer"
                className="text-(--el-link) underline hover:text-(--el-link-pressed)"
              >
                {t('empty.guideLink')}
              </a>
              {t('empty.bodyAfterLink')}
            </>
          }
          action={
            <Button
              variant="primary"
              leftIcon={<Plus className="size-4" />}
              onClick={() => setCreateOpen(true)}
            >
              {t('card.create')}
            </Button>
          }
        />
      ) : (
        <Card
          header={
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="font-sans text-base font-semibold text-(--el-text)">
                  {t('card.title')}
                </h3>
                <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">
                  {t('card.subtitle')}
                </p>
              </div>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Plus className="size-4" />}
                onClick={() => setCreateOpen(true)}
              >
                {t('card.create')}
              </Button>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-(--el-border)">
                  <Th>{t('columns.label')}</Th>
                  <Th>{t('columns.token')}</Th>
                  <Th>{t('columns.workspace')}</Th>
                  <Th>{t('columns.created')}</Th>
                  <Th>{t('columns.expires')}</Th>
                  <Th>{t('columns.lastUsed')}</Th>
                  <Th className="text-right">{t('columns.actions')}</Th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((token) => {
                  const revoked = token.revokedAt !== null;
                  const dateClass = revoked
                    ? 'text-(--el-text-faint)'
                    : 'text-(--el-text-secondary)';
                  return (
                    <tr key={token.id} className="border-b border-(--el-border-soft) last:border-0">
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <span
                          className={`font-sans text-sm font-medium ${revoked ? 'text-(--el-text-faint)' : 'text-(--el-text)'}`}
                        >
                          {token.label}
                        </span>
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <code className="rounded-(--radius-control) bg-(--el-code-bg) px-1.5 py-0.5 font-mono text-xs text-(--el-code-text)">
                          {token.tokenPrefix}…
                        </code>
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <span
                          className={`font-sans text-sm ${revoked ? 'text-(--el-text-faint)' : 'text-(--el-text-secondary)'}`}
                        >
                          {multiOrg
                            ? `${token.organization.name} · ${token.workspace.name}`
                            : token.workspace.name}
                        </span>
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <span className={`font-sans text-sm ${dateClass}`}>
                          {formatDate(token.createdAt, locale)}
                        </span>
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        {renderExpires(token, now, locale, t)}
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <span className={`font-sans text-sm ${dateClass}`}>
                          {token.lastUsedAt
                            ? formatDate(token.lastUsedAt, locale)
                            : t('lastUsedNever')}
                        </span>
                      </td>
                      <td className="py-(--spacing-control-y) text-right align-middle">
                        {revoked ? (
                          <Pill tone="neutral">{t('revoked')}</Pill>
                        ) : (
                          <button
                            type="button"
                            aria-label={t('revokeAria', { label: token.label })}
                            onClick={() => setRevokeTarget(token)}
                            className="inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-danger) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <CreateTokenModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        scopeOrgs={scopeOrgs}
        activeWorkspaceId={activeWorkspaceId}
      />
      {revokeTarget ? (
        <RevokeTokenDialog
          token={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onRevoked={handleRevoked}
        />
      ) : null}
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`py-(--spacing-control-y) pr-4 font-sans text-xs font-medium tracking-wide text-(--el-text-faint) uppercase ${className}`}
    >
      {children}
    </th>
  );
}

/** The Expires cell: "Never" when null, a muted "—" for a revoked row, the
 * relative "in N days" (warning chip within ~7 days) once `now` is known, and
 * the absolute date as the hydration-safe fallback before mount. */
function renderExpires(
  token: ApiTokenDto,
  now: number | null,
  locale: Locale,
  t: ReturnType<typeof useTranslations>,
) {
  if (token.revokedAt) {
    return <span className="font-sans text-sm text-(--el-text-faint)">—</span>;
  }
  if (!token.expiresAt) {
    return (
      <span className="font-sans text-sm text-(--el-text-secondary)">{t('expiresNever')}</span>
    );
  }
  if (now === null) {
    return (
      <span className="font-sans text-sm text-(--el-text-secondary)">
        {formatDate(token.expiresAt, locale)}
      </span>
    );
  }
  const days = Math.ceil((new Date(token.expiresAt).getTime() - now) / DAY_MS);
  if (days < 0) {
    // Past expiry but not revoked — show the (muted) date; verify already rejects it.
    return (
      <span className="font-sans text-sm text-(--el-text-faint)">
        {formatDate(token.expiresAt, locale)}
      </span>
    );
  }
  const text = t('expiresIn', { days });
  if (days <= EXPIRING_SOON_DAYS) {
    return <Pill severity="warning">{text}</Pill>;
  }
  return <span className="font-sans text-sm text-(--el-text-secondary)">{text}</span>;
}
