import type { ExecutorDto, WorkItemDifficultyDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import { WORK_ITEM_DIFFICULTIES, isWorkItemDifficulty } from '@/lib/issues/difficulty';
import { isWorkItemType } from '@/lib/issues/executorDefaults';

// The PLANNED BUG an `author_bug` job returns (Story MOTIR-4930 · Subtask
// MOTIR-5851), as motir-core accepts it — the mirror of motir-ai's `AuthoredBug`
// (`src/jobs/handlers/authorBug.ts`).
//
// ⚠️ RE-VALIDATED AT THIS BOUNDARY, BECAUSE THE ANSWER IS UNTRUSTED HERE TOO.
// motir-ai validates before returning, and that is a fact about motir-ai's BUILD,
// not a guarantee about THIS process's input — a version skew, a bug on the far
// side, or a result read from a job some other build wrote all arrive looking
// exactly like a good answer. So `parseAuthoredBug` PARSES; it never casts. A
// field that fails its check fails the WHOLE answer: a half-written card is worse
// than an unenriched one, because it looks authored.

/** The longest bodies accepted — motir-ai's own caps, re-asserted here. */
export const AUTHORED_DESCRIPTION_MAX = 8_000;
export const AUTHORED_EXPLANATION_MAX = 4_000;
/** The sizing scale a bug may carry. */
export const AUTHORED_STORY_POINTS = [1, 2, 3, 5] as const;
/** The largest estimate accepted, in minutes. */
export const AUTHORED_ESTIMATE_MAX_MINUTES = 480;

/** The heading the mechanisms sit under, and the sentence saying none is
 *  established — used only when an answer arrives without them. */
export const CANDIDATE_MECHANISMS_HEADING = '## Candidate mechanisms';
export const CANDIDATE_MECHANISMS_DISCLAIMER =
  'None of these is established. Each is a hypothesis the stack trace is consistent with, listed so the first person to look can rule them in or out — not a diagnosis.';
/** The refs-section statement an UNGROUNDED card must carry. */
export const UNRESOLVED_REFS_STATEMENT =
  "- Context refs could not be resolved against the project's code. Any paths below are the stack frames exactly as the monitor reported them, unchecked.";

const GROUNDING_REASONS = [
  'indexed',
  'not_indexed',
  'no_repos',
  'budget_exhausted',
  'no_match',
] as const;
export type GroundingReason = (typeof GROUNDING_REASONS)[number];

export interface AuthoredBug {
  descriptionMd: string;
  explanationMd: string;
  type: WorkItemTypeDto;
  executor: ExecutorDto;
  storyPoints: (typeof AUTHORED_STORY_POINTS)[number];
  estimateMinutes: number;
  /** How hard the fix is to reason about (MOTIR-6135). `null` when the answer
   *  carried no key — a motir-ai build that predates the field. */
  difficulty: WorkItemDifficultyDto | null;
  contextRefs: string[];
  candidateMechanisms: string[];
  grounded: boolean;
  groundingReason: GroundingReason | null;
}

/** Why an answer was refused — named so the outcome can say which check failed. */
export class InvalidAuthoredBugError extends Error {
  readonly code = 'INVALID_AUTHORED_BUG' as const;
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`author_bug answer refused at ${field}: ${detail}`);
    this.name = 'InvalidAuthoredBugError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function body(raw: Record<string, unknown>, key: string, max: number): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new InvalidAuthoredBugError(key, 'must be a non-empty string');
  }
  if (v.length > max) throw new InvalidAuthoredBugError(key, `exceeds ${max} characters`);
  return v;
}

function stringList(raw: Record<string, unknown>, key: string): string[] {
  const v = raw[key];
  if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
    throw new InvalidAuthoredBugError(key, 'must be an array of strings');
  }
  return v as string[];
}

/** The description's `## <heading>` section body, or null when it has none. */
function section(md: string, heading: string): string | null {
  const lines = md.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * Parse a job result's `authoredBug` into a typed answer, or THROW
 * {@link InvalidAuthoredBugError} naming the first field that failed. Every check
 * the story states: `type` in the fourteen-member enum, `executor` in its two,
 * `storyPoints` in `1 | 2 | 3 | 5`, `estimateMinutes` a positive integer within
 * the cap, `difficulty` in `trivial | low | medium | high` when present (an
 * ABSENT key reads as `null` — rollout tolerance for a motir-ai build that does
 * not emit it yet — while a present unknown value is refused, as `storyPoints`
 * is), both bodies non-empty and within their caps, `candidateMechanisms` empty
 * or two-or-more, and a description carrying `## Acceptance criteria` with
 * a bullet and `## Context refs`.
 */
export function parseAuthoredBug(raw: unknown): AuthoredBug {
  if (!isRecord(raw)) throw new InvalidAuthoredBugError('authoredBug', 'is not an object');

  const descriptionMd = body(raw, 'descriptionMd', AUTHORED_DESCRIPTION_MAX);
  const explanationMd = body(raw, 'explanationMd', AUTHORED_EXPLANATION_MAX);

  if (!isWorkItemType(raw['type'])) {
    throw new InvalidAuthoredBugError('type', 'is not a work-item type');
  }
  const executor = raw['executor'];
  if (executor !== 'coding_agent' && executor !== 'human') {
    throw new InvalidAuthoredBugError('executor', 'must be coding_agent | human');
  }
  const storyPoints = raw['storyPoints'];
  if (!(AUTHORED_STORY_POINTS as readonly unknown[]).includes(storyPoints)) {
    throw new InvalidAuthoredBugError(
      'storyPoints',
      `must be one of ${AUTHORED_STORY_POINTS.join(' | ')}`,
    );
  }
  // Absent (or explicitly null) → null; present → must be a known member.
  const rawDifficulty = raw['difficulty'];
  if (
    rawDifficulty !== undefined &&
    rawDifficulty !== null &&
    !isWorkItemDifficulty(rawDifficulty)
  ) {
    throw new InvalidAuthoredBugError(
      'difficulty',
      `must be one of ${WORK_ITEM_DIFFICULTIES.join(' | ')}`,
    );
  }
  const difficulty: WorkItemDifficultyDto | null = rawDifficulty ?? null;
  const estimate = raw['estimateMinutes'];
  if (
    typeof estimate !== 'number' ||
    !Number.isInteger(estimate) ||
    estimate < 1 ||
    estimate > AUTHORED_ESTIMATE_MAX_MINUTES
  ) {
    throw new InvalidAuthoredBugError(
      'estimateMinutes',
      `must be an integer in 1..${AUTHORED_ESTIMATE_MAX_MINUTES}`,
    );
  }

  const candidateMechanisms = stringList(raw, 'candidateMechanisms');
  if (candidateMechanisms.length === 1) {
    throw new InvalidAuthoredBugError(
      'candidateMechanisms',
      'must be empty or hold two or more — one mechanism is a diagnosis',
    );
  }
  const contextRefs = stringList(raw, 'contextRefs');

  const criteria = section(descriptionMd, '## Acceptance criteria');
  if (criteria === null || !/^- \S/m.test(criteria)) {
    throw new InvalidAuthoredBugError(
      'descriptionMd',
      'carries no "## Acceptance criteria" section with a bullet',
    );
  }
  if (section(descriptionMd, '## Context refs') === null) {
    throw new InvalidAuthoredBugError('descriptionMd', 'carries no "## Context refs" section');
  }

  if (typeof raw['grounded'] !== 'boolean') {
    throw new InvalidAuthoredBugError('grounded', 'must be a boolean');
  }
  const reason = raw['groundingReason'];
  const groundingReason = (GROUNDING_REASONS as readonly unknown[]).includes(reason)
    ? (reason as GroundingReason)
    : null;

  return {
    descriptionMd,
    explanationMd,
    type: raw['type'],
    executor,
    storyPoints: storyPoints as AuthoredBug['storyPoints'],
    estimateMinutes: estimate,
    difficulty,
    contextRefs,
    candidateMechanisms,
    grounded: raw['grounded'],
    groundingReason,
  };
}

/**
 * The description to WRITE — the answer's own, with the two statements the story
 * requires folded in if (and only if) the answer arrived without them: the
 * candidate mechanisms under their heading with the not-established sentence,
 * and, on an ungrounded card, the refs section's "could not be resolved"
 * statement. motir-ai renders both itself, so on a well-formed answer this
 * returns the description unchanged — it is a guarantee at the seam that writes
 * the card, never a second renderer that could double a heading.
 */
export function describedForWrite(answer: AuthoredBug): string {
  let md = answer.descriptionMd;
  if (answer.candidateMechanisms.length > 0 && section(md, CANDIDATE_MECHANISMS_HEADING) === null) {
    const block = [
      CANDIDATE_MECHANISMS_HEADING,
      '',
      CANDIDATE_MECHANISMS_DISCLAIMER,
      '',
      ...answer.candidateMechanisms.map((m) => `- ${m.replace(/\s*\n+\s*/g, ' ')}`),
      '',
    ].join('\n');
    md = md.replace(/^## Context refs$/m, `${block}\n## Context refs`);
  }
  if (!answer.grounded) {
    const refs = section(md, '## Context refs') ?? '';
    if (!/could not (be )?(fully )?(be )?resolved/i.test(refs)) {
      md = md.replace(/^## Context refs$/m, `## Context refs\n\n${UNRESOLVED_REFS_STATEMENT}`);
    }
  }
  return md;
}
