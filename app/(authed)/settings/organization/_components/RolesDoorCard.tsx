import Link from 'next/link';
import { ArrowRight, Shield } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';

// The Roles door in the one-workspace fold-in (Story MOTIR-6168 · MOTIR-6466;
// `design/workspaces/workspace-roles.mock.html` panel 4b). Below the reveal the
// workspace rail is not taught, and the Roles room — a list with a detail, an
// editor and a delete flow — cannot fold into one section, so the org page
// carries a DOOR to it. `/settings/workspace/roles` answers at every workspace
// count (the design's one reveal carve-out), so the door always lands.

export async function RolesDoorCard({ customRoleCount }: { customRoleCount: number }) {
  const t = await getTranslations('settings.rolesPage');
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="bg-(--el-role-admin) text-(--el-text-strong) flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control)"
          >
            <Shield className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h2>
            <p className="text-(--el-text-secondary) font-sans text-xs">
              {t('doorSummary', { custom: customRoleCount })}
            </p>
          </div>
        </div>
        <Link
          href="/settings/workspace/roles"
          className="text-(--el-link) inline-flex shrink-0 items-center gap-1 font-sans text-sm font-medium hover:underline"
        >
          {t('openRoles')}
          <ArrowRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Card>
  );
}
