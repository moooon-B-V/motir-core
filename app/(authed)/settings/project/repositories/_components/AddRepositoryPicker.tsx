'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, FolderGit2, Plus } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { GithubMark } from '@/components/icons/GithubMark';
import type { OrgRepoOptionDto } from '@/lib/dto/organizationRepos';

// `Add repository` — ONE control, ONE list, TWO segments (Story MOTIR-4669 ·
// MOTIR-4681), built to `design/repository-set/design-notes.md` §17.3–17.4 over
// MOTIR-4678's service.
//
//   In <org> · already connected  → pick, and the row is linked IMMEDIATELY.
//                                   It costs NOTHING: the graph exists, belongs
//                                   to the organisation, and is not rebuilt
//                                   because a second project picked it up.
//   Connect a new one             → the organisation connection AND the project
//                                   link in one act. The only path that indexes.
//
// ⚠️ A FIRST-TIME ORGANISATION GETS THE PICKER WITH ONE SEGMENT, never an empty
// state that links somewhere else. "Nothing to pick" rendered as a signpost turns
// one intent into two errands — the same defect at the project tier that this
// whole story removes at the organisation tier, and the specific shape §17.4
// exists to forbid. The search field goes (there is nothing to search); everything
// else stays where it was.
//
// ⚠️ A REPOSITORY THIS PROJECT ALREADY HAS IS LISTED AND UNPICKABLE, not filtered
// out. A reader who came looking for it should find it and see why it is not
// offered. (The service's `listAvailableForProject` already subtracts them, so
// this component is handed the two lists separately rather than deriving either.)
//
// ⚠️ THE PROVIDER ASYMMETRY IS DRAWN, NOT SMOOTHED. `Connect a new one` is a
// LINK-OUT to the App's install screen for GitHub — Motir cannot add a repository
// to an installation on the user's behalf, and `github.repos.foot` has said so for
// as long as the page has existed.

export interface AddRepositoryPickerProps {
  /** The organisation's repositories this project does NOT yet hold. */
  options: OrgRepoOptionDto[];
  /** Held already — listed, and unpickable. */
  alreadyHeld: OrgRepoOptionDto[];
  /** The organisation's display name, for the segment heading. */
  organizationName: string;
  /** Where `Connect a new one` hands off. Null on a deployment with no App. */
  installHref: string | null;
  loading: boolean;
  error: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves once the link has landed; the caller owns the optimistic update. */
  onPick: (option: OrgRepoOptionDto) => Promise<void>;
}

export function AddRepositoryPicker({
  options,
  alreadyHeld,
  organizationName,
  installHref,
  loading,
  error,
  open,
  onOpenChange,
  onPick,
}: AddRepositoryPickerProps) {
  const t = useTranslations('repositoryPicker');
  const [query, setQuery] = useState('');
  const [pickingId, setPickingId] = useState<string | null>(null);

  /**
   * A fresh search on every opening: a query left over from last time is a filter
   * the reader did not apply and cannot see the origin of.
   *
   * Cleared on CLOSE, in the event handler — not in an effect on `open`. A
   * `setState` inside an effect is a second render pass for something the
   * interaction already knew (`react-hooks/set-state-in-effect`), and the close is
   * where the intent actually is.
   */
  const setOpen = (next: boolean) => {
    if (!next) setQuery('');
    onOpenChange(next);
  };

  const matches = useCallback(
    (repo: OrgRepoOptionDto) => repo.fullName.toLowerCase().includes(query.trim().toLowerCase()),
    [query],
  );

  const visible = options.filter(matches);
  const visibleHeld = alreadyHeld.filter(matches);
  // ⚠️ THE ZERO CASE IS ABOUT THE ORGANISATION, NOT ABOUT THE SEARCH. An
  // organisation with nothing connected has one segment; a search that matches
  // nothing still has two, and says so.
  const orgHasNothing = options.length === 0 && alreadyHeld.length === 0 && !loading && !error;

  const pick = async (option: OrgRepoOptionDto) => {
    setPickingId(option.id);
    try {
      await onPick(option);
    } finally {
      setPickingId(null);
    }
  };

  return (
    <Modal open={open} onOpenChange={setOpen} title={t('title')} description={t('subtitle')}>
      {/* ⚠️ `Modal.Body`, not a bare flex column (MOTIR-2491). This list is as
          tall as the organisation has repositories — a number this call site
          cannot know — so the fields SCROLL and the connect segment below stays
          reachable. A bare column would push `Connect a new one` off the fold for
          exactly the organisations that have the most repositories. */}
      <Modal.Body className="gap-4">
        {orgHasNothing ? null : (
          <Input
            label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        )}

        {error ? (
          <p role="alert" className="font-sans text-sm text-(--el-danger-on-surface)">
            {t('error')}
          </p>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)">
            <Spinner className="h-4 w-4" aria-hidden />
            {t('loading')}
          </p>
        ) : null}

        {/* SEGMENT 1 — the organisation's. Absent for a first-time organisation,
            which is what makes the zero case a one-segment PICKER rather than a
            signpost. */}
        {orgHasNothing ? null : (
          <section className="flex flex-col gap-2">
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-(--el-text-secondary)">
              {t('segment.organization', { org: organizationName })}
            </p>
            <ul className="flex flex-col gap-1">
              {visible.map((repo) => (
                <li key={repo.id}>
                  <button
                    type="button"
                    onClick={() => void pick(repo)}
                    disabled={pickingId !== null}
                    className="flex w-full items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left hover:bg-(--el-surface) disabled:opacity-60"
                  >
                    <FolderGit2 className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-sans text-sm text-(--el-text)">
                      {repo.fullName}
                    </span>
                    {/* ⚠️ `already indexed · shared` is a STATE and it carries the
                        whole promise of the tier move: the graph exists, belongs
                        to the organisation, and is not rebuilt because a second
                        project picked this up. A NEUTRAL chip, not a tint — a fact
                        about the repository, not a step in a flow. Without it the
                        row is indistinguishable from the segment below, which is
                        exactly the pair the reader is being asked to tell apart. */}
                    <Pill tone="neutral">{t('alreadyIndexed')}</Pill>
                  </button>
                </li>
              ))}
              {visibleHeld.map((repo) => (
                // LISTED AND UNPICKABLE, never filtered out: a reader who came
                // looking for it should find it and see why it is not offered.
                <li
                  key={repo.id}
                  className="flex items-center gap-3 px-(--spacing-control-x) py-(--spacing-control-y) opacity-60"
                >
                  <FolderGit2 className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-sans text-sm text-(--el-text)">
                    {repo.fullName}
                  </span>
                  <span className="shrink-0 font-sans text-xs text-(--el-text-secondary)">
                    {t('alreadyInProject')}
                  </span>
                </li>
              ))}
              {visible.length === 0 && visibleHeld.length === 0 && !loading ? (
                <li className="px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-secondary)">
                  {t('noMatch')}
                </li>
              ) : null}
            </ul>
          </section>
        )}

        {/* SEGMENT 2 — the only path that costs an index, and the one a first-time
            organisation sees alone. The lead sentence says what will happen, so
            the zero case explains itself rather than sending anyone away. */}
        <section className="flex flex-col gap-2">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-(--el-text-secondary)">
            {t('segment.connect')}
          </p>
          {orgHasNothing ? (
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {t('firstTimeLead', { org: organizationName })}
            </p>
          ) : null}
          {installHref ? (
            <a
              href={installHref}
              className={buttonVariants({ variant: orgHasNothing ? 'primary' : 'secondary' })}
            >
              <GithubMark className="h-4 w-4" aria-hidden />
              {t('connectNew')}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          ) : (
            // No App configured on this deployment: drop the control rather than
            // offering a link to nowhere — the same disposition the room's
            // `installHref` already takes.
            <p className="font-sans text-sm text-(--el-text-secondary)">{t('noInstallHref')}</p>
          )}
        </section>
      </Modal.Body>
    </Modal>
  );
}

/** The room's one add door — a primary button in the pane head (§17.2). */
export function AddRepositoryButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations('repositoryPicker');
  return (
    <Button type="button" variant="primary" size="sm" onClick={onClick}>
      <Plus className="h-4 w-4" aria-hidden />
      {t('add')}
    </Button>
  );
}
