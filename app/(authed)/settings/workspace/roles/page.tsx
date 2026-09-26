import { getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import { RoleList } from './_components/RoleList';
import { loadRolesPage } from './_load';

// Workspace settings → Access → Roles & permissions (Story MOTIR-6168 ·
// MOTIR-6466): the Roles room moved up a tier from project settings, built to
// `design/workspaces/workspace-roles.mock.html` panel 2. Every member reads it;
// only a Manager gets New role / Edit / Delete.

export default async function WorkspaceRolesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const t = await getTranslations('settings');
  const { workspace, catalog, canManage } = await loadRolesPage();
  const { from } = await searchParams;

  return (
    <div className="mx-auto flex max-w-[48rem] flex-col gap-6">
      {from === 'project' ? (
        // A bookmark of the retired project Roles page lands here (panel 4c).
        <p className="border-(--el-info) bg-(--el-tint-sky) text-(--el-text-strong) flex items-center gap-2 rounded-(--radius-control) border-l-2 px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs">
          <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {t('rolesPage.movedFromProject')}
        </p>
      ) : null}
      <header className="flex flex-col gap-1">
        <h1 className="text-(--el-text) font-serif text-3xl font-semibold">
          {t('rolesPage.title')}
        </h1>
        <p className="text-(--el-text-secondary) font-sans text-sm">
          {t.rich('rolesPage.subtitle', {
            workspaceName: workspace.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <RoleList catalog={catalog} canManage={canManage} />
    </div>
  );
}
