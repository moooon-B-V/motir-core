'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// READ A PROPOSAL WITH THE SHIPPED PEEK (MOTIR-4185, story MOTIR-4181, design
// `design/ai-planning/design-notes.md` Part XIV).
//
// This REPLACES `ProposalQuickView`, which was a second surface built from the
// same `QuickViewSurface` chrome. It existed because, when it was written, a
// proposal peek could only ever be opened on an `add`; MOTIR-4022 made a LIST
// ROW a door and that premise became false. Every field the review model carries
// then had to be walked across the `op` axis by hand, one bug report at a time
// (MOTIR-4134's bodies, MOTIR-4143's rail), with a person discovering each
// omission from the running product.
//
// ── The two arms, and why they differ ───────────────────────────────────────
// A `modify` / `remove` names a REAL work item, so the target's payload is
// FETCHED from the shipped `GET /api/work-items/peek` — the same request
// `WorkItemQuickView` and `IssueQuickViewController` already make, on open, for
// the one proposal the reviewer opened. An un-materialized `add` has no key, so
// there is nothing to fetch and nothing to fetch it BY: the review model's own
// proposed fields are the whole of what exists, and they are shaped here.
//
// Part XIV §2 (as amended) measured the alternative: merging the target's
// payload server-side would mean `workItemsService.getQuickView` — ~14 reads —
// once per proposal, on a plan-review read whose own header advertises ONE
// batched target read and no N+1. That is ~280 reads for a plan with twenty
// `modify`s, to serve a peek the reviewer opens at most one of.

/**
 * The project's key PREFIX, for the panel's title-linkify — derived from the
 * proposal's own identifier rather than threaded through two hosts.
 *
 * A plan of pure `add`s has no committed key to derive one from, and it also has
 * no committed key a bare `MOTIR-<n>` in a title could resolve TO, so the empty
 * prefix costs that case nothing.
 */
function prefixOf(identifier: string | null): string {
  if (!identifier) return '';
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : '';
}

/**
 * The proposed values, shaped as the payload the panel renders.
 *
 * ⚠️ NOTHING IS INVENTED, and the fields with no source say so rather than
 * carrying a plausible value. A synthesized `createdAt` of `now` is the shape to
 * avoid: it is indistinguishable from a real one and it is a lie about a work
 * item that does not exist. Every field below is either the proposal's own or an
 * explicit empty — and proposal mode SUPPRESSES the sections that would read the
 * empties (Development, readiness, comments, children, the audit line), so none
 * of them reaches a reader as a claim about a card that is not there.
 */
function proposedPayload(item: PlanReviewItemDto, projectIdentifier: string): QuickViewData {
  const empty = {
    // Suppressed sections. Present because the payload's type requires them and
    // read by nothing in proposal mode (Part XIV §5).
    pullRequests: [],
    deliveries: [],
    customFields: [],
    labels: [],
    components: [],
    readiness: null,
    archived: null,
    hasChildren: false,
    canPlan: false,
    // The audit line is REPLACED by the count line, so these are never rendered.
    // Empty rather than `new Date().toISOString()`: a proposal has no instants of
    // its own that mean anything to a reviewer, and inventing them would be the
    // one lie this function exists to refuse.
    createdAt: '',
    updatedAt: '',
  };

  // The repo PIN, as the delivery row it actually is: the repository is NAMED
  // and nothing has been delivered to it, which is exactly `awaiting`. Not an
  // invention — it is the same state a committed card in this repository reports
  // before its first pull request, and it is what routes dispatch.
  const repoDelivery = item.targetRepo
    ? [{ repo: item.targetRepo, state: 'awaiting' as const, primary: true }]
    : [];

  const payload: QuickViewData = {
    repoDelivery,
    // An un-materialized `add` has no row, so no id. Proposal mode writes
    // nothing, and both write paths are keyed by this — an empty id is
    // unusable by construction, which is the correct state for a card that
    // cannot be edited at all.
    id: '',
    identifier: item.identifier ?? '',
    projectIdentifier,
    title: item.title,
    workItemRefs: {},
    kind: (item.kind || 'task') as WorkItemKindDto,
    // No status: an `add` is not a work item yet, and the header's op chip is
    // where a proposal's own state lives (Part XIV §4).
    status: item.status ?? '',
    statusLabel: item.statusLabel ?? '',
    statusCategory: item.statusCategory,
    descriptionMd: item.descriptionMd,
    explanationMd: item.explanationMd,
    type: item.type as QuickViewData['type'],
    executor: item.executor as QuickViewData['executor'],
    priority: (item.priority ?? 'medium') as QuickViewData['priority'],
    storyPoints: item.storyPoints,
    estimateMinutes: item.estimateMinutes,
    estimateLabel: item.estimateMinutes != null ? `${item.estimateMinutes}m` : null,
    parent: item.parentIdentifier
      ? {
          identifier: item.parentIdentifier,
          title: item.parentTitle ?? '',
          kind: (item.parentKind || 'story') as WorkItemKindDto,
        }
      : null,
    // Nobody is assigned to something that does not exist; the loader assigns at
    // materialize, deterministically, and saying otherwise here would be a guess.
    assigneeName: null,
    assigneeId: null,
    reporterName: '',
    parentId: null,
    sprintName: null,
    sprintId: null,
    dueLabel: null,
    dueDate: null,
    ...empty,
    // The editor inputs. Proposal mode suppresses every editor, so these are the
    // shapes the type needs and nothing reads.
    workflow: { statuses: [], transitions: [], policyMode: 'open' },
    members: [],
    sprints: [],
    projectComponents: [],
    estimation: {
      estimationStatistic: 'story_points',
      pointScale: 'fibonacci',
      customScaleValues: [],
      canEdit: false,
    },
  };
  return payload;
}

export function ProposalPeek({
  item,
  onClose,
}: {
  /** The proposal to read, or null when the peek is closed. */
  item: PlanReviewItemDto | null;
  onClose: () => void;
}) {
  const [fetched, setFetched] = useState<{ key: string; data: QuickViewData } | null>(null);
  const targetKey = item?.proposal.identifier ?? null;
  const abort = useRef<AbortController | null>(null);

  // Fetch the TARGET's payload for a `modify` / `remove`, on open — the request
  // the shipped peek's other two drivers already make. An `add` skips it: there
  // is no key, which is the model's own signal that there is nothing to fetch.
  useEffect(() => {
    if (!targetKey) return;
    const controller = new AbortController();
    abort.current = controller;
    (async () => {
      try {
        const res = await fetch(`/api/work-items/peek?key=${encodeURIComponent(targetKey)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return; // fall back to the proposal's own values below
        setFetched({ key: targetKey, data: (await res.json()) as QuickViewData });
      } catch {
        // An aborted fetch (the peek closed or swapped) is expected; a real
        // failure falls back to the proposed values rather than blanking the
        // dialog, because the proposal's own fields are always available.
      }
    })();
    return () => controller.abort();
  }, [targetKey]);

  if (!item) return null;

  // The OVERLAY (Part XIV §2). The target's payload is the base — so a `modify`
  // keeps `Assignee`, `Reporter`, `Labels`, `Components`, `Due date`, `Sprint`
  // and the custom fields the canvas door shows today — and the proposal's own
  // fields are laid over it, so every marked row reads the value approval will
  // WRITE rather than the one it is replacing.
  const base =
    fetched && fetched.key === targetKey
      ? fetched.data
      : proposedPayload(item, prefixOf(item.identifier));
  const data: QuickViewData =
    fetched && fetched.key === targetKey
      ? {
          ...base,
          title: item.title,
          descriptionMd: item.descriptionMd,
          explanationMd: item.explanationMd,
          ...(item.priority ? { priority: item.priority as QuickViewData['priority'] } : {}),
          ...(item.type !== null ? { type: item.type as QuickViewData['type'] } : {}),
          storyPoints: item.storyPoints,
          estimateMinutes: item.estimateMinutes,
          estimateLabel: item.estimateMinutes != null ? `${item.estimateMinutes}m` : null,
          // Only when the plan MOVES the pin: overlaying it unconditionally
          // would replace a delivered repository's real state with `awaiting`
          // on a `modify` that does not touch the repo at all.
          ...(item.proposal.changedFields.includes('targetRepo') && item.targetRepo
            ? {
                repoDelivery: [
                  { repo: item.targetRepo, state: 'awaiting' as const, primary: true },
                ],
              }
            : {}),
        }
      : base;

  return (
    <Modal
      open
      onOpenChange={(next) => (next ? undefined : onClose())}
      srTitle={item.title}
      size="xl"
      // ONE close affordance (MOTIR-4022, Part XIII §7, inherited by Part XIV
      // §7). Without this the base Modal's corner x renders BESIDE the header's
      // own close button — measured at two glyphs 40px apart, and two controls
      // with the identical accessible name `Close` in one dialog.
      hideClose
      className="h-[680px] max-h-[82vh] w-[90vw] p-0"
    >
      <div className="flex h-full flex-col" data-testid="proposal-peek">
        <IssueQuickViewPanel
          key={item.planItemId}
          state="ready"
          data={data}
          proposal={item.proposal}
          onClose={onClose}
        />
      </div>
    </Modal>
  );
}
