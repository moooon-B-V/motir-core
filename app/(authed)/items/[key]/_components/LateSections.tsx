import type * as React from 'react';
import { getTranslations } from 'next-intl/server';
import { ContentSectionCard } from './ContentSectionCard';
import { AcceptancePanel } from './AcceptancePanel';
import { DesignResultSection } from './DesignResultSection';
import { DecidedGateStatusBridge } from './DecidedGateStatusBridge';
import {
  approveAndMergeAction,
  decideApprovalGateAction,
  queueAgainAutoAction,
  retryApproveAndMergeMemberAction,
} from '../approvalGateActions';
import { AttachmentsPanel } from './AttachmentsPanel';
import { ActivitySection } from './ActivitySection';
import { DevelopmentSectionBody, hasOpenPullRequest } from '@/components/github/DevelopmentSection';
import { AcceptanceDevelopmentSlot } from '@/components/acceptance/AcceptanceDevelopmentSlot';
import type { DevelopmentGateRead } from '@/components/github/DevelopmentGateFrame';
import { DesignResultPanel } from './DesignResultPanel';
import { RunSection } from './RunSection';
import { formatRunTimes } from './runTimes';
import { formatRunInstant } from '@/lib/runs/runClock';
import {
  DevelopmentLinkProvider,
  LinkPullRequestDoor,
  LinkPullRequestForm,
  RemovePullRequestLinkButton,
} from './DevelopmentLinkControl';
import { HowToTestWriteProvider } from '@/components/howToTest/HowToTestWrite';
import {
  loadHowToTestDraftAction,
  saveHowToTestAction,
  unlinkMonitorIssueAction,
} from '../actions';
import { MonitorErrorsCard } from './MonitorErrorsCard';
import { RUN_HISTORY_PAGE, type LateReads } from './lateReads';

// The item page's LATE STACK (Subtask MOTIR-3436), allocated by
// `design/work-items/design-notes.md` § *The item page at ARRIVAL, and while it
// STREAMS* — the tier table's third tier: Run, Development, Acceptance, Design
// result, Attachments and Activity.
//
// ⚠️ RUN SITS ABOVE DEVELOPMENT, and the order is CAUSAL rather than merely
// adjacent (Yue, 2026-08-29; `design/runs/design-notes.md` § Placement). The run
// is what PRODUCES the pull request, so a reader meets *an agent worked this
// card* and then *and here is what it shipped* — the order the events happened
// in, and the order the run's own timeline ends in, since *pull request linked*
// is its second-to-last step. Reversed, the page shows the artefact above the
// act that made it.
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

/**
 * ⚠️ WHICH GATE THE DEVELOPMENT FRAME IS A PORT FOR (MOTIR-5667, MOTIR-5678). A PRIMARY
 * question that is still open — the DESIGN (AMENDMENT 6 Q1) or the DECISION (§8's FIFTH
 * AMENDMENT, clause 5) — leads, so the press addresses it and ONE press answers both
 * questions and merges the set. Pressing the merge gate there would leave the primary
 * awaiting after its own commits had merged.
 *
 * The MEMBERS stay the merge gate's: they are what the press will merge. Once the primary
 * is decided the merge gate leads ALONE while it still awaits (Q2; §27 Panel 5b) — the
 * reader is being asked about the commits, and the primary shows as decided. A DECISION
 * card with no merge question left keeps its own gate in the frame (§27 Panels 4, 5a, 6a,
 * 6b): its record is the frame's record.
 */
function frameGateFor(r: LateReads, acceptanceLeads: boolean): DevelopmentGateRead | null {
  const primary = (read: {
    gate: DevelopmentGateRead['gate'] | null;
    canDecide: boolean;
    routedToLabel: string | null;
    stamp: string | null;
  }): DevelopmentGateRead | null =>
    read.gate
      ? {
          gate: read.gate,
          canDecide: read.canDecide,
          routedToLabel: read.routedToLabel,
          // The PRIMARY gate's stamp — it covers the pull requests beneath it too.
          stamp: read.stamp,
          members: r.mergeGate.members,
        }
      : null;
  const merge = r.mergeGate.gate ? primary(r.mergeGate) : null;
  const decision = r.decisionGate.gate;
  if (decision) {
    if (decision.state === 'awaiting' || decision.state === 'superseded') {
      return primary(r.decisionGate);
    }
    // Only an ACCEPTED decision hands the lead to the merge question (Panel 5b). One sent
    // back keeps the frame — its commits cannot merge (`decisionHoldsMerge`), so an
    // *Approve and merge* over them would be a press the door refuses.
    return decision.state === 'approved' && r.mergeGate.gate?.state === 'awaiting'
      ? merge
      : primary(r.decisionGate);
  }
  // THE STORY RUN'S PRIMARY (Story MOTIR-4949 · Subtask MOTIR-5790): the acceptance gate
  // is what the frame names and the press addresses while it awaits — its stamp covers
  // the pull requests beneath it, and the MEMBERS are the merge gate's. It also carries
  // `mergeSubjectVersion`, because the sentence names what the press merges and that is
  // the merge gate's subject, never the recording's.
  if (acceptanceLeads && r.mergeGate.gate && r.acceptanceGate.gate) {
    const read = primary(r.acceptanceGate);
    return read ? { ...read, mergeSubjectVersion: r.mergeGate.gate.subjectVersion } : null;
  }
  if (r.designGate.gate?.state === 'awaiting' && r.mergeGate.gate) return primary(r.designGate);
  return merge;
}

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

/** The fallback for the UPPER half — Development, Errors, Acceptance, Design
 *  result. UNCHANGED by the Errors section (§14 panel 10): most cards have no
 *  link, so reserving a skeleton for it would draw a card that then vanishes. */
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
  /** The card's DELIVERY SET (MOTIR-3660), read in the same TIER-TWO group and
   *  passed down for the same reason — the rail needs it too. */
  deliveries: React.ComponentProps<typeof DevelopmentSectionBody>['deliveries'];
}

/**
 * Development · Acceptance · Design result — the late sections that sit ABOVE
 * `ChildPanel` in the page's order.
 */
export async function LateUpperSections({
  reads,
  itemId,
  itemIdentifier,
  currentUserId,
  canEdit,
  repoDelivery,
  deliveries,
}: LateProps & {
  /** The session's user — only to say whether the design gate is ROUTED to the
   *  reader (the band's sentence, MOTIR-5229). Authority stays `canDecide`. */
  currentUserId: string;
}) {
  const r = await reads;
  const [tGithub, tAcceptance, tDesignResult, tRuns] = await Promise.all([
    getTranslations('github'),
    getTranslations('acceptance'),
    getTranslations('designResult'),
    getTranslations('runs'),
  ]);
  // ⚠️ A DESIGN RESULT ON A CARD WITH AN OPEN LINKED PULL REQUEST IS NOT A SECTION
  // (`design-result.md` AMENDMENT 4 Q8). Those pull requests carry the decision —
  // one approve-to-merge gate over all of them — so the result renders ONCE as
  // the Development block's slot, and the standalone section (and its
  // `design_result` frame) is not drawn. With no open pull request, or nothing
  // published yet, the section renders exactly as before.
  // ⚠️ RE-DERIVED FROM THE GATES, not from "a pull request exists" (Story
  // MOTIR-5652 · Subtask MOTIR-5667; AMENDMENT 6 Q1 reversing AMENDMENT 4 Q8).
  // The old rule keyed on an open pull request because one meant NO design gate at
  // all — the card had a merge question and nothing else, so the result was a slot
  // rather than a subject. Such a card raises a design gate again, and the design
  // gate LEADS: the result is the Development block's subject and the pull requests
  // sit beneath it as what approving will merge.
  const designInDevelopment =
    r.designEvidence !== null &&
    r.designGate.gate !== null &&
    hasOpenPullRequest(r.pullRequests, deliveries ?? []);
  const showDesignResult = !designInDevelopment && (r.designEvidence !== null || r.isDesignCard);
  // THE STORY RUN (Story MOTIR-4949 · Subtask MOTIR-5790; the MOTIR-5787 amendment, point
  // 2). A story holding an acceptance question AND an open pull request of its own was
  // run as a whole: the receipt LEADS the Development block exactly as a design does,
  // and the pull requests beneath it are what the one press merges. The standalone
  // Acceptance section is then not drawn — one question, one place. A story with no
  // pull request of its own (a single-card run) keeps the section, alone (point 3).
  //
  // ⚠️ AND ONLY WHEN THE BLOCK CAN CARRY THE QUESTION (Subtask MOTIR-5792). The frame is
  // the MERGE gate's — `DevelopmentSectionBody` draws no bands without one. Since Bug
  // MOTIR-5903 a story run's acceptance question is asked only once its set is GREEN, so a
  // story whose pull requests are open but not yet green holds NO acceptance question at
  // all — there is no "To approve" row to fall back on, and none should exist (the receipt
  // is evidence waiting for the one approve-to-merge question). An awaiting acceptance with
  // no merge gate beside it is now the `auto`-mode shape, where Motir raises no merge gate:
  // the standalone section stays its door. An ANSWERED acceptance stays here too: panels B
  // and C are lines about a decision already made, and the block is where they belong
  // beside the commits they cover.
  const acceptanceAwaiting = r.acceptanceGate.gate?.state === 'awaiting';
  const acceptanceInDevelopment =
    r.acceptanceEvidence !== null &&
    r.acceptanceGate.gate !== null &&
    hasOpenPullRequest(r.pullRequests, deliveries ?? []) &&
    (!acceptanceAwaiting || r.mergeGate.gate !== null);
  const acceptanceLeads = acceptanceInDevelopment && acceptanceAwaiting;

  // THE DECISION PORT (Story MOTIR-4907 · Subtask MOTIR-5678; design `design/github` §27).
  // A card that asks the decision question and holds a decision gate shows its document
  // FIRST in the Development block — the PRIMARY question, with the pull requests beneath
  // as what accepting it merges. `decisionGate` is read only for such a card.
  const decisionInDevelopment = r.decisionGate.gate !== null;
  const developmentFrame = frameGateFor(r, acceptanceLeads);
  return (
    <>
      {/* THE RUN — above Development, because the run is what produced it. It
          renders even with no runs: its empty state reads *nothing has run yet*,
          and an absent section would be a third thing for a reader to interpret.
          A container that was run as a SCOPE shows its scope block instead of that
          empty state (MOTIR-5363) — the time is formatted here, on the server, for
          the same first-paint reason `formatRunTimes` exists. */}
      <ContentSectionCard title={tRuns('title')} subtitle={tRuns('gloss')}>
        <RunSection
          initialRuns={r.runs ?? []}
          initialCursor={
            r.runs && r.runs.length === RUN_HISTORY_PAGE ? (r.runs.at(-1)?.id ?? null) : null
          }
          itemKey={itemIdentifier}
          formattedTimes={formatRunTimes(r.runs ?? [])}
          scopeRun={r.scopeRun}
          scopeRunTime={r.scopeRun ? formatRunInstant(r.scopeRun.startedAt) : null}
        />
      </ContentSectionCard>
      {/* THE HOW-TO-TEST WRITE DOORS (Story MOTIR-5450 · MOTIR-5455, design § 24).
          Mounted ONLY for an actor holding `work_item:edit` and ONLY here: the
          block asks for this context and draws no door without it, so the
          read-only peek and the approval overlay — which render the same block —
          have none by construction rather than by a flag each host remembers to
          pass (§ 24, decisions 10 and 11). Both actions assert the same key
          server-side, so the gate is not this line's alone. */}
      <HowToTestWrite canEdit={canEdit} itemId={itemId} itemIdentifier={itemIdentifier}>
        <DevelopmentLinkProvider currentItemId={itemId} identifier={itemIdentifier}>
          <ContentSectionCard
            title={tGithub('development.title')}
            subtitle={tGithub(
              decisionInDevelopment
                ? 'development.glossWithDecision'
                : designInDevelopment
                  ? 'development.glossWithDesign'
                  : acceptanceInDevelopment
                    ? 'development.glossWithAcceptance'
                    : 'development.gloss',
            )}
            headerRight={canEdit ? <LinkPullRequestDoor /> : undefined}
          >
            {canEdit ? <LinkPullRequestForm /> : null}
            <DevelopmentSectionBody
              pullRequests={r.pullRequests}
              itemIdentifier={itemIdentifier}
              manualLinkable={canEdit}
              // The per-row REMOVE control (Story MOTIR-4878 · MOTIR-5005,
              // design Panels 5d–5f). Gated on the SAME `work_item:edit` the
              // header door is — the key `unlinkPullRequestAction` and the MCP
              // tool both assert — and passed only from THIS host: the read-only
              // peek omits it, so its rows keep no trailing control at all rather
              // than a disabled one (design Q1 / Q4).
              rowAction={
                canEdit
                  ? (pr) => (
                      <RemovePullRequestLinkButton
                        pullRequestId={pr.id}
                        target={`${pr.repo} · #${pr.number}`}
                      />
                    )
                  : undefined
              }
              // The item's repository set, VERBATIM (Story MOTIR-2725 ·
              // MOTIR-2415) — which rows it earns is the section's derivation,
              // not this page's. Pre-filtering here is what let this page and the
              // quick view disagree (MOTIR-3036).
              repoDelivery={repoDelivery}
              deliveries={deliveries}
              // THE DEVELOPMENT BLOCK (MOTIR-5336, design §20): How to test renders
              // INSIDE this card, below the rows — never a second section in this
              // stack — and an awaiting approve-to-merge gate makes the rows plus
              // How to test the port of ONE frame, as Design result's gate does.
              howToTest={r.howToTest}
              // THE FIX PART (MOTIR-5466, design § 21): below the rows, above How to
              // test — the copyable `motir fix`, a repair in progress, or a give-up.
              repair={r.repair}
              designResult={
                designInDevelopment ? (
                  <DesignResultPanel
                    evidence={r.designEvidence}
                    isDesignCard={r.isDesignCard}
                    placement="development"
                  />
                ) : acceptanceInDevelopment && r.acceptanceEvidence && r.acceptanceGate.gate ? (
                  <AcceptanceDevelopmentSlot
                    evidence={r.acceptanceEvidence}
                    accepted={
                      r.acceptanceGate.gate.state === 'approved'
                        ? {
                            name: r.acceptanceGate.gate.decidedByLabel ?? '',
                            at: r.acceptanceGate.gate.decidedAt ?? '',
                          }
                        : null
                    }
                    mergeAwaiting={r.mergeGate.gate?.state === 'awaiting'}
                  />
                ) : undefined
              }
              // ⚠️ WHICH GATE THE FRAME IS A PORT FOR (MOTIR-5667). When the card's
              // DESIGN question is still open it is the PRIMARY (AMENDMENT 6 Q1), so
              // the frame names it, and the press addresses it — which is what makes
              // ONE press answer both questions and merge the set (MOTIR-5664).
              // Pressing the merge gate here would leave the design question awaiting
              // after its own commits had merged.
              //
              // The MEMBERS stay the merge gate's: they are what the press will merge,
              // and they are what band 1 counts beneath the subject. After the design
              // is decided the merge gate leads ALONE (Q2) — the reader is being asked
              // about the commits, and the design shows as decided rather than as a
              // second thing to answer.
              mergeGate={developmentFrame}
              decision={
                decisionInDevelopment
                  ? { document: r.decisionGate.document, gate: r.decisionGate.gate }
                  : null
              }
              // THE FRAME'S VERBS (MOTIR-5484): server actions, handed down as references
              // so the shared block — also the read-only peek's — imports none of them.
              gateActions={{
                decide: decideApprovalGateAction,
                approveAndMerge: approveAndMergeAction,
                retryMember: retryApproveAndMergeMemberAction,
              }}
              // An `auto` card's exits (MOTIR-5635): Queue again for a reader who may edit.
              autoQueueExits={{
                workItemId: itemId,
                exits: r.mergeGate.autoQueueExits,
                canEdit,
                queueAgain: queueAgainAutoAction,
              }}
            />
          </ContentSectionCard>
        </DevelopmentLinkProvider>
      </HowToTestWrite>
      {/* ERRORS — directly below Development (§14 access path): the same question,
          "what outside this tree does this card relate to", from a different source.
          The host draws NOTHING for a card with no link (the page is unchanged) unless
          the ⋯ menu's Link an error row asked for it (MOTIR-5744). */}
      <MonitorErrorsCard
        links={r.monitorIssueLinks}
        hasConnection={r.monitorHasConnection}
        // `work_item:edit` — the key every error-link action asserts (§14 Decision 5).
        canEdit={canEdit}
        workItemId={itemId}
        identifier={itemIdentifier}
        unlinkAction={unlinkMonitorIssueAction}
      />
      {r.acceptanceEligibility && r.showAcceptance && !acceptanceInDevelopment ? (
        <ContentSectionCard title={tAcceptance('title')} subtitle={tAcceptance('gloss')}>
          <AcceptancePanel
            workItemId={itemId}
            itemIdentifier={itemIdentifier}
            projectId={r.projectId}
            eligibility={r.acceptanceEligibility}
            initialEvidence={r.acceptanceEvidence}
            gate={r.acceptanceGate.gate}
            canDecide={r.acceptanceGate.canDecide}
            routedElsewhereName={
              r.acceptanceGate.gate?.routedToId === currentUserId
                ? null
                : r.acceptanceGate.routedToLabel
            }
          />
        </ContentSectionCard>
      ) : null}
      {showDesignResult ? (
        <ContentSectionCard title={tDesignResult('title')} subtitle={tDesignResult('gloss')}>
          {/* A decision made in the approval OVERLAY (mounted in the shell, outside
              this page's optimistic status provider) reaches the status rail
              through here — MOTIR-5570. */}
          {r.designGate.gate ? <DecidedGateStatusBridge gateId={r.designGate.gate.id} /> : null}
          <DesignResultSection
            evidence={r.designEvidence}
            isDesignCard={r.isDesignCard}
            gate={r.designGate.gate}
            canDecide={r.designGate.canDecide}
            routedToLabel={r.designGate.routedToLabel}
            routedToViewer={r.designGate.gate?.routedToId === currentUserId}
            subject={r.designGate.subject}
            itemIdentifier={itemIdentifier}
          />
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

/**
 * The write provider, or nothing — a reader without `work_item:edit` gets the
 * block's children with NO context, which is what makes "no door" structural
 * (MOTIR-5455). Split out so the mount reads as one element in the stack rather
 * than a ternary wrapped around half the section.
 */
function HowToTestWrite({
  canEdit,
  itemId,
  itemIdentifier,
  children,
}: {
  canEdit: boolean;
  itemId: string;
  itemIdentifier: string;
  children: React.ReactNode;
}) {
  if (!canEdit) return <>{children}</>;
  return (
    <HowToTestWriteProvider
      workItemId={itemId}
      identifier={itemIdentifier}
      loadDraft={loadHowToTestDraftAction}
      saveHowToTest={saveHowToTestAction}
    >
      {children}
    </HowToTestWriteProvider>
  );
}
