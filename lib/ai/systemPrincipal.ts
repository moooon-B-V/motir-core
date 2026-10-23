import { userRepository } from '@/lib/repositories/userRepository';

// The Motir SYSTEM PRINCIPAL — the service identity the AI self-learning loop
// writes AS when it files a `kind: bug` into the Motir meta project (MOTIR-1451,
// the foundation MOTIR-1450's route consumes), and, since MOTIR-9329, the ONE
// account everything Motir AI writes into any workspace is written by.
//
// It is a real `User` row so it can be a genuine workspace member (satisfying
// `assertReporterMember` + the 6.4 project gate + the work_item reporter FK) —
// but a RESERVED, non-loginnable one: it has NO credential `Account`, so there
// is no password to sign in with. It authenticates ONLY via the §4a service
// bearer (`verifyServiceBearer`), never an interactive session.
//
// Provisioned by `scripts/plan-seed/systemPrincipal.ts` (a member of the meta
// workspace) in dev and test, by the migration
// `20261009210000_provision_motir_system_principal` in production (MOTIR-8058),
// and resolved at request time by `lib/ai/serviceAuth.ts`. The seed and the
// resolver import these constants so the email is defined in exactly one place;
// the migration is SQL and repeats both literals, and
// `tests/integration/migrations/provision-motir-system-principal.test.ts`
// asserts they still match. The
// `.internal` TLD is reserved/non-routable, so the reserved address can never
// collide with — or receive mail as — a real user.

export const MOTIR_SYSTEM_USER_EMAIL = 'system@motir.internal';
export const MOTIR_SYSTEM_USER_NAME = 'Motir';

/**
 * The KEY of the Motir META project — the project the system principal files
 * into. Mirrors motir-ai's `MOTIR_META_PROJECT_KEY` with the same default, so
 * both sides of the boundary name the same project. Read at CALL time, so a
 * deployment (or a test) that sets the variable after import is honoured.
 */
export function metaProjectKey(): string {
  return process.env['MOTIR_META_PROJECT_KEY'] ?? 'MOTIR';
}

// ⚠️ THE ACCOUNT ENTERS ANY WORKSPACE BY IDENTITY, NOT BY MEMBERSHIP (MOTIR-9329).
// What Motir AI writes is Motir's own, recorded under its own name — never the
// person's — so the account must reach a customer workspace it is no member of.
// It is given NO role row anywhere: the gates that decide "may this actor act here"
// (`composeOwnerReach`, which the project gate composes, and `assertReporterMember`)
// ask {@link isMotirSystemUser} on their NON-member branch and admit it as a
// Manager. With no membership it is in no member list, seat count, assignee picker
// or mention suggestion.
//
// The question is asked of the ACTOR'S OWN resolved user id (a session's, or the
// service bearer's system principal), never of anything a caller sends, and the
// answer is the stored row's email — the reserved, non-routable
// `MOTIR_SYSTEM_USER_EMAIL`, unique on `user` — so no other user gains anything.
// A positive answer is remembered (user ids are never reused); a negative one is
// not, so an environment that provisions the account after the first ask still
// admits it.
const knownSystemUserIds = new Set<string>();

/** Whether `userId` is the Motir system account. One primary-key read on a
 *  non-member branch; free after the first positive answer. */
export async function isMotirSystemUser(userId: string): Promise<boolean> {
  if (knownSystemUserIds.has(userId)) return true;
  const user = await userRepository.findById(userId);
  if (user?.email !== MOTIR_SYSTEM_USER_EMAIL) return false;
  knownSystemUserIds.add(userId);
  return true;
}
