import type { RequirementRecommendation, SubmittedRequirement } from '@/lib/ai/types';

/** A list whose every entry is a string or `{ text, id? }` with string members — the shape motir-ai reads. */
export function isRecommendationList(
  value: unknown,
): value is (string | RequirementRecommendation)[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        typeof r === 'string' ||
        (typeof r === 'object' &&
          r !== null &&
          typeof (r as Record<string, unknown>).text === 'string' &&
          ((r as Record<string, unknown>).id === undefined ||
            typeof (r as Record<string, unknown>).id === 'string')),
    )
  );
}

// The plan's STORED sharpened requirement, narrowed to the six fields a planning
// job reads as `SubmittedRequirement` (Task MOTIR-1101 · Subtask MOTIR-8450).
// `plannerAssumptions` and `settledAt` stay on the plan; only the six parts ride
// the wire. ONE narrowing, used by both the Sharpen door's `run` hole and the
// plan-writing submit, so the two can never read the requirement differently.

const REQUIREMENT_PARTS = [
  'outcome',
  'behaviour',
  'scopeEdge',
  'constraints',
  'acceptance',
  'assumptions',
] as const;

/** The six string parts of a stored sharpened requirement, or `undefined` when
 *  there is none or it carries none of them. */
export function narrowSharpenedRequirement(stored: unknown): SubmittedRequirement | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  const source = stored as Record<string, unknown>;
  const out: SubmittedRequirement = {};
  for (const part of REQUIREMENT_PARTS) {
    const value = source[part];
    if (part === 'assumptions') {
      // A list of recommendations (MOTIR-9160), or the string stored before it.
      if (typeof value === 'string') out.assumptions = value;
      else if (isRecommendationList(value)) out.assumptions = value;
      continue;
    }
    if (typeof value === 'string') out[part] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
