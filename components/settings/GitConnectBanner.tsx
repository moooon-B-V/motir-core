import { getTranslations } from 'next-intl/server';
import { GITHUB_BANNER_TONE, type GithubBannerStatus } from '@/lib/github/bannerStatus';
import { GITLAB_BANNER_TONE, type GitlabBannerStatus } from '@/lib/gitlab/bannerStatus';
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
  /**
   * The raw `?gitlab=` search param. ⚠️ ONE COMPONENT, TWO PROVIDERS (MOTIR-4680):
   * both flows now return to the same route, so a second banner component would
   * be the restated map this file exists to prevent — one tier down. The two
   * statuses share a tone map and differ only in which `<provider>.banner.*`
   * namespace the copy comes from.
   *
   * Both cannot be set at once by any flow we mint; if a hand-typed URL carries
   * both, GitHub's wins and GitLab's is dropped, because two stacked banners
   * about one round trip is worse than the wrong one of two.
   */
  gitlabStatus?: string | undefined;
}

export async function GitConnectBanner({ status, gitlabStatus }: GitConnectBannerProps) {
  // Each provider resolves through ITS OWN total map, which is also its
  // allow-list: a hand-typed `?github=whatever` is not a key, so it renders
  // nothing rather than reaching `t('banner.<anything>')`.
  if (status && status in GITHUB_BANNER_TONE) {
    const t = await getTranslations('github');
    return (
      <SettingsBanner
        tone={GITHUB_BANNER_TONE[status as GithubBannerStatus]}
        message={t(`banner.${status as GithubBannerStatus}`)}
      />
    );
  }
  if (gitlabStatus && gitlabStatus in GITLAB_BANNER_TONE) {
    const t = await getTranslations('gitlab');
    return (
      <SettingsBanner
        tone={GITLAB_BANNER_TONE[gitlabStatus as GitlabBannerStatus]}
        message={t(`banner.${gitlabStatus as GitlabBannerStatus}`)}
      />
    );
  }
  return null;
}
