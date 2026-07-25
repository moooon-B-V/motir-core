export class PlanEditsClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Plan edits request failed (${status})`);
    this.name = 'PlanEditsClientError';
  }
}

export interface ApproveDeltaResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? null;
  } catch {
    return null;
  }
}

export async function submitExpandJob(
  itemKey: string,
  signal?: AbortSignal,
): Promise<{ jobId: string }> {
  const res = await fetch('/api/ai/expand', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as { jobId: string };
}

export async function approvePlanDelta(
  jobId: string,
  signal?: AbortSignal,
): Promise<ApproveDeltaResult> {
  const res = await fetch('/api/ai/plan-delta/approve', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as ApproveDeltaResult;
}

export async function fetchJobResult(
  jobId: string,
  signal?: AbortSignal,
): Promise<{
  status: string;
  result: { planDelta?: { added?: Array<{ title: string; kind: string }> } } | null;
}> {
  const res = await fetch(`/api/ai/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as {
    status: string;
    result: { planDelta?: { added?: Array<{ title: string; kind: string }> } } | null;
  };
}
