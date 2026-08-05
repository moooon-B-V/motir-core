'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { AuditPanel } from './AuditPanel';
import { AuditRepoList } from './AuditRepoList';
import { ConventionPanel } from './ConventionPanel';
import type {
  CodeAuditSurfaceDTO,
  ConventionSurfaceDTO,
  ReauditResultDTO,
  RepoAuditSurfaceDTO,
} from '@/lib/dto/codeHealth';
import { buildRepoAuditRows, defaultSelectedRepoKey } from '@/lib/codeHealth/repoAuditRows';
import type { JobStatus } from '@/lib/ai/types';

type Tab = 'audit' | 'convention';

// The cheapest LEGAL per-repo SUMMARY read — motir-ai's `parsePositiveInt`
// rejects `0`, so the floor is one row (Panel 7 §3). Mirrors the page's own
// constant; the island re-reads the same two-phase shape the server seeded with.
const SUMMARY_FINDINGS_LIMIT = '1';

const AUDIT_URL = '/api/ai/coding-convention/audit';
const CONVENTION_URL = '/api/ai/coding-convention/convention';
const REFRESH_URL = '/api/ai/coding-convention/refresh';
const JOB_URL = '/api/ai/jobs';

const REAUDIT_POLL_MS = 3000;
const REAUDIT_POLL_TRIES = 20;

// The two NON-terminal job statuses (`lib/ai/types.ts`). Everything else —
// `succeeded` / `failed` / `canceled` — means the run is over as far as this
// page is concerned, so the stored record has done its job and clears.
const ACTIVE_JOB_STATUSES: readonly string[] = ['queued', 'running'];

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

// ── The in-flight run, kept where it SURVIVES the page (MOTIR-2223) ──────────
//
// `AuditPanel`'s deriving copy says "You can leave this page — the audit keeps
// running." The JOB half was always true (motir-ai persists each job; the poll
// below is only an OBSERVER, so navigating away cancels nothing). The PAGE half
// was not: `reauditing` is `useState` and the trigger's returned job ids were
// thrown away, so a returning user met State B's PRIMARY "Run the first audit"
// on a project mid-audit — and one click queued the whole fan-out a second time.
// `reaudit()`'s `if (reauditing) return;` is in-memory, so MOTIR-2123's ONE-POST
// invariant held per click and not across a page leave.
//
// So the ids the POST already returns are persisted here, and resumed on mount
// against the SERVER (design/coding-convention § Panel 7 · 5b). Same mechanism
// as the deepen-dismissed flag above — a second use of a shipped pattern, not a
// new one. Deliberately per BROWSER: another device still shows the pre-audit
// state, the job still lands there, and the copy never promises otherwise.
const runKey = (projectId: string) => `motir:code-health:reaudit-run:${projectId}`;
const runListeners = new Set<() => void>();
function subscribeRun(cb: () => void): () => void {
  runListeners.add(cb);
  return () => {
    runListeners.delete(cb);
  };
}

// `useSyncExternalStore` compares snapshots by IDENTITY, so parsing the JSON on
// every call would hand React a fresh object each render and loop forever.
// Memoize the parse against the exact raw string (and project) it came from.
let runCache: { projectId: string; raw: string | null; value: ReauditResultDTO | null } = {
  projectId: '',
  raw: null,
  value: null,
};

function parseRun(raw: string): ReauditResultDTO | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const repos = (parsed as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos)) return null;
  // A record with no job id to read back is not resumable — treat a corrupt or
  // superseded entry as no record at all rather than wedging the trigger.
  const valid = repos.filter(
    (r): r is ReauditResultDTO['repos'][number] =>
      typeof (r as { auditJobId?: unknown })?.auditJobId === 'string' &&
      (r as { auditJobId: string }).auditJobId !== '',
  );
  return valid.length > 0 ? { repos: valid } : null;
}

function readRun(projectId: string): ReauditResultDTO | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(runKey(projectId));
  } catch {
    // localStorage unavailable — behave exactly as before this record existed.
    raw = null;
  }
  if (runCache.projectId === projectId && runCache.raw === raw) return runCache.value;
  runCache = { projectId, raw, value: raw === null ? null : parseRun(raw) };
  return runCache.value;
}

function writeRun(projectId: string, run: ReauditResultDTO): void {
  try {
    localStorage.setItem(runKey(projectId), JSON.stringify(run));
  } catch {
    // localStorage unavailable
  }
  runListeners.forEach((l) => l());
}

function clearRun(projectId: string): void {
  try {
    localStorage.removeItem(runKey(projectId));
  } catch {
    // localStorage unavailable
  }
  runListeners.forEach((l) => l());
}

// The Code-health interactive surface (MOTIR-926/1663): the Audit | Convention
// tabs over the two panels. The convention panel is read-only per-repo
// (MOTIR-1663 — approve/edit removed). Seeded once from the server-fetched
// DTOs; findings paginate through the API routes.
export function CodeHealthClient({
  projectId,
  repoRefs,
  initialAudits,
  initialSelectedRepoKey,
  initialSelectedAudit,
  initialConventions,
  loadError,
}: {
  projectId: string;
  /** The connected repos this page would audit (`owner/name`), resolved by the
   * server page. REQUIRED: the audit tab's pre-audit copy is false unless it
   * knows whether there is any code at all (MOTIR-2081). */
  repoRefs: string[];
  /** ONE entry per connected repo, at SUMMARY depth — the list's source
   *  (MOTIR-2207 · Panel 7). An entry's `surface === null` means that repo's
   *  read failed; `surface.audit === null` means it has no audit yet. */
  initialAudits: RepoAuditSurfaceDTO[];
  initialSelectedRepoKey: string | null;
  /** The selected repo's report, read at the FULL findings page size. */
  initialSelectedAudit: CodeAuditSurfaceDTO | null;
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
  // The AUDIT is now a set too (MOTIR-2207): every connected repo has a row, and
  // the SELECTED repo has the report. `auditUrl` therefore takes its repo
  // explicitly — there is no ambient "the audit repo" left to get wrong.
  const auditUrl = (repoKey: string, params: Record<string, string> = {}): string =>
    `${AUDIT_URL}?${new URLSearchParams({ repoKey, ...params }).toString()}`;
  const summaryUrl = (repoKey: string): string =>
    auditUrl(repoKey, { findingsLimit: SUMMARY_FINDINGS_LIMIT });
  const conventionUrl = (repoKey: string): string =>
    `${CONVENTION_URL}?${new URLSearchParams({ repoKey }).toString()}`;

  const [audits, setAudits] = useState<RepoAuditSurfaceDTO[]>(initialAudits);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(initialSelectedRepoKey);
  // The selected repo's FULL report, tagged with the repo it belongs to. Tagging
  // it is what keeps a slower switch from painting the previous repo's findings
  // under the new repo's name — and `nextOffset` is an offset into ONE audit, so
  // switching repos RESETS the list rather than appending to it (Panel 7 §3).
  const [report, setReport] = useState<{ repoKey: string; surface: CodeAuditSurfaceDTO } | null>(
    initialSelectedRepoKey !== null && initialSelectedAudit !== null
      ? { repoKey: initialSelectedRepoKey, surface: initialSelectedAudit }
      : null,
  );
  const [conventions, setConventions] = useState<ConventionSurfaceDTO[]>(initialConventions);
  // The repos a run has queued whose audit has not changed since. NOT a DTO
  // field: inventing one would be a motir-ai change and a two-repo straddle
  // (Panel 7 §5) — `reaudit()` already answers with exactly which repos it fired.
  const [derivingRepos, setDerivingRepos] = useState<string[]>([]);
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
  // The report currently being fetched for a repo switch. Guards the same stale
  // race `pageSeq` guards for pagination: a slow read for repo A must not land
  // after the user has already moved to repo B.
  const reportSeq = useRef(0);
  // Each queued repo's audit id AS IT WAS when the run was fired. A repo stops
  // being "deriving" the moment its id differs from this — which is the same
  // signal `observeRun` polls on, applied per repo instead of to the selected
  // one alone.
  const runBaseline = useRef<Record<string, string | null>>({});

  const deepenDismissed = useSyncExternalStore(
    subscribeDismiss,
    () => readDismissed(projectId),
    () => false,
  );

  // The run this browser last fired, if any. Read during RENDER (never in an
  // effect) so the very first client commit already knows a run may be in
  // flight — the server snapshot is `null`, which is also the truth for a
  // browser that never fired one.
  const storedRun = useSyncExternalStore(
    subscribeRun,
    () => readRun(projectId),
    () => null,
  );
  // This mount has taken responsibility for `storedRun` — either by resolving it
  // against the server, or by being the mount that fired it.
  const [runResolved, setRunResolved] = useState(false);
  const resumeStarted = useRef(false);
  // A stored run whose real status this mount does not know YET. The trigger is
  // REMOVED for its duration (Panel 4b State C's rule, one moment further out):
  // leaving it up would merely narrow the duplicate-POST window to the few
  // hundred ms before the first status answers, instead of closing it.
  const resuming = storedRun !== null && !runResolved;

  useEffect(() => {
    if (storedRun === null || runResolved || resumeStarted.current) return;
    resumeStarted.current = true;
    void resumeStoredRun(storedRun);
    // `resumeStoredRun` reads the current render's `audit` / `t`, both of which
    // are the mount values here — this runs exactly once, guarded by the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedRun, runResolved]);

  // Resume against the SERVER, never against the stored record: the record says
  // a run was fired, only motir-ai knows whether it is still going. Any repo
  // still `queued` / `running` restores the deriving state and re-enters the
  // OBSERVE half of the run (it must never re-POST — the job is already queued).
  // Everything else clears the entry, so a stale id can never wedge the page.
  async function resumeStoredRun(run: ReauditResultDTO): Promise<void> {
    const outcomes = await Promise.all(
      run.repos.map(async (repo): Promise<'active' | 'terminal' | 'gone'> => {
        try {
          const res = await fetch(`${JOB_URL}/${encodeURIComponent(repo.auditJobId)}`);
          if (!res.ok) return 'gone';
          const body = (await res.json()) as { status?: JobStatus };
          return ACTIVE_JOB_STATUSES.includes(body.status ?? '') ? 'active' : 'terminal';
        } catch {
          // A job motir-ai no longer knows, or a read that failed outright. Not
          // an error strip: the page falls back to its shipped pre-audit states
          // and the trigger becomes available again.
          return 'gone';
        }
      }),
    );

    if (outcomes.includes('active')) {
      setRunResolved(true);
      setReauditing(true);
      // Restore the per-repo deriving rows too — a resumed run is the same run,
      // and the list must say which repos it is still waiting on, not just that
      // "something" is in flight. Only the repos whose job motir-ai still calls
      // active count; the rest have landed or are gone.
      const stillDeriving = run.repos
        .map((repo, index) => (outcomes[index] === 'active' ? repo.repoKey : null))
        .filter((repoKey): repoKey is string => repoKey !== null);
      runBaseline.current = Object.fromEntries(
        stillDeriving.map((repoKey) => [
          repoKey,
          audits.find((a) => a.repoKey === repoKey)?.surface?.audit?.id ?? null,
        ]),
      );
      setDerivingRepos(stillDeriving);
      const seq = ++reauditSeq.current;
      try {
        await observeRun(seq, report?.surface.audit?.id ?? null);
      } finally {
        if (seq === reauditSeq.current) setReauditing(false);
      }
      return;
    }

    clearRun(projectId);
    setRunResolved(true);
    // A run that finished while the page was away: the report on screen was
    // seeded before it landed, so re-read the surface — exactly once, and only
    // when something actually landed.
    if (outcomes.includes('terminal')) await reload();
  }

  // ONE repo's summary read, contained exactly as the server contains it: a
  // rejection becomes THIS repo's `surface: null` ("Couldn't load this report")
  // and never the whole page's error strip (MOTIR-2207).
  async function readRepoSummary(repoKey: string): Promise<RepoAuditSurfaceDTO> {
    try {
      const res = await fetch(summaryUrl(repoKey));
      if (!res.ok) throw new Error('audit failed');
      return { repoKey, surface: (await res.json()) as CodeAuditSurfaceDTO };
    } catch {
      return { repoKey, surface: null };
    }
  }

  // The selected repo's FULL findings page. Returns null when the repo has no
  // report to fetch (never audited, or its read failed) — the panel draws that.
  async function readRepoReport(repoKey: string): Promise<CodeAuditSurfaceDTO | null> {
    try {
      const res = await fetch(auditUrl(repoKey));
      if (!res.ok) throw new Error('audit failed');
      return (await res.json()) as CodeAuditSurfaceDTO;
    } catch {
      return null;
    }
  }

  // A repo is still deriving only while its audit id matches what it was when
  // the run was fired. Recomputed on every COMPLETED read, which is also the
  // only moment the list re-sorts (Panel 7 §4) — so a repo landing mid-run can
  // never re-order the rows under the reader.
  function pruneDeriving(next: RepoAuditSurfaceDTO[]): void {
    setDerivingRepos((prev) =>
      prev.filter((repoKey) => {
        const entry = next.find((a) => a.repoKey === repoKey);
        if (entry === undefined) return false;
        return (entry.surface?.audit?.id ?? null) === (runBaseline.current[repoKey] ?? null);
      }),
    );
  }

  async function reload() {
    setError(null);
    if (repoRefs.length === 0) {
      // No connected repo: there is nothing to read, and the page seeded nothing
      // either. Not an error state — the audit tab draws the start-fresh case.
      setAudits([]);
      setReport(null);
      setSelectedRepo(null);
      setConventions([]);
      return;
    }
    // Every repo's summary refreshes together, so the list and its rollup are a
    // consistent snapshot; the selected repo's report follows from it.
    const nextAudits = await Promise.all(repoRefs.map(readRepoSummary));
    setAudits(nextAudits);
    pruneDeriving(nextAudits);

    // Hold the selection if it is still a connected repo; otherwise re-derive it
    // (worst-first) from the snapshot just read.
    const stillConnected = selectedRepo !== null && repoRefs.includes(selectedRepo);
    const nextSelected = stillConnected
      ? selectedRepo
      : defaultSelectedRepoKey(buildRepoAuditRows(nextAudits, derivingRepos));
    setSelectedRepo(nextSelected);

    const seq = ++reportSeq.current;
    const entry = nextAudits.find((a) => a.repoKey === nextSelected);
    const surface =
      nextSelected !== null && entry?.surface?.audit != null
        ? await readRepoReport(nextSelected)
        : null;
    if (seq === reportSeq.current) {
      setReport(
        surface === null || nextSelected === null ? null : { repoKey: nextSelected, surface },
      );
    }

    try {
      const cResList = await Promise.all(repoRefs.map((repoKey) => fetch(conventionUrl(repoKey))));
      if (cResList.some((r) => !r.ok)) throw new Error('load failed');
      const surfaces = (await Promise.all(cResList.map((r) => r.json()))) as ConventionSurfaceDTO[];
      // Same per-repo filter the page seeds with: a repo with nothing derived
      // yet renders no card, and never suppresses the repos that do have one.
      setConventions(surfaces.filter((c) => c.convention !== null));
    } catch {
      setError(t('errorLoad'));
    }
  }

  // Swap which repo's report is on screen. The findings list RESETS rather than
  // appending: `nextOffset` is an offset into ONE audit, so carrying it across
  // repos would page repo B's list with repo A's cursor (Panel 7 §3).
  async function selectRepo(repoKey: string) {
    if (repoKey === selectedRepo) return;
    const seq = ++reportSeq.current;
    setSelectedRepo(repoKey);
    setReport(null);
    const entry = audits.find((a) => a.repoKey === repoKey);
    // Nothing to fetch for a repo with no audit, or one whose read failed — the
    // panel renders that repo's own state instead.
    if (entry?.surface?.audit == null) return;
    const surface = await readRepoReport(repoKey);
    if (seq !== reportSeq.current) return;
    if (surface === null) {
      // The report read failed where the summary had succeeded: degrade THIS
      // repo to the row state that says so, leaving every sibling readable.
      setAudits((prev) =>
        prev.map((a) => (a.repoKey === repoKey ? { repoKey, surface: null } : a)),
      );
      return;
    }
    setReport({ repoKey, surface });
  }

  // Re-read ONE repo after its read failed. Deliberately not a re-audit: the row
  // failed to LOAD, which says nothing about whether it needs deriving.
  async function retryRepo(repoKey: string) {
    const fresh = await readRepoSummary(repoKey);
    setAudits((prev) => prev.map((a) => (a.repoKey === repoKey ? fresh : a)));
    if (repoKey === selectedRepo && fresh.surface?.audit != null) {
      const seq = ++reportSeq.current;
      const surface = await readRepoReport(repoKey);
      if (seq === reportSeq.current && surface !== null) setReport({ repoKey, surface });
    }
  }

  async function loadMoreFindings() {
    const current = report;
    if (!current || current.surface.nextOffset === null || loadingMore) return;
    const url = auditUrl(current.repoKey, {
      findingsOffset: String(current.surface.nextOffset),
    });
    const seq = ++pageSeq.current;
    setLoadingMore(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('page failed');
      const next = (await res.json()) as CodeAuditSurfaceDTO;
      if (seq !== pageSeq.current) return;
      setReport((prev) =>
        // Append only onto the SAME repo's list — a page that arrives after a
        // repo switch belongs to an audit that is no longer on screen.
        prev && prev.repoKey === current.repoKey
          ? {
              repoKey: prev.repoKey,
              surface: {
                ...prev.surface,
                findings: [...prev.surface.findings, ...next.findings],
                nextOffset: next.nextOffset,
              },
            }
          : prev,
      );
    } catch {
      setError(t('errorLoadMore'));
    } finally {
      if (seq === pageSeq.current) setLoadingMore(false);
    }
  }

  // The OBSERVE half of a run, shared by the click path and the resume path. It
  // only ever re-READS the audit surface: MOTIR-2123's one-POST invariant is per
  // RUN, and a resumed run was POSTed by an earlier mount.
  //
  // ⚠️ IT POLLS THE REPO WHOSE REPORT IS ON SCREEN (Panel 7 §4). With every repo
  // now deriving its own audit, polling a fixed `repos[0]` would sit waiting on
  // a report the user cannot see — and would call the run finished the moment an
  // unrelated repo landed. The selection does not move for the duration of a run,
  // so the repo captured here is the repo the reader is watching.
  async function observeRun(seq: number, prevAuditId: string | null): Promise<void> {
    const watched = selectedRepo;
    if (watched === null) return;
    const url = auditUrl(watched);
    for (let i = 0; i < REAUDIT_POLL_TRIES; i++) {
      await delay(REAUDIT_POLL_MS);
      if (seq !== reauditSeq.current) return;
      const aRes = await fetch(url);
      if (!aRes.ok) continue;
      const next = (await aRes.json()) as CodeAuditSurfaceDTO;
      if (next.audit && next.audit.id !== prevAuditId) {
        if (seq !== reauditSeq.current) return;
        // Landed: the record has nothing left to resume, so it goes rather than
        // sending the next mount on a round of terminal-status reads.
        clearRun(projectId);
        await reload();
        return;
      }
    }
    // The 60s window (3s × 20) is a UI wait, not a job timeout — the audit keeps
    // running either way, and the stored record is KEPT for exactly that reason:
    // a later mount resumes it rather than re-offering the trigger. Where that
    // gets SAID differs by what is on screen: a FIRST audit has an empty screen
    // to rest in (State D, MOTIR-2080), while a re-audit still shows the previous
    // report, so it keeps today's strip.
    if (prevAuditId === null) setPollExhausted(true);
    else setError(t('deepen.reauditPending'));
  }

  async function reaudit() {
    // `resuming` closes the hole the in-memory guard alone left open: a mount
    // that is still asking the server about a run must not fire a second one.
    if (reauditing || resuming) return;
    const seq = ++reauditSeq.current;
    const prevAuditId = report?.surface.audit?.id ?? null;
    setReauditing(true);
    setError(null);
    setPollExhausted(false);
    try {
      const res = await fetch(REFRESH_URL, { method: 'POST' });
      if (!res.ok) throw new Error('refresh failed');
      // ONE POST per click, whatever the poll does — the trigger's own fan-out
      // over the repo set happens server-side, so a poll tick must never re-POST.
      // The ids it answers with are the record that makes that hold across a
      // page leave too; this mount owns the run it just fired, so it resolves
      // its own write rather than resuming it.
      setRunResolved(true);
      resumeStarted.current = true;
      const result = (await res.json()) as ReauditResultDTO;
      const repos = (result?.repos ?? []).filter((r) => typeof r?.auditJobId === 'string');
      if (repos.length > 0) writeRun(projectId, { repos });
      // The fan-out told us exactly which repos it queued, so the list can show
      // each of them deriving rather than the whole tab going vague. Their audit
      // ids AS OF NOW are the baseline every later read is measured against.
      const queued = repos
        .map((r) => r.repoKey)
        .filter((repoKey): repoKey is string => repoKey !== null);
      runBaseline.current = Object.fromEntries(
        queued.map((repoKey) => [
          repoKey,
          audits.find((a) => a.repoKey === repoKey)?.surface?.audit?.id ?? null,
        ]),
      );
      setDerivingRepos(queued);
      await observeRun(seq, prevAuditId);
    } catch {
      setError(t('errorReaudit'));
    } finally {
      if (seq === reauditSeq.current) setReauditing(false);
    }
  }

  // ── What the audit tab is looking at, derived fresh each render ───────────
  const rows = buildRepoAuditRows(audits, derivingRepos);
  // Only ever the SELECTED repo's report. A report still tagged with the
  // previous repo is not shown at all — a stale grade under a new repo's name is
  // worse than the half-second of the panel's own state.
  const shownReport = report !== null && report.repoKey === selectedRepo ? report.surface : null;
  const selectedRow = rows.find((row) => row.repoKey === selectedRepo) ?? null;
  const siblingAudited = rows.some(
    (row) => row.repoKey !== selectedRepo && row.state === 'audited',
  );
  const unavailableRepoRef = selectedRow?.state === 'unavailable' ? selectedRow.repoKey : null;
  // E2 fires exactly on the design's condition: the selected repo has no audit
  // and at least one sibling does. When NO repo has one, Panel 4b's A–D fire
  // unchanged — this panel takes nothing away from MOTIR-2080 / MOTIR-2081.
  const partiallyDerivedRepoRef =
    shownReport?.audit == null &&
    selectedRepo !== null &&
    unavailableRepoRef === null &&
    siblingAudited
      ? selectedRepo
      : null;

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
        <>
          <AuditRepoList
            rows={rows}
            selectedRepoKey={selectedRepo}
            onSelect={(repoKey) => void selectRepo(repoKey)}
            onRetry={(repoKey) => void retryRepo(repoKey)}
          />
          <AuditPanel
            audit={shownReport?.audit ?? null}
            repoRefs={repoRefs}
            findings={shownReport?.findings ?? []}
            total={shownReport?.total ?? 0}
            hasMore={(shownReport?.nextOffset ?? null) !== null}
            loadingMore={loadingMore}
            onLoadMore={() => void loadMoreFindings()}
            scanner={shownReport?.scanner ?? null}
            // Panel 7 §5 · E2 — the selected repo has no report while a SIBLING
            // does. Panel 4b's A–D are all-or-nothing by construction, so they
            // must not fire here: the project is not waiting, one repo is.
            partiallyDerivedRepoRef={partiallyDerivedRepoRef}
            // The selected repo's read FAILED. Distinct from E2 in the one way
            // that matters: nothing is coming unless the reader retries.
            unavailableRepoRef={unavailableRepoRef}
            onRetryRepo={() => {
              if (selectedRepo !== null) void retryRepo(selectedRepo);
            }}
            // `resuming` counts as deriving: a run WAS fired from this browser, and
            // until the server says otherwise the honest screen is the one that
            // shows work in progress and offers no button to fire it again.
            reauditing={reauditing || resuming}
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
        </>
      ) : (
        <ConventionPanel conventions={conventions} />
      )}
    </div>
  );
}
