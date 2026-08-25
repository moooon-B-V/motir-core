import { projectRepository } from '@/lib/repositories/projectRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { resolveRecordPlanningMistakes } from '@/lib/projectAiSettings/limits';

// The PRODUCER half of the record-planning-mistakes crossing (Story MOTIR-3331 ·
// MOTIR-3350) — resolve `Project.aiRecordPlanningMistakes` at submit time and put
// it on the job envelope's `context`, so motir-ai's capture path can be gated by
// a motir-core setting without motir-ai ever reading motir-core's database.
//
// Composition mirrors `resolveCodeContext` / `resolveProjectRepoContext`, the two
// neighbours on the same submits: the read opens its OWN workspace context, goes
// through the repository, and returns just the value the caller drops into the
// bag. Same reason as theirs — the resolution lives in ONE place rather than once
// per dispatch entry point.
//
// ⚠️ THIS IS A CROSS-REPO CONTRACT AND IT FAILS CLOSED AND SILENTLY — the hazard
// `motirAiClient.ts` documents beside `JOB_SCOPE_QUERY_PARAM`, and the reason the
// field name is a CONSTANT here rather than an object-literal key at each call
// site. There is no shared type across the two repositories, so the name is a
// string agreement between two codebases: a typo on either side is not a type
// error and not a test failure in the repo that made it — it is a setting that
// silently stops being honoured. One name, exported, quoted in the pull request,
// and checkable against the consumer BY READING.

/**
 * The `context` key the flag rides on, as motir-ai's job handler reads it.
 *
 * Declared `as const` so a computed-key literal (`{ [FIELD]: value }`) still
 * type-checks against `JobContextBag`'s `recordPlanningMistakes` — the call sites
 * therefore name this constant and never re-spell the string.
 *
 * The consumer half is motir-ai `src/jobs/plannerInputs.ts`, which reads exactly
 * this key. It sits beside `generateExplanations`, the shipped precedent for a
 * motir-core project setting crossing the boundary on the envelope.
 */
export const RECORD_PLANNING_MISTAKES_CONTEXT_FIELD = 'recordPlanningMistakes' as const;

/**
 * Resolve whether this project's planner may record what it got wrong.
 *
 * ALWAYS returns a boolean — never `undefined` — because the two states must stay
 * distinguishable ON THE WIRE. A present `false` means *this project switched it
 * off*; an ABSENT field means *the producer predates this contract* and the
 * consumer must fall back to ON. A resolver that returned `undefined` for "off"
 * would collapse those into one value and switch capture off for every job in
 * flight across a deploy, so the caller sends the field unconditionally.
 *
 * The stored column is nullable (never written ⇒ ON); `resolveRecordPlanningMistakes`
 * is the single place that rule lives (MOTIR-3349). A project that cannot be read
 * resolves to the same default rather than throwing: this is a flag on a submit
 * that is already happening, and failing a planning run because a settings read
 * came back empty would be a worse answer than capturing.
 */
export async function resolveRecordPlanningMistakesForJob(
  projectId: string,
  ctx: { userId: string; workspaceId: string },
): Promise<boolean> {
  const settings = await withWorkspaceContext(ctx, (tx) =>
    projectRepository.findAiSettings(projectId, tx),
  );
  return resolveRecordPlanningMistakes(settings?.aiRecordPlanningMistakes ?? null);
}
