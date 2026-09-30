'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { runsHref } from '@/lib/runs/runsAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// EVERY REFUSAL, IN WORDS (MOTIR-6868 revision 3, panel 5). A route answers a
// refusal as `{ code, error, reason? }`; the page renders the DESIGN's localised
// sentence for it, never the server's English `error`. Create and Wake are refused
// before any machine boots, so each sentence says which rule refused and what to do.

/** What the page knows about a refused request. */
export interface AgentRefusal {
  /** `busy` is a wait (the warning ground); everything else a refusal (rose). */
  kind: 'refusal' | 'busy';
  message: ReactNode;
}

interface RefusalBody {
  code?: string;
  reason?: string;
  /** `agent_instance_run_active` (MOTIR-7027): the run holding the agent, and its card. */
  runId?: string;
  workItemKey?: string | null;
}

/** The copy key a refused response maps to. Exported for the unit test. */
export function refusalKey(body: RefusalBody | null): string {
  switch (body?.reason) {
    case 'credits':
      return 'credits';
    case 'credits_unknown':
      return 'creditsUnknown';
    case 'user_cap':
      return 'userCap';
    case 'fleet_busy':
      return 'busy';
  }
  switch (body?.code) {
    case 'agent_instance_run_active':
      return 'runActive';
    case 'agent_instance_name_taken':
      return 'nameTaken';
    case 'agent_instance_name_invalid':
      return 'nameInvalid';
    case 'agent_profile_not_offered':
      return 'notOffered';
    case 'agent_instances_unavailable':
      return 'unavailable';
    case 'agent_instance_state_conflict':
    case 'agent_instance_not_found':
      return 'conflict';
  }
  return 'generic';
}

/** Build the refusal a failed response should show. */
export function useAgentRefusal(maxPerUser: number) {
  const t = useTranslations('myAgents.refusal');
  const tRun = useTranslations('myAgents.panel.run');
  // The Start bar shares this with the Visitor tree's item page (MOTIR-6888).
  const routes = useReaderRoutes();
  return (
    body: RefusalBody | null,
    name?: string,
    action: 'wake' | 'hibernate' | 'delete' = 'hibernate',
  ): AgentRefusal => {
    const key = refusalKey(body);
    if (key === 'runActive') {
      // Hibernate / Delete during a run (MOTIR-7029 panel 2): name the run, link it.
      const runId = body?.runId ?? '';
      return {
        kind: 'refusal',
        message: tRun.rich(action === 'delete' ? 'refusedDelete' : 'refusedHibernate', {
          name: name ?? '',
          key: body?.workItemKey ?? runId,
          link: (chunks) => (
            <Link
              href={routes.view(runsHref({ run: runId }))}
              className="text-(--el-link) underline"
            >
              {chunks}
            </Link>
          ),
        }),
      };
    }
    const message =
      key === 'credits'
        ? t.rich('credits', {
            link: (chunks) => (
              <Link href="/settings/organization/billing" className="text-(--el-link) underline">
                {chunks}
              </Link>
            ),
          })
        : key === 'userCap'
          ? t('userCap', { count: maxPerUser })
          : key === 'nameTaken'
            ? t('nameTaken', { name: name ?? '' })
            : t(key);
    return { kind: key === 'busy' ? 'busy' : 'refusal', message };
  };
}

/** The refusal box — rose for a refusal, peach for a wait. */
export function RefusalBox({ refusal }: { refusal: AgentRefusal }) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-(--radius-card) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong) ${
        refusal.kind === 'busy' ? 'bg-(--el-tint-peach)' : 'bg-(--el-tint-rose)'
      }`}
    >
      <TriangleAlert className="mt-0.5 size-4 flex-none" aria-hidden="true" />
      <span>{refusal.message}</span>
    </div>
  );
}
