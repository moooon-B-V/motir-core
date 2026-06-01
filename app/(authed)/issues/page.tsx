import { ProjectStubPage } from '../_components/ProjectStubPage';

// Placeholder route so the sidebar "Issues" link resolves; Epic 2 ships the
// real surface.
export default function IssuesPage() {
  return <ProjectStubPage title="Issues" comingIn="Epic 2" />;
}
