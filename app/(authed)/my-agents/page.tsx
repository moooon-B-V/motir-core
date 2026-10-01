import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  INSTANCE_MAX_PER_USER,
  INSTANCE_STORAGE_CREDITS_PER_DAY,
} from '@/lib/agentInstances/config';
import { isCloudBilling } from '@/lib/billing/availability';
import { MY_AGENTS_LIST_LIMIT } from '@/lib/agentInstances/presentation';
import { OFFERED_AGENT_PROFILES } from '@/lib/agentInstances/profiles';
import { memberPageContext, pageScope } from '@/lib/pages/projectPageContext';
import { agentInstanceLifecycleService } from '@/lib/services/agentInstanceLifecycleService';
import { MyAgentsRoom } from './_components/MyAgentsRoom';
import { MyAgentsSkeleton } from './_components/MyAgentsSkeleton';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// MY AGENTS (Story MOTIR-6860 · MOTIR-6874) — the reader's own agent instances on
// the active project. Renders the approved `design/my-agents/my-agents.mock.html`
// (MOTIR-6868, revision 3) over `agentInstanceLifecycleService`.
//
// A MEMBER room only: an agent is the reader's own machine on their own sign-in,
// so there is no Visitor view and no Project view — nobody else's agents are ever
// listed (`agent-instances.md` §8).
//
// ⚠️ THE GATE FIRST, THEN THE FRAME. A reader without `instance:use` gets the
// page's `notFound()` — the way every room refuses a reader it does not admit —
// and the in-page <Suspense> sits AFTER that gate, never a `loading.tsx`
// (`design/shell/design-notes.md` § the navigation-pending grammar).

export default async function MyAgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[]; tab?: string | string[] }>;
}) {
  const ctx = await memberPageContext();
  const [held, t] = await Promise.all([ctx.permissions(), getTranslations('myAgents')]);
  if (!held.has('instance:use')) notFound();
  const project = ctx.project;
  // `?agent=<id>` reopens that agent's panel on a reload or a shared link
  // (MOTIR-6941). The id is only a key into the reader's OWN list below; an id
  // that list does not hold opens the not-available face, never that agent.
  const { agent, tab } = await searchParams;
  const openAgentId = typeof agent === 'string' && agent.length > 0 ? agent : null;
  // `&tab=chat` reopens that agent on its Chat tab (MOTIR-7017); anything else is Terminal.
  const openTab = tab === 'chat' ? 'chat' : 'terminal';
  return (
    <Suspense
      fallback={
        <MyAgentsSkeleton
          title={t('title')}
          subtitle={t('subtitle', { project: project.name })}
          newAgent={t('newAgent')}
        />
      }
    >
      <MyAgentsData
        projectKey={project.identifier}
        projectName={project.name}
        service={pageScope(ctx).service}
        openAgentId={openAgentId}
        openTab={openTab}
      />
    </Suspense>
  );
}

async function MyAgentsData({
  projectKey,
  projectName,
  service,
  openAgentId,
  openTab,
}: {
  projectKey: string;
  projectName: string;
  service: ServiceContext;
  openAgentId: string | null;
  openTab: 'terminal' | 'chat';
}) {
  // A failed first read is its own face, never the empty state — "we could not
  // load" and "you have none" are opposite facts (panel 7).
  const initial = await agentInstanceLifecycleService
    .list(projectKey, { take: MY_AGENTS_LIST_LIMIT, skip: 0 }, service)
    .catch((err: unknown) => {
      console.error('[my-agents] the first read failed', {
        projectKey,
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  return (
    <MyAgentsRoom
      projectKey={projectKey}
      projectName={projectName}
      initial={initial}
      profiles={OFFERED_AGENT_PROFILES.map((p) => ({ id: p.id, name: p.name }))}
      maxPerUser={INSTANCE_MAX_PER_USER}
      // agent-instance-storage.md §2: storage is charged on a cloud build only.
      storageCreditsPerDay={isCloudBilling() ? INSTANCE_STORAGE_CREDITS_PER_DAY : null}
      openAgentId={openAgentId}
      openTab={openTab}
    />
  );
}
