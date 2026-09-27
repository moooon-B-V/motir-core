import { getTranslations } from 'next-intl/server';
import { FolderKanban } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoProjectCreateButton } from './NoProjectCreateButton';

// The no-project shell's home area (Story MOTIR-6169 · MOTIR-6548 ·
// `design/shell/no-project--limited.mock.html` S1 / S3). A reader lands here when
// their workspace has projects and they can ENTER none of them — a Limited member
// added to no project, or a Full member whose every project is Members only.
//
// ⚠️ THIS IS NOT THE CREATE-FIRST SCREEN MOTIR-4872 RETIRED. That one showed a
// Create door to everyone; this one shows it only to someone allowed to create a
// project they could then enter (`projectsService.canOfferCreateProject`), and
// otherwise says who can let them in. The top bar around it drops the work-item
// Create button and reads "No project" (S1), and the switcher opens empty (S2).

export interface NoProjectShellProps {
  workspaceName: string;
  canCreateProject: boolean;
}

export async function NoProjectShell({ workspaceName, canCreateProject }: NoProjectShellProps) {
  const t = await getTranslations('shell.noProject');
  return (
    <div className="mx-auto max-w-[48rem]" data-testid="no-project-shell">
      <EmptyState
        icon={<FolderKanban className="h-12 w-12" aria-hidden />}
        title={t('title')}
        description={t('body', { workspace: workspaceName })}
        action={canCreateProject ? <NoProjectCreateButton label={t('create')} /> : undefined}
      />
    </div>
  );
}
