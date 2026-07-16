'use client';

import { useTranslations } from 'next-intl';
import { Sparkles, FileSearch } from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown/render';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';
import type { ConventionSurfaceDTO } from '@/lib/dto/codeHealth';

// Per-repo read-only convention surface (MOTIR-1663). The convention is derived +
// auto-used — there is no approve gate and no free-edit. Each connected repo gets
// its own card, expandable to show the read-only convention document (Adopted
// rules + provenance badges), with a "Refine with Motir" entry that opens the
// universal AI chat launcher.
//
// The old approve/edit form, status banners (PROPOSED/STANDARD), confirmation
// modal, and editable Textarea are removed.
export function ConventionPanel({ conventions }: { conventions: ConventionSurfaceDTO[] }) {
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
        <RepoConventionCard key={c.repoKey ?? '__default__'} convention={c} />
      ))}
    </div>
  );
}

function RepoConventionCard({ convention: c }: { convention: ConventionSurfaceDTO }) {
  const t = useTranslations('codeHealth');
  // The derived convention is auto-used — the standard IS the one injected.
  // If neither proposed nor standard exists, the repo hasn't been audited yet.
  const current = c.standard ?? c.proposed;

  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-(--el-text-strong)">
              {c.repoKey ?? t('convention.defaultRepo')}
            </span>
            {c.standard ? (
              <Pill severity="success">
                {t('convention.versionStandard', { version: c.standard.version })}
              </Pill>
            ) : c.proposed ? (
              <Pill status="planned">
                {t('convention.versionDerived', { version: c.proposed.version })}
              </Pill>
            ) : null}
          </div>
          <PlanWithAILauncher context={{ kind: 'convention-refine', repoKey: c.repoKey ?? '' }} />
        </div>
      }
    >
      {current ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 bg-(--el-surface-soft) p-3 rounded-(--radius-card)">
            <Sparkles
              className="mt-0.5 size-4 shrink-0 text-(--el-accent-on-surface)"
              aria-hidden
            />
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-(--el-text-strong)">
                {t('convention.bannerDerivedTitle')}
              </span>
              <span className="text-sm text-(--el-text-secondary)">
                {t('convention.bannerDerivedBody')}
              </span>
            </div>
          </div>
          <ConventionDocument contentMd={current.contentMd} />
          <ProvenanceList provenance={current.provenance} />
        </div>
      ) : (
        <p className="text-sm text-(--el-text-muted)">{t('convention.noRules')}</p>
      )}
      {c.versions.length > 1 ? <VersionHistory versions={c.versions} /> : null}
    </Card>
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

function VersionHistory({ versions }: { versions: ConventionSurfaceDTO['versions'] }) {
  const t = useTranslations('codeHealth');
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
            <Pill tone="neutral">v{v.version}</Pill>
            <StatusLabel status={v.status} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StatusLabel({ status }: { status: 'proposed' | 'standard' | 'superseded' }) {
  const t = useTranslations('codeHealth');
  switch (status) {
    case 'standard':
      return <Pill severity="success">{t('convention.status.standard')}</Pill>;
    case 'proposed':
      return <Pill status="planned">{t('convention.status.derived')}</Pill>;
    default:
      return <Pill tone="archived">{t('convention.status.superseded')}</Pill>;
  }
}
