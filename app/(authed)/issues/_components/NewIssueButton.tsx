'use client';

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { useCreateIssue } from '../../_components/CreateIssueProvider';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';

// The "New issue" affordance on the /issues route (Subtask 2.5.3). Reuses the
// shipped create-issue modal (2.3.3) via the shell-level CreateIssueProvider
// context — there is NO second create path. Used both in the page toolbar and
// the empty-state CTA. Hidden when there's no active project (the modal isn't
// mounted then), mirroring the top-nav CreateIssueButton.
export function NewIssueButton({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const t = useTranslations('issueViews');
  const ta = useTranslations('projectAccess');
  const { openCreateIssue, canCreate } = useCreateIssue();
  const { canEdit } = useProjectAccess();
  if (!canCreate) return null;

  // Read-only project: show the affordance disabled with a tooltip rather than
  // hiding it (6.4.6 role-affordance treatment). The disabled Button is wrapped
  // in a <span> so the Tooltip trigger still receives hover/focus (a disabled
  // <button> fires no pointer events).
  if (!canEdit) {
    return (
      <Tooltip content={ta('readOnlyHint')}>
        <span className="inline-flex">
          <Button variant="primary" size={size} leftIcon={<Plus className="h-4 w-4" />} disabled>
            {t('newIssue')}
          </Button>
        </span>
      </Tooltip>
    );
  }

  return (
    <Button
      variant="primary"
      size={size}
      leftIcon={<Plus className="h-4 w-4" />}
      onClick={openCreateIssue}
    >
      {t('newIssue')}
    </Button>
  );
}
