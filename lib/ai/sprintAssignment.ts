// The sprint-assignment delta a `plan_sprint` job proposes and motir-core
// commits (boundary contract §3.2, Subtask 7.13.5 · MOTIR-918).
//
// This module is the SHAPE gate — the first of the two independent checks the
// approve path runs on a delta it did not produce. It answers "is this a
// well-formed v1 sprint-assignment delta?" and nothing else; whether the packing
// is LEGAL against the live project (the items exist, are schedulable, and the
// ordering respects the `is_blocked_by` DAG) is the service's semantic pass,
// which reads the database. Both run BEFORE any write.
//
// Why parse at all when the job result is typed: the approve body carries the
// APPROVED, possibly human-EDITED packing, submitted by the browser. It is
// untrusted input on exactly the same footing as any request body, so it is
// re-derived from `unknown` here rather than cast — the same discipline
// `parsePlanDelta` applies to the tree delta.

import {
  SPRINT_ASSIGNMENT_DELTA_VERSION,
  type ProposedSprint,
  type SprintAssignmentDelta,
} from '@/lib/ai/types';

export class SprintAssignmentValidationError extends Error {
  readonly code = 'SPRINT_ASSIGNMENT_INVALID' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'SprintAssignmentValidationError';
  }
}

/** Upper bound on sprints in one approved packing — the same order of magnitude
 *  as the scheduler's item cap, so a hand-edited body cannot ask for thousands
 *  of `createSprint` calls inside one transaction. */
export const MAX_PROPOSED_SPRINTS = 100;

/** Upper bound on members per proposed sprint. Matches `backlogService`'s
 *  `MAX_BULK_BATCH_SIZE`, which is what actually performs the assignment — an
 *  oversize sprint would be rejected there anyway, so it is rejected here first,
 *  with a message that names the sprint. */
export const MAX_ITEMS_PER_SPRINT = 100;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asPositiveInt(raw: unknown, where: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
    throw new SprintAssignmentValidationError(`${where} must be a positive integer`);
  }
  return raw;
}

function asNonNegativeInt(raw: unknown, where: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    throw new SprintAssignmentValidationError(`${where} must be a non-negative integer`);
  }
  return raw;
}

function asNonEmptyString(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new SprintAssignmentValidationError(`${where} must be a non-empty string`);
  }
  return raw.trim();
}

function asKeyList(raw: unknown, where: string, max: number): string[] {
  if (!Array.isArray(raw)) throw new SprintAssignmentValidationError(`${where} must be an array`);
  if (raw.length > max) {
    throw new SprintAssignmentValidationError(`${where} holds ${raw.length} entries (max ${max})`);
  }
  return raw.map((entry, i) => asNonEmptyString(entry, `${where}[${i}]`).toUpperCase());
}

function parseSprint(raw: unknown, where: string): ProposedSprint {
  if (!isRecord(raw)) throw new SprintAssignmentValidationError(`${where} must be an object`);
  const tempId = asNonEmptyString(raw['tempId'], `${where}.tempId`);
  // The temp-ref grammar is fixed by the contract. Enforcing it here means the
  // persist can key its tempId → real-id map on a value that cannot collide with
  // a real sprint id (which is a cuid), so a hand-edited `tempId` of "abc" is
  // rejected rather than silently creating an unreferenced sprint.
  if (!/^sprint:\d+$/.test(tempId)) {
    throw new SprintAssignmentValidationError(
      `${where}.tempId must match "sprint:<n>" (got "${tempId}")`,
    );
  }
  return {
    tempId,
    name: asNonEmptyString(raw['name'], `${where}.name`),
    lengthDays: asPositiveInt(raw['lengthDays'], `${where}.lengthDays`),
    itemKeys: asKeyList(raw['itemKeys'], `${where}.itemKeys`, MAX_ITEMS_PER_SPRINT),
    totalEstimateMinutes: asNonNegativeInt(
      raw['totalEstimateMinutes'],
      `${where}.totalEstimateMinutes`,
    ),
    capacityMinutes: asNonNegativeInt(raw['capacityMinutes'], `${where}.capacityMinutes`),
    oversizedKeys: asKeyList(
      raw['oversizedKeys'] ?? [],
      `${where}.oversizedKeys`,
      MAX_ITEMS_PER_SPRINT,
    ),
    // Free-form derived prose — present on every produced delta, but not
    // load-bearing for the persist, so an absent/blank one is tolerated rather
    // than rejecting an otherwise-valid packing.
    rationale: typeof raw['rationale'] === 'string' ? raw['rationale'] : '',
  };
}

/**
 * Parse an untrusted value into a v1 {@link SprintAssignmentDelta}.
 *
 * Rejects (as `SprintAssignmentValidationError`, a 400 at the route):
 *   * a non-object, or a `deltaVersion` this build does not implement — the
 *     version switch is the whole point of §3.2's independent versioning, so an
 *     unknown version is refused, never best-effort parsed;
 *   * a malformed sprint (bad `tempId` grammar, missing name/length, non-array
 *     `itemKeys`, oversize batches);
 *   * DUPLICATE `tempId`s, or a work-item key appearing in TWO sprints — an item
 *     has exactly one sprint, so a duplicate is an incoherent packing, not a
 *     last-write-wins.
 *
 * An EMPTY `sprints` list is VALID: "nothing to schedule" is a legitimate
 * proposal, and approving it is a no-op (never an error).
 *
 * Work-item keys are upper-cased on the way in, matching how every other
 * key-taking seam in the codebase normalizes an identifier.
 */
export function parseSprintAssignmentDelta(raw: unknown): SprintAssignmentDelta {
  if (!isRecord(raw)) {
    throw new SprintAssignmentValidationError('sprint assignment delta must be an object');
  }
  const version = raw['deltaVersion'];
  if (version !== SPRINT_ASSIGNMENT_DELTA_VERSION) {
    throw new SprintAssignmentValidationError(
      `unsupported sprint-assignment deltaVersion ${JSON.stringify(version)} (expected "${SPRINT_ASSIGNMENT_DELTA_VERSION}")`,
    );
  }
  const rawSprints = raw['sprints'];
  if (!Array.isArray(rawSprints)) {
    throw new SprintAssignmentValidationError('sprints must be an array');
  }
  if (rawSprints.length > MAX_PROPOSED_SPRINTS) {
    throw new SprintAssignmentValidationError(
      `sprints holds ${rawSprints.length} entries (max ${MAX_PROPOSED_SPRINTS})`,
    );
  }

  const sprints = rawSprints.map((s, i) => parseSprint(s, `sprints[${i}]`));

  const seenTempIds = new Set<string>();
  const seenKeys = new Map<string, string>();
  for (const sprint of sprints) {
    if (seenTempIds.has(sprint.tempId)) {
      throw new SprintAssignmentValidationError(`duplicate sprint tempId "${sprint.tempId}"`);
    }
    seenTempIds.add(sprint.tempId);
    for (const key of sprint.itemKeys) {
      const owner = seenKeys.get(key);
      if (owner) {
        throw new SprintAssignmentValidationError(
          `work item ${key} is assigned to two sprints ("${owner}" and "${sprint.tempId}")`,
        );
      }
      seenKeys.set(key, sprint.tempId);
    }
  }

  return {
    deltaVersion: SPRINT_ASSIGNMENT_DELTA_VERSION,
    sprintLengthDays: asPositiveInt(raw['sprintLengthDays'], 'sprintLengthDays'),
    capacityMinutes: asNonNegativeInt(raw['capacityMinutes'], 'capacityMinutes'),
    agentMinutesPerDay: asNonNegativeInt(raw['agentMinutesPerDay'], 'agentMinutesPerDay'),
    sprints,
    // Reported counts are DERIVED here rather than trusted: a human-edited delta
    // that moved an item but left `itemCount` stale must not make the persist
    // report a number that disagrees with what it wrote.
    itemCount: seenKeys.size,
    totalEstimateMinutes: sprints.reduce((sum, s) => sum + s.totalEstimateMinutes, 0),
    unestimatedKeys: asKeyList(
      raw['unestimatedKeys'] ?? [],
      'unestimatedKeys',
      MAX_PROPOSED_SPRINTS * MAX_ITEMS_PER_SPRINT,
    ),
    oversizedKeys: asKeyList(
      raw['oversizedKeys'] ?? [],
      'oversizedKeys',
      MAX_PROPOSED_SPRINTS * MAX_ITEMS_PER_SPRINT,
    ),
  };
}
