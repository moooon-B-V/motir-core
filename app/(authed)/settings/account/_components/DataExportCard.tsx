'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, Download, Hourglass, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { DataExportRequestDTO } from '@/lib/dto/dataExport';
import { DATA_EXPORT_RETENTION_DAYS, DATA_PRIVACY_MAILBOX } from '@/lib/users/dataSubjectRequests';
import { formatDate, formatDateTime } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import { SettingsCallout } from './SettingsCallout';
import { requestDataExportAction } from '../data/actions';

// The "Export your data" card on the Account › Data & privacy pane (Story 8.4 ·
// Subtask MOTIR-1136), built to `design/settings/account-data.mock.html` panels
// 1 and 2, in the shipped settings-row grammar the Profile and Language panes
// use (a `Card` with a header slot, hairline-separated rows) rather than a
// hand-rolled card shell.
//
// ⚠️ FIVE RENDERED STATES, NOT FOUR. The card's own prose enumerates
// "idle · preparing · ready · failed", and the shipped `DataExportStatus` enum
// carries a value that enumeration leaves out — `expired`, whose entire reason
// to exist is (the model's words) that "the row survives so the pane can say
// what happened instead of showing nothing". A renderer over a subset of a live
// enum is a partial function, so this component branches over the whole union
// plus the no-row IDLE case, and `assertNever` makes the totality a compile-time
// property rather than a promise in a comment.
//
// A CLIENT ISLAND because it owns a mutation and its optimistic state. The
// action calls `revalidatePath`, which re-runs the pane's server read — but
// CLAUDE.md's page-state contract says a refresh cannot reach a `useState`
// initializer, so the island ALSO holds what it just learned. The two agree
// because they describe the same row.
//
// WHAT IT DOES NOT OWN: the download itself (MOTIR-3703's authenticated route,
// which 302s to a freshly minted 300-second URL — this card renders the link and
// nothing more) and the build (MOTIR-3701's background job).

export interface DataExportCardProps {
  /** The reader's most recent request, or `null` when they have never asked. */
  request: DataExportRequestDTO | null;
  /** Where the "it's ready" notification goes — the reader's own address. */
  email: string;
  /**
   * Replaces the idle head's standing pitch (MOTIR-3704, panel 5). The ONE
   * caller is the scheduled state, where the pitch is no longer the honest
   * line: with an erasure dated, the reason to export is that after that date
   * there is nothing left to. Only the IDLE copy moves — every request state
   * still reports what that row is doing.
   */
  idleSubtitle?: string;
}

export function DataExportCard({
  request: initialRequest,
  email,
  idleSubtitle,
}: DataExportCardProps) {
  const t = useTranslations('settings.account.data.export');
  const locale = useLocale() as Locale;
  const { toast } = useToast();

  // Seeded from the server read and advanced by our own action's answer. The
  // action revalidates the pane too; this is the half a refresh cannot reach.
  const [request, setRequest] = useState<DataExportRequestDTO | null>(initialRequest);
  const [isPending, startTransition] = useTransition();

  function requestExport() {
    startTransition(async () => {
      const result = await requestDataExportAction();
      if (result.ok) {
        // We know a request is open; we do not know its id or its timestamps
        // without a second read, and the revalidate is already fetching them.
        // Showing `preparing` from the existing row (or a provisional one) is
        // the honest reading of "there is an export being built for you".
        setRequest((current) =>
          current !== null && current.status === 'preparing'
            ? current
            : {
                id: current?.id ?? '',
                status: 'preparing',
                requestedAt: new Date().toISOString(),
                builtAt: null,
                expiresAt: null,
              },
        );
        return;
      }
      toast({ variant: 'error', title: t('error') });
    });
  }

  return (
    <Card
      header={
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h3>
            <p className="mt-0.5 max-w-[54ch] font-sans text-sm text-(--el-text-muted)">
              {headline(t, request, locale, idleSubtitle)}
            </p>
          </div>
          {request === null ? null : <StatusPill status={request.status} t={t} />}
        </div>
      }
    >
      {request === null ? (
        <IdleBody t={t} onRequest={requestExport} pending={isPending} />
      ) : (
        <StateBody
          t={t}
          request={request}
          email={email}
          locale={locale}
          onRequest={requestExport}
          pending={isPending}
        />
      )}
    </Card>
  );
}

type T = ReturnType<typeof useTranslations<'settings.account.data.export'>>;

/** The head's subtitle — the standing pitch when idle, the state's line otherwise. */
function headline(
  t: T,
  request: DataExportRequestDTO | null,
  locale: Locale,
  idleSubtitle?: string,
): string {
  if (request === null) return idleSubtitle ?? t('subtitle');
  switch (request.status) {
    case 'preparing':
      return t('preparing.headline', { requested: formatDateTime(request.requestedAt, locale) });
    case 'ready':
      // A `ready` row always carries `builtAt` (the build writes both together),
      // but the column is nullable, so the type says it might not.
      return t('ready.headline', {
        built: request.builtAt === null ? '—' : formatDateTime(request.builtAt, locale),
      });
    case 'failed':
      return t('failed.headline');
    case 'expired':
      return t('expired.headline');
    default:
      return assertNever(request.status);
  }
}

/**
 * The state chip. A GLYPH on every one of them: finding #35 forbids resting a
 * state on colour alone, and at a glance the tint is all that separates two of
 * these.
 */
function StatusPill({ status, t }: { status: DataExportRequestDTO['status']; t: T }) {
  const label = t(`${status}.pill`);
  switch (status) {
    case 'preparing':
      return (
        <Pill severity="info" className="shrink-0">
          <Hourglass aria-hidden className="h-3 w-3" /> {label}
        </Pill>
      );
    case 'ready':
      return (
        <Pill severity="success" className="shrink-0">
          <CheckCircle2 aria-hidden className="h-3 w-3" /> {label}
        </Pill>
      );
    case 'failed':
      return (
        <Pill severity="danger" className="shrink-0">
          <AlertCircle aria-hidden className="h-3 w-3" /> {label}
        </Pill>
      );
    case 'expired':
      return (
        <Pill severity="warning" className="shrink-0">
          <AlertCircle aria-hidden className="h-3 w-3" /> {label}
        </Pill>
      );
    default:
      return assertNever(status);
  }
}

/**
 * PANEL 1 — what the export IS, and the control that asks for one.
 *
 * The three rows and the fact line are the card's standing explanation of what a
 * reader receives; the design drops them once a request exists, because from
 * then on the card is about THAT file.
 */
function IdleBody({ t, onRequest, pending }: { t: T; onRequest: () => void; pending: boolean }) {
  return (
    <>
      {(['profile', 'workspaces', 'files'] as const).map((row) => (
        <SettingsRow
          key={row}
          name={t(`what.${row}.name`)}
          desc={t(`what.${row}.desc`)}
          control={
            <span className="font-sans text-sm text-(--el-text)">{t(`what.${row}.value`)}</span>
          }
        />
      ))}

      <div className="flex flex-wrap gap-x-6 gap-y-1.5 border-t border-(--el-border-soft) pb-4 pt-4">
        {(['format', 'window'] as const).map((fact) => (
          <span key={fact} className="font-sans text-xs text-(--el-text-secondary)">
            {t.rich(fact, {
              b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
            })}
          </span>
        ))}
      </div>

      <SettingsRow
        name={t('requestTitle')}
        desc={t('requestDesc')}
        control={
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Download className="h-4 w-4" />}
            loading={pending}
            onClick={onRequest}
          >
            {t('cta')}
          </Button>
        }
      />
    </>
  );
}

/** PANEL 2 — the card body once a request exists: one file row per status. */
function StateBody({
  t,
  request,
  email,
  locale,
  onRequest,
  pending,
}: {
  t: T;
  request: DataExportRequestDTO;
  email: string;
  locale: Locale;
  onRequest: () => void;
  pending: boolean;
}) {
  const filename = t('filename');

  switch (request.status) {
    case 'preparing':
      return (
        <StateSection>
          <FileRow
            tone="pending"
            icon={<Hourglass aria-hidden className="h-[17px] w-[17px]" />}
            name={filename}
            detail={t('preparing.body', { email })}
            control={
              <Button variant="secondary" size="sm" disabled>
                {t('cta')}
              </Button>
            }
          />
        </StateSection>
      );

    case 'ready':
      return (
        <StateSection>
          <FileRow
            tone="ready"
            icon={<Download aria-hidden className="h-[17px] w-[17px]" />}
            name={filename}
            detail={t('ready.body', {
              until: request.expiresAt === null ? '—' : formatDate(request.expiresAt, locale),
            })}
            control={
              // The download is MOTIR-3703's authenticated route, which mints a
              // FRESH 300-second presigned URL per request and 302s to it — so
              // this is a link to that route, never a stored URL, which is what
              // makes the copy beside it ("a fresh, private link… five minutes")
              // the mechanism rather than a description of one. No `download`
              // attribute: the route binds the content-disposition into the
              // signature itself.
              <a
                href={`/api/account/data-export/${request.id}/download`}
                className={buttonVariants({ variant: 'primary', size: 'sm' })}
              >
                <Download aria-hidden className="h-4 w-4" />
                <span>{t('download')}</span>
              </a>
            }
          />
          <SettingsCallout className="mt-3">
            {t('expiry')} {t('retention', { days: DATA_EXPORT_RETENTION_DAYS })}
          </SettingsCallout>
        </StateSection>
      );

    case 'failed':
      return (
        <StateSection>
          <FileRow
            tone="failed"
            icon={<AlertCircle aria-hidden className="h-[17px] w-[17px]" />}
            name={filename}
            detail={t('failed.body', { mailbox: DATA_PRIVACY_MAILBOX })}
            control={
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<RefreshCw className="h-4 w-4" />}
                loading={pending}
                onClick={onRequest}
              >
                {t('retry')}
              </Button>
            }
          />
        </StateSection>
      );

    case 'expired':
      return (
        <StateSection>
          <FileRow
            tone="expired"
            icon={<AlertCircle aria-hidden className="h-[17px] w-[17px]" />}
            name={filename}
            detail={t('expired.body', { days: DATA_EXPORT_RETENTION_DAYS })}
            control={
              <Button variant="secondary" size="sm" loading={pending} onClick={onRequest}>
                {t('cta')}
              </Button>
            }
          />
        </StateSection>
      );

    default:
      return assertNever(request.status);
  }
}

/** The hairline under the card head that every settings pane draws. */
function StateSection({ children }: { children: ReactNode }) {
  return <div className="border-t border-(--el-border-soft) pt-4">{children}</div>;
}

/** The shipped settings-row grammar: label + description left, control right. */
function SettingsRow({ name, desc, control }: { name: string; desc: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-t border-(--el-border-soft) pb-4 pt-4 last:pb-0">
      <div className="min-w-0">
        <div className="font-sans text-sm font-medium text-(--el-text)">{name}</div>
        <div className="mt-0.5 max-w-[46ch] font-sans text-xs leading-snug text-(--el-text-muted)">
          {desc}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">{control}</div>
    </div>
  );
}

const FILE_ROW_TONES = {
  ready: 'bg-(--el-tint-mint) text-(--el-success)',
  pending: 'bg-(--el-tint-sky) text-(--el-info)',
  failed: 'bg-(--el-tint-rose) text-(--el-danger)',
  // The design draws three tones; `expired` reuses the palette's WARNING pairing
  // — the same tint/ink recipe, no new colour — because the state is neither a
  // failure nor a file you still have.
  expired: 'bg-(--el-tint-peach) text-(--el-warning)',
} as const;

/** The delivered (or not-yet-delivered) archive, as one row. */
function FileRow({
  tone,
  icon,
  name,
  detail,
  control,
}: {
  tone: keyof typeof FILE_ROW_TONES;
  icon: ReactNode;
  name: string;
  detail: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface-soft) p-3">
      <span
        className={`inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-(--radius-control) ${FILE_ROW_TONES[tone]}`}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-mono text-xs font-semibold text-(--el-text)">{name}</span>
        <span className="font-sans text-xs text-(--el-text-secondary)">{detail}</span>
      </span>
      <span className="shrink-0">{control}</span>
    </div>
  );
}

/** Compile-time proof that every branch above is total over the live enum. */
function assertNever(value: never): never {
  throw new Error(`unhandled data-export status: ${String(value)}`);
}
