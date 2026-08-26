import { passkeyRepository } from '@/lib/repositories/passkeyRepository';
import { toPasskeyDTO } from '@/lib/mappers/passkeyMappers';
import type { PasskeyDTO } from '@/lib/dto/passkey';

// The passkey business layer (Story MOTIR-1214 · Subtask MOTIR-3611).
//
// ⚠️ READ THIS BEFORE ADDING A METHOD: THIS SERVICE IS READ-ONLY, DELIBERATELY.
//
// Better-Auth's `passkey` plugin owns every CEREMONY and every write —
// registration (`/passkey/generate-register-options` → `/passkey/verify-registration`),
// authentication, rename and remove. Those are reached from the browser through
// `authClient.passkey.*` and `authClient.signIn.passkey`, and they are not
// proxied here: a WebAuthn ceremony is a conversation between the browser's
// credential store and the server, and a proxy in the middle would have to
// re-implement the challenge/response handling to add nothing.
//
// What the plugin does NOT give us is a read a SERVER COMPONENT can call. The
// Security pane resolves its data through services in one `Promise.all` rather
// than fetching its own HTTP endpoints, so it needs a function, not a route.
// This service is that function, and adding a write to it would quietly create a
// second path onto rows the plugin believes it owns.
//
// Layer rules (CLAUDE.md): the repository does the single Prisma call, the
// mapper does the DTO, and this file returns DTOs and never a Prisma row — which
// is also why it imports no Prisma type at all.

export const passkeyService = {
  /**
   * Every passkey a user holds, oldest first, as DTOs.
   *
   * READ-ONLY, so no transaction: nothing here derives a write from what it
   * reads, and a list that is one registration stale is a display artifact the
   * next render corrects.
   */
  async listForUser(userId: string): Promise<PasskeyDTO[]> {
    const rows = await passkeyRepository.findManyByUserId(userId);
    return rows.map(toPasskeyDTO);
  },

  /**
   * How many passkeys a user holds.
   *
   * Its caller is `twoFactorService.getStatus`, which needs the number to decide
   * whether `passkey` belongs in the account's method set. Kept as a COUNT
   * rather than `listForUser(...).length` so the status read does not pay for
   * rows it will not render.
   */
  async countForUser(userId: string): Promise<number> {
    return passkeyRepository.countByUserId(userId);
  },
};
