import { withV1Route } from '@/lib/api/v1/route';
import { serveReadyContainerLane } from '@/lib/api/v1/ready/lanes';

// GET /api/v1/projects/{projectKey}/ready/containers (Story MOTIR-6829 ·
// MOTIR-6832) — the CONTAINERS lane: every non-bug runnable container holding a
// ready leaf, in the leaves lane's group order. What `motir next --parent` runs.
// The body is `lib/api/v1/ready/lanes.ts`.
export const GET = withV1Route<{ projectKey: string }>({ permission: 'project:browse' }, (ctx) =>
  serveReadyContainerLane(ctx),
);
