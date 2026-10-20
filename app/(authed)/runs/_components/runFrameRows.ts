// The run overlay's two host-owned facts about its split (MOTIR-9072). The frame
// itself is the shared `ResizableSplit`; these are what it asks its host for.
//
// ⚠️ A PLAIN MODULE, DELIBERATELY — no `'use client'`, following
// `components/planning/planningFrameRows.ts`: a value exported from a client
// module reaches a non-client importer (a suite, Tailwind's scanner) as a client
// REFERENCE and not as the string, and one home is what lets a test assert the
// literals instead of retyping them.

// Below `md` the panes stack. The run's left pane is a canvas that pans and zooms
// while its right pane is a text log, so the log takes the larger share — unlike
// the planning frame, where the canvas is the pane a plan is read in — with a
// floor tall enough for its header, phase chip and findings strip.
// `md:grid-rows-none` returns the split to its single implicit row.
export const RUN_FRAME_STACKED_ROWS =
  'grid-rows-[minmax(0,2fr)_minmax(14rem,3fr)] md:grid-rows-none';

// This host's OWN persisted-width key, so no caller can inherit the planning
// workspace's width by omission. Global rather than per run or per project: the
// number is about the reader's screen, not about a run (the same reasoning
// `lib/planning/railWidth.ts` records for the planning key).
export const RUN_LOG_WIDTH_STORAGE_KEY = 'motir.runs.logWidth';
