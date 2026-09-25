// The planning frames' STACKED row template — shared by the fixed frame
// (`PlanningWorkspace`) and the resizable one (`PlanningResizableFrame`), so the
// two cannot drift (MOTIR-6276 fixed the second, MOTIR-6281 the first).
//
// ⚠️ A PLAIN MODULE, DELIBERATELY — no `'use client'`. `PlanningWorkspace` is a
// server-renderable component (`PlanningWorkspaceSkeleton` mounts it), and a
// value exported from a `'use client'` module reaches a server importer as a
// client REFERENCE, not as the string. Keeping the constant in
// `PlanningResizableFrame.tsx` would have handed the fixed frame an object for a
// class name.
//
// Below `md` both frames are ONE column, canvas first and the rail below it
// (MOTIR-6249 §7). Without an explicit row template the two panes sit in IMPLICIT
// `auto` rows, sized from their content: the canvas's drawing area is
// `min-h-0 flex-1` and contributes only its chrome, while the rail has real
// content height, and `auto` tracks share only the FREE space. So the canvas row
// got its chrome and nothing else — 0px of drawn canvas at 767×720 on the
// planning workspace under a long transcript (MOTIR-6276), and on the plan page
// with the rail exactly as it arrives (MOTIR-6281: rows `44px 541px`).
//
// `fr` tracks divide the height regardless of content, and `minmax(0, …)` lets
// each pane scroll inside its own row rather than push the other out. The canvas
// is the pane drawn first and the one a plan is read in, so it takes the larger
// share; the rail keeps a floor tall enough for its header and its composer or
// decision bar. `md:grid-rows-none` returns the split to the single implicit row
// it has always had, so nothing at or above the breakpoint changes.
export const PLANNING_FRAME_STACKED_ROWS =
  'grid-rows-[minmax(0,3fr)_minmax(12rem,2fr)] md:grid-rows-none';
