import { withV1Route } from '@/lib/api/v1/route';
import { serveReadyRowLane } from '@/lib/api/v1/ready/lanes';

// GET /api/v1/projects/{projectKey}/ready/bugs (Story MOTIR-6829 · MOTIR-6832)
// — the BUGS lane: a ready bug, or a ready subtask of one, grouped under its bug.
// What `motir next --bug` takes from. The body is `lib/api/v1/ready/lanes.ts`.
// ⚠️ `acceptsRunToken` — a hosted run's own credential may call this (the CLI's
// ready reads, MOTIR-6835), bound as `lib/hostedRuns/runTokenRoutes.ts` says.
export const GET = withV1Route<{ projectKey: string }>(
  { permission: 'project:browse', acceptsRunToken: true },
  (ctx) => serveReadyRowLane(ctx, 'bug'),
);
