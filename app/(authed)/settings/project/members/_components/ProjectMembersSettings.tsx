'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Check,
  Copy,
  Eye,
  FileText,
  Globe,
  Info,
  Link2,
  Lock,
  Users,
} from 'lucide-react';
import type { ProjectAccessLevel } from '@prisma/client';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import { PROJECT_ASSIGNABLE_ROLES, type ProjectRole } from '@/lib/projects/roles';
import type { ProjectMemberDTO } from '@/lib/dto/projectMembers';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EditOverview } from './EditOverview';

// ProjectMembersSettings (Story 6.4 · Subtask 6.4.5) — the project-settings
// Members + Access UI, built against design/projects/access-members.mock.html
// (the 6.4.1 design asset) and calling the 6.4.4 REST API optimistically.
//
// The two cards:
//   • Project access — the open / limited / private radio cards (PATCH
//     /api/projects/[key]/access). Going private seeds every workspace member
//     as a project member, so we mirror that locally (the server does the same
//     via createManySkipDuplicates).
//   • Members — the project member list with a per-row role select + Remove,
//     and an add-member Combobox scoped to workspace-members-not-yet-on-project
//     (POST / PATCH / DELETE /api/projects/[key]/members[/userId]).
//
// Project-admin gated: `canManage` (a workspace owner/admin, or a project
// admin) governs whether the edit affordances render; non-admins see the same
// data read-only (role chips, no selects, no add/remove) — the gate stays
// legible rather than the controls vanishing.

// The SETTABLE access levels (the radio control), in openness order
// `public > open > limited > private` (Story 6.12.8 adds `public` — the
// make-public toggle — to the 6.4 control; the share link + Overview editor
// below it render only while the project is public, per design/public-projects
// Panel 6). The icon / tint / label maps are total over `ProjectAccessLevel`.
const ACCESS_LEVELS = ['public', 'open', 'limited', 'private'] as const;
type AccessLevel = (typeof ACCESS_LEVELS)[number];

// Per-level icon (design Panel 6: globe / users / eye / lock).
const ACCESS_ICON: Record<ProjectAccessLevel, typeof Globe> = {
  public: Globe,
  open: Users,
  limited: Eye,
  private: Lock,
};
// Icon-tile tint per level — hue in the tint with strong text (AA, finding #35):
// public = sky, open = mint, limited = peach, private = lavender.
const ACCESS_TINT: Record<ProjectAccessLevel, string> = {
  public: 'bg-(--el-tint-sky)',
  open: 'bg-(--el-tint-mint)',
  limited: 'bg-(--el-tint-peach)',
  private: 'bg-(--el-tint-lavender)',
};

export interface ProjectMembersSettingsProps {
  projectKey: string;
  projectName: string;
  workspaceName: string;
  // The project's CURRENT level (display + settable) — `ProjectAccessLevel`,
  // now including `public` (6.12.8, the make-public control).
  accessLevel: ProjectAccessLevel;
  // The authored public Overview/README body (6.12.8) — seeds the entry-point
  // snippet + the route-less "Edit overview" sub-view (`EditOverview`), both
  // shown only while the project is public.
  publicOverviewMd: string | null;
  members: ProjectMemberDTO[];
  workspaceMembers: WorkspaceMemberDTO[];
  currentUserId: string;
  canManage: boolean;
}

export function ProjectMembersSettings({
  projectKey,
  projectName,
  workspaceName,
  accessLevel: initialAccessLevel,
  publicOverviewMd,
  members: initialMembers,
  workspaceMembers,
  currentUserId,
  canManage,
}: ProjectMembersSettingsProps) {
  const t = useTranslations('settings');
  const { toast } = useToast();

  const [accessLevel, setAccessLevel] = useState<ProjectAccessLevel>(initialAccessLevel);
  const [members, setMembers] = useState<ProjectMemberDTO[]>(initialMembers);
  const [accessPending, setAccessPending] = useState(false);
  const [pendingUserIds, setPendingUserIds] = useState<ReadonlySet<string>>(new Set());
  // The Overview/README authoring is a route-less sub-view (Panel 7) reached
  // from the make-public entry point — swap the whole settings content to it
  // rather than navigate, so no settings route/rail entry is invented (the
  // totality contract). `overviewMd` holds the committed body for the snippet.
  const [editingOverview, setEditingOverview] = useState(false);
  const [overviewMd, setOverviewMd] = useState(publicOverviewMd ?? '');

  function setPending(userId: string, on: boolean) {
    setPendingUserIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  // The 6.4.4 routes return `{ code }` on error; surface the only one with a
  // member-specific message (the last-admin guard, 409) and fall back to a
  // generic message for everything else. Read the code as the thrown Error's
  // message so each catch can branch on it.
  async function readError(res: Response): Promise<string> {
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    return data.code ?? 'UNKNOWN';
  }

  // ── Access level ──────────────────────────────────────────────────────────
  async function changeAccess(level: AccessLevel) {
    if (!canManage || level === accessLevel || accessPending) return;
    const prevLevel = accessLevel;
    const prevMembers = members;
    setAccessLevel(level);
    // Going private seeds every workspace member as a project `member`, keeping
    // anyone already a member at their current role — match the server locally.
    if (level === 'private') {
      setMembers((current) => {
        const have = new Set(current.map((m) => m.userId));
        const seeded = workspaceMembers
          .filter((w) => !have.has(w.userId))
          .map<ProjectMemberDTO>((w) => ({
            userId: w.userId,
            name: w.name,
            email: w.email,
            role: 'member',
          }));
        return [...current, ...seeded];
      });
    }
    setAccessPending(true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessLevel: level }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({
        variant: 'success',
        title: t('access.levelChangedToast', { level: t(`access.level.${level}`) }),
      });
    } catch {
      setAccessLevel(prevLevel);
      setMembers(prevMembers);
      toast({
        variant: 'error',
        title: t('access.changeAccessErrorTitle'),
        description: t('access.errorGeneric'),
      });
    } finally {
      setAccessPending(false);
    }
  }

  // ── Members ───────────────────────────────────────────────────────────────
  const availableToAdd = useMemo<ComboboxOption<string>[]>(() => {
    const onProject = new Set(members.map((m) => m.userId));
    return workspaceMembers
      .filter((w) => !onProject.has(w.userId))
      .map((w) => ({ value: w.userId, label: w.name, secondary: w.email, keywords: w.email }));
  }, [members, workspaceMembers]);

  async function addMember(userId: string) {
    const target = workspaceMembers.find((w) => w.userId === userId);
    if (!target) return;
    const optimistic: ProjectMemberDTO = {
      userId: target.userId,
      name: target.name,
      email: target.email,
      role: 'member',
    };
    setMembers((current) => [...current, optimistic]);
    setPending(userId, true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, role: 'member' }),
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
    } catch (err) {
      setMembers(prev);
      const code = err instanceof Error ? err.message : undefined;
      toast({
        variant: 'error',
        title: t('access.removeMemberErrorTitle'),
        description:
          code === 'LAST_PROJECT_ADMIN' ? t('access.errorLastAdmin') : t('access.errorGeneric'),
      });
    } finally {
      setPending(member.userId, false);
    }
  }

  async function changeRole(member: ProjectMemberDTO, role: ProjectRole) {
    if (role === member.role) return;
    const prev = members;
    setMembers((current) => current.map((m) => (m.userId === member.userId ? { ...m, role } : m)));
    setPending(member.userId, true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/members/${member.userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ variant: 'success', title: t('access.roleChangedToast', { name: member.name }) });
    } catch (err) {
      setMembers(prev);
      const code = err instanceof Error ? err.message : undefined;
      toast({
        variant: 'error',
        title: t('access.changeRoleErrorTitle'),
        description:
          code === 'LAST_PROJECT_ADMIN' ? t('access.errorLastAdmin') : t('access.errorGeneric'),
      });
    } finally {
      setPending(member.userId, false);
    }
  }

  const roleOptions = useMemo<ComboboxOption<ProjectRole>[]>(
    () =>
      PROJECT_ASSIGNABLE_ROLES.map((r) => ({
        value: r,
        label: t(`access.role.${r}`),
        secondary: t(`access.roleDesc.${r}`),
      })),
    [t],
  );

  // The dedicated Overview/README editor takes over the whole settings content
  // (Panel 7) — reached from the entry point below, no route change.
  if (editingOverview) {
    return (
      <EditOverview
        value={overviewMd}
        canManage={canManage}
        isPublic={accessLevel === 'public'}
        onClose={() => setEditingOverview(false)}
        onSaved={setOverviewMd}
      />
    );
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
              <p className="text-(--el-text-muted) font-sans text-xs">
                {t('access.accessSubheading', { workspaceName })}
              </p>
            </div>
            <AccessSummaryPill level={accessLevel} label={t(`access.level.${accessLevel}`)} />
          </div>
        }
      >
        <div
          role="radiogroup"
          aria-label={t('access.levelGroupLabel')}
          className="flex flex-col gap-2"
        >
          {ACCESS_LEVELS.map((level) => {
            const Icon = ACCESS_ICON[level];
            const selected = accessLevel === level;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!canManage || accessPending}
                onClick={() => changeAccess(level)}
                className={`focus-visible:ring-(--focus-ring-color) flex items-center gap-3 rounded-(--radius-card) border p-(--spacing-card-padding) text-left focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default ${
                  selected ? 'border-(--el-accent)' : 'border-(--el-border)'
                } ${canManage ? 'enabled:hover:border-(--el-border-strong)' : ''}`}
              >
                <span
                  className={`inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) ${ACCESS_TINT[level]} text-(--el-text-strong)`}
                  aria-hidden
                >
                  <Icon className="size-5" />
                </span>
                <span className="flex-1">
                  <span className="block font-sans text-sm font-medium text-(--el-text)">
                    {t(`access.level.${level}`)}
                  </span>
                  <span className="text-(--el-text-muted) block font-sans text-xs">
                    {t(`access.levelDesc.${level}`, { workspaceName })}
                  </span>
                </span>
                <span
                  className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                    selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
                  }`}
                  aria-hidden
                >
                  {selected ? <span className="size-2 rounded-full bg-(--el-accent)" /> : null}
                </span>
              </button>
            );
          })}
        </div>

        {accessLevel === 'private' && canManage ? (
          <div className="mt-3 flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)">
            <Info className="mt-0.5 size-4 shrink-0 text-(--el-text-strong)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-strong)">
              {t.rich('access.goPrivateNote', {
                count: workspaceMembers.length,
                projectName,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>
        ) : null}
      </Card>

      {/* ── Public link + Overview (only while the project is public, 6.12.8) ── */}
      {accessLevel === 'public' ? (
        <PublicShareSection
          projectKey={projectKey}
          publicOverviewMd={overviewMd}
          canManage={canManage}
          onEditOverview={() => setEditingOverview(true)}
        />
      ) : null}

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
            {canManage ? (
              <div className="w-[15rem]">
                <Combobox
                  options={availableToAdd}
                  value={null}
                  onChange={addMember}
                  label={t('access.addMemberLabel')}
                  placeholder={t('access.addMember')}
                  searchable
                  searchPlaceholder={t('access.addMemberSearch')}
                  emptyText={t('access.addMemberEmpty')}
                />
              </div>
            ) : (
              <Pill tone="neutral">{t('access.readOnly')}</Pill>
            )}
          </div>
        }
      >
        {!canManage ? (
          <div className="mb-3 flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface) p-(--spacing-control-y) px-(--spacing-control-x)">
            <Info className="size-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <p className="text-(--el-text-muted) font-sans text-xs">{t('access.readOnlyNote')}</p>
          </div>
        ) : null}

        <ul role="list" className="flex flex-col">
          {members.map((member) => {
            const isSelf = member.userId === currentUserId;
            const busy = pendingUserIds.has(member.userId);
            const initial = (member.name || member.email).charAt(0).toUpperCase();
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
                      <span className="text-(--el-text-muted) font-normal">
                        {t('access.youSuffix')}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-(--el-text-muted) truncate font-sans text-xs">
                    {member.email}
                  </p>
                </div>

                {canManage && !isSelf ? (
                  <div className="w-[8.5rem]">
                    <Combobox
                      options={roleOptions}
                      value={member.role}
                      onChange={(role) => changeRole(member, role)}
                      label={t('access.roleSelectLabel', { name: member.name })}
                      disabled={busy}
                    />
                  </div>
                ) : (
                  <Pill memberRole={member.role}>{t(`access.role.${member.role}`)}</Pill>
                )}

                {canManage && !isSelf ? (
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
      </Card>
    </div>
  );
}

function AccessSummaryPill({ level, label }: { level: ProjectAccessLevel; label: string }) {
  const Icon = ACCESS_ICON[level];
  return (
    <Pill tone="neutral" className="shrink-0">
      <Icon className="size-3" aria-hidden />
      {label}
    </Pill>
  );
}

// The public-only follow-on to the Access card (Story 6.12 · Subtask 6.12.8,
// design/public-projects Panel 6) — rendered ONLY while the project is public:
//   • the shareable public link (a stable, crawlable `/p/<key>` URL + Copy);
//   • the Overview/README entry point → the dedicated editor (Panel 7).
// Deviation from the Panel-6 mock, noted in the PR: the mock drew Copy/Rotate/
// Disable, but the locked model (Yue, 2026-06-14) is a FULLY PUBLIC, crawlable,
// SEO/GEO-indexed page, and the 6.12.4 public route is the stable project key
// (`/p/<identifier>`), not a rotatable secret slug. A rotatable/secret link is
// incoherent with an indexable page, so we ship a STABLE link (Copy only) and
// fold "stop sharing" into the access control above (set a non-public level) —
// the GitHub / Canny model. "Rotate" is dropped (no stated use case; rung-1
// "no complexity for nothing").
function PublicShareSection({
  projectKey,
  publicOverviewMd,
  canManage,
  onEditOverview,
}: {
  projectKey: string;
  publicOverviewMd: string | null;
  canManage: boolean;
  onEditOverview: () => void;
}) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  // The path is stable + server-relative; the absolute origin is only resolvable
  // client-side, so build the display/copy value after mount to avoid a
  // hydration mismatch. The path itself (`/p/<key>`) renders immediately.
  const publicPath = `/p/${projectKey}`;

  async function copyLink() {
    const href =
      typeof window !== 'undefined' ? `${window.location.origin}${publicPath}` : publicPath;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ variant: 'error', title: t('public.copyError') });
    }
  }

  const overviewSnippet = (publicOverviewMd ?? '')
    .replace(/[#>*_`~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

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
            <span className="truncate font-mono text-xs text-(--el-text)">{publicPath}</span>
          </span>
          <Button variant="secondary" size="md" onClick={copyLink}>
            {copied ? (
              <Check className="size-4 text-(--el-success)" aria-hidden />
            ) : (
              <Copy className="size-4" aria-hidden />
            )}
            {copied ? t('public.copied') : t('public.copy')}
          </Button>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)">
          <Info className="mt-0.5 size-4 shrink-0 text-(--el-text-strong)" aria-hidden />
          <p className="font-sans text-xs text-(--el-text-strong)">{t('public.linkNote')}</p>
        </div>
      </Card>

      {/* Overview / README entry point → the dedicated editor (Panel 7) */}
      <Card
        header={
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('public.overviewHeading')}
              </h2>
              <p className="text-(--el-text-muted) font-sans text-xs">
                {t('public.overviewSubheading')}
              </p>
            </div>
            {canManage ? (
              <Button variant="secondary" size="md" onClick={onEditOverview}>
                <FileText className="size-4" aria-hidden />
                {t('public.editOverview')}
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="flex items-center gap-3 rounded-(--radius-card) bg-(--el-surface) p-(--spacing-card-padding)">
          <FileText className="text-(--el-text-muted) size-4 shrink-0" aria-hidden />
          <p className="text-(--el-text-secondary) min-w-0 flex-1 truncate font-sans text-sm">
            {overviewSnippet || t('public.overviewEmpty')}
          </p>
          {canManage ? (
            <button
              type="button"
              onClick={onEditOverview}
              className="text-(--el-link) hover:text-(--el-link-pressed) inline-flex shrink-0 items-center gap-1 font-sans text-xs font-medium"
            >
              {t('public.overviewEdit')}
              <ArrowRight className="size-3" aria-hidden />
            </button>
          ) : null}
        </div>
        <p className="text-(--el-text-muted) mt-2 font-sans text-xs">{t('public.overviewNote')}</p>
      </Card>
    </div>
  );
}
