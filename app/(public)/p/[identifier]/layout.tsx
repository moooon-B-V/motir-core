import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getPublicOverview } from '@/lib/publicProjects/viewerContext';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { publicProjectUrl, derivePublicDescription } from '@/lib/publicProjects/urls';
import { PublicTopBar } from '@/app/(public)/_components/PublicTopBar';
import { PublicBanner } from '@/app/(public)/_components/PublicBanner';

// The public project shell (Story 6.12 · Subtask 6.12.4). Resolves the project +
// the anonymous-friendly actor ONCE, renders the top bar + banner chrome, and
// 404s a non-public/unknown project (the gate throws ProjectNotFoundError →
// notFound()). The read is NOT session-gated — a logged-out visitor / crawler
// reads a public project. Each child PAGE renders its own tab nav (so the active
// tab is correct + crawlable) inside this shell.
//
// `generateMetadata` makes the surface SEO/GEO-ready: a real <title> +
// description (the overview tagline / first ~160 chars of the README) + canonical
// + OpenGraph + Twitter. (Story 6.12.1 Panel 9.)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ identifier: string }>;
}): Promise<Metadata> {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;
  let overview;
  try {
    overview = await getPublicOverview(identifier, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return {};
    throw err;
  }
  const url = publicProjectUrl(overview.identifier);
  const title = `${overview.name} · ${overview.workspaceName}`;
  const description = derivePublicDescription(
    overview.publicOverviewMd,
    `${overview.name} — a public project on Motir. View the board, work items, and roadmap.`,
  );
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      title,
      description,
      url,
      siteName: 'Motir',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

export default async function PublicProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
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

  return (
    <div className="min-h-full bg-(--el-surface) px-4 py-8">
      <div className="mx-auto max-w-[75rem] overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) shadow-(--shadow-card)">
        <PublicTopBar
          name={overview.name}
          identifier={overview.identifier}
          workspaceName={overview.workspaceName}
          user={session ? { name: session.user.name, email: session.user.email } : null}
        />
        <PublicBanner />
        {children}
      </div>
    </div>
  );
}
