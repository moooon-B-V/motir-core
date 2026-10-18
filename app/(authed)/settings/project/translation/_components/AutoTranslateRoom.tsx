'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import {
  ArrowRight,
  Check,
  CircleAlert,
  History,
  Languages,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SwitchRow } from '@/components/settings/SwitchRow';
import type {
  ProjectAutoTranslateChangeDTO,
  ProjectAutoTranslateSettingsDTO,
} from '@/lib/dto/projectAutoTranslateSettings';

// AutoTranslateRoom (Story MOTIR-7738 · MOTIR-8830) — the Translation settings
// room, per `design/settings/auto-translate.mock.html` and
// `design/settings/design-notes.md` § Auto-translate room (MOTIR-8822).
//
// A client ISLAND over `GET / PATCH /api/projects/[key]/auto-translate`
// (MOTIR-8827). It reads on mount rather than being seeded by the server, so the
// history's loading and failed faces ARE that read, and *Try again* re-asks
// without re-running the page.
//
// The switch commits at once (no save footer: a save bar would show the setting
// on while nothing had been recorded). The press is optimistic — the switch moves
// to the new value and the row stops taking presses — and returns to the value it
// held before the attempt if the write fails. A successful PATCH answers with the
// whole DTO, which replaces the switch AND the history in place: no
// `router.refresh()` (CLAUDE.md § page state, case 1), so the new change row
// appears without a second request.
//
// The room writes only through the route; it translates, bills and stores
// nothing. Colour strictly `--el-*`; shape through the element tokens; every text
// ink on a non-white surface is `--el-text-secondary` / `--el-text-strong` /
// `--el-text` (design § Contrast).

type Load =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; dto: ProjectAutoTranslateSettingsDTO };

const BILLING_HREF = '/settings/organization/billing';
const USAGE_HREF = '/settings/organization/usage';
const SKELETON_ROWS = 3;

export function AutoTranslateRoom({
  projectKey,
  canChange,
  noCredit,
  canAddCredit,
}: {
  projectKey: string;
  /** Whether the actor holds the room's WRITE key (`project:administer`), read off
   *  the registry entry by the page. Without it the room is read-only (panel 5). */
  canChange: boolean;
  /** The organisation cannot pay for translation right now (the AI paywall applies
   *  and there is no paid plan or no balance). Never true off-cloud. */
  noCredit: boolean;
  /** Whether the no-credit callout may link to adding credit. */
  canAddCredit: boolean;
}) {
  const t = useTranslations('settings.translation');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  // The value a flip is moving TO while its write is in flight; null at rest.
  const [pendingTo, setPendingTo] = useState<boolean | null>(null);
  // The value the last failed attempt was moving to; cleared by the next attempt.
  const [failedTo, setFailedTo] = useState<boolean | null>(null);
  // A read resolving after a newer one (Try again pressed twice) never lands.
  const readSeq = useRef(0);
  const url = `/api/projects/${encodeURIComponent(projectKey)}/auto-translate`;

  // The read itself. It sets state only in its callbacks, so the mount effect
  // below can start it; `retry` shows the loading face first.
  const read = useCallback(() => {
    const seq = ++readSeq.current;
    void fetch(url, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (seq !== readSeq.current) return;
        if (!res.ok) {
          setLoad({ state: 'failed' });
          return;
        }
        const dto = (await res.json()) as ProjectAutoTranslateSettingsDTO;
        if (seq !== readSeq.current) return;
        setLoad({ state: 'ready', dto });
      })
      .catch(() => {
        if (seq === readSeq.current) setLoad({ state: 'failed' });
      });
  }, [url]);

  useEffect(() => {
    read();
  }, [read]);

  const retry = useCallback(() => {
    setLoad({ state: 'loading' });
    read();
  }, [read]);

  const dto = load.state === 'ready' ? load.dto : null;
  const saving = pendingTo !== null;
  const value = pendingTo ?? dto?.autoTranslateWorkContent ?? false;

  const flip = useCallback(
    (next: boolean) => {
      if (!canChange || saving || !dto) return;
      setFailedTo(null);
      setPendingTo(next);
      // Any answer or failure of an earlier read must not land over this write.
      readSeq.current += 1;
      const failed = () => {
        // The switch returns to the value it held (it was never stored), and the
        // history is untouched: nothing was recorded.
        setPendingTo(null);
        setFailedTo(next);
      };
      void fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ autoTranslateWorkContent: next }),
      })
        .then(async (res) => {
          if (!res.ok) {
            failed();
            return;
          }
          // The response IS the confirmation and the authoritative state: it
          // replaces the switch and the history in place.
          const saved = (await res.json()) as ProjectAutoTranslateSettingsDTO;
          setLoad({ state: 'ready', dto: saved });
          setPendingTo(null);
        })
        .catch(failed);
    },
    [canChange, saving, dto, url],
  );

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard
        testId="auto-translate-setting"
        icon={<Languages className="size-[17px]" aria-hidden />}
        title={t('card.title')}
        subtitle={t('card.subtitle')}
        action={
          !canChange ? (
            <Pill tone="neutral" data-testid="auto-translate-readonly-pill">
              {t('readOnly')}
            </Pill>
          ) : null
        }
      >
        {load.state === 'loading' ? (
          <SettingSkeleton />
        ) : load.state === 'failed' ? (
          <Callout
            tint="peach"
            role="status"
            icon={<TriangleAlert className="size-[15px]" aria-hidden />}
            testId="auto-translate-failed"
          >
            <span className="block">
              <strong className="font-semibold">{t('loadFailed')}</strong>
            </span>
            <RetryButton onClick={retry} testId="auto-translate-retry" label={t('retry')} />
          </Callout>
        ) : canChange ? (
          <>
            <SwitchRow
              testId="auto-translate-switch"
              checked={value}
              onCheckedChange={flip}
              disabled={saving}
              label={t('switch.label')}
              hint={t.rich(value ? 'hint.on' : 'hint.off', { b: bold })}
            >
              {saving ? (
                <span
                  role="status"
                  data-testid="auto-translate-saving"
                  className="text-(--el-text-secondary) mt-1.5 flex items-center gap-1.5 text-xs"
                >
                  <Spinner size="sm" />
                  {t('saving')}
                </span>
              ) : null}
            </SwitchRow>

            {failedTo !== null ? (
              <div
                role="alert"
                data-testid="auto-translate-flip-error"
                className="text-(--el-text) flex flex-wrap items-center gap-2.5 text-xs"
              >
                <TriangleAlert
                  className="size-[14px] shrink-0 text-(--el-danger-on-surface)"
                  aria-hidden
                />
                <span>{t('flipError', { to: failedTo ? 'on' : 'off' })}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<RefreshCw className="size-[13px]" aria-hidden />}
                  onClick={() => flip(failedTo)}
                  data-testid="auto-translate-flip-retry"
                >
                  {t('retry')}
                </Button>
              </div>
            ) : null}

            {noCredit && value ? (
              <Callout
                tint="peach"
                role="status"
                icon={<CircleAlert className="size-[15px]" aria-hidden />}
                testId="auto-translate-no-credit"
              >
                <span className="block">{t.rich('noCredit.body', { b: bold })}</span>
                <span className="mt-1.5 block">
                  {canAddCredit ? (
                    <Link
                      href={BILLING_HREF}
                      data-testid="auto-translate-add-credit"
                      className="text-(--el-link) inline-flex items-center gap-1 font-medium underline"
                    >
                      {t('noCredit.add')}
                      <ArrowRight className="size-[13px]" aria-hidden />
                    </Link>
                  ) : (
                    <span data-testid="auto-translate-ask-admin">{t('noCredit.askAdmin')}</span>
                  )}
                </span>
              </Callout>
            ) : null}

            <hr className="border-(--el-border-soft)" />
            {value ? (
              <>
                <div>
                  <SectionLabel>{t('effects.title')}</SectionLabel>
                  <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                    {(['page', 'lists', 'original'] as const).map((id) => (
                      <li key={id} className="text-(--el-text) flex items-start gap-2 text-xs">
                        <Check
                          className="text-(--el-icon-muted) mt-0.5 size-[13px] shrink-0"
                          aria-hidden
                        />
                        <span>{t.rich(`effects.${id}`, { b: bold })}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <hr className="border-(--el-border-soft)" />
              </>
            ) : null}
            <CostLine />
          </>
        ) : (
          <>
            <div className="flex items-center gap-3" data-testid="auto-translate-value">
              <span className="text-sm font-medium text-(--el-text)">{t('switch.label')}</span>
              <ValuePill on={value} />
            </div>
            <p className="text-(--el-text-secondary) m-0 text-xs leading-relaxed">
              {t(value ? 'readOnlyValue.on' : 'readOnlyValue.off')}
            </p>
            <p
              data-testid="auto-translate-readonly-note"
              className="text-(--el-text-secondary) m-0 text-xs leading-relaxed"
            >
              {t('readOnlyNote')}
            </p>
          </>
        )}
      </SettingsCard>

      <HistoryCard load={load} onRetry={retry} />
    </div>
  );
}

function bold(chunks: ReactNode) {
  return <strong className="font-semibold">{chunks}</strong>;
}

function CostLine() {
  const t = useTranslations('settings.translation');
  return (
    <p
      className="text-(--el-text-secondary) m-0 text-xs leading-relaxed"
      data-testid="auto-translate-cost"
    >
      {t.rich('cost', {
        link: (chunks) => (
          <Link href={USAGE_HREF} className="text-(--el-link) underline">
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}

function ValuePill({ on }: { on: boolean }) {
  const t = useTranslations('settings.translation');
  return on ? (
    <Pill className="border-transparent bg-(--el-tint-mint) text-(--el-text-strong)">
      {t('value.on')}
    </Pill>
  ) : (
    <Pill tone="neutral">{t('value.off')}</Pill>
  );
}

function SettingSkeleton() {
  return (
    <div
      className="flex items-start gap-3.5"
      aria-busy="true"
      data-testid="auto-translate-skeleton"
    >
      <span className="bg-(--el-muted) mt-0.5 block h-5 w-9 rounded-full" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-2" aria-hidden>
        <span className="bg-(--el-muted) block h-4 w-48 rounded-(--radius-control)" />
        <span className="bg-(--el-muted) block h-3 w-full max-w-[28rem] rounded-(--radius-control)" />
      </span>
    </div>
  );
}

function RetryButton({
  onClick,
  testId,
  label,
}: {
  onClick: () => void;
  testId: string;
  label: string;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="mt-2"
      leftIcon={<RefreshCw className="size-[13px]" aria-hidden />}
      onClick={onClick}
      data-testid={testId}
    >
      {label}
    </Button>
  );
}

// ── The change history (design panel 7) ───────────────────────────────────────

function HistoryCard({ load, onRetry }: { load: Load; onRetry: () => void }) {
  const t = useTranslations('settings.translation');
  const format = useFormatter();
  const dto = load.state === 'ready' ? load.dto : null;

  return (
    <SettingsCard
      testId="auto-translate-history"
      icon={<History className="size-[17px]" aria-hidden />}
      title={t('history.title')}
      subtitle={t('history.subtitle')}
    >
      {load.state === 'failed' ? (
        <Callout
          tint="peach"
          role="status"
          icon={<TriangleAlert className="size-[15px]" aria-hidden />}
          testId="auto-translate-history-failed"
        >
          <span className="block">{t.rich('history.failed', { b: bold })}</span>
          <RetryButton onClick={onRetry} testId="auto-translate-history-retry" label={t('retry')} />
        </Callout>
      ) : load.state === 'loading' ? (
        <div
          className="flex flex-col"
          aria-busy="true"
          data-testid="auto-translate-history-loading"
        >
          <HistoryHeads />
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className={`${ROW} items-center`} aria-hidden>
              <span className="bg-(--el-muted) block h-4 w-36 rounded-(--radius-control)" />
              <span className="bg-(--el-muted) block h-5 w-28 rounded-(--radius-badge)" />
              <span className="bg-(--el-muted) block h-4 w-32 rounded-(--radius-control)" />
            </div>
          ))}
        </div>
      ) : dto && dto.changes.length === 0 ? (
        <p
          data-testid="auto-translate-history-empty"
          className="text-(--el-text-secondary) m-0 text-xs leading-relaxed"
        >
          {t('history.empty')}
        </p>
      ) : dto ? (
        <>
          <ul className="m-0 flex list-none flex-col p-0" data-testid="auto-translate-history-list">
            <li className="list-none" aria-hidden>
              <HistoryHeads />
            </li>
            {dto.changes.map((c) => (
              <HistoryRow key={c.id} change={c} format={format} />
            ))}
          </ul>
          {dto.totalChanges > dto.changes.length ? (
            <p
              data-testid="auto-translate-history-capped"
              className="text-(--el-text-secondary) m-0 text-xs"
            >
              {t('history.capped', { shown: dto.changes.length, total: dto.totalChanges })}
            </p>
          ) : null}
        </>
      ) : null}
    </SettingsCard>
  );
}

const ROW =
  'border-(--el-border-soft) grid min-h-(--height-control) grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b py-2.5 @lg:grid-cols-[minmax(0,1fr)_9.5rem_minmax(0,12rem)]';

function HistoryHeads() {
  const t = useTranslations('settings.translation');
  return (
    <div
      className="text-(--el-text-eyebrow) border-(--el-border) hidden grid-cols-[minmax(0,1fr)_9.5rem_minmax(0,12rem)] gap-x-4 border-b pb-2 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase @lg:grid"
      aria-hidden
    >
      <span>{t('history.col.who')}</span>
      <span>{t('history.col.change')}</span>
      <span>{t('history.col.when')}</span>
    </div>
  );
}

function HistoryRow({
  change,
  format,
}: {
  change: ProjectAutoTranslateChangeDTO;
  format: ReturnType<typeof useFormatter>;
}) {
  const t = useTranslations('settings.translation');
  const who = change.changedByName ?? t('history.unknownActor');
  const from = t(change.fromEnabled ? 'value.on' : 'value.off');
  const to = t(change.toEnabled ? 'value.on' : 'value.off');
  const when = format.dateTime(new Date(change.changedAt), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <li
      data-testid="auto-translate-history-row"
      aria-label={t('history.row', { who, from, to, when })}
      className={ROW}
    >
      <span className="text-(--el-text) min-w-0 truncate text-sm">{who}</span>
      <span className="flex items-center gap-1.5" aria-hidden>
        <ValuePill on={change.fromEnabled} />
        <ArrowRight className="text-(--el-icon-muted) size-[13px]" />
        <ValuePill on={change.toEnabled} />
      </span>
      <time dateTime={change.changedAt} className="text-(--el-text-secondary) text-xs" aria-hidden>
        {when}
      </time>
    </li>
  );
}

// ── Callout — the AI planning room's box, two of its tints ────────────────────

function Callout({
  tint,
  icon,
  children,
  testId,
  role,
}: {
  tint: 'peach' | 'plain';
  icon: ReactNode;
  children: ReactNode;
  testId?: string;
  role?: 'status';
}) {
  const surface =
    tint === 'peach'
      ? 'bg-(--el-tint-peach) border-(--el-border-soft) text-(--el-text-strong)'
      : 'bg-(--el-surface) border-(--el-border) text-(--el-text-secondary)';
  const iconTone = tint === 'peach' ? 'text-(--el-warning)' : 'text-(--el-icon-muted)';
  return (
    <div
      data-testid={testId}
      {...(role ? { role } : {})}
      className={`flex gap-2.5 rounded-(--radius-card) border px-3.5 py-2.5 text-xs leading-relaxed ${surface}`}
    >
      <span className={`mt-px shrink-0 ${iconTone}`}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}
