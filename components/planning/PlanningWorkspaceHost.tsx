'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Map, X } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { AuditCoverageBanner } from '@/components/planning/AuditCoverageBanner';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { PlanChangeCanvas } from '@/components/planning/PlanChangeCanvas';
import { PlanningCanvasSkeleton } from '@/components/planning/PlanningWorkspaceSkeleton';
import { PlanChangeConfirmBar } from '@/components/planning/PlanChangeConfirmBar';
import { PlanProposalViews } from '@/components/planning/PlanProposalViews';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { PlanCloseGuard } from '@/components/planning/PlanCloseGuard';
import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import {
  closeLosesProposal,
  isProposalPending,
  pendingProposalCount,
} from '@/lib/planning/planPending';
import { planGateView, type PlanDecisionPlace } from '@/lib/planning/planGateView';
import { isProposedReview } from '@/lib/planning/planReview';
import { defaultPlanView, type PlanViewDto } from '@/lib/planning/planView';
import {
  addPlanningTarget,
  removePlanningTarget,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';
import type { PlanningLaunch } from '@/lib/planning/launcher';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';

// The client island of the established-project planning HOST (Subtask
// MOTIR-1729; design `plan-change-conversation.mock.html` panel 2). It COMPOSES
// the shipped pieces — `PlanningWorkspace` (the two-pane frame),
// `WorkItemRoadmap` → `ProjectRoadmapCanvas` (the canvas, seeded with the
// project's EXISTING tree) — and adds only what the host owns: the exit chrome
// and the mode/context wiring. It rebuilds none of them.
//
// ⚠️ THE ROUTE FRAMING IS RETIRED (MOTIR-4729, under story MOTIR-4725). This
// header used to end: *"The design's overlay keeps the origin screen mounted
// behind it; this host is a ROUTE (the card's deliverable), so 'returns you to
// where you launched from' is a navigation back to that route."* It is now the
// overlay the design always specified — `PlanningWorkspaceOverlay` composes this
// host inside the shipped `Modal size="full"` over whichever authed page the
// reader is on, and closing removes four query parameters without unmounting
// anything.
//
// Two consequences land HERE rather than in the overlay, and both are subtractions:
//
//   · The exit chrome is a `<button>` calling `onClose`, not a `<Link href>`.
//     There is nowhere to link to — the reader is already on the page they are
//     going back to. Its label is a plain `close`; the three `backTo*` keys are
//     deleted, because naming a destination is exactly what made the route wrong
//     (`design/ai-chat/design-notes.md` § *Opening & exiting* → *The Close
//     control's copy*).
//   · This component no longer listens for `Esc`. Radix's dialog owns the key —
//     ONE handler, not two — and it already yields to a focused text field. The
//     listener that stood here is the collision `design/runs/` warned about.
//
// The chat pane is `PlanChangeRail` — the multi-turn plan-change CONVERSATION
// (Subtask MOTIR-1730). The host owns the conversation STATE
// (`usePlanChangeConversation`) rather than the rail, because the proposal is
// reviewed on the CANVAS: the same delta drives the rail's summary, the canvas's
// in-place diff, and the confirm-to-persist bar between them.
//
// PAGE STATE AFTER A MUTATION (`motir-core/CLAUDE.md`): an approve commits work
// items, which changes two kinds of surface. The canvas is a CLIENT ISLAND that
// seeds its level once — `router.refresh()` cannot reach it — so it gets an
// explicit refetch trigger (`treeVersion`, folded into the canvas's diff key);
// the server-rendered surfaces behind this overlay (counts, headers, the backlog
// underneath) take the `router.refresh()`. Both, because both apply.
//
// OPENS BEFORE ITS DATA (Bug MOTIR-2069): the frame — back bar, project name,
// the two-pane split, the whole conversation rail — waits on NOTHING. The host
// used to take a `hasItems` boolean the page computed from a server root read,
// and awaiting that read is what held the entire workspace shut: nothing painted
// until the level had been fetched, so the surface loaded first and opened
// second. That prop is gone. The canvas reads its own root level anyway (the
// same level, over `fetchRoadmapLevel`), so it owns the loading and empty states
// itself — one read instead of two, and none of them between the click and the
// paint. (`app/(planning)/loading.tsx` covered the navigation ahead of this while
// the workspace was a route; the overlay has no navigation to cover — it renders
// `PlanningWorkspaceSkeleton` inside the dialog instead.)

export interface PlanningWorkspaceHostProps {
  /** The project's `MOTIR`-style key — the canvas's per-level read source. */
  projectKey: string;
  projectName: string;
  /** The launcher's context, parsed off the query by the page. */
  launch: PlanningLaunch;
  /**
   * The ANCHOR work item's database id, when the workspace was summoned from a
   * work item (MOTIR-910's Plan / Re-plan entrance) and that item resolved. The
   * page resolves `launch.itemKey` → id server-side, so no client component
   * touches the service layer; the conversation then rides the item-scoped
   * MOTIR-909 endpoints instead of the project-wide thread. `null` for every
   * project / roadmap launch — and for an item key that no longer resolves,
   * which degrades to the project conversation rather than a dead workspace.
   */
  anchorId?: string | null;
  /** May this viewer configure the project's AI? Gates the audit-coverage banner
   *  (MOTIR-2250) — `auditCoverageService.getCoverage` asserts `ai:configure`,
   *  so a banner shown to anyone else is an invitation to a 403.
   *
   *  ⚠️ Still passed EXPLICITLY rather than read from `useProjectAccess()` here,
   *  and the reason has changed. It used to be that the `/planning` ROUTE lived
   *  OUTSIDE `(authed)`, so the provider was not mounted and the hook returned
   *  its permissive default. That route is gone (MOTIR-4732) and the overlay
   *  mounts INSIDE `(authed)`, so the provider IS there — the OVERLAY reads it,
   *  with the permission's own name (`can('ai:configure')`), and passes the
   *  answer down. Kept as a prop because this host is presentational about
   *  access: it renders what it is told, and every gate is decided one level up
   *  where the provider is. */
  canManage?: boolean;
  /** Close the workspace. The overlay routes Close, `Esc`, the scrim and a
   *  browser Back through ONE `requestClose()`, which is the seam the pending
   *  guard (MOTIR-4731) intercepts — so this control must call it rather than
   *  navigate.
   *
   *  ⚠️ REQUIRED since MOTIR-4732. It was briefly optional, with a `backHref`
   *  fallback, for exactly one caller: the `(planning)` page, a SERVER Component
   *  that could not hand a function across the boundary. That page is deleted
   *  and the fallback went with it — there is nowhere to navigate BACK to,
   *  because the reader never left. */
  onClose: () => void;
  /**
   * A slot the OVERLAY hands down so this host can VETO a close (MOTIR-4731).
   *
   * The overlay routes Close, `Esc`, the scrim and Back's `popstate` through one
   * `requestClose()` — but the thing that decides whether closing is safe is the
   * conversation state, which lives HERE. So the host writes a predicate into
   * this ref: `true` means *go ahead*, `false` means *I have raised the guard,
   * do not close*. That keeps the seam in one place and the state in one place,
   * with a single function between them.
   *
   * Absent wherever a caller does not want the question asked — a test
   * rendering the host in isolation, for instance. No guard, no veto.
   */
  closeGuardRef?: RefObject<(() => boolean) | null>;
  /**
   * *Keep planning* was chosen after a browser BACK — the one vector that has
   * already happened by the time the guard can ask, so the address no longer
   * says *open*. The overlay puts it back; the host cannot, because it does not
   * know the launch context.
   */
  onKeepPlanningAfterBack?: () => void;
  /** The work item the Plan / Re-plan entrance opened on, resolved server-side
   *  (MOTIR-1491): it is the PRE-FILLED initial target. Null for a project-scoped
   *  launch — or when the `?item=` key no longer resolves. */
  initialTarget?: PlanningTarget | null;
  /**
   * The canvas's ARRIVAL LEVEL (MOTIR-2070) — the anchor's ancestor chain
   * (root→parent) as a breadcrumb trail, resolved server-side alongside the
   * anchor itself. The anchor used to reach only the CONVERSATION: the canvas
   * seeded itself at the project root, so a workspace summoned about a subtask
   * three levels down opened on the epics and drew the item's target ring on a
   * level the user was not on — invisible, and indistinguishable from no anchor
   * at all. Empty for a project launch, for an unresolvable `?item=`, AND for a
   * root-level anchor (an epic is already on the root level).
   */
  initialCanvasTrail?: readonly CanvasCrumb[];
  /**
   * The user has just come BACK from onboarding (MOTIR-4770) — the round trip
   * closed. Passed straight to the rail, because the acknowledgement belongs in
   * the conversation rather than anywhere this component draws.
   */
  justReturnedFromOnboarding?: boolean;
}

export function PlanningWorkspaceHost({
  canManage = false,
  projectKey,
  projectName,
  launch,
  anchorId = null,
  onClose,
  closeGuardRef,
  onKeepPlanningAfterBack,
  initialTarget = null,
  initialCanvasTrail,
  justReturnedFromOnboarding,
}: PlanningWorkspaceHostProps) {
  const t = useTranslations('planningWorkspace');
  const router = useRouter();

  // The turn's TARGET SET (MOTIR-1491). It lives HERE, not in the rail, because
  // both panes read it: the composer collects it and the canvas rings it. The
  // entrance's item seeds it as the INITIAL target — not a locked one, so the
  // user can remove it (⨉) or add more (design panel 5).
  const [targets, setTargets] = useState<PlanningTarget[]>(initialTarget ? [initialTarget] : []);
  const addTarget = useCallback(
    (target: PlanningTarget) => setTargets((current) => addPlanningTarget(current, target)),
    [],
  );
  const removeTarget = useCallback(
    (identifier: string) => setTargets((current) => removePlanningTarget(current, identifier)),
    [],
  );

  // ── THE CLOSE, AND THE ONE QUESTION IT MAY ASK (MOTIR-4731) ───────────────
  //
  // `onClose` is the overlay's `requestClose` — the seam every close vector
  // converges on.
  const [guardOpen, setGuardOpen] = useState(false);
  // Set while a decision THE GUARD took is closing the workspace, so the veto
  // lets that close through. Without it the guard would answer its own question:
  // both decisions are server writes, so the proposal is still pending at the
  // moment *Discard* or *Confirm & add* asks to close.
  const bypassRef = useRef(false);

  const performClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const closeBypassingGuard = useCallback(() => {
    bypassRef.current = true;
    try {
      performClose();
    } finally {
      bypassRef.current = false;
    }
  }, [performClose]);

  const close = performClose;

  // Bumped on every approve: the committed tree is new data, so the canvas island
  // must refetch its level (the server-rendered surfaces take the refresh below).
  const [treeVersion, setTreeVersion] = useState(0);
  // ⚠️ *Confirm & add* CLOSES FROM HERE, not from the `await` (MOTIR-4731). This
  // callback fires on a SUCCESSFUL approve and on nothing else, so it is the one
  // place that knows the write landed — reading `state.decided` after the await
  // would race the re-render that sets it. A FAILED approve simply never reaches
  // here, which leaves the guard up with the conversation's own error: the one
  // case where closing would lose the thing the reader was trying to save.
  const closeAfterApproveRef = useRef(false);
  const onApproved = useCallback(() => {
    setTreeVersion((v) => v + 1);
    router.refresh();
    if (!closeAfterApproveRef.current) return;
    closeAfterApproveRef.current = false;
    setGuardOpen(false);
    closeBypassingGuard();
  }, [router, closeBypassingGuard]);
  const { state, send, retry, correctTurn, approve, discard, stop } = usePlanChangeConversation({
    onApproved,
    anchorId,
    // A NAMED conversation (`planSession=`, a Plans row) reopens that one
    // (MOTIR-6024).
    sessionId: launch.sessionId ?? null,
  });

  // The rail sends TEXT; the anchors come from the set this host owns, so the
  // rail never has to know how a turn is scoped.
  const sendTargeted = useCallback((text: string) => void send(text, targets), [send, targets]);
  const targetIds = targets.map((target) => target.id);

  const index = useMemo(() => indexPlanReview(state.review), [state.review]);
  // One key for "what the canvas is drawing": a new proposal, or a fresh commit.
  const diffKey = `${treeVersion}:${state.jobId ?? 'none'}:${state.decided ?? 'pending'}:${index.counts.added}-${index.counts.changed}-${index.counts.removed}`;

  // THE PREDICATE, from `lib/planning/planPending.ts` — the SAME expression that
  // used to sit inline in the footer slot below, moved into a module so the bar
  // and the guard cannot come to disagree about whether anything is at stake.
  const pending = isProposalPending(state, index);
  const pendingCount = pendingProposalCount(index);
  const deciding = state.phase === 'deciding';
  // ⚠️ THE GUARD'S OWN PREDICATE IS NARROWER THAN `pending` (MOTIR-6037; design Part XX
  // §20.6, §20.11 flag 1): an ASKED plan and a plan being WRITTEN lose nothing on close —
  // the first waits in To approve, the second is a server job — so the guard, whose copy
  // says closing discards them, does not open for either. `pending` still chooses the
  // footer slot's content.
  const guarded = closeLosesProposal(state, index);

  // ── THE PLAN GATE'S DECISION, on this surface (Story MOTIR-6012 · MOTIR-6037) ──────
  // One derivation for the bar and the rail's review block, so the gate and its mirror
  // cannot disagree. A plan run streaming into the plan in hand holds its verbs before
  // the review read can say so.
  const gateView = planGateView({
    review: state.review,
    rewriting: state.phase === 'streaming' && state.planId !== null,
  });
  // ── THE PLAN PAGE'S OWN List | Canvas, ON THIS SURFACE (Subtask MOTIR-6186) ────────
  //
  // Once the conversation holds a PROPOSED plan, the left pane renders the very
  // component the plan page renders — `PlanProposalViews` — instead of the roadmap
  // with the proposal decorated over it. What that page shows, this shows, and a
  // change to one is a change to both: there is no second list, no second review
  // canvas and no second edge computation anywhere on this surface.
  //
  // `state.decided` keeps it mounted after the decision, in Part VI's decided
  // treatment (MOTIR-3162 keeps the review across approve and discard). A new turn
  // clears the review, and the pane falls back to `PlanChangeCanvas` — which is the
  // "no plan" state again, and correct.
  //
  // ⚠️ `generating` is NOT handled here. `isProposedReview` is false for it, so the
  // pane stays on `PlanChangeCanvas` until MOTIR-6158 replaces that phase's pane.
  // Do not add a generating read.
  const review = state.review;
  const showsProposalViews =
    review !== null && (isProposedReview(review) || state.decided !== null);

  // ⚠️ THE VIEW IS LOCAL, AND IT IS NEVER WRITTEN TO THE URL (`design-notes.md`
  // Part XXI 21.4). The plan page keeps it in the URL and is right to; this is an
  // OVERLAY over whichever page the reader is on, so the address bar belongs to
  // that page — and `?view=` is not a free name, because the plan page itself uses
  // it. Back already means one thing here (the overlay routes Close, Esc, the scrim
  // and browser Back through one `requestClose()`, which the pending guard
  // intercepts); a view switch that pushed history would make it mean two.
  //
  // ⚠️ PINNED PER PLAN, exactly as `PlanDetail` pins its own seed (MOTIR-3262). The
  // default is DERIVED from the plan's shape, and a plan's item set can grow under a
  // re-read, so recomputing it per render would yank a reader between views while
  // they were reading. It is re-seeded when the plan in hand CHANGES — a new
  // `planId` — and by nothing else: not by a stale refusal, not by a revision, not
  // by a decision.
  const [view, setView] = useState<PlanViewDto>('canvas');
  const seededForPlanRef = useRef<string | null>(null);
  useEffect(() => {
    if (!review || seededForPlanRef.current === review.id) return;
    seededForPlanRef.current = review.id;
    setView(defaultPlanView(review));
  }, [review]);

  // WHERE Decline's confirm band is up, and where the last press came from — the stale
  // refusal is said beside the verbs it refused (Panel 5). Local UI state: it describes
  // this surface, not the plan.
  const [declineFrom, setDeclineFrom] = useState<PlanDecisionPlace | null>(null);
  const [pressFrom, setPressFrom] = useState<PlanDecisionPlace>('bar');
  const approveFrom = useCallback(
    (place: PlanDecisionPlace) => {
      setPressFrom(place);
      setDeclineFrom(null);
      void approve();
    },
    [approve],
  );
  const confirmDecline = useCallback(
    (noteMd: string | null) => {
      setPressFrom(declineFrom ?? 'bar');
      void (async () => {
        await discard(noteMd);
        setDeclineFrom(null);
      })();
    },
    [discard, declineFrom],
  );
  const staleRefusedAt = state.errorCode === 'stale' ? pressFrom : null;

  // The VETO the overlay consults. Writing it into a ref rather than passing a
  // boolean up keeps the decision here, next to the state it reads, and keeps
  // the overlay's `requestClose` a single function with a single caller shape.
  useEffect(() => {
    if (!closeGuardRef) return;
    closeGuardRef.current = () => {
      if (bypassRef.current) return true;
      if (!guarded) return true;
      setGuardOpen(true);
      return false;
    };
    return () => {
      closeGuardRef.current = null;
    };
  }, [closeGuardRef, guarded]);

  // ⚠️ TWO VECTORS ARE DELIBERATELY NOT GUARDED, and the design says why
  // (`design/ai-chat/design-notes.md` § *Opening & exiting* → *The
  // CLOSE-WITH-PENDING guard*, the vector table):
  //
  //   · A RELOAD or a TAB CLOSE gets no `beforeunload`. A browser's own "leave
  //     site?" dialog cannot carry these three actions, so it would be a strictly
  //     worse version of this one — and it fires on every reload whether or not
  //     there is anything to lose.
  //   · A STREAMING TURN is not guarded. The predicate needs a `review`, and a
  //     stream has none yet, so there is no proposal to lose; closing calls the
  //     conversation's `stop` and the turn is abandoned, which is exactly what
  //     navigating away from the route did.
  //
  // Both are the ABSENCE of code, which is why they are written down: an absence
  // reads as an oversight unless somebody says it was chosen.

  // ⚠️ *Keep planning* is also what `Esc` and the scrim mean ON THE GUARD: the
  // safe answer is the one that loses nothing. After a browser BACK the address
  // has already dropped the overlay, so the overlay puts it back.
  const keepPlanning = useCallback(() => {
    closeAfterApproveRef.current = false;
    setGuardOpen(false);
    onKeepPlanningAfterBack?.();
  }, [onKeepPlanningAfterBack]);

  const discardAndClose = useCallback(() => {
    void (async () => {
      await discard();
      setGuardOpen(false);
      closeBypassingGuard();
    })();
  }, [discard, closeBypassingGuard]);

  // Arms the close and starts the write. Never closes with the approve IN
  // FLIGHT: every action is disabled while `deciding`, and the close happens in
  // `onApproved` above — which fires on success and on nothing else.
  const confirmAndClose = useCallback(() => {
    closeAfterApproveRef.current = true;
    void approve();
  }, [approve]);

  // ⚠️ NO `Esc` LISTENER HERE. It was removed with the route (MOTIR-4729): the
  // dialog owns the key, and the handler that stood here — yielding to a focused
  // field, to `document.fullscreenElement` and to a `defaultPrevented` event —
  // was the second of the two the run modal's design warned about
  // (`design/runs/design-notes.md`: *"a full-screen canvas inside a dialog is
  // exactly where two `ESC` handlers collide. The dialog's must win"*).

  return (
    <PlanningWorkspace
      // ⚠️ THE CHROME-FITTED VARIANT (MOTIR-4729). `PlanningWorkspace`'s default
      // is `h-dvh w-full`, which is right for a component that IS the viewport.
      // Inside the dialog it is not: the panel is already `h-dvh`, and a second
      // `h-dvh` child of it overflows by whatever the panel's own box costs. The
      // variant its own docstring offers is exactly this case.
      className="h-full w-full"
      canvas={
        <div className="flex h-full min-h-0 flex-col bg-(--el-canvas)">
          {/* The shell's own exit chrome + project crumb. The canvas keeps its
              own top-left breadcrumb and top-right search/zoom overlays, so this
              sits ABOVE the canvas rather than over them. */}
          <div className="flex items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2">
            <button
              type="button"
              onClick={close}
              className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <X className="h-4 w-4 shrink-0" aria-hidden />
              {t('close')}
              <kbd className="ml-1 rounded-(--radius-kbd) border border-(--el-border) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[0.6875rem] text-(--el-text-secondary)">
                {t('escKey')}
              </kbd>
            </button>
            <span className="truncate text-sm font-semibold text-(--el-text)">{projectName}</span>
          </div>

          {/* The audit-coverage banner sits in the seam BETWEEN the top bar and
              the panes, full-bleed and unpadded (design/audit-coverage §1). It
              must not be wrapped in a padded container — the full bleed is the
              design. It renders nothing at all for a non-admin, or when every
              connected repo has a report, and reserves no gap when absent. */}
          {canManage ? <AuditCoverageBanner /> : null}

          {/* ⭐ THE BODY AND THE BAR — one box, and the bar FLOATS OVER IT
              (Subtask MOTIR-6186; `design/ai-planning/design-notes.md` Part XXI 21.8).
              ────────────────────────────────────────────────────────────────
              ⚠️ THIS REPLACES MOTIR-1815's FIX RATHER THAN REVERTING IT, and the
              distinction is the whole of this block. That bug was: the bar was a
              `shrink-0` SIBLING below this `min-h-0 flex-1` box, so a bar that
              mounted and unmounted grew and shrank the box by its full height on
              every proposal — and the canvas anchors three control clusters to the
              bottom of the box (the engine's zoom + fit at `bottom-4 left-4`, LOCATE
              at `bottom-4 left-[8.25rem]`, full-screen at `right-3 bottom-4`), so
              all three slid. The fix that shipped was to keep a RESTING FOOTER in the
              slot at all times, which held the box constant by always spending the
              space.

              The resting footer is gone: when there is nothing to show, the footer
              hides. So the box is held constant a better way — it is ALWAYS the full
              remainder of the pane, and the bar is absolutely positioned over its
              bottom edge. Nothing resizes, in either direction, and the space is only
              ever drawn into when there is something to draw.

              `--canvas-foot` is what keeps the clusters off the bar. It is set
              UNCONDITIONALLY — not only while the bar is up — because a value that
              came and went would move them exactly as the old sibling did. The
              canvases read it with a `0px` fallback, so every other surface
              (`/roadmap`, the plan page) is untouched.

              The canvas itself still mounts UNCONDITIONALLY (MOTIR-2069): it reads its
              own root level, so it — not the page — knows whether there is anything to
              draw, and its skeleton and empty statement fill the same box as a drawn
              level. */}
          <div
            className="relative min-h-0 flex-1 overflow-hidden"
            style={{ '--canvas-foot': 'var(--height-plan-confirm-bar)' } as CSSProperties}
          >
            {showsProposalViews ? (
              <PlanProposalViews
                items={review.items}
                outcome={state.decided}
                projectKey={projectKey}
                version={treeVersion}
                ariaLabel={t('canvasAria', { project: projectName })}
                view={view}
                onViewChange={setView}
                // The surface opts IN, and the plan page does not (21.7). A reader
                // who drills the canvas, reads the List and comes back is returned
                // to the level they were on.
                preserveCanvasLevel
              />
            ) : (
              <PlanChangeCanvas
                projectKey={projectKey}
                index={index}
                diffKey={diffKey}
                outcome={state.decided}
                targetIds={targetIds}
                initialTrail={initialCanvasTrail}
                ariaLabel={t('canvasAria', { project: projectName })}
                loadingFallback={<PlanningCanvasSkeleton />}
                emptyRoot={
                  <EmptyState
                    icon={<Map className="h-12 w-12" aria-hidden />}
                    title={t('emptyCanvasTitle')}
                    description={t('emptyCanvasDescription')}
                  />
                }
              />
            )}

            {/* THE GATE, over the body's bottom edge. Shown only while a proposal is
                PENDING (MOTIR-3162: a review survives its decision, so "there is a
                review" does not mean "there is a decision to take" — `state.decided`
                is what does). When there is nothing to decide there is NOTHING HERE:
                the footer hides, and the body runs to the pane's edge. */}
            {pending ? (
              <div className="absolute inset-x-0 bottom-0 z-20">
                <PlanChangeConfirmBar
                  index={index}
                  deciding={state.phase === 'deciding'}
                  onApprove={() => approveFrom('bar')}
                  onDiscard={() => void discard()}
                  view={gateView}
                  declining={declineFrom === 'bar'}
                  onRequestDecline={() => setDeclineFrom('bar')}
                  onCancelDecline={() => setDeclineFrom(null)}
                  onConfirmDecline={confirmDecline}
                  staleRefused={staleRefusedAt === 'bar'}
                />
              </div>
            ) : null}
          </div>
        </div>
      }
      guard={
        // THE CLOSE-WITH-PENDING GUARD (MOTIR-4731), over the whole workspace.
        // Rendered HERE because the state it reads is here; raised by the VETO
        // above, which the overlay's one `requestClose()` consults.
        <PlanCloseGuard
          open={guardOpen}
          count={pendingCount}
          deciding={deciding}
          onKeepPlanning={keepPlanning}
          onDiscard={discardAndClose}
          onConfirm={confirmAndClose}
        />
      }
      chat={
        <PlanChangeRail
          launch={launch}
          projectName={projectName}
          {...(justReturnedFromOnboarding ? { justReturnedFromOnboarding: true } : {})}
          state={state}
          index={index}
          targets={targets}
          onAddTarget={addTarget}
          onRemoveTarget={removeTarget}
          onSend={sendTargeted}
          onRetry={retry}
          onCorrectTurn={correctTurn}
          onApprove={() => approveFrom('rail')}
          onDiscard={() => void discard()}
          onStop={stop}
          gateView={gateView}
          declining={declineFrom === 'rail'}
          onRequestDecline={() => setDeclineFrom('rail')}
          onCancelDecline={() => setDeclineFrom(null)}
          onConfirmDecline={confirmDecline}
          staleRefused={staleRefusedAt === 'rail'}
        />
      }
    />
  );
}
