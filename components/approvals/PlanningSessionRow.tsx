'use client';

import { Children, type ReactNode } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Pill } from '@/components/ui/Pill';
import { planSentenceOf } from '@/lib/planning/planSentence';
import { useOpenPlanOverlay } from '@/lib/hooks/useOpenPlanOverlay';
import { usePeekRowClick } from '@/app/(authed)/items/_components/IssueQuickView';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { PlanningSessionSubjectSummaryDTO } from '@/lib/dto/approvalGate';
import type { ApprovalRowRecord } from './ApprovalRow';
import { useRelativeLabel } from './useRelativeLabel';

// THE PLANNING SESSION THAT NEEDS YOU, as a Waiting on you row (Story MOTIR-7905 ·
// MOTIR-7917; design `design/workbench/design-notes.md` § 37.1, mock
// `workbench--planning-session-needs-you.mock.html` Panels 1–4).
//
// ⚠️ ONE GATE KIND, TWO CAUSES, ONE ANATOMY. Line 1 is § 29's plan leading line —
// `planSentenceOf`, never re-worded — with the kind chip and *since {when}*. Line 2 is the
// cause's lead: the planner's QUESTION (one truncated line, the full text in `title`), or
// *waiting on your reply* plus the planner's last line.
//
// ⚠️ NO DECIDE BUTTONS. The decision IS the next turn in the conversation, so the row has
// no verb, and the approval overlay is SKIPPED for this kind: its door is the planning
// overlay, through the ONE plan-overlay door (`useOpenPlanOverlay`, MOTIR-7884) with
// `planVia=approvals` so the reopened line reads *Reopened from Waiting on you*.
//
// ⚠️ THE ROW SUPPLIES `known`, so the door makes no fetch: a session that waits is, by
// definition, a `generating` plan's (or a not-yet-planned session's) conversation. A
// question before the first proposal has no plan; the door is then handed the session id
// as its key — only its fallback page would read it, and a member always has the overlay.

export function PlanningSessionRow({
  record,
  subject,
  gridTemplate,
  arrived,
}: {
  record: ApprovalRowRecord;
  subject: PlanningSessionSubjectSummaryDTO;
  gridTemplate: string;
  arrived: boolean;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('workbench.approvals');
  const tRow = useTranslations('approvalGate.planningSession.row');
  const tPlan = useTranslations('approvalGate.planApproval.row');
  const locale = useLocale();
  const relativeLabel = useRelativeLabel();
  const peekRowClick = usePeekRowClick();
  const { row } = record;

  const targets = subject.targetKey ? [{ key: subject.targetKey, title: subject.targetTitle }] : [];
  const sentence = planSentenceOf({
    targets,
    title: subject.planTitle,
    projectName: subject.projectName,
  });
  const sentenceText = tPlan.markup(sentence.form, {
    name: sentence.name,
    project: sentence.name,
    title: (chunks: string) => chunks,
  });

  const door = useOpenPlanOverlay(
    subject.planId ?? subject.sessionId,
    { planStatus: 'generating', sessionId: subject.sessionId, anchorKey: subject.targetKey },
    { via: 'approvals' },
  );

  const parts: ReactNode = tPlan.rich(sentence.form, {
    name: sentence.name,
    project: sentence.name,
    title: (chunks) =>
      sentence.form === 'targeted' ? (
        // THE TITLE IS THE TARGET'S QUICK-VIEW DOOR, above the stretched row door.
        <Link
          key="title"
          href={routes.item(sentence.key)}
          onClick={(e) => peekRowClick(e, sentence.key)}
          className="relative z-10 min-w-0 truncate font-medium text-(--el-text) hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {chunks}
        </Link>
      ) : (
        <span key="title" className="min-w-0 truncate font-medium text-(--el-text)">
          {chunks}
        </span>
      ),
  });

  const asked = subject.cause === 'question';
  const lead = asked ? tRow('asked') : tRow('waitReply');
  const body = asked ? subject.question : subject.plannerLine;

  return (
    <div
      role="row"
      data-testid={`approval-row-${row.gateId}`}
      data-planning-session={subject.sessionId}
      className={cn(
        'group relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0',
        'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
        'md:pt-0 md:pr-4 md:pb-2.5 md:pl-4',
      )}
    >
      <div
        role="presentation"
        className="flex flex-col gap-1 md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div role="cell" className="flex min-w-0 items-center gap-2">
          {/* THE DOOR: the hook's own `href`, so a modified click opens the overlay's full
              address in a new tab; a plain click opens it in place. */}
          <Link
            href={door.href}
            aria-haspopup="dialog"
            aria-label={tRow('open', { sentence: sentenceText })}
            onClick={door.open}
            className="absolute inset-0 z-0 focus:outline-none"
          />
          <Sparkles className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
          <span className="flex min-w-0 items-center gap-1 text-sm">
            {Children.toArray(parts).map((part, index) =>
              typeof part === 'string' ? (
                part.trim() === '' ? null : (
                  <span key={`frame-${index}`} className="shrink-0 text-(--el-text-secondary)">
                    {part}
                  </span>
                )
              ) : (
                part
              ),
            )}
          </span>
          {subject.targetKey ? (
            <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
              {subject.targetKey}
            </span>
          ) : null}
          {arrived ? <Pill tone="neutral">{t('live.new')}</Pill> : null}
        </div>
        <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
          <div role="cell" className="flex min-w-0 items-center">
            <Pill tone="neutral">{tRow('kind')}</Pill>
          </div>
          <div role="cell" className="flex min-w-0 items-center">
            <span
              className="truncate text-xs text-(--el-text-secondary)"
              title={new Date(subject.since).toLocaleString(locale)}
            >
              {tRow('since', { when: relativeLabel(subject.since) })}
            </span>
          </div>
          <div role="cell" aria-hidden className="hidden md:block" />
        </div>
      </div>
      {/* LINE 2 — THE CAUSE'S LEAD (§ 37.1). One truncated line; the full text is on hover
          and, fully, in the overlay the row opens. */}
      <div role="cell" className="flex min-w-0 items-baseline gap-1.5 pl-6 text-xs">
        <span className="shrink-0 font-medium text-(--el-text)">{lead}</span>
        {body ? (
          <span className="min-w-0 truncate text-(--el-text-secondary)" title={body}>
            {body}
          </span>
        ) : null}
      </div>
    </div>
  );
}
