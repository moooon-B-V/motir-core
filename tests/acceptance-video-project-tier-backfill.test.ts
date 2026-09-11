import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-4925 · MOTIR-5167 — the acceptance-video switch moves to the PROJECT, and
// the BACKFILL is what makes the move safe.
//
// `Project.acceptanceVideoEnabled` defaults to `true`. On its own that default
// would switch acceptance video ON for every project under an organisation that
// had deliberately turned it OFF — a setting flipping itself, which is worse than
// the wrong tier it replaces, because the wrong tier at least does what the person
// who set it asked. So the migration copies each project's owning organisation's
// CURRENT value forward, in the same migration, before anything reads the column.
//
// ⚠️ THIS FILE ASSERTS THE MIGRATION'S OWN SQL, READ FROM THE MIGRATION.
// A test that retyped the UPDATE would pass for ever while the shipped statement
// drifted away from it — and the statement is the deliverable. So the backfill is
// extracted from the migration file and executed verbatim: if somebody edits the
// migration, this file is measuring the edit.
//
// Real Postgres; truncate between tests (CLAUDE.md: never mock the DB). The fixture
// builds TWO tenants that disagree, which is the only shape that can tell a
// per-project backfill from a blanket write — with one organisation both answers
// look identical.
//
// `adminDb` throughout, deliberately: cross-tenant fixture writes are exactly what
// the RLS policies exist to refuse, and a raw statement on the owner client is the
// shipped rule (`tests/helpers/adminDb.ts`) rather than an exception to it — which
// is also why this file does not move `tests/rls/test-singleton-statement-guard`'s
// `RAW_CEILING`, a ratchet that only ever falls.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20260911170000_project_acceptance_video_gate_switch/migration.sql',
);

/** The migration's statements, comments stripped, in file order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The ONE backfill statement the deploy runs — extracted, never retyped. */
function backfillStatement(): string {
  const updates = migrationStatements().filter((s) => /^UPDATE\b/i.test(s));
  expect(
    updates,
    'the migration must carry EXACTLY ONE backfill UPDATE — this file executes it, ' +
      'so zero means the copy-forward was dropped and two means it no longer knows which ' +
      'statement it is asserting',
  ).toHaveLength(1);
  return updates[0]!;
}

let seq = 0;

/** An organisation + workspace + project, with the organisation's answer set. */
async function seedTenant(tag: string, orgAnswer: boolean) {
  const n = seq++;
  const org = await adminDb.organization.create({
    data: {
      name: `Org ${tag}`,
      slug: `avp-org-${tag}-${n}`,
      acceptanceVideoEnabled: orgAnswer,
    },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS ${tag}`, slug: `avp-ws-${tag}-${n}`, organizationId: org.id },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Project ${tag}`,
      slug: `avp-p-${tag}-${n}`,
      identifier: `AVP${tag}${n}`,
      workspaceId: workspace.id,
    },
  });
  return { org, workspace, project };
}

/** The project's stored answer, read past RLS. */
async function projectAnswer(projectId: string): Promise<boolean> {
  const row = await adminDb.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { acceptanceVideoEnabled: true },
  });
  return row.acceptanceVideoEnabled;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the project-tier acceptance-video switch inherits its organisation answer', () => {
  it('copies each organisation answer forward — OFF becomes off, ON stays on', async () => {
    // Both projects start at the column DEFAULT, which IS the pre-backfill state:
    // the migration has added the column and has not yet copied anything forward.
    const off = await seedTenant('off', false);
    const on = await seedTenant('on', true);

    expect(await projectAnswer(off.project.id)).toBe(true);
    expect(await projectAnswer(on.project.id)).toBe(true);

    await adminDb.$executeRawUnsafe(backfillStatement());

    // The PAIR is the assertion. A blanket write would satisfy either line alone.
    expect(
      await projectAnswer(off.project.id),
      'a project whose organisation had acceptance video OFF must not come back ON',
    ).toBe(false);
    expect(
      await projectAnswer(on.project.id),
      'a project whose organisation had it ON must not be turned off by the backfill',
    ).toBe(true);
  });

  it('is per-project: two projects under ONE organisation both take its answer', async () => {
    // The sibling property. The backfill resolves through the workspace, so a
    // second project under the same organisation must land on the same value —
    // this is what proves the join is not matching one arbitrary row.
    const { org, workspace } = await seedTenant('multi', false);
    const second = await adminDb.project.create({
      data: {
        name: 'Project multi B',
        slug: `avp-p-multi-b-${seq++}`,
        identifier: 'AVPMB',
        workspaceId: workspace.id,
      },
    });

    await adminDb.$executeRawUnsafe(backfillStatement());

    const projects = await adminDb.project.findMany({
      where: { workspace: { organizationId: org.id } },
      select: { acceptanceVideoEnabled: true },
    });
    expect(projects).toHaveLength(2);
    expect(projects.every((p) => p.acceptanceVideoEnabled === false)).toBe(true);
    expect(await projectAnswer(second.id)).toBe(false);
  });

  it('the backfill lives IN the migration, so a deploy cannot apply the column without it', () => {
    const statements = migrationStatements();

    // The column and its copy-forward are ONE migration on purpose: a separate
    // script is a second thing to remember, and a deploy that runs the migration
    // without it is exactly the silent flip this file exists to refuse.
    expect(
      statements.some((s) => /^ALTER TABLE "project" ADD COLUMN/i.test(s)),
      'the migration must be the one that adds the column',
    ).toBe(true);

    const backfill = backfillStatement();
    // It has to resolve the organisation THROUGH the workspace — there is no
    // organisation FK on `project`, so a backfill that does not join both tables
    // is reading something other than the owning organisation's answer.
    expect(backfill).toMatch(/"workspace"/);
    expect(backfill).toMatch(/"organization"/);
    expect(backfill).toMatch(/"acceptance_video_enabled"/);
  });
});
