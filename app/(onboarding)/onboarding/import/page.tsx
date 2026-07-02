import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { GitBranch } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';

// The import hand-off placeholder (Subtask 7.22.4 / MOTIR-1462). The entrance's
// "I have an existing project — import it" row routes here. Building the actual
// migrate wizard — connect a repository, read the code, import work items from
// Jira / Linear / Plane, index + generate a plan on top — is DOWNSTREAM and owned
// by its own stories (7.15 / MOTIR-815 · MOTIR-930 · MOTIR-931 and 7.17 /
// MOTIR-817). MOTIR-1462 deliberately "stops at the hand-off": it draws the fork
// and makes each destination reachable, and NO connect / source-selection / index
// / generate UI is built here.
//
// So this is an explicit, visible SEAM — a minimal "coming soon" surface using
// the shared `EmptyState` primitive (not an improvised feature) — that the 7.15
// wizard replaces in place. Shipping it (rather than a raw 404 behind the fork's
// Import row) keeps the entrance's two paths both functional today. The route
// path (`/onboarding/import`) is the provisional hand-off target; if 7.15 chooses
// a different one, only the entrance's link + this file change.
export default async function OnboardingImportPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in?next=%2Fonboarding%2Fimport');

  const t = await getTranslations('onboarding.import');
  return (
    <div className="mx-auto flex min-h-dvh max-w-[41.25rem] items-center px-7">
      <EmptyState
        icon={<GitBranch className="size-6" />}
        title={t('title')}
        description={t('body')}
        action={
          <Link href="/onboarding">
            <Button variant="secondary">{t('back')}</Button>
          </Link>
        }
      />
    </div>
  );
}
