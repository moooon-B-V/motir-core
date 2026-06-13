import { getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';

// The "Workspace configuration" fold-in card (design/org-admin panel 2) — shown
// ONLY at one workspace (progressive disclosure, 6.10.2 §6d). Workspace-scoped
// config (workflows, fields, labels, components, automation, dashboards) lives
// on the Workspace row underneath — there is NO org→workspace config
// inheritance. At one workspace it's managed in the (single) workspace settings;
// add a second and these sections split into a per-workspace area. This card is
// an explanatory note that links to that surface — the config editors are owned
// by their own design areas and are not redrawn here.
export async function WorkspaceConfigCard({ workspaceCount }: { workspaceCount: number }) {
  const t = await getTranslations('orgAdmin');
  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('settings.workspaceConfig')}
            </h2>
            <p className="text-(--el-text-muted) font-sans text-sm">
              {t('settings.workspaceConfigSub')}
            </p>
          </div>
          <Pill orgRole="member" className="shrink-0">
            {t('settings.workspaceConfigBadge', { count: workspaceCount })}
          </Pill>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="border-(--el-border) flex items-start gap-3 rounded-(--radius-card) border border-dashed bg-(--el-surface-soft) px-4 py-3">
          <Info className="text-(--el-text-muted) mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="text-(--el-text-secondary) font-sans text-sm">
            {t('settings.workspaceConfigNote')}
          </p>
        </div>
        <div>
          <a
            href="/settings/workspace"
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            {t('settings.openWorkspaceSettings')}
          </a>
        </div>
      </div>
    </Card>
  );
}
