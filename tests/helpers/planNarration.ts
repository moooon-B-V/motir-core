import type {
  PlanNarrationDto,
  PlanNarrationReadDto,
  PlanNarrationSessionDto,
  PlanStepKindDto,
} from '@/lib/dto/plans';

// Builders for the planner's stored narration (Story MOTIR-8060), in the shape
// the plan review read returns it (`PlanReviewDto.narration`).

let order = 0;

/** One session's step words. `firstReportedAt` advances per call, so sessions
 *  built in order are in the read's order. */
export function narrationSession(
  sessionKey: string,
  stepKind: PlanStepKindDto,
  targetTitle: string | null = stepKind === 'settle' ? null : `Target of ${sessionKey}`,
): PlanNarrationSessionDto {
  order += 1;
  const at = new Date(Date.UTC(2026, 9, 9, 10, 0, order)).toISOString();
  return {
    sessionKey,
    stepKind,
    targetRef: targetTitle === null ? null : `ref-${sessionKey}`,
    targetTitle,
    firstReportedAt: at,
    updatedAt: at,
  };
}

/** One stored sentence. */
export function narrationEntry(seq: number, sessionKey: string, body: string): PlanNarrationDto {
  return {
    id: `n${seq}`,
    sessionKey,
    seq,
    body,
    createdAt: new Date(Date.UTC(2026, 9, 9, 11, 0, seq)).toISOString(),
  };
}

/** A read over `sessions` and a window of `entries` (ascending `seq`). */
export function narrationRead(
  sessions: PlanNarrationSessionDto[],
  entries: PlanNarrationDto[],
): PlanNarrationReadDto {
  return { sessions, entries, earlierCount: entries.length === 0 ? 0 : entries[0]!.seq - 1 };
}
