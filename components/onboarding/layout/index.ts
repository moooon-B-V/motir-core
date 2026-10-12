// The onboarding layout primitives (MOTIR-8252), built to the Pattern panel of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`
// (MOTIR-8250). The screen cards compose these; none of them hand-rolls a hero,
// a section band or the wave lines.
export { OnboardingBrandBar, type OnboardingBrandBarProps } from './OnboardingBrandBar';
export {
  OnboardingHero,
  ONBOARDING_HERO_CONTROL_ID,
  type OnboardingHeroProps,
} from './OnboardingHero';
export { OnboardingSection, type OnboardingSectionProps } from './OnboardingSection';
export {
  SectionArt,
  ArtPaper,
  ArtBar,
  type SectionArtProps,
  type SectionArtTint,
  type ArtPaperProps,
  type ArtBarProps,
} from './SectionArt';
export { OnboardingLinkOut, type OnboardingLinkOutProps } from './OnboardingLinkOut';
export { WarmButton, WARM_CTA } from './WarmButton';
export {
  OnboardingWizardBar,
  BAR_SECONDARY_HOVER,
  BAR_GHOST_HOVER,
  type OnboardingWizardBarProps,
} from './OnboardingWizardBar';
export { OnboardingWorkBand, type OnboardingWorkBandProps } from './OnboardingWorkBand';
