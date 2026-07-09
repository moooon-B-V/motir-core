'use client';

import { useId, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, CircleDot, FileUp, GitBranch, SquareKanban, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';
import { Pill } from '@/components/ui/Pill';
import { Combobox } from '@/components/ui/Combobox';
import { cn } from '@/lib/utils/cn';
import type { ConnectionConfig, ImportSourceId } from './importClient';
import type { WizardConnected } from './ImportWizard';

export interface ConnectionDraft {
  jira: { baseUrl: string; projectKey: string };
  linear: { teamKey: string };
  github: { owner: string; repo: string };
  plane: { baseUrl: string; workspaceSlug: string; projectId: string };
  csv: { filename: string; content: string; externalIdColumn: string; header: string[] };
}

export const emptyDraft: ConnectionDraft = {
  jira: { baseUrl: '', projectKey: '' },
  linear: { teamKey: '' },
  github: { owner: '', repo: '' },
  plane: { baseUrl: '', workspaceSlug: '', projectId: '' },
  csv: { filename: '', content: '', externalIdColumn: '', header: [] },
};

/** Prefill the draft from an already-connected identity's metadata (Jira site,
 *  Plane base URL / workspace) so a post-OAuth return doesn't lose the instance. */
export function seedDraft(connected: WizardConnected): Partial<ConnectionDraft> {
  return {
    jira: { baseUrl: connected.siteUrl ?? '', projectKey: '' },
    plane: {
      baseUrl: connected.baseUrl ?? '',
      workspaceSlug: connected.workspaceSlug ?? '',
      projectId: '',
    },
  };
}

/** Assemble the API connection config from the draft, or null if a required
 *  field for the chosen source is missing (drives the Next button's disabled
 *  state). The credential is NEVER here — it comes from the token store. */
export function buildConnection(
  source: ImportSourceId,
  draft: ConnectionDraft,
): ConnectionConfig | null {
  switch (source) {
    case 'jira':
      return draft.jira.baseUrl.trim()
        ? {
            source: 'jira',
            baseUrl: draft.jira.baseUrl.trim(),
            projectKey: draft.jira.projectKey.trim() || undefined,
          }
        : null;
    case 'linear':
      return { source: 'linear', teamKey: draft.linear.teamKey.trim() || undefined };
    case 'github':
      return draft.github.owner.trim() && draft.github.repo.trim()
        ? { source: 'github', owner: draft.github.owner.trim(), repo: draft.github.repo.trim() }
        : null;
    case 'plane':
      return draft.plane.workspaceSlug.trim() && draft.plane.projectId.trim()
        ? {
            source: 'plane',
            baseUrl: draft.plane.baseUrl.trim() || undefined,
            workspaceSlug: draft.plane.workspaceSlug.trim(),
            projectId: draft.plane.projectId.trim(),
          }
        : null;
    case 'csv':
      return draft.csv.filename && draft.csv.content
        ? {
            source: 'csv',
            filename: draft.csv.filename,
            content: draft.csv.content,
            columnMap: draft.csv.externalIdColumn
              ? { externalId: draft.csv.externalIdColumn }
              : undefined,
          }
        : null;
  }
}

const LIVE_SOURCES: Exclude<ImportSourceId, 'csv'>[] = ['jira', 'linear', 'github', 'plane'];
const ALL_SOURCES: ImportSourceId[] = [...LIVE_SOURCES, 'csv'];

const SOURCE_ICON: Record<ImportSourceId, typeof GitBranch> = {
  jira: SquareKanban,
  linear: CircleDot,
  github: GitBranch,
  plane: Table2,
  csv: FileUp,
};
// Distinct tint slots per source (kept mutually distinct — never invented hues).
const SOURCE_TINT: Record<ImportSourceId, string> = {
  jira: 'bg-(--el-tint-sky)',
  linear: 'bg-(--el-tint-lavender)',
  github: 'bg-(--el-tint-mint)',
  plane: 'bg-(--el-tint-rose)',
  csv: 'bg-(--el-tint-peach)',
};

/** The OAuth "Connect" launch URL for a live source. `returnTo` is the wizard
 *  door the round-trip returns to, so the wizard works from BOTH the /onboarding
 *  entrance and the Settings home rather than a single hardcoded path (the start
 *  route validates it against the open-redirect class). GitHub reuses the
 *  existing 7.10 connection, which owns its own return target; Plane also carries
 *  its instance base URL + workspace slug. */
function connectHref(
  source: Exclude<ImportSourceId, 'csv'>,
  draft: ConnectionDraft,
  returnTo: string,
): string {
  const params = new URLSearchParams();
  switch (source) {
    case 'jira':
      params.set('returnTo', returnTo);
      return `/api/import/jira/oauth/start?${params.toString()}`;
    case 'linear':
      params.set('returnTo', returnTo);
      return `/api/import/linear/oauth/start?${params.toString()}`;
    case 'github':
      // GitHub's 7.10 flow owns its own return target (Settings › GitHub); the
      // wizard just reads the resulting connected state. No returnTo to pass.
      return '/api/github/oauth/start';
    case 'plane': {
      if (draft.plane.baseUrl.trim()) params.set('baseUrl', draft.plane.baseUrl.trim());
      if (draft.plane.workspaceSlug.trim())
        params.set('workspaceSlug', draft.plane.workspaceSlug.trim());
      params.set('returnTo', returnTo);
      return `/api/import/plane/oauth/start?${params.toString()}`;
    }
  }
}

export function ConnectStep({
  source,
  onSelectSource,
  draft,
  onDraftChange,
  connected,
  canProceed,
  busy,
  error,
  justConnectedFailed,
  onNext,
}: {
  source: ImportSourceId | null;
  onSelectSource: (s: ImportSourceId) => void;
  draft: ConnectionDraft;
  onDraftChange: (d: ConnectionDraft) => void;
  connected: Record<Exclude<ImportSourceId, 'csv'>, WizardConnected>;
  canProceed: boolean;
  busy: boolean;
  error: { code: string } | null;
  justConnectedFailed: boolean;
  onNext: () => void;
}) {
  const t = useTranslations('import');
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const baseId = useId();

  function patch(next: Partial<ConnectionDraft>) {
    onDraftChange({ ...draft, ...next });
  }

  async function onCsvFile(file: File) {
    setCsvError(null);
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setCsvError(t('errors.invalid'));
      return;
    }
    const content = await file.text();
    const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
    const header = firstLine
      .split(',')
      .map((h) => h.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    onDraftChange({
      ...draft,
      csv: { filename: file.name, content, externalIdColumn: '', header },
    });
  }

  const sourceName = (s: ImportSourceId) => t(`connect.sources.${s}.name`);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-(--el-text-strong)">{t('connect.heading')}</h2>
        <p className="text-sm text-(--el-text-muted)">{t('connect.body')}</p>
      </div>

      {/* Source cards */}
      <div
        role="radiogroup"
        aria-label={t('connect.heading')}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        {ALL_SOURCES.map((s) => {
          const Icon = SOURCE_ICON[s];
          const selected = source === s;
          const isLive = s !== 'csv';
          const isConnected = isLive && connected[s as Exclude<ImportSourceId, 'csv'>]?.connected;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelectSource(s)}
              className={cn(
                'flex flex-col items-start gap-2 rounded-(--radius-card) border p-4 text-left transition-shadow',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                selected
                  ? 'border-(--el-accent) ring-2 ring-[color-mix(in_srgb,var(--el-accent)_18%,transparent)]'
                  : 'border-(--el-border) hover:shadow-(--shadow-card)',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-9 items-center justify-center rounded-(--radius-control) text-(--el-text-strong)',
                  SOURCE_TINT[s],
                )}
              >
                <Icon className="size-4.5" />
              </span>
              <span className="text-sm font-medium text-(--el-text)">{sourceName(s)}</span>
              <span className="text-xs text-(--el-text-muted)">
                {t(`connect.sources.${s}.meta`)}
              </span>
              {isLive ? (
                <Pill
                  severity={isConnected ? 'success' : undefined}
                  tone={isConnected ? undefined : 'neutral'}
                >
                  {isConnected ? t('connect.connected') : t('connect.notConnected')}
                </Pill>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Per-source connection panel */}
      {source ? (
        <div className="flex flex-col gap-4 rounded-(--radius-card) border border-(--el-border) p-4">
          {source !== 'csv' ? (
            <LiveConnect
              source={source}
              draft={draft}
              patch={patch}
              connected={connected[source as Exclude<ImportSourceId, 'csv'>]}
              baseId={baseId}
            />
          ) : (
            <CsvConnect
              draft={draft}
              patch={patch}
              csvError={csvError}
              csvInputRef={csvInputRef}
              onCsvFile={onCsvFile}
              baseId={baseId}
            />
          )}
        </div>
      ) : null}

      {/* Connect / probe error callouts */}
      {(error || justConnectedFailed) && source ? (
        <div
          role="alert"
          className="rounded-(--radius-card) bg-(--el-tint-rose) p-3 text-sm text-(--el-text-strong)"
        >
          <p className="font-medium">
            {t('connect.connectFailedTitle', { source: sourceName(source) })}
          </p>
          <p className="text-(--el-text-strong)">
            {error?.code === 'IMPORT_SOURCE_NOT_CONNECTED'
              ? t('connect.notConnectedError', { source: sourceName(source) })
              : t('errors.generic')}
          </p>
        </div>
      ) : null}

      <Footer>
        <a href="/onboarding" className="text-sm text-(--el-link) hover:text-(--el-link-pressed)">
          {t('chrome.cancel')}
        </a>
        <Button onClick={onNext} disabled={!canProceed} loading={busy}>
          {t('connect.next')}
        </Button>
      </Footer>
    </section>
  );
}

function LiveConnect({
  source,
  draft,
  patch,
  connected,
  baseId,
}: {
  source: Exclude<ImportSourceId, 'csv'>;
  draft: ConnectionDraft;
  patch: (next: Partial<ConnectionDraft>) => void;
  connected: WizardConnected;
  baseId: string;
}) {
  const t = useTranslations('import');
  const name = t(`connect.sources.${source}.name`);
  // Return to THIS door after the connect round-trip, preserving the resume
  // params (the active project) so a re-open lands where the user was.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId');
  const returnTo = projectId ? `${pathname}?projectId=${encodeURIComponent(projectId)}` : pathname;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {connected.connected ? (
            <Pill severity="success">
              <Check className="mr-1 inline size-3" aria-hidden />
              {t('connect.connected')}
            </Pill>
          ) : (
            <Pill tone="neutral">{t('connect.notConnected')}</Pill>
          )}
          {source === 'github' ? (
            <span className="text-xs text-(--el-text-muted)">{t('connect.githubReuse')}</span>
          ) : null}
        </div>
        <a href={connectHref(source, draft, returnTo)}>
          <Button variant={connected.connected ? 'secondary' : 'primary'} size="sm">
            {connected.connected
              ? t('connect.reconnectButton')
              : t('connect.connectButton', { source: name })}
          </Button>
        </a>
      </div>
      <p className="text-xs text-(--el-text-muted)">{t('connect.connectHint', { source: name })}</p>

      {source === 'jira' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t('connect.baseUrlLabel')}
            htmlFor={`${baseId}-jira-base`}
            helperText={t('connect.baseUrlHint')}
          >
            <Input
              id={`${baseId}-jira-base`}
              value={draft.jira.baseUrl}
              placeholder={t('connect.baseUrlPlaceholder')}
              onChange={(e) => patch({ jira: { ...draft.jira, baseUrl: e.target.value } })}
            />
          </FormField>
          <FormField
            label={t('connect.jiraProjectKeyLabel')}
            htmlFor={`${baseId}-jira-key`}
            helperText={t('connect.jiraProjectKeyHint')}
          >
            <Input
              id={`${baseId}-jira-key`}
              value={draft.jira.projectKey}
              onChange={(e) => patch({ jira: { ...draft.jira, projectKey: e.target.value } })}
            />
          </FormField>
        </div>
      ) : null}

      {source === 'linear' ? (
        <FormField label={t('connect.linearTeamKeyLabel')} htmlFor={`${baseId}-linear-team`}>
          <Input
            id={`${baseId}-linear-team`}
            value={draft.linear.teamKey}
            onChange={(e) => patch({ linear: { teamKey: e.target.value } })}
          />
        </FormField>
      ) : null}

      {source === 'github' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t('connect.repoOwnerLabel')} htmlFor={`${baseId}-gh-owner`}>
            <Input
              id={`${baseId}-gh-owner`}
              value={draft.github.owner}
              onChange={(e) => patch({ github: { ...draft.github, owner: e.target.value } })}
            />
          </FormField>
          <FormField label={t('connect.repoNameLabel')} htmlFor={`${baseId}-gh-repo`}>
            <Input
              id={`${baseId}-gh-repo`}
              value={draft.github.repo}
              onChange={(e) => patch({ github: { ...draft.github, repo: e.target.value } })}
            />
          </FormField>
        </div>
      ) : null}

      {source === 'plane' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField
            label={t('connect.baseUrlLabel')}
            htmlFor={`${baseId}-plane-base`}
            helperText={t('connect.baseUrlHint')}
          >
            <Input
              id={`${baseId}-plane-base`}
              value={draft.plane.baseUrl}
              placeholder={t('connect.baseUrlPlaceholder')}
              onChange={(e) => patch({ plane: { ...draft.plane, baseUrl: e.target.value } })}
            />
          </FormField>
          <FormField label={t('connect.workspaceSlugLabel')} htmlFor={`${baseId}-plane-ws`}>
            <Input
              id={`${baseId}-plane-ws`}
              value={draft.plane.workspaceSlug}
              onChange={(e) => patch({ plane: { ...draft.plane, workspaceSlug: e.target.value } })}
            />
          </FormField>
          <FormField label={t('connect.planeProjectIdLabel')} htmlFor={`${baseId}-plane-proj`}>
            <Input
              id={`${baseId}-plane-proj`}
              value={draft.plane.projectId}
              onChange={(e) => patch({ plane: { ...draft.plane, projectId: e.target.value } })}
            />
          </FormField>
        </div>
      ) : null}
    </>
  );
}

function CsvConnect({
  draft,
  patch,
  csvError,
  csvInputRef,
  onCsvFile,
  baseId,
}: {
  draft: ConnectionDraft;
  patch: (next: Partial<ConnectionDraft>) => void;
  csvError: string | null;
  csvInputRef: React.RefObject<HTMLInputElement | null>;
  onCsvFile: (file: File) => void;
  baseId: string;
}) {
  const t = useTranslations('import');
  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={() => csvInputRef.current?.click()}
        className="flex flex-col items-center gap-1 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-6 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <FileUp className="size-6 text-(--el-text-muted)" aria-hidden />
        <span className="text-sm text-(--el-text)">{t('connect.csv.dropzone')}</span>
        <span className="text-xs text-(--el-text-muted)">{t('connect.csv.dropzoneHint')}</span>
      </button>
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        aria-label={t('connect.csv.dropzone')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onCsvFile(file);
        }}
      />
      {csvError ? (
        <p
          role="alert"
          className="rounded-(--radius-card) bg-(--el-tint-rose) p-2 text-sm text-(--el-text-strong)"
        >
          {csvError}
        </p>
      ) : null}
      {draft.csv.filename ? (
        <div className="flex items-center gap-2 text-sm text-(--el-text)">
          <Check className="size-4 text-(--el-success)" aria-hidden />
          {t('connect.csv.fileReady', { filename: draft.csv.filename })}
        </div>
      ) : null}
      {draft.csv.header.length > 0 ? (
        <FormField
          label={t('connect.csv.idColumnLabel')}
          htmlFor={`${baseId}-csv-id`}
          helperText={t('connect.csv.idColumnHint')}
        >
          <Combobox
            label={t('connect.csv.idColumnLabel')}
            placeholder={t('connect.csv.idColumnPlaceholder')}
            value={draft.csv.externalIdColumn || null}
            onChange={(v) => patch({ csv: { ...draft.csv, externalIdColumn: v } })}
            options={draft.csv.header.map((h) => ({ value: h, label: h }))}
            searchable
          />
        </FormField>
      ) : null}
    </div>
  );
}

export function Footer({ children }: { children: React.ReactNode }) {
  return (
    <footer className="flex items-center justify-between gap-3 border-t border-(--el-border) pt-4">
      {children}
    </footer>
  );
}
