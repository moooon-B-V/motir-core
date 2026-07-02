import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';

// The "See how Motir works" explainer placeholder (Subtask 7.22.4 / MOTIR-1462).
// The entrance header links here. The DETAILED lifecycle explainer (idea → plan →
// agents build it) is, per the 7.22.3 design, "its own page/surface, not drawn
// here" — a future design/card owns the polished walkthrough. So this is an
// explicit, visible SEAM using the shared `EmptyState` primitive (not an
// improvised designed surface), the same pattern as the import hand-off stub —
// it keeps the entrance's link functional today rather than a dead link, and the
// real explainer replaces it in place.
export default async function OnboardingHowItWorksPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in?next=%2Fonboarding%2Fhow-it-works');

  const t = await getTranslations('onboarding.howItWorks');
  return (
    <div className="mx-auto flex min-h-dvh max-w-[41.25rem] items-center px-7">
      <EmptyState
        icon={<Sparkles className="size-6" />}
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
