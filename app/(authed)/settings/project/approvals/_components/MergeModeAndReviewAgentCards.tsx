'use client';

import { useState } from 'react';
import type { PrMergeModeValue } from '@/lib/dto/projects';
import { PrMergeModeCard } from './PrMergeModeCard';
import { ReviewAgentCard } from './ReviewAgentCard';

// The two Approvals cards that EXCLUDE each other (`docs/decisions/approval-gates.md`
// §12.2a · MOTIR-6823): the review agent and *Merge automatically* cannot both be
// on. Each card still owns its own optimistic value; this island only MIRRORS the
// value each one shows, so choosing a mode re-renders the review-agent card and
// flipping the switch re-renders the merge-mode card — without a reload (the
// page-state contract, case 3: `router.refresh()` could not reach either island).

export interface MergeModeAndReviewAgentCardsProps {
  projectKey: string;
  initialPrMergeMode: PrMergeModeValue;
  initialReviewAgentEnabled: boolean;
}

export function MergeModeAndReviewAgentCards({
  projectKey,
  initialPrMergeMode,
  initialReviewAgentEnabled,
}: MergeModeAndReviewAgentCardsProps) {
  const [prMergeMode, setPrMergeMode] = useState(initialPrMergeMode);
  const [reviewAgentEnabled, setReviewAgentEnabled] = useState(initialReviewAgentEnabled);

  return (
    <>
      <PrMergeModeCard
        projectKey={projectKey}
        initialMode={initialPrMergeMode}
        reviewAgentEnabled={reviewAgentEnabled}
        onModeChange={setPrMergeMode}
      />
      <ReviewAgentCard
        projectKey={projectKey}
        initialEnabled={initialReviewAgentEnabled}
        prMergeMode={prMergeMode}
        onEnabledChange={setReviewAgentEnabled}
      />
    </>
  );
}
