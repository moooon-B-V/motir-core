// SHARED HARNESS for the size-refusal suites (Story MOTIR-7092 · MOTIR-7130 /
// MOTIR-7133): the container exit script and motir-ai's run-verdict answer, the
// one HTTP seam outside this repository.

import { vi } from 'vitest';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { INDEX_REPO_REF } from './indexFleet';

export const GIB = 1024 ** 3;
/** 1.4 GiB — the refused graph every case uses. */
export const REFUSED_SIZE = 1_503_238_554;

/** Container N (in provision order) exits with `codes[N-1]`; past the list, the last. */
export function containersExitWith(...codes: Array<number | null>): void {
  const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
    async (session, previous, options) => {
      const n = Math.min(fakeOrchestrator.provisioned.length, codes.length);
      for (const id of fakeOrchestrator.liveContainerIds()) {
        fakeOrchestrator.completeJob(id, { exitCode: codes[n - 1]! });
      }
      return realPoll(session, previous, options);
    },
  );
}

export type VerdictAnswer = 'refused' | 'upload' | 'none' | 'unreachable' | 'not-found';

/**
 * Wrap the shared fleet stub so motir-ai's run-verdict read answers as motir-ai
 * would for a run whose grant was refused for size (`refused`), one whose PUT
 * failed (`upload`), one with nothing recorded (`none`), an older motir-ai with no
 * such route (`not-found`), or not at all (`unreachable`).
 */
export function motirAiAnswersVerdict(answer: VerdictAnswer): { reads: () => number } {
  const inner = globalThis.fetch;
  let reads = 0;
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (new URL(href).pathname.endsWith('/v1/code-graph/run/verdict')) {
      reads += 1;
      if (answer === 'unreachable') throw new TypeError('fetch failed');
      // An OLDER motir-ai, deployed before the route existed.
      if (answer === 'not-found') {
        return new Response(JSON.stringify({ code: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      const failure =
        answer === 'refused'
          ? {
              failureClass: 'GRAPH_TOO_LARGE',
              message:
                'The code graph is 1.40 GiB uncompressed; the supported maximum is 1.00 GiB.',
              httpStatus: 422,
              sizeBytes: REFUSED_SIZE,
              capBytes: GIB,
              attempts: null,
              reportedAt: new Date().toISOString(),
            }
          : answer === 'upload'
            ? {
                failureClass: 'UPLOAD',
                message: 'HTTP 503',
                httpStatus: 503,
                sizeBytes: null,
                capBytes: null,
                attempts: 4,
                reportedAt: new Date().toISOString(),
              }
            : null;
      return new Response(
        JSON.stringify({
          verdict: failure
            ? { repoRef: INDEX_REPO_REF, runId: 'r', indexMode: null, failure }
            : null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return inner(url, init);
  });
  return { reads: () => reads };
}
