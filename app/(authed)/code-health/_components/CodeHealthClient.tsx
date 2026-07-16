'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
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
const REFRESH_URL = '/api/ai/coding-convention/refresh';

const REAUDIT_POLL_MS = 3000;
const REAUDIT_POLL_TRIES = 20;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const dismissKey = (projectId: string) => `motir:code-health:deepen-dismissed:${projectId}`;
const dismissListeners = new Set<() => void>();
function subscribeDismiss(cb: () => void): () => void {
  dismissListeners.add(cb);
  return () => {
    dismissListeners.delete(cb);
  };
}
function readDismissed(projectId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(projectId)) === '1';
  } catch {
    return false;
  }
}
function writeDismissed(projectId: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(dismissKey(projectId), '1');
    else localStorage.removeItem(dismissKey(projectId));
  } catch {
    // localStorage unavailable
  }
  dismissListeners.forEach((l) => l());
}

// The Code-health interactive surface (MOTIR-926/1663): the Audit | Convention
// tabs over the two panels. The convention panel is read-only per-repo
// (MOTIR-1663 — approve/edit removed). Seeded once from the server-fetched
// DTOs; findings paginate through the API routes.
export function CodeHealthClient({
  projectId,
  initialAudit,
  initialConventions,
  loadError,
}: {
  projectId: string;
  initialAudit: CodeAuditSurfaceDTO | null;
  initialConventions: ConventionSurfaceDTO[];
  loadError: string | false;
}) {
  const t = useTranslations('codeHealth');
  const [tab, setTab] = useState<Tab>('audit');

  const [audit, setAudit] = useState<CodeAuditSurfaceDTO | null>(initialAudit);
  const [conventions, setConventions] = useState<ConventionSurfaceDTO[]>(initialConventions);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reauditing, setReauditing] = useState(false);
  const [error, setError] = useState<string | null>(
    loadError ? `${t('errorLoad')} — ${loadError}` : null,
  );
  const pageSeq = useRef(0);
  const reauditSeq = useRef(0);

  const deepenDismissed = useSyncExternalStore(
    subscribeDismiss,
    () => readDismissed(projectId),
    () => false,
  );

  async function reload() {
    setError(null);
    try {
      const [aRes, cRes] = await Promise.all([fetch(AUDIT_URL), fetch(CONVENTION_URL)]);
      if (!aRes.ok || !cRes.ok) throw new Error('load failed');
      setAudit((await aRes.json()) as CodeAuditSurfaceDTO);
      setConventions([(await cRes.json()) as ConventionSurfaceDTO]);
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
      if (seq !== pageSeq.current) return;
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

  async function reaudit() {
    if (reauditing) return;
    const seq = ++reauditSeq.current;
    const prevAuditId = audit?.audit?.id ?? null;
    setReauditing(true);
    setError(null);
    try {
      const res = await fetch(REFRESH_URL, { method: 'POST' });
      if (!res.ok) throw new Error('refresh failed');
      for (let i = 0; i < REAUDIT_POLL_TRIES; i++) {
        await delay(REAUDIT_POLL_MS);
        if (seq !== reauditSeq.current) return;
        const aRes = await fetch(AUDIT_URL);
        if (!aRes.ok) continue;
        const next = (await aRes.json()) as CodeAuditSurfaceDTO;
        if (next.audit && next.audit.id !== prevAuditId) {
          if (seq !== reauditSeq.current) return;
          await reload();
          return;
        }
      }
      setError(t('deepen.reauditPending'));
    } catch {
      setError(t('errorReaudit'));
    } finally {
      if (seq === reauditSeq.current) setReauditing(false);
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
          scanner={audit?.scanner ?? null}
          reauditing={reauditing}
          onReaudit={() => void reaudit()}
          deepenDismissed={deepenDismissed}
          onDeepenDismiss={() => writeDismissed(projectId, true)}
          onDeepenReopen={() => writeDismissed(projectId, false)}
        />
      ) : (
        <ConventionPanel conventions={conventions} />
      )}
    </div>
  );
}
