import { Sparkles } from 'lucide-react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Pill } from '@/components/ui/Pill';
import type { WorkItemExplanationSourceDto } from '@/lib/dto/workItems';
import { ContentSectionCard } from './ContentSectionCard';

// The issue's "why this matters" axis (Story 1.4's `explanationMd`), rendered
// beneath the description as a sibling content card (Subtask 2.4.2, per
// `design/work-items/detail.png`). When the provenance is `ai_draft` it carries
// an "AI-drafted" badge. The section is ALWAYS present (with an empty state when
// blank) so the explanation is a visible, first-class part of the issue.
// Authoring/regenerating the prose is the create/edit forms' job; editing here
// routes to the edit form via the card's "Edit" link.

export interface IssueExplanationProps {
  explanationMd: string | null;
  explanationSource: WorkItemExplanationSourceDto;
  /** The issue's edit route, for the section's "Edit" link. */
  editHref: string;
}

export function IssueExplanation({
  explanationMd,
  explanationSource,
  editHref,
}: IssueExplanationProps) {
  return (
    <ContentSectionCard
      title="Explanation"
      subtitle="why it matters"
      editHref={editHref}
      headerExtra={
        explanationSource === 'ai_draft' ? (
          <Pill tone="neutral">
            <Sparkles className="h-3 w-3" aria-hidden />
            AI-drafted
          </Pill>
        ) : null
      }
    >
      {explanationMd ? (
        <MarkdownView value={explanationMd} aria-label="Issue explanation" />
      ) : (
        <p className="font-sans text-sm text-(--color-slate) italic">No explanation yet.</p>
      )}
    </ContentSectionCard>
  );
}
