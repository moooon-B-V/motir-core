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
  repoRefs,
  initialAudit,
  initialConventions,
  loadError,
}: {
  projectId: string;
  /** The connected repos this page would audit (`owner/name`), resolved by the
   * server page. REQUIRED: the audit tab's pre-audit copy is false unless it
   * knows whether there is any code at all (MOTIR-2081). */
  repoRefs: string[];
  initialAudit: CodeAuditSurfaceDTO | null;
  initialConventions: ConventionSurfaceDTO[];
  loadError: string | false;
}) {
  const t = useTranslations('codeHealth');
  const [tab, setTab] = useState<Tab>('audit');

  // Every read is repo-SCOPED (MOTIR-2123). Both boundary reads REQUIRE a
  // `repoKey` — motir-ai's `/v1/code-audit` and `/v1/convention` each
  // `requireQuery` it — so an unscoped fetch is a 400, and the fan-out means the
  // conventions are a SET, one surface per connected repo, exactly what the page
  // seeded and what `ConventionPanel` renders a card each for.
  //
  // The audit stays on ONE repo — the same first repo the page rendered — which
  // is what keeps the re-audit poll watching the surface on screen rather than
  // tripping on a sibling repo's fresh audit now that every repo derives one.
  const auditRepoRef = repoRefs[0] ?? null;
  const auditUrl = (params: Record<string, string> = {}): string | null =>
    auditRepoRef === null
      ? null
      : `${AUDIT_URL}?${new URLSearchParams({ repoKey: auditRepoRef, ...params }).toString()}`;
  const conventionUrl = (repoKey: string): string =>
    `${CONVENTION_URL}?${new URLSearchParams({ repoKey }).toString()}`;

  const [audit, setAudit] = useState<CodeAuditSurfaceDTO | null>(initialAudit);
  const [conventions, setConventions] = useState<ConventionSurfaceDTO[]>(initialConventions);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reauditing, setReauditing] = useState(false);
  // The FIRST-audit poll ran out while the job kept going (MOTIR-2080). Held apart
  // from `error` on purpose: it is a resting state the audit tab draws, not a
  // failure, and the rose strip would tell the user their audit broke.
  const [pollExhausted, setPollExhausted] = useState(false);
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
    const url = auditUrl();
    if (url === null) {
      // No connected repo: there is nothing to read, and the page seeded nothing
      // either. Not an error state — the audit tab draws the start-fresh case.
      setAudit(null);
      setConventions([]);
      return;
    }
    try {
      const [aRes, cResList] = await Promise.all([
        fetch(url),
        Promise.all(repoRefs.map((repoKey) => fetch(conventionUrl(repoKey)))),
      ]);
      if (!aRes.ok || cResList.some((r) => !r.ok)) throw new Error('load failed');
      setAudit((await aRes.json()) as CodeAuditSurfaceDTO);
      const surfaces = (await Promise.all(cResList.map((r) => r.json()))) as ConventionSurfaceDTO[];
      // Same per-repo filter the page seeds with: a repo with nothing derived
      // yet renders no card, and never suppresses the repos that do have one.
      setConventions(surfaces.filter((c) => c.convention !== null));
    } catch {
      setError(t('errorLoad'));
    }
  }

  async function loadMoreFindings() {
    if (!audit || audit.nextOffset === null || loadingMore) return;
    const url = auditUrl({ findingsOffset: String(audit.nextOffset) });
    if (url === null) return;
    const seq = ++pageSeq.current;
    setLoadingMore(true);
    try {
      const res = await fetch(url);
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
    setPollExhausted(false);
    try {
      const res = await fetch(REFRESH_URL, { method: 'POST' });
      if (!res.ok) throw new Error('refresh failed');
      // ONE POST per click, whatever the poll does — the trigger's own fan-out
      // over the repo set happens server-side, so a poll tick must never re-POST.
      const url = auditUrl();
      if (url === null) return;
      for (let i = 0; i < REAUDIT_POLL_TRIES; i++) {
        await delay(REAUDIT_POLL_MS);
        if (seq !== reauditSeq.current) return;
        const aRes = await fetch(url);
        if (!aRes.ok) continue;
        const next = (await aRes.json()) as CodeAuditSurfaceDTO;
        if (next.audit && next.audit.id !== prevAuditId) {
          if (seq !== reauditSeq.current) return;
          await reload();
          return;
        }
      }
      // The 60s window (3s × 20) is a UI wait, not a job timeout — the audit keeps
      // running either way. Where that gets SAID differs by what is on screen: a
      // FIRST audit has an empty screen to rest in (State D, MOTIR-2080), while a
      // re-audit still shows the previous report, so it keeps today's strip.
      if (prevAuditId === null) setPollExhausted(true);
      else setError(t('deepen.reauditPending'));
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
          repoRefs={repoRefs}
          findings={audit?.findings ?? []}
          total={audit?.total ?? 0}
          hasMore={(audit?.nextOffset ?? null) !== null}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMoreFindings()}
          scanner={audit?.scanner ?? null}
          reauditing={reauditing}
          onReaudit={() => void reaudit()}
          pollExhausted={pollExhausted}
          // "Check again" re-READS; it must never re-POST /refresh, which would
          // queue a second code_audit + propose_convention pair for work already
          // in flight. `reload()` setAudit()s the island's own state — the
          // page-state contract's case 3, since a server re-read cannot reach a
          // client island seeded from useState(initialProps).
          onCheckAgain={() => {
            setPollExhausted(false);
            void reload();
          }}
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
