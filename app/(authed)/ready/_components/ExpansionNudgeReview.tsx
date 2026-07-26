'use client';

import { useTranslations } from 'next-intl';
import { Check, FileText, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { PlanDeltaCreateOp } from '@/lib/ai/planDelta';

interface Props {
  addedChildren: PlanDeltaCreateOp[];
  onApprove: () => void;
  onDecline: () => void;
  approving: boolean;
}

export function ExpansionNudgeReview({ addedChildren, onApprove, onDecline, approving }: Props) {
  const t = useTranslations('ready');

  return (
    <div className="mt-3 space-y-2.5">
      <p className="text-xs font-medium text-(--el-text-secondary)">{t('nudge.reviewTitle')}</p>
      <ul className="space-y-1.5" role="list">
        {addedChildren.map((child, i) => (
          <li
            key={i}
            className="flex items-center gap-2 text-sm text-(--el-text) pl-1"
            role="listitem"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-(--el-text-muted)" aria-hidden />
            <span className="truncate">{child.fields.title}</span>
            <span className="shrink-0 text-xs text-(--el-text-muted)">{child.kind}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Check className="h-3.5 w-3.5" />}
          onClick={onApprove}
          disabled={approving}
        >
          {approving ? t('nudge.approving') : t('nudge.approveLabel')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<X className="h-3.5 w-3.5" />}
          onClick={onDecline}
          disabled={approving}
        >
          {t('nudge.declineLabel')}
        </Button>
      </div>
    </div>
  );
}
