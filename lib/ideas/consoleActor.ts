import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { IdeaActor } from './types';

/**
 * The console's `IdeaActor` (Story MOTIR-7664 · MOTIR-7680).
 *
 * The operator console reaches the idea store through `ideasAdminService` in
 * server components and server actions, never through `/api/platform/ideas`, so
 * it does not pass the ideas gate (`lib/platform/ideasGate.ts`, which only the
 * API may import). Its principal comes from the console session the page gate
 * already checked, and the credential that carried it is that session — which
 * is what every audit row the console's writes append says (`credential:
 * session`).
 */
export function consoleIdeaActor(principal: PlatformPrincipal): IdeaActor {
  return {
    userId: principal.userId,
    email: principal.email,
    role: principal.role,
    credential: { kind: 'session' },
  };
}
