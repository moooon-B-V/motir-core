// A Sentry "Retrieve an Issue Event" response (`…/events/latest/`) for the
// frame normalizer's tests (Story MOTIR-4930 · Subtask MOTIR-5846).
//
// ⚠️ SHAPED FROM SENTRY'S DOCUMENTATION, NOT CAPTURED FROM SENTRY.IO — the suite
// may not reach the host (`lib/monitors/provider.ts`'s header). The envelope is
// the documented example of https://docs.sentry.io/api/events/retrieve-an-issue-event/
// and the exception entry follows
// https://develop.sentry.dev/sdk/data-model/event-payloads/stacktrace/ (both
// read 2026-09-21): `entries[]` holds a `type: "exception"` item whose
// `data.values[]` is the chain CAUSE FIRST, and each value's
// `stacktrace.frames[]` is OLDEST CALL FIRST, with `filename` / `absPath` /
// `module` / `function` / `lineNo` / `inApp` per frame.
//
// The frames deliberately arrive in NEITHER order the normalizer produces —
// library and application frames interleaved, oldest first — so an assertion on
// the output order cannot pass by the input already being in it.

/** The latest event of a Next.js route handler that threw inside the app's
 *  service layer, wrapped by a framework error and re-thrown. */
export const SENTRY_LATEST_EVENT = {
  id: '9fac2ceed9344f2bbfdd1fdacb0ed9b1',
  eventID: '9fac2ceed9344f2bbfdd1fdacb0ed9b1',
  groupID: '4501',
  title: "TypeError: Cannot read properties of undefined (reading 'id')",
  culprit: 'app/api/v1/work-items/[key]/route.ts in GET',
  platform: 'node',
  dateCreated: '2026-09-20T18:04:11.000Z',
  tags: [
    { key: 'level', value: 'error' },
    { key: 'environment', value: 'production' },
  ],
  release: { version: 'motir-core@5dd0999' },
  entries: [
    {
      type: 'breadcrumbs',
      data: { values: [{ category: 'http', message: 'GET /api/v1/work-items/ACME-7' }] },
    },
    {
      type: 'exception',
      data: {
        excOmitted: null,
        hasSystemFrames: true,
        values: [
          // The CAUSE — first in Sentry's chain order. Its frames must NOT be the
          // ones returned while a later value carries frames of its own.
          {
            type: 'PrismaClientKnownRequestError',
            value: 'Record not found',
            stacktrace: {
              frames: [
                {
                  filename: 'node_modules/@prisma/client/runtime/library.js',
                  function: 'handleRequestError',
                  lineNo: 121,
                  inApp: false,
                },
              ],
            },
          },
          // The exception that SURFACED — last in the chain.
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'id')",
            mechanism: { type: 'onunhandledrejection', handled: false },
            stacktrace: {
              frames: [
                // OLDEST call first, exactly as Sentry states them.
                {
                  filename: 'node:internal/process/task_queues',
                  absPath: 'node:internal/process/task_queues',
                  function: 'process.processTicksAndRejections',
                  lineNo: 95,
                  colNo: 5,
                  inApp: false,
                },
                {
                  filename: 'node_modules/next/dist/server/base-server.js',
                  function: 'DevServer.handleRequest',
                  lineNo: 1210,
                  inApp: false,
                },
                {
                  filename: 'app/api/v1/work-items/[key]/route.ts',
                  absPath: '/app/app/api/v1/work-items/[key]/route.ts',
                  module: 'app.api.v1.work-items.[key].route',
                  function: 'GET',
                  lineNo: 42,
                  colNo: 18,
                  inApp: true,
                },
                {
                  filename: 'node_modules/next/dist/server/lib/trace/tracer.js',
                  function: 'NextTracerImpl.trace',
                  lineNo: 131,
                  inApp: false,
                },
                {
                  filename: 'lib/services/workItemsService.ts',
                  function: 'workItemsService.getByKey',
                  lineNo: 318,
                  inApp: true,
                },
                // A frame with no line and no function, as a minified frame is.
                {
                  filename: 'lib/workItems/present.ts',
                  inApp: true,
                },
                {
                  // No filename: the path is only on absPath.
                  absPath: '/app/lib/repositories/workItemRepository.ts',
                  function: 'findByKey',
                  lineNo: 77,
                  inApp: true,
                },
                // A frame naming no file at all — dropped, never invented.
                { function: '<anonymous>', lineNo: 1, inApp: false },
              ],
            },
          },
        ],
      },
    },
  ],
};

/** A latest event carrying `count` library frames and one app frame, oldest
 *  first — for asserting the cut at the named bound. */
export function sentryEventWithFrames(count: number): Record<string, unknown> {
  const frames: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    frames.push({
      filename: `node_modules/lib/frame-${i}.js`,
      function: `frame${i}`,
      lineNo: i + 1,
      inApp: false,
    });
  }
  // The OLDEST frame is the application's: an unordered cut would drop it.
  frames.unshift({ filename: 'lib/boot.ts', function: 'boot', lineNo: 1, inApp: true });
  return {
    id: 'deep',
    tags: [],
    release: null,
    entries: [{ type: 'exception', data: { values: [{ type: 'Error', stacktrace: { frames } }] } }],
  };
}
