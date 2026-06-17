import 'server-only';

// The motir-core → motir-ai client: a SERVER-ONLY leaf primitive (like
// lib/email.ts). Services import it; routes never do, and the `server-only`
// import above makes bundling it into a Client Component a build error — the
// open-core invariant that browsers never reach motir-ai (docs/ai-boundary.md).
//
// It is the single seam the 7.2 chat, 7.3/7.4 generation, and the 7.8 planning
// tools call — a clean abstraction over the boundary, not endpoint glue. It
// submits jobs (minting the §4b job-scoped read-back token), polls them, and
// streams them, mapping the §5 problem+json taxonomy to motir-core typed errors.

import { mintJobToken } from './jobToken';
import {
  MotirAiConfigError,
  MotirAiUnavailableError,
  errorFromProblem,
  type JobView,
} from './errors';
import type {
  JobContextBag,
  JobKind,
  JobStreamEvent,
  Problem,
  RawJobResponse,
  RawUsageResponse,
  RequestEnvelope,
  Tenant,
  UsageQuery,
} from './types';

// The actor a job runs on behalf of — the read-back token is minted for them, so
// motir-ai reads/proposes only what this user could (contract §4b).
export interface RequestActor {
  userId: string;
}

interface ClientConfig {
  url: string;
  serviceToken: string;
}

// Read + validate config at CALL time (not module load), so the module imports
// cleanly in dev/test/CI without these env vars set — and fails FAST with a
// clear error the moment a caller actually tries to reach motir-ai.
function config(): ClientConfig {
  const url = process.env['MOTIR_AI_URL'];
  const serviceToken = process.env['MOTIR_AI_SERVICE_TOKEN'];
  if (!url) throw new MotirAiConfigError('MOTIR_AI_URL is not set');
  if (!serviceToken) throw new MotirAiConfigError('MOTIR_AI_SERVICE_TOKEN is not set');
  return { url: url.replace(/\/+$/, ''), serviceToken };
}

function authHeaders(serviceToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${serviceToken}`,
    'content-type': 'application/json',
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort parse of a non-2xx body into a Problem (contract §5); falls back
// to a synthetic problem when the body isn't problem+json.
async function readProblem(res: Response): Promise<Problem> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && typeof (body as Problem).code === 'string') {
      return body as Problem;
    }
  } catch {
    // not JSON — fall through
  }
  return {
    type: 'about:blank',
    title: res.statusText || 'request failed',
    status: res.status,
    code: 'internal_error',
  };
}

// POST /v1/jobs — mint the read-back token, post a valid v1 envelope, return the
// jobId. Never blocks on execution (motir-ai returns 202 immediately).
export async function submitJob(
  kind: JobKind,
  tenant: Tenant,
  context: JobContextBag,
  actor: RequestActor,
): Promise<{ jobId: string }> {
  const { url, serviceToken } = config();
  const readBackToken = mintJobToken({
    userId: actor.userId,
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
  });
  const envelope: RequestEnvelope = {
    envelopeVersion: 'v1',
    jobKind: kind,
    tenant,
    context,
    readBackToken,
  };

  let res: Response;
  try {
    res = await fetch(`${url}/v1/jobs`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify(envelope),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  const body: unknown = await res.json();
  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    throw new MotirAiUnavailableError('submit response missing a jobId');
  }
  return { jobId };
}

// GET /v1/jobs/:id — status + result, with a failed job's error mapped to a
// typed error. A 404 / transport failure throws a typed error.
export async function getJob(jobId: string): Promise<JobView> {
  const { url, serviceToken } = config();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(serviceToken),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  const body = (await res.json()) as RawJobResponse;
  return {
    jobId: body.jobId,
    status: body.status,
    result: body.result ?? null,
    error: body.error ? errorFromProblem(body.error) : null,
  };
}

// GET /v1/usage — the org cost rollup for the cost dashboard (Subtask 7.2.11),
// at a drill level (org / workspace / project). Read-through: the caller is the
// aiUsageService, which has already gated the actor and narrowed the scope. A
// transport failure / non-2xx maps to a typed error the dashboard renders as
// the error/retry state (never a misleading zero balance).
export async function getOrgUsage(query: UsageQuery): Promise<RawUsageResponse> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreOrganizationId: query.coreOrganizationId,
    scope: query.scope,
  });
  if (query.coreWorkspaceId) params.set('coreWorkspaceId', query.coreWorkspaceId);
  if (query.coreProjectId) params.set('coreProjectId', query.coreProjectId);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));

  let res: Response;
  try {
    res = await fetch(`${url}/v1/usage?${params.toString()}`, {
      headers: authHeaders(serviceToken),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawUsageResponse;
}

// GET /v1/jobs/:id/stream — yield SSE frames (status / done / error) as they
// arrive; the generator ends when the stream closes (motir-ai closes it on a
// terminal state). A transport failure throws a typed error before the first
// yield.
export async function* streamJob(jobId: string): AsyncGenerator<JobStreamEvent> {
  const { url, serviceToken } = config();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}/stream`, {
      headers: { Authorization: `Bearer ${serviceToken}`, Accept: 'text/event-stream' },
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  if (!res.body) throw new MotirAiUnavailableError('stream response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Parse one SSE frame ("event: x\ndata: {...}") into a JobStreamEvent. Returns
// null for a comment-only / dataless frame. Exported for unit testing.
export function parseSseFrame(frame: string): JobStreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // leave as raw string
  }
  return { event, data };
}
