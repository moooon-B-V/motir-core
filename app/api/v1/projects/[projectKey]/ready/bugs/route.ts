import { withV1Route } from '@/lib/api/v1/route';
import { serveReadyRowLane } from '@/lib/api/v1/ready/lanes';

// GET /api/v1/projects/{projectKey}/ready/bugs (Story MOTIR-6829 · MOTIR-6832)
// — the BUGS lane: a ready bug, or a ready subtask of one, grouped under its bug.
// What `motir next --bug` takes from. The body is `lib/api/v1/ready/lanes.ts`.
export const GET = withV1Route<{ projectKey: string }>({ permission: 'project:browse' }, (ctx) =>
  serveReadyRowLane(ctx, 'bug'),
);
