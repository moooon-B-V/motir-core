'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Check, CircleSlash, ExternalLink, Info, Lock, Search } from 'lucide-react';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { WarmButton as Button } from '@/components/onboarding/layout';
import { cn } from '@/lib/utils/cn';
import type { MigrateConnectExistingRepositoryDto } from '@/lib/dto/migrateOnboarding';
import type { AccountRepositoriesState } from './useAccountRepositories';

// THE CONNECT STEP'S REPOSITORY PICKER (Story MOTIR-8245 · MOTIR-8763), built on
// `design/onboarding-migrate/` Revision 8 and its delta mock
// `onboarding-migrate--installed-accounts.mock.html`, panels 2p, 2q and 2r.i.
// The rows are Settings' `RepoPickerRow` markup (MOTIR-8223) with this step's
// own words.
//
// PRESENTATIONAL. The read and the selection are `useAccountRepositories`; the
// link is behind `onConfirm` (MOTIR-8764). Rows are rendered one to one from
// the route's availability — the lookup below is keyed by its closed union, so
// a new value is a type error here, never a guess.
//
// ⚠️ `connected_elsewhere` NAMES NOBODY: the row renders the repository's own
// name and the sentence, nothing else.

type Availability = MigrateConnectExistingRepositoryDto['availability'];

const MARK: Record<Availability, { glyph: ReactNode; labelKey: string } | null> = {
  available: null,
  connected_here: {
    glyph: <Check className="size-3.5 flex-none text-(--el-icon-muted)" aria-hidden />,
    labelKey: 'connectedHere',
  },
  connected_elsewhere: {
    glyph: <Lock className="size-3.5 flex-none text-(--el-icon-muted)" aria-hidden />,
    labelKey: 'connectedElsewhere',
  },
};

export interface ExistingRepositoryPickerProps {
  accountLogin: string;
  state: AccountRepositoriesState;
  selected: ReadonlySet<string>;
  /** Rows the link route said another organisation took meanwhile. */
  taken: ReadonlySet<string>;
  /** Opened by the install round trip's `select_repos` (2r.i). */
  fromInstall: boolean;
  /** The account's installation settings on GitHub. */
  manageUrl: string;
  /** An outcome to show on top of the picker (MOTIR-8764). */
  notice?: ReactNode;
  confirming?: boolean;
  onToggle: (repoId: string, next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  onBack: () => void;
  onRetry: () => void;
  /** The chosen ids — the link is behind this seam. */
  onConfirm: (repoIds: string[]) => void;
}

export function ExistingRepositoryPicker({
  accountLogin,
  state,
  selected,
  taken,
  fromInstall,
  manageUrl,
  notice,
  confirming = false,
  onToggle,
  onToggleAll,
  onBack,
  onRetry,
  onConfirm,
}: ExistingRepositoryPickerProps) {
  const t = useTranslations('onboardingMigrate.connect.existing');
  const tPicker = useTranslations('github.picker');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => (state.kind === 'ok' ? state.rows : []), [state]);
  const available = rows.filter((r) => r.availability === 'available' && !taken.has(r.repoId));
  const count = available.filter((r) => selected.has(r.repoId)).length;
  const visible = query.trim()
    ? rows.filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase()))
    : rows;
  const allSelected = available.length > 0 && available.every((r) => selected.has(r.repoId));
  const nothingLeft = state.kind === 'ok' && state.counts.available === 0 && taken.size === 0;

  return (
    <div data-testid="existing-repository-picker" className="grid gap-3">
      <button
        type="button"
        onClick={onBack}
        data-testid="existing-picker-back"
        className="inline-flex w-fit items-center gap-1.5 rounded-(--radius-control) text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent-on-surface)"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('picker.backCta')}
      </button>

      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="inline-flex size-8 flex-none items-center justify-center rounded-full bg-(--el-avatar-fallback) text-sm font-semibold text-(--el-text-inverted)"
        >
          {(accountLogin.trim()[0] ?? '?').toUpperCase()}
        </span>
        <div className="grid gap-1">
          <h3 className="m-0 text-sm font-semibold text-(--el-text)">
            {t('picker.heading', { login: accountLogin })}
          </h3>
          <p className="m-0 max-w-[60ch] text-sm leading-normal text-(--el-text-secondary)">
            {t('picker.hint')}
          </p>
        </div>
      </div>

      {fromInstall ? <PickerNotice title={t('picker.fromInstallHint')} /> : null}
      {notice}

      {state.kind === 'loading' ? (
        <div data-testid="existing-picker-loading" className="grid gap-2" aria-busy="true">
          <p
            role="status"
            className="m-0 flex items-center gap-2.5 text-sm text-(--el-text-secondary)"
          >
            <span aria-hidden className="flex-none text-(--el-highlight)">
              <Spinner size="sm" />
            </span>
            {t('picker.loading')}
          </p>
          <div aria-hidden className="grid gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex min-h-(--height-control) items-center gap-3 px-(--spacing-control-x)"
              >
                <span className="size-4 rounded-(--radius-control) bg-(--el-muted)" />
                <span className="h-3 w-48 rounded-(--radius-control) bg-(--el-muted)" />
              </div>
            ))}
          </div>
        </div>
      ) : state.kind === 'failed' || state.kind === 'not_accessible' ? (
        <ErrorState
          data-testid="existing-picker-error"
          title={tPicker('reposError.title')}
          description={tPicker('reposError.body', { account: accountLogin })}
          retry={onRetry}
          retryLabel={tPicker('retry')}
        />
      ) : nothingLeft ? (
        <NothingLeft
          connectedHere={state.counts.connectedHere}
          connectedElsewhere={state.counts.connectedElsewhere}
          manageUrl={manageUrl}
          onChooseAnother={onBack}
        />
      ) : (
        <>
          <Input
            type="search"
            aria-label={tPicker('search')}
            placeholder={tPicker('search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            addonStart={<Search className="size-4 text-(--el-icon-muted)" aria-hidden />}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 px-(--spacing-control-x)">
            <Checkbox
              checked={allSelected}
              onChange={onToggleAll}
              disabled={available.length === 0}
              label={tPicker('selectAll', { count: available.length })}
              labelVisible
              stateLabels={{
                checked: tPicker('rowState.selected'),
                unchecked: tPicker('rowState.notSelected'),
              }}
            />
            <span
              aria-live="polite"
              data-testid="existing-picker-count"
              className="text-sm text-(--el-text-secondary)"
            >
              {t('picker.selectedCount', { count })}
            </span>
          </div>
          {visible.length === 0 ? (
            <p className="m-0 px-(--spacing-control-x) text-sm text-(--el-text-secondary)">
              {tPicker('noMatches')}
            </p>
          ) : (
            <ul
              aria-label={t('picker.heading', { login: accountLogin })}
              data-testid="existing-picker-list"
              className="m-0 flex max-h-[22rem] list-none flex-col overflow-y-auto p-0"
            >
              {visible.map((row) => (
                <Row
                  key={row.repoId}
                  row={row}
                  taken={taken.has(row.repoId)}
                  checked={selected.has(row.repoId)}
                  onToggle={(next) => onToggle(row.repoId, next)}
                />
              ))}
            </ul>
          )}
          <div
            data-testid="existing-picker-footer"
            className="flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) bg-(--el-card) pt-3"
          >
            {count === 0 ? (
              <p className="m-0 mr-auto text-sm text-(--el-text-secondary)">
                {t('outcome.selectionRequiredTitle')}
              </p>
            ) : (
              <span className="mr-auto" />
            )}
            <Button
              variant="primary"
              size="md"
              disabled={count === 0 || confirming}
              loading={confirming}
              data-testid="existing-picker-confirm"
              onClick={() =>
                onConfirm(available.filter((r) => selected.has(r.repoId)).map((r) => r.repoId))
              }
            >
              {t('picker.confirmCta', { count })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  row,
  taken,
  checked,
  onToggle,
}: {
  row: MigrateConnectExistingRepositoryDto;
  taken: boolean;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const t = useTranslations('onboardingMigrate.connect.existing');
  const tPicker = useTranslations('github.picker');
  const slash = row.fullName.indexOf('/');
  const owner = slash >= 0 ? row.fullName.slice(0, slash + 1) : '';
  const name = slash >= 0 ? row.fullName.slice(slash + 1) : row.fullName;
  const availability: Availability = taken ? 'connected_elsewhere' : row.availability;
  const locked = availability !== 'available';
  const mark = MARK[availability];
  return (
    <li>
      <div
        data-testid="existing-picker-row"
        data-availability={availability}
        data-taken={taken || undefined}
        aria-disabled={locked || undefined}
        className={cn(
          'flex min-h-(--height-control) items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)',
          taken ? 'bg-(--el-tint-sky) text-(--el-text-strong)' : 'hover:bg-(--el-option-active-bg)',
        )}
      >
        <Checkbox
          checked={availability === 'connected_here' ? true : checked && !locked}
          onChange={onToggle}
          disabled={locked}
          label={row.fullName}
          stateLabels={{
            checked: tPicker('rowState.selected'),
            unchecked: tPicker('rowState.notSelected'),
          }}
        />
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className={taken ? undefined : 'text-(--el-text-secondary)'}>{owner}</span>
          <span
            className={
              taken ? undefined : locked ? 'text-(--el-text-secondary)' : 'text-(--el-text)'
            }
          >
            {name}
          </span>
        </span>
        {mark ? (
          <span
            className={cn(
              'flex flex-none items-center gap-1.5 text-xs',
              taken ? undefined : 'text-(--el-text-secondary)',
            )}
          >
            {taken ? <Info className="size-3.5 flex-none" aria-hidden /> : mark.glyph}
            {t(`picker.${mark.labelKey}`)}
            {availability === 'connected_elsewhere' ? (
              <span className="sr-only"> {t('picker.connectedElsewhereHint')}</span>
            ) : null}
          </span>
        ) : (
          <span className="sr-only">{t('picker.available')}</span>
        )}
      </div>
    </li>
  );
}

function PickerNotice({ title }: { title: string }) {
  return (
    <p
      role="status"
      className="m-0 flex items-start gap-2.5 rounded-(--radius-control) bg-(--el-tint-sky) px-(--spacing-control-x) py-(--spacing-control-y) text-sm leading-normal text-(--el-text-strong)"
    >
      <Info className="mt-0.5 size-4 flex-none" aria-hidden />
      <span>{title}</span>
    </p>
  );
}

/** 2q: nothing on this account is left to connect — an explicit panel, never
 *  an empty list. The counts are counts: _elsewhere_ never becomes a name. */
function NothingLeft({
  connectedHere,
  connectedElsewhere,
  manageUrl,
  onChooseAnother,
}: {
  connectedHere: number;
  connectedElsewhere: number;
  manageUrl: string;
  onChooseAnother: () => void;
}) {
  const t = useTranslations('onboardingMigrate.connect');
  const tNone = useTranslations('github.picker.noneLeft');
  const tile =
    'flex min-w-[9rem] flex-col gap-0.5 rounded-(--radius-card) border border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y)';
  return (
    <div data-testid="existing-picker-nothing-left" className="grid gap-3">
      <p className="m-0 flex items-center gap-2.5 text-sm font-semibold text-(--el-text)">
        <CircleSlash className="size-4 flex-none text-(--el-icon-muted)" aria-hidden />
        {t('existing.picker.nothingLeftTitle')}
      </p>
      <div className="flex flex-wrap gap-3">
        <div className={tile} data-testid="existing-picker-count-here">
          <span className="text-xl font-semibold text-(--el-text)">{connectedHere}</span>
          <span className="text-xs text-(--el-text-secondary)">{tNone('connectedHere')}</span>
        </div>
        <div className={tile} data-testid="existing-picker-count-elsewhere">
          <span className="text-xl font-semibold text-(--el-text)">{connectedElsewhere}</span>
          <span className="text-xs text-(--el-text-secondary)">{tNone('connectedElsewhere')}</span>
        </div>
      </div>
      <p className="m-0 max-w-[60ch] text-sm leading-normal text-(--el-text-secondary)">
        {t('existing.picker.nothingLeftHint')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="md" onClick={onChooseAnother}>
          {tNone('chooseAnother')}
        </Button>
        <a
          href={manageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-(--radius-control) text-sm text-(--el-text-secondary) underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent-on-surface)"
        >
          {t('existing.picker.nothingLeftCta')}
          <ExternalLink className="size-3.5" aria-hidden />
          <span className="sr-only"> {t('newTab')}</span>
        </a>
      </div>
    </div>
  );
}
