'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { FolderGit2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { SectionLabel } from '@/components/ui/SectionLabel';
import type { ProjectRepoConnectedDto } from '@/lib/dto/projectRepos';

// THE OTHER REGISTRY — the repositories this project has because the WORKSPACE
// connected them, not because Motir created them (MOTIR-3126 · design §16).
//
// ⚠️ IT IS THE SHIPPED LIST, MIRRORED — not a new one. `/settings/workspace/github`
// has rendered exactly this for as long as an installation has existed: a `Card`
// over a `flex flex-col gap-1` list whose row is a `FolderGit2` glyph, the
// `owner/` + `name` pair, and a mono default-branch chip. Two surfaces answering
// the same question ("which repositories has this workspace connected?") with two
// different-looking lists is the drift the design-against-shipped-reality rule
// exists to stop, so this composes the same markup rather than restyling it.
//
// ⚠️ NOTHING HERE IS PRESSABLE EXCEPT THE ONE LINK. A row carries no takeover, no
// menu, no disabled control: the user already owns these repositories, so there is
// nothing to move, and an affordance would be a promise this room cannot keep
// (design §16.2). It is drawn as an ABSENCE, which is the same choice MOTIR-1939
// made for an already-yours set row. And no row is focusable for the same reason —
// a focus stop that leads nowhere is worse than none.
//
// ⚠️ THE SECTION'S EXISTENCE IS NOT THIS COMPONENT'S DECISION. `RepositoriesRoom`
// renders it only when the LADDER says the workspace rung is part of this
// project's domain (`ProjectRepoRoomViewDto.connectedInDomain`, from
// `lib/projectRepos/effectiveDomain.ts`). A project born in Motir is answered by
// its set alone and never sees this, empty or otherwise.

/** The section's accessible name — what distinguishes the two lists to a screen
 *  reader, which is the whole a11y content of drawing them apart (§16.9). */
const HEADING_ID = 'project-repositories-connected';

export interface ConnectedRepositoriesProps {
  /** Already split from the set's rows by `connectedNotInSet` — this component
   *  renders what it is handed and de-duplicates nothing of its own. */
  repos: ProjectRepoConnectedDto[];
  /** The shipped workspace GitHub pane, which owns connecting and disconnecting. */
  manageHref: string;
}

export function ConnectedRepositories({ repos, manageHref }: ConnectedRepositoriesProps) {
  const t = useTranslations('repositoryTakeover');

  return (
    <section aria-labelledby={HEADING_ID} className="flex flex-col gap-2">
      <SectionLabel id={HEADING_ID}>{t('yoursHeading')}</SectionLabel>
      <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('yoursHint')}</p>
      <Card
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-sans text-sm text-(--el-text-secondary)">{t('yoursFoot')}</p>
            <Link
              href={manageHref}
              className="font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
            >
              {t('yoursManage')}
            </Link>
          </div>
        }
      >
        <ul className="flex flex-col gap-1">
          {repos.map((repo) => (
            <li
              key={repo.repoRef}
              className="flex items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)"
            >
              <FolderGit2
                className="h-[18px] w-[18px] shrink-0 text-(--el-icon-muted)"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-sans text-sm">
                <span className="text-(--el-text-muted)">{ownerPrefix(repo)}</span>
                <span className="font-medium text-(--el-text)">{repo.name}</span>
              </span>
              {repo.defaultBranch ? (
                <span className="shrink-0 rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs text-(--el-code-text)">
                  {repo.defaultBranch}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/**
 * The `owner/` half of the reference, derived from `repoRef` rather than carried
 * as its own field.
 *
 * `repoRef` is `owner/name` and is this shape's identity, so splitting it here
 * keeps the DTO to facts both of its producers can supply (the room's domain read
 * has no owner column of its own). A ref that somehow carries no `/` renders as
 * just the name — the honest degradation, and never a stray slash.
 */
function ownerPrefix(repo: ProjectRepoConnectedDto): string {
  const cut = repo.repoRef.lastIndexOf('/');
  return cut === -1 ? '' : `${repo.repoRef.slice(0, cut)}/`;
}
