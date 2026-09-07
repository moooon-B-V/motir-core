'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FolderGit2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import type { OrgSectionEntry } from '@/lib/projectRepos/roomSections';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';

// FROM YOUR ORGANISATION — the project's organisation repositories (Story
// MOTIR-4669 · MOTIR-4681), `design/repository-set/design-notes.md` §17.2 / §17.6.
//
// ⚠️ THE HEADING CHANGED, AND THE COPY WITH IT. It read *Your own repositories*,
// which was true of a workspace-connected repository and is FALSE of an
// org-owned one: these are not the reader's personally, they are the
// organisation's, and the project has them because somebody added them.
//
// ⚠️ AND MOTIR-4820 GAVE THE SECTION THE ROWS THE HEADING ALWAYS PROMISED. §17.2
// is one section — it RENAMES the connected list and gives its rows an action —
// and MOTIR-4681 shipped it as a second section beside the old one, keyed on
// `seedSource`. On a project with no repository SET that left this section EMPTY
// above the very repositories it is about, while `/settings/organization/git`
// read `Used by <project>` for each of them (MOTIR-4802). The section now renders
// the LADDER's answer, which is what the org page counts, so the two surfaces
// agree by construction.
//
// ⚠️ TWO KINDS OF ROW, ONE LIST — and the only thing that distinguishes them is
// whether there is a LINK to remove:
//
//   - a `link`   — a `project_repository` row somebody picked. It carries
//                  `Remove from this project`.
//   - a `domain` — a repository the ladder layers into this project's domain,
//                  with no row of its own. NOTHING to remove, so no action —
//                  the same absence §16.6 drew, for the same reason: an
//                  affordance here would be a promise this room cannot keep.
//
// ⚠️ THE ROW ACTION IS THE FIRST AFFORDANCE A REPOSITORY IN THIS HALF HAS EVER
// HAD, and it is a legitimate one: a project's LINK to an organisation
// repository is exactly the thing a project may change.
//
// ⚠️ THE TWO REMOVALS MUST NOT LOOK ALIKE (§17.6). This one is a quiet row action
// whose confirm's primary is a SECONDARY button and whose copy spends its length
// on what does NOT happen. The organisation's is a destructive confirm (GitLab) or
// a pre-link-out disclosure (GitHub) naming every affected project. **Each label
// names its own tier** — `Remove from this project` · `Disconnect from
// organisation` — so neither depends on the reader knowing which page they are
// standing on.
//
// ⚠️ AND IT IS NOT ORG-ADMIN GATED. The discriminator is what the act CHANGES:
// removing a repository from this project deletes one `ProjectRepo` row and
// touches neither the organisation's connection nor the code graph. It is the
// room's own scope, so it takes the room's own permission, `repository:manage`.

const HEADING_ID = 'project-repositories-organization';

export interface OrganizationRepositoriesProps {
  /**
   * The section's rows — links and ladder-layered repositories, already ordered
   * and de-duplicated by `splitRoomSections`. This component renders what it is
   * handed and decides nothing about membership.
   */
  entries: OrgSectionEntry[];
  /** The organisation's display name, for the heading and the confirm copy. */
  organizationName: string;
  /** The org inventory — `See every repository in <org>`. */
  inventoryHref: string;
  /** Whether the actor may ADD. The remove action is NOT gated on this. */
  canAdd: boolean;
  /** Resolves once the row is gone; the caller owns the optimistic update. */
  onRemove: (row: ProjectRepoDto) => Promise<void>;
  /** The add door, rendered in the section head when the actor may use it. */
  addButton: React.ReactNode;
}

export function OrganizationRepositories({
  entries,
  organizationName,
  inventoryHref,
  canAdd,
  onRemove,
  addButton,
}: OrganizationRepositoriesProps) {
  const t = useTranslations('repositoryPicker');
  const [confirming, setConfirming] = useState<ProjectRepoDto | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (row: ProjectRepoDto) => {
    setBusy(true);
    try {
      await onRemove(row);
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={HEADING_ID} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel id={HEADING_ID}>{t('section.heading')}</SectionLabel>
        {canAdd ? addButton : null}
      </div>
      <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
        {t('section.hint', { org: organizationName })}
      </p>
      <Card
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* ⚠️ THE PROVENANCE SENTENCE, RE-TIERED (MOTIR-4820). The section it
                absorbed carried "Connected for the whole workspace, not for this
                project alone" — a true sentence about the wrong tier, since
                MOTIR-4649 moved a repository's tenancy to the ORGANISATION. It
                matters more here than it did there, because this section now
                holds rows the project cannot remove, and this is what says why.
                ⚠️ NOT SILENT when the actor cannot add. A room whose one action
                simply vanishes leaves a reader wondering whether they are looking
                at a bug; the footer says WHO can do it and WHERE, which is what
                turns an absence into an answer. And not DISABLED either — an entry
                point is a promise about a room, and a disabled control is a
                promise the product then refuses (MOTIR-2468). */}
            <p className="min-w-0 font-sans text-sm text-(--el-text-secondary)">
              {canAdd ? t('section.provenance') : t('section.footNoPermission')}
            </p>
            {/* ⚠️ THE FOOTER LINK STOPPED BEING A HAND-OFF AND BECAME A VIEW. It
                read "Choose which repositories Motir can see" — the way to perform
                an act this room could not. The room performs it now, so the link
                reads "See every repository in <org>". That single change is the
                tier move in one line. */}
            <a
              href={inventoryHref}
              className="font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
            >
              {t('section.seeAll', { org: organizationName })}
            </a>
          </div>
        }
      >
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)"
            >
              <FolderGit2
                className="h-[18px] w-[18px] shrink-0 text-(--el-icon-muted)"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-sans text-sm">
                <span className="text-(--el-text-muted)">{ownerPrefix(entry)}</span>
                <span className="font-medium text-(--el-text)">{repoName(entry)}</span>
              </span>
              {defaultBranch(entry) ? (
                <span className="shrink-0 rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs text-(--el-code-text)">
                  {defaultBranch(entry)}
                </span>
              ) : null}
              {/* ⚠️ ONLY A LINK CARRIES THIS. A ladder-layered repository has no
                  `project_repository` row, so there is nothing for a remove to
                  delete — and a control that cannot keep its promise is worse
                  than its absence (§16.2). */}
              {entry.kind === 'link' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(entry.row)}
                  className="shrink-0 text-(--el-danger-on-surface) hover:bg-(--el-danger-surface)"
                >
                  {t('remove.action')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Modal
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t('remove.title', {
          repo: confirming?.realizedRepo
            ? `${confirming.realizedRepo.owner}/${confirming.realizedRepo.name}`
            : (confirming?.name ?? ''),
        })}
      >
        <div className="flex flex-col gap-4">
          {/* ⚠️ THE COPY SPENDS ITS LENGTH ON WHAT DOES NOT HAPPEN. That is the
              whole difference from the organisation's dialog, which spends its
              length on what does. A project-level remove enqueues NO offboarding
              — it deletes one row and nothing else. */}
          <p className="font-sans text-sm text-(--el-text-secondary)">
            {t('remove.body', { org: organizationName })}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              {t('remove.cancel')}
            </Button>
            {/* SECONDARY, deliberately — a danger fill would claim a blast radius
                this act does not have. */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() => confirming && void remove(confirming)}
            >
              {t('remove.confirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

/**
 * The three things a row PRINTS, read off whichever half of the union it is.
 *
 * A LINK prefers its REALIZED repository — the host's own casing is what a
 * checkout answers to, and it can legitimately differ from the row's authored
 * name once someone renames the repository on GitHub. A DOMAIN entry has only
 * `repoRef`, which is `owner/name` and is that shape's identity, so the owner is
 * split off it rather than carried as its own field: the room's domain read has
 * no owner column to carry.
 *
 * A ref that somehow holds no `/` renders as just the name — the honest
 * degradation, and never a stray slash.
 */
function repoName(entry: OrgSectionEntry): string {
  return entry.kind === 'link' ? (entry.row.realizedRepo?.name ?? entry.row.name) : entry.repo.name;
}

function ownerPrefix(entry: OrgSectionEntry): string {
  if (entry.kind === 'link') {
    return entry.row.realizedRepo ? `${entry.row.realizedRepo.owner}/` : '';
  }
  const cut = entry.repo.repoRef.lastIndexOf('/');
  return cut === -1 ? '' : `${entry.repo.repoRef.slice(0, cut)}/`;
}

function defaultBranch(entry: OrgSectionEntry): string | null {
  return entry.kind === 'link'
    ? (entry.row.realizedRepo?.defaultBranch ?? null)
    : entry.repo.defaultBranch;
}
