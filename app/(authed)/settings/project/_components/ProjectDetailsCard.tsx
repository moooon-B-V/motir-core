'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Calendar, Eye, Hash, Image as ImageIcon, Info, Layers, Shield, Type } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { ArchiveProjectCard } from './ArchiveProjectCard';

// The Details landing body (Story 6.5 · Subtask 6.5.3) — the read-only project
// identity card plus the re-homed Archive "Danger zone", matching the Details
// panel of `design/projects/settings-area.mock.html`. Pure + presentational
// (every value arrives as a prop, the created date pre-formatted server-side),
// so the role split is unit-testable without a date or a DB.
//
// Role split (the verified 1.3.4 / 6.4 rule the mock's role-states panel draws):
//   * the card head pill reflects the actor's capability — admins get the
//     "Admin" pill (they will gain editing in Story 6.8); non-admin members get
//     the "Read-only" pill;
//   * the "editing arrives with project-details editing" seam shows only to
//     admins (only they ever edit — 6.8's updateDetails is admin-gated);
//   * the Danger zone (archive) renders ONLY for admins — a non-admin member
//     sees Details WITHOUT it (archive is admin-gated; the UI hide is backed by
//     the server-side `assertCanManage` in `projectsService.archiveProject`).
// The identity rows themselves are identical for every viewer.

export interface ProjectDetailsCardProps {
  projectId: string;
  projectName: string;
  projectIdentifier: string;
  workspaceName: string;
  /** The creation date, pre-formatted in the active locale by the server page. */
  createdLabel: string;
  /** Project admin (or workspace owner/admin) — gates the seam + the danger zone. */
  canManage: boolean;
}

export function ProjectDetailsCard({
  projectId,
  projectName,
  projectIdentifier,
  workspaceName,
  createdLabel,
  canManage,
}: ProjectDetailsCardProps) {
  const t = useTranslations('settings');
  const avatarInitial = projectName.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="flex flex-col gap-6">
      <Card
        header={
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('details.cardTitle')}
            </h2>
            {canManage ? (
              <Pill memberRole="admin">
                <Shield className="h-3.5 w-3.5" aria-hidden />
                {t('details.roleAdmin')}
              </Pill>
            ) : (
              <Pill memberRole="viewer">
                <Eye className="h-3.5 w-3.5" aria-hidden />
                {t('details.roleReadOnly')}
              </Pill>
            )}
          </div>
        }
      >
        <dl className="flex flex-col">
          <IdentityRow
            icon={<ImageIcon className="h-[15px] w-[15px]" aria-hidden />}
            label={t('details.fieldAvatar')}
          >
            <span
              aria-hidden
              className="inline-flex h-10 w-10 items-center justify-center rounded-(--radius-control) bg-(--el-type-task) font-sans text-[17px] font-bold text-(--el-text-inverted)"
            >
              {avatarInitial}
            </span>
          </IdentityRow>
          <IdentityRow
            icon={<Type className="h-[15px] w-[15px]" aria-hidden />}
            label={t('details.fieldName')}
          >
            {projectName}
          </IdentityRow>
          <IdentityRow
            icon={<Hash className="h-[15px] w-[15px]" aria-hidden />}
            label={t('details.fieldKey')}
            mono
          >
            {projectIdentifier}
          </IdentityRow>
          <IdentityRow
            icon={<Layers className="h-[15px] w-[15px]" aria-hidden />}
            label={t('details.fieldWorkspace')}
          >
            {workspaceName}
          </IdentityRow>
          <IdentityRow
            icon={<Calendar className="h-[15px] w-[15px]" aria-hidden />}
            label={t('details.fieldCreated')}
          >
            {createdLabel}
          </IdentityRow>
        </dl>

        {canManage ? (
          <p className="mt-3.5 flex items-start gap-2 rounded-(--radius-card) bg-(--el-surface) px-3 py-2.5 font-sans text-xs leading-relaxed text-(--el-text-secondary)">
            <Info className="mt-px h-[15px] w-[15px] shrink-0 text-(--el-text-muted)" aria-hidden />
            <span>{t('details.editingSeam')}</span>
          </p>
        ) : null}
      </Card>

      {canManage ? (
        <ArchiveProjectCard
          projectId={projectId}
          projectName={projectName}
          projectIdentifier={projectIdentifier}
        />
      ) : null}
    </div>
  );
}

// One identity row: an icon + label cell (fixed width, muted) and a value cell.
// A `<div>` pair inside a `<dl>` — `<dt>` for the label, `<dd>` for the value —
// so the read-only identity reads as a description list to assistive tech.
function IdentityRow({
  icon,
  label,
  mono = false,
  children,
}: {
  icon: ReactNode;
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 border-b border-(--el-border-soft) py-3.5 last:border-b-0">
      <dt className="flex w-[132px] flex-none items-center gap-2 font-sans text-[12.5px] text-(--el-text-muted)">
        {icon}
        {label}
      </dt>
      <dd
        className={
          mono
            ? 'min-w-0 flex-1 font-mono text-[12.5px] font-medium text-(--el-text)'
            : 'min-w-0 flex-1 font-sans text-[13.5px] font-medium text-(--el-text)'
        }
      >
        {children}
      </dd>
    </div>
  );
}
