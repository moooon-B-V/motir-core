'use client';

import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Combobox } from '@/components/ui/Combobox';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { cn } from '@/lib/utils/cn';
import { Footer } from './ConnectStep';
import type {
  ImportSourceId,
  Mapping,
  Vocabulary,
  WorkItemKind,
  WorkItemPriority,
  UnmatchedUserPolicy,
} from './importClient';
import type { WizardStatusOption } from './ImportWizard';

const KINDS: WorkItemKind[] = ['epic', 'story', 'task', 'bug', 'subtask'];
const PRIORITIES: WorkItemPriority[] = ['lowest', 'low', 'medium', 'high', 'highest'];
const USER_POLICIES: UnmatchedUserPolicy[] = ['unassign', 'importing_user', 'invite'];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const KIND_SYNONYMS: Record<string, WorkItemKind> = {
  epic: 'epic',
  story: 'story',
  userstory: 'story',
  feature: 'story',
  task: 'task',
  improvement: 'task',
  chore: 'task',
  bug: 'bug',
  defect: 'bug',
  incident: 'bug',
  subtask: 'subtask',
  sub: 'subtask',
};
const PRIORITY_SYNONYMS: Record<string, WorkItemPriority> = {
  highest: 'highest',
  urgent: 'highest',
  critical: 'highest',
  blocker: 'highest',
  high: 'high',
  major: 'high',
  medium: 'medium',
  normal: 'medium',
  none: 'medium',
  low: 'low',
  minor: 'low',
  lowest: 'lowest',
  trivial: 'lowest',
};

/** Auto-propose a mapping from the discovered vocabulary, then merge the user's
 *  prior edits on top (so a re-discover doesn't clobber choices). Every match is
 *  a proposal the user can override; nothing is silently dropped. */
export function buildInitialMapping(
  vocab: Vocabulary,
  statuses: WizardStatusOption[],
  prev: Mapping,
): Mapping {
  const typeToKind: Record<string, WorkItemKind> = {};
  for (const type of vocab.types) {
    const hit = KIND_SYNONYMS[norm(type)];
    if (hit) typeToKind[type] = hit;
  }
  const statusToKey: Record<string, string> = {};
  for (const status of vocab.statuses) {
    const match = statuses.find(
      (s) => norm(s.key) === norm(status) || norm(s.label) === norm(status),
    );
    if (match) statusToKey[status] = match.key;
  }
  const priorityToPriority: Record<string, WorkItemPriority> = {};
  for (const priority of vocab.priorities) {
    const hit = PRIORITY_SYNONYMS[norm(priority)];
    if (hit) priorityToPriority[priority] = hit;
  }
  return {
    defaultKind: prev.defaultKind ?? 'task',
    unmatchedUserPolicy: prev.unmatchedUserPolicy ?? 'unassign',
    defaultStatusKey: prev.defaultStatusKey ?? null,
    typeToKind: { ...typeToKind, ...prev.typeToKind },
    statusToKey: { ...statusToKey, ...prev.statusToKey },
    priorityToPriority: { ...priorityToPriority, ...prev.priorityToPriority },
  };
}

/** The one blocking decision: a source status with neither a per-value mapping
 *  nor a fallback default. (Priority defaults to `medium`; the unmatched-user
 *  policy defaults to `unassign` — neither blocks.) */
export function countUnresolved(vocab: Vocabulary, mapping: Mapping): number {
  if (mapping.defaultStatusKey) return 0;
  return vocab.statuses.filter((s) => !mapping.statusToKey?.[s]).length;
}

export function MapStep({
  source,
  sourceRef,
  issueCount,
  vocabulary,
  statuses,
  mapping,
  onMappingChange,
  unresolved,
  busy,
  error,
  onBack,
  onNext,
}: {
  source: ImportSourceId;
  sourceRef: string;
  issueCount: number | null;
  vocabulary: Vocabulary;
  statuses: WizardStatusOption[];
  mapping: Mapping;
  onMappingChange: (m: Mapping) => void;
  unresolved: number;
  busy: boolean;
  error: { code: string } | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useTranslations('import');

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-(--el-text-strong)">{t('map.heading')}</h2>
        <p className="text-sm text-(--el-text-muted)">{t('map.body')}</p>
        <p className="text-xs text-(--el-text-tertiary)">
          {issueCount != null
            ? t('connect.reachable', { count: issueCount, ref: sourceRef })
            : t('connect.reachableUnknown', { ref: sourceRef })}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 text-xs font-medium uppercase tracking-wide text-(--el-text-tertiary) sm:grid-cols-[1fr_auto_1fr]">
        <span>{t('map.colSource', { source: t(`connect.sources.${source}.name`) })}</span>
        <span aria-hidden className="hidden sm:block" />
        <span>{t('map.colTarget')}</span>
      </div>

      <div className="flex flex-col divide-y divide-(--el-border)">
        {/* Issue type → kind */}
        <MapSection label={t('map.rowType')}>
          {vocabulary.types.length === 0 ? (
            <DefaultKindRow mapping={mapping} onMappingChange={onMappingChange} />
          ) : (
            vocabulary.types.map((type) => (
              <MapRow
                key={type}
                sourceLabel={type}
                tag={mapping.typeToKind?.[type] ? 'auto' : undefined}
              >
                <KindSelect
                  value={mapping.typeToKind?.[type] ?? mapping.defaultKind ?? 'task'}
                  onChange={(v) =>
                    onMappingChange({
                      ...mapping,
                      typeToKind: { ...mapping.typeToKind, [type]: v },
                    })
                  }
                />
              </MapRow>
            ))
          )}
        </MapSection>

        {/* Status → workflow_status */}
        <MapSection label={t('map.rowStatus')}>
          {vocabulary.statuses.map((status) => {
            const mapped = mapping.statusToKey?.[status];
            const unmatchedNow = !mapped && !mapping.defaultStatusKey;
            return (
              <MapRow
                key={status}
                sourceLabel={status}
                warn={unmatchedNow ? t('map.unmatched') : undefined}
              >
                <Combobox
                  label={t('map.rowStatus')}
                  placeholder={t('map.chooseStatus')}
                  value={mapped ?? null}
                  onChange={(v) =>
                    onMappingChange({
                      ...mapping,
                      statusToKey: { ...mapping.statusToKey, [status]: v },
                    })
                  }
                  options={statuses.map((s) => ({ value: s.key, label: s.label }))}
                  searchable
                />
              </MapRow>
            );
          })}
          <MapRow sourceLabel={t('map.defaultKindLabel')} muted>
            <Combobox
              label={t('map.chooseStatus')}
              placeholder={t('map.chooseStatus')}
              value={mapping.defaultStatusKey ?? null}
              onChange={(v) => onMappingChange({ ...mapping, defaultStatusKey: v })}
              options={statuses.map((s) => ({ value: s.key, label: s.label }))}
              searchable
            />
          </MapRow>
        </MapSection>

        {/* Priority */}
        {vocabulary.priorities.length > 0 ? (
          <MapSection label={t('map.rowPriority')}>
            {vocabulary.priorities.map((priority) => (
              <MapRow
                key={priority}
                sourceLabel={priority}
                tag={mapping.priorityToPriority?.[priority] ? 'auto' : undefined}
              >
                <Combobox
                  label={t('map.rowPriority')}
                  placeholder={t('map.choosePriority')}
                  value={mapping.priorityToPriority?.[priority] ?? 'medium'}
                  onChange={(v) =>
                    onMappingChange({
                      ...mapping,
                      priorityToPriority: {
                        ...mapping.priorityToPriority,
                        [priority]: v as WorkItemPriority,
                      },
                    })
                  }
                  options={PRIORITIES.map((p) => ({ value: p, label: p }))}
                />
              </MapRow>
            ))}
          </MapSection>
        ) : null}

        {/* Assignee & reporter — a single unmatched-user policy */}
        <MapSection label={t('map.rowUsers')}>
          <MapRow sourceLabel={t('map.unmatchedUserLabel')}>
            <Combobox
              label={t('map.unmatchedUserLabel')}
              value={mapping.unmatchedUserPolicy ?? 'unassign'}
              onChange={(v) =>
                onMappingChange({ ...mapping, unmatchedUserPolicy: v as UnmatchedUserPolicy })
              }
              options={USER_POLICIES.map((p) => ({
                value: p,
                label:
                  p === 'unassign'
                    ? t('map.userPolicyUnassign')
                    : p === 'importing_user'
                      ? t('map.userPolicyImporter')
                      : t('map.userPolicyInvite'),
              }))}
            />
          </MapRow>
        </MapSection>

        {/* Labels — created as Motir labels (auto, no control) */}
        <MapSection label={t('map.rowLabels')}>
          {vocabulary.labels.length === 0 ? (
            <p className="py-2 text-sm text-(--el-text-muted)">{t('map.labelsNone')}</p>
          ) : (
            <div className="flex flex-col gap-2 py-2">
              <div className="flex flex-wrap gap-1.5">
                {vocabulary.labels.map((label) => (
                  <Pill key={label} tone="neutral">
                    {label}
                  </Pill>
                ))}
              </div>
              <span className="text-xs text-(--el-text-tertiary)">{t('map.labelsCreate')}</span>
            </div>
          )}
        </MapSection>
      </div>

      {unresolved > 0 ? (
        <p
          role="status"
          className="rounded-(--radius-card) bg-(--el-tint-peach) p-3 text-sm text-(--el-text-strong)"
        >
          {t('map.unresolved', { count: unresolved })}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-(--radius-card) bg-(--el-tint-rose) p-3 text-sm text-(--el-text-strong)"
        >
          {t('errors.generic')}
        </p>
      ) : null}

      <Footer>
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          {t('chrome.back')}
        </Button>
        <div className="flex items-center gap-3">
          {unresolved > 0 ? (
            <span className="text-xs text-(--el-text-muted)">
              {t('map.nextBlocked', { count: unresolved })}
            </span>
          ) : null}
          <Button onClick={onNext} disabled={unresolved > 0 || busy} loading={busy}>
            {t('map.next')}
          </Button>
        </div>
      </Footer>
    </section>
  );
}

function MapSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-4">
      <span className="text-xs font-medium uppercase tracking-wide text-(--el-text-tertiary)">
        {label}
      </span>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function MapRow({
  sourceLabel,
  tag,
  warn,
  muted,
  children,
}: {
  sourceLabel: string;
  tag?: string;
  warn?: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations('import');
  return (
    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'truncate font-mono text-sm',
            muted ? 'text-(--el-text-muted)' : 'text-(--el-text)',
          )}
        >
          {sourceLabel}
        </span>
        {tag ? (
          <span className="font-mono text-xs text-(--el-text-tertiary)">{t('map.auto')}</span>
        ) : null}
        {warn ? <Pill severity="warning">{warn}</Pill> : null}
      </div>
      <ArrowRight className="hidden size-4 text-(--el-text-faint) sm:block" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function DefaultKindRow({
  mapping,
  onMappingChange,
}: {
  mapping: Mapping;
  onMappingChange: (m: Mapping) => void;
}) {
  const t = useTranslations('import');
  return (
    <MapRow sourceLabel={t('map.defaultKindLabel')} muted>
      <KindSelect
        value={mapping.defaultKind ?? 'task'}
        onChange={(v) => onMappingChange({ ...mapping, defaultKind: v })}
      />
    </MapRow>
  );
}

function KindSelect({
  value,
  onChange,
}: {
  value: WorkItemKind;
  onChange: (v: WorkItemKind) => void;
}) {
  const t = useTranslations('import');
  return (
    <Combobox
      label={t('map.chooseKind')}
      placeholder={t('map.chooseKind')}
      value={value}
      onChange={(v) => onChange(v as WorkItemKind)}
      options={KINDS.map((k) => ({
        value: k,
        label: k,
        icon: <IssueTypeIcon type={k} className="size-4" />,
      }))}
    />
  );
}
