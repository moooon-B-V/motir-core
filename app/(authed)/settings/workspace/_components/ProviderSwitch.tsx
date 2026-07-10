'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Segmented } from '@/components/ui/Segmented';
import { GithubMark } from '@/components/icons/GithubMark';
import { GitlabMark } from '@/components/icons/GitlabMark';

// The provider picker for the shared "Git" settings surface (Story 7.23 ·
// MOTIR-1478, design/gitlab Panel 1 + 6). The two providers — GitHub (7.10) and
// GitLab (7.23) — render through ONE shared shell; this Segmented [GitHub | GitLab]
// is the in-page door that swaps which provider's connect panel shows. Selecting a
// provider navigates to that provider's thin route (`/settings/workspace/github`
// | `/settings/workspace/gitlab`), both of which render the same shell with the
// other segment pressed — so the chrome is provably shared and only the connect
// content varies (the card's "provider is a variant, not a separate look").
//
// The shipped `Segmented` primitive: an accessible `role="group"` of real
// `<button aria-pressed>`s, coloured/shaped through `--el-*` + element-semantic
// tokens. The provider marks are the monochrome `currentColor` GithubMark /
// GitlabMark (no invented brand hue).

type Provider = 'github' | 'gitlab';

export function ProviderSwitch({ active }: { active: Provider }) {
  const t = useTranslations('git');
  const router = useRouter();

  return (
    <Segmented<Provider>
      label={t('provider.label')}
      value={active}
      onChange={(value) => router.push(`/settings/workspace/${value}`)}
      options={[
        { value: 'github', label: t('provider.github'), icon: <GithubMark /> },
        { value: 'gitlab', label: t('provider.gitlab'), icon: <GitlabMark /> },
      ]}
    />
  );
}
