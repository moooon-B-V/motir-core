import { agentWorkspaceBudget } from '@/lib/rateLimit/budgets';
import type { RateLimitLimb } from '@/lib/rateLimit/guard';
import { rateLimitKey } from '@/lib/rateLimit/keys';

// The per-WORKSPACE agent-volume ceiling (MOTIR-8601, Story MOTIR-8548).
//
// Every agent-volume surface keys its own limb per AGENT — a credential, a job —
// so that one person running ten agents gets ten allowances. What that must not
// do is let a tenant buy past a ceiling by minting credentials or starting jobs,
// so each such surface ALSO spends this one limb, shared across all of them:
//
//   - the MCP transport (`lib/rateLimit/mcpGuard.ts`),
//   - `/api/v1` (`lib/api/v1/route.ts`),
//   - the job-token read-backs (`/api/internal/ai/*`), from MOTIR-8604.
//
// ⚠️ THIS IS A CONTRACT the job read-backs card consumes: build the ceiling
// through this function, never by restating the scope and budget, so the
// surfaces cannot drift onto different ceilings.

/** The workspace's shared agent-volume ceiling, as a limb to spend beside a per-agent one. */
export function agentWorkspaceLimb(workspaceId: string): RateLimitLimb {
  return {
    scope: 'agent:workspace',
    key: rateLimitKey('agent:workspace', workspaceId),
    budget: agentWorkspaceBudget(),
  };
}
