'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FolderGit2,
  Info,
  LoaderCircle,
  Mail,
  RefreshCw,
  ShieldOff,
  TriangleAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { GithubMark } from '@/components/icons/GithubMark';
import { IdentityHeader } from '@/app/(authed)/settings/workspace/_components/gitSettingsPrimitives';
import {
  buildTeamAccessView,
  type TeamAccessCell,
  type TeamAccessPerson,
} from '@/lib/projectRepos/teamAccessView';
import type {
  GrantTeamAccessResultDto,
  ProjectRepoDto,
  ProjectRepoTeamAccessDto,
} from '@/lib/dto/projectRepos';

// THE TEAM CODE-ACCESS SURFACE (Story MOTIR-1775 · MOTIR-1945) — design
// `design/repository-set/team-access.mock.html` + `design-notes.md` §15, over
// MOTIR-1910's per-member record, DTO and endpoints.
//
// A repository Motir creates is PRIVATE and lives in Motir's own org, so nobody
// on the team can clone it until Motir invites their GitHub account. Before this
// pane that gap was INVISIBLE: five of six people could not clone their own
// project's code and nothing said so anywhere. This is the room that says so —
// one row per person, every state carrying an icon AND a word (never colour
// alone), and one action per row that is actually theirs to take.
//
// ⚠️ MEMBER-primary, from a REPOSITORY-primary read. The transposition and the
// roll-up live in `lib/projectRepos/teamAccessView.ts` so they are testable
// without a DOM; this file renders the result and owns only interaction.
//
// ⚠️ PAGE STATE AFTER A MUTATION (CLAUDE.md's three-mechanism rule, design
// §15.13). This whole surface is ONE client island seeded from server props, so
// `router.refresh()` could not reach it even if it were called — the `useState`
// initializer runs once. Every mutation therefore reconciles the island from its
// OWN response (which is why the endpoints return the whole matrix), and the
// header count re-derives from that same state. There is deliberately NO
// `router.refresh()`: the only other surface carrying these numbers is door 2 on
// the members route, which re-reads on the next navigation. Responses are
// seq-guarded, because per-row actions overlap and an older response must never
// clobber a newer one.

export interface CodeAccessSettingsProps {
  projectKey: string;
  projectName: string;
  initialAccess: ProjectRepoTeamAccessDto;
  initialRepos: ProjectRepoDto[];
  currentUserId: string;
  /** Whether the viewer may INVITE. The write is re-gated in the service; this
   *  only governs which affordances render (the members-pane convention). */
  canEdit: boolean;
  /** The viewer's own connected GitHub account, if any. */
  selfLogin: string | null;
  selfAvatarUrl: string | null;
  /** The shipped 7.10 connect pane — grant 1 (identity) only. Redrawn nowhere. */
  connectHref: string;
  /** Where "Review the plan" goes when the project has no code yet. */
  plansHref: string;
  /** The Access & members pane — `Change role` is a link to it, never a control
   *  this surface owns. */
  membersHref: string;
}

export function CodeAccessSettings({
  projectKey,
  projectName,
  initialAccess,
  initialRepos,
  currentUserId,
  canEdit,
  selfLogin,
  selfAvatarUrl,
  connectHref,
  plansHref,
  membersHref,
}: CodeAccessSettingsProps) {
  const t = useTranslations('settings.codeAccess');
  const tAccess = useTranslations('settings.access');

  const [access, setAccess] = useState<ProjectRepoTeamAccessDto>(initialAccess);
  const [repos, setRepos] = useState<ProjectRepoDto[]>(initialRepos);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // What GitHub refused in the pass the reader just ran. NOT persisted anywhere:
  // MOTIR-1910 stamps nothing on a refusal (the repository is real and the record
  // is untouched), so the response is the only honest source — and the row it
  // marks stays otherwise fine, which is the degrade-gracefully contract.
  const [failure, setFailure] = useState<{
    userId: string;
    name: string;
    failed: number;
    total: number;
  } | null>(null);

  const seqRef = useRef(0);

  const failedUserIds = useMemo(() => new Set(failure ? [failure.userId] : []), [failure]);
  const view = useMemo(
    () => buildTeamAccessView(access, repos, { failedUserIds }),
    [access, repos, failedUserIds],
  );

  async function invite(person: TeamAccessPerson) {
    const seq = (seqRef.current += 1);
    setPendingUserId(person.userId);
    try {
      const res = await fetch(`/api/projects/${projectKey}/repositories/access/team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: person.userId }),
      });
      if (!res.ok) throw new Error(`invite failed: ${res.status}`);
      const result = (await res.json()) as GrantTeamAccessResultDto;
      if (seq !== seqRef.current) return;
      setAccess(result.access);
      setFailure(
        result.failed > 0
          ? {
              userId: person.userId,
              name: person.name,
              failed: result.failed,
              total: result.failed + result.invited,
            }
          : null,
      );
    } catch {
      if (seq !== seqRef.current) return;
      // An invite Motir could not even send reads exactly like one GitHub
      // refused — both leave the repository real and the invitation retryable,
      // and neither is a state the reader can do anything different about.
      setFailure({
        userId: person.userId,
        name: person.name,
        failed: Math.max(view.invitableCount, 1),
        total: Math.max(view.invitableCount, 1),
      });
    } finally {
      if (seq === seqRef.current) setPendingUserId(null);
    }
  }

  async function refresh() {
    const seq = (seqRef.current += 1);
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      // Two calls, because they answer two questions: the first asks GITHUB
      // whether the pending invitations have been accepted (GitHub tells Motir
      // nothing when one is), the second re-reads the matrix that answer changed.
      const settled = await fetch(`/api/projects/${projectKey}/repositories/access`);
      if (!settled.ok) throw new Error(`refresh failed: ${settled.status}`);
      const rows = (await settled.json()) as ProjectRepoDto[];
      const reread = await fetch(`/api/projects/${projectKey}/repositories/access/team`);
      if (!reread.ok) throw new Error(`re-read failed: ${reread.status}`);
      const matrix = (await reread.json()) as ProjectRepoTeamAccessDto;
      if (seq !== seqRef.current) return;
      setRepos(rows);
      setAccess(matrix);
      setFailure(null);
    } catch {
      if (seq === seqRef.current) setRefreshFailed(true);
    } finally {
      if (seq === seqRef.current) setRefreshing(false);
    }
  }

  function toggleExpanded(userId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  // No repository has ever been proposed for this project — not an error and not
  // an empty table: there is genuinely nothing to grant until a plan is approved.
  if (view.repos.length === 0) {
    return (
      <EmptyState
        icon={<FolderGit2 className="h-12 w-12" aria-hidden />}
        title={t('empty.title', { projectName })}
        description={t('empty.body', { projectName })}
        action={
          <Link href={plansHref} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            {t('empty.action')}
          </Link>
        }
      />
    );
  }

  const self = view.people.find((p) => p.userId === currentUserId) ?? null;
  const establishing = view.establishingRepoName !== null;
  // Skeletons ONLY while there is nothing truthful to show yet. Once one
  // repository has landed, the real rows are more honest than a placeholder —
  // the banner already says the rest are still coming.
  const skeletonOnly = establishing && view.invitableCount === 0;

  return (
    <div className="flex flex-col gap-6">
      {self && selfLogin === null ? (
        // The one thing the signed-in member can do, and nobody can do for them
        // (ADR §3 Q3): connect an account for Motir to invite. Grant 1 only — no
        // repository permission is asked for, because none is needed to be
        // invited to one.
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden
              className="bg-(--el-avatar-fallback) text-(--el-text-inverted) inline-flex size-10 shrink-0 items-center justify-center rounded-full font-sans text-sm font-semibold"
            >
              {(self.name || self.email).charAt(0).toUpperCase()}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="font-sans text-sm font-semibold text-(--el-text)">{t('self.title')}</p>
              <p className="text-(--el-text-muted) font-sans text-xs">
                {t('self.body', { projectName, count: view.invitableCount })}
              </p>
            </div>
            <a href={connectHref} className={buttonVariants({ variant: 'primary', size: 'md' })}>
              <GithubMark className="size-4" aria-hidden />
              {t('connect')}
            </a>
          </div>
        </Card>
      ) : null}

      {self && selfLogin !== null && self.state !== 'accepted' ? (
        // The account Motir will invite, shown rather than asserted — the shipped
        // `IdentityHeader`, not a redrawn stand-in, so what the reader sees is
        // what the product knows. Offered only while their own access is still
        // unsettled; once they can clone, which account did it is no longer a
        // question they are asking.
        <Card>
          <IdentityHeader
            login={selfLogin}
            avatarUrl={selfAvatarUrl}
            verified={t('self.verified')}
            caption={t('self.identityCaption')}
            trailing={
              <a
                href={connectHref}
                className="text-(--el-link) hover:text-(--el-link-pressed) font-sans text-sm font-medium"
              >
                {t('useDifferent')}
              </a>
            }
          />
        </Card>
      ) : null}

      <Card
        header={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('peopleHeading')}
              </h2>
              {establishing ? (
                <Pill tone="neutral">
                  <LoaderCircle className="size-3 animate-spin" aria-hidden />
                  {t('establishing.pill')}
                </Pill>
              ) : (
                <Pill tone="neutral">
                  <Users className="size-3" aria-hidden />
                  {t('countPill', { granted: view.grantedCount, eligible: view.eligibleCount })}
                </Pill>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              loading={refreshing}
              aria-label={t('refreshLabel')}
              leftIcon={<RefreshCw className="size-4" aria-hidden />}
            >
              {t('refresh')}
            </Button>
          </div>
        }
      >
        {establishing ? (
          <Notice tone="warning" role="status">
            {t.rich('establishing.banner', {
              repo: view.establishingRepoName ?? '',
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </Notice>
        ) : null}

        {failure ? (
          <Notice tone="danger" role="alert">
            {t.rich('failedBanner', {
              failed: failure.failed,
              total: failure.total,
              name: failure.name,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </Notice>
        ) : null}

        {refreshFailed ? (
          <Notice tone="danger" role="alert">
            {t('refreshError')}
          </Notice>
        ) : null}

        {/* The M axis, named ONCE — the only place a repository is named at the
            top level, so six people × three repositories does not print the same
            three names six times. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-(--el-text-muted) font-sans text-xs">
            {t('setLabel', { count: view.repos.length })}
          </span>
          {view.repos.map((repo) => (
            <Pill
              key={repo.rowId}
              tone="neutral"
              className={repo.established ? undefined : 'opacity-60'}
            >
              {repo.invitable ? <GithubMark className="size-3" aria-hidden /> : null}
              <span className="font-mono">{repo.label}</span>
              {repo.connected ? <span>· {t('setChip.yours')}</span> : null}
              {!repo.established ? <span>· {t('setChip.notCreated')}</span> : null}
            </Pill>
          ))}
        </div>

        {skeletonOnly ? (
          <PeopleSkeleton count={Math.max(view.people.length, 2)} />
        ) : (
          <ul role="list" className="flex flex-col">
            {view.people.map((person) => (
              <PersonRow
                key={person.userId}
                person={person}
                projectName={projectName}
                repoCount={view.invitableCount}
                isSelf={person.userId === currentUserId}
                youSuffix={tAccess('youSuffix')}
                canEdit={canEdit}
                busy={pendingUserId === person.userId}
                expanded={expanded.has(person.userId) || person.disagree}
                onToggle={() => toggleExpanded(person.userId)}
                onInvite={() => void invite(person)}
                connectHref={connectHref}
                membersHref={membersHref}
              />
            ))}
          </ul>
        )}

        {view.invitableCount < view.repos.length ? (
          <p className="text-(--el-text-muted) mt-3 font-sans text-xs">{t('partialNote')}</p>
        ) : null}

        {!canEdit ? (
          // The controls do not vanish silently and are not disabled with a
          // tooltip — they were never this member's to begin with, and a sentence
          // saying so is the honest form of that (design §15.7).
          <div className="bg-(--el-notice-info-bg) mt-3 flex items-start gap-2 rounded-(--radius-card) p-(--spacing-control-y) px-(--spacing-control-x)">
            <Info className="mt-0.5 size-4 shrink-0 text-(--el-text-strong)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-strong)">{t('readOnlyNote')}</p>
          </div>
        ) : null}
      </Card>

      {view.ineligible.length > 0 ? (
        // Its OWN card, never a greyed row in the list above: an excluded member
        // is a statement about the project's roles, not a pending task, and
        // mixing the two would read as "this one is stuck".
        <Card
          header={
            <div className="flex items-center gap-2">
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('notEligibleHeading')}
              </h2>
              <Pill tone="neutral">{view.ineligible.length}</Pill>
            </div>
          }
        >
          <p className="text-(--el-text-muted) mb-3 font-sans text-xs">
            {t('notEligibleBody', { projectName })}
          </p>
          <ul role="list" className="flex flex-col">
            {view.ineligible.map((person) => (
              <PersonRow
                key={person.userId}
                person={person}
                projectName={projectName}
                repoCount={view.invitableCount}
                isSelf={person.userId === currentUserId}
                youSuffix={tAccess('youSuffix')}
                canEdit={canEdit}
                busy={false}
                expanded={false}
                onToggle={() => undefined}
                onInvite={() => undefined}
                connectHref={connectHref}
                membersHref={membersHref}
              />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/** A banner above the list. Peach while something is still happening on its own,
 *  rose when GitHub said no — hue in the BACKGROUND with strong ink, never a
 *  colour-only signal (finding #35). */
function Notice({
  tone,
  role,
  children,
}: {
  tone: 'warning' | 'danger';
  role: 'status' | 'alert';
  children: ReactNode;
}) {
  const Icon = tone === 'danger' ? TriangleAlert : CircleAlert;
  return (
    <div
      role={role}
      className={`mb-3 flex items-start gap-2 rounded-(--radius-card) p-(--spacing-card-padding) ${
        tone === 'danger'
          ? 'bg-(--el-danger-surface) text-(--el-danger-surface-text)'
          : 'bg-(--el-warning-surface) text-(--el-warning-text)'
      }`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="font-sans text-xs leading-relaxed">{children}</p>
    </div>
  );
}

function PeopleSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-4 py-1" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="bg-(--el-muted) size-8 shrink-0 animate-pulse rounded-full" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="bg-(--el-muted) h-3 w-2/5 animate-pulse rounded-(--radius-control)" />
            <span className="bg-(--el-muted) h-3 w-3/5 animate-pulse rounded-(--radius-control)" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * ONE person's row — the shipped members-pane `<li>`, grown a state line.
 *
 * `items-start` rather than `items-center` for exactly that reason: the row is no
 * longer one line tall, and centring would float the trailing control against the
 * middle of a three-line block.
 */
function PersonRow({
  person,
  projectName,
  repoCount,
  isSelf,
  youSuffix,
  canEdit,
  busy,
  expanded,
  onToggle,
  onInvite,
  connectHref,
  membersHref,
}: {
  person: TeamAccessPerson;
  projectName: string;
  repoCount: number;
  isSelf: boolean;
  youSuffix: string;
  canEdit: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onInvite: () => void;
  connectHref: string;
  membersHref: string;
}) {
  const t = useTranslations('settings.codeAccess');
  const regionId = `code-access-repos-${person.userId}`;
  const expandable =
    person.cells.length > 1 && (person.sentCount > 0 || person.cells.some((c) => c.failed));

  return (
    <li className="border-(--el-border-soft) flex items-start gap-3 border-b py-3 last:border-b-0">
      <span
        className="bg-(--el-text) text-(--el-text-inverted) inline-flex size-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold"
        aria-hidden
      >
        {(person.name || person.email).charAt(0).toUpperCase()}
      </span>

      {/* `min-w-0` on every flex column, or a long `owner/name` blows the row out
          — this repo's recurring horizontal-overflow class. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate font-sans text-sm font-medium text-(--el-text)">
          {person.name}
          {isSelf ? <span className="text-(--el-text-muted) font-normal">{youSuffix}</span> : null}
        </p>
        <p className="text-(--el-text-muted) truncate font-sans text-xs">{person.email}</p>

        <StateLine
          person={person}
          projectName={projectName}
          repoCount={repoCount}
          isSelf={isSelf}
        />

        {/* The second dimension is offered only where there IS one to read: a
            member nobody has invited anywhere has M identical "not invited"
            lines, and an expander over them is a door onto the sentence the row
            already says. */}
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={regionId}
            aria-label={t('expandLabel', { name: person.name })}
            className="text-(--el-link) hover:text-(--el-link-pressed) mt-1 inline-flex w-fit items-center gap-1 font-sans text-xs font-medium"
          >
            {expanded ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            {person.sentCount > 0 && person.sentCount < person.cells.length
              ? t('expandPartial', { count: person.cells.length, sent: person.sentCount })
              : t('expand', { count: person.cells.length })}
          </button>
        ) : null}

        {expandable && expanded ? (
          <div
            id={regionId}
            className="bg-(--el-surface-soft) mt-2 flex flex-col gap-2 rounded-(--radius-card) p-(--spacing-card-padding)"
          >
            {person.cells.map((cell) => (
              <RepoCellRow key={cell.rowId} cell={cell} name={person.name} />
            ))}
          </div>
        ) : null}
      </div>

      <span className="flex shrink-0 items-center gap-2">
        <RowAction
          person={person}
          isSelf={isSelf}
          canEdit={canEdit}
          busy={busy}
          onInvite={onInvite}
          connectHref={connectHref}
          membersHref={membersHref}
        />
      </span>
    </li>
  );
}

/** The state, as an icon AND a word AND its reason — never colour alone, so the
 *  whole surface stays legible in greyscale and to a colour-blind reader. */
function StateLine({
  person,
  projectName,
  repoCount,
  isSelf,
}: {
  person: TeamAccessPerson;
  projectName: string;
  repoCount: number;
  isSelf: boolean;
}) {
  const t = useTranslations('settings.codeAccess');
  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;

  let icon: ReactNode;
  let word: string;
  let reason: ReactNode;
  let note: string | null = null;
  // The one state that changes without the reader acting on THIS page — the
  // member connects elsewhere and comes back — so it announces itself.
  let live = false;

  switch (person.state) {
    case 'accepted':
      icon = <BadgeCheck className="size-4 shrink-0 text-(--el-success)" aria-hidden />;
      word = t('state.accepted');
      reason =
        repoCount === 1
          ? t.rich('state.acceptedReasonOne', {
              login: person.login ?? '',
              repo: person.cells[0]?.repoRef ?? '',
              strong,
            })
          : t.rich('state.acceptedReason', {
              login: person.login ?? '',
              count: repoCount,
              strong,
            });
      break;
    case 'invited':
      icon = <Mail className="size-4 shrink-0 text-(--el-info)" aria-hidden />;
      word = t('state.invited');
      reason = t.rich('state.invitedReason', { login: person.login ?? '', strong });
      break;
    case 'failed':
      icon = <TriangleAlert className="size-4 shrink-0 text-(--el-danger)" aria-hidden />;
      word = t('state.failed');
      reason = t.rich('state.failedReason', { repo: person.failedRepoRef ?? '', strong });
      break;
    case 'ineligible':
      icon = <ShieldOff className="text-(--el-icon-muted) size-4 shrink-0" aria-hidden />;
      word = t('state.ineligible');
      reason = t('state.ineligibleViewer', { projectName });
      break;
    case 'nothing_to_grant':
      icon = <ShieldOff className="text-(--el-icon-muted) size-4 shrink-0" aria-hidden />;
      word = t('state.nothingToGrant');
      reason = t('state.nothingToGrantReason');
      break;
    default:
      icon = <UserPlus className="size-4 shrink-0 text-(--el-warning)" aria-hidden />;
      word = t('state.notInvited');
      if (person.reason === 'no_github_identity') {
        live = true;
        reason = isSelf
          ? t('state.notInvitedSelf')
          : t('state.notInvitedOther', { name: person.name });
        // Whose job it is, said in words — because the answer is "nobody but
        // them", and a control for anyone else would be a lie.
        note = isSelf ? null : t('state.notInvitedOtherNote', { name: person.name });
      } else {
        reason = t.rich('state.notInvitedReady', { login: person.login ?? '', strong });
      }
      break;
  }

  return (
    <>
      <span
        {...(live ? { role: 'status' } : {})}
        className="mt-0.5 flex flex-wrap items-center gap-1.5 font-sans text-xs"
      >
        {icon}
        <span className="font-medium text-(--el-text-strong)">{word}</span>
        <span aria-hidden className="text-(--el-text-faint)">
          ·
        </span>
        <span className="text-(--el-text-secondary) min-w-0">{reason}</span>
      </span>
      {note ? <span className="text-(--el-text-muted) font-sans text-xs">{note}</span> : null}
    </>
  );
}

/** One `(member × repository)` line of the expansion — the second dimension, on
 *  demand. Not a nested `Card`: it is a detail OF the row, and a second border
 *  inside a card reads as a second object. */
function RepoCellRow({ cell, name }: { cell: TeamAccessCell; name: string }) {
  const t = useTranslations('settings.codeAccess');
  const state = cell.failed ? 'failed' : cell.state;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <GithubMark className="text-(--el-icon-muted) size-3.5 shrink-0" aria-hidden />
      {/* `min-w-0` so a long `owner/name` truncates instead of blowing the box
          out, but a real basis so it does not collapse to an ellipsis and let the
          trailing chips have the room — the line exists to NAME the repository. */}
      <span className="text-(--el-text-secondary) min-w-0 truncate font-mono text-xs">
        {cell.repoRef}
      </span>
      {cell.permission ? <Pill tone="neutral">{t(`permission.${cell.permission}`)}</Pill> : null}
      {/* The name takes the width it needs rather than growing to fill: inside a
          42rem settings column the four parts do not always fit on one line, and
          eliding every repository into `moti…` to keep them there loses the one
          thing the line exists to say. They wrap left, as a continuation. */}
      <span className="flex shrink-0 items-center gap-1.5 font-sans text-xs text-(--el-text-strong)">
        {state === 'accepted' ? (
          <BadgeCheck className="size-3.5 text-(--el-success)" aria-hidden />
        ) : state === 'invited' ? (
          <Mail className="size-3.5 text-(--el-info)" aria-hidden />
        ) : state === 'failed' ? (
          <TriangleAlert className="size-3.5 text-(--el-danger)" aria-hidden />
        ) : (
          <UserPlus className="size-3.5 text-(--el-warning)" aria-hidden />
        )}
        {state === 'accepted'
          ? t('state.accepted')
          : state === 'invited'
            ? t('state.invited')
            : state === 'failed'
              ? t('state.failed')
              : t('state.notInvited')}
      </span>
      {/* A door only a PENDING invitation has. An accepted one leads to an
          invitation that no longer exists, and an uninvited cell to none at all —
          which is why the design gives neither a forward path. */}
      {state === 'invited' && cell.invitationUrl ? (
        <a
          href={cell.invitationUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={t('openInvitationLabel', { name, repo: cell.repoRef })}
          className="text-(--el-link) hover:text-(--el-link-pressed) inline-flex shrink-0 items-center gap-1 font-sans text-xs font-medium"
        >
          {t('openInvitation')}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

/**
 * The row's ONE forward path, and the trailing permission chip.
 *
 * ⚠️ Every accessible name carries the member, so `getByRole('button', { name })`
 * can never match two rows — and no name is a superstring of another (the
 * selector-contract rule; the audit is design §15.11).
 *
 * ⚠️ A row with no action for THIS reader renders no control at all — not a
 * disabled one with a tooltip. "Only Dana can connect Dana's account" is not an
 * action that is temporarily unavailable; it was never this reader's to take.
 */
function RowAction({
  person,
  isSelf,
  canEdit,
  busy,
  onInvite,
  connectHref,
  membersHref,
}: {
  person: TeamAccessPerson;
  isSelf: boolean;
  canEdit: boolean;
  busy: boolean;
  onInvite: () => void;
  connectHref: string;
  membersHref: string;
}) {
  const t = useTranslations('settings.codeAccess');

  if (person.state === 'ineligible') {
    return canEdit ? (
      <Link
        href={membersHref}
        aria-label={t('changeRoleLabel', { name: person.name })}
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
      >
        {t('changeRole')}
      </Link>
    ) : null;
  }

  // The account's own connect prompt — offered on their OWN row and nowhere else,
  // regardless of who can edit: it is the one action a non-admin member can take
  // here, and the one an admin cannot take for them.
  if (person.reason === 'no_github_identity') {
    return isSelf ? (
      <a href={connectHref} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
        <GithubMark className="size-4" aria-hidden />
        {t('connect')}
      </a>
    ) : null;
  }

  const permissionChip =
    person.permission === 'admin' ? (
      <Pill memberRole="admin">{t('permission.admin')}</Pill>
    ) : person.permission === 'push' ? (
      <Pill tone="neutral">{t('permission.push')}</Pill>
    ) : null;

  if (!canEdit) return permissionChip;

  switch (person.state) {
    case 'accepted':
      // Settled — nothing is offered, because there is nothing left to do.
      return permissionChip;
    case 'failed':
      return (
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          onClick={onInvite}
          aria-label={t('retryLabel', { name: person.name })}
        >
          {t('retry')}
        </Button>
      );
    case 'invited':
      return (
        <>
          {permissionChip}
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            onClick={onInvite}
            aria-label={t('resendLabel', { name: person.name })}
          >
            {t('resend')}
          </Button>
        </>
      );
    case 'not_invited':
      return (
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          onClick={onInvite}
          aria-label={t('inviteLabel', { name: person.name })}
          leftIcon={<GithubMark className="size-4" aria-hidden />}
        >
          {t('invite')}
        </Button>
      );
    default:
      return permissionChip;
  }
}
