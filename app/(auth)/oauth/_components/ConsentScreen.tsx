'use client';

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  CircleAlert,
  CircleCheckBig,
  CircleX,
  Globe,
  Info,
  KeyRound,
  Laptop,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Pill } from '@/components/ui/Pill';
import { Segmented } from '@/components/ui/Segmented';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { OAuthConsentProblem } from '@/lib/oauth/errors';
import type { ConsentRequestDto, ConsentWorkspaceDto } from '@/lib/dto/oauthConnections';
import { AuthShell } from '../../_components/AuthShell';
import { PermissionPicker } from '@/app/(authed)/settings/account/_components/PermissionPicker';
import {
  permissionColumnsForTokens,
  type PermissionMeta,
} from '@/app/(authed)/settings/account/_components/permissionMeta';
import { ConsentRefused, consentProblemFrom } from './ConsentRefused';
import {
  Callout,
  DetailBlock,
  DetailColumn,
  DetailSub,
  ErrorBanner,
  Strong,
  TerminalState,
} from './consentParts';

// The OAuth CONSENT screen's interactive half (Story MOTIR-6973 · Subtask
// MOTIR-6985), built to `design/auth/oauth-consent.mock.html` (`## OAuth
// consent` in `design/auth/design-notes.md`). One island over one pending
// request: consent (Panels 1–3), no workspace (6a/6b), submitting (8), approved
// (9), denied (10), and the refused page (7) when the request stops being usable
// between the page load and a press.
//
// EVERYTHING IT SAYS ABOUT THE APP CAME FROM THE SERVER. The page read the
// request the provider signed and the client's own registration
// (`oauthConnectionsService.describeConsentRequest`); nothing here is taken
// from the URL. The app's name is its own claim, so it is rendered as text,
// never markup, and a self-registered one carries the Unverified pill. An app
// Motir verified by its metadata document (MOTIR-7174, the verified-by-domain
// delta `design/auth/oauth-consent--verified-client.mock.html`) is NAMED BY ITS
// HOST everywhere — the title, the App asking value, every later state — and
// its own name appears once, beneath, as what it calls itself.
//
// ONE ENDPOINT, two actions: `POST /api/oauth/consent` with `approve` (records
// the connection and answers the provider) or `deny` (answers it, writes
// nothing). Each returns the client's redirect, which the browser then follows.
// The server re-validates the workspace, the project and the grant on approve;
// this island only offers what the same reads allow.

type Phase = 'consent' | 'approved' | 'denied' | 'refused';
type Reach = 'all' | 'one';

export interface ConsentScreenProps {
  /** The consent page's query exactly as the provider signed it. */
  oauthQuery: string;
  request: ConsentRequestDto;
  user: { name: string; email: string };
  activeWorkspaceId: string | null;
  activeProjectId: string | null;
  /** Where "Sign out" sends the reader: sign-in, then back to this request. */
  signInHref: string;
  /** Follows the client redirect. Injected so a test can observe it. */
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

/** The workspace the picker opens on: the last-active one, else the first. */
function pickWorkspace(workspaces: ConsentWorkspaceDto[], activeId: string | null): string | null {
  if (activeId && workspaces.some((w) => w.id === activeId)) return activeId;
  return workspaces[0]?.id ?? null;
}

/** The project One project opens on: the active one (MOTIR-4876), else the first
 *  the person can grant something in, else the first. */
function pickProject(workspace: ConsentWorkspaceDto | undefined, activeId: string | null) {
  const projects = workspace?.projects ?? [];
  return (
    projects.find((p) => p.id === activeId) ??
    projects.find((p) => p.grantable.length > 0) ??
    projects[0] ??
    null
  );
}

/** A project's starting grant: the default grant ∩ what the person holds there
 *  (design decision 5 — Delete off by default). */
function defaultGrantFor(grantable: readonly PermissionKey[]): Set<PermissionKey> {
  const held = new Set(grantable);
  return new Set(DEFAULT_TOKEN_GRANT.filter((key) => held.has(key)));
}

async function readProblem(res: Response): Promise<{ code: string | null; reason: string | null }> {
  try {
    const body = (await res.json()) as { code?: unknown; reason?: unknown };
    return {
      code: typeof body.code === 'string' ? body.code : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
    };
  } catch {
    return { code: null, reason: null };
  }
}

export function ConsentScreen({
  oauthQuery,
  request,
  user,
  activeWorkspaceId,
  activeProjectId,
  signInHref,
  navigate = defaultNavigate,
}: ConsentScreenProps) {
  const t = useTranslations('oauthConsent');
  const router = useRouter();
  const verification = request.client.verification;
  const claimedName = request.client.name ?? t('unnamedApp');
  // THE HOST IS THE NAME for a verified app: the document's `client_name` is
  // self-asserted, so every sentence of fact names the host instead.
  const app = verification.kind === 'domain' ? verification.host : claimedName;
  const { workspaces } = request;

  const [phase, setPhase] = useState<Phase>('consent');
  const [problem, setProblem] = useState<OAuthConsentProblem>('not_issued');
  const [workspaceId, setWorkspaceId] = useState<string | null>(() =>
    pickWorkspace(workspaces, activeWorkspaceId),
  );
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const [reach, setReach] = useState<Reach>('all');
  const [projectId, setProjectId] = useState<string | null>(
    () => pickProject(workspace, activeProjectId)?.id ?? null,
  );
  const project = workspace?.projects.find((p) => p.id === projectId) ?? null;
  const [granted, setGranted] = useState<Set<PermissionKey>>(() =>
    defaultGrantFor(pickProject(workspace, activeProjectId)?.grantable ?? []),
  );
  const conferrable = useMemo(() => new Set(project?.grantable ?? []), [project]);
  const effectiveGrant = [...granted].filter((key) => conferrable.has(key));

  // What the connection will be — the approved screen names it, and the pickers
  // must not be able to rewrite that sentence after the press.
  const [approvedAs, setApprovedAs] = useState<{ workspace: string; project: string | null }>({
    workspace: '',
    project: null,
  });
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [pageError, setPageError] = useState('');

  const reachLabelId = useId();
  const grantLabelId = useId();
  const projectFieldId = useId();

  function chooseWorkspace(id: string) {
    setWorkspaceId(id);
    const next = pickProject(
      workspaces.find((w) => w.id === id),
      activeProjectId,
    );
    setProjectId(next?.id ?? null);
    setGranted(defaultGrantFor(next?.grantable ?? []));
  }

  function chooseProject(id: string) {
    setProjectId(id);
    // Changing the project resets the switches (design decision 5): what the
    // person holds is per project, so a carried-over grant could be one they
    // cannot confer here.
    setGranted(defaultGrantFor(workspace?.projects.find((p) => p.id === id)?.grantable ?? []));
  }

  function toggle(key: PermissionKey) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Route a failed response to what the page should DO. */
  async function handleFailure(res: Response) {
    if (res.status === 401) {
      router.push(signInHref);
      return;
    }
    const { code, reason } = await readProblem(res);
    if (res.status === 400 && code === 'OAUTH_CONSENT_REQUEST_INVALID') {
      setProblem(consentProblemFrom(reason));
      setPhase('refused');
      return;
    }
    if (code === 'WORKSPACE_NOT_FOUND' || code === 'PROJECT_NOT_FOUND') {
      setPageError(t('errors.workspace'));
      return;
    }
    if (code === 'API_TOKEN_INVALID_PERMISSION') {
      setPageError(t('errors.grant'));
      return;
    }
    setPageError(t('errors.unexpected'));
  }

  async function submit(action: 'approve' | 'deny') {
    if (submitting) return;
    setPageError('');
    setSubmitting(action);
    const payload =
      action === 'deny'
        ? { action, oauthQuery }
        : {
            action,
            oauthQuery,
            workspaceId,
            ...(reach === 'one'
              ? { projectId: project?.id ?? null, permissions: effectiveGrant }
              : { projectId: null }),
          };
    try {
      const res = await fetch('/api/oauth/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        await handleFailure(res);
        setSubmitting(null);
        return;
      }
      const { redirectUrl } = (await res.json()) as { redirectUrl: string };
      if (action === 'approve') {
        setApprovedAs({
          workspace: workspace?.label ?? '',
          project: reach === 'one' ? (project?.key ?? null) : null,
        });
        setPhase('approved');
      } else {
        setPhase('denied');
      }
      // The terminal screen renders first and the redirect follows at once
      // (design decision 8): a loopback listener that has already closed leaves
      // the tab on a true "is connected", not on a spinner that never ends.
      navigate(redirectUrl);
    } catch {
      setPageError(t('errors.network'));
      setSubmitting(null);
    }
  }

  async function signOutAndSwitch() {
    const { signOut } = await import('@/lib/auth/client');
    await signOut();
    router.push(signInHref);
    router.refresh();
  }

  // ── Panel 7 — the request stopped being usable under this tab ──────────────
  if (phase === 'refused') return <ConsentRefused problem={problem} />;

  // ── Panel 9 — approved ─────────────────────────────────────────────────────
  if (phase === 'approved') {
    return (
      <TerminalState
        headline={t('heading.approved', { app })}
        subhead={t('subhead.closeTab')}
        foot={t('foot.disconnect')}
      >
        <Callout tone="success" icon={<CircleCheckBig className="h-5 w-5" aria-hidden />}>
          {approvedAs.project
            ? t.rich('approved.bodyOne', {
                app,
                workspace: approvedAs.workspace,
                project: approvedAs.project,
                b: (c) => <Strong>{c}</Strong>,
              })
            : t.rich('approved.bodyAll', {
                app,
                workspace: approvedAs.workspace,
                b: (c) => <Strong>{c}</Strong>,
              })}
        </Callout>
        <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
          {t('approved.returning', { app })}
        </p>
        <Link
          href="/settings/account/tokens#connected-apps"
          className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'w-full')}
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          {t('approved.viewConnected')}
        </Link>
      </TerminalState>
    );
  }

  // ── Panel 10 — denied ──────────────────────────────────────────────────────
  if (phase === 'denied') {
    return (
      <TerminalState
        headline={t('heading.denied', { app })}
        subhead={t('subhead.closeTab')}
        foot={t('foot.nothingShared')}
      >
        <Callout tone="danger" icon={<CircleX className="h-5 w-5" aria-hidden />}>
          {t('denied.body', { app })}
        </Callout>
        <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
          {t('denied.retry', { app })}
        </p>
      </TerminalState>
    );
  }

  const banner = pageError ? <ErrorBanner>{pageError}</ErrorBanner> : null;

  // ── Panels 6a / 6b — nowhere it could act: Deny only ───────────────────────
  if (workspaces.length === 0) {
    const noMemberships = request.unusableWorkspaces.length === 0;
    return (
      <TerminalState
        headline={t('heading.noWorkspace', { app })}
        subhead={noMemberships ? t('subhead.noMemberships') : t('subhead.noGrantable')}
        foot={t('foot.denyNothingStored', { app })}
      >
        {banner}
        <Callout tone="warn" icon={<CircleAlert className="h-5 w-5" aria-hidden />}>
          {noMemberships
            ? t('noWorkspace.noMemberships', { app })
            : t('noWorkspace.noGrantable', {
                app,
                workspaces: new Intl.ListFormat(undefined, {
                  style: 'long',
                  type: 'conjunction',
                }).format(request.unusableWorkspaces),
              })}
        </Callout>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => void submit('deny')}
          loading={submitting === 'deny'}
          leftIcon={<CircleX className="h-4 w-4 text-(--el-danger)" />}
          className="w-full border-(--el-danger)"
        >
          {t('actions.denyReturn', { app })}
        </Button>
      </TerminalState>
    );
  }

  // ── Panels 1–3, 8 — consent ────────────────────────────────────────────────
  const busy = submitting !== null;
  const multiWorkspace = workspaces.length > 1;
  const noProject = reach === 'one' && project === null;
  const emptyGrant = reach === 'one' && effectiveGrant.length === 0;
  const canApprove = Boolean(workspaceId) && !emptyGrant && (reach === 'all' || project !== null);

  // What the bar says beside the buttons (MOTIR-7379 § What moves): the reason
  // Approve is off when it is off — no project yet, then an empty grant — and
  // otherwise the whole decision, restated where the eye goes to press.
  let decision: ReactNode;
  if (noProject) {
    decision = (
      <p
        role="status"
        className="flex min-w-0 items-start gap-2 font-sans text-sm leading-relaxed text-(--el-text-secondary)"
      >
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('summary.pickProject', { app })}</span>
      </p>
    );
  } else if (emptyGrant) {
    decision = (
      <p
        role="alert"
        className="flex min-w-0 items-start gap-2 font-sans text-sm leading-relaxed text-(--el-danger-on-surface)"
      >
        <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('grant.empty')}</span>
      </p>
    );
  } else {
    decision = (
      <p className="flex min-w-0 items-start gap-2 font-sans text-sm leading-relaxed text-(--el-text-secondary)">
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {reach === 'all'
            ? t.rich('summary.all', {
                app,
                count: DEFAULT_TOKEN_GRANT.length,
                total: GRANTABLE_PERMISSIONS.length,
                workspace: workspace?.label ?? '',
                b: (c) => <strong className="font-semibold text-(--el-text)">{c}</strong>,
              })
            : t.rich('summary.one', {
                app,
                count: effectiveGrant.length,
                project: project?.key ?? '',
                b: (c) => <strong className="font-semibold text-(--el-text)">{c}</strong>,
              })}
        </span>
      </p>
    );
  }

  return (
    // `data-auth-wide="consent"` widens the (auth) card to 64rem at `lg` (40rem
    // below it), suppresses the lockup and hands the card's bottom padding to
    // the action bar — `design/auth/oauth-consent--sticky-actions.mock.html`.
    <div data-auth-wide="consent" className="flex flex-col gap-4">
      <AuthShell
        headline={
          verification.kind === 'domain'
            ? t('titleVerified', { host: verification.host })
            : t('heading.consent', { app })
        }
        subhead={t('subhead.consent')}
        tight
      >
        <div className="flex flex-col gap-4">
          {banner}

          {/* Two panes at `lg`: who and where (22rem) beside what (the grant at
              the 36rem its two columns were measured at). One column below. */}
          <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start lg:gap-x-8">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="grid rounded-(--radius-card) border border-(--el-border) sm:grid-cols-2 lg:grid-cols-1">
                <DetailColumn>
                  <DetailBlock label={t('detail.app')}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      {/* Decision 1: never a client logo — a borrowed one is the
                          more convincing lie. The tile is the name's first letter. */}
                      <span
                        aria-hidden
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-card-icon-bg) font-sans text-sm font-semibold text-(--el-card-icon-fg)"
                      >
                        {app.trim().charAt(0).toUpperCase() || '?'}
                      </span>
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-sans text-sm font-medium text-(--el-text)">
                        {verification.kind === 'domain' ? (
                          // The verified host is never truncated: it is the fact.
                          <span className="font-mono font-semibold break-all">{app}</span>
                        ) : (
                          <span className="truncate">{app}</span>
                        )}
                        <VerificationPill verification={verification} />
                      </span>
                    </span>
                    <DetailSub>{appLine(verification, claimedName, t)}</DetailSub>
                  </DetailBlock>

                  {/* Decision 3: the return host is always on screen — the code
                      goes there, so it is part of what is being approved. */}
                  <DetailBlock label={t('detail.returnsTo')}>
                    <span className="flex min-w-0 items-center gap-2 font-sans text-sm font-medium text-(--el-text)">
                      {request.loopback ? (
                        <Laptop className="text-(--el-text-muted) h-4 w-4 shrink-0" aria-hidden />
                      ) : (
                        <Globe className="text-(--el-text-muted) h-4 w-4 shrink-0" aria-hidden />
                      )}
                      <span className="truncate">
                        {request.loopback ? 'localhost' : request.redirectHost}
                      </span>
                    </span>
                    <DetailSub>
                      {request.loopback
                        ? t('detail.returnsLoopback', { app })
                        : t('detail.returnsHttps', { uri: request.redirectUri })}
                    </DetailSub>
                  </DetailBlock>
                </DetailColumn>

                <DetailColumn divided>
                  <DetailBlock label={t('detail.you')}>
                    <span className="flex items-center gap-2.5">
                      <span
                        aria-hidden
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--el-text) font-sans text-sm font-semibold text-(--el-text-inverted)"
                      >
                        {(user.name || user.email).trim().charAt(0).toUpperCase() || '?'}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-sans text-sm font-medium text-(--el-text)">
                          {user.name || user.email}
                        </span>
                        <span className="text-(--el-text-muted) truncate font-sans text-xs">
                          {user.email}
                        </span>
                      </span>
                    </span>
                    <DetailSub>
                      {t.rich('detail.notYou', {
                        link: (chunks) => (
                          <button
                            type="button"
                            onClick={() => void signOutAndSwitch()}
                            disabled={busy}
                            className="rounded-(--radius-control) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:opacity-50"
                          >
                            {chunks}
                          </button>
                        ),
                      })}
                    </DetailSub>
                  </DetailBlock>

                  <DetailBlock label={t('detail.workspace')}>
                    {multiWorkspace ? (
                      <Combobox
                        id="oauth-consent-workspace"
                        label={t('detail.workspacePicker', { app })}
                        options={workspaces.map((w) => ({ value: w.id, label: w.label }))}
                        value={workspaceId}
                        onChange={chooseWorkspace}
                        disabled={busy}
                      />
                    ) : (
                      <span className="line-clamp-2 font-sans text-sm font-medium text-(--el-text)">
                        {workspaces[0]?.label}
                      </span>
                    )}
                    <DetailSub>
                      {multiWorkspace
                        ? t('detail.workspaceHelp', { count: workspaces.length })
                        : t('detail.workspaceOnly')}
                    </DetailSub>
                  </DetailBlock>
                </DetailColumn>
              </div>

              {/* WHERE — all projects (the fixed default grant) or one (a chosen
                  grant). The one-arm rule (MOTIR-6983): no project ⇒ no choice. */}
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-0.5">
                  <span
                    id={reachLabelId}
                    className="font-sans text-sm font-medium text-(--el-text)"
                  >
                    {t('reach.label')}
                  </span>
                  <span className="text-(--el-text-muted) font-sans text-xs">
                    {reach === 'all'
                      ? t('reach.helpAll', { workspace: workspace?.label ?? '' })
                      : t('reach.helpOne')}
                  </span>
                </div>
                <Segmented<Reach>
                  label={t('reach.label')}
                  value={reach}
                  onChange={setReach}
                  disabled={busy}
                  options={[
                    { value: 'all', label: t('reach.all') },
                    { value: 'one', label: t('reach.one') },
                  ]}
                />
              </div>

              {reach === 'one' ? (
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={projectFieldId}
                    className="font-sans text-sm font-medium text-(--el-text)"
                  >
                    {t('reach.project')}
                  </label>
                  <Combobox
                    id={projectFieldId}
                    label={t('reach.project')}
                    options={(workspace?.projects ?? []).map((p) => ({
                      value: p.id,
                      label: `${p.key} — ${p.name}`,
                    }))}
                    value={project?.id ?? null}
                    onChange={chooseProject}
                    disabled={busy}
                  />
                  <span className="text-(--el-text-muted) font-sans text-xs">
                    {t('reach.projectHelp', { app })}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              {/* WHAT — the token picker's own columns and words. */}
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-0.5">
                  <span
                    id={grantLabelId}
                    className="font-sans text-sm font-medium text-(--el-text)"
                  >
                    {t('grant.label')}
                  </span>
                  <span className="text-(--el-text-muted) font-sans text-xs">
                    {reach === 'all' ? t('grant.helpAll') : t('grant.helpOne', { app })}
                  </span>
                </div>
                {reach === 'all' ? (
                  <FixedGrant labelledBy={grantLabelId} />
                ) : (
                  <PermissionPicker
                    labelledBy={grantLabelId}
                    conferrable={conferrable}
                    granted={granted}
                    onToggle={toggle}
                    lockedWhy={t('grant.locked')}
                    dangerTag={t('grant.dangerTag')}
                    disabled={busy}
                  />
                )}
              </div>

              {/* The end of the scrolling content, so it reads over the card
                  whether or not the bar is stuck: secondary, not muted. */}
              <p className="font-sans text-xs leading-relaxed text-(--el-text-secondary)">
                {t('foot.disconnect')}
              </p>
            </div>
          </div>
        </div>
      </AuthShell>

      <ConsentActionBar decision={decision}>
        {/* Deny FIRST in the DOM and equal weight, the /device composition: the
            danger hue lives in the BORDER + glyph, never the label. */}
        <div
          role="group"
          aria-label={t('actions.group', { app })}
          className="grid gap-2 sm:grid-cols-2 sm:gap-3 lg:flex-none"
        >
          <Button
            variant="secondary"
            size="lg"
            onClick={() => void submit('deny')}
            disabled={busy}
            loading={submitting === 'deny'}
            leftIcon={<CircleX className="h-4 w-4 text-(--el-danger)" />}
            className="w-full border-(--el-danger) lg:min-w-44"
          >
            {t('actions.deny')}
          </Button>
          <Button
            size="lg"
            onClick={() => void submit('approve')}
            loading={submitting === 'approve'}
            disabled={!canApprove || busy}
            className="w-full lg:min-w-44"
          >
            {submitting === 'approve' ? t('actions.connecting') : t('actions.approve')}
          </Button>
        </div>
      </ConsentActionBar>
    </div>
  );
}

/**
 * THE PINNED ACTION BAR (MOTIR-7379 § The action bar): the decision and its two
 * buttons, `sticky bottom-0` as the card's LAST child. It is IN FLOW, never
 * `fixed`: while the card is taller than the viewport it rides the viewport's
 * bottom edge, and at the end of the scroll it comes to rest at the card's foot
 * — so the last permission always ends above it and no spacer is needed.
 *
 * The other half of the scroll rule is FOCUS: a Switch reached with Tab while the
 * bar is stuck must scroll into view above it, not under it. The (auth) page
 * scrolls the document, so the bar measures itself and writes its height as the
 * root's `scroll-padding-bottom` — a wrapping summary or a longer locale moves
 * the number with it — and takes it back when the bar leaves (a terminal state).
 */
function ConsentActionBar({ decision, children }: { decision: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const root = document.documentElement;
    const write = () => {
      root.style.scrollPaddingBottom = `${Math.ceil(bar.getBoundingClientRect().height)}px`;
    };
    write();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(write);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.scrollPaddingBottom = '';
    };
  }, []);

  return (
    <div
      ref={ref}
      data-consent-bar
      className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2.5 rounded-b-(--radius-card) border-t border-(--el-border) bg-(--el-page-bg) px-4 pt-3 pb-4 sm:-mx-8 sm:px-8 sm:pb-5 lg:flex-row lg:items-center lg:gap-5"
    >
      <div className="min-w-0 lg:flex-1">{decision}</div>
      {children}
    </div>
  );
}

/**
 * The All-projects grant: `DEFAULT_TOKEN_GRANT`, FIXED, so no switches (design
 * decision 4 — a switch would offer a choice the server ignores). Names only, the
 * /device row, in the picker's columns; the irreversible key is drawn WITHHELD in
 * its danger card, pointing at One project.
 */
function FixedGrant({ labelledBy }: { labelledBy: string }) {
  const t = useTranslations('oauthConsent');
  const tp = useTranslations('permissions');
  const [left, right] = permissionColumnsForTokens();
  const granted = new Set<PermissionKey>(DEFAULT_TOKEN_GRANT);

  function row(meta: PermissionMeta) {
    const Icon = meta.Icon;
    return (
      <div
        key={meta.key}
        className="flex items-center gap-2 py-1.5 font-sans text-sm text-(--el-text) first:pt-0 last:pb-0"
      >
        <Icon aria-hidden className="text-(--el-text-muted) h-4 w-4 shrink-0" />
        {tp(`${permissionSlug(meta.key)}.label`)}
      </div>
    );
  }

  function withheld(meta: PermissionMeta) {
    const Icon = meta.Icon;
    return (
      <div
        key={meta.key}
        className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y)"
      >
        <div className="flex items-start gap-2.5">
          <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-(--el-danger)" />
          <div className="min-w-0 flex-1">
            <span className="font-sans text-sm font-medium text-(--el-text-strong)">
              {tp(`${permissionSlug(meta.key)}.label`)}{' '}
              <span className="font-mono text-[0.625rem] tracking-wide text-(--el-danger-on-surface) uppercase">
                {t('grant.dangerTag')}
              </span>
            </span>
            <p className="mt-0.5 font-sans text-xs text-(--el-text-strong)">
              {t.rich('grant.withheld', {
                b: (c) => <strong className="font-semibold">{c}</strong>,
              })}
            </p>
          </div>
        </div>
      </div>
    );
  }

  function column(groups: ReturnType<typeof permissionColumnsForTokens>[number]) {
    return (
      <div className="flex flex-col gap-4">
        {groups.map((g) => {
          const shown = g.permissions.filter((m) => granted.has(m.key));
          const held = g.permissions.filter((m) => !granted.has(m.key));
          return (
            <div key={g.domain} className="flex flex-col gap-2">
              <div className="font-mono text-[0.625rem] tracking-wide text-(--el-text-secondary) uppercase">
                {tp(`domain.${g.domain}`)}
              </div>
              {shown.length > 0 ? (
                <div className="divide-y divide-(--el-border-soft)">{shown.map(row)}</div>
              ) : null}
              {held.map(withheld)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="mt-1 grid gap-x-6 gap-y-4 sm:grid-cols-2"
    >
      {column(left)}
      {column(right)}
    </div>
  );
}

type ConsentT = ReturnType<typeof useTranslations<'oauthConsent'>>;

/** The pill beside the App asking value: sky info + ShieldCheck for a verified
 * domain, the shipped warning + ShieldAlert for a self-registered app, and
 * nothing for one this deployment registered. */
function VerificationPill({
  verification,
}: {
  verification: ConsentRequestDto['client']['verification'];
}) {
  const t = useTranslations('oauthConsent');
  switch (verification.kind) {
    case 'domain':
      return (
        <Tooltip content={t('detail.verifiedTooltip', { host: verification.host })}>
          <span tabIndex={0} className="inline-flex focus-visible:outline-none">
            <Pill severity="info" className="gap-1">
              <ShieldCheck className="h-3 w-3" aria-hidden />
              {t('detail.verified')}
            </Pill>
          </span>
        </Tooltip>
      );
    case 'self':
      return (
        <Pill severity="warning" className="gap-1">
          <ShieldAlert className="h-3 w-3" aria-hidden />
          {t('detail.unverified')}
        </Pill>
      );
    case 'registered':
      return null;
  }
}

/** The line beneath the App asking value — the ONE place a verified app's own
 * name appears, attributed to it. */
function appLine(
  verification: ConsentRequestDto['client']['verification'],
  claimedName: string,
  t: ConsentT,
): string {
  switch (verification.kind) {
    case 'domain':
      return t('detail.appVerified', { app: claimedName, host: verification.host });
    case 'self':
      return t('detail.appDynamic');
    case 'registered':
      return t('detail.appRegistered');
  }
}
