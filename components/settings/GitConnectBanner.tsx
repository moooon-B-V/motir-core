import { getTranslations } from 'next-intl/server';
import { GITHUB_BANNER_TONE, type GithubBannerStatus } from '@/lib/github/bannerStatus';
import { SettingsBanner } from '@/app/(authed)/settings/workspace/_components/gitSettingsPrimitives';

// THE `?github=<status>` BANNER, ON WHICHEVER SURFACE THE FLOW RETURNED TO
// (Story MOTIR-4669 · MOTIR-4676).
//
// The OAuth grant and the App install used to land on one hard-coded page, so
// the banner only ever had one host and the page rendered it inline. Now the
// return target is the surface the flow STARTED from
// (`lib/github/returnSurface.ts`), which means several pages have to render the
// same outcome — and the moment more than one does, the way to get it wrong is
// for the second one to restate the status → tone map.
//
// ⚠️ SO THIS COMPONENT RENDERS THE MAP; IT DOES NOT RESTATE IT.
// `GITHUB_BANNER_TONE` stays the ONE declaration (MOTIR-3755 put it in
// `lib/github/bannerStatus.ts` precisely so the routes, the tone and the
// `github.banner.*` copy are checked against a single source), and the map is
// also the ALLOW-LIST: a hand-typed `?github=whatever` is not a key, so it
// renders nothing rather than reaching `t('banner.<anything>')`.
//
// A Server Component, because the copy is translated server-side exactly as it
// was on the page this was lifted out of.

export interface GitConnectBannerProps {
  /** The raw `?github=` search param — unvalidated, straight off the URL. */
  status: string | undefined;
}

export async function GitConnectBanner({ status }: GitConnectBannerProps) {
  const tone =
    status && status in GITHUB_BANNER_TONE
      ? GITHUB_BANNER_TONE[status as GithubBannerStatus]
      : undefined;
  if (!tone) return null;

  const t = await getTranslations('github');
  return <SettingsBanner tone={tone} message={t(`banner.${status as GithubBannerStatus}`)} />;
}
