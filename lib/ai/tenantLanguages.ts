import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { usersService } from '@/lib/services/usersService';
import { toOrgContentLanguage } from '@/lib/workItems/contentLanguage';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { Locale } from '@/lib/i18n/locales';

// The language half of a job-submit tenant (Story MOTIR-7734 · MOTIR-8737) — the
// producer motir-ai's envelope requires on every writing job (MOTIR-8736):
//
//   • `contentLanguage` — the organisation's content language, the language of
//     stored work content. Read through `app_workspace_content_language`, which
//     answers for the BOUND workspace only: with a user, under
//     `withWorkspaceContext`; with none, under `withWorkspaceServiceContext`,
//     which binds the workspace without a user. (`withSystemContext` would bind
//     no workspace, and the function would answer NULL — read as `en` — for
//     every org.) A NULL or retired value reads as `en` (`toOrgContentLanguage`).
//   • `personLanguage` — the requesting person's saved account language, read by
//     user id with no request in scope. `''` ONLY when there is no person (a
//     schedule or a monitor started the job). A real person with nothing saved
//     falls back to the CONTENT language, never to `''`: the far side reads `''`
//     as "no person". There is no browser on a job path, so the browser-language
//     fallback the interface applies does not exist here.
//
// Beside `resolveTenantOrg`, not inside it: a caller that needs the languages
// calls this too.
export async function resolveTenantLanguages(ctx: {
  workspaceId: string;
  userId: string | null;
}): Promise<{ contentLanguage: Locale; personLanguage: Locale | '' }> {
  const read = (
    tx: Parameters<typeof organizationRepository.findContentLanguageByWorkspaceId>[1],
  ) => organizationRepository.findContentLanguageByWorkspaceId(ctx.workspaceId, tx);
  const stored =
    ctx.userId === null
      ? await withWorkspaceServiceContext(ctx.workspaceId, read)
      : await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, read);
  const contentLanguage = toOrgContentLanguage(stored);
  if (ctx.userId === null) return { contentLanguage, personLanguage: '' };
  const saved = await usersService.getSavedLocale(ctx.userId);
  return { contentLanguage, personLanguage: saved ?? contentLanguage };
}
