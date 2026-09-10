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
   * The section's rows — this project's organisation-owned LINKS, ordered by
   * `splitRoomSections`. This component renders what it is handed and decides
   * nothing about membership.
   *
   * ⚠️ EVERY ENTRY IS REMOVABLE NOW (MOTIR-4954). The array used to mix links
   * with ladder-layered entries that carried no action, which is what made the
   * `Remove from this project` link the ONLY signal telling the two apart —
   * design §18.2: *"a reader cannot answer 'which repositories does this project
   * work on?' from the page whose title is Repositories."* An empty array is a
   * legitimate state and is drawn as such, not hidden.
   */
  entries: OrgSectionEntry[];
  /** The organisation's display name, for the heading, hint and confirm copy. */
  organizationName: string;
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
  canAdd,
  onRemove,
  addButton,
}: OrganizationRepositoriesProps) {
  const t = useTranslations('repositoryPicker');
  // The empty sentence belongs to the ROOM's namespace, not the picker's — it is
  // the page speaking about itself, and it is the same string the whole-room
  // empty state uses (design §18.5, `repositoryTakeover.empty`).
  const tRoom = useTranslations('repositoryTakeover');
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
      {/* ⚠️ THE FOOTER IS GONE, AND BOTH HALVES OF IT WENT SOMEWHERE DIFFERENT
          (MOTIR-4954 · design §18.5–§18.6).

          `section.provenance` — "Connected to the organisation, not to this
          project alone" — is RETIRED, not relocated. It was a true sentence that
          existed to explain rows this section could not remove, and there are no
          such rows any more: every entry here is a LINK this project chose and
          may drop. Organisation provenance is not a footer for a project-link
          list, and a sentence that survives the thing it explained becomes the
          contradiction it was written to resolve — which is exactly the pair
          §18.5 replaces it as half of.

          `section.seeAll` — "See every repository in {org}" — MOVES OUT, into the
          standalone navigation block the room renders after BOTH project sections
          (§18.6). It stopped being a footnote to a list and became the one route
          to the organisation's whole inventory, and a route belongs in navigation
          rather than under the rows it is not about.

          `section.footNoPermission` stays and moves with the heading, because it
          answers a question about the ADD DOOR — who may use it — and the add
          door is at the top of this section. */}
      {/* ⚠️ NOT SILENT WHEN THE ACTOR CANNOT ADD. A room whose one action simply
          vanishes leaves a reader wondering whether they are looking at a bug, so
          the sentence that says WHO can add and WHERE moves up here beside the
          add door it is about — it used to sit in the card footer this card
          removed. Not DISABLED either: an entry point is a promise about a room,
          and a disabled control is a promise the product then refuses. */}
      {canAdd ? null : (
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('section.footNoPermission')}
        </p>
      )}
      <Card>
        {/* ⚠️ PANEL 9 — ZERO LINKS IS A NORMAL STARTING CONDITION, NOT AN ERROR
            AND NOT AN EMPTY BOX (design §18.3). Every project in the estate is in
            this state today. It says the PROJECT is empty while the organisation
            may not be, and it points at the add door above rather than at another
            page: "'Nothing to pick' must never render as a message whose job is to
            send somebody to another page: that turns one intent into two errands."
            The `See every repository in {org}` route is still one block below,
            where a reader looking for it will find it — as navigation, not as the
            answer to having none. */}
        {entries.length === 0 ? (
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
            {tRoom('empty', { org: organizationName })}
          </p>
        ) : (
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
                {/* ⚠️ EVERY ROW CARRIES THIS NOW, AND THAT IS THE CARD (MOTIR-4954).
                  It used to be conditional: a ladder-layered repository had no
                  `project_repository` row, so there was nothing for a remove to
                  delete, and a control that cannot keep its promise is worse than
                  its absence (§16.2). The consequence was that the PRESENCE of
                  this one link became the only signal distinguishing a repository
                  the project works on from one it merely can reach — an affordance
                  carrying a state nothing else labelled, grouped or ordered
                  (§18.2). With the layered half gone every row is a link, the
                  action is unconditional, and the distinction it was silently
                  carrying is now the page's own boundary. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(entry.row)}
                  className="shrink-0 text-(--el-danger-on-surface) hover:bg-(--el-danger-surface)"
                >
                  {t('remove.action')}
                </Button>
              </li>
            ))}
          </ul>
        )}
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
 * The three things a row PRINTS.
 *
 * A row prefers its REALIZED repository — the host's own casing is what a
 * checkout answers to, and it can legitimately differ from the row's authored
 * name once someone renames the repository on GitHub.
 *
 * ⚠️ THERE IS NO SECOND ARM ANY MORE (MOTIR-4954). All three used to branch on
 * `entry.kind`, because a `domain` entry carried only a `repoRef` and its owner
 * had to be split back off that string. That half of the union is gone with the
 * section it fed, so the branch goes with it rather than standing as a dead
 * `else` every reader has to evaluate before concluding it is unreachable.
 */
function repoName(entry: OrgSectionEntry): string {
  return entry.row.realizedRepo?.name ?? entry.row.name;
}

function ownerPrefix(entry: OrgSectionEntry): string {
  return entry.row.realizedRepo ? `${entry.row.realizedRepo.owner}/` : '';
}

function defaultBranch(entry: OrgSectionEntry): string | null {
  return entry.row.realizedRepo?.defaultBranch ?? null;
}
