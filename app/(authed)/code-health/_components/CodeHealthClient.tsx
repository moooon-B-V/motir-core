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

// After triggering a re-audit the jobs run async on the worker; poll the audit
// surface until a NEW CodeAudit row lands, then re-read every surface (the
// page-state-after-mutation contract). Bounded so a slow/queued job stops the
// spinner gracefully rather than polling forever.
const REAUDIT_POLL_MS = 3000;
const REAUDIT_POLL_TRIES = 20;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Per-project "Deepen this audit" dismissal, persisted in localStorage so it does
// not nag on every visit (Panel 6 State D). Read through useSyncExternalStore: the
// server snapshot is always `false` (no localStorage), so there is no hydration
// mismatch and no set-state-in-effect — the client re-reads after hydration and on
// every write. A module-level notifier covers same-tab writes (the `storage` event
// only fires cross-tab).
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
    // localStorage unavailable — dismissal falls back to non-persistent (the card
    // simply reappears next visit); never throw from a UI toggle.
  }
  dismissListeners.forEach((l) => l());
}

// The Code-health interactive surface (Subtask 7.14.5): the Audit | Convention tabs
// over the two panels. Seeded once from the server-fetched DTOs (props → useState);
// findings paginate and edit/approve mutate through the API routes, updating local
// island state (the mutation fires from inside this island — the page-state contract's
// client-island case; no router.refresh reaches it). A boundary failure surfaces as
// the retry Card.
export function CodeHealthClient({
  projectId,
  initialAudit,
  initialConvention,
  loadError,
}: {
  projectId: string;
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
  const [reauditing, setReauditing] = useState(false);
  const [error, setError] = useState<string | null>(loadError ? t('errorLoad') : null);
  // Guards overlapping findings pages so a stale response can't double-append.
  const pageSeq = useRef(0);
  // Guards overlapping re-audit polls so a superseded run can't clobber state.
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

  // "Re-audit now" (the Deepen affordance): trigger a re-audit, then poll until the
  // fresh audit lands and re-read every surface (report + convention). The mutation
  // fires from inside this island, so it updates local state directly.
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
        if (seq !== reauditSeq.current) return; // superseded by a newer trigger
        const aRes = await fetch(AUDIT_URL);
        if (!aRes.ok) continue;
        const next = (await aRes.json()) as CodeAuditSurfaceDTO;
        if (next.audit && next.audit.id !== prevAuditId) {
          if (seq !== reauditSeq.current) return;
          await reload();
          return;
        }
      }
      // Still queued after the poll budget — stop the spinner, tell the user it is
      // running; a later visit / reload shows the deepened report.
      setError(t('deepen.reauditPending'));
    } catch {
      setError(t('errorReaudit'));
    } finally {
      if (seq === reauditSeq.current) setReauditing(false);
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
          scanner={audit?.scanner ?? null}
          reauditing={reauditing}
          onReaudit={() => void reaudit()}
          deepenDismissed={deepenDismissed}
          onDeepenDismiss={() => writeDismissed(projectId, true)}
          onDeepenReopen={() => writeDismissed(projectId, false)}
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
