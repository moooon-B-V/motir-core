import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import { AuthLanguageControl } from '@/components/i18n/AuthLanguageControl';
import {
  OnboardingHero,
  OnboardingLinkOut,
  OnboardingSection,
} from '@/components/onboarding/layout';
import { DecideArt, SayArt, WatchArt } from '@/components/onboarding/howItWorks/HowItWorksArt';
import { BackToStartLink } from '@/components/onboarding/howItWorks/BackToStartLink';

// "How Motir works" — the explainer behind the entrance's "See how Motir works"
// link (Subtask 7.22.4 / MOTIR-1462 shipped it as an `EmptyState` placeholder
// seam; MOTIR-8253 draws it to Panel 4 of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`,
// design-notes.md § "2026-10-11" and its Revisions 1 and 2):
//
//   the hero       brand bar (the lockup, and the language control at its
//                  trailing end), the H1 and the lede — no control, so the wave
//                  lines gather on the headline group
//   three bands    say · watch · decide, each with its wordless drawing on its
//                  own tint slot (sky · lavender · peach)
//   the link-out   motir.co's closing block pointed outward, to
//                  https://motir.co/how-it-works in a new tab
//   Back to start  the entrance opens this page in a NEW TAB, so Back closes the
//                  tab — or, where the tab cannot be closed, goes to /onboarding
//
// A server component: it reads only the session (the signed-out bounce) and the
// catalogue. It reads no project state, which is why `onboardingRanGate.test`
// records it as deliberately ungated.

const MOTIR_CO_HOW_IT_WORKS_URL = 'https://motir.co/how-it-works';

export default async function OnboardingHowItWorksPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in?next=%2Fonboarding%2Fhow-it-works');

  const t = await getTranslations('onboarding.howItWorks');
  return (
    <div className="min-h-dvh bg-(--el-page-bg)">
      <main>
        <OnboardingHero headline={t('title')} lede={t('body')} barEnd={<AuthLanguageControl />} />
        <OnboardingSection
          title={t('sections.say.title')}
          lede={t('sections.say.body')}
          art={<SayArt />}
        />
        <OnboardingSection
          title={t('sections.watch.title')}
          lede={t('sections.watch.body')}
          art={<WatchArt />}
        />
        <OnboardingSection
          title={t('sections.decide.title')}
          lede={t('sections.decide.body')}
          art={<DecideArt />}
        />
        <OnboardingLinkOut
          title={t('developers.title')}
          body={t('developers.body')}
          cta={t('developers.cta')}
          href={MOTIR_CO_HOW_IT_WORKS_URL}
          newTabLabel={t('developers.newTab')}
        />
        <div className="border-t border-(--el-border-soft) bg-(--el-page-bg) px-[clamp(16px,3vw,48px)] py-10 md:py-14">
          <BackToStartLink href={ONBOARDING_ENTRY_PATH}>{t('back')}</BackToStartLink>
        </div>
      </main>
    </div>
  );
}
