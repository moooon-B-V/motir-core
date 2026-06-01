import { systemPing } from './definitions/systemPing';

// The list of registered Inngest functions the serve route mounts (Story 1.6 ·
// Subtask 1.6.2). Adding a new job = define it under `definitions/` and add it
// here; the serve route imports from THIS file, never from individual job
// files, so a new job never touches `app/api/inngest/route.ts`.
export const jobFunctions = [systemPing];
