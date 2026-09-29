import { withV1Route } from '@/lib/api/v1/route';
import { serveReadyContainerLane } from '@/lib/api/v1/ready/lanes';

// GET /api/v1/projects/{projectKey}/ready/containers (Story MOTIR-6829 ·
// MOTIR-6832) — the CONTAINERS lane: every non-bug runnable container holding a
// ready leaf, in the leaves lane's group order. What `motir next --parent` runs.
// The body is `lib/api/v1/ready/lanes.ts`.
// ⚠️ `acceptsRunToken` — a hosted run's own credential may call this (`motir
// next --parent`, MOTIR-6837), bound as `lib/hostedRuns/runTokenRoutes.ts` says.
export const GET = withV1Route<{ projectKey: string }>(
  { permission: 'project:browse', acceptsRunToken: true },
  (ctx) => serveReadyContainerLane(ctx),
);
