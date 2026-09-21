// The Motir SYSTEM PRINCIPAL — the service identity the AI self-learning loop
// writes AS when it files a `kind: bug` into the Motir meta project (MOTIR-1451,
// the foundation MOTIR-1450's route consumes).
//
// It is a real `User` row so it can be a genuine workspace member (satisfying
// `assertReporterMember` + the 6.4 project gate + the work_item reporter FK) —
// but a RESERVED, non-loginnable one: it has NO credential `Account`, so there
// is no password to sign in with. It authenticates ONLY via the §4a service
// bearer (`verifyServiceBearer`), never an interactive session.
//
// Provisioned by `scripts/plan-seed/systemPrincipal.ts` (a member of the meta
// workspace) and resolved at request time by `lib/ai/serviceAuth.ts`. Both
// import these constants so the email is defined in exactly one place. The
// `.internal` TLD is reserved/non-routable, so the reserved address can never
// collide with — or receive mail as — a real user.

export const MOTIR_SYSTEM_USER_EMAIL = 'system@motir.internal';
export const MOTIR_SYSTEM_USER_NAME = 'Motir Planner';

/**
 * The KEY of the Motir META project — the project the system principal files
 * into. Mirrors motir-ai's `MOTIR_META_PROJECT_KEY` with the same default, so
 * both sides of the boundary name the same project. Read at CALL time, so a
 * deployment (or a test) that sets the variable after import is honoured.
 */
export function metaProjectKey(): string {
  return process.env['MOTIR_META_PROJECT_KEY'] ?? 'MOTIR';
}
