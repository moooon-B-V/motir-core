'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';
import { PlanningWorkspaceSkeleton } from '@/components/planning/PlanningWorkspaceSkeleton';
import { useProjectAccess } from '@/app/(authed)/_components/ProjectAccessProvider';
import {
  parsePlanningOverlay,
  withoutPlanningOverlay,
  withPlanningOverlay,
  OVERLAY_PARAM_NAMES,
  type PlanningLaunch,
  type PlanningLaunchContext,
} from '@/lib/planning/launcher';
import { resolvePlanningHostGate } from '@/lib/planning/workspaceHost';
import { fetchPlanningAnchor } from '@/lib/planning/planningAnchorClient';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import { workItemCrumbLabel, type CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import type { PlanningTarget } from '@/lib/planning/planningTargets';

// THE PLANNING WORKSPACE OVERLAY (MOTIR-4729, under story MOTIR-4725) — the
// workspace as a full-screen layer over whatever authed page is open, which is
// what `design/ai-chat/design-notes.md` § *Opening & exiting — a full-screen
// overlay ON TOP of the app (sheet 6)* has specified since MOTIR-1193 and what
// the `(planning)` ROUTE could not be.
//
// ⚠️ THE OPEN STATE IS THE ADDRESS, AND IS HELD NOWHERE ELSE. It is open when
// `parsePlanningOverlay` finds the overlay's four namespaced parameters in the
// query (MOTIR-4728), and it closes by writing them away. `RunsIndex.tsx`
// derives `openRunId` the same way, and the property is what buys the two things
// this story promises for free: **browser Back closes it** (a `popstate` changes
// what `useSearchParams` reports, and no code has to notice), and no second
// source of truth can ever disagree with the address bar.
//
// ⚠️ IT IS THE SHIPPED `Modal`, NOT A HAND-ROLLED OVERLAY. Focus trapping, the
// Escape key and focus RETURN are the parts of an overlay that go wrong quietly,
// and the product has paid to get them right once. `size="full"` +
// `rounded-none border-0 p-0` is the EDGE-TO-EDGE composition the design
// measured and chose over an inset (it would cost the canvas 48px in each axis
// at every viewport, on the surface with the most canvas need); `hideClose`
// suppresses the dialog's own corner ✕, because the host renders its Close
// top-left and two Closes in one dialog is a question the reader should never be
// asked.
//
// ⚠️ THE ORB SITS BEHIND THE SCRIM, and it needs no code. `PlanWithAIFab` is
// `fixed … z-40`; `Dialog.Overlay` is `fixed inset-0 z-40` and is PORTALLED, so
// it comes later in the document and wins the tie — the orb is dimmed and inert
// with the rest of the app, which is what "the app stays mounted, dimmed +
// inert, behind it" means. `Dialog.Content` is `z-50`, above both. The run modal
// lands in exactly the same place for the same reason.
//
// ⚠️ EVERY CLOSE GOES THROUGH `requestClose()`. Close, Escape, the scrim and the
// history pop all land on that one function, because the close-with-pending
// guard (MOTIR-4731) intercepts exactly it. The seam is the deliverable; the
// behaviour behind it is that card's.
//
// ── What the ROUTE did on the server, this does in the browser ──────────────
//
//   session + 2FA + re-consent  → inherited: `app/(authed)/layout.tsx` runs both
//                                 ahead of `children`, and this is a child.
//   the active project           → props, from the layout that already has it.
//   canBrowse / the admin gate   → `useProjectAccess()`. The provider IS mounted
//                                 in `(authed)`, which is the whole reason the
//                                 page had to pass `canManage` by prop.
//   `resolvePlanningHostGate`    → reused as-is (it is pure).
//   the anchor + its ancestors   → `fetchPlanningAnchor` over HTTP (MOTIR-4727),
//                                 because a client island may not reach a service.
//
// ── PAGE STATE AFTER A MUTATION (`motir-core/CLAUDE.md`) ────────────────────
// An approve commits work items, so the page BEHIND the overlay is stale the
// moment the reader closes it. The host already does both halves for its own
// surfaces — `router.refresh()` for the server-rendered ones and a `treeVersion`
// tick for the canvas, which is a client island seeded once. The host page
// underneath gets the SAME split and it is not this component's to bump: a
// backlog's `IssueTreeTable` and a board's `BoardContainer` are islands that
// watch `CreateIssueProvider.issuesChangedAt`, so a story that has the overlay
// commit work items behind an open board owes that tick. Nothing here seeds them,
// and `router.refresh()` alone will not reach them.

export interface PlanningWorkspaceOverlayProps {
  /** The active project's `MOTIR`-style key. */
  projectKey: string;
  projectName: string;
  /**
   * The project's immutable onboarding-ran marker, serialised. Null means
   * onboarding still owns this project's journey and the workspace forwards
   * rather than opening — the SAME marker `/onboarding`'s own redirect reads,
   * so the two surfaces cannot disagree.
   */
  onboardingRanAt: string | null;
}

/**
 * What the anchor read SETTLED on, and for which key.
 *
 * There is no `loading` member on purpose: the pending state is DERIVED at
 * render (`settled.key !== anchorKey`), never written in the effect. That is the
 * quick view's own shape and it is what keeps this out of
 * `react-hooks/set-state-in-effect` — a synchronous `setState` in an effect body
 * is a cascading render, and here it would also mean the previous item's chip
 * could flash under the new item's address.
 */
interface AnchorLoad {
  key: string;
  target: PlanningTarget | null;
  trail: CanvasCrumb[];
}

export function PlanningWorkspaceOverlay({
  projectKey,
  projectName,
  onboardingRanAt,
}: PlanningWorkspaceOverlayProps) {
  const t = useTranslations('planningWorkspace');
  const ta = useTranslations('projectAccess');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { can } = useProjectAccess();

  // The host's veto (MOTIR-4731) — see `requestClose`.
  const closeGuardRef = useRef<(() => boolean) | null>(null);

  // ⚠️ BROWSER BACK IS THE VECTOR THAT HAS ALREADY HAPPENED. Every other close
  // can be intercepted BEFORE anything changes; a history pop cannot — by the
  // time the overlay notices, the address no longer carries the workspace. So
  // when a pop takes the overlay out of the address while the host vetoes, the
  // launch is HELD: the dialog stays mounted with the guard up, over an address
  // that already says closed, and *Keep planning* re-pushes it.
  // (`design/ai-chat/design-notes.md` § *Opening & exiting* → the guard's vector
  // table.) *Discard* and *Confirm & add* let the pop stand.
  const [heldLaunch, setHeldLaunch] = useState<PlanningLaunch | null>(null);

  const addressLaunch = useMemo(() => parsePlanningOverlay(searchParams), [searchParams]);
  // The address decides, EXCEPT while a vetoed history pop is being answered.
  const launch = addressLaunch ?? heldLaunch;
  const open = launch !== null;
  const anchorKey = launch?.itemKey ?? null;

  // The current address, as the reader's browser has it — the thing Close writes
  // back minus four parameters. Composed from the two hooks rather than read off
  // `window.location`, so it is stable across a render and safe on the server.
  const currentHref = useMemo(() => {
    const qs = searchParams.toString();
    return `${pathname}${qs ? `?${qs}` : ''}`;
  }, [pathname, searchParams]);

  // ⚠️ FOCUS RETURN, and why it is not free here. Radix restores focus to the
  // element that had it when the dialog opened — but only when the dialog is
  // opened by its own `Trigger`. This one is opened by a URL write from a door
  // that may itself be unmounting (⌘K closes its palette; a menu row closes its
  // popover), so the element to come back to is recorded at the moment the
  // address changes and restored by hand.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (!open && wasOpenRef.current) {
      const opener = openerRef.current;
      openerRef.current = null;
      // `isConnected` because the door may have gone away with its own menu.
      if (opener?.isConnected) opener.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  /**
   * THE ONE CLOSE. Every vector routes here, and the pending guard (MOTIR-4731)
   * wraps exactly this function.
   *
   * `shallowPush`, never `router.push`: the destination body is already in the
   * browser — it is the page that never unmounted — so a server round trip would
   * re-render a page to show what is already on screen, and would throw away the
   * scroll position and the client islands this story exists to preserve
   * (`CLAUDE.md` § *URL state the CLIENT reads is written with `shallowPush`*).
   */
  const requestClose = useCallback(() => {
    // ⚠️ THE HOST MAY VETO (MOTIR-4731). It writes a predicate into this ref: a
    // `false` means it has raised the close-with-pending guard and the workspace
    // must stay. Every vector runs through here, so the guard is asked exactly
    // once per close attempt and there is no vector it can miss.
    if (closeGuardRef.current && !closeGuardRef.current()) return;
    setHeldLaunch(null);
    shallowPush(withoutPlanningOverlay(currentHref));
  }, [currentHref]);

  // ⚠️ THE POP HOLD. `popstate` fires AFTER the browser has already navigated,
  // so this reads the address as it now stands: if the overlay has left it and
  // the host vetoes, the launch is held and the guard asks over a workspace
  // whose address already says closed. Registered as a real listener rather than
  // derived, because a pop is an EVENT and setting state from an event handler
  // is exactly what React allows (deriving it in an effect body is the
  // cascading render `react-hooks/set-state-in-effect` forbids).
  const launchRef = useRef<PlanningLaunch | null>(null);
  useEffect(() => {
    launchRef.current = launch;
  }, [launch]);
  useEffect(() => {
    function onPopState() {
      if (new URLSearchParams(window.location.search).has(OVERLAY_PARAM_NAMES.mode)) return;
      const leaving = launchRef.current;
      if (!leaving) return;
      if (!closeGuardRef.current || closeGuardRef.current()) return;
      setHeldLaunch(leaving);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  /**
   * *Keep planning*, after a Back. The pop has happened, so the workspace is only
   * on screen because it is HELD — put its address back with ONE `shallowPush`
   * so Back means what it says again, and release the hold.
   */
  const keepPlanningAfterBack = useCallback(() => {
    const held = heldLaunch;
    if (!held) return;
    setHeldLaunch(null);
    shallowPush(withPlanningOverlay(currentHref, launchContext(held)));
  }, [heldLaunch, currentHref]);

  // ── THE GATE ───────────────────────────────────────────────────────────────
  // `no-project` cannot occur: the mount itself is behind `Boolean(activeProject)`
  // in the layout, the same gate the orb is behind.
  const gate = resolvePlanningHostGate({
    hasActiveProject: true,
    canBrowse: can('project:browse'),
    onboardingRanAt,
  });

  // Never onboarded → onboarding still owns this project (it decides between the
  // start-fresh entrance and the migrate wizard). A REAL navigation, with the
  // overlay stripped so returning does not immediately re-open it.
  useEffect(() => {
    if (!open || gate !== 'onboarding') return;
    router.push(ONBOARDING_ENTRY_PATH);
  }, [open, gate, router]);

  // ── THE ANCHOR READ ────────────────────────────────────────────────────────
  // Only a `work-item` launch has one. The dialog frame is up while it is in
  // flight — the skeleton renders INSIDE the dialog, which is what
  // `app/(planning)/loading.tsx` used to do for the navigation.
  const [anchor, setAnchor] = useState<AnchorLoad | null>(null);
  useEffect(() => {
    if (!open || anchorKey === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const found = await fetchPlanningAnchor(anchorKey, controller.signal);
        if (controller.signal.aborted) return;
        setAnchor({
          key: anchorKey,
          // A `null` is the no-existence-leak answer for a stale, deleted,
          // foreign or forbidden key alike — it degrades to the project
          // conversation at the root, never a dead workspace and never an error
          // surface. This is the page's own silent `catch`, one hop over.
          target: found && {
            id: found.anchor.id,
            identifier: found.anchor.identifier,
            title: found.anchor.title,
            kind: found.anchor.kind,
          },
          // ANCESTORS ONLY (MOTIR-2070): the LAST crumb is the level the canvas
          // loads, so the workspace opens on the anchor's OWN level with its
          // siblings and dependency edges around it. Opening on the anchor's
          // CHILDREN would hide the item the conversation is about.
          trail: (found?.ancestors ?? []).map((a) => ({
            id: a.id,
            label: workItemCrumbLabel(a.identifier, a.title),
          })),
        });
      } catch {
        if (controller.signal.aborted) return;
        // A real failure is the same degradation as a 404. The workspace opens;
        // it is simply not scoped to the item, which is strictly better than an
        // error panel inside a planning surface.
        setAnchor({ key: anchorKey, target: null, trail: [] });
      }
    })();
    return () => controller.abort();
  }, [open, anchorKey]);

  if (!open || gate === 'onboarding') return null;

  // The anchor's result is only usable while it is still the key in the address:
  // a re-target swaps `anchorKey` before the new read lands, and the previous
  // item's chip must not appear under the new one's address.
  const settled = anchor !== null && anchor.key === anchorKey ? anchor : null;
  const waitingForAnchor = anchorKey !== null && settled === null;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        // Escape and the scrim both arrive here. Radix has not closed anything
        // yet — the dialog is controlled — so this IS the interception point.
        if (!next) requestClose();
      }}
      size="full"
      srTitle={t('canvasAria', { project: projectName })}
      // At full size the dialog IS the surface, so the panel chrome comes off —
      // the run modal's line, and the design's measured decision: edge to edge,
      // 0px radius, 0px border.
      className="flex flex-col rounded-none border-0 p-0"
      // The workspace carries its own Close, top-left. See the header note.
      hideClose
    >
      {/* modal-scroll-container: measured 1280x700, tallest = the HOST with a full conversation in the rail and a drilled canvas; the full-size panel IS the viewport and the canvas, the rail and the host's exit bar each own their scroll (min-h-0 flex-1 overflow-auto), panel 700px */}
      {gate === 'no-access' ? (
        // The run modal's `missing` shape: say so, and get out of the way. Never
        // a 404 — there is no route to 404, and the page underneath is still
        // perfectly usable.
        <div className="flex flex-1 items-center justify-center p-(--spacing-card-padding)">
          <NoAccessState
            title={ta('noAccessTitle')}
            description={ta('noAccessDescription')}
            backHref="/dashboard"
            backLabel={ta('backToProjects')}
          />
        </div>
      ) : waitingForAnchor ? (
        <PlanningWorkspaceSkeleton />
      ) : (
        <PlanningWorkspaceHost
          // A DIFFERENT ANCHOR IS A DIFFERENT WORKSPACE — so remount on it. The
          // host seeds three things from its props ONCE, in `useState`
          // initializers: the canvas's arrival level, the pre-filled
          // `@`-mention target set, and the conversation the anchor scopes.
          //
          // Keyed on the anchor ALONE, deliberately: the seeds derive from
          // nothing else, so an approve's `router.refresh()` — same anchor —
          // must NOT remount and throw away the conversation and the canvas's
          // drill state. The workspace contains a door back into itself (the
          // canvas's own quick-view carries the per-item Plan / Re-plan
          // entrance), so a re-target is a same-address change that React would
          // otherwise reconcile in place, leaving the chrome saying one item
          // while the canvas sat on the level it happened to be on.
          key={anchorKey ?? 'project'}
          projectKey={projectKey}
          projectName={projectName}
          launch={launch}
          anchorId={settled?.target?.id ?? null}
          onClose={requestClose}
          closeGuardRef={closeGuardRef}
          onKeepPlanningAfterBack={keepPlanningAfterBack}
          // Named by the permission its own server gate asserts, not by a rank:
          // `auditCoverageService.getCoverage` asserts `ai:configure`, so that is
          // what decides whether the banner is an invitation or a 403.
          canManage={can('ai:configure')}
          initialTarget={settled?.target ?? null}
          initialCanvasTrail={settled?.trail}
        />
      )}
    </Modal>
  );
}

/**
 * A parsed launch back as the CONTEXT that produced it — what
 * `withPlanningOverlay` needs to re-write the address after a vetoed Back.
 *
 * The mode is not carried: it is DERIVED from the context by
 * `resolvePlanningMode`, and a launch that came from a door round-trips exactly.
 * The one lossy case is `hasPlan`, which the address never carried either — a
 * `replan` launch re-pushes as its coarse origin, and the workspace it re-opens
 * is the one already on screen, so nothing the reader can see changes.
 */
function launchContext(launch: PlanningLaunch): PlanningLaunchContext {
  if (launch.from === 'work-item' && launch.itemKey) {
    return { kind: 'work-item', itemKey: launch.itemKey, hasPlan: launch.mode === 'replan' };
  }
  if (launch.from === 'convention-refine' && launch.repoKey) {
    return { kind: 'convention-refine', repoKey: launch.repoKey };
  }
  if (launch.from === 'roadmap') return { kind: 'roadmap' };
  return { kind: 'project', hasPlan: launch.mode === 'replan' ? true : undefined };
}
