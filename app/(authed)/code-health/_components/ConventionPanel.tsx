'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, ShieldCheck, Pencil, Check, FileSearch } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CodingConventionDTO, ConventionSurfaceDTO } from '@/lib/dto/codeHealth';

// Panels 2–4 (7.14.1): the proposed-convention REVIEW + the approve gate + version
// history. A pending PROPOSED draft (State A) is editable in place and approvable;
// once approved the STANDARD (State B) is the injected house-rules document and is
// NOT editable in place (a change is a new proposed version — the 7.14.7 refresh).
export function ConventionPanel({
  convention,
  busy,
  onSaveDraft,
  onApprove,
}: {
  convention: ConventionSurfaceDTO;
  busy: boolean;
  onSaveDraft: (conventionId: string, contentMd: string) => Promise<void>;
  onApprove: (conventionId: string) => Promise<void>;
}) {
  const t = useTranslations('codeHealth');
  const current = convention.proposed ?? convention.standard;

  if (!current) {
    return (
      <EmptyState
        icon={<FileSearch aria-hidden />}
        title={t('convention.emptyTitle')}
        description={t('convention.emptyDescription')}
      />
    );
  }

  const isProposed = current.status === 'proposed';
  return (
    <div className="flex flex-col gap-4">
      {isProposed ? (
        <ProposedConvention
          convention={current}
          busy={busy}
          onSaveDraft={onSaveDraft}
          onApprove={onApprove}
        />
      ) : (
        <StandardConvention convention={current} />
      )}
      <VersionHistory versions={convention.versions} />
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

function ProvenanceList({ convention }: { convention: CodingConventionDTO }) {
  const t = useTranslations('codeHealth');
  if (convention.provenance.length === 0) return null;
  return (
    <Card
      header={
        <span className="text-sm font-medium text-(--el-text-strong)">
          {t('convention.provenanceTitle')}
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {convention.provenance.map((p) => (
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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{contentMd}</ReactMarkdown>
    </div>
  );
}

function ProposedConvention({
  convention,
  busy,
  onSaveDraft,
  onApprove,
}: {
  convention: CodingConventionDTO;
  busy: boolean;
  onSaveDraft: (conventionId: string, contentMd: string) => Promise<void>;
  onApprove: (conventionId: string) => Promise<void>;
}) {
  const t = useTranslations('codeHealth');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(convention.contentMd);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-(--el-text-strong)">
              {t('convention.title')}
            </span>
            <Pill tone="neutral">
              {t('convention.versionProposed', { version: convention.version })}
            </Pill>
          </div>
          {!editing ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Pencil className="size-4" aria-hidden />}
                onClick={() => {
                  setDraft(convention.contentMd);
                  setEditing(true);
                }}
              >
                {t('convention.edit')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Check className="size-4" aria-hidden />}
                onClick={() => setConfirmOpen(true)}
              >
                {t('convention.approve')}
              </Button>
            </div>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2 bg-(--el-warning-surface) p-3 rounded-(--radius-card)">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-(--el-text-strong)">
              {t('convention.bannerProposedTitle')}
            </span>
            <span className="text-sm text-(--el-text-secondary)">
              {t('convention.bannerProposedBody')}
            </span>
          </div>
        </div>

        {editing ? (
          <div className="flex flex-col gap-3">
            <Textarea
              label={t('convention.editorLabel')}
              helperText={t('convention.editorHelper')}
              rows={16}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                leftIcon={<Check className="size-4" aria-hidden />}
                loading={busy}
                onClick={() => setConfirmOpen(true)}
              >
                {t('convention.approve')}
              </Button>
              <Button
                variant="secondary"
                loading={busy}
                onClick={async () => {
                  await onSaveDraft(convention.id, draft);
                  setEditing(false);
                }}
              >
                {t('convention.saveDraft')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                {t('convention.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ConventionDocument contentMd={convention.contentMd} />
            <ProvenanceList convention={convention} />
          </>
        )}
      </div>

      <Modal
        open={confirmOpen}
        onOpenChange={(o) => (!o ? setConfirmOpen(false) : undefined)}
        role="alertdialog"
        title={t('convention.confirmTitle')}
        size="md"
      >
        <div className="flex flex-col gap-4" aria-busy={busy || undefined}>
          <p className="text-sm text-(--el-text-secondary)">
            {t('convention.confirmBody', { version: convention.version })}
          </p>
          <Modal.Footer>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmOpen(false)}>
              {t('convention.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              leftIcon={<Check className="size-4" aria-hidden />}
              onClick={async () => {
                // If the draft was edited but not yet saved, persist it first so the
                // approved standard is what the reviewer sees.
                if (editing && draft !== convention.contentMd) {
                  await onSaveDraft(convention.id, draft);
                }
                await onApprove(convention.id);
                setConfirmOpen(false);
                setEditing(false);
              }}
            >
              {t('convention.confirmApprove')}
            </Button>
          </Modal.Footer>
        </div>
      </Modal>
    </Card>
  );
}

function StandardConvention({ convention }: { convention: CodingConventionDTO }) {
  const t = useTranslations('codeHealth');
  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-(--el-text-strong)">
              {t('convention.title')}
            </span>
            <Pill severity="success">
              {t('convention.versionStandard', { version: convention.version })}
            </Pill>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2 bg-(--el-success-surface) p-3 rounded-(--radius-card)">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-(--el-success)" aria-hidden />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-(--el-text-strong)">
              {t('convention.bannerStandardTitle')}
            </span>
            <span className="text-sm text-(--el-text-secondary)">
              {t('convention.bannerStandardBody')}
            </span>
          </div>
        </div>
        <ConventionDocument contentMd={convention.contentMd} />
        <ProvenanceList convention={convention} />
      </div>
    </Card>
  );
}

function VersionHistory({ versions }: { versions: CodingConventionDTO[] }) {
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
            {v.status === 'standard' ? (
              <span className="text-(--el-text-muted)">· {t('convention.activeStandard')}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StatusLabel({ status }: { status: CodingConventionDTO['status'] }) {
  const t = useTranslations('codeHealth');
  switch (status) {
    case 'standard':
      return <Pill severity="success">{t('convention.status.standard')}</Pill>;
    case 'proposed':
      return <Pill status="planned">{t('convention.status.proposed')}</Pill>;
    default:
      return <Pill tone="archived">{t('convention.status.superseded')}</Pill>;
  }
}
