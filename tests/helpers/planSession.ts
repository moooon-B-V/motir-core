import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { PROJECT_SCOPE, type PlanChangeScope } from '@/lib/planChange/scope';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';

/**
 * Open — or resume — a planning conversation for a scope, EMPTY, the way the
 * public `open` doors do (`openForScope`; MOTIR-6028). The test-side successor
 * of the retired `getOrCreateForProject` / `getOrCreateForScope` wrappers: a
 * case that needs "a thread to work on" gets one here, and then addresses every
 * write to it by id, which is the only address a session has
 * (`agent-authored-plans.md` AMENDMENT 17 §2).
 */
export async function openTestSession(
  pctx: ProjectContext,
  scope: PlanChangeScope = PROJECT_SCOPE,
): Promise<PlanChangeSessionDto> {
  return planChangeSessionsService.openForScope(pctx, scope);
}

/** The `{ sessionId }` address of a session DTO — what every write takes. */
export function addressOf(session: { id: string }): { sessionId: string } {
  return { sessionId: session.id };
}
