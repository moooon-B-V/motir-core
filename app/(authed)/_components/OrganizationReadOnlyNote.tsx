import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { organizationDeletionService } from '@/lib/services/organizationDeletionService';

// The one quiet header note a closing organization adds to a page (Story
// MOTIR-6306 · MOTIR-6403, design MOTIR-6390 panel 6): "Read-only while {org}
// closes", where the page's primary action normally sits.
//
// Nothing else on the page changes: every actor in a closing org resolves to
// read permissions (MOTIR-6396), so each surface's own permission gate already
// removes its edit controls — hidden, not disabled (MOTIR-2462). The closing bar
// above carries the explanation; this note only says why the actions are gone.
// Renders `null` for an open organization.

export async function OrganizationReadOnlyNote({ workspaceId }: { workspaceId: string }) {
  const orgName = await organizationDeletionService.getClosingOrganizationName(workspaceId);
  if (!orgName) return null;
  const t = await getTranslations('orgClosing');
  return (
    <span
      data-testid="organization-read-only-note"
      className="inline-flex items-center gap-1.5 font-sans text-sm text-(--el-text-secondary)"
    >
      <Lock aria-hidden className="h-4 w-4" />
      {t('readOnlyNote', { org: orgName })}
    </span>
  );
}
