import type { SharpenSessionDto } from '@/lib/dto/sharpen';

import type { GrillError } from '@/components/planning/useGrillSession';

/**
 * GRILL ME FAILED, AND THE RUN HANDED OFF ANYWAY (MOTIR-8781).
 *
 * The grilling thread is drawn only in the conversation phase, and a plan run leaves
 * that phase at once, so a grilling whose turn failed — or whose session never opened —
 * is invisible once the run is writing: the person turned Grill me on, was never asked
 * anything, and the plan was written without them. This is the one test for "say so":
 * the run is writing, the person had the mode on, the session did not END (an ended
 * session draws its own summary), and either the hook holds an error or the last stored
 * turn is a failed one.
 */
export function grillFailedAfterHandoff(args: {
  writing: boolean;
  on: boolean;
  session: Pick<SharpenSessionDto, 'status' | 'turns'> | null;
  error: GrillError;
}): boolean {
  const { writing, on, session, error } = args;
  if (!writing || !on) return false;
  if (session?.status === 'ended') return false;
  return error !== null || session?.turns.at(-1)?.failed === true;
}
