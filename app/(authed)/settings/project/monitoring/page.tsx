import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import {
  MONITOR_CONNECT_RESULT_COOKIE,
  decodeMonitorConnectResult,
} from '@/lib/monitors/connectResult';
import {
  buildMonitoringBanner,
  type MonitoringBannerTranslator,
} from '@/lib/monitors/returnBanner';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { guardSettingsPage } from '../_guard';
import { MonitoringLoading } from './_components/MonitoringStates';
import { MonitoringLoadError } from './_components/MonitoringLoadError';
import { MonitoringRoom } from './_components/MonitoringRoom';

// THE MONITORING ROOM (Story MOTIR-4928 · MOTIR-5262). Layout source of truth:
// `design/monitoring/monitoring-room.mock.html` panels 1, 1b, 2–5, 8, 9 and 10,
// and `design-notes.md` §11 for the revision. The project picker (panels 6–7) is
// MOTIR-5297's and renders INSIDE this room.
//
// A SERVER component over a client island, and the island holds NO copy of the
// view: every value it renders arrives as a prop from the read below, so
// `router.refresh()` after re-check, disconnect, or a bind from the picker
// re-runs that read and the island re-renders with it. That is the page-state
// contract's server-refresh case on purpose — there is no `useState(view)` for a
// refresh to fail to reach. `router.refresh()` is therefore also the mechanism
// the picker calls after binding.
//
// ⚠️ NO `loading.tsx`. This route decides whether a project has a connection at
// all, and CLAUDE.md forbids a route-level boundary above such a route. Loading
// and error are the room's OWN renders (panel 9), inside an in-page `<Suspense>`
// placed after the gate.
//
// ⚠️ THE `error` BANNER'S REASON COMES FROM A COOKIE, NEVER FROM THE URL. The
// callback sets `motir_monitor_result` (httpOnly) on its redirect; a `reason`
// query parameter would let a crafted link put any sentence on this page after
// "Sentry says:". So the reason is read only alongside `?monitor=error`, and a
// query string cannot supply one.
interface MonitoringPageProps {
  searchParams: Promise<{ monitor?: string | string[] }>;
}

export default async function MonitoringPage({ searchParams }: MonitoringPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) redirect('/sign-in');

  // THE DESTINATION GUARD — the key comes from the registry entry `monitoring`.
  const refused = await guardSettingsPage('monitoring', ctx);
  if (refused) return refused;

  const t = await getTranslations('monitoring');
  const sp = await searchParams;
  // Read here, above the boundary, because `cookies()` is request state; the
  // DECISION of whether it is used lives in `buildMonitoringBanner`.
  const reasonCookie = (await cookies()).get(MONITOR_CONNECT_RESULT_COOKIE)?.value;

  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('description')}</p>
      </header>

      <Suspense fallback={<MonitoringLoading label={t('loading')} />}>
        <MonitoringPaneBody
          projectId={ctx.projectId}
          projectKey={ctx.project.identifier}
          userId={ctx.userId}
          workspaceId={ctx.workspaceId}
          searchParams={sp}
          reasonCookie={reasonCookie}
        />
      </Suspense>
    </div>
  );
}

async function MonitoringPaneBody({
  projectId,
  projectKey,
  userId,
  workspaceId,
  searchParams,
  reasonCookie,
}: {
  projectId: string;
  projectKey: string;
  userId: string;
  workspaceId: string;
  searchParams: { monitor?: string | string[] };
  reasonCookie: string | undefined;
}) {
  const t = await getTranslations('monitoring');
  let view;
  try {
    view = await monitorConnectionService.getView(projectId, { userId, workspaceId });
  } catch (err) {
    // Panel 9's error: the room's own render, whose one claim is that nothing
    // changed. Logged, because swallowing it would make the state undebuggable.
    console.error('[monitoring] room read failed', err);
    return (
      <MonitoringLoadError
        title={t('error.title')}
        body={t('error.body')}
        retryLabel={t('error.retry')}
      />
    );
  }

  // Relative times are formatted HERE, against one server `now`, and handed down
  // as strings: a client render would disagree with the server's clock by the
  // round trip and hydrate different words.
  const format = await getFormatter();
  const now = new Date();
  const org = view.orgSlug ?? t('grant.unknownOrg');

  const banner = buildMonitoringBanner({
    searchParams,
    reasonCookie,
    org,
    // The catalog's key type is a literal union; the builder composes keys from
    // the status map, which `tests/monitors/returnBanner.test.ts` checks against
    // both catalogs, so the widening here cannot reach a missing key.
    t: t as unknown as MonitoringBannerTranslator,
    decodeReason: decodeMonitorConnectResult,
  });

  return (
    <MonitoringRoom
      projectKey={projectKey}
      view={view}
      banner={banner}
      checkedLabel={
        view.healthCheckedAt
          ? t('grant.checked', { when: format.relativeTime(new Date(view.healthCheckedAt), now) })
          : null
      }
      boundLabels={Object.fromEntries(
        view.connections.map((c) => [
          c.id,
          t('row.bound', { when: format.relativeTime(new Date(c.createdAt), now) }),
        ]),
      )}
    />
  );
}
