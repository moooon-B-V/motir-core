'use client';

import { useTranslations } from 'next-intl';
import { Check, FileText, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

interface Props {
  /** The run's proposals, read from its Plan (MOTIR-1747) — not a `planDelta`. */
  proposals: PlanReviewItemDto[];
  onApprove: () => void;
  onDecline: () => void;
  approving: boolean;
}

export function ExpansionNudgeReview({ proposals, onApprove, onDecline, approving }: Props) {
  const t = useTranslations('ready');

  return (
    <div className="mt-3 space-y-2.5">
      <p className="text-xs font-medium text-(--el-text-secondary)">{t('nudge.reviewTitle')}</p>
      <ul className="space-y-1.5" role="list">
        {proposals.map((item) => (
          <li
            key={item.planItemId}
            className="flex items-center gap-2 text-sm text-(--el-text) pl-1"
            role="listitem"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-(--el-text-muted)" aria-hidden />
            <span className={`truncate ${item.op === 'remove' ? 'line-through' : ''}`}>
              {item.title}
            </span>
            {/* A run may propose more than children: an `expand` can also change
                or remove existing work (the Plan's own vocabulary, which the old
                delta had no op for). Approving persists ALL of it, so the row
                names the op rather than quietly showing only the additions. */}
            <span className="shrink-0 text-xs text-(--el-text-muted)">
              {item.op === 'add'
                ? item.kind
                : item.op === 'modify'
                  ? t('nudge.opChange')
                  : t('nudge.opRemove')}
            </span>
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
