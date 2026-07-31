'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  CircleCheckBig,
  ExternalLink,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { GithubMark } from '@/components/icons/GithubMark';
import { IdentityHeader } from '@/app/(authed)/settings/workspace/_components/gitSettingsPrimitives';
import { RepositoryRow } from '@/components/planning/repositories/RepositoryRow';
import type { PlanCodeOutcome } from '@/components/planning/PlanReviewRail';
import {
  addRepositoryRow,
  connectRepositoryRow,
  establishRepositorySet,
  fetchRepositorySet,
  grantRepositoryAccess,
  moveRepositoryRow,
  patchRepositoryRow,
  refreshRepositoryAccess,
  removeRepositoryRow,
  replanRepositoryRow,
  skipRepositoryRow,
} from '@/lib/planning/repositorySetClient';
import type { ProjectRepoDto, ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';

// THE ESTABLISH STEP at plan approval (Story MOTIR-1775 · MOTIR-1782) — the step
// that gives an approved plan somewhere for its code to live. It takes the CANVAS
// pane of the plan-detail box; the review rail stays, still reading "Approved",
// which is what makes the step honest: the plan is already safe before the user
// answers anything here (ADR §4.3).
//
// ⚠️ THE DEFAULT PATH IS ONE SENTENCE, ONE PRIMARY, ONE QUIET SECONDARY. No
// repository name, role, target account, COUNT, row, table chrome, seed source or
// GitHub error string reaches it — a one-repository plan and a three-repository
// plan render the identical screen, which is the design's central claim and the
// reason the question is REMOVED rather than styled two ways. This is the
// `notes.html` #151 rule: an AI-derived artifact a non-technical user cannot
// meaningfully evaluate is derived, used automatically, and never put behind an
// approval gate or a bespoke editor.
//
// Everything technical — rows, roles, names, per-row state, the derivation's
// "why" — lives behind "I already have code", and appears only once the user has
// connected their own GitHub, which is how they self-identify as someone the word
// "repository" means something to.
//
// ⚠️ PROGRESS COMES FROM THE POLL, NOT FROM THE ESTABLISH RESPONSE. The creation
// primitive persists each row's outcome AS IT RESOLVES, so re-reading the set is
// what makes per-row progress real (spike §4.2: a `201` is not a ready
// repository, and how long seeding takes is unmeasured). The run is resumable, so
// a request that outlives the platform's limit costs nothing but a **Try again**.

/** How often the set is re-read while anything is in flight. Fast enough that a
 *  sub-second create still shows its transition; slow enough to be free. */
const POLL_MS = 1500;

/** The three states the DEFAULT path renders. The ADR's six per-row states are
 *  the MODEL; this path shows only what the user can act on, and `proposed` /
 *  `connected` / `skipped` cannot occur on it at all — nothing is proposed for
 *  approval, nothing is adopted, and there is nothing to decline. */
type DefaultState = 'idle' | 'working' | 'ready' | 'failed';

/** Which surface the step is showing. `own` is the short confirmation behind "I
 *  already have code"; `set` is the technical path's editable rows; `access` is
 *  the step that gets the user INTO the code Motir just made (MOTIR-1900). */
type Mode = 'default' | 'own' | 'set' | 'access';

export interface RepositorySetStepProps {
  /** The project's key — how the repository-set API is addressed. */
  projectKey: string;
  initialView: ProjectRepoEstablishViewDto;
  /** Where "Go to my backlog" leads. */
  backlogHref: string;
  /** The shipped 7.10 connect pane — this step hands off to it and redraws none
   *  of it. */
  connectHref: string;
  /**
   * Reports the ONE line the review rail's approved outcome carries about the
   * project's code — `ready` once every row has settled AND the user can reach
   * what Motir made them, `needs_access` when the code exists but nobody has been
   * invited to it (MOTIR-1900), `unfinished` while any row is still unresolved.
   *
   * A CALLBACK rather than a `router.refresh()`, because the rail is not a
   * server-rendered surface here: it is a sibling client component fed by the
   * plan-detail island's own state, so re-reading the server would be a round
   * trip to learn something this component already knows. (`router.refresh()`
   * remains the right mechanism for the surfaces that ARE server-rendered — the
   * three-surface page-state contract is about routing each surface to the
   * mechanism that reaches it, not about always reaching for the same one.)
   */
  onOutcomeChange?: (outcome: PlanCodeOutcome) => void;
}

export function RepositorySetStep({
  projectKey,
  initialView,
  backlogHref,
  connectHref,
  onOutcomeChange,
}: RepositorySetStepProps) {
  const t = useTranslations('repositorySet');
  const [view, setView] = useState(initialView);
  const [busy, setBusy] = useState(false);
  const [failedAction, setFailedAction] = useState(false);
  const [establishing, setEstablishing] = useState(false);
  const [accessFailed, setAccessFailed] = useState(false);
  const [connectingRows, setConnectingRows] = useState<readonly string[]>([]);
  // The technical path needs GRANT 2 (the installation): it is what lets Motir
  // read a repository the user already owns, and what fills the picker. Grant 1
  // (the identity) only supplies the login the lead greets them by — an
  // installation another admin performed leaves it null, which is why the lead
  // has an anonymous form rather than a gate.
  const connected = view.hasInstallation;
  const [mode, setMode] = useState<Mode>('default');

  const rows = view.set.rows;
  const anyCreating = rows.some((r) => r.state === 'creating');
  const running = establishing || anyCreating;

  const refetch = useCallback(
    async (signal?: AbortSignal) => {
      const fresh = await fetchRepositorySet(projectKey, signal);
      setView(fresh);
      return fresh;
    },
    [projectKey],
  );

  // POLL while anything is in flight. This is the fourth page-state mechanism
  // (design §12): a row's `creating → created` hop is settled by a readiness read
  // on the server, so it is an async job with its own poll — `router.refresh()`
  // is neither how it starts nor how it finishes.
  useEffect(() => {
    if (!running) return;
    const ctrl = new AbortController();
    const handle = setInterval(() => {
      void refetch(ctrl.signal).catch(() => {
        /* best-effort poll — a transient failure just retries next tick */
      });
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(handle);
    };
  }, [running, refetch]);

  // Tell the rail what to say about the code, and ONLY when the answer actually
  // changes — a poll tick that finds the same state must not re-render the rail.
  //
  // ACCESS is part of the answer (MOTIR-1900): a set whose rows all settled but
  // whose repositories the user cannot reach is not finished, and the rail says
  // so ("Finish setting up access") rather than claiming the code is ready. A
  // user who chose **Later** therefore leaves with an honest outcome and a door.
  const outcomeRef = useRef<PlanCodeOutcome | null>(null);
  useEffect(() => {
    if (rows.length === 0) return;
    const outcome: PlanCodeOutcome = !rows.every(isSettled)
      ? 'unfinished'
      : rows.every(hasAccess)
        ? 'ready'
        : 'needs_access';
    if (outcome === outcomeRef.current) return;
    outcomeRef.current = outcome;
    onOutcomeChange?.(outcome);
  }, [rows, onOutcomeChange]);

  /** Run one mutation, keep the response AS the confirmation, and re-read the set
   *  (the set is a list — a sibling row's state can legitimately have moved). */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setFailedAction(false);
      try {
        await action();
        return await refetch();
      } catch {
        setFailedAction(true);
        // A failed WRITE leaves the server as it was, but a rejected move is
        // usually a lost race, so re-read rather than keep a stale optimistic view.
        await refetch().catch(() => {});
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refetch],
  );

  const establish = useCallback(
    async (rowId?: string) => {
      setFailedAction(false);
      setEstablishing(true);
      try {
        await establishRepositorySet(projectKey, rowId);
      } catch {
        setFailedAction(true);
      } finally {
        setEstablishing(false);
        // The authoritative read, always — the run persists per row, so even a
        // request that failed part-way has committed real outcomes to show.
        await refetch().catch(() => {});
      }
    },
    [projectKey, refetch],
  );

  /**
   * Send (or re-send) the collaborator invitations — the access step's return
   * trip after **Connect GitHub**, and a row's **Resend invitation**.
   *
   * The RESPONSE IS THE CONFIRMATION (the three-surface page-state contract, and
   * design §12's note that this now covers the invitation sub-state too): the
   * grant returns the rows it just wrote, so they are kept rather than re-read.
   * `router.refresh()` is not reached for either — this step is a client island,
   * and the rail is told through `onOutcomeChange`.
   */
  const grantAccess = useCallback(
    async (rowId?: string) => {
      setBusy(true);
      setAccessFailed(false);
      try {
        const result = await grantRepositoryAccess(projectKey, rowId);
        setView((prev) => ({ ...prev, set: { ...prev.set, rows: result.rows } }));
        // Only a GitHub refusal is an error worth showing. A `login: null` is the
        // honest "you have not connected yet" state, which the panel already
        // renders as the connect prompt rather than as a failure.
        if (result.failed > 0) setAccessFailed(true);
      } catch {
        setAccessFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [projectKey],
  );

  // Settle any PENDING invitation the user has since accepted on GitHub. Its own
  // call, and only on entering the access step: GitHub tells Motir nothing when an
  // invitation is accepted, so a read is the only way to learn it — but putting
  // that read on the 1.5s set poll would spend a host request per row per tick to
  // discover something that changes once.
  useEffect(() => {
    if (mode !== 'access') return;
    const ctrl = new AbortController();
    void refreshRepositoryAccess(projectKey, ctrl.signal)
      .then((fresh) => setView((prev) => ({ ...prev, set: { ...prev.set, rows: fresh } })))
      .catch(() => {
        /* best-effort — the row keeps saying what it last knew */
      });
    return () => ctrl.abort();
  }, [mode, projectKey]);

  const setConnecting = useCallback((rowId: string, on: boolean) => {
    setConnectingRows((prev) =>
      on ? [...new Set([...prev, rowId])] : prev.filter((id) => id !== rowId),
    );
  }, []);

  const onReplan = useCallback(
    async (rowId: string, thenConnect: boolean) => {
      // Not routed through `run`, because the intent has to follow the row's new
      // IDENTITY: re-planning replaces the row, and the response is the only place
      // the replacement's id appears. Reading it from the response beats guessing
      // which of the re-read rows is the new one.
      setBusy(true);
      setFailedAction(false);
      try {
        const replacement = await replanRepositoryRow(projectKey, rowId);
        setConnecting(rowId, false);
        if (thenConnect) setConnecting(replacement.id, true);
        await refetch();
      } catch {
        setFailedAction(true);
        await refetch().catch(() => {});
      } finally {
        setBusy(false);
      }
    },
    [projectKey, refetch, setConnecting],
  );

  // ── The DEFAULT path ─────────────────────────────────────────────────────
  if (mode === 'default') {
    return (
      <StepShell>
        <DefaultPath
          state={defaultStateOf(rows, running)}
          busy={busy || running}
          backlogHref={backlogHref}
          onContinue={() => void establish()}
          onIHaveCode={() => setMode(connected ? 'set' : 'own')}
          onGetAccess={() => setMode('access')}
        />
      </StepShell>
    );
  }

  // ── The ACCESS step — the main line continues here (MOTIR-1900) ──────────
  if (mode === 'access') {
    return (
      <StepShell>
        <AccessStep
          login={view.githubLogin}
          avatarUrl={view.githubAvatarUrl}
          rows={rows}
          busy={busy}
          failed={accessFailed}
          backlogHref={backlogHref}
          connectHref={connectHref}
          onGrant={() => void grantAccess()}
          onLater={() => setMode('default')}
        />
      </StepShell>
    );
  }

  // ── The escape hatch: one short confirmation, then the SHIPPED connect pane ──
  if (mode === 'own') {
    return (
      <StepShell>
        <div className="flex flex-col gap-3">
          <SectionLabel label={t('overline')} />
          <h2 className="font-serif text-[28px] leading-tight font-semibold text-(--el-text)">
            {t('ownTitle')}
          </h2>
          <p className="text-sm leading-relaxed text-(--el-text-secondary)">{t('ownLead')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href={connectHref}
            className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) text-sm font-medium text-(--el-accent-text) hover:opacity-90"
          >
            <GithubMark className="size-4" aria-hidden />
            {t('connectGithub')}
          </Link>
          <QuietButton onClick={() => setMode('default')}>{t('letMotirHost')}</QuietButton>
        </div>
      </StepShell>
    );
  }

  // ── The TECHNICAL path ───────────────────────────────────────────────────
  const unresolved = rows.filter((r) => r.state === 'proposed' || r.state === 'failed');
  const partial = rows.some(isSettled) && unresolved.length > 0;

  return (
    <StepShell>
      <div className="flex flex-col gap-2">
        <SectionLabel label={t('overline')} />
        <h2 className="font-serif text-[22px] leading-tight font-semibold text-(--el-text)">
          {t('setTitle')}
        </h2>
        <p className="text-sm leading-relaxed text-(--el-text-secondary)">
          {view.githubLogin ? t('setLead', { login: view.githubLogin }) : t('setLeadAnon')}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {rows.map((row, index) => (
          <RepositoryRow
            key={row.id}
            row={row}
            index={index}
            total={rows.length}
            hostOwner={view.hostOwner}
            candidates={view.connectCandidates}
            grantMoreHref={connectHref}
            busy={busy}
            connecting={connectingRows.includes(row.id)}
            onConnectingChange={setConnecting}
            onRename={(rowId, name) =>
              void run(() => patchRepositoryRow(projectKey, rowId, { name }))
            }
            onConnect={(rowId, githubRepoId) =>
              void run(() => connectRepositoryRow(projectKey, rowId, githubRepoId))
            }
            onReplan={(rowId, thenConnect) => void onReplan(rowId, thenConnect)}
            onSkip={(rowId) => void run(() => skipRepositoryRow(projectKey, rowId))}
            onRemove={(rowId) => void run(() => removeRepositoryRow(projectKey, rowId))}
            onMove={(rowId, direction) =>
              void run(() => moveRepositoryRow(projectKey, rowId, direction))
            }
            onRetry={(rowId) => void establish(rowId)}
            onResendInvitation={(rowId) => void grantAccess(rowId)}
          />
        ))}
      </div>

      {/* Set level — "the plan needs a part Motir didn't infer". Deliberately NOT
          a sibling of the row-level "Use one of mine": one asks how many, the
          other asks where, and reading them as two ways of doing the same thing
          is the ambiguity this layout exists to remove. */}
      <button
        type="button"
        disabled={busy || running}
        onClick={() =>
          void run(() =>
            addRepositoryRow(projectKey, { role: 'other', name: nextName(rows, t('addRowName')) }),
          )
        }
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed) disabled:opacity-50"
      >
        <Plus className="size-4" aria-hidden="true" />
        {t('addRow')}
      </button>

      <div className="flex flex-col gap-2">
        {failedAction ? (
          <p role="alert" className="text-sm font-medium text-(--el-danger)">
            {t('actionError')}
          </p>
        ) : null}
        {partial ? (
          <p role="status" className="text-sm text-(--el-text-secondary)">
            {t('summaryPartial', {
              created: rows.filter((r) => r.state === 'created' || r.state === 'connected').length,
              skipped: rows.filter((r) => r.state === 'skipped').length,
              unresolved: unresolved.length,
            })}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            onClick={() => void establish()}
            loading={running}
            disabled={busy || running || unresolved.length === 0}
            leftIcon={<GithubMark className="size-4" aria-hidden />}
          >
            {partial
              ? t('finishSetup')
              : unresolved.length === 1
                ? t('setUpOne')
                : t('setUpMany', { n: unresolved.length })}
          </Button>
          <Button variant="ghost" onClick={() => setMode('default')} disabled={busy || running}>
            {t('notNow')}
          </Button>
        </div>
        <p className="text-xs text-(--el-text-helper)">
          {partial ? t('finishHint') : t('setupNote')}
        </p>
      </div>
    </StepShell>
  );
}

/** The default path's three states, plus the pre-Continue hero. */
function DefaultPath({
  state,
  busy,
  backlogHref,
  onContinue,
  onIHaveCode,
  onGetAccess,
}: {
  state: DefaultState;
  busy: boolean;
  backlogHref: string;
  onContinue: () => void;
  onIHaveCode: () => void;
  /** `created` is the one state that CONTINUES: the code now exists, and the next
   *  thing the user needs is a way to reach it (design §4's table). */
  onGetAccess: () => void;
}) {
  const t = useTranslations('repositorySet');
  return (
    <>
      <div className="flex flex-col gap-3">
        <SectionLabel label={t('overline')} />
        <h2 className="font-serif text-[28px] leading-tight font-semibold text-(--el-text)">
          {t('title')}
        </h2>
        {state === 'idle' ? (
          <p className="text-sm leading-relaxed text-(--el-text-secondary)">{t('lead')}</p>
        ) : null}
      </div>

      {state === 'working' ? (
        <>
          <p
            role="status"
            data-testid="repo-setup-status"
            className="flex items-center gap-2 text-base font-semibold text-(--el-text)"
          >
            <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden="true" />
            {t('working')}
          </p>
          <p className="text-sm text-(--el-text-helper)">{t('workingDetail')}</p>
        </>
      ) : null}

      {state === 'ready' ? (
        <p
          data-testid="repo-setup-status"
          className="flex items-center gap-2 text-base font-semibold text-(--el-text)"
        >
          <CircleCheckBig className="size-5 shrink-0 text-(--el-success)" aria-hidden="true" />
          {t('ready')}
        </p>
      ) : null}

      {state === 'failed' ? (
        <>
          <p
            data-testid="repo-setup-status"
            className="flex items-center gap-2 text-base font-semibold text-(--el-text)"
          >
            <TriangleAlert className="size-5 shrink-0 text-(--el-danger)" aria-hidden="true" />
            {t('setupFailed')}
          </p>
          {/* The consequence, in the USER's terms — never a GitHub status code and
              never a repository name (those belong to the technical path). */}
          <p role="alert" className="text-sm text-(--el-text-helper)">
            {t('setupFailedDetail')}
          </p>
        </>
      ) : null}

      {/* The ownership promise — a STANDING GUARANTEE on the main line, not a
          footnote and not a severity tint: it is a fact about the arrangement,
          which is why it sits on `--el-surface-soft` rather than a hue. */}
      {state === 'idle' || state === 'ready' ? <OwnershipPromise /> : null}

      <div className="flex flex-wrap items-center gap-4">
        {state === 'idle' ? (
          <>
            <Button variant="primary" onClick={onContinue} disabled={busy}>
              {t('continueCta')}
            </Button>
            <QuietButton
              onClick={onIHaveCode}
              disabled={busy}
              icon={<GithubMark className="size-4" aria-hidden />}
            >
              {t('iHaveCode')}
            </QuietButton>
          </>
        ) : null}
        {state === 'ready' ? (
          <>
            {/* The main line CONTINUES into the access step: repositories are
                created under Motir's org and are private, so "your code is
                ready" is only half true until the user can reach it. Before
                Epic 9's hosted agent every user runs their own agent locally,
                which is why this is the primary rather than an aside (design
                §7 / panel 8a). */}
            <Button
              variant="primary"
              onClick={onGetAccess}
              disabled={busy}
              leftIcon={<GithubMark className="size-4" aria-hidden />}
            >
              {t('connectGithub')}
            </Button>
            <Link
              href={backlogHref}
              className="text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
            >
              {t('goToBacklog')}
            </Link>
          </>
        ) : null}
        {state === 'failed' ? (
          <>
            <Button
              variant="primary"
              onClick={onContinue}
              disabled={busy}
              leftIcon={<RefreshCw className="size-4" aria-hidden="true" />}
            >
              {t('tryAgain')}
            </Button>
            <QuietButton
              onClick={onIHaveCode}
              disabled={busy}
              icon={<GithubMark className="size-4" aria-hidden />}
            >
              {t('iHaveCode')}
            </QuietButton>
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * THE ACCESS STEP (MOTIR-1900 — design panels 3 + 3b): getting the user into the
 * code Motir just made them.
 *
 * Three properties are load-bearing and each is rendered, not merely asserted:
 *
 *   1. **It comes AFTER approval, and after the code exists.** Nothing about
 *      GitHub can cost the user their plan — it is already in the backlog — or
 *      their repositories, which are already made.
 *   2. **It is not a gate.** `Later` is a real answer that leaves everything
 *      intact; the rail's outcome then says what is unfinished.
 *   3. **It asks for no PERMISSION.** Motir needs exactly one thing — the user's
 *      GitHub username — which is grant 1 (identity) of the shipped connect pane.
 *      The repository-access install is grant 2 and is needed only for
 *      connect-existing. No re-consent, upgrade or org-owner state is rendered,
 *      because none is asked for.
 *
 * ⚠️ THE ACCOUNT IS CONNECTED, NEVER TYPED — and therefore SHOWN. There is no
 * "type your GitHub username" field: a typed handle proves nothing and a typo
 * would invite a STRANGER to a private repository. Once connected, the shipped
 * `IdentityHeader` renders which account it is, with a way to change it that
 * re-runs the connect rather than opening a field.
 */
function AccessStep({
  login,
  avatarUrl,
  rows,
  busy,
  failed,
  backlogHref,
  connectHref,
  onGrant,
  onLater,
}: {
  login: string | null;
  avatarUrl: string | null;
  rows: readonly ProjectRepoDto[];
  busy: boolean;
  failed: boolean;
  backlogHref: string;
  connectHref: string;
  onGrant: () => void;
  onLater: () => void;
}) {
  const t = useTranslations('repositorySet');
  const tGithub = useTranslations('github');

  // The single pending invitation's door. Only offered when there is exactly ONE
  // — with a multi-repo set there is no single "the invitation" to open, and the
  // per-row lines on the technical path are where each is reached.
  const pending = rows.filter((r) => r.access.state === 'invited' && r.access.invitationUrl);
  const invitationUrl = pending.length === 1 ? pending[0]!.access.invitationUrl : null;
  const anyInvited = rows.some((r) => r.access.state !== 'not_invited');

  return (
    <>
      <div className="flex flex-col gap-3">
        <SectionLabel label={t('overline')} />
        <h2 className="font-serif text-[28px] leading-tight font-semibold text-(--el-text)">
          {login && anyInvited ? t('invitedTitle') : t('accessTitle')}
        </h2>
        <p className="text-sm leading-relaxed text-(--el-text-secondary)">
          {login && anyInvited ? t('invitedDetail') : t('accessLead')}
        </p>
      </div>

      {login ? (
        // The shipped `IdentityHeader`, not a redrawn stand-in — the same
        // component the Git settings pane puts a Disconnect button on, so the
        // account the user sees here is the account the product knows.
        <IdentityHeader
          login={login}
          avatarUrl={avatarUrl}
          verified={tGithub('identity.verified')}
          caption={t('identityCaption')}
          trailing={
            <Link
              href={connectHref}
              className="text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
            >
              {t('useOtherAccount')}
            </Link>
          }
        />
      ) : (
        <p className="text-sm text-(--el-text-helper)">{t('accessWhichAccount')}</p>
      )}

      {failed ? (
        <p role="alert" className="text-sm font-medium text-(--el-danger)">
          {t('accessError')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        {login ? (
          <>
            {invitationUrl ? (
              <a
                href={invitationUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) font-sans text-sm font-medium text-(--el-accent-text) hover:opacity-90"
              >
                {t('openInvitation')}
                <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
              </a>
            ) : (
              <Button
                variant="primary"
                onClick={onGrant}
                loading={busy}
                disabled={busy}
                leftIcon={<GithubMark className="size-4" aria-hidden />}
              >
                {anyInvited ? t('resendInvitation') : t('connectGithub')}
              </Button>
            )}
            {anyInvited ? (
              <QuietButton onClick={onGrant} disabled={busy}>
                {t('resendInvitation')}
              </QuietButton>
            ) : null}
          </>
        ) : (
          // No identity: the ONE thing Motir needs. The hand-off is the shipped
          // 7.10 connect pane — this surface redraws none of it.
          <Link
            href={connectHref}
            className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) font-sans text-sm font-medium text-(--el-accent-text) hover:opacity-90"
          >
            <GithubMark className="size-4" aria-hidden />
            {t('connectGithub')}
          </Link>
        )}
        {/* `Later` leaves with everything intact — the plan is in the backlog and
            the repositories exist. The rail then reads "Finish setting up
            access", and MOTIR-1764's code-context surface is the permanent door
            back. Chosen over "Not now", which this surface already uses at the
            technical path's set footer (two controls with the same accessible
            name on one route is the superstring/scoping problem). */}
        <QuietButton onClick={onLater} disabled={busy}>
          {t('accessLater')}
        </QuietButton>
        <Link
          href={backlogHref}
          className="text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('goToBacklog')}
        </Link>
      </div>
    </>
  );
}

function OwnershipPromise() {
  const t = useTranslations('repositorySet');
  return (
    <div className="flex max-w-prose gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
      <Lock className="mt-0.5 size-5 shrink-0 text-(--el-icon-muted)" aria-hidden="true" />
      {/* THE DOOR IS NOW LIT (MOTIR-1939). It was withheld until this commit
          because the room behind it did not exist — "a link to a 404 is a worse
          broken promise than no link, and a surface that draws a door owes a real
          entrance". `/settings/project/repositories` is that entrance, and this
          is door 1 of the three the design draws (§14.4). A plain `Link`, not a
          button: it is a navigation, and the promise is a standing statement
          rather than a control. */}
      <p className="min-w-0 text-sm leading-relaxed text-(--el-text-secondary)">
        {t.rich('promise', {
          b: (chunks) => <strong className="font-semibold text-(--el-text)">{chunks}</strong>,
        })}{' '}
        <Link
          href="/settings/project/repositories"
          className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('promiseDoor')}
        </Link>
      </p>
    </div>
  );
}

function StepShell({ children }: { children: ReactNode }) {
  return (
    <div className="h-full w-full overflow-y-auto bg-(--el-canvas) p-8">
      <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-5">{children}</div>
    </div>
  );
}

function QuietButton({
  children,
  onClick,
  disabled,
  icon,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed) disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

/** A row is SETTLED when it has no legal move left (ADR §4.1). `failed` is not
 *  settled — it is resumable at any later visit. */
function isSettled(row: ProjectRepoDto): boolean {
  return row.state === 'created' || row.state === 'connected' || row.state === 'skipped';
}

/**
 * Can the user REACH this row's repository (MOTIR-1900)?
 *
 * TRUE for every row that raises no access question at all — a `connected` row is
 * the user's own repository and a `skipped` row has none — so only a repository
 * MOTIR created and nobody has been invited to counts as unfinished. `invited`
 * counts as reached: Motir has done everything it can, and the remaining step is
 * the user's to take on GitHub.
 */
function hasAccess(row: ProjectRepoDto): boolean {
  return row.state !== 'created' || row.access.state !== 'not_invited';
}

/**
 * The default path's state, derived from the SET — never from a local flag alone,
 * so a reload mid-run lands in the right state.
 *
 * Order matters: anything in flight is `working`; then a set with nothing left to
 * resolve is `ready`; then a failure. A `failed` row therefore only surfaces once
 * the run has stopped, which is what keeps the one status line honest while
 * siblings are still being created.
 */
function defaultStateOf(rows: readonly ProjectRepoDto[], running: boolean): DefaultState {
  if (running) return 'working';
  if (rows.length === 0) return 'idle';
  if (rows.every(isSettled)) return 'ready';
  if (rows.some((r) => r.state === 'failed')) return 'failed';
  return 'idle';
}

/** A non-colliding name for a hand-added row — the set's `(project, name)` unique
 *  index would otherwise reject the second one before the user can rename it. */
function nextName(rows: readonly ProjectRepoDto[], base: string): string {
  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
