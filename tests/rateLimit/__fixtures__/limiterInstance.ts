import { createInterface } from 'node:readline';
import { tokenFingerprint } from '@/lib/api/v1/bearer';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { contextFromAuthInfo } from '@/lib/mcp/context';
import { enforceMcpRateLimit } from '@/lib/rateLimit/mcpGuard';
import { resolveRateLimitBackend, sharedRateLimitStore } from '@/lib/rateLimit/store';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';

// ONE "app instance" for the two-instance enforcement suite (MOTIR-8605).
//
// Run as its own OS process with `tsx`, so it holds its own module graph: its
// own `sharedRateLimitStore()` singleton, its own env-read budgets. It runs the
// exact sequence `limitedHandler` in `app/api/mcp/route.ts` runs per request —
// verify the bearer, resolve the context, fingerprint the token, spend the
// limbs — and answers one JSON line per command on stdout.
//
//   stdin:  {"id": 1, "bearer": "motir_pat_…"}
//   stdout: {"id": 1, "status": 200 | 429 | 401, "retryAfterSeconds", "limit", "remaining"}
//
// The Postgres store is pinned to the TEST deadline (MOTIR-3067), unless the
// parent chose the in-process `memory` backend for the control arm.

if (resolveRateLimitBackend() === 'postgres') pinSharedRateLimitStoreDeadline();
// Resolve the store before announcing readiness, so the first call is not the
// one that pays for it.
sharedRateLimitStore();

interface Command {
  id: number;
  bearer: string;
}

async function handle({ id, bearer }: Command): Promise<Record<string, unknown>> {
  const authInfo = await verifyMcpToken(
    new Request('http://instance/api/mcp', { method: 'POST' }),
    bearer,
  );
  if (!authInfo) return { id, status: 401 };
  const ctx = contextFromAuthInfo(authInfo);
  const { refusal, headers } = await enforceMcpRateLimit(ctx, tokenFingerprint(authInfo.token));
  const limit = Number(headers['x-ratelimit-limit']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  if (!refusal) return { id, status: 200, retryAfterSeconds: null, limit, remaining };
  const body = (await refusal.json()) as { error: { data: { retryAfterSeconds: unknown } } };
  return {
    id,
    status: refusal.status,
    retryAfterSeconds: body.error.data.retryAfterSeconds,
    limit,
    remaining,
  };
}

const inFlight = new Set<Promise<unknown>>();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  const command = JSON.parse(line) as Command;
  const work = handle(command).then(
    (answer) => process.stdout.write(`${JSON.stringify(answer)}\n`),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.stdout.write(`${JSON.stringify({ id: command.id, status: 500 })}\n`);
    },
  );
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
});
// Closing stdin is the stop signal: answer what is in flight, then exit 0.
lines.on('close', () => {
  void Promise.allSettled([...inFlight]).then(() => process.exit(0));
});

process.stdout.write('ready\n');
