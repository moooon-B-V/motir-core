import Link from 'next/link';
import { ArrowLeft, Eye, Lock, Shield, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { RoleCatalogDTO, RoleDTO } from '@/lib/dto/permissions';
import type { ProjectRole } from '@/lib/projects/roles';
import { PermissionGroups } from './PermissionGroups';

// The role DETAIL — screen 2 of the drill-down (Subtask MOTIR-2263), built to
// `design/projects/roles-permissions.mock.html` panel 1: one role's permissions
// at FULL WIDTH, under their domain headings, each description on one line.
//
// ⚠️ BOTH THE CRUMB AND THE BACK LINK, DELIBERATELY. The design notes: "the
// inherited crumb trail is orientation, the back link is the control, and a
// drill-down needs a control rather than a place to read where you are." The
// settings AREA otherwise drops per-page crumbs (the rail owns orientation) —
// this screen is the one place that sits a level BELOW a rail row, which is
// exactly the case that rule never contemplated.
//
// ⚠️ A BUILT-IN ROLE GETS A LOCK AND NO CONTROL AT ALL. Not a disabled Edit, not
// a greyed Delete: the three built-ins reproduce the shipped behaviour by
// definition, so editing one is not a thing that exists. `Edit` / `Delete` and
// the `Based on …` provenance chip arrive with custom roles (MOTIR-2257).

const ROLE_ICON: Record<ProjectRole, typeof Shield> = {
  admin: Shield,
  member: Users,
  viewer: Eye,
};

export function RoleDetail({
  role,
  catalog,
  projectName,
}: {
  role: RoleDTO;
  catalog: RoleCatalogDTO;
  projectName: string;
}) {
  const t = useTranslations('settings.rolesPage');
  const tCatalog = useTranslations();
  const Glyph = ROLE_ICON[role.role];
  const roleName = tCatalog(role.labelKey);

  return (
    <div className="flex flex-col">
      <p className="text-(--el-text-faint) mb-2 font-mono text-[11px] tracking-[0.02em]">
        {t('crumbs', { projectName, roleName })}
      </p>

      <Link
        href="/settings/project/roles"
        className="text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) mb-3 inline-flex w-fit items-center gap-1.5 rounded-(--radius-control) font-sans text-[12.5px] font-medium focus-visible:ring-2"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t('allRoles')}
      </Link>

      <div className="border-(--el-border) mb-1 flex items-start justify-between gap-4 border-b pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="bg-(--el-tint-lavender) text-(--el-text-strong) flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control)"
          >
            <Glyph className="h-[17px] w-[17px]" />
          </span>
          <div className="min-w-0">
            <h1 className="text-(--el-text) font-serif text-xl font-semibold">{roleName}</h1>
            <p className="text-(--el-text-muted) mt-1.5 max-w-[62ch] font-sans text-[13px] leading-relaxed">
              {tCatalog(role.descriptionKey)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {role.builtIn ? (
                <span className="text-(--el-text-faint) inline-flex items-center gap-1 font-sans text-[11px] font-medium whitespace-nowrap">
                  <Lock aria-hidden="true" className="h-3 w-3" />
                  {t('builtInLocked')}
                </span>
              ) : null}
              <span className="bg-(--el-muted) text-(--el-text-secondary) inline-flex h-5 items-center gap-1.5 rounded-(--radius-badge) px-(--spacing-chip-x) font-sans text-[11.5px] whitespace-nowrap">
                <Users aria-hidden="true" className="h-3 w-3" />
                {t('memberCount', { count: role.memberCount })}
              </span>
            </div>
          </div>
        </div>
        <p className="text-(--el-text-secondary) shrink-0 font-sans text-[12.5px] whitespace-nowrap">
          {t.rich('holdsCount', {
            held: role.permissions.length,
            total: catalog.roleGatedPermissionCount,
            strong: (chunks) => <strong className="text-(--el-text)">{chunks}</strong>,
          })}
        </p>
      </div>

      <div className="border-(--el-border) bg-(--el-surface) mt-5 overflow-hidden rounded-(--radius-card) border shadow-(--shadow-card)">
        <PermissionGroups domains={catalog.domains} held={role.permissions} />
      </div>
    </div>
  );
}
