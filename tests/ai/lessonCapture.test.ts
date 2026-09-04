import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The PRODUCER seam of the record-planning-mistakes setting (Story MOTIR-3331 ·
// MOTIR-3350): the project's setting reaches motir-ai on the job envelope's
// `context`, because motir-ai cannot read motir-core's database. Real Postgres
// (the motir-core convention): seed a workspace and project for real, and mock
// only the boundary client — except in the wire case below, which deliberately
// does NOT mock it.
//
// The four things only this file is positioned to see:
//
//   1. The stored NULL (never written) resolves to ON at submit time, so a
//      project nobody has touched keeps capturing.
//   2. An explicit `false` reaches the envelope as `false` and is PRESENT —
//      absent and false are opposite answers across this boundary.
//   3. The assertion is made on the SERIALIZED body, which is the only form
//      motir-ai ever sees. An intermediate object can carry a key that
//      `JSON.stringify` drops (an `undefined` value does exactly that), so a
//      test that stops at the argument object cannot see this contract fail.
//   4. The envelope stays a valid `v1` envelope — this adds a context field, it
//      does not version the envelope.

import { db } from '@/lib/db';
import {
  RECORD_PLANNING_MISTAKES_CONTEXT_FIELD,
  resolveRecordPlanningMistakesForJob,
} from '@/lib/ai/lessonCapture';
import { submitJob } from '@/lib/ai/motirAiClient';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The WIRE STRING, written out rather than imported from the code under test.
// motir-ai's contract fixture (MOTIR-3354) spells this same literal; a test that
// read the name out of the module would agree with itself about it and prove
// nothing about a contract whose whole hazard is that the two repositories
// disagree silently.
const WIRE_KEY = 'recordPlanningMistakes';

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedProject(): Promise<{
  userId: string;
  workspaceId: string;
  projectId: string;
  identifier: string;
}> {
  const user = await usersService.createUser({
    email: `lesson-capture-${randomToken(6)}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const identifier = `LC${randomToken(4)
    .toUpperCase()
    .replace(/[^A-Z]/g, 'X')}`;
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: identifier,
    identifier,
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    // The STORED identifier, not the one requested — `createProject` normalizes
    // it, and the settings service resolves a project by the stored key.
    identifier: project.identifier,
  };
}

describe('resolveRecordPlanningMistakesForJob — the setting, resolved at submit time', () => {
  it('a project that has never touched the setting resolves to ON', async () => {
    const seed = await seedProject();

    // The state a project that predates the column is in — asserted on the row,
    // so this is the real unset case and not a written `true`.
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: seed.projectId } });
    expect(row.aiRecordPlanningMistakes).toBeNull();

    await expect(
      resolveRecordPlanningMistakesForJob(seed.projectId, {
        userId: seed.userId,
        workspaceId: seed.workspaceId,
      }),
    ).resolves.toBe(true);
  });

  it('an explicit false resolves to false, and switching it back on resolves to true', async () => {
    const seed = await seedProject();
    const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };

    await projectAiSettingsService.updateAiSettings(
      seed.identifier,
      { aiRecordPlanningMistakes: false },
      ctx,
    );
    await expect(resolveRecordPlanningMistakesForJob(seed.projectId, ctx)).resolves.toBe(false);

    await projectAiSettingsService.updateAiSettings(
      seed.identifier,
      { aiRecordPlanningMistakes: true },
      ctx,
    );
    await expect(resolveRecordPlanningMistakesForJob(seed.projectId, ctx)).resolves.toBe(true);
  });

  it('a project that cannot be read resolves to ON rather than throwing', async () => {
    const seed = await seedProject();

    // A settings read that comes back empty must not fail a planning run that is
    // already under way. Capturing is the safe answer: it is the default the
    // whole feature ships with, and the alternative is a submit that 500s
    // because of a flag.
    await expect(
      resolveRecordPlanningMistakesForJob('pj_does_not_exist', {
        userId: seed.userId,
        workspaceId: seed.workspaceId,
      }),
    ).resolves.toBe(true);
  });
});

describe('the flag on the SERIALIZED envelope (the only form motir-ai sees)', () => {
  const tenant = {
    organizationId: 'org_1',
    isMeta: false,
    workspaceId: 'ws_1',
    projectId: 'pj_1',
    projectKey: 'MOTIR',
  };

  // The client fails fast on an unconfigured boundary; these cases are about the
  // BODY it sends, so give it a base URL and a service token the way
  // `tests/ai/motirAiClient.test.ts` does. `fetch` is stubbed, so nothing leaves
  // the process.
  beforeEach(() => {
    process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** Submit through the REAL client with `fetch` stubbed, and return the body
   *  motir-ai would have received — parsed back out of the request, not read off
   *  the argument object. */
  async function wireContext(value: boolean): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobId: 'job_1' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await submitJob(
        // ⚠️ A 15th FILE MOTIR-4304's GREP COULD NOT SEE (found by MOTIR-4308).
        // That card reconciled 14 test files naming a planning kind; its pattern
        // requires the literal on the same LINE as `submitJob` / `jobKind` /
        // `kind`, and this one sits on its own line. The kind is incidental to
        // what this helper asserts — that the context field crosses the wire —
        // so it takes the one planning kind like every other submit.
        'plan',
        tenant,
        { [RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]: value },
        { userId: 'user_1' },
      );
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        envelopeVersion: string;
        context: Record<string, unknown>;
      };
      expect(body.envelopeVersion).toBe('v1');
      return body.context;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('carries `false` on the wire when the project switched capture off', async () => {
    const context = await wireContext(false);

    expect(context[WIRE_KEY]).toBe(false);
    // Present as a KEY in the serialized JSON. This is the assertion an
    // argument-object check cannot make: `JSON.stringify` drops a key whose value
    // is `undefined`, so a producer that resolved the flag to `undefined` for
    // "off" would look correct at the call site and send nothing at all — which
    // the consumer reads as "old producer", i.e. keep capturing.
    expect(Object.prototype.hasOwnProperty.call(context, WIRE_KEY)).toBe(true);
  });

  it('carries `true` on the wire when capture is on', async () => {
    const context = await wireContext(true);
    expect(context[WIRE_KEY]).toBe(true);
  });

  it('the exported constant IS the wire string', () => {
    // The one place the name lives on this side of the boundary. motir-ai has its
    // own copy of this literal and no shared type binds them, so a rename that
    // passes here is a rename that must also be made there.
    expect(RECORD_PLANNING_MISTAKES_CONTEXT_FIELD).toBe(WIRE_KEY);
  });
});
