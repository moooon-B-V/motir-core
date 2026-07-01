'use client';

import type { ReactNode } from 'react';
import { Archive } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { RelationshipPeekLink } from '@/app/(authed)/items/[key]/_components/RelationshipPeekLink';
import type { IssueType } from '@/lib/issues/parentRules';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemRefSummaryDto } from '@/lib/dto/workItems';

// The LIVE internal-link chip (Story 5.8 · Subtask 5.8.6), per
// design/work-items/internal-links.mock.html (panels 1–2). A reference to
// another work item — a `[KEY](motir:<id>)` token in a description / explanation
// / comment body — renders inline as a SINGLE interactive chip showing the
// target's CURRENT type-hue icon · mono key · title · status dot. The render
// layer (lib/markdown/render.tsx) hands the resolved summary in; this component
// is purely presentational over it. Click opens the shared quick-view PEEK by
// REUSING the relationships-panel's `RelationshipPeekLink` (a plain primary
// click → `?peek=<id>`; ⌘/ctrl/middle still open the full page) — so a reference
// is a glance, not a context switch, exactly like a relationship row.
//
// A reference NEVER breaks the body (the design invariant): the state pairs a
// shape/icon cue with the hue (not colour alone), and the deleted / no-access
// states are non-interactive spans that keep only the bare key:
//   · archived → muted, dashed border + archive glyph, still navigable;
//   · deleted (summary absent) → strikethrough, bare authored key, NOT clickable;
//   · no view access (`accessible:false`) → dashed bare key, no title/status leak.
// Colour flows through --el-* only; shape through the element-semantic tokens —
// all styled as `.wi-chip` (+ state classes) in markdown-editor.css, the same
// `.motir-prose`-scoped sheet the sibling `.mention-chip` lives in.

const DOT_CLASS: Record<StatusCategoryDto, string> = {
  todo: 'wi-dot s-todo',
  in_progress: 'wi-dot s-inprogress',
  done: 'wi-dot s-done',
};

export function WorkItemRefChip({
  summary,
  fallbackLabel,
}: {
  /** The resolved summary for this id, or undefined when the id resolves to
   *  nothing (deleted / cross-workspace) — rendered as a struck-through key. */
  summary: WorkItemRefSummaryDto | undefined;
  /** The token's authored bracket label (the key the author typed) — the bare
   *  key shown for the deleted / no-access states (no current data to show). */
  fallbackLabel: ReactNode;
}) {
  const t = useTranslations('issueViews');

  // Deleted / cross-workspace — the id resolved to nothing.
  if (!summary) {
    return (
      <span className="wi-chip is-deleted" title={t('refDeletedTitle')}>
        <span className="wi-key">{fallbackLabel}</span>
      </span>
    );
  }

  // No view access — bare key only (no title / status leak).
  if (summary.accessible === false) {
    return (
      <span className="wi-chip is-noaccess" title={t('refNoAccessTitle')}>
        <span className="wi-key">{fallbackLabel}</span>
      </span>
    );
  }

  const { identifier, title, kind, archived, status } = summary;

  // Archived — muted, dashed border + archive glyph, still navigable (the peek
  // shows the archived record).
  if (archived) {
    return (
      <RelationshipPeekLink identifier={identifier} className="wi-chip is-archived max-w-full">
        <span className="wi-archive-glyph" aria-hidden>
          <Archive />
        </span>
        <span className="wi-key">{identifier}</span>
        <span className="wi-title min-w-0 truncate">{title}</span>
      </RelationshipPeekLink>
    );
  }

  // Live — the full chip (type icon · key · title · status dot).
  return (
    <RelationshipPeekLink identifier={identifier} className="wi-chip max-w-full">
      <IssueTypeIcon type={kind as IssueType} className="wi-type-icon shrink-0" />
      <span className="wi-key">{identifier}</span>
      <span className="wi-title min-w-0 truncate">{title}</span>
      {status ? <span className={DOT_CLASS[status.category]} aria-hidden /> : null}
    </RelationshipPeekLink>
  );
}
