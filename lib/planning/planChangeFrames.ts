// THE FRAME CONTRACT (Story MOTIR-4054 · MOTIR-4069) — what a planning run can
// say, and what the rail does with each thing it says.
//
// ⚠️ THIS FILE EXISTS BECAUSE THE CONTRACT DID NOT. MOTIR-4069 asks for a
// renderer that is TOTAL "over the frame contract … enumerated from the contract,
// never from a hand-written list". There was nothing to enumerate from: a frame's
// kind is a bare `string` on both sides of the wire — `motir-ai`'s emitter is
// `(event: string, data: unknown) => Promise<void>` — so no union, no enum and no
// schema existed in either repository. The card's premise was false in a way that
// is only visible from here, and this module is the repair: the enumeration has
// to live SOMEWHERE before anything can be total over it.
//
// ⚠️ AND THE NUMBERS ARE WORSE THAN THE CARD SAYS. It reports that `retrieval`
// narrates nothing. Swept across `motir-ai`'s `origin/main` — every `emit(…)`,
// `signal(…)` and `event:` literal — the producer emits **51 distinct kinds**,
// and `narrateFrame` handled **seven**. Forty-four were dropped through
// `default: return null`, silently, with no signature: nothing threw, nothing
// logged, the rail simply said less than the run did.
//
// ── WHY A MAP, AND WHY `Record` ─────────────────────────────────────────────
// `FRAME_DISPOSITIONS` is typed `Record<PlanChangeFrameKind, FrameDisposition>`,
// so a kind added to {@link PLAN_CHANGE_FRAME_KINDS} without a disposition is a
// COMPILE ERROR. That is stronger than a test: the renderer and the enumeration
// cannot drift apart, because they are the same object. The card's warning —
// "or the test drifts the same way the renderer did" — is answered by there being
// nothing for the test to hold its own copy of.
//
// ── TOTAL MEANS ACCOUNTED FOR, NOT SHOWN ────────────────────────────────────
// The card's own words are that "the renderer accounts for every frame kind",
// and the distinction is load-bearing. A line for all 51 would make the rail a
// LOG, which `design/ai-chat/plan-change-run-live.mock.html` sheet 3 rejects in
// as many words — "a rail read line-by-line is a log, not narration". So a
// disposition is either SHOW (a drawn act line) or QUIET (a decision, with the
// reason written down). What is forbidden is neither: a kind that falls through.
//
// ⚠️ WHAT THIS FILE CANNOT DO, said plainly rather than left to be discovered:
// it does not track `motir-ai`. The list below is a SNAPSHOT of a sweep, and a
// kind added upstream tomorrow will not appear in it. That is what the LOUD
// default is for, and it is the only mechanism here that covers the future —
// `narrateFrame` never returns a silent null for an unknown kind, so a new frame
// surfaces where a developer sees it instead of vanishing. Do not read the
// snapshot as a guarantee; read it as the set somebody has actually decided
// about.

import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';

/**
 * Every frame kind `motir-ai` emitted on `origin/main` at the time of the sweep
 * (2026-09-03), from every call shape: `ctx.emit(…)`, `sink.signal(…)` and the
 * `{ event: … }` literals the handlers push.
 *
 * ⚠️ NOT ALPHABETICAL BY ACCIDENT — it is sorted so the next sweep's `sort -u`
 * output diffs cleanly against it. Re-run:
 *
 *   git grep -ohE "emit\??\.?\(\s*'[a-z_]+'|signal\??\.?\(\s*'[a-z_]+'|event: '[a-z_]+'" \
 *     origin/main -- src | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u
 */
export const PLAN_CHANGE_FRAME_KINDS = [
  'assistant',
  'audit',
  'author',
  'code_graph',
  'comparables',
  'contextual_context',
  'contextual_scope',
  'convention',
  'conversation',
  'discovery_doc',
  'docs',
  'done',
  'drill',
  'error',
  'explanation',
  'feasibility_doc',
  'feature_catalog',
  'info',
  'lay',
  'lessons_injected',
  'level_complete',
  'neighbourhood',
  'note',
  'packed',
  'partition',
  'pass',
  'pending_plans',
  'plan_cleared',
  'planned',
  'provenance',
  'read',
  'retrieval',
  'retrieval_ready',
  'revision_landed',
  'revision_seeded',
  'revisions',
  'scanner',
  'search',
  'state',
  'status',
  'target_read',
  'target_settled',
  'token',
  'turn',
  'validate_early_ask',
  'validated',
  'validation_doc',
  'validation_skipped',
  'validity_reopen',
  'vision_doc',
  'wired',
] as const;

export type PlanChangeFrameKind = (typeof PLAN_CHANGE_FRAME_KINDS)[number];

/**
 * What the rail does with one frame kind.
 *
 * `quiet` carries its REASON as a string rather than being a bare `false`,
 * because the whole failure this card repairs was a silent decision nobody
 * wrote down. A reason is what makes "we do not show this" reviewable.
 */
export type FrameDisposition =
  | { readonly show: PlanChangeProgress['kind'] }
  | { readonly quiet: string };

/** Not part of the drawn act set — the standing reason for most of the list. */
const NOT_AN_ACT = 'not one of the acts MOTIR-4066 sheet 3 draws on the rail';
/** Emitted by a job kind whose frames never reach this surface. */
const OTHER_SURFACE = 'belongs to another job kind; it does not reach the plan-change rail';
/** Bookkeeping the run keeps for itself. */
const BOOKKEEPING = 'internal bookkeeping — it says nothing a reader of the run would act on';

/**
 * The TOTAL map. Exhaustive by type: adding a member to
 * {@link PLAN_CHANGE_FRAME_KINDS} without a line here does not compile.
 *
 * The SHOW set is the story's own sentence — *"searching, reading code, laying a
 * level, authoring a card, drilling … and the planner's own prose line"* — plus
 * the outcome frames the rail already narrated before this card.
 */
export const FRAME_DISPOSITIONS: Record<PlanChangeFrameKind, FrameDisposition> = {
  // ── THE ACTS (the story's sentence, and sheet 3's table) ──────────────────
  search: { show: 'searching' },
  /** ⚠️ THE FRAME THIS CARD IS FOR. Emitted on every graph lookup the planner
   *  makes, carrying `{ tool, family }` over five families, plus a
   *  `blocked: true` variant when the per-job retrieval budget is spent. It has
   *  been emitted all along and rendered by nothing. */
  retrieval: { show: 'retrieval' },
  drill: { show: 'drilling' },
  lay: { show: 'laying' },
  author: { show: 'authoring' },
  /** The planner's own PROSE line. The producer emits nothing at all when the
   *  text is blank (`signalNote` returns early), so "its absence is not an empty
   *  row" is guaranteed upstream as well as here. */
  note: { show: 'note' },

  // ── THE OUTCOMES (narrated before this card; unchanged by it) ─────────────
  pass: { show: 'proposed' },
  planned: { show: 'proposed' },
  level_complete: { show: 'proposed' },
  validated: { show: 'validating' },
  validation_skipped: { show: 'validating' },

  // ── ACCOUNTED FOR, AND DELIBERATELY QUIET ────────────────────────────────
  // `done` and `error` are the stream's own control frames: `consumeStream`
  // handles both before `onFrame` ever sees them, so narrating them here would
  // draw a line for an event the rail has already acted on.
  done: { quiet: 'a stream control frame, consumed by the transport before narration' },
  error: { quiet: 'a stream control frame, surfaced as the run’s error state instead' },

  assistant: { quiet: OTHER_SURFACE },
  conversation: { quiet: OTHER_SURFACE },
  turn: { quiet: OTHER_SURFACE },
  explanation: { quiet: OTHER_SURFACE },
  convention: { quiet: OTHER_SURFACE },
  scanner: { quiet: OTHER_SURFACE },
  code_graph: { quiet: OTHER_SURFACE },
  audit: { quiet: OTHER_SURFACE },
  comparables: { quiet: OTHER_SURFACE },
  discovery_doc: { quiet: OTHER_SURFACE },
  feasibility_doc: { quiet: OTHER_SURFACE },
  validation_doc: { quiet: OTHER_SURFACE },
  vision_doc: { quiet: OTHER_SURFACE },
  feature_catalog: { quiet: OTHER_SURFACE },
  docs: { quiet: OTHER_SURFACE },
  revisions: { quiet: OTHER_SURFACE },
  revision_seeded: { quiet: OTHER_SURFACE },
  revision_landed: { quiet: OTHER_SURFACE },
  pending_plans: { quiet: OTHER_SURFACE },
  plan_cleared: { quiet: OTHER_SURFACE },
  validate_early_ask: { quiet: OTHER_SURFACE },
  validity_reopen: { quiet: OTHER_SURFACE },

  token: { quiet: BOOKKEEPING },
  packed: { quiet: BOOKKEEPING },
  wired: { quiet: BOOKKEEPING },
  provenance: { quiet: BOOKKEEPING },
  state: { quiet: BOOKKEEPING },
  status: { quiet: BOOKKEEPING },
  info: { quiet: BOOKKEEPING },
  lessons_injected: { quiet: BOOKKEEPING },
  retrieval_ready: { quiet: BOOKKEEPING },

  read: { quiet: NOT_AN_ACT },
  partition: { quiet: NOT_AN_ACT },
  neighbourhood: { quiet: NOT_AN_ACT },
  contextual_context: { quiet: NOT_AN_ACT },
  contextual_scope: { quiet: NOT_AN_ACT },
  target_read: { quiet: NOT_AN_ACT },
  target_settled: { quiet: NOT_AN_ACT },
};

/** Is this a kind somebody has decided about? */
export function isKnownFrameKind(event: string): event is PlanChangeFrameKind {
  return Object.prototype.hasOwnProperty.call(FRAME_DISPOSITIONS, event);
}
