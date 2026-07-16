import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { MigrateWizard } from './_components/MigrateWizard';

// The migrate-onboarding wizard (Story 7.15 · MOTIR-934) — the stepped,
// resumable set-up shell for onboarding an EXISTING codebase. Full-screen in
// the `(onboarding)` route group (no app shell — a minimal brand bar), at its
// own route `/onboarding/migrate` (the issue importer MOTIR-942 occupies
// `/onboarding/import`; the entrance's existing-project door routes here).
//
// A Server Component that reads the project's migrate run — its SAVED step —
// via the state-machine service (4-layer: this page calls ONE service method,
// no DB), and hands it to the client island. Re-opening resumes at the saved
// step (never restarts). The client island drives the step transitions through
// the migrate API routes (advance / skip-import / index-status poll); it never
// calls the service layer directly.
export default async function MigrateOnboardingPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in?next=%2Fonboarding%2Fmigrate');

  const ctx = await getActiveProject();
  if (!ctx) redirect('/onboarding');

  const run = await migrateOnboardingService.getForProject(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  // A completed run means the project's plan was approved — onboarding is done.
  // Land the user on the roadmap, not the wizard.
  if (run?.status === 'completed') redirect('/roadmap');

  return (
    <MigrateWizard
      initialRun={run}
      projectName={ctx.project.name}
      userInitial={(session.user.name?.[0] ?? 'M').toUpperCase()}
    />
  );
}
