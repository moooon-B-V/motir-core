import type { AuthoredBug } from '@/lib/ai/authoredBug';

// The ONE diagnosis a debug landing writes (Story MOTIR-7042 · MOTIR-7049), as
// `debugLandingService` consumes it. It used to be parsed from a `debug_bug` job's
// result; that job is retired (AMENDMENT 5), and since MOTIR-9323 the landing builds
// this shape from a CONFIRMED `log_bug` offer (`lib/ai/logBugOffer.ts`), which was
// parsed — never cast — when the answer carrying it settled. So nothing here parses:
// the bounds below are the ones `parseLogBugOffer` applies.

/** The longest new-card title accepted — motir-ai's `DEBUG_BUG_TITLE_MAX`, and
 *  the triage intake's own cap (`MAX_TRIAGE_TITLE_LENGTH`) is no tighter. */
export const DEBUG_TITLE_MAX = 200;
/** The acceptance-criteria bounds motir-ai states (1–8). */
export const DEBUG_CRITERIA_MAX = 8;

interface DebugBugCommon {
  /** The anchored triage bug the diagnosis is ADDED to, or the anchor an
   *  enrichment comment relates to; null for a new bug. Re-resolved under the
   *  sender's access before anything is written. */
  anchorKey: string | null;
  /** The title a NEW card would carry. */
  title: string;
  acceptanceCriteria: string[];
  /** The diagnosis — `parseAuthoredBug`'s validated shape. */
  diagnosis: AuthoredBug;
}

export type DebugBugOutcome =
  | (DebugBugCommon & {
      outcome: 'enrich_existing';
      /** The card the answer READ and judged to cover the defect. */
      workItemKey: string;
      matchReason: string | null;
    })
  | (DebugBugCommon & { outcome: 'diagnose' });
