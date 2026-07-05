'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { AuditPanel } from './AuditPanel';
import { ConventionPanel } from './ConventionPanel';
import type { CodeAuditSurfaceDTO, ConventionSurfaceDTO } from '@/lib/dto/codeHealth';

type Tab = 'audit' | 'convention';

const AUDIT_URL = '/api/ai/coding-convention/audit';
const CONVENTION_URL = '/api/ai/coding-convention/convention';

// The Code-health interactive surface (Subtask 7.14.5): the Audit | Convention tabs
// over the two panels. Seeded once from the server-fetched DTOs (props → useState);
// findings paginate and edit/approve mutate through the API routes, updating local
// island state (the mutation fires from inside this island — the page-state contract's
// client-island case; no router.refresh reaches it). A boundary failure surfaces as
// the retry Card.
export function CodeHealthClient({
  initialAudit,
  initialConvention,
  loadError,
}: {
  initialAudit: CodeAuditSurfaceDTO | null;
  initialConvention: ConventionSurfaceDTO | null;
  loadError: boolean;
}) {
  const t = useTranslations('codeHealth');
  const [tab, setTab] = useState<Tab>('audit');

  const [audit, setAudit] = useState<CodeAuditSurfaceDTO | null>(initialAudit);
  const [convention, setConvention] = useState<ConventionSurfaceDTO | null>(initialConvention);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(loadError ? t('errorLoad') : null);
  // Guards overlapping findings pages so a stale response can't double-append.
  const pageSeq = useRef(0);

  async function reload() {
    setError(null);
    try {
      const [aRes, cRes] = await Promise.all([fetch(AUDIT_URL), fetch(CONVENTION_URL)]);
      if (!aRes.ok || !cRes.ok) throw new Error('load failed');
      setAudit((await aRes.json()) as CodeAuditSurfaceDTO);
      setConvention((await cRes.json()) as ConventionSurfaceDTO);
    } catch {
      setError(t('errorLoad'));
    }
  }

  async function loadMoreFindings() {
    if (!audit || audit.nextOffset === null || loadingMore) return;
    const seq = ++pageSeq.current;
    setLoadingMore(true);
    try {
      const res = await fetch(`${AUDIT_URL}?findingsOffset=${audit.nextOffset}`);
      if (!res.ok) throw new Error('page failed');
      const next = (await res.json()) as CodeAuditSurfaceDTO;
      if (seq !== pageSeq.current) return; // a newer page won
      setAudit((prev) =>
        prev
          ? { ...prev, findings: [...prev.findings, ...next.findings], nextOffset: next.nextOffset }
          : next,
      );
    } catch {
      setError(t('errorLoadMore'));
    } finally {
      if (seq === pageSeq.current) setLoadingMore(false);
    }
  }

  async function saveDraft(conventionId: string, contentMd: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${CONVENTION_URL}/${conventionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentMd }),
      });
      if (!res.ok) throw new Error('save failed');
      // Re-read the surface so proposed + version history reflect the edit.
      await reload();
    } catch {
      setError(t('errorSave'));
    } finally {
      setBusy(false);
    }
  }

  async function approve(conventionId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${CONVENTION_URL}/${conventionId}/approve`, { method: 'POST' });
      if (!res.ok) throw new Error('approve failed');
      // The proposed became the standard + a prior standard was demoted — re-read.
      await reload();
    } catch {
      setError(t('errorApprove'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Segmented<Tab>
        label={t('tabsLabel')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'audit', label: t('tabs.audit') },
          { value: 'convention', label: t('tabs.convention') },
        ]}
      />

      {error ? (
        <Card tint="rose">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-(--el-text-strong)">{error}</span>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              {t('retry')}
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === 'audit' ? (
        <AuditPanel
          audit={audit?.audit ?? null}
          findings={audit?.findings ?? []}
          total={audit?.total ?? 0}
          hasMore={(audit?.nextOffset ?? null) !== null}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMoreFindings()}
        />
      ) : (
        <ConventionPanel
          convention={
            convention ?? { proposed: null, standard: null, versions: [], nextCursor: null }
          }
          busy={busy}
          onSaveDraft={saveDraft}
          onApprove={approve}
        />
      )}
    </div>
  );
}
