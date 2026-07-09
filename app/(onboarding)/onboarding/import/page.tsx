import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ImportWizard } from './_components/ImportWizard';
import type { ImportSourceId } from './_components/importClient';
import { loadImportWizard } from './_data';

// The import wizard (Story 7.16 · MOTIR-942) — connect → map → dry-run preview →
// run. Lives at `/onboarding/import` because the shipped per-vendor OAuth flows
// (7.16.11–13) hardcode this as their return path (`IMPORT_PATH`); it REPLACES
// the 7.22.4 "coming soon" hand-off stub in place. The design's Settings ›
// Project › Import door mounts the same wizard component (a follow-up, once the
// OAuth start routes carry a `returnTo`). Server Component: reads via services,
// hands the client island its data + connected-source state (4-layer).

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

  if (result.kind === 'chooseProject') {
    return (
      <div className="mx-auto w-full max-w-[41.25rem] px-6 py-10">
        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-(--el-text-strong)">
              {t('projectPicker.heading')}
            </h1>
            <p className="text-sm text-(--el-text-muted)">{t('projectPicker.body')}</p>
          </div>
          {result.data.projects.length === 0 ? (
            <EmptyState title={t('projectPicker.label')} description={t('projectPicker.empty')} />
          ) : (
            <ul className="flex flex-col gap-2">
              {result.data.projects.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/onboarding/import?projectId=${encodeURIComponent(p.id)}`}
                    className="block rounded-(--radius-control) border border-(--el-border) px-4 py-3 text-sm text-(--el-text) hover:bg-(--el-surface)"
                  >
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    );
  }

  const { data } = result;
  const justConnected = resolveJustConnected(sp);

  return (
    <ImportWizard
      project={data.project}
      statuses={data.statuses}
      connected={data.connected}
      existingImportId={data.existingImport?.id ?? null}
      justConnected={justConnected}
    />
  );
}

/** Parse the OAuth round-trip return params the shipped callbacks set, recovering
 *  BOTH the source (so its card re-selects) and the success/failure flag:
 *   - Jira → `?jira=connected|denied|state_error|not_configured|error`.
 *   - Linear → `?import=linear_connected|linear_denied|…`.
 *   - Plane  → `?import=plane_connected|plane_denied|…`.
 *  Success is exactly the `…connected` outcome; every other value is a failure. */
function resolveJustConnected(
  sp: Record<string, string | string[] | undefined>,
): { source: ImportSourceId | null; failed: boolean } | undefined {
  const jira = typeof sp['jira'] === 'string' ? sp['jira'] : undefined;
  if (jira) return { source: 'jira', failed: jira !== 'connected' };
  const generic = typeof sp['import'] === 'string' ? sp['import'] : undefined;
  if (generic) {
    const source: ImportSourceId | null = generic.startsWith('linear_')
      ? 'linear'
      : generic.startsWith('plane_')
        ? 'plane'
        : null;
    return { source, failed: !generic.endsWith('connected') };
  }
  return undefined;
}
