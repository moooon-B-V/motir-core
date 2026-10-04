import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { dispatchRunSchema } from '@/lib/api/v1/workLoop/schema';
import { DispatchRunNotFoundError } from '@/lib/dispatchRuns/errors';
import { normalizeReportedModel } from '@/lib/dispatchRuns/reportedModel';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { MotirClient } from '../../../packages/cli/src/client';
import {
  createDispatchRunReporter,
  type DispatchRunReporter,
} from '../../../packages/cli/src/dispatchRunReporter';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../../helpers/mcpHttpServer';
import { randomToken } from '../../helpers/random';

// STORY GATE — MOTIR-7447 · MOTIR-7505: every leg of a run records the model
// that ran it.
//
// The unit suites each own one side of a seam and stay green while the seam
// drifts: the CLI tests assert the event the reporter is HANDED, the service
// tests assert what `appendEvents` does with an input THEY build, and the
// back-fill test pins the SQL against cases it chose. This file drives the
// shipped pieces end to end instead:
//
//   · the CLI's REAL reporter (`createDispatchRunReporter`) over the REAL
//     `MotirClient`, through a real HTTP listener in front of the real v1
//     routes, into the real Postgres — so the body the reporter batches is the
//     body the route parses, and the leg row is what the service committed;
//   · both reads of that row — `GET /api/v1/dispatch-runs/{id}` and the
//     browser's run DTO — asserted to say the same `model`;
//   · the OLD shape (`data.model` only), which every installed CLI sends;
//   · one shared input table run through BOTH `normalizeReportedModel` and the
//     back-fill migration's own SQL, so the two validity rules cannot drift
//     apart without this file going red;
//   · Q3 §3's field-name boundary, and workspace isolation.

const BACKFILL = path.join(
  process.cwd(),
  'prisma/migrations/20261003220000_dispatch_run_card_model_backfill/migration.sql',
);

function backfillStatement(): string {
  return readFileSync(BACKFILL, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim()
    .replace(/;\s*$/, '');
}

let server: McpTestServer;
let fixture: WorkItemFixture;
let token: string;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
  token = await tokenFor(fixture);
});

async function tokenFor(fx: WorkItemFixture): Promise<string> {
  const { token: minted } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: `leg-model-gate-${randomToken()}`,
    projectId: fx.projectId,
    permissions: CLI_TOKEN_GRANT.filter((p) => !p.startsWith('lesson:')),
  });
  return minted;
}

async function seedCard(title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title },
    fixture.ctx,
  );
  return item.identifier;
}

/** The CLI's own reporter, opened over the real client against the real routes. */
async function openReporter(
  key: string,
): Promise<{ reporter: DispatchRunReporter; runId: string }> {
  const client = new MotirClient({ serverUrl: server.url, token });
  const warnings: string[] = [];
  const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
  await reporter.open({
    projectKey: fixture.projectIdentifier,
    command: 'run',
    runId: `gate-${randomToken()}`,
    cards: [{ key, disposition: 'queued' }],
  });
  expect(warnings, 'the reporter stayed online').toEqual([]);
  expect(reporter.runId).not.toBeNull();
  return { reporter, runId: reporter.runId! };
}

async function legModel(runId: string): Promise<string | null> {
  return (await adminDb.dispatchRunCard.findFirstOrThrow({ where: { dispatchRunId: runId } }))
    .model;
}

/** Both reads of the run: the v1 route over HTTP, and the browser's DTO. */
async function bothReads(runId: string): Promise<{ api: unknown; browser: unknown }> {
  const res = await fetch(`${server.url}/api/v1/dispatch-runs/${runId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const api = dispatchRunSchema.parse(await res.json()).cards.map((c) => c.model);
  const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
  const browser = detail.cards.map((c) => c.model);
  return { api, browser };
}

describe('the CLI reporter → the v1 route → the leg → both reads', () => {
  it('a top-level model lands on the leg, and both reads return it', async () => {
    const key = await seedCard('a card the agent works');
    const { reporter, runId } = await openReporter(key);

    reporter.event({ kind: 'agent_started', workItemKey: key, disposition: 'running' });
    reporter.event({
      kind: 'agent_exited',
      workItemKey: key,
      exitCode: 0,
      model: 'm',
      data: { model: 'm', signal: null },
    });
    reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'implemented' });
    await reporter.close('completed');
    expect(reporter.offline).toBe(false);

    expect(await legModel(runId)).toBe('m');
    expect(await bothReads(runId)).toEqual({ api: ['m'], browser: ['m'] });
  });

  it('the OLD shape — `data.model` only, as every installed CLI sends — lands too', async () => {
    const key = await seedCard('a card an older CLI works');
    const { reporter, runId } = await openReporter(key);

    reporter.event({
      kind: 'agent_exited',
      workItemKey: key,
      exitCode: 0,
      data: { model: 'm2', signal: null },
    });
    await reporter.close('completed');

    expect(await legModel(runId)).toBe('m2');
    expect(await bothReads(runId)).toEqual({ api: ['m2'], browser: ['m2'] });
  });

  it('a later exit with no model leaves the earlier one in place', async () => {
    const key = await seedCard('a retried card');
    const { reporter, runId } = await openReporter(key);

    reporter.event({ kind: 'agent_exited', workItemKey: key, exitCode: 1, model: 'm' });
    await reporter.flush();
    reporter.event({
      kind: 'agent_exited',
      workItemKey: key,
      exitCode: 0,
      model: null,
      data: { model: null, signal: null },
    });
    await reporter.close('completed');

    expect(await legModel(runId)).toBe('m');
  });

  it('an agent that reported none leaves a null leg model, and the run still closes completed', async () => {
    const key = await seedCard('a card whose agent says nothing');
    const { reporter, runId } = await openReporter(key);

    reporter.event({
      kind: 'agent_exited',
      workItemKey: key,
      exitCode: 0,
      model: null,
      data: { model: null, signal: null },
    });
    reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'implemented' });
    await reporter.close('completed');

    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: 'succeeded', stopReason: 'completed' });
    expect(await legModel(runId)).toBeNull();
    expect(await bothReads(runId)).toEqual({ api: [null], browser: [null] });
  });
});

describe('the back-fill SQL and `normalizeReportedModel` are ONE rule', () => {
  // `undefined` = the key is absent from `data`.
  const TABLE: ReadonlyArray<readonly [string, unknown]> = [
    ['valid', 'claude-opus-5-5'],
    ['padded', '  gpt-5 \t'],
    ['newline-padded', '\ngpt-5\n'],
    ['blank', ''],
    ['whitespace', '   '],
    ['number', 42],
    ['boolean', true],
    ['null', null],
    ['object', { id: 'gpt-5' }],
    ['array', ['gpt-5']],
    ['200 characters', 'm'.repeat(200)],
    ['201 characters', 'm'.repeat(201)],
    ['200 after the trim', ` ${'m'.repeat(200)} `],
    ['missing', undefined],
  ];

  it('gives the same outcome for every row', async () => {
    const keys: string[] = [];
    for (const [label] of TABLE) keys.push(await seedCard(label));
    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'batch',
        reportedBy: 'cli',
        cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
      },
      fixture.ctx,
    );
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
    const legOf = (key: string) => legs.find((l) => l.workItemKey === key)!.id;

    // Straight into the table, as a server older than the writer stored them.
    let seq = 0;
    for (const [i, [, value]] of TABLE.entries()) {
      seq += 1;
      await adminDb.dispatchRunEvent.create({
        data: {
          workspaceId: fixture.workspaceId,
          dispatchRunId: run.id,
          dispatchRunCardId: legOf(keys[i]!),
          seq,
          kind: 'agent_exited',
          data: (value === undefined ? { signal: null } : { model: value }) as never,
        },
      });
    }

    await adminDb.$executeRawUnsafe(backfillStatement());

    const after = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
    for (const [i, [label, value]] of TABLE.entries()) {
      const row = after.find((l) => l.workItemKey === keys[i])!;
      expect(row.model, label).toBe(normalizeReportedModel(value));
    }
  });
});

describe('the boundaries', () => {
  it('Q3 §3 — the leg gains `model` and still no usage, token, credit or cost column', () => {
    const fields = Object.keys(adminDb.dispatchRunCard.fields);
    expect(fields).toContain('model');
    expect(fields.filter((f) => /usage|token|credit|cost/i.test(f))).toEqual([]);
  });

  it('a leg in another workspace is neither written nor returned', async () => {
    const key = await seedCard('a card in the first workspace');
    const { reporter, runId } = await openReporter(key);
    await reporter.close('completed');

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherToken = await tokenFor(other);

    const append = await fetch(`${server.url}/api/v1/dispatch-runs/${runId}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ kind: 'agent_exited', workItemKey: key, model: 'intruder' }],
      }),
    });
    expect(append.status).toBe(404);
    const read = await fetch(`${server.url}/api/v1/dispatch-runs/${runId}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(read.status).toBe(404);
    await expect(dispatchRunService.getRun(runId, other.ctx)).rejects.toBeInstanceOf(
      DispatchRunNotFoundError,
    );
    expect(await legModel(runId)).toBeNull();
  });
});
