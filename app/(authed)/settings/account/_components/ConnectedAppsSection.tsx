'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowUpRight, ChevronDown, CircleCheck, Plug, Trash2, TriangleAlert } from 'lucide-react';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate, formatDateTime } from '@/lib/utils/datetime';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Tooltip } from '@/components/ui/Tooltip';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { permissionSlug } from '@/lib/permissions/catalog';
import {
  grantsDelete,
  permissionColumnsForTokens,
  summarizeGrant,
  type PermissionDomainGroup,
} from './permissionMeta';
import { listConnections, revokeConnection, type OAuthConnectionDto } from './connectedAppsClient';

// Settings → Account → Tokens · the CONNECTED APPS card (Story MOTIR-6973 ·
// Subtask MOTIR-6986), built to `design/settings/account-settings--connected-apps.mock.html`
// and `design/settings/design-notes.md` § Connected apps. Every app the person
// has signed into with their Motir account, one row per GRANT (the same app in
// two workspaces is two rows), with a Revoke that deletes the grant and every
// token issued under it — so the app's next MCP call is a 401.
//
// A CLIENT ISLAND seeded from the server read (`initialConnections`), so a
// revoke splices its row out of the island's own state; `router.refresh()`
// cannot reach it (the page-state-after-mutation contract, case 3). `null` means
// the server read failed: the island renders the inline error, and Try again
// re-runs the list read through `GET /api/account/oauth-connections`.

/** Where the empty state sends a person: motir.co's "Add Motir to Claude",
 * which leads `/docs/mcp` (Story MOTIR-6976 owns the page). */
export const ADD_MOTIR_TO_CLAUDE_HREF = 'https://motir.co/docs/mcp';

/** The card's anchor — the link the consent screen and the docs hand out. */
export const CONNECTED_APPS_ANCHOR = 'connected-apps';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Last used" is relative up to this many days, then the absolute date. */
const RELATIVE_WINDOW_DAYS = 7;

export function ConnectedAppsSection({
  initialConnections,
  multiOrg,
}: {
  /** The server read; `null` when it failed (the error state). */
  initialConnections: OAuthConnectionDto[] | null;
  /** More than one organisation → prefix the workspace with it (the token row's rule). */
  multiOrg: boolean;
}) {
  const t = useTranslations('settings.connectedApps');
  const tTokens = useTranslations('settings.apiTokens');

  const [connections, setConnections] = useState<OAuthConnectionDto[] | null>(initialConnections);
  const [retrying, setRetrying] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [revokeTarget, setRevokeTarget] = useState<OAuthConnectionDto | null>(null);

  // `now` after mount, so the relative "Last used" is hydration-safe: the server
  // and the first client render both show the absolute date.
  const [now, setNow] = useState<number | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => setNow(Date.now()), []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // A retry that resolves after a newer one must not overwrite it.
  const listSeq = useRef(0);
  async function retry() {
    const seq = ++listSeq.current;
    setRetrying(true);
    try {
      const rows = await listConnections();
      if (seq === listSeq.current) setConnections(rows);
    } catch {
      // Stay on the error line; the button returns from `loading`.
    } finally {
      if (seq === listSeq.current) setRetrying(false);
    }
  }

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRevoked(id: string) {
    setConnections((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
    setRevokeTarget(null);
  }

  const workspaceLabel = (c: OAuthConnectionDto) =>
    multiOrg ? `${c.organization.name} · ${c.workspace.name}` : c.workspace.name;
  const reachLabel = (c: OAuthConnectionDto) => c.project?.name ?? t('allProjects');

  let body: React.ReactNode;
  if (connections === null) {
    body = <ErrorLine retrying={retrying} onRetry={() => void retry()} />;
  } else if (connections.length === 0) {
    body = <EmptyLine />;
  } else {
    body = (
      <>
        {/* sm and up — the token list's table, column for column (Panel 1). */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-(--el-border)">
                <Th>{t('columns.app')}</Th>
                <Th>{tTokens('columns.scopes')}</Th>
                <Th>{t('columns.workspace')}</Th>
                <Th>{t('columns.connected')}</Th>
                <Th>{t('columns.lastUsed')}</Th>
                <Th className="text-right">{t('columns.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => {
                const expanded = expandedIds.has(c.id);
                return (
                  <Fragment key={c.id}>
                    <tr
                      data-testid="connected-app-row"
                      className={`border-(--el-border-soft) ${expanded ? '' : 'border-b last:border-0'}`}
                    >
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <AppCell connection={c} />
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <ScopesCell
                          connection={c}
                          expanded={expanded}
                          onToggle={() => toggleExpanded(c.id)}
                        />
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <div className="font-sans text-sm text-(--el-text-secondary)">
                          {workspaceLabel(c)}
                        </div>
                        <div className="font-sans text-xs text-(--el-text-secondary)">
                          {reachLabel(c)}
                        </div>
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <ConnectedDate iso={c.createdAt} />
                      </td>
                      <td className="py-(--spacing-control-y) pr-4 align-middle">
                        <LastUsed iso={c.lastUsedAt} now={now} />
                      </td>
                      <td className="py-(--spacing-control-y) text-right align-middle">
                        <RevokeButton
                          label={t('revokeAria', {
                            app: appName(c, t),
                            workspace: c.workspace.name,
                          })}
                          onClick={() => setRevokeTarget(c)}
                        />
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="border-b border-(--el-border-soft) last:border-0">
                        <td colSpan={6} className="pr-4 pb-3.5 align-top">
                          <GrantColumns connection={c} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Below sm — one block per connection (Panel 9). */}
        <ul
          data-testid="connected-apps-narrow"
          className="divide-y divide-(--el-border-soft) sm:hidden"
        >
          {connections.map((c) => {
            const expanded = expandedIds.has(c.id);
            return (
              <li key={c.id} className="flex flex-col gap-1.5 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <AppCell connection={c} />
                  <RevokeButton
                    label={t('revokeAria', { app: appName(c, t), workspace: c.workspace.name })}
                    onClick={() => setRevokeTarget(c)}
                  />
                </div>
                <div className="font-sans text-[13px] text-(--el-text-secondary)">
                  {workspaceLabel(c)} · {reachLabel(c)}
                </div>
                <ScopesCell
                  connection={c}
                  expanded={expanded}
                  onToggle={() => toggleExpanded(c.id)}
                />
                {expanded ? <GrantColumns connection={c} /> : null}
                <div className="font-sans text-xs text-(--el-text-secondary)">
                  {t('narrowDates.connected')} <ConnectedDate iso={c.createdAt} bare /> ·{' '}
                  {t('narrowDates.lastUsed')} <LastUsed iso={c.lastUsedAt} now={now} bare />
                </div>
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <div id={CONNECTED_APPS_ANCHOR} className="scroll-mt-6">
      <Card
        header={
          <div className="min-w-0">
            <h3 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h3>
            <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
          </div>
        }
      >
        {body}
      </Card>
      {revokeTarget ? (
        <RevokeConnectionDialog
          connection={revokeTarget}
          workspaceLabel={workspaceLabel(revokeTarget)}
          reachLabel={reachLabel(revokeTarget)}
          onClose={() => setRevokeTarget(null)}
          onRevoked={handleRevoked}
        />
      ) : null}
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

/** The client's registered name; the unnamed fallback is the consent screen's. */
function appName(c: OAuthConnectionDto, t: T): string {
  return c.client.name ?? t('unnamedApp');
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`py-(--spacing-control-y) pr-4 font-sans text-xs font-medium tracking-wide text-(--el-text-secondary) uppercase ${className}`}
    >
      {children}
    </th>
  );
}

function AppCell({ connection: c }: { connection: OAuthConnectionDto }) {
  const t = useTranslations('settings.connectedApps');
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-sans text-sm font-medium text-(--el-text)">{appName(c, t)}</span>
        {c.client.unverified ? (
          <Tooltip content={t('unverifiedTooltip')}>
            <span tabIndex={0} className="inline-flex focus-visible:outline-none">
              <Pill tone="neutral">{t('unverified')}</Pill>
            </span>
          </Tooltip>
        ) : null}
      </div>
      {c.client.host ? (
        <div className="font-mono text-xs text-(--el-text-secondary)">{c.client.host}</div>
      ) : null}
    </div>
  );
}

function ScopesCell({
  connection: c,
  expanded,
  onToggle,
}: {
  connection: OAuthConnectionDto;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('settings.connectedApps');
  const tTokens = useTranslations('settings.apiTokens');
  const summary = summarizeGrant(c.permissions);
  const name = appName(c, t);
  return (
    <span className="inline-flex items-center gap-1.5">
      {summary === 'full' ? (
        <Pill severity="success">{tTokens('scopes.summary.full')}</Pill>
      ) : (
        <Pill tone="neutral">{tTokens(`scopes.summary.${summary}`)}</Pill>
      )}
      {grantsDelete(c.permissions) ? (
        <Pill severity="danger">
          <Trash2 className="size-3" aria-hidden />
          {tTokens('scopes.canDelete')}
        </Pill>
      ) : null}
      <button
        type="button"
        aria-label={t(expanded ? 'hideScopes' : 'showScopes', { app: name })}
        aria-expanded={expanded}
        onClick={onToggle}
        className="inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <ChevronDown
          className={`size-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
    </span>
  );
}

/** The disclosed grant — the token picker's two columns, read-only (Panel 2). */
function GrantColumns({ connection: c }: { connection: OAuthConnectionDto }) {
  const t = useTranslations('settings.connectedApps');
  const tp = useTranslations('permissions');
  const held = new Set(c.permissions);
  const [left, right] = permissionColumnsForTokens();

  const column = (groups: PermissionDomainGroup[]) => (
    <div className="flex flex-col gap-3">
      {groups.map(({ domain, permissions }) => (
        <div key={domain} className="flex flex-col gap-1">
          <div className="font-mono text-[0.625rem] tracking-wide text-(--el-text-secondary) uppercase">
            {tp(`domain.${domain}`)}
          </div>
          <ul className="flex flex-col">
            {permissions.map((meta) => {
              const Icon = meta.Icon;
              const granted = held.has(meta.key);
              const label = tp(`${permissionSlug(meta.key)}.label`);
              const danger = granted && meta.danger;
              return (
                <li
                  key={meta.key}
                  data-permission={meta.key}
                  data-granted={granted ? 'true' : 'false'}
                  className={`flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-1 ${danger ? 'bg-(--el-tint-rose)' : ''}`}
                >
                  <Icon
                    aria-hidden
                    className={`size-4 shrink-0 ${danger ? 'text-(--el-danger-on-surface)' : 'text-(--el-icon-muted)'}`}
                  />
                  <span
                    className={`min-w-0 flex-1 font-sans text-sm ${
                      danger
                        ? 'font-medium text-(--el-text-strong)'
                        : granted
                          ? 'text-(--el-text)'
                          : 'text-(--el-text-secondary)'
                    }`}
                  >
                    {label}
                  </span>
                  {granted ? (
                    <>
                      <CircleCheck aria-hidden className="size-4 shrink-0 text-(--el-success)" />
                      <span className="sr-only">{t('granted')}</span>
                    </>
                  ) : (
                    <span className="font-sans text-xs text-(--el-text-secondary)">
                      {t('notGranted')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );

  return (
    <div className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
      <p className="mb-2 font-sans text-xs text-(--el-text-secondary)">{t('detailLead')}</p>
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {column(left)}
        {column(right)}
      </div>
    </div>
  );
}

function ConnectedDate({ iso, bare = false }: { iso: string; bare?: boolean }) {
  const locale = useLocale() as Locale;
  const text = formatDate(iso, locale);
  if (bare) return <>{text}</>;
  return <span className="font-sans text-sm text-(--el-text-secondary)">{text}</span>;
}

/** Relative up to seven days ("2 minutes ago", "yesterday"), then the absolute
 * date; "Never" when the app has not called. The absolute time rides in `title`. */
function LastUsed({
  iso,
  now,
  bare = false,
}: {
  iso: string | null;
  now: number | null;
  bare?: boolean;
}) {
  const t = useTranslations('settings.connectedApps');
  const locale = useLocale() as Locale;
  let text: string;
  let title: string | undefined;
  if (!iso) {
    text = t('lastUsedNever');
  } else {
    title = formatDateTime(iso, locale);
    text = now === null ? formatDate(iso, locale) : relativeOrDate(iso, now, locale);
  }
  if (bare) return <span title={title}>{text}</span>;
  return (
    <span title={title} className="font-sans text-sm text-(--el-text-secondary)">
      {text}
    </span>
  );
}

export function relativeOrDate(iso: string, now: number, locale: Locale): string {
  const diffMs = new Date(iso).getTime() - now;
  if (-diffMs > RELATIVE_WINDOW_DAYS * DAY_MS) return formatDate(iso, locale);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const seconds = Math.round(diffMs / 1000);
  if (Math.abs(seconds) < 60) return rtf.format(0, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

function RevokeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-danger-on-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <Trash2 className="size-4" aria-hidden />
    </button>
  );
}

/** Panel 3 — one line and one link, not the `EmptyState` primitive. */
function EmptyLine() {
  const t = useTranslations('settings.connectedApps');
  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-(--el-muted)">
        <Plug aria-hidden className="size-4 text-(--el-icon-muted)" />
      </span>
      <p className="font-sans text-sm text-(--el-text-secondary)">
        {t('empty.body')}{' '}
        <a
          href={ADD_MOTIR_TO_CLAUDE_HREF}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-0.5 text-(--el-link) underline hover:text-(--el-link-pressed)"
        >
          {t('empty.link')}
          <ArrowUpRight aria-hidden className="size-3.5" />
        </a>
      </p>
    </div>
  );
}

/** Panel 5 — an inline error line with Try again, not the `ErrorState` card. */
function ErrorLine({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const t = useTranslations('settings.connectedApps');
  const tc = useTranslations('common');
  return (
    <div role="alert" className="flex items-start gap-3">
      <TriangleAlert aria-hidden className="size-5 shrink-0 text-(--el-danger-on-surface)" />
      <div className="min-w-0 flex-1">
        <p className="font-sans text-sm font-medium text-(--el-text)">{t('error.title')}</p>
        <p className="font-sans text-[13px] text-(--el-text-secondary)">{t('error.body')}</p>
      </div>
      <Button variant="secondary" size="sm" loading={retrying} onClick={onRetry}>
        {tc('retry')}
      </Button>
    </div>
  );
}

/** Panel 4 — the card while the server read streams: the header, then three
 * skeleton rows in the table's own columns. Rendered as the `<Suspense>`
 * fallback by the page, never by a `loading.tsx`. */
export function ConnectedAppsSkeleton() {
  const t = useTranslations('settings.connectedApps');
  const tc = useTranslations('common');
  const bar = 'rounded-(--radius-control) bg-(--el-muted)';
  return (
    <div id={CONNECTED_APPS_ANCHOR} className="scroll-mt-6">
      <Card
        header={
          <div className="min-w-0">
            <h3 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h3>
            <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
          </div>
        }
      >
        <span role="status" className="sr-only">
          {tc('loading')}
        </span>
        <div aria-hidden className="flex animate-pulse flex-col">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-(--el-border-soft) py-(--spacing-control-y) last:border-0"
            >
              <div className="flex w-40 flex-col gap-1.5">
                <div className={`h-3.5 w-28 ${bar}`} />
                <div className={`h-3 w-20 ${bar}`} />
              </div>
              <div className="h-5 w-20 rounded-(--radius-badge) bg-(--el-muted)" />
              <div className="flex w-32 flex-col gap-1.5">
                <div className={`h-3.5 w-24 ${bar}`} />
                <div className={`h-3 w-16 ${bar}`} />
              </div>
              <div className={`h-3.5 w-20 ${bar}`} />
              <div className={`h-3.5 w-20 ${bar}`} />
              <div className={`ml-auto size-7 ${bar}`} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** Panels 6–8 — the destructive confirm, naming the app, the workspace and the grant. */
function RevokeConnectionDialog({
  connection: c,
  workspaceLabel,
  reachLabel,
  onClose,
  onRevoked,
}: {
  connection: OAuthConnectionDto;
  workspaceLabel: string;
  reachLabel: string;
  onClose: () => void;
  onRevoked: (id: string) => void;
}) {
  const t = useTranslations('settings.connectedApps');
  const tTokens = useTranslations('settings.apiTokens');
  const locale = useLocale() as Locale;
  const { toast } = useToast();
  const [revoking, setRevoking] = useState(false);
  const name = appName(c, t);

  async function confirm() {
    setRevoking(true);
    try {
      await revokeConnection(c.id);
      toast({
        variant: 'success',
        title: t('revoked.title'),
        description: t('revoked.body', { app: name, workspace: c.workspace.name }),
      });
      onRevoked(c.id);
    } catch {
      toast({
        variant: 'error',
        title: t('revokeError.title'),
        description: t('revokeError.body'),
      });
      setRevoking(false);
    }
  }

  return (
    <Modal
      open
      // While the revoke runs its outcome is unknown, so nothing closes the
      // dialog: Escape and the scrim are ignored and the close button is
      // withdrawn (Panel 7 — one step stricter than the token dialog).
      onOpenChange={(o) => (!o && !revoking ? onClose() : undefined)}
      hideClose={revoking}
      title={t('revokeConfirm.title', { app: name })}
      size="sm"
    >
      <div className="flex min-h-0 flex-col gap-4">
        <Modal.Body className="gap-4">
          <div className="flex gap-3 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding)">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-(--el-danger)" />
            <p className="font-sans text-sm text-(--el-text-strong)">
              {t.rich('revokeConfirm.body', {
                app: name,
                workspace: c.workspace.name,
                strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
              })}
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-sans text-[13px]">
            <dt className="text-(--el-text-secondary)">{t('revokeConfirm.workspace')}</dt>
            <dd className="text-(--el-text)">
              {workspaceLabel} · {reachLabel}
            </dd>
            <dt className="text-(--el-text-secondary)">{t('revokeConfirm.scopes')}</dt>
            <dd className="text-(--el-text)">
              {tTokens(`scopes.summary.${summarizeGrant(c.permissions)}`)}
            </dd>
            <dt className="text-(--el-text-secondary)">{t('revokeConfirm.connected')}</dt>
            <dd className="text-(--el-text)">{formatDate(c.createdAt, locale)}</dd>
          </dl>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={revoking}>
            {t('revokeConfirm.cancel')}
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={revoking}
            leftIcon={<Trash2 className="size-4" />}
            onClick={() => void confirm()}
          >
            {t('revokeConfirm.confirm')}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}
