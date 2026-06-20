import { type ReactNode } from 'react';

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
}

export function PlanningWorkspace({ canvas, chat }: PlanningWorkspaceProps) {
  return (
    <div className="grid h-dvh w-full grid-cols-1 md:grid-cols-[1fr_22rem]">
      {canvas}
      {chat}
    </div>
  );
}
