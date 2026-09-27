'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Info,
  Link2,
  LoaderCircle,
  Lock,
  Megaphone,
  Users,
  X,
} from 'lucide-react';
import type { ProjectAccessMode } from '@/generated/prisma/client';
import { Card } from '@/components/ui/Card';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import { BuildingInPublicBadge } from '@/components/projects/BuildingInPublicBadge';
import type { AccessLossPersonDTO, ProjectMemberDTO } from '@/lib/dto/projectMembers';
import type { WorkspaceMemberWithAccessDTO } from '@/lib/dto/workspaces';
import { BuildInPublicDialog } from './BuildInPublicDialog';
import { StopBuildInPublicDialog } from './StopBuildInPublicDialog';
import { MembersOnlyConfirmDialog } from './MembersOnlyConfirmDialog';
import { RolePill, ScopePill } from './MemberChips';

// ProjectMembersSettings — the project's Access & members page (Story 6.4 ·
// Subtask 6.4.5; re-pointed at ACCESS MODES by Story MOTIR-6169 · MOTIR-6550 and
// `design/projects/access-members--access-modes.mock.html`).
//
// The two cards:
//   • Project access — the three MODES (Open to the workspace · Members only ·
//     Public) as the shipped radio-card markup (there is no `RadioGroup`
//     primitive; the card IS the radio — design A1). `PATCH
//     /api/projects/[key]/access { accessMode }`. Members only first reads the
//     preview and confirms who loses access (A2 / A3); Public goes through the
//     build-in-public dialog and is disabled, with its reason, off-cloud (A10).
//   • Members — the people added to the project, each with read-only role and
//     scope chips (A1), an "Add people" Combobox of workspace members not yet
//     added (A5), and Remove. `POST` / `DELETE /api/projects/[key]/members`.
//
// The two cards are gated SEPARATELY (A6 / A7): `canManageAccess`
// (`project:manage_access`) owns the mode control, `canManageMembers`
// (`member:manage`) the people controls. Without one, that card is read-only —
// the mode shown as text, or the list without Add / Remove — rather than gone.

// The modes in the order the design draws them. Total over `ProjectAccessMode`.
const ACCESS_MODES = [
  'workspace',
  'members',
  'public',
] as const satisfies readonly ProjectAccessMode[];

// Per-mode icon and tile tint (design A1): mint Users · lavender Lock · the
// build-in-public megaphone on its own tokens.
const MODE_ICON: Record<ProjectAccessMode, typeof Megaphone> = {
  workspace: Users,
  members: Lock,
  public: Megaphone,
};
const MODE_TINT: Record<ProjectAccessMode, string> = {
  workspace: 'bg-(--el-tint-mint) text-(--el-text-strong)',
  members: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  public: 'bg-(--el-build-bg) text-(--el-build-glyph)',
};

export interface ProjectMembersSettingsProps {
  projectKey: string;
  projectName: string;
  workspaceName: string;
  /** The project's CURRENT access mode. */
  accessMode: ProjectAccessMode;
  members: ProjectMemberDTO[];
  /** Every workspace member, with role and scope — the add picker's source and
   *  where each row's chips are read from (MOTIR-6545). */
  workspaceMembers: WorkspaceMemberWithAccessDTO[];
  currentUserId: string;
  /** `project:manage_access` — whether the mode control is live (A6 / A7). */
  canManageAccess: boolean;
  /** `member:manage` — whether Add / Remove render (A6 / A7). */
  canManageMembers: boolean;
  /**
   * Whether this BUILD can publish a project at all — `isCloud()`, read on the
   * server page (MOTIR-4035). Threaded as a prop rather than read here because
   * `MOTIR_CLOUD` is a server variable and this is a client island.
   *
   * False on a self-hosted build, where `app/api/public/*` serves nothing: Public
   * is then DRAWN, disabled, with the reason (design A10) rather than removed.
   * The service refuses it too (`PublicAccessUnavailableError`).
   */
  publicAccessAvailable: boolean;
  /**
   * The project's absolute address ON THE PUBLIC SITE — `https://motir.co/p/<key>`
   * once `MOTIR_PUBLIC_SITE_URL` is configured (MOTIR-4242), resolved on the
   * server by `publicProjectUrl()`, the one module that owns that question.
   */
  publicPageUrl: string;
}

export function ProjectMembersSettings({
  projectKey,
  projectName,
  workspaceName,
  accessMode: initialAccessMode,
  members: initialMembers,
  workspaceMembers,
  currentUserId,
  canManageAccess,
  canManageMembers,
  publicAccessAvailable,
  publicPageUrl,
}: ProjectMembersSettingsProps) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const router = useRouter();

  const [accessMode, setAccessMode] = useState<ProjectAccessMode>(initialAccessMode);
  // The mode being saved — its card shows a spinner in place of the radio dot
  // and the group is disabled until the write settles (design A8).
  const [savingMode, setSavingMode] = useState<ProjectAccessMode | null>(null);
  const [members, setMembers] = useState<ProjectMemberDTO[]>(initialMembers);
  const [pendingUserIds, setPendingUserIds] = useState<ReadonlySet<string>>(new Set());
  // The "Start building in public?" explainer/confirm (Story 6.17.2). Choosing
  // Public opens it instead of writing — going public is a confirmed action.
  const [buildConfirmOpen, setBuildConfirmOpen] = useState(false);
  // The reverse "Stop building in public?" confirm (Story 6.17.4).
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  // The Members-only confirm (design A2 / A3): who loses access, from the
  // preview read. `null` while closed.
  const [membersOnlyLosing, setMembersOnlyLosing] = useState<AccessLossPersonDTO[] | null>(null);
  const [previewPending, setPreviewPending] = useState(false);

  const accessBusy = savingMode !== null || previewPending;
  const modeLabel = (mode: ProjectAccessMode) => t(`access.mode.${mode}`);
  const byUserId = useMemo(
    () => new Map(workspaceMembers.map((w) => [w.userId, w])),
    [workspaceMembers],
  );

  function setPending(userId: string, on: boolean) {
    setPendingUserIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  // The member routes return `{ code }` on error; read it as the thrown Error's
  // message so each catch can branch on it.
  async function readError(res: Response): Promise<string> {
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    return data.code ?? 'UNKNOWN';
  }

  // ── Access mode ───────────────────────────────────────────────────────────
  // Choosing a mode. Public is gated behind the build-in-public dialog, and
  // Members only behind the preview-and-confirm — in both the radio does not
  // flip until the person confirms. Open to the workspace applies at once: it
  // only ever admits more people.
  function changeMode(mode: ProjectAccessMode) {
    if (!canManageAccess || mode === accessMode || accessBusy) return;
    // Off-cloud there is nothing to publish to (MOTIR-4035). The card is
    // disabled, so this is the belt to that brace.
    if (mode === 'public' && !publicAccessAvailable) return;
    if (mode === 'public') {
      setBuildConfirmOpen(true);
      return;
    }
    if (mode === 'members') {
      void openMembersOnlyConfirm();
      return;
    }
    void applyMode(mode);
  }

  async function openMembersOnlyConfirm() {
    setPreviewPending(true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/access/preview?mode=members`);
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { losing: AccessLossPersonDTO[] };
      setMembersOnlyLosing(data.losing);
    } catch {
      toast({
        variant: 'error',
        title: t('access.changeAccessErrorTitle'),
        description: t('access.changeAccessErrorBody', {
          projectName,
          mode: modeLabel(accessMode),
        }),
      });
    } finally {
      setPreviewPending(false);
    }
  }

  async function confirmMembersOnly() {
    await applyMode('members');
    setMembersOnlyLosing(null);
  }

  async function confirmBuildInPublic() {
    await applyMode('public');
    setBuildConfirmOpen(false);
  }

  // Stopping building in public returns the project to Open to the workspace —
  // the non-public mode the card specifies (Story 6.17.4); no prior mode is kept.
  async function confirmStop() {
    await applyMode('workspace');
    setStopConfirmOpen(false);
  }

  // The access write. The chosen card saves in place (A8); on failure the
  // selection reverts and the toast names the mode the project is STILL in.
  async function applyMode(mode: ProjectAccessMode) {
    if (mode === accessMode) return;
    const prevMode = accessMode;
    setSavingMode(mode);
    try {
      const res = await fetch(`/api/projects/${projectKey}/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessMode: mode }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setAccessMode(mode);
      toast({
        variant: 'success',
        title: t('access.modeChangedToast', { projectName, mode: modeLabel(mode) }),
      });
      // The mode also feeds SERVER-rendered surfaces — the shell header's
      // build-in-public slot and the switcher's project list. This card stays a
      // client island seeded once, so `router.refresh()` re-reads those without
      // touching it (page-state-after-mutation: keep the island, refresh the
      // server surface).
      router.refresh();
    } catch {
      setAccessMode(prevMode);
      toast({
        variant: 'error',
        title: t('access.changeAccessErrorTitle'),
        description: t('access.changeAccessErrorBody', {
          projectName,
          mode: modeLabel(prevMode),
        }),
      });
    } finally {
      setSavingMode(null);
    }
  }

  // ── Members ───────────────────────────────────────────────────────────────
  // Workspace members not yet added (A5). The secondary line is
  // `email · role · scope`; a Manager is offered but marked "always enters".
  const availableToAdd = useMemo<ComboboxOption<string>[]>(() => {
    const onProject = new Set(members.map((m) => m.userId));
    return workspaceMembers
      .filter((w) => !onProject.has(w.userId))
      .map((w) => {
        const role = w.customRole?.name ?? t(`members.role.${w.workspaceRole}`);
        const tail =
          w.workspaceRole === 'manager'
            ? t('access.alwaysEnters')
            : t(`access.scope.${w.accessScope}`);
        return {
          value: w.userId,
          label: w.name,
          secondary: `${w.email} · ${role} · ${tail}`,
          keywords: w.email,
        };
      });
  }, [members, workspaceMembers, t]);

  async function addMember(userId: string) {
    const target = workspaceMembers.find((w) => w.userId === userId);
    if (!target) return;
    const optimistic: ProjectMemberDTO = {
      userId: target.userId,
      name: target.name,
      email: target.email,
    };
    setMembers((current) => [...current, optimistic]);
    setPending(userId, true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { member: ProjectMemberDTO };
      setMembers((current) => current.map((m) => (m.userId === userId ? data.member : m)));
      toast({ variant: 'success', title: t('access.memberAddedToast', { name: target.name }) });
    } catch {
      setMembers((current) => current.filter((m) => m.userId !== userId));
      toast({
        variant: 'error',
        title: t('access.addMemberErrorTitle'),
        description: t('access.errorGeneric'),
      });
    } finally {
      setPending(userId, false);
    }
  }

  async function removeMember(member: ProjectMemberDTO) {
    const prev = members;
    setMembers((current) => current.filter((m) => m.userId !== member.userId));
    setPending(member.userId, true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/members/${member.userId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ variant: 'success', title: t('access.memberRemovedToast', { name: member.name }) });
    } catch {
      setMembers(prev);
      toast({
        variant: 'error',
        title: t('access.removeMemberErrorTitle'),
        description: t('access.errorGeneric'),
      });
    } finally {
      setPending(member.userId, false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Project access ─────────────────────────────────────────────── */}
      <Card
        header={
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('access.accessHeading')}
              </h2>
              <p className="text-(--el-text-secondary) font-sans text-xs">
                {t('access.accessSubheading', { workspaceName })}
              </p>
            </div>
            <ModeSummaryPill mode={accessMode} label={modeLabel(accessMode)} />
          </div>
        }
      >
        {canManageAccess ? (
          <div
            role="radiogroup"
            aria-label={t('access.modeGroupLabel')}
            className="flex flex-col gap-2"
          >
            {ACCESS_MODES.map((mode) => {
              const selected = accessMode === mode;
              const unavailable = mode === 'public' && !publicAccessAvailable;
              return (
                <ModeCard
                  key={mode}
                  mode={mode}
                  label={modeLabel(mode)}
                  description={t(`access.modeDesc.${mode}`, { workspaceName })}
                  selected={selected}
                  saving={savingMode === mode}
                  disabled={accessBusy || unavailable}
                  unavailableReason={unavailable ? t('access.publicUnavailable') : null}
                  liveLabel={t('buildInPublic.liveBadge')}
                  onSelect={() => changeMode(mode)}
                />
              );
            })}
          </div>
        ) : (
          // Read-only (design A6 / A7): the mode as TEXT — the selected card
          // alone, no radio — and one note saying who can change it.
          <div className="flex flex-col gap-3">
            <ModeCard
              mode={accessMode}
              label={modeLabel(accessMode)}
              description={t(`access.modeDesc.${accessMode}`, { workspaceName })}
              selected
              readOnly
              liveLabel={t('buildInPublic.liveBadge')}
            />
            <InfoNote>{t('access.readOnlyModeNote')}</InfoNote>
          </div>
        )}
      </Card>

      <BuildInPublicDialog
        open={buildConfirmOpen}
        onOpenChange={setBuildConfirmOpen}
        onConfirm={confirmBuildInPublic}
        pending={savingMode === 'public'}
      />

      <MembersOnlyConfirmDialog
        open={membersOnlyLosing !== null}
        onOpenChange={(open) => {
          if (!open) setMembersOnlyLosing(null);
        }}
        projectName={projectName}
        workspaceName={workspaceName}
        losing={membersOnlyLosing ?? []}
        onConfirm={confirmMembersOnly}
        pending={savingMode === 'members'}
      />

      {/* ── Building-in-public status + manage / stop + public link (only
          while the project is public; design A10 keeps them unchanged) ───── */}
      {accessMode === 'public' ? (
        <>
          <BuildInPublicManageRow
            publicPageUrl={publicPageUrl}
            canManage={canManageAccess}
            onStop={() => setStopConfirmOpen(true)}
          />
          <PublicShareSection publicPageUrl={publicPageUrl} canManage={canManageAccess} />
        </>
      ) : null}

      <StopBuildInPublicDialog
        open={stopConfirmOpen}
        onOpenChange={setStopConfirmOpen}
        onConfirm={confirmStop}
        pending={savingMode === 'workspace'}
      />

      {/* ── Members ────────────────────────────────────────────────────── */}
      <Card
        header={
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('access.membersHeading')}
              </h2>
              <Pill
                tone="neutral"
                aria-label={t('access.memberCountLabel', { count: members.length })}
              >
                <Users className="size-3" aria-hidden />
                {members.length}
              </Pill>
            </div>
            {canManageMembers ? (
              <div className="w-[15rem]">
                <Combobox
                  options={availableToAdd}
                  value={null}
                  onChange={addMember}
                  label={t('access.addMemberLabel')}
                  placeholder={t('access.addPeople')}
                  searchable
                  searchPlaceholder={t('access.addPeopleSearch')}
                  emptyText={t('access.addMemberEmpty')}
                />
              </div>
            ) : (
              <Pill tone="neutral">{t('access.readOnly')}</Pill>
            )}
          </div>
        }
      >
        <p className="text-(--el-text-secondary) mb-3 font-sans text-xs">
          {t('access.membersFromWorkspaceRole')}{' '}
          <Link
            href="/settings/workspace/roles"
            className="text-(--el-link) underline underline-offset-2"
          >
            {t('access.workspaceRolesLink')}
          </Link>
        </p>
        {!canManageMembers ? (
          <div className="mb-3">
            <InfoNote>{t('access.readOnlyNote')}</InfoNote>
          </div>
        ) : null}

        {members.length === 0 && accessMode === 'members' ? (
          // Members only with nobody added (design A4).
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span
              className="bg-(--el-tint-lavender) text-(--el-text-strong) inline-flex size-9 items-center justify-center rounded-(--radius-control)"
              aria-hidden
            >
              <Lock className="size-5" />
            </span>
            <p className="font-sans text-sm font-medium text-(--el-text)">
              {t('access.emptyMembersOnlyTitle')}
            </p>
            <p className="text-(--el-text-secondary) max-w-[26rem] font-sans text-xs">
              {t('access.emptyMembersOnlyBody')}
            </p>
          </div>
        ) : (
          <ul role="list" className="flex flex-col">
            {members.map((member) => {
              const isSelf = member.userId === currentUserId;
              const busy = pendingUserIds.has(member.userId);
              const initial = (member.name || member.email).charAt(0).toUpperCase();
              const who = byUserId.get(member.userId);
              return (
                <li
                  key={member.userId}
                  className="border-(--el-border-soft) flex items-center gap-3 border-b py-3 last:border-b-0"
                >
                  <span
                    className="bg-(--el-text) text-(--el-text-inverted) inline-flex size-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold"
                    aria-hidden
                  >
                    {initial}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-sans text-sm font-medium text-(--el-text)">
                      {member.name}
                      {isSelf ? (
                        <span className="text-(--el-text-secondary) font-normal">
                          {t('access.youSuffix')}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-(--el-text-secondary) truncate font-sans text-xs">
                      {member.email}
                    </p>
                  </div>
                  {who ? (
                    <>
                      <RolePill role={who.workspaceRole} customRoleName={who.customRole?.name} />
                      {who.workspaceRole === 'manager' ? null : (
                        <ScopePill scope={who.accessScope} />
                      )}
                    </>
                  ) : null}

                  {canManageMembers && !isSelf ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy}
                      onClick={() => removeMember(member)}
                    >
                      {t('access.remove')}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

// One mode as a radio card (design A1) — or, read-only, as the same card with
// no radio and no button role (A6). The card IS the radio.
function ModeCard({
  mode,
  label,
  description,
  selected,
  saving = false,
  disabled = false,
  readOnly = false,
  unavailableReason = null,
  liveLabel,
  onSelect,
}: {
  mode: ProjectAccessMode;
  label: string;
  description: string;
  selected: boolean;
  saving?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  unavailableReason?: string | null;
  liveLabel: string;
  onSelect?: () => void;
}) {
  const Icon = MODE_ICON[mode];
  const body = (
    <>
      <span
        className={`inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) ${MODE_TINT[mode]}`}
        aria-hidden
      >
        <Icon className="size-5" />
      </span>
      <span className="flex-1">
        <span className="flex items-center gap-2 font-sans text-sm font-medium text-(--el-text)">
          {label}
          {mode === 'public' && selected ? (
            <Pill className="border-transparent bg-(--el-build-bg) text-(--el-build-text)">
              <Megaphone className="size-3" aria-hidden />
              {liveLabel}
            </Pill>
          ) : null}
        </span>
        <span className="text-(--el-text-secondary) block font-sans text-xs">{description}</span>
        {unavailableReason ? (
          <span className="text-(--el-text-secondary) mt-1 flex items-start gap-1 font-sans text-xs">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
            {unavailableReason}
          </span>
        ) : null}
      </span>
    </>
  );

  if (readOnly) {
    return (
      <div className="border-(--el-border) flex items-center gap-3 rounded-(--radius-card) border p-(--spacing-card-padding)">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={unavailableReason ? true : undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`focus-visible:ring-(--focus-ring-color) enabled:hover:border-(--el-border-strong) flex items-center gap-3 rounded-(--radius-card) border p-(--spacing-card-padding) text-left focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default ${
        selected ? 'border-(--el-accent)' : 'border-(--el-border)'
      } ${unavailableReason ? 'opacity-60' : ''}`}
    >
      {body}
      {saving ? (
        <LoaderCircle className="size-4 shrink-0 animate-spin text-(--el-accent)" aria-hidden />
      ) : (
        <span
          className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
            selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
          }`}
          aria-hidden
        >
          {selected ? <span className="size-2 rounded-full bg-(--el-accent)" /> : null}
        </span>
      )}
    </button>
  );
}

function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface) p-(--spacing-control-y) px-(--spacing-control-x)">
      <Info className="text-(--el-text-secondary) size-4 shrink-0" aria-hidden />
      <p className="text-(--el-text-secondary) font-sans text-xs">{children}</p>
    </div>
  );
}

function ModeSummaryPill({ mode, label }: { mode: ProjectAccessMode; label: string }) {
  const Icon = MODE_ICON[mode];
  return (
    <Pill tone="neutral" className="shrink-0">
      <Icon className="size-3" aria-hidden />
      {label}
    </Pill>
  );
}

// `https://motir.co/p/MOTIR` → `motir.co/p/MOTIR`. The mono path beside the
// status badge shows the HOST, so a reader can see which site the link goes to,
// without the scheme's noise (MOTIR-4242, design Panel A frame 3). Purely
// presentational: it never re-resolves the origin, it trims the one the server
// already resolved.
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

// The "Building in public" status + manage row (Story 6.17 · Subtask 6.17.4,
// design/public-projects Panel 12) — rendered in the access area while the
// project is public. Pairs the status badge with the live public URL, a "View
// public page" link, and (admins only) a "Stop" action that opens the reverse
// confirm. Non-admins see the badge + link read-only (no Stop) — the gate stays
// legible rather than the control vanishing, matching the Members card.
function BuildInPublicManageRow({
  publicPageUrl,
  canManage,
  onStop,
}: {
  publicPageUrl: string;
  canManage: boolean;
  onStop: () => void;
}) {
  const t = useTranslations('settings');
  // MOTIR-4242 — the link and the mono path beside the badge are the PUBLIC
  // site's address, not this application's. The displayed form drops the scheme
  // (`motir.co/p/<key>`) and the link keeps it; both come from the one resolved
  // value, so they can never disagree the way three hand-spelled sites did.
  const publicPageDisplay = stripScheme(publicPageUrl);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <BuildingInPublicBadge label={t('buildInPublic.statusBadge')} className="self-start" />
          <span className="text-(--el-text-muted) truncate font-mono text-xs">
            {publicPageDisplay}
          </span>
        </div>
        <a
          href={publicPageUrl}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'secondary', size: 'md' })}
        >
          <ExternalLink className="size-4" aria-hidden />
          {t('buildInPublic.viewPublicPage')}
        </a>
        {canManage ? (
          <Button
            variant="danger"
            size="md"
            onClick={onStop}
            leftIcon={<X className="size-4" aria-hidden />}
          >
            {t('buildInPublic.stop')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

// The public-only follow-on to the Access card (Story 6.12 · Subtask 6.12.8 +
// 6.16.6, design/public-projects Panel 6; retargeted by MOTIR-4242 against
// design/projects/public-page.mock.html Panel A frames 2 and 3) — rendered ONLY
// while the project is public:
//   • the shareable public link — the PUBLIC SITE's absolute URL + Copy;
//   • the "Hero & overview" row → an "Edit the public page" link that opens
//     Settings > Public page, the room MOTIR-4171 mounts.
//
// ⚠️ MOTIR-4242 — BOTH targets used to name this application. The share value
// was `window.location.origin` + the site-relative path, i.e.
// `https://app.motir.co/p/<key>`, and the edit link was that path plus
// `?edit=1`. `app/(public)/p/` was deleted by MOTIR-3951 and the editing surface
// moved into the application (`docs/decisions/public-surface-hosts.md`
// AMENDMENT 4 row 7), so the first 404'd on the wrong host and the second 404'd
// on this one. The absolute URL now arrives as a prop, resolved on the server by
// the single owner of the public origin.
//
// The old in-settings Overview split-editor (`EditOverview`, Panel 7) is REMOVED
// (6.16.6, explicit user request) — there is one editing surface, and since
// MOTIR-4171 it is the Public page room rather than the public page itself.
// Deviation from the Panel-6 mock, noted in the PR: the mock drew Copy/Rotate/
// Disable, but the locked model (Yue, 2026-06-14) is a FULLY PUBLIC, crawlable,
// SEO/GEO-indexed page, and the 6.12.4 public route is the stable project key
// (`/p/<identifier>`), not a rotatable secret slug. A rotatable/secret link is
// incoherent with an indexable page, so we ship a STABLE link (Copy only) and
// fold "stop sharing" into the access control above (set a non-public level) —
// the GitHub / Canny model. "Rotate" is dropped (no stated use case; rung-1
// "no complexity for nothing").
function PublicShareSection({
  publicPageUrl,
  canManage,
}: {
  publicPageUrl: string;
  canManage: boolean;
}) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  // The room is in THIS application, so its link is site-relative (MOTIR-4171
  // mounts the route; MOTIR-4242 retargets the door). The `?edit=1` deep link
  // into the retired on-page editor is gone with the page that hosted it.
  const editPath = '/settings/project/public';
  const publicAddressPath = '/settings/project/public-address';

  async function copyLink() {
    try {
      // What a person pastes into a tweet. The value is server-resolved, so it
      // is the same string the field shows and needs no after-mount dance.
      await navigator.clipboard.writeText(publicPageUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ variant: 'error', title: t('public.copyError') });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Public link */}
      <Card
        header={
          <div>
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('public.linkHeading')}
            </h2>
            <p className="text-(--el-text-muted) font-sans text-xs">{t('public.linkSubheading')}</p>
          </div>
        }
      >
        <div className="flex items-center gap-2">
          <span className="border-(--el-border) bg-(--el-surface) flex h-(--height-input) min-w-0 flex-1 items-center gap-2 rounded-(--radius-input) border px-(--spacing-input-x)">
            <Link2 className="text-(--el-text-muted) size-4 shrink-0" aria-hidden />
            <span className="truncate font-mono text-xs text-(--el-text)">{publicPageUrl}</span>
          </span>
          <Button
            variant="secondary"
            size="md"
            onClick={copyLink}
            leftIcon={
              copied ? (
                <Check className="size-4 text-(--el-success)" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )
            }
          >
            {copied ? t('public.copied') : t('public.copy')}
          </Button>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)">
          <Info className="mt-0.5 size-4 shrink-0 text-(--el-text-strong)" aria-hidden />
          <p className="font-sans text-xs text-(--el-text-strong)">{t('public.linkNote')}</p>
        </div>
        {/* DOOR ② into the Public address room (Story MOTIR-3878 · MOTIR-4221,
            design/projects/design-notes.md § *The access path*, entrance ②).
            It sits UNDER the share link on purpose: this is the moment the
            question occurs — somebody has just made a project public and is
            looking at the address it got. Admin-gated exactly as the Hero &
            overview door below is; a non-admin sees neither. */}
        {canManage ? (
          <a
            href={publicAddressPath}
            className="mt-3 inline-flex items-center gap-1.5 font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {t('public.setUpOwnAddress')}
            <ArrowRight className="size-4" aria-hidden />
          </a>
        ) : null}
      </Card>

      {/* Hero & overview → the Public page room (MOTIR-4242, design
          public-page.mock.html Panel A frame 2). Editing happens in Settings >
          Public page; this is the door to it. Admin-gated — a non-admin sees the
          copy without the link. */}
      <Card
        header={
          <div>
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('public.heroOverviewHeading')}
            </h2>
            <p className="text-(--el-text-muted) font-sans text-xs">
              {t('public.heroOverviewSubheading')}
            </p>
          </div>
        }
      >
        {canManage ? (
          <a
            href={editPath}
            className="text-(--el-link) hover:text-(--el-link-pressed) inline-flex items-center gap-1.5 font-sans text-sm font-medium"
          >
            {t('public.editOnPublicPage')}
            <ArrowRight className="size-4" aria-hidden />
          </a>
        ) : null}
        <p className="text-(--el-text-muted) mt-2 font-sans text-xs">
          {t('public.heroOverviewNote')}
        </p>
      </Card>
    </div>
  );
}
