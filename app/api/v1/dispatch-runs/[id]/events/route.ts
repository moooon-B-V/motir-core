import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { dispatchRunAppendBodySchema } from '@/lib/api/v1/workLoop/schema';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import type { Prisma } from '@/generated/prisma/client';

// POST /api/v1/dispatch-runs/{id}/events (Story MOTIR-1789 · MOTIR-1792) —
// append a batch to the run's ordered stream.
//
// BATCHED, because a chatty agent must not cost one request per line, and
// because a batch is the unit whose ORDER has to survive: the service numbers
// the whole batch inside one transaction, under the run's own row lock.
//
// The route parses and delegates. Every refusal below is a typed domain error
// the service raises and `DOMAIN_ERROR_STATUS` maps — an already-closed run
// (409), an event naming a card the run does not own (422), an over-sized log
// body (413), a run at its event ceiling (422).
export const POST = withV1Route<{ id: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, dispatchRunAppendBodySchema);

  const result = await dispatchRunService.appendEvents(
    ctx.params.id,
    body.events.map((event) => ({
      kind: event.kind,
      ...(event.workItemKey !== undefined ? { workItemKey: event.workItemKey } : {}),
      // `data` is declared as `unknown` on the wire — the structured detail an
      // event carries is per-kind and deliberately not enumerated in the
      // contract. Prisma's `InputJsonValue` is the widest thing the column
      // accepts, and the cast is where that looseness is acknowledged rather
      // than spread through the service.
      ...(event.data !== undefined ? { data: event.data as Prisma.InputJsonValue } : {}),
      ...(event.body !== undefined ? { body: event.body } : {}),
      ...(event.disposition !== undefined ? { disposition: event.disposition } : {}),
      ...(event.skipReason !== undefined ? { skipReason: event.skipReason } : {}),
      ...(event.sessionBranch !== undefined ? { sessionBranch: event.sessionBranch } : {}),
      ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    })),
    ctx.service,
  );

  return NextResponse.json(result);
});
