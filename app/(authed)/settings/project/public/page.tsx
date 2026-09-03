import { redirect, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isCloud } from '@/lib/billing/availability';
import { projectsService } from '@/lib/services/projectsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { guardSettingsPage } from '../_guard';

// THE PUBLIC PAGE ROOM (Story MOTIR-3875 · MOTIR-4243) — where a project admin
// edits the tagline, tags and README that `motir.co/p/<key>` renders. Drawn by
// MOTIR-4205: `design/projects/public-page.mock.html` Panel B +
// `design/projects/design-notes.md` § *Public page — the room in project
// settings*.
//
// This card is the MOUNT — the door, the page and the read. The room's client
// island (the card, the three fields, the save bar and its six states) is
// MOTIR-4171, which is blocked on this. Until it lands, the page renders its
// HEADER ALONE: an admin-only room, on cloud only, for the window between two
// pull requests in one sprint. That is the card's own stated ordering, not an
// oversight.
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

  // THE ISLAND'S INITIAL VALUES (MOTIR-4171). The room's client island mounts
  // below this header and takes these three fields as its initial state; this
  // card ships the read that produces them, MOTIR-4171 ships the island that
  // renders them. Deliberately not consumed yet — hence the leading underscore
  // the lint config reserves for exactly that. Dropping the call until the
  // island exists would leave MOTIR-4171 to find out whether the widened read
  // works, on the card that can least afford it.
  const _initialHero = await projectsService.getPublicHero({
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
    </div>
  );
}
