'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { leaveWorkspaceAction } from '../actions';

export interface DangerZoneCardProps {
  isLastMember: boolean;
  /**
   * `manageWorkspaces` on the workspace's org — an Owner or Admin. It decides
   * two things, both POINTERS rather than doors: the one-line hint saying where
   * removing the workspace went, and which wording the last-member tooltip uses.
   */
  canRemoveWorkspace: boolean;
  /** Where the card is mounted: `/settings/workspace`, or the org page's
   *  one-workspace fold-in — the hint names a different place from each. */
  placement: 'workspace' | 'foldIn';
}

// The WORKSPACE-tier danger zone after the move (MOTIR-6312 ·
// `design/org-admin/org-admin--workspaces-at-org-tier.mock.html` panel 2).
//
// ⚠️ LEAVE STAYS; DELETE IS GONE. Removing a workspace is an org-Admin act now
// (MOTIR-6309), and its only door is the org settings page's Workspaces card.
// This one component is mounted by BOTH `/settings/workspace` and the org page's
// one-workspace fold-in (`WorkspaceFoldInSection`), so the one edit removes the
// row from both. Whoever remembers Delete here is told where it went — a
// pointer, never a second Remove button — and a Member, who cannot remove at
// all, is told nothing.
export function DangerZoneCard({
  isLastMember,
  canRemoveWorkspace,
  placement,
}: DangerZoneCardProps) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  function handleLeave() {
    startTransition(async () => {
      // On success the action redirects, so control only returns here on
      // the last-member error path.
      const result = await leaveWorkspaceAction();
      if (!result.ok) {
        toast({ variant: 'error', title: t('danger.cantLeaveTitle'), description: result.error });
      }
    });
  }

  const leaveButton = (
    <Button variant="danger" onClick={handleLeave} loading={isPending} disabled={isLastMember}>
      {t('danger.leave')}
    </Button>
  );

  return (
    <Card
      className="border-2 border-(--el-danger)"
      header={
        <h2 className="font-sans text-base font-semibold" style={{ color: 'var(--el-danger)' }}>
          {t('danger.heading')}
        </h2>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-sans text-sm font-medium text-(--el-text)">
            {t('danger.leaveWorkspace')}
          </p>
          <p className="text-(--el-text-muted) font-sans text-xs">
            {t('danger.leaveWorkspaceDesc')}
          </p>
        </div>
        {isLastMember ? (
          <Tooltip
            content={
              canRemoveWorkspace
                ? t('danger.lastMemberTooltipAdmin')
                : t('danger.lastMemberTooltip')
            }
          >
            {/* span wrapper: a disabled button doesn't fire the hover events Radix Tooltip needs. */}
            <span tabIndex={0}>{leaveButton}</span>
          </Tooltip>
        ) : (
          leaveButton
        )}
      </div>

      {canRemoveWorkspace ? (
        <p
          className="text-(--el-text-secondary) mt-(--spacing-md) flex items-center gap-2 font-sans text-xs"
          data-testid="workspace-remove-hint"
        >
          <Info className="text-(--el-icon-muted) h-3.5 w-3.5 shrink-0" aria-hidden />
          {placement === 'foldIn' ? (
            t('danger.removeHintFoldIn')
          ) : (
            <Link href="/settings/organization" className="text-(--el-link) hover:underline">
              {t('danger.removeHint')}
            </Link>
          )}
        </p>
      ) : null}
    </Card>
  );
}
