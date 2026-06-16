import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getPublicOverview } from '@/lib/publicProjects/viewerContext';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { derivePublicDescription } from '@/lib/publicProjects/urls';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';
import { PublicOverviewHero } from '@/app/(public)/_components/PublicOverviewHero';
import { PublicOverviewSidebar } from '@/app/(public)/_components/PublicOverviewSidebar';
import { PublicOverviewFaq, publicFaqItems } from '@/app/(public)/_components/PublicOverviewFaq';
import { PublicSubmitRequest } from '@/app/(public)/_components/PublicSubmitRequest';
import { PublicOverviewEditor } from '@/app/(public)/_components/PublicOverviewEditor';
import { PublicProjectJsonLd } from '@/app/(public)/_components/PublicProjectJsonLd';

// The public Overview / README landing (Story 6.12 · Subtask 6.12.4 · design
// Panel 1) — the DEFAULT public tab. A hero + the authored `publicOverviewMd`
// rendered with the shipped MarkdownView (empty → no body, just the slim hero +
// sidebar auto-intro, never a blank page) + a Links / At-a-glance sidebar + an
// FAQ block. Server-rendered + crawlable; emits JSON-LD (SoftwareApplication +
// FAQPage). The single <h1> is the project name in the hero (SEO/GEO).

export default async function PublicOverviewPage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let overview;
  try {
    overview = await getPublicOverview(identifier, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound();
    throw err;
  }

  const t = await getTranslations('publicProjects');
  const faq = await publicFaqItems();
  const description = derivePublicDescription(
    overview.publicOverviewMd,
    `${overview.name} — a public project on Motir.`,
  );
  const roadmapHref = `/p/${encodeURIComponent(overview.identifier)}/roadmap`;

  return (
    <>
      <PublicProjectJsonLd overview={overview} description={description} faq={faq} />
      <PublicTabNav identifier={overview.identifier} active="overview" />

      {overview.viewerCanManage ? (
        // An admin viewing their own public page gets the on-page in-place editor
        // (Subtask 6.16.5): a client island that owns the tagline / tags / body
        // and renders the hero + body itself, so a Save reflects without a reload.
        // An anonymous / non-admin viewer never mounts it — they fall through to
        // the server-rendered, crawlable read layout below.
        <PublicOverviewEditor
          overview={overview}
          roadmapHref={roadmapHref}
          adminName={session?.user.name ?? session?.user.email ?? ''}
          faq={<PublicOverviewFaq />}
          sidebar={<PublicOverviewSidebar overview={overview} />}
          submitButton={<PublicSubmitRequest identifier={overview.identifier} size="md" />}
        />
      ) : (
        <div className="p-(--spacing-card-padding)">
          <PublicOverviewHero overview={overview} roadmapHref={roadmapHref} />

          <div className="mt-[18px] grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_312px]">
            <div className="min-w-0">
              {overview.publicOverviewMd ? (
                <MarkdownView value={overview.publicOverviewMd} aria-label={t('tabOverview')} />
              ) : null}
              <div className="mt-6">
                <PublicOverviewFaq />
              </div>
            </div>
            <PublicOverviewSidebar overview={overview} />
          </div>
        </div>
      )}
    </>
  );
}
