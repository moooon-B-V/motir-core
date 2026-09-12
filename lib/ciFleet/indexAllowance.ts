// THE INDEX ALLOWANCE, AS MOTIR-CORE READS IT (MOTIR-4593 · Story MOTIR-4335).
//
// motir-ai owns the allowance: the two pools, the rate, the verdict
// (`motir-ai` MOTIR-4592 / MOTIR-5284, `docs/contract.md` § index-check /
// index-draw). motir-core owns the container-seconds and the dispatch. This
// module is the vocabulary between the two: pure, so a test and a job read the
// same rules.
//
// ⚠️⚠️ MOTIR DOES NOT CHARGE FOR CODE INDEXING. The allowance is internal cost
// accounting on Motir's own compute. Nothing here reaches a customer surface, and
// nothing here touches the visible credit balance.
//
// ⚠️ ONLY A HARD STOP PREVENTS A BOOT. `soft_gate_crossed` — a paid tier past its
// allowance — BOOTS, and motir-ai records the crossing. A soft gate that refused
// would destroy the instrument: the crossing rate is what says whether the gate is
// mis-sized, and a gate that blocks can never measure how often it was wrong.

/** The verdicts motir-ai names today. The type stays OPEN (`string`) on the wire:
 *  a verdict added there (hard gate B, MOTIR-5280) must reach the family rule
 *  below rather than be refused by a parser that never heard of it. */
export const KNOWN_INDEX_ALLOWANCE_OUTCOMES = [
  'ok',
  'soft_gate_crossed',
  'hard_stop_no_credit',
  'hard_stop_allowance_exhausted',
  'no_allowance_configured',
  'exempt',
] as const;

export type KnownIndexAllowanceOutcome = (typeof KNOWN_INDEX_ALLOWANCE_OUTCOMES)[number];

/** A verdict from `POST /v1/credits/index-check` or `/index-draw`. */
export interface IndexAllowanceVerdict {
  /** A known outcome, or a newer `hard_stop_*` / other value motir-ai added. */
  outcome: string;
  window: string | null;
  grantedCredits: number | null;
  consumedCredits: number | null;
  attributedCredits: number;
}

/** The reason recorded on a repository whose index was paused by a hard stop —
 *  `hard_stop_no_credit` → `paused_index_no_credit`. */
export type IndexPauseReason = `paused_index_${string}`;

const HARD_STOP_PREFIX = 'hard_stop_';

/**
 * Does this verdict stop the container from booting?
 *
 * ⚠️ IT KEYS ON THE OUTCOME FAMILY, NOT ON A LIST OF NAMES (MOTIR-4593 AC 4). Hard
 * gate B's `hard_stop_headroom_exhausted` lands in motir-ai separately; when it
 * does, it is refused here with no change. A list of the two stops known today
 * would boot the third.
 */
export function isIndexHardStop(outcome: string): boolean {
  return outcome.startsWith(HARD_STOP_PREFIX) && outcome.length > HARD_STOP_PREFIX.length;
}

/** The recorded pause reason for a hard stop, or `null` for a verdict that boots. */
export function indexPauseReasonFor(outcome: string): IndexPauseReason | null {
  if (!isIndexHardStop(outcome)) return null;
  return `paused_index_${outcome.slice(HARD_STOP_PREFIX.length)}`;
}

/**
 * Parse a verdict body, or `null` when it is not one.
 *
 * ⚠️ `null` IS "COULD NOT ASK", NEVER A VERDICT. A body without a string `outcome`
 * — an error envelope, an older motir-ai answering 404, a proxy page — must not be
 * read as `ok` and must not be read as a stop. The caller decides what not
 * knowing means.
 */
export function parseIndexAllowanceVerdict(body: unknown): IndexAllowanceVerdict | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b['outcome'] !== 'string' || b['outcome'] === '') return null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    outcome: b['outcome'],
    window: typeof b['window'] === 'string' ? b['window'] : null,
    grantedCredits: num(b['grantedCredits']),
    consumedCredits: num(b['consumedCredits']),
    attributedCredits: num(b['attributedCredits']) ?? 0,
  };
}

/** The draw's idempotency key: ONE draw per container, whatever replays. */
export function indexDrawKey(containerProvider: string, containerId: string): string {
  return `index-container:${containerProvider}:${containerId}`;
}
