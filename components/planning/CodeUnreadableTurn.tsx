'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Info, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Bubble } from '@/components/planning/PlanChangeRail';

// THE OUTAGE FACE OF A PLANNING TURN (Story MOTIR-8136 · MOTIR-8141; design
// `design/code-context/planning-turn-code-unreadable.mock.html`, notes §17). When the
// code graph cannot be read, Motir says so on the turn itself — information register,
// never the rose failure treatment, because the turn did not break: it declined to
// write blind (plan-writing) or answered without confirming anything it could not read
// (questions). No sticky banner: each turn carries its own state, and an earlier outage
// turn keeps its notice after recovery.
//
// The words are the CATALOGUE's (`planningWorkspace.codeUnreadable.*`), drawn from the
// turn's stored face — never from its body — so they speak the viewer's locale.

const NS = 'planningWorkspace.codeUnreadable';

/** The information notice (the shipped `--el-notice-info-bg` treatment). */
function Notice({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-notice-info-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
    >
      <Info className="mt-px size-3.5 flex-none" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** A plan-writing turn that wrote nothing: the notice alone in the bubble, the marker
 *  line under it, and — on the latest such turn — Try again. */
export function CodeUnreadableDeclinedTurn({
  retry,
}: {
  /** Present only on the latest assistant turn; absent on an earlier one. */
  retry: { onRetry: () => void; disabled: boolean } | null;
}) {
  const t = useTranslations(NS);
  const tc = useTranslations('planningWorkspace.conversation');
  return (
    <div data-testid="plan-change-code-unreadable-declined" className="flex flex-col gap-2">
      <Bubble role="assistant">
        <Notice testId="plan-change-code-unreadable-notice">{t('planBody')}</Notice>
      </Bubble>
      <p
        className="text-center text-xs text-(--el-text-secondary)"
        data-testid="plan-change-code-unreadable-marker"
      >
        {t('planMarker')}
      </p>
      {retry ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw className="size-4" aria-hidden="true" />}
            onClick={retry.onRetry}
            disabled={retry.disabled}
            data-testid="plan-change-code-unreadable-retry"
          >
            {tc('retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The notice as the FIRST child of an answer's bubble, above the answer. */
export function CodeUnreadableAskNotice() {
  const t = useTranslations(NS);
  return (
    <div className="mb-2">
      <Notice testId="plan-change-code-unreadable-ask-notice">{t('askNotice')}</Notice>
    </div>
  );
}
