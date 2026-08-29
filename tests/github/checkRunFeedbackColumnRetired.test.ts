import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { adminDb } from '../helpers/adminDb';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';

// MOTIR-3863 — THE SCHEMA-ONLY PHASE of `github_check_run.feedback_comment_id`'s
// drop (`docs/decisions/delivery-reader-migration.md` §6a).
//
// ─── WHAT THIS FILE HOLDS, AND WHY A STATIC CHECK CANNOT ─────────────────────
//
// `tests/contract-phase-guard.test.ts` holds the CONTRACT phase's rule: a
// migration that drops a column declares the release in which the client stopped
// selecting it. This file holds the property that declaration ASSERTS — that the
// client has, in fact, stopped selecting it — and it holds it the only way it can
// be held, which is by reading the SQL the client emits.
//
// Reading `prisma/schema.prisma` cannot answer it. The question is not whether a
// field is written down; it is whether a query names a column, and the two came
// apart in exactly the direction that costs an outage: a bare relation include
// (`{ pullRequest: { include: { checkRuns: true } } }`, which is what
// `workItemDeliveryRepository` and `githubPullRequestRepository` use) selects
// every scalar the MODEL declares, so the emitted column list is a property of
// the datamodel and of no line of application code. MOTIR-3852 is what that costs
// when the declaration and the `DROP COLUMN` land in one release: `get_work_item`
// 500-ed tenant-wide for about six minutes while the previous image was still
// serving.
//
// So the assertions below are query-level. The first two read the SQL; the third
// and fourth read the DATABASE, because this phase's other half is that the
// column must still be there for the previous image to keep using; the last reads
// the schema for the ONE thing only the schema can say — that the field is still
// declared, and `@ignore`d rather than deleted.
//
// ⚠️ ALL OF THIS IS RETIRED BY THE CONTRACT PHASE (MOTIR-3803), which drops the
// column and the field in one commit. Delete this file with it; do not "fix" a
// failure here by deleting the field on its own, which breaks the drift gate
// (`prisma migrate diff … --exit-code` answers `[+] Added column
// feedback_comment_id`, exit 2 — measured on this schema).

const COLUMN = 'feedback_comment_id';

/** A client with query logging on. It is a SEPARATE `PrismaClient` because
 *  `lib/db.ts` and `helpers/adminDb.ts` are both constructed without the `log`
 *  option, and a client's logging is fixed at construction — there is no way to
 *  attach an emitter to an existing one. Same worker database, so it observes the
 *  same generated client the rest of the suite runs against. */
function loggingClient(): { client: PrismaClient; queries: string[] } {
  const queries: string[] = [];
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: currentWorkerAdminUrl() }),
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query' as never, ((e: { query: string }) => queries.push(e.query)) as never);
  return { client, queries };
}

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('the generated client no longer selects github_check_run.feedback_comment_id', () => {
  it('the bare relation include emits every OTHER scalar and not that one', async () => {
    // The read under test is the real one — `listByWorkItemWithChecks`, whose
    // `WITH_CHECKS` is the bare include this whole phase exists because of. The
    // work item id matches nothing, which is deliberate and sufficient: Prisma
    // still issues the nested check-run query (with `IN (NULL)`), and it is the
    // PROJECTION that is under test, not the rows. A fixture would add a
    // workspace, a repo, a pull request and a card to assert nothing extra.
    const { client, queries } = loggingClient();
    try {
      await workItemDeliveryRepository.listByWorkItemWithChecks('no-such-work-item', client);
    } finally {
      await client.$disconnect();
    }

    const checkRunReads = queries.filter((q) => q.includes('"github_check_run"'));
    expect(checkRunReads.length).toBeGreaterThan(0); // the query fired at all

    // The POSITIVE half first, so this cannot pass by the read silently
    // disappearing: the projection is real, and it still carries the columns the
    // verdict is derived from.
    for (const column of ['id', 'pull_request_id', 'commit_sha', 'check_name', 'conclusion']) {
      expect(checkRunReads.some((q) => q.includes(`"${column}"`))).toBe(true);
    }

    // …and the retired one is absent from every query this read emits.
    expect(checkRunReads.filter((q) => q.includes(COLUMN))).toEqual([]);
  });

  it('a direct read of the model does not name it either — the field is gone from the client, not from one include', async () => {
    const { client, queries } = loggingClient();
    try {
      await client.githubCheckRun.findMany({ where: { pullRequestId: 'no-such-pr' } });
    } finally {
      await client.$disconnect();
    }
    expect(queries.some((q) => q.includes('"github_check_run"'))).toBe(true);
    expect(queries.filter((q) => q.includes(COLUMN))).toEqual([]);
  });
});

describe('the COLUMN is still in the database — this phase removes a reader, not a column', () => {
  it('github_check_run.feedback_comment_id exists and is still nullable', async () => {
    // Raw SQL, necessarily: the field is `@ignore`d, so the generated client has
    // no way to name it. That is the point of the phase and it is why this
    // assertion cannot be written through Prisma's model API.
    const rows = await adminDb.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'github_check_run'
        AND column_name = ${COLUMN}
    `;
    expect(rows).toMatchObject([{ column_name: COLUMN, is_nullable: 'YES' }]);
  });

  it('its foreign key to comment is still there, so a deleted comment still nulls it', async () => {
    const rows = await adminDb.$queryRaw<{ constraint_name: string }[]>`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'github_check_run'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = ${COLUMN}
    `;
    expect(rows).toHaveLength(1);
  });
});

describe('the datamodel still DECLARES the field, and declares it @ignore', () => {
  it('the field line carries @ignore — deleting it is the drift the gate refuses', () => {
    // The schema is the one place this fact lives, and both directions of it are
    // load-bearing:
    //   • no `@ignore`  ⇒ the bare include selects the column again, and the
    //     CONTRACT release re-opens MOTIR-3852;
    //   • no field      ⇒ `prisma migrate diff --from-schema … --exit-code`
    //     reports `[+] Added column feedback_comment_id` and exits 2, so CI's
    //     schema-drift gate (MOTIR-1960) goes red.
    // The only edit that satisfies both is deleting the field AND dropping the
    // column in one commit, which is MOTIR-3803's.
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    const field = schema.split('\n').find((line) => line.trim().startsWith('feedbackCommentId '));
    expect(field, 'the field is gone from schema.prisma — see the comment above').toBeDefined();
    expect(field).toContain(`@map("${COLUMN}")`);
    expect(field).toContain('@ignore');

    // The relation that hangs on it is ignored too, or the column stays reachable
    // through `include: { feedbackComment: true }`.
    const relation = schema.split('\n').find((line) => line.trim().startsWith('feedbackComment '));
    expect(relation).toBeDefined();
    expect(relation).toContain('@ignore');
  });
});

describe('no application code reads or writes the field', () => {
  it('the CI-feedback service and the check-run repository name it only in prose', () => {
    // AC 1 as an assertion rather than a grep quoted in a pull-request body: the
    // two files that held the last readers may mention the column in a comment —
    // they explain why it is retired — but neither may reference the FIELD.
    const offenders: string[] = [];
    for (const path of [
      'lib/services/changeRequestCiFeedback.ts',
      'lib/repositories/githubCheckRunRepository.ts',
      'lib/repositories/githubCiFeedbackCommentRepository.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      for (const [i, line] of source.split('\n').entries()) {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
        if (code.includes('feedbackCommentId')) offenders.push(`${path}:${i + 1}: ${code}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
