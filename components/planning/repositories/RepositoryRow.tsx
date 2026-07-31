'use client';

import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  BadgeCheck,
  ChevronDown,
  ChevronUp,
  CircleCheckBig,
  Ellipsis,
  ExternalLink,
  Link as LinkIcon,
  Loader2,
  Mail,
  SkipForward,
  Sparkles,
  TriangleAlert,
  UserPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { GithubMark } from '@/components/icons/GithubMark';
import { repoWebUrl } from '@/lib/repos/cloneUrl';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import type {
  ProjectRepoConnectCandidateDto,
  ProjectRepoDto,
  ProjectRepoProposalSignalDto,
} from '@/lib/dto/projectRepos';

// ONE row of the repository set, on the TECHNICAL path only (Story MOTIR-1775 ·
// MOTIR-1782 — design/repository-set panels 6 + 7).
//
// Everything here is behind the "I already have code" door: the default path
// renders no row, no name, no role and no count, so this component is never
// mounted for a user who has not self-identified as technical.
//
// ⚠️ STATE IS NEVER COLOUR ALONE. Every state carries an icon PLUS a word, and the
// tint goes on the ROW rather than into a `Pill`: `Pill severity="danger"` is
// `--el-tint-rose` and `--el-danger-surface` is the SAME value, so a danger pill
// on a failed row is invisible (finding #35 taken one step further). The only
// pill on a row is the neutral role chip, which has its own border and reads on
// every tint.
//
// ⚠️ ROWS ARE INDEPENDENT (ADR §4.2). A row's spinner, failure or recovery is
// scoped to itself; the parent never blocks the set behind one row's work.

/** The row's tint + the ink that clears AA on it, per state (design §9). */
const ROW_TINT: Record<ProjectRepoDto['state'], string> = {
  proposed: 'bg-(--el-card) border-(--el-border)',
  creating: 'bg-(--el-card) border-(--el-border)',
  created: 'bg-(--el-success-surface) border-(--el-border-soft)',
  connected: 'bg-(--el-notice-info-bg) border-(--el-border-soft)',
  skipped: 'bg-(--el-surface-soft) border-(--el-border-soft)',
  failed: 'bg-(--el-danger-surface) border-(--el-border-soft)',
};

export interface RepositoryRowProps {
  row: ProjectRepoDto;
  /** Set ordinal + size — decides the chip / grip / menu affordances (a one-row
   *  set reads as ONE question, per ADR §6) and which move controls are live. */
  index: number;
  total: number;
  /** The fixed `owner /` prefix a created repository lands under, or null on a
   *  deployment that cannot provision. */
  hostOwner: string | null;
  /** The repositories the installation grants, for "Use one of mine". */
  candidates: ProjectRepoConnectCandidateDto[];
  /** Where "Grant more on GitHub" hands off — the shipped 7.10 pane. */
  grantMoreHref: string;
  busy: boolean;
  /**
   * Whether this row is showing the "Use one of mine" PICKER rather than the
   * name field. Owned by the parent, not here, for one load-bearing reason: a
   * re-plan (`Create it after all` / `Let Motir host it`) replaces the row with a
   * FRESH one carrying a new id, so a mode held on this component would be
   * unmounted with the old row and the user would have to ask twice.
   */
  connecting: boolean;
  onConnectingChange: (rowId: string, connecting: boolean) => void;
  onRename: (rowId: string, name: string) => void;
  onConnect: (rowId: string, githubRepoId: string) => void;
  /** Put a settled-but-empty-handed row back in play. `thenConnect` carries the
   *  user's intent through the row's identity change, so "Use one of mine" on a
   *  skipped row lands on the picker rather than on a name field. */
  onReplan: (rowId: string, thenConnect: boolean) => void;
  onSkip: (rowId: string) => void;
  onRemove: (rowId: string) => void;
  onMove: (rowId: string, direction: 'up' | 'down') => void;
  onRetry: (rowId: string) => void;
  /** Send (or re-send) this row's collaborator invitation — the row-scoped
   *  **Resend invitation** (MOTIR-1900). Row-scoped on purpose: rows are
   *  independent, so re-sending one must not quietly re-send its siblings. */
  onResendInvitation: (rowId: string) => void;
}

export function RepositoryRow({
  row,
  index,
  total,
  hostOwner,
  candidates,
  grantMoreHref,
  busy,
  connecting,
  onConnectingChange,
  onRename,
  onConnect,
  onReplan,
  onSkip,
  onRemove,
  onMove,
  onRetry,
  onResendInvitation,
}: RepositoryRowProps) {
  const t = useTranslations('repositorySet');
  const fieldId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftName, setDraftName] = useState(row.name);

  const roleGloss = t(`role.${row.role}` as 'role.web');
  const single = total === 1;
  const editable = row.state === 'proposed' || row.state === 'failed';
  const picking = connecting && editable;

  return (
    <div
      data-testid={`repo-row-${row.role}`}
      data-state={row.state}
      className={`flex gap-3 rounded-(--radius-card) border p-(--spacing-card-padding) ${ROW_TINT[row.state]}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* Role chip + the state word. `min-w-0` throughout: a long org or repo
            name must truncate rather than blow the row out (the repo's recurring
            horizontal-overflow class). */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {single ? null : (
            <Pill tone="neutral" className="font-mono">
              {row.role}
            </Pill>
          )}
          {row.state === 'proposed' ? (
            <span className="min-w-0 truncate text-sm text-(--el-text-secondary)">{roleGloss}</span>
          ) : null}
          <RowState row={row} />
        </div>

        {row.state === 'creating' ? (
          <>
            <RepoName label={qualified(hostOwner, row.name)} />
            <p role="status" className="flex items-center gap-2 text-sm text-(--el-text-secondary)">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              {t('stateCreating')}
              <span aria-hidden="true">·</span>
              {t('stateCreatingDetail')}
            </p>
          </>
        ) : null}

        {row.state === 'created' || row.state === 'connected' ? (
          <>
            <RepoLink row={row} />
            <p className="text-sm text-(--el-text-helper)">
              {row.state === 'created' ? t('createdDetail') : t('connectedDetail')}
            </p>
          </>
        ) : null}

        {/* The INVITATION — a sub-state OF a created row, never a row state of
            its own (MOTIR-1900, design panel 4). The row keeps its own tint and
            state word; this is an extra line inside it, which is what makes the
            two axes independent: `created` is about the repository existing,
            `invited`/`accepted` is about the user being able to reach it, and
            neither can fail the other. A `connected` row is the user's OWN
            repository, so it has nothing to be invited to. */}
        {row.state === 'created' ? (
          <RowInvitation
            row={row}
            busy={busy}
            connectHref={grantMoreHref}
            onResend={() => onResendInvitation(row.id)}
          />
        ) : null}

        {row.state === 'skipped' ? (
          <>
            <p className="text-sm text-(--el-text-secondary)">
              {t('skippedTitle', { roleLabel: row.role })}
            </p>
            <p className="text-sm text-(--el-text-helper)">{t('skippedDetail')}</p>
          </>
        ) : null}

        {row.state === 'failed' ? (
          <p
            role="alert"
            className="flex items-start gap-2 text-sm text-(--el-danger-surface-text)"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{row.failureReason}</span>
          </p>
        ) : null}

        {/* The EDITABLE half — a name Motir will create under, or a picker over
            the repositories the user already granted. Never both. */}
        {editable && !picking ? (
          <Input
            id={fieldId}
            aria-label={single ? t('nameLabelOne') : t('nameLabelForRole', { role: row.role })}
            label={single ? t('nameLabelOne') : undefined}
            value={draftName}
            disabled={busy}
            addonStart={
              hostOwner ? (
                <span className="font-mono text-xs text-(--el-text-muted)">{hostOwner} /</span>
              ) : null
            }
            helperText={
              row.state === 'failed'
                ? undefined
                : row.seedSource === SEED_SOURCE_PLATFORM_STARTER
                  ? t('seedStarter')
                  : t('seedInitialised')
            }
            onChange={(e) => setDraftName(e.target.value)}
            // Commit on BLUR, not per keystroke: the edit is a persisted decision
            // (it must survive a refresh), and a PATCH per character would race
            // itself. Reverting to the row's value on an empty field keeps the
            // control from committing a name the service would reject anyway.
            onBlur={() => {
              const next = draftName.trim();
              if (next.length === 0) setDraftName(row.name);
              else if (next !== row.name) onRename(row.id, next);
            }}
          />
        ) : null}

        {editable && picking ? (
          <div className="flex flex-col gap-1.5">
            <Combobox
              options={candidates.map((c) => ({
                value: c.id,
                label: c.repoRef,
                ...(c.claimed ? { secondary: t('claimedOption') } : {}),
              }))}
              value={null}
              onChange={(githubRepoId) => onConnect(row.id, githubRepoId)}
              label={single ? t('pickerLabelOne') : t('pickerLabelForRole', { role: row.role })}
              placeholder={t('pickerPlaceholder')}
              searchable
              emptyText={t('pickerEmpty')}
            />
            <p className="text-xs text-(--el-text-helper)">
              {single ? t('monorepoHint') : t('pickerHint')}{' '}
              <a
                href={grantMoreHref}
                className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
              >
                {t('grantMore')}
              </a>
            </p>
          </div>
        ) : null}

        {/* WHY this row exists — the derivation's persisted signal, mapped to
            copy here (the column is machine-readable on purpose). A row the USER
            added carries no signal, and so renders no explanation. */}
        {row.state === 'proposed' && row.proposalSignal ? (
          <p className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-callout-bg) p-3 text-xs text-(--el-text-secondary)">
            <Sparkles
              className="mt-0.5 size-3.5 shrink-0 text-(--el-accent-on-surface)"
              aria-hidden="true"
            />
            <span className="min-w-0">{whyCopy(t, row.proposalSignal, row.role)}</span>
          </p>
        ) : null}

        {/* The row's ways forward. `failed` keeps all three recoveries and
            `skipped` both of its own — no state is a dead end (ADR §4.1/§4.4). */}
        <RowActions>
          {row.state === 'failed' ? (
            <Button variant="secondary" size="sm" onClick={() => onRetry(row.id)} disabled={busy}>
              {t('retryRow')}
            </Button>
          ) : null}
          {editable && !picking ? (
            <QuietAction
              onClick={() => onConnectingChange(row.id, true)}
              disabled={busy}
              icon={<LinkIcon className="size-3.5" aria-hidden="true" />}
            >
              {t('useOneOfMine')}
            </QuietAction>
          ) : null}
          {editable && picking ? (
            <QuietAction onClick={() => onConnectingChange(row.id, false)} disabled={busy}>
              {t('letMotirHost')}
            </QuietAction>
          ) : null}
          {row.state === 'failed' ? (
            <Button variant="ghost" size="sm" onClick={() => onSkip(row.id)} disabled={busy}>
              {t('skipRow')}
            </Button>
          ) : null}
          {row.state === 'skipped' ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onReplan(row.id, false)}
                disabled={busy}
              >
                {t('createAfterAll')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onReplan(row.id, true)}
                disabled={busy}
              >
                {t('useOneOfMine')}
              </Button>
            </>
          ) : null}
          {row.state === 'connected' ? (
            <QuietAction onClick={() => onReplan(row.id, false)} disabled={busy}>
              {t('letMotirHost')}
            </QuietAction>
          ) : null}
        </RowActions>
      </div>

      {/* Reorder + the row menu, at two or more rows. The grip in the mock is
          decorative; the REAL controls are these buttons, so reordering is
          keyboard-operable and drag would only ever be an enhancement. */}
      {single ? null : (
        <div className="flex shrink-0 flex-col gap-1 self-start">
          <IconButton
            label={t('moveUp')}
            onClick={() => onMove(row.id, 'up')}
            disabled={busy || index === 0}
          >
            <ChevronUp className="size-4" aria-hidden="true" />
          </IconButton>
          <IconButton
            label={t('moveDown')}
            onClick={() => onMove(row.id, 'down')}
            disabled={busy || index === total - 1}
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </IconButton>
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                aria-label={t('rowActions')}
                className="inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <Ellipsis className="size-4" aria-hidden="true" />
              </button>
            </Popover.Trigger>
            <Popover.Content align="end" width={200}>
              <div className="flex flex-col">
                {editable ? (
                  <MenuRow
                    onClick={() => {
                      setMenuOpen(false);
                      onSkip(row.id);
                    }}
                  >
                    {t('skipRow')}
                  </MenuRow>
                ) : null}
                <MenuRow
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove(row.id);
                  }}
                >
                  {t('removeRow')}
                </MenuRow>
              </div>
            </Popover.Content>
          </Popover>
        </div>
      )}
    </div>
  );
}

/** The state WORD beside its icon — never the tint alone, and never a `Pill`
 *  (which would be the same value as the tint it sits on). */
function RowState({ row }: { row: ProjectRepoDto }) {
  const t = useTranslations('repositorySet');
  const common = 'inline-flex items-center gap-1.5 text-sm font-semibold';
  switch (row.state) {
    case 'created':
      return (
        <span className={`${common} text-(--el-text-strong)`}>
          <CircleCheckBig className="size-4 shrink-0 text-(--el-success)" aria-hidden="true" />
          {t('stateCreated')}
        </span>
      );
    case 'connected':
      return (
        <span className={`${common} text-(--el-text-strong)`}>
          <LinkIcon className="size-4 shrink-0 text-(--el-info)" aria-hidden="true" />
          {t('stateConnected')}
        </span>
      );
    case 'skipped':
      return (
        <span className={`${common} text-(--el-text-strong)`}>
          <SkipForward className="size-4 shrink-0 text-(--el-icon-muted)" aria-hidden="true" />
          {t('stateSkipped')}
        </span>
      );
    case 'failed':
      return (
        <span className={`${common} text-(--el-danger-surface-text)`}>
          <TriangleAlert className="size-4 shrink-0 text-(--el-danger)" aria-hidden="true" />
          {t('stateFailed')}
        </span>
      );
    default:
      return null;
  }
}

/**
 * The row's INVITATION line — the third of the design's three access states, with
 * its own icon AND word (never colour alone), plus the one way forward each state
 * has.
 *
 * `accepted` is settled and offers nothing, which is deliberate: GitHub owns the
 * acceptance, so once the account can clone there is nothing for Motir to do and
 * nothing honest to offer. `not invited` is a `role="status"` because it is a
 * standing condition the user can resolve, not an error the row raised — the
 * repository was created successfully.
 */
function RowInvitation({
  row,
  busy,
  connectHref,
  onResend,
}: {
  row: ProjectRepoDto;
  busy: boolean;
  connectHref: string;
  onResend: () => void;
}) {
  const t = useTranslations('repositorySet');
  const { state, login, invitationUrl } = row.access;
  const line = 'inline-flex items-center gap-1.5 text-sm font-semibold text-(--el-text-strong)';

  if (state === 'accepted') {
    return (
      <div className="flex flex-col gap-1">
        <span className={line}>
          <BadgeCheck className="size-4 shrink-0 text-(--el-success)" aria-hidden="true" />
          {t('stateAccepted')}
        </span>
        {login ? (
          <p className="min-w-0 text-sm text-(--el-text-helper)">
            {t('acceptedRowDetail', { login: `@${login}` })}
          </p>
        ) : null}
      </div>
    );
  }

  if (state === 'invited') {
    return (
      <div className="flex flex-col gap-1.5">
        <span className={line}>
          <Mail className="size-4 shrink-0 text-(--el-info)" aria-hidden="true" />
          {t('stateInvited')}
        </span>
        {login ? (
          <p className="min-w-0 text-sm text-(--el-text-helper)">
            {t('invitedRowDetail', { login: `@${login}` })}
          </p>
        ) : null}
        <RowActions>
          {invitationUrl ? (
            // The `Button` primitive renders a real `<button>` and has no
            // `asChild`, and the invitation is a NAVIGATION out to GitHub — so
            // this is an anchor wearing the secondary/sm shape rather than a
            // button faking a link (which would lose middle-click, open-in-new-tab
            // and the link role a screen reader announces).
            <a
              href={invitationUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-(--height-btn-sm) items-center gap-1.5 rounded-(--radius-btn) border border-(--el-button-border) px-3 font-sans text-xs font-medium text-(--el-text) hover:bg-(--el-surface)"
            >
              {t('openInvitation')}
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            </a>
          ) : null}
          <QuietAction onClick={onResend} disabled={busy}>
            {t('resendInvitation')}
          </QuietAction>
        </RowActions>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span role="status" className={line}>
        <UserPlus className="size-4 shrink-0 text-(--el-warning)" aria-hidden="true" />
        {t('stateNotInvited')}
      </span>
      <p className="min-w-0 text-sm text-(--el-text-helper)">{t('notInvitedDetail')}</p>
      <RowActions>
        <a
          href={connectHref}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          <GithubMark className="size-3.5" aria-hidden />
          {t('connectGithub')}
        </a>
      </RowActions>
    </div>
  );
}

/** The realized repository, as a link out to the host. */
function RepoLink({ row }: { row: ProjectRepoDto }) {
  const realized = row.realizedRepo;
  if (!realized) return <RepoName label={row.name} />;
  const href = repoWebUrl(realized);
  if (!href) return <RepoName label={realized.repoRef} />;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <GithubMark className="size-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="min-w-0 truncate font-mono text-sm text-(--el-link) hover:text-(--el-link-pressed)"
      >
        {realized.repoRef}
      </a>
      <ExternalLink className="size-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden="true" />
    </span>
  );
}

function RepoName({ label }: { label: string }) {
  return <span className="min-w-0 truncate font-mono text-sm text-(--el-text)">{label}</span>;
}

function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 empty:hidden">{children}</div>;
}

function QuietAction({
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
      className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed) disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function MenuRow({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) hover:bg-(--el-option-active-bg)"
    >
      {children}
    </button>
  );
}

/** The derivation signal → the copy that explains it. The persisted value is a
 *  machine key precisely so this mapping lives in the UI and stays localizable. */
function whyCopy(
  t: ReturnType<typeof useTranslations>,
  signal: ProjectRepoProposalSignalDto,
  role: string,
): string {
  switch (signal) {
    case 'plan-item-role':
      return t('whyPlanItemRole', { role });
    case 'preplan-platform':
      return t('whyPreplanPlatform', { role });
    case 'default-web':
      return t('whyDefaultWeb');
  }
}

/** `owner/name` when Motir knows the owner, else just the name. */
function qualified(hostOwner: string | null, name: string): string {
  return hostOwner ? `${hostOwner}/${name}` : name;
}
