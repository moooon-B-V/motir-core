import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';
import { usersService } from '@/lib/services/usersService';

// CREATING A PERSON A FIXTURE CAN SIGN IN AS.
//
// ⚠️ `usersService.createUser` ALONE MAKES SOMEBODY WHO CANNOT USE THE PRODUCT,
// and the way it fails is the reason this helper exists rather than a comment.
//
// Story 8.4 · MOTIR-1135 holds a signed-in person at `/re-consent` until they
// have agreed to the current legal documents, in EVERY signed-in route group.
// The rows that say they agreed are written by Better-Auth's
// `user.create.after` hook — the sign-up ceremony. `usersService.createUser`
// writes through Prisma directly and never fires it, so a person minted that
// way has agreed to nothing and is held on their first page load.
//
// The failure then lands nowhere near the cause: `signIn` succeeds, and the
// spec times out in `shell-session.ts`'s `settleOnHome` waiting for `/home`
// while the browser sits on `/re-consent`. It reads as a navigation or a timing
// problem. Ten acceptance specs were red on `main` for exactly this
// (MOTIR-3715), and not one of them looked like a consent problem.
//
// So a fixture person is created HERE, through both halves of what signing up
// actually does. `recordAcceptance` is idempotent and reads the versions from
// the server, so this records agreement to the documents as they stand — which
// is the state a real sign-up would have produced a moment earlier.
//
// ⚠️ NOT FOR A SPEC ABOUT CONSENT ITSELF. A spec asserting the interstitial
// wants a person who has agreed to nothing; it should call `usersService`
// directly and say why.

export async function createTestPerson(input: {
  email: string;
  password: string;
  name: string;
}): Promise<{ id: string; name: string; email: string }> {
  const user = await usersService.createUser(input);
  await legalAcceptanceService.recordAcceptance(user.id);
  return { id: user.id, name: user.name, email: input.email };
}
