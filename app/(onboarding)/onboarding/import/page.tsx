import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  BAR_GHOST_HOVER,
  OnboardingHero,
  OnboardingWizardBar,
  OnboardingWorkBand,
} from '@/components/onboarding/layout';
import { getSession } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import { ImportWizard } from './_components/ImportWizard';
import { loadImportWizard } from './_data';
import { resolveJustConnected } from './_justConnected';

// The import wizard (Story 7.16 · MOTIR-942) — connect → map → dry-run preview →
// run. Lives at `/onboarding/import` because the shipped per-vendor OAuth flows
// (7.16.11–13) hardcode this as their return path (`IMPORT_PATH`); it REPLACES
// the 7.22.4 "coming soon" hand-off stub in place. The migrate wizard's Import
// step runs the same component inline (MOTIR-8254); this route stays for the
// person who reaches it directly. Server Component: reads via services, hands
// the client island its data + connected-source state (4-layer).
//
// On the onboarding vibe layout (MOTIR-8254, `design/import/design-notes.md`
// § 2026-10-12): the wizard's bar, a hero (full on the picker, compact on the
// wizard) and one band, with no outer centred card.

export default async function OnboardingImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const projectId = typeof sp['projectId'] === 'string' ? sp['projectId'] : undefined;
  const importId = typeof sp['importId'] === 'string' ? sp['importId'] : undefined;

  const result = await loadImportWizard({ projectId, importId });
  if (result.kind === 'unauthenticated') redirect('/sign-in?next=%2Fonboarding%2Fimport');

  const t = await getTranslations('import');
  const tm = await getTranslations('onboardingMigrate');
  const session = await getSession();
  const userInitial = (session?.user.name?.[0] ?? 'M').toUpperCase();

  // F1: the importer has no Save & exit of its own; it borrows the wizard's key
  // (same words) and goes where the Connect step's Cancel goes.
  const bar = (
    <OnboardingWizardBar flowName={t('chrome.title')} userInitial={userInitial}>
      <Link
        href={ONBOARDING_ENTRY_PATH}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), BAR_GHOST_HOVER)}
      >
        {tm('common.saveExit')}
      </Link>
    </OnboardingWizardBar>
  );

  if (result.kind === 'chooseProject') {
    return (
      <div className="flex min-h-dvh flex-col bg-(--el-page-bg)">
        <OnboardingHero bar={bar} headline={t('hero.headline')} lede={t('hero.lede')} />
        <OnboardingWorkBand>
          <div className="mx-auto grid w-full max-w-[72rem] items-start gap-x-14 gap-y-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <h2 className="m-0 font-serif text-[34px] leading-[0.98] font-bold tracking-[-0.03em] text-balance text-(--el-text) md:text-[56px]">
              {t('projectPicker.heading')}
            </h2>
            <div className="grid gap-5">
              <p className="m-0 max-w-[44ch] text-[18px] leading-normal text-(--el-text-secondary)">
                {t('projectPicker.body')}
              </p>
              {result.data.projects.length === 0 ? (
                <EmptyState
                  title={t('projectPicker.label')}
                  description={t('projectPicker.empty')}
                />
              ) : (
                <ul
                  aria-label={t('projectPicker.label')}
                  className="m-0 flex list-none flex-col gap-2 p-0"
                >
                  {result.data.projects.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/onboarding/import?projectId=${encodeURIComponent(p.id)}`}
                        className="block rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-card-padding-12) text-sm text-(--el-text) hover:border-(--el-border-strong)"
                      >
                        {p.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </OnboardingWorkBand>
      </div>
    );
  }

  const { data } = result;
  const justConnected = resolveJustConnected(sp);

  return (
    <div className="flex min-h-dvh flex-col bg-(--el-page-bg)">
      <OnboardingHero bar={bar} compact headline={t('hero.headline')} lede={t('hero.lede')} />
      <OnboardingWorkBand>
        <div className="mx-auto w-full max-w-[72rem]">
          <ImportWizard
            project={data.project}
            statuses={data.statuses}
            connected={data.connected}
            existingImportId={data.existingImport?.id ?? null}
            justConnected={justConnected}
          />
        </div>
      </OnboardingWorkBand>
    </div>
  );
}
