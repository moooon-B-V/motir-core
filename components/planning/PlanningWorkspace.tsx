import { type ReactNode } from 'react';
import { PlanningResizableFrame } from '@/components/planning/PlanningResizableFrame';

// The reusable AI planning workspace shell (introduced by Subtask 7.3.5 /
// MOTIR-833). The full-screen, two-pane frame EVERY AI-planning surface shares:
// the canvas on the LEFT, the chat rail on the RIGHT — nothing else.
//
// This is the "one planning interface" foundation (Yue, 2026-06-20): the
// canvas+chat STRUCTURE is identical across the planning surfaces; only the
// canvas content + the chat driver differ per case. Onboarding (7.3) is the
// FIRST, specialized consumer; generation review (7.4), re-planning (7.11),
// contextual planning (7.12) and the persistent roadmap (7.19) REUSE this same
// shell rather than each building their own. Presentational: it owns only the
// full-screen two-pane layout; each consumer supplies its own `canvas` + `chat`.
export interface PlanningWorkspaceProps {
  /** The left pane — the roadmap / work-item canvas. */
  canvas: ReactNode;
  /** The right pane — the AI planning chat rail. */
  chat: ReactNode;
  /**
   * An overlay the workspace raises over BOTH panes — today the
   * close-with-pending guard (MOTIR-4731). Rendered as a sibling of the grid
   * rather than inside a pane, because it is about the workspace as a whole and
   * a dialog nested in a `min-h-0` grid cell inherits that cell's clipping.
   * Absent everywhere it is not passed, and it reserves no space.
   */
  guard?: ReactNode;
  /** Sizing override for the two-pane container. Defaults to the full-screen
   *  `h-dvh w-full` the onboarding consumer wants; a surface mounted INSIDE the
   *  app chrome (e.g. the plan detail) passes `h-full w-full` to fill a
   *  chrome-fitted container instead of the viewport. The grid columns are
   *  unchanged. */
  className?: string;
  /**
   * OPT IN to the RESIZABLE split (MOTIR-6250) — a conversation pane that opens
   * at a third, a divider that drags, and a reset when a plan is proposed, all
   * built to MOTIR-6249's approved design.
   *
   * ⚠️ OPT-IN, NOT THE DEFAULT, AND THAT IS A SCOPE DECISION RATHER THAN
   * CAUTION. This shell has five consumers, and the split belongs to exactly one
   * of them: the planning workspace (`PlanningWorkspaceHost`). Both cards in the
   * story say so in terms — MOTIR-6250's boundary is *"Does NOT change: … the
   * plan page's rail"*, and MOTIR-6236's is *"This host is NOT a split — it keeps
   * its own rail width"*. `PlanDetail`, `GenerationFlow`, `DiscoveryOnboarding`
   * and `PlanningWorkspaceSkeleton` therefore keep the FIXED `22rem` column,
   * byte for byte, and a `false` here renders the identical markup it always did.
   *
   * It is the same shape MOTIR-6237 used one file over for `Textarea`'s
   * auto-grow — *"every current caller keeps its fixed `rows`"* — which is the
   * precedent in this very story set.
   */
  resizable?: boolean;
  /**
   * Whether a plan PROPOSAL is present. Read ONLY when `resizable` is set: it is
   * what the reset fires on, at the moment a proposal arrives in the workspace's
   * state rather than on a route change.
   */
  proposalPresent?: boolean;
}

export function PlanningWorkspace({
  canvas,
  chat,
  guard,
  className,
  resizable = false,
  proposalPresent = false,
}: PlanningWorkspaceProps) {
  if (resizable) {
    return (
      <>
        <PlanningResizableFrame
          canvas={canvas}
          chat={chat}
          proposalPresent={proposalPresent}
          className={className}
        />
        {guard}
      </>
    );
  }
  return (
    <>
      <div className={`grid grid-cols-1 md:grid-cols-[1fr_22rem] ${className ?? 'h-dvh w-full'}`}>
        {canvas}
        {chat}
      </div>
      {guard}
    </>
  );
}
