import type * as React from 'react';
import { getTranslations } from 'next-intl/server';
import { ContentSectionCard } from './ContentSectionCard';
import { AcceptancePanel } from './AcceptancePanel';
import { DesignResultPanel } from './DesignResultPanel';
import { AttachmentsPanel } from './AttachmentsPanel';
import { ActivitySection } from './ActivitySection';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import {
  DevelopmentLinkProvider,
  LinkPullRequestDoor,
  LinkPullRequestForm,
} from './DevelopmentLinkControl';
import type { LateReads } from './lateReads';

// The item page's LATE STACK (Subtask MOTIR-3436), allocated by
// `design/work-items/design-notes.md` § *The item page at ARRIVAL, and while it
// STREAMS* — the tier table's third tier: Development, Acceptance, Design
// result, Attachments and Activity.
//
// ── ONE SETTLE, DELIVERED BY TWO BOUNDARIES ────────────────────────────────
// The design decides the page settles TWICE — once when the first content
// replaces the frame, once when the late stack fills — and therefore that the
// five late sections share ONE boundary rather than one each. Five independent
// boundaries would let the page arrive five times in whatever order the reads
// finish, and a reader watching blocks pop in at random reads instability, not
// speed.
//
// ⚠️ "ONE settle" is about TIME, not about JSX elements, and on this page it
// cannot be one element: `ChildPanel` is TIER TWO (it renders from the
// already-read `detail.children`) and the shipped page puts it BETWEEN Design
// result and Attachments. Wrapping it would make first-tier content late;
// moving it would reorder a page no card in this story is authorised to
// reorder. So the stack is two `<Suspense>` boundaries around a tier-2 section
// — both awaiting THE SAME `lateReads` promise, so they resolve in the same
// tick and flush together. The reader sees one settle; React sees two
// boundaries. (`MOTIR-3465` corrects the asset, whose settled frame drew
// Children second and so made a single contiguous span look possible.)
//
// ── WHAT DID NOT MOVE, AND WHY ─────────────────────────────────────────────
// The ROLL-UP BADGE stays server-resolved in the page's tier-2 group. The tier
// table calls it "late, IN PLACE" — a slot reserved at the settled width and
// filled where it stands — and `ParentRollupBadge` does ship a lazy path
// (`initialTotal: undefined` → a client fetch). But that path renders NOTHING
// while pending, so the slot is not reserved and its neighbours shift when it
// fills, which is the one thing the design's in-place rule forbids. The page's
// concurrent group already has the figure at no marginal cost, so "late in
// place" is satisfied more cheaply by not being late at all. Reserving the slot
// properly is a change to that component's markup, which this card's boundary
// excludes.
//
// ── ERROR CONTAINMENT IS UNCHANGED ─────────────────────────────────────────
// The reads that were wrapped in `try/catch` still are — in `lateReads.ts`,
// where they resolve to `null` and the section renders its own ErrorState +
// retry. A boundary must not convert a caught failure into a thrown one, and
// there is deliberately no `error.tsx`: a section-level empty/error state is
// what the design specifies, and a route-level error page would replace the
// whole item with a failure the reader cannot act on.

/** One pulsing placeholder block. Fill + radius through tokens only. */
function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}

/**
 * A pending section card — the real `ContentSectionCard` chrome with its body on
 * pulse blocks, which is what the tier table names for Development, Acceptance
 * and Design result. Attachments and Activity name their own already-drawn
 * skeletons (tile-shaped and comment-row-shaped); those live with their panels
 * and are cited by the asset rather than redrawn, so the fallback here holds
 * only the CARD, and each panel draws its own body once it arrives.
 */
export function SectionCardSkeleton({ rows = 2 }: { rows?: number }) {
  const widths = ['w-2/3', 'w-1/2', 'w-3/4', 'w-1/3'];
  return (
    <div
      className="rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding) shadow-(--shadow-card)"
      data-surface="card"
      aria-busy="true"
    >
      <div className="mb-(--spacing-md)" aria-hidden="true">
        <Block className="h-5 w-36" />
      </div>
      <div className="flex animate-pulse flex-col gap-2" aria-hidden="true">
        {widths.slice(0, rows).map((w) => (
          <Block key={w} className={`h-3 ${w}`} />
        ))}
      </div>
    </div>
  );
}

/** The fallback for the UPPER half — Development, Acceptance, Design result. */
export function LateUpperFallback() {
  return (
    <>
      <SectionCardSkeleton rows={3} />
      <SectionCardSkeleton rows={2} />
    </>
  );
}

/** The fallback for the LOWER half — Attachments, Activity. */
export function LateLowerFallback() {
  return (
    <>
      <SectionCardSkeleton rows={2} />
      <SectionCardSkeleton rows={4} />
    </>
  );
}

interface LateProps {
  reads: Promise<LateReads>;
  itemId: string;
  itemIdentifier: string;
  canEdit: boolean;
  /** Read in the page's TIER-TWO group — the rail's Repositories card needs it
   *  too, so it is read once there and passed down rather than read twice. */
  repoDelivery: React.ComponentProps<typeof DevelopmentSectionBody>['repoDelivery'];
}

/**
 * Development · Acceptance · Design result — the late sections that sit ABOVE
 * `ChildPanel` in the page's order.
 */
export async function LateUpperSections({
  reads,
  itemId,
  itemIdentifier,
  canEdit,
  repoDelivery,
}: LateProps) {
  const r = await reads;
  const [tGithub, tAcceptance, tDesignResult] = await Promise.all([
    getTranslations('github'),
    getTranslations('acceptance'),
    getTranslations('designResult'),
  ]);
  const showDesignResult = r.designEvidence !== null || r.isDesignCard;
  return (
    <>
      <DevelopmentLinkProvider currentItemId={itemId} identifier={itemIdentifier}>
        <ContentSectionCard
          title={tGithub('development.title')}
          subtitle={tGithub('development.gloss')}
          headerRight={canEdit ? <LinkPullRequestDoor /> : undefined}
        >
          {canEdit ? <LinkPullRequestForm /> : null}
          <DevelopmentSectionBody
            pullRequests={r.pullRequests}
            itemIdentifier={itemIdentifier}
            manualLinkable={canEdit}
            // The item's repository set, VERBATIM (Story MOTIR-2725 ·
            // MOTIR-2415) — which rows it earns is the section's derivation,
            // not this page's. Pre-filtering here is what let this page and the
            // quick view disagree (MOTIR-3036).
            repoDelivery={repoDelivery}
          />
        </ContentSectionCard>
      </DevelopmentLinkProvider>
      {r.acceptanceEligibility ? (
        <ContentSectionCard title={tAcceptance('title')} subtitle={tAcceptance('gloss')}>
          <AcceptancePanel
            workItemId={itemId}
            organizationId={r.acceptanceEligibility.organizationId}
            eligibility={r.acceptanceEligibility}
            initialEvidence={r.acceptanceEvidence}
            canDecide={r.canDecideAcceptance}
            settingsHref="/settings/organization"
          />
        </ContentSectionCard>
      ) : null}
      {showDesignResult ? (
        <ContentSectionCard title={tDesignResult('title')} subtitle={tDesignResult('gloss')}>
          <DesignResultPanel evidence={r.designEvidence} isDesignCard={r.isDesignCard} />
        </ContentSectionCard>
      ) : null}
    </>
  );
}

/**
 * Attachments · Activity — the late sections BELOW `ChildPanel`. Awaits the same
 * promise as the upper half, so the two flush together and the reader sees one
 * settle.
 */
export async function LateLowerSections({
  reads,
  itemId,
  currentUserId,
  currentUserName,
  workflowStatuses,
  mentionCandidates,
  activityTab,
}: {
  reads: Promise<LateReads>;
  itemId: string;
  currentUserId: string;
  currentUserName: string;
  workflowStatuses: React.ComponentProps<typeof ActivitySection>['workflowStatuses'];
  mentionCandidates: { id: string; name: string; email: string }[];
  activityTab: 'comments' | 'history' | 'all';
}) {
  const r = await reads;
  return (
    <>
      <AttachmentsPanel
        workItemId={itemId}
        canCreate={r.attachmentCaps.canCreate}
        canDeleteAll={r.attachmentCaps.canDeleteAll}
        currentUserId={currentUserId}
        initialPage={r.initialAttachments}
      />
      <ActivitySection
        workItemId={itemId}
        tab={activityTab}
        workflowStatuses={workflowStatuses}
        comments={{
          canComment: r.commentCaps.canComment,
          canModerate: r.commentCaps.canModerate,
          currentUserId,
          currentUserName,
          mentionCandidates,
        }}
        initialComments={r.initialComments}
        initialHistory={r.initialHistory}
        initialAll={r.initialAll}
      />
    </>
  );
}
