import { withV1Route } from '@/lib/api/v1/route';
import { serveReadyRowLane } from '@/lib/api/v1/ready/lanes';

// GET /api/v1/projects/{projectKey}/ready/leaves (Story MOTIR-6829 · MOTIR-6832)
// — the LEAVES lane: the ready set minus bug work, grouped by runnable container.
// What `motir next` takes from. The body is `lib/api/v1/ready/lanes.ts`, which
// follows `…/ready/route.ts`: the route never re-derives readiness.
export const GET = withV1Route<{ projectKey: string }>({ permission: 'project:browse' }, (ctx) =>
  serveReadyRowLane(ctx, 'leaf'),
);
