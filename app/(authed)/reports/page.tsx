import { getTranslations } from 'next-intl/server';
import { ProjectStubPage } from '../_components/ProjectStubPage';

// Placeholder route so the sidebar "Reports" link resolves; Epic 6 ships the
// real surface.
export default async function ReportsPage() {
  const t = await getTranslations('shell');
  return <ProjectStubPage title={t('nav.reports')} comingIn="Epic 6" />;
}
