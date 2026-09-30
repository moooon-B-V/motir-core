'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';

// EVERY REFUSAL, IN WORDS (MOTIR-6868 revision 3, panel 5). A route answers a
// refusal as `{ code, error, reason? }`; the page renders the DESIGN's localised
// sentence for it, never the server's English `error`. Create and Wake are refused
// before any machine boots, so each sentence says which rule refused and what to do.
// MOTIR-6916's delta (MOTIR-6918 builds it): the rules a person can act on with
// money or a count — the AI plan, credits, the per-person cap — open with a bold
// TITLE naming the rule, so two limits never read as one.

/** What the page knows about a refused request. */
export interface AgentRefusal {
  /** `busy` is a wait (the warning ground); everything else a refusal (rose). */
  kind: 'refusal' | 'busy';
  /** The bold line naming the rule (the delta's titled boxes); absent on the rest. */
  title?: string;
  message: ReactNode;
}

interface RefusalBody {
  code?: string;
  reason?: string;
  /** The number a cap refusal names (`org_running_cap`). */
  limit?: number;
}

/** The copy key a refused response maps to. Exported for the unit test. */
export function refusalKey(body: RefusalBody | null): string {
  switch (body?.reason) {
    case 'ai_plan_required':
      return 'aiPlanRequired';
    case 'ai_plan_unknown':
      return 'aiPlanUnknown';
    case 'credits':
      return 'credits';
    case 'credits_unknown':
      return 'creditsUnknown';
    case 'user_cap':
      return 'userCap';
    case 'org_running_cap':
      return 'orgRunningLimit';
    case 'fleet_busy':
      return 'busy';
  }
  switch (body?.code) {
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

/** The keys whose box opens with a title (the delta's table, MOTIR-6916). */
const TITLED = new Set([
  'aiPlanRequired',
  'aiPlanUnknown',
  'credits',
  'userCap',
  'orgRunningLimit',
]);

/** The keys whose sentence carries a link to Billing & plans. */
const BILLING_LINKED = new Set(['aiPlanRequired', 'credits']);

/** Build the refusal a failed response should show. */
export function useAgentRefusal(maxPerUser: number) {
  const t = useTranslations('myAgents.refusal');
  const tt = useTranslations('myAgents.refusalTitle');
  return (body: RefusalBody | null, name?: string): AgentRefusal => {
    const key = refusalKey(body);
    const message = BILLING_LINKED.has(key)
      ? t.rich(key, {
          link: (chunks) => (
            <Link href="/settings/organization/billing" className="text-(--el-link) underline">
              {chunks}
            </Link>
          ),
        })
      : key === 'userCap'
        ? t('userCap', { count: maxPerUser })
        : key === 'orgRunningLimit'
          ? t('orgRunningLimit', { limit: body?.limit ?? 0 })
          : key === 'nameTaken'
            ? t('nameTaken', { name: name ?? '' })
            : t(key);
    return {
      kind: key === 'busy' ? 'busy' : 'refusal',
      ...(TITLED.has(key) ? { title: tt(key) } : {}),
      message,
    };
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
      {refusal.title ? (
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{refusal.title}</span>
          <span>{refusal.message}</span>
        </span>
      ) : (
        <span>{refusal.message}</span>
      )}
    </div>
  );
}
