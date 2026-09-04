import { redirect, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isCloud } from '@/lib/billing/availability';
import { projectsService } from '@/lib/services/projectsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { guardSettingsPage } from '../_guard';
import { publicProjectUrl } from '@/lib/publicProjects/urls';
import { PublicPageEditor } from './_components/PublicPageEditor';

// THE PUBLIC PAGE ROOM (Story MOTIR-3875 · MOTIR-4243) — where a project admin
// edits the tagline, tags and README that `motir.co/p/<key>` renders. Drawn by
// MOTIR-4205: `design/projects/public-page.mock.html` Panel B +
// `design/projects/design-notes.md` § *Public page — the room in project
// settings*.
//
// MOTIR-4243 was the MOUNT — the door, the page and the read. MOTIR-4171 is the
// room's client island (`_components/PublicPageEditor.tsx` — the card, the
// three fields, the save bar and its six states), rendered under the header
// below with the three hero fields the read returns as its initial values.
//
// ── THREE GATES, IN THIS ORDER, AND THE ORDER IS THE POINT ─────────────────
//
// 1. `isCloud()` → `notFound()`. Public projects are a CLOUD capability
//    (MOTIR-3908): off-cloud the feature is not hidden, it is ABSENT, so the
//    honest answer is that there is no door. The billing page's precedent
//    (`settings/organization/billing/page.tsx`), and the same 404 the surface's
//    API routes already give through `publicSurfaceUnavailable()`. It runs
//    FIRST — ahead of the session read — because a capability this build does
//    not have must not open a session to say so, and because a refusal state
//    would say *this exists and you may not see it* about a build where it does
//    not exist.
// 2. The session, then the active project (the members room's shape).
// 3. THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
//    protection: the rail row is gone for a non-admin, and this page is still
//    one typed URL away. The key comes from the registry entry `public-page`
//    (`project:administer`) and is never re-declared here.
export default async function ProjectPublicPagePage() {
  // Off-cloud (self-hosted GPL build): the public surface does not exist.
  if (!isCloud()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('project.empty.title')} description={t('project.empty.description')} />
      </div>
    );
  }

  const refused = await guardSettingsPage('public-page', ctx);
  if (refused) return refused;

  // THE ISLAND'S INITIAL VALUES — the three hero fields, read once here
  // (MOTIR-4243's widened read) and handed to the island as its committed
  // baseline. The island never re-reads them: the save's success response is
  // its confirmation (CLAUDE.md § page state, rule 1).
  const initialHero = await projectsService.getPublicHero({
    key: ctx.project.identifier,
    ctx,
  });

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('publicPage.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t.rich('publicPage.subtitle', {
            projectName: ctx.project.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <PublicPageEditor
        projectKey={ctx.project.identifier}
        initial={initialHero}
        // The not-yet-public band and the head's *View public page* link hang
        // off the access level (Panel C6): the room is usable before the
        // project is public — an overview is written before it is shown.
        isPublic={ctx.project.accessLevel === 'public'}
        // The page ON THE PUBLIC HOST, resolved by the one module that owns
        // that question (`publicSiteOrigin()` → `MOTIR_PUBLIC_SITE_URL`); a
        // server value threaded to the island, as the Members room does.
        publicPageUrl={publicProjectUrl(ctx.project.identifier)}
      />
    </div>
  );
}
