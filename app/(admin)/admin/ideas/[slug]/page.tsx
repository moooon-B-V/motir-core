import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { StaffIdeaDto } from '@/lib/dto/ideas';
import { consoleIdeaActor } from '@/lib/ideas/consoleActor';
import { IdeaNotFoundError } from '@/lib/ideas/errors';
import type { IdeaActor } from '@/lib/ideas/types';
import { platformRoleAtLeast } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { IdeaDetailView } from '../_components/IdeaDetailView';
import { IdeaWorkbench } from './_components/IdeaWorkbench';

/**
 * One IDEA — design `platform-admin/design-notes.md` § Ideas Panels 4, 5 and
 * 10's support view (MOTIR-7679), card MOTIR-7680.
 *
 * ⚠️ THE READ DECIDES EXISTENCE, so it runs in the page body before anything
 * streams and there is no `<Suspense>` above it: a slug the store does not have
 * is the app's 404 with a real 404 status (CLAUDE.md's boundary rule).
 *
 * Every staff role reads. An operator or a superadmin gets the write island
 * (MOTIR-7681: Edit and Retire, plus Delete for a superadmin); a support viewer
 * gets the read-only line in the actions slot instead, as real text rather
 * than disabled buttons — the role matrix's "absent, not disabled".
 */

/**
 * Who retired it, for the Retired box. A side read: when it fails the box says
 * when without who, rather than the page failing over a name.
 */
async function readRetiredBy(actor: IdeaActor, idea: StaffIdeaDto): Promise<string | null> {
  try {
    return await ideasAdminService.retiredBy(actor, idea);
  } catch (err) {
    console.error('[admin] idea retired-by read failed', { slug: idea.slug }, err);
    return null;
  }
}

export const metadata: Metadata = { title: 'Idea' };

export const dynamic = 'force-dynamic';

export default async function AdminIdeaPage({ params }: { params: Promise<{ slug: string }> }) {
  const principal = await requirePlatformStaffPage('support');
  const { slug } = await params;
  const t = await getTranslations('platformAdmin.ideas');

  const actor = consoleIdeaActor(principal);
  let idea: StaffIdeaDto;
  try {
    idea = await ideasAdminService.getForStaff(actor, slug);
  } catch (err) {
    if (err instanceof IdeaNotFoundError) notFound();
    throw err;
  }

  const canWrite = platformRoleAtLeast(principal.role, 'operator');
  const [retiredBy, tags] = await Promise.all([
    readRetiredBy(actor, idea),
    canWrite ? ideasAdminService.listTags(actor) : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      {canWrite ? (
        <IdeaWorkbench
          idea={idea}
          tags={tags}
          retiredBy={retiredBy}
          canDelete={principal.role === 'superadmin'}
        />
      ) : (
        <IdeaDetailView
          idea={idea}
          retiredBy={retiredBy}
          actions={
            <p
              data-testid="idea-read-only"
              className="max-w-[24rem] font-sans text-xs text-(--el-text-secondary)"
            >
              {t('readOnly')}
            </p>
          }
        />
      )}
    </div>
  );
}
