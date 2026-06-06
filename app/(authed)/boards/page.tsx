import { getTranslations } from 'next-intl/server';
import { ProjectStubPage } from '../_components/ProjectStubPage';

// Placeholder route so the sidebar "Boards" link resolves; Epic 3 ships the
// real surface.
export default async function BoardsPage() {
  const t = await getTranslations('shell');
  return <ProjectStubPage title={t('nav.boards')} comingIn="Epic 3" />;
}
