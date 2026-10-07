import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { StaffIdeaDto } from '@/lib/dto/ideas';
import { consoleIdeaActor } from '@/lib/ideas/consoleActor';
import { IdeaNotFoundError } from '@/lib/ideas/errors';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { IdeaDetailView } from '../_components/IdeaDetailView';

/**
 * One IDEA — design `platform-admin/design-notes.md` § Ideas Panels 4, 5 and
 * 10's support view (MOTIR-7679), card MOTIR-7680.
 *
 * ⚠️ THE READ DECIDES EXISTENCE, so it runs in the page body before anything
 * streams and there is no `<Suspense>` above it: a slug the store does not have
 * is the app's 404 with a real 404 status (CLAUDE.md's boundary rule).
 *
 * Every staff role reads. The edit, retire and delete controls are MOTIR-7681's
 * and render in the header's actions slot; a support viewer gets the read-only
 * line there instead, as real text rather than disabled buttons.
 */

export const metadata: Metadata = { title: 'Idea' };

export const dynamic = 'force-dynamic';

export default async function AdminIdeaPage({ params }: { params: Promise<{ slug: string }> }) {
  const principal = await requirePlatformStaffPage('support');
  const { slug } = await params;
  const t = await getTranslations('platformAdmin.ideas');

  let idea: StaffIdeaDto;
  try {
    idea = await ideasAdminService.getForStaff(consoleIdeaActor(principal), slug);
  } catch (err) {
    if (err instanceof IdeaNotFoundError) notFound();
    throw err;
  }

  const readOnly =
    principal.role === 'support' ? (
      <p
        data-testid="idea-read-only"
        className="max-w-[24rem] font-sans text-xs text-(--el-text-secondary)"
      >
        {t('readOnly')}
      </p>
    ) : null;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <IdeaDetailView idea={idea} actions={readOnly} />
    </div>
  );
}
