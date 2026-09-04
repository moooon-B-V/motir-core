'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type {
  ReadinessVerdictDto,
  RelationshipLinkDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { ContentSectionCard } from './ContentSectionCard';
import { AddLinkControl } from './AddLinkControl';
import { RemoveLinkButton } from './RemoveLinkButton';
import { RelationshipPeekLink } from './RelationshipPeekLink';
import { Pill } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { showsReadiness } from '@/lib/issues/readinessVisibility';
import { StatusPill } from '@/components/issues/StatusPill';
import {
  createLinkAction,
  removeLinkAction,
  type CreateLinkActionResult,
  type RemoveLinkActionResult,
} from '../actions';

// The relationships panel on the issue detail page (Story 2.4 · Subtasks 2.4.5
// + 2.4.9), per `design/work-items/relationships.mock.html` + `links.mock.html`:
// a LEFT-column section card grouping the work_item_link edges by kind
// (blocked-by / blocks / relates-to / duplicates / clones), with the
// ready/blocked banner at the top. READ surface from 2.4.5; 2.4.9 makes it
// EDITABLE on the detail page (`editable`): a "+ Link issue" add control + a
// per-row remove. The EDIT page reuses it the same editable way (user directive)
// so an editor manages dependency links without leaving the edit surface.

// The status chip's tone + glyph live in `components/issues/StatusPill`
// (MOTIR-3103). This file used to keep its own copy of the category map —
// one of five — which is how `implemented` could share a chip with three
// other statuses in every one of them at once.

// ── MOTIR-4496: this panel is a CLIENT ISLAND, and it owns the write ──────────
// It used to be a server component whose two edit affordances each called their
// own Server Action and then `router.refresh()`, with nothing in between. That
// made the visible latency of a link mutation the latency of the detail page's
// WHOLE read group (the item, the children, the sprints, the to-dos, the
// roll-up, the pending plans) rather than of the one route the user invoked —
// the page-state-after-mutation contract's third case (`CLAUDE.md`), unmet: a
// client island that owns state needs an optimistic local insert/remove, not
// only a refresh. Four `@smoke` E2E tests had been rotating failures on that
// race across two spec files.
//
// So the WRITE moved up here, because the optimistic state and the rows have to
// live in one component: `AddLinkControl` / `RemoveLinkButton` keep their form
// and confirm UX and hand the mutation to `addLink` / `removeLink` below. The
// REMOVE error moved up with it — an optimistic removal unmounts the row before
// the rejection arrives, so the popover that must show the message is gone by
// then (`removeErrors`, below).
//
// THE BANNER MOVED WITH THE ROWS, DELIBERATELY (criterion 7a). Making only the
// rows optimistic would have handed the whole-page wait to the readiness
// banner, whose assertions have never flaked precisely because the row
// assertion above them was absorbing it — the same race under two new line
// numbers. The banner is NOT re-derived in the browser (readiness is a
// server-side judgement over each blocker's own project's terminal set): the
// link actions now RETURN the re-judged verdict, and the panel shows it until
// the refresh supersedes it.
//
// RECONCILIATION (criterion 5). `router.refresh()` still runs and is still the
// authority. Every optimistic entry is stamped with a monotonic `seq`; when a
// refresh started for seq N commits, every entry at or below N is dropped, so
// whatever the server just re-rendered wins — including a server that DISAGREES
// (a row we hid that is still there comes back). Entries above N are a mutation
// that landed while that refresh was in flight and survive until their own.

export interface RelationshipsPanelProps {
  blockedBy: RelationshipLinkDto[];
  blocks: RelationshipLinkDto[];
  relatesTo: RelationshipLinkDto[];
  duplicates: RelationshipLinkDto[];
  clones: RelationshipLinkDto[];
  readiness: ReadinessVerdictDto;
  /** The current item's status key — the readiness banner shows only while the
   *  item is in the `todo` category (resolved via `workflow`); "can I start
   *  this?" is moot once it's in-progress or done (2.5.21). */
  currentStatus: string;
  /** Is the item ARCHIVED (`archivedAt != null`)? An archived item is never
   *  startable work — archiving leaves `status` untouched, so without this the
   *  status-only gate showed "Ready to start" beside the page's own "Archived"
   *  banner, promising work the ready set can never hand out (bug MOTIR-2050). */
  archived?: boolean;
  /** The item's project workflow — classifies a linked status into a Pill tone. */
  workflow: WorkflowDto;
  /** When set, render the add control + per-row remove (the detail page). The
   *  edit page omits these (read-only). Requires currentItemId + identifier. */
  editable?: boolean;
  currentItemId?: string;
  identifier?: string;
}

/** One optimistic mutation, stamped with the sequence number that retires it. */
type PendingRemoval = { linkId: string; seq: number };
type PendingAddition = { relationship: RelationshipKind; link: RelationshipLinkDto; seq: number };
type Overlay = {
  removed: PendingRemoval[];
  added: PendingAddition[];
  readiness: { value: ReadinessVerdictDto; seq: number } | null;
};

const EMPTY_OVERLAY: Overlay = { removed: [], added: [], readiness: null };

/** Take a verdict only if it is NEWER than the one already shown.
 *
 * Two writes in flight resolve in whatever order the server answers, and the
 * readiness verdict is a single slot rather than a list — so without this an
 * older response clobbers the newer optimistic state, the `seq`-guarded
 * reconcile `CLAUDE.md` requires of every optimistic mutation. */
function latestReadiness(current: Overlay['readiness'], value: ReadinessVerdictDto, seq: number) {
  return current && current.seq > seq ? current : { value, seq };
}

/** `key ASC` — the order every relationship projection is served in
 *  (MOTIR-4063), so an optimistic row lands where the refresh will put it
 *  rather than at the end and then jumping. */
function byItemKeyAsc(a: RelationshipLinkDto, b: RelationshipLinkDto): number {
  return a.item.key - b.item.key;
}

// One linked item: a navigable row (id+title share an inline baseline, icon/pill
// centered — the alignment the design specifies). When editable, a remove button
// sits OUTSIDE the link (an interactive control can't nest inside an anchor).
function LinkRow({
  link,
  workflow,
  isOpenBlocker,
  editable,
  relationshipLabel,
  onRemove,
  removeError,
  onDismissRemoveError,
}: {
  link: RelationshipLinkDto;
  workflow: WorkflowDto;
  isOpenBlocker?: boolean;
  editable?: boolean;
  relationshipLabel: string;
  onRemove?: (linkId: string) => Promise<RemoveLinkActionResult>;
  removeError?: string | null;
  onDismissRemoveError?: (linkId: string) => void;
}) {
  const t = useTranslations('issueViews');
  const { item } = link;
  const statusMeta = workflow.statuses.find((s) => s.key === item.status);
  return (
    <li className="hover:bg-(--el-surface) flex items-center gap-1 rounded-(--radius-control) pr-1">
      <RelationshipPeekLink
        identifier={item.identifier}
        className="group flex min-w-0 flex-1 items-center gap-2 rounded-(--radius-control) px-2 py-1.5 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {isOpenBlocker ? (
          <span
            className="bg-(--el-warning) h-1.5 w-1.5 shrink-0 rounded-full"
            aria-hidden
            title={t('openBlocker')}
          />
        ) : null}
        <IssueTypeIcon type={item.kind} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-(--el-text-secondary) font-mono text-xs">{item.identifier}</span>
          <span className="text-(--el-text) ml-2 font-sans text-sm group-hover:underline">
            {item.title}
          </span>
        </span>
        {statusMeta ? (
          <StatusPill
            statusKey={statusMeta.key}
            category={statusMeta.category}
            label={statusMeta.label}
            className="shrink-0"
          />
        ) : (
          <Pill tone="neutral" className="shrink-0">
            {item.status}
          </Pill>
        )}
      </RelationshipPeekLink>
      {editable && onRemove ? (
        <RemoveLinkButton
          linkId={link.linkId}
          relationshipLabel={relationshipLabel}
          targetIdentifier={item.identifier}
          onRemove={onRemove}
          error={removeError ?? null}
          onDismissError={onDismissRemoveError}
        />
      ) : null}
    </li>
  );
}

export function RelationshipsPanel({
  blockedBy,
  blocks,
  relatesTo,
  duplicates,
  clones,
  readiness,
  currentStatus,
  archived = false,
  workflow,
  editable,
  currentItemId,
  identifier,
}: RelationshipsPanelProps) {
  const t = useTranslations('issueViews');
  const tl = useTranslations('labels');
  const router = useRouter();

  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  // A rejected removal's message, per link. It lives HERE because the
  // optimistic removal unmounts the row — and its confirm popover — before the
  // rejection arrives, so the control that must show it no longer exists at
  // that moment (see RemoveLinkButton).
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});
  const [isRefreshing, startRefresh] = useTransition();
  const seqRef = useRef(0);
  // The highest seq a STARTED refresh covers. Read only when that refresh
  // commits, which is what makes the drop below "the server has now spoken
  // about everything up to here".
  const refreshedThroughRef = useRef(0);

  // The callback is ASYNC so the transition spans the refresh rather than the
  // call that starts it: `isRefreshing` stays true until the refreshed tree has
  // committed, which is what makes its falling edge mean "the server's props
  // are now on screen" — the precondition the reconcile below depends on.
  const startRefreshThrough = useCallback(
    (seq: number) => {
      startRefresh(async () => {
        refreshedThroughRef.current = Math.max(refreshedThroughRef.current, seq);
        await router.refresh();
      });
    },
    [router],
  );

  // The refresh has committed → the props below are the server's own answer, so
  // drop every optimistic entry it covers. A later mutation (seq above the
  // watermark) is still in flight and keeps its overlay.
  useEffect(() => {
    if (isRefreshing) return;
    const through = refreshedThroughRef.current;
    if (through === 0) return;
    setOverlay((o) => {
      const removed = o.removed.filter((r) => r.seq > through);
      const added = o.added.filter((a) => a.seq > through);
      const nextReadiness = o.readiness && o.readiness.seq > through ? o.readiness : null;
      if (
        removed.length === o.removed.length &&
        added.length === o.added.length &&
        nextReadiness === o.readiness
      ) {
        return o;
      }
      return { removed, added, readiness: nextReadiness };
    });
  }, [isRefreshing]);

  const addLink = useCallback(
    async (
      relationship: RelationshipKind,
      target: WorkItemSummaryDto,
    ): Promise<CreateLinkActionResult> => {
      if (!currentItemId || !identifier) throw new Error('AddLinkControl needs an editable panel');
      const seq = ++seqRef.current;
      // OPTIMISTIC: the row is in the list before the request leaves, built from
      // the candidate the picker already fetched. The temporary linkId is
      // replaced by the real one below, so the row's own remove button is armed
      // with a server-known id as soon as the write answers.
      setOverlay((o) => ({
        ...o,
        added: [
          ...o.added,
          { relationship, link: { linkId: `optimistic:${seq}`, item: target }, seq },
        ],
      }));
      const res = await createLinkAction({
        currentItemId,
        identifier,
        targetId: target.id,
        relationship,
      });
      if (!res.ok) {
        // ROLL BACK — the control surfaces `res.error` inline.
        setOverlay((o) => ({ ...o, added: o.added.filter((a) => a.seq !== seq) }));
        return res;
      }
      setOverlay((o) => ({
        ...o,
        added: o.added.map((a) =>
          a.seq === seq ? { ...a, link: { ...a.link, linkId: res.linkId } } : a,
        ),
        readiness: latestReadiness(o.readiness, res.readiness, seq),
      }));
      startRefreshThrough(seq);
      return res;
    },
    [currentItemId, identifier, startRefreshThrough],
  );

  const dismissRemoveError = useCallback((linkId: string) => {
    setRemoveErrors((e) =>
      linkId in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== linkId)) : e,
    );
  }, []);

  const removeLink = useCallback(
    async (linkId: string): Promise<RemoveLinkActionResult> => {
      if (!currentItemId || !identifier)
        throw new Error('RemoveLinkButton needs an editable panel');
      const seq = ++seqRef.current;
      // OPTIMISTIC: the row leaves the list before the request does.
      setOverlay((o) => ({ ...o, removed: [...o.removed, { linkId, seq }] }));
      const res = await removeLinkAction({ linkId, currentItemId, identifier });
      if (!res.ok) {
        // ROLL BACK — the row returns, and the message goes with it so the
        // re-mounted confirm popover can surface it inline.
        setOverlay((o) => ({ ...o, removed: o.removed.filter((r) => r.seq !== seq) }));
        setRemoveErrors((e) => ({ ...e, [linkId]: res.error }));
        return res;
      }
      setOverlay((o) => ({ ...o, readiness: latestReadiness(o.readiness, res.readiness, seq) }));
      startRefreshThrough(seq);
      return res;
    },
    [currentItemId, identifier, startRefreshThrough],
  );

  // The server's rows ⊕ this panel's un-reconciled optimism.
  const removedIds = new Set(overlay.removed.map((r) => r.linkId));
  function project(server: RelationshipLinkDto[], relationship: RelationshipKind) {
    const kept = server.filter((l) => !removedIds.has(l.linkId));
    const pending = overlay.added
      .filter((a) => a.relationship === relationship)
      // A refresh can land the real row while this entry is still un-retired
      // (its own refresh not yet committed) — don't render it twice.
      .filter((a) => !kept.some((l) => l.linkId === a.link.linkId))
      .map((a) => a.link);
    return pending.length === 0 ? kept : [...kept, ...pending].sort(byItemKeyAsc);
  }

  const effectiveReadiness = overlay.readiness?.value ?? readiness;

  const groups = [
    {
      key: 'blocked_by' as const,
      label: tl('relationship.blocked_by'),
      items: project(blockedBy, 'blocked_by'),
      blockerGroup: true,
    },
    {
      key: 'blocks' as const,
      label: tl('relationship.blocks'),
      items: project(blocks, 'blocks'),
      blockerGroup: false,
    },
    {
      key: 'relates_to' as const,
      label: tl('relationship.relates_to'),
      items: project(relatesTo, 'relates_to'),
      blockerGroup: false,
    },
    {
      key: 'duplicates' as const,
      label: tl('relationship.duplicates'),
      items: project(duplicates, 'duplicates'),
      blockerGroup: false,
    },
    {
      key: 'clones' as const,
      label: tl('relationship.clones'),
      items: project(clones, 'clones'),
      blockerGroup: false,
    },
  ];
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  // The readiness banner shows for a TODO-category item that is NOT archived —
  // the shared `showsReadiness` predicate the quick-view peek uses too
  // (MOTIR-2050). "Can I start this?" is moot once the item is in-progress or
  // done (2.5.21), and an archived item is not startable work at all (it is
  // filtered out of every ready-set read). An item with NO blockers is the most
  // ready it can be, so it shows the green "Ready to start" too — the badge
  // renders off the `readiness` verdict (ready when no blockers OR all terminal),
  // not the blocker count (bug-ready-banner-no-deps).
  const currentCategory = workflow.statuses.find((s) => s.key === currentStatus)?.category;
  const showReadiness = showsReadiness({ statusCategory: currentCategory, archived });
  const openBlockerIds = new Set(effectiveReadiness.openBlockers.map((b) => b.id));
  const canEdit = Boolean(editable && currentItemId && identifier);

  return (
    <ContentSectionCard title={t('relationships')} subtitle={t('relationshipsGloss')}>
      <div className="flex flex-col gap-4">
        {canEdit ? <AddLinkControl currentItemId={currentItemId!} onAdd={addLink} /> : null}

        {/* Readiness shows while the item is still in the todo category
            (2.5.21): green "Ready to start" when ready (no blockers, or all
            terminal), peach "Blocked" naming the open blockers otherwise. */}
        {showReadiness ? (
          <ReadinessBadge
            ready={effectiveReadiness.ready}
            blockers={effectiveReadiness.openBlockers.map((b) => ({
              identifier: b.identifier,
              href: `/items/${b.identifier}`,
            }))}
            blockedByAncestor={
              effectiveReadiness.blockedByAncestor
                ? {
                    identifier: effectiveReadiness.blockedByAncestor.identifier,
                    title: effectiveReadiness.blockedByAncestor.title,
                    href: `/items/${effectiveReadiness.blockedByAncestor.identifier}`,
                  }
                : null
            }
          />
        ) : null}

        {nonEmpty.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary) italic">
            {t('noLinkedIssues')}
          </p>
        ) : (
          nonEmpty.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-2">
                <SectionLabel label={group.label} />
                <span className="text-(--el-text-muted) font-mono text-[11px]">
                  {group.items.length}
                </span>
              </div>
              <ul className="flex flex-col">
                {group.items.map((link) => (
                  <LinkRow
                    key={link.linkId}
                    link={link}
                    workflow={workflow}
                    isOpenBlocker={group.blockerGroup && openBlockerIds.has(link.item.id)}
                    editable={canEdit}
                    relationshipLabel={group.label}
                    onRemove={canEdit ? removeLink : undefined}
                    removeError={removeErrors[link.linkId] ?? null}
                    onDismissRemoveError={dismissRemoveError}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </ContentSectionCard>
  );
}
