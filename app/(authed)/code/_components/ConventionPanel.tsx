'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, FileSearch, Info } from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown/render';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Textarea } from '@/components/ui/Textarea';
import type { CodingConventionDTO, ConventionSurfaceDTO } from '@/lib/dto/codeHealth';

// The longest convention a person may save, in characters — the same number the
// server enforces (`CONVENTION_MAX_CHARS` in aiConventionService, which a client
// module cannot import: it reaches the database).
const MAX_CHARS = 65_536;

const CONVENTION_URL = '/api/ai/coding-convention/convention';

// Per-repo convention surface. A repository's convention is derived from its code
// and auto-used (MOTIR-1660/1663), and a person with `ai:configure` can WRITE it
// (MOTIR-9079/9082): Edit saves a new `edited` version through motir-ai, and a
// later re-derive parks its output beside that text instead of replacing it. The
// page itself is gated on `ai:configure`, so `canEdit` is the courtesy the design
// asks for (Edit absent, not disabled), not the gate — the server enforces it.
export function ConventionPanel({
  conventions,
  onSaved,
  canEdit = true,
}: {
  conventions: ConventionSurfaceDTO[];
  // Hands the re-read surface of the repository just saved to the island that owns
  // the set (page-state contract, case 3: a client island seeded from props).
  onSaved?: (surface: ConventionSurfaceDTO) => void;
  canEdit?: boolean;
}) {
  const t = useTranslations('codeHealth');

  if (conventions.length === 0) {
    return (
      <EmptyState
        icon={<FileSearch aria-hidden />}
        title={t('convention.emptyTitle')}
        description={t('convention.emptyDescription')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {conventions.map((c) => (
        <RepoConventionCard
          key={c.repoKey ?? '__default__'}
          convention={c}
          canEdit={canEdit}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

type EditState =
  | { mode: 'read' }
  | { mode: 'edit'; draft: string; base: number; saving: boolean; failed: boolean }
  | { mode: 'conflict'; draft: string; base: number; latest: ConventionSurfaceDTO; copy: boolean };

function RepoConventionCard({
  convention: c,
  canEdit,
  onSaved,
}: {
  convention: ConventionSurfaceDTO;
  canEdit: boolean;
  onSaved?: (surface: ConventionSurfaceDTO) => void;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  // The latest version IS the one injected — derived or edited, auto-used. Null
  // means the repo has neither been audited nor written yet.
  const current = c.convention;
  const [state, setState] = useState<EditState>({ mode: 'read' });
  const [comparing, setComparing] = useState(false);
  const repoKey = c.repoKey;

  const startEdit = () =>
    setState({
      mode: 'edit',
      draft: current?.contentMd ?? '',
      base: current?.version ?? 0,
      saving: false,
      failed: false,
    });

  const save = async () => {
    if (state.mode !== 'edit' || repoKey === null) return;
    const { draft, base } = state;
    setState({ ...state, saving: true, failed: false });
    try {
      const res = await fetch(CONVENTION_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoKey, contentMd: draft, baseVersion: base }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as { latest?: ConventionSurfaceDTO };
        if (body.latest) {
          setState({ mode: 'conflict', draft, base, latest: body.latest, copy: false });
          return;
        }
      }
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      const saved = (await res.json()) as ConventionSurfaceDTO;
      setState({ mode: 'read' });
      setComparing(false);
      onSaved?.(saved);
    } catch {
      setState({ mode: 'edit', draft, base, saving: false, failed: true });
    }
  };

  // "Load their version": adopt the surface the conflict carried, close the editor.
  const loadTheirs = () => {
    if (state.mode !== 'conflict') return;
    onSaved?.(state.latest);
    setState({ mode: 'read' });
  };

  const editing = state.mode !== 'read';
  const edited = current?.authorKind === 'edited';
  const pending = edited ? current.pendingDerivedMd : null;

  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-(--el-text-strong)">
              {c.repoKey ?? t('convention.defaultRepo')}
            </span>
            {current ? (
              edited ? (
                <Pill severity="info">
                  {t('convention.versionEdited', { version: current.version })}
                </Pill>
              ) : (
                <Pill status="planned">
                  {t('convention.versionDerived', { version: current.version })}
                </Pill>
              )
            ) : null}
            {current ? (
              <span className="text-xs text-(--el-text-secondary)">
                {edited
                  ? current.editedByName
                    ? t('convention.bylineEdited', {
                        name: current.editedByName,
                        date: format.dateTime(new Date(current.createdAt), { dateStyle: 'medium' }),
                      })
                    : t('convention.bylineEditedUnknown', {
                        date: format.dateTime(new Date(current.createdAt), { dateStyle: 'medium' }),
                      })
                  : t('convention.bylineDerived')}
              </span>
            ) : null}
          </div>
          {canEdit && current && !editing ? (
            <Button variant="secondary" size="sm" onClick={startEdit}>
              {t('convention.edit')}
            </Button>
          ) : null}
        </div>
      }
    >
      {state.mode === 'edit' ? (
        <ConventionEditor
          state={state}
          next={(current?.version ?? 0) + 1}
          version={current?.version ?? 0}
          onChange={(draft) => setState({ ...state, draft, failed: false })}
          onCancel={() => setState({ mode: 'read' })}
          onSave={() => void save()}
        />
      ) : state.mode === 'conflict' ? (
        <ConventionConflict
          state={state}
          onLoadTheirs={loadTheirs}
          onKeepMine={() => setState({ ...state, copy: true })}
        />
      ) : current ? (
        <div className="flex flex-col gap-4">
          {pending ? (
            <PendingDerived
              current={current}
              pending={pending}
              comparing={comparing}
              onToggle={() => setComparing((v) => !v)}
            />
          ) : null}
          <ConventionDocument contentMd={current.contentMd} />
          {edited ? null : <ProvenanceList provenance={current.provenance} />}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-(--el-text-secondary)">
            {canEdit ? t('convention.emptyWriteBody') : t('convention.noRules')}
          </p>
          {canEdit ? (
            <Button variant="primary" size="sm" onClick={startEdit}>
              {t('convention.writeFirst')}
            </Button>
          ) : null}
        </div>
      )}
      {c.versions.length > 1 ? (
        <VersionHistory versions={c.versions} currentId={current?.id ?? null} />
      ) : null}
    </Card>
  );
}

function ConventionEditor({
  state,
  next,
  version,
  onChange,
  onCancel,
  onSave,
}: {
  state: Extract<EditState, { mode: 'edit' }>;
  next: number;
  version: number;
  onChange: (draft: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  const count = state.draft.length;
  const tooLong = count > MAX_CHARS;
  const blank = state.draft.trim().length === 0;
  const error = state.failed
    ? t('convention.saveFailed')
    : tooLong
      ? t('convention.tooLong', { max: format.number(MAX_CHARS) })
      : undefined;
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium text-(--el-text-secondary)">
        {t('convention.editingVersion', { version })}
      </span>
      <Textarea
        label={t('convention.editFieldLabel')}
        rows={14}
        value={state.draft}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        helperText={`${t('convention.saveCreates', {
          next,
          count: format.number(count),
          max: format.number(MAX_CHARS),
        })} ${t('convention.editHelper')}`}
        className="font-mono text-xs"
      />
      {blank && count > 0 ? (
        <p className="text-xs text-(--el-text-secondary)">{t('convention.blank')}</p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={state.saving}>
          {t('convention.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onSave}
          loading={state.saving}
          disabled={blank || tooLong || state.saving}
        >
          {state.saving ? t('convention.saving') : t('convention.save')}
        </Button>
      </div>
    </div>
  );
}

function ConventionConflict({
  state,
  onLoadTheirs,
  onKeepMine,
}: {
  state: Extract<EditState, { mode: 'conflict' }>;
  onLoadTheirs: () => void;
  onKeepMine: () => void;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  const latest = state.latest.convention;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) p-(--spacing-card-padding-12)"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
        <div className="flex flex-col gap-3">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-(--el-text-strong)">
              {t('convention.conflictTitle')}
            </span>
            <span className="text-sm text-(--el-text-secondary)">
              {t('convention.conflictBody', {
                name: latest?.editedByName ?? t('convention.bylineDerived'),
                latest: latest?.version ?? 0,
                date: latest
                  ? format.dateTime(new Date(latest.createdAt), { dateStyle: 'medium' })
                  : '',
                base: state.base,
              })}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={onLoadTheirs}>
              {t('convention.conflictLoadTheirs')}
            </Button>
            {state.copy ? null : (
              <Button variant="secondary" size="sm" onClick={onKeepMine}>
                {t('convention.conflictKeepMine')}
              </Button>
            )}
          </div>
        </div>
      </div>
      {state.copy ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-(--el-text-secondary)">
            {t('convention.conflictCopyLabel')}
          </span>
          <Textarea
            aria-label={t('convention.conflictCopyLabel')}
            readOnly
            rows={10}
            value={state.draft}
            helperText={t('convention.conflictCopyHint')}
            className="font-mono text-xs"
          />
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(state.draft)}
            >
              {t('convention.copy')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PendingDerived({
  current,
  pending,
  comparing,
  onToggle,
}: {
  current: CodingConventionDTO;
  pending: string;
  comparing: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-surface-soft) p-(--spacing-card-padding-12)">
        <Info className="mt-0.5 size-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
        <div className="flex flex-col gap-3">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-(--el-text-strong)">
              {t('convention.pendingTitle')}
            </span>
            <span className="text-sm text-(--el-text-secondary)">
              {t('convention.pendingBody', {
                date: format.dateTime(new Date(current.createdAt), { dateStyle: 'medium' }),
              })}
            </span>
          </div>
          <div>
            <Button variant="secondary" size="sm" onClick={onToggle} aria-expanded={comparing}>
              {t('convention.pendingCompare')}
            </Button>
          </div>
        </div>
      </div>
      {comparing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <ComparisonColumn
            label={t('convention.pendingInUse', { version: current.version })}
            contentMd={current.contentMd}
          />
          <ComparisonColumn label={t('convention.pendingWaiting')} contentMd={pending} />
        </div>
      ) : null}
    </div>
  );
}

function ComparisonColumn({ label, contentMd }: { label: string; contentMd: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding-12)">
      <span className="text-xs font-semibold text-(--el-text-secondary)">{label}</span>
      <ConventionDocument contentMd={contentMd} />
    </div>
  );
}

function ProvenanceBadge({ source }: { source: 'adopted' | 'proposed' }) {
  const t = useTranslations('codeHealth');
  return source === 'adopted' ? (
    <Pill severity="success">{t('convention.provenance.adopted')}</Pill>
  ) : (
    <Pill status="planned">{t('convention.provenance.proposed')}</Pill>
  );
}

function ProvenanceList({
  provenance,
}: {
  provenance: { ruleId: string; category: string; source: 'adopted' | 'proposed' }[];
}) {
  const t = useTranslations('codeHealth');
  if (provenance.length === 0) return null;
  return (
    <Card
      header={
        <span className="text-sm font-medium text-(--el-text-strong)">
          {t('convention.provenanceTitle')}
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {provenance.map((p) => (
          <li key={p.ruleId} className="flex flex-wrap items-center gap-2 text-sm">
            <ProvenanceBadge source={p.source} />
            <span className="font-medium text-(--el-text-strong)">{p.ruleId}</span>
            <span className="text-(--el-text-muted)">· {p.category}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-(--el-text-muted)">{t('convention.provenanceLegend')}</p>
    </Card>
  );
}

function ConventionDocument({ contentMd }: { contentMd: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed text-(--el-text) [&_h1]:font-serif [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-(--el-text-strong) [&_h2]:mt-3 [&_h2]:font-serif [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-(--el-text-strong) [&_h3]:mt-2 [&_h3]:font-medium [&_h3]:text-(--el-text-strong) [&_ul]:list-disc [&_ul]:pl-5 [&_code]:text-(--el-text-identifier) [&_a]:text-(--el-link)">
      {renderMarkdown(contentMd)}
    </div>
  );
}

// The design's `.version` list (design/coding-convention, Panel 4): a mono version
// id, the CURRENT marker, and when the version was derived. It switches on
// identity, never on a lifecycle `status` — MOTIR-1660/1662 deleted that
// lifecycle and motir-ai does not send one (MOTIR-2127).
function VersionHistory({
  versions,
  currentId,
}: {
  versions: ConventionSurfaceDTO['versions'];
  currentId: string | null;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  if (versions.length === 0) return null;
  return (
    <Card
      header={
        <span className="text-sm font-medium text-(--el-text-strong)">
          {t('convention.historyTitle')}
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs font-semibold text-(--el-text-secondary)">
              v{v.version}
            </span>
            {v.id === currentId ? (
              <Pill status="planned">{t('convention.historyCurrent')}</Pill>
            ) : null}
            <span className="text-xs text-(--el-text-muted)">
              {format.relativeTime(new Date(v.createdAt))}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
