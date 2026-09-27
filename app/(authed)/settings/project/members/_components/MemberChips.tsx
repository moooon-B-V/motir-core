'use client';

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { WorkspaceAccessScope, WorkspaceRole } from '@/generated/prisma/client';

// The two read-only chips a person carries on the project's Access & members
// page and in its Members-only confirm (Story MOTIR-6169 · MOTIR-6550 ·
// `design/projects/access-members--access-modes.mock.html` A1 / A2): their
// WORKSPACE role, in the role hues the workspace page uses, and their access
// SCOPE, neutral with a `Lock` on Limited. A Manager carries no scope chip —
// scope is never read for a Manager (`canEnter`), so the page does not show it.

const ROLE_TINT: Record<WorkspaceRole, string> = {
  manager: 'bg-(--el-role-admin)',
  member: 'bg-(--el-role-member)',
  viewer: 'bg-(--el-role-viewer)',
};

export function RolePill({
  role,
  customRoleName,
}: {
  role: WorkspaceRole;
  /** A workspace custom role's name — its author's text, never translated. */
  customRoleName?: string | null;
}) {
  const t = useTranslations('settings.members');
  return (
    <Pill
      className={`shrink-0 border-transparent text-(--el-text-strong) ${
        customRoleName ? 'bg-(--el-role-custom)' : ROLE_TINT[role]
      }`}
    >
      {customRoleName ?? t(`role.${role}`)}
    </Pill>
  );
}

export function ScopePill({ scope }: { scope: WorkspaceAccessScope }) {
  const t = useTranslations('settings.access');
  return (
    <Pill tone="neutral" className="shrink-0">
      {scope === 'limited' ? <Lock className="size-3" aria-hidden /> : null}
      {t(`scope.${scope}`)}
    </Pill>
  );
}
