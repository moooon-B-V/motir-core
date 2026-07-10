import { type ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { ProviderSwitch } from './ProviderSwitch';

// The shared "Git" settings surface shell (Story 7.23 · MOTIR-1478) — the ONE
// connect-settings surface both git providers render through. It owns the page
// chrome (centered column + "Git" header) and the provider `Segmented` picker;
// each provider route passes its own connect panels as `children`. This is the
// card's requirement made concrete — "the SHARED provider connect-settings
// component (GitHub | GitLab as variants), not a separate page": the GitHub route
// (7.10) and the GitLab route (7.23) are thin wrappers that both mount this shell
// with the matching provider pressed, so the chrome is provably shared and only
// the panels below the picker vary. Server Component — the header copy is
// translated server-side; the picker (a client island) handles navigation.
export async function GitSettingsShell({
  provider,
  children,
}: {
  provider: 'github' | 'gitlab';
  children: ReactNode;
}) {
  const t = await getTranslations('git');
  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
          <p className="font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
        </div>
        <ProviderSwitch active={provider} />
      </header>
      {children}
    </div>
  );
}
