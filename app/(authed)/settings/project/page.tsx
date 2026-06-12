import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { ArchiveProjectCard } from './_components/ArchiveProjectCard';

// Project settings landing — server component. Story 6.5.2 turned the flat card
// HUB this used to be into the settings AREA: the per-section navigation cards
// (Workflow / Board / Estimation / Fields / Components / Members) are RETIRED —
// the settings rail (SidebarNav, driven by the projectSettingsNav registry) owns
// navigation now. The settings-area layout (../layout.tsx) guards no-project /
// no-access for the whole area.
//
// This route IS the area's landing — the registry's `details` entry. Story 6.5.3
// rebuilds it into the full read-only Details page (identity rows + the re-homed
// Archive danger zone); for now it keeps the project header + the Archive card
// (the only card that doesn't move into the nav — it moves into Details in 6.5.3).

export default async function ProjectSettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const project = await getActiveProject();
  if (!project) {
    // Defensive — the area layout already renders the no-project empty state, but
    // keep the route self-sufficient so it never 404s on its own.
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('area.noProjectTitle')} description={t('area.noProjectDescription')} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('project.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('project.subtitle')}</p>
      </header>

      <ArchiveProjectCard
        projectId={project.projectId}
        projectName={project.project.name}
        projectIdentifier={project.project.identifier}
      />
    </div>
  );
}
