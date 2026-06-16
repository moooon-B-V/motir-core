import type { ReactNode } from 'react';
import { projectTagsService } from '@/lib/services/projectTagsService';
import { ExploreTopBar } from './_components/ExploreTopBar';
import { ExploreFooter } from './_components/ExploreFooter';

// The project-square shell (Story 6.13 · Subtask 6.13.6 · design Panel 1). This
// is the MARKETING-SITE chrome — a top bar + an SEO footer — NOT the app
// `Sidebar` / authed shell: the square is a standalone, fully-public web page
// (model revision 2026-06-14), so it renders for logged-out visitors and
// crawlers with no `getSession()` gate. Wraps both `/explore` and the
// `/explore/topic/<slug>` landing pages so the chrome (and the footer's per-topic
// crawl links) is consistent across them. The footer's "Explore by topic" links
// come from the 6.13.5 facet (top topics by public-project count).

export default async function ExploreLayout({ children }: { children: ReactNode }) {
  const categories = await projectTagsService.listCategories();
  const topics = categories.slice(0, 6).map((c) => ({ slug: c.slug, label: c.label }));

  return (
    <div className="flex min-h-screen flex-col bg-(--el-page-bg)">
      <ExploreTopBar />
      <main className="mx-auto w-full max-w-[72rem] flex-1 px-4 py-8 sm:px-6">{children}</main>
      <ExploreFooter topics={topics} />
    </div>
  );
}
