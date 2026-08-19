'use client';

import { useTranslations } from 'next-intl';
import { Bot, User } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { QuickViewCloseButton } from '@/app/(authed)/items/_components/QuickViewCloseButton';
import {
  QuickViewBody,
  QuickViewHeader,
  QuickViewMain,
  QuickViewRail,
  QuickViewRailField,
  QuickViewSectionLabel,
} from '@/components/workItems/QuickViewSurface';
import type { IssueType } from '@/lib/issues/parentRules';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// READ a proposal (MOTIR-3084, per MOTIR-3082's design Part V §3).
//
// Viewing a proposal is viewing a card: the same `Modal size="xl"` peek shell a
// work item gets, composed from the SAME chrome (`QuickViewSurface`), with
// editing absent rather than merely disabled — the proposal edit modal is
// removed, and a proposal is changed by re-planning.
//
// ⚠️ The ONE place this must not copy the work-item peek. That peek ends with a
// deliberate deferral — *"Explanation, child items, … live on the full page"* —
// which is right for a work item and IMPOSSIBLE for a proposal: there is no
// per-item route, so there is no page to defer to. Deferring to a thing that
// does not exist is precisely how `explanationMd` came to be carried, diffed and
// materialized while nothing in the review surface ever read it. So both bodies
// render INLINE here, as two sibling sections.
//
// The head differs from the work-item peek only where the model has nothing to
// put: no identifier and no status pill (a proposal has neither until it
// materializes), and no "Open full page →".

const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);

function toKind(raw: string): IssueType {
  return KNOWN_KINDS.has(raw as IssueType) ? (raw as IssueType) : 'task';
}

export function ProposalQuickView({
  item,
  onClose,
}: {
  /** The proposal to read, or null when the peek is closed. */
  item: PlanReviewItemDto | null;
  onClose: () => void;
}) {
  const t = useTranslations('planReview');
  if (!item) return null;

  const kind = toKind(item.kind);
  const ExecutorGlyph = item.executor === 'human' ? User : Bot;
  const hasRail =
    item.type != null ||
    item.priority != null ||
    item.storyPoints != null ||
    item.estimateMinutes != null ||
    item.targetRepo != null ||
    item.targetRepoRole != null ||
    item.executor != null ||
    item.parentIdentifier != null;

  return (
    <Modal
      open
      onOpenChange={(next) => (next ? undefined : onClose())}
      srTitle={item.title}
      size="xl"
    >
      <div className="flex h-[min(82vh,680px)] flex-col" data-testid="proposal-quick-view">
        <QuickViewHeader>
          <IssueTypeIcon type={kind} className="h-[18px] w-[18px] shrink-0" />
          {/* No identifier and no status: a proposal has neither until approve
              materializes it. The node shows the same `new`. */}
          <span className="font-mono text-xs text-(--el-text-secondary)">{t('newItem')}</span>
          <span className="text-xs text-(--el-text-muted)">{t('notYetCreated')}</span>
          <span className="flex-1" />
          {/* No "Open full page" — there is no page for a proposal — and no edit
              affordance anywhere on this surface. */}
          <QuickViewCloseButton variant="icon" onClose={onClose} />
        </QuickViewHeader>

        <QuickViewBody railed={hasRail}>
          <QuickViewMain>
            <h2 className="font-serif text-[27px] leading-tight font-semibold text-(--el-text)">
              {item.title}
            </h2>

            <QuickViewSectionLabel>{t('sectionDescription')}</QuickViewSectionLabel>
            {item.descriptionMd ? (
              <MarkdownView value={item.descriptionMd} aria-label={t('descriptionAria')} />
            ) : (
              <p className="text-sm text-(--el-text-secondary) italic">{t('noDescription')}</p>
            )}

            {/* The WHY — the body the review surface used to drop entirely. */}
            <QuickViewSectionLabel>
              {t('sectionExplanation')}
              {item.explanationSource === 'ai_drafted' ? (
                <span className="ml-2 rounded-(--radius-badge) bg-(--el-tint-lavender) px-1.5 py-0.5 text-[10px] font-semibold text-(--el-accent-on-surface) normal-case">
                  {t('aiDrafted')}
                </span>
              ) : null}
            </QuickViewSectionLabel>
            {item.explanationMd ? (
              <MarkdownView value={item.explanationMd} aria-label={t('explanationAria')} />
            ) : (
              <p className="text-sm text-(--el-text-secondary) italic">{t('noExplanation')}</p>
            )}
          </QuickViewMain>

          {hasRail ? (
            <QuickViewRail>
              {item.type ? (
                <QuickViewRailField label={t('railType')}>{item.type}</QuickViewRailField>
              ) : null}
              {item.priority ? (
                <QuickViewRailField label={t('railPriority')}>{item.priority}</QuickViewRailField>
              ) : null}
              {item.storyPoints != null ? (
                <QuickViewRailField label={t('railPoints')}>{item.storyPoints}</QuickViewRailField>
              ) : null}
              {item.estimateMinutes != null ? (
                <QuickViewRailField label={t('railEstimate')}>
                  {t('minutes', { n: item.estimateMinutes })}
                </QuickViewRailField>
              ) : null}
              {/* The repo pin: what routes dispatch, and what was invisible at the
                  one moment a person could still correct it. The ROLE stands in
                  when no name is pinned yet (a plan may name repos before they
                  exist). */}
              {item.targetRepo || item.targetRepoRole ? (
                <QuickViewRailField label={t('railRepository')}>
                  <span className="truncate font-mono text-[13px]">
                    {item.targetRepo ?? item.targetRepoRole}
                  </span>
                </QuickViewRailField>
              ) : null}
              {item.executor ? (
                <QuickViewRailField label={t('railExecutor')}>
                  <ExecutorGlyph className="size-3.5 shrink-0" aria-hidden />
                  {item.executor === 'human' ? t('executorHuman') : t('executorAgent')}
                </QuickViewRailField>
              ) : null}
              {/* Where approval will put it — the same fact the breadcrumb carries
                  on the canvas (MOTIR-3083), repeated here because the peek can be
                  opened from a search result without the level in view. */}
              {item.parentIdentifier ? (
                <QuickViewRailField label={t('railParent')}>
                  <span className="truncate font-mono text-[13px]">{item.parentIdentifier}</span>
                </QuickViewRailField>
              ) : null}
            </QuickViewRail>
          ) : null}
        </QuickViewBody>
      </div>
    </Modal>
  );
}
