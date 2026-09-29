import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { INSTANCE_MAX_PER_USER } from '@/lib/agentInstances/config';
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

export default async function MyAgentsPage() {
  const ctx = await memberPageContext();
  const [held, t] = await Promise.all([ctx.permissions(), getTranslations('myAgents')]);
  if (!held.has('instance:use')) notFound();
  const project = ctx.project;
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
      />
    </Suspense>
  );
}

async function MyAgentsData({
  projectKey,
  projectName,
  service,
}: {
  projectKey: string;
  projectName: string;
  service: ServiceContext;
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
    />
  );
}
