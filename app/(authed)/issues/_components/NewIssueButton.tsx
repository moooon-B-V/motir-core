'use client';

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useCreateIssue } from '../../_components/CreateIssueProvider';

// The "New issue" affordance on the /issues route (Subtask 2.5.3). Reuses the
// shipped create-issue modal (2.3.3) via the shell-level CreateIssueProvider
// context — there is NO second create path. Used both in the page toolbar and
// the empty-state CTA. Hidden when there's no active project (the modal isn't
// mounted then), mirroring the top-nav CreateIssueButton.
export function NewIssueButton({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const t = useTranslations('issueViews');
  const { openCreateIssue, canCreate } = useCreateIssue();
  if (!canCreate) return null;
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
