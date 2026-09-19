import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { runListProjects } from '@/lib/mcp/tools/listProjects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-5763 — a PROJECT-BOUND token (MOTIR-2607) enumerates only its project.
//
// Every per-key read refuses a bound token's other projects as not-found
// (`projectAccessService.resolveInputs`). `list_projects` filtered its TEXT block
// on the binding and serialised the UNFILTERED list into `structuredContent`, so
// the half an agent reads named projects it could not open. The root was the
// batch gate `filterBrowsable`, which never consulted the binding at all.

let fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;
let otherId: string;
let otherKey: string;

beforeEach(async () => {
  await truncateAuthTables();
  // The caller OWNS the workspace, so the browse gate alone keeps both projects:
  // only the binding can be what removes OTHER.
  fx = await makeWorkItemFixture({ identifier: 'BOUND' });
  const other = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    identifier: 'OTHER',
  });
  otherId = other.id;
  // The service de-dupes an identifier collision by suffixing, so keep the key
  // it ASSIGNED.
  otherKey = other.identifier;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function bound(): ServiceContext {
  return { ...fx.ctx, tokenProjectId: fx.projectId };
}

function listedKeys(result: { structuredContent?: unknown }): string[] {
  const payload = result.structuredContent as { projects: { key: string }[] };
  return payload.projects.map((p) => p.key);
}

function textKeys(result: { content: unknown }): string[] {
  const [block] = result.content as { type: 'text'; text: string }[];
  return block!.text.split('\n').map((line) => line.split(' — ')[0]!);
}

describe('list_projects with a project-bound token', () => {
  it('lists exactly the bound project in BOTH halves of the answer', async () => {
    const result = await runListProjects(bound());

    expect(result.isError).toBeFalsy();
    expect(listedKeys(result)).toEqual(['BOUND']);
    expect(textKeys(result)).toEqual(['BOUND']);
  });

  it('leaves an UNBOUND token listing every browsable project', async () => {
    const result = await runListProjects(fx.ctx);

    const both = ['BOUND', otherKey].sort();
    expect([...listedKeys(result)].sort()).toEqual(both);
    expect([...textKeys(result)].sort()).toEqual(both);
  });
});

describe('projectAccessService.filterBrowsable honours the binding', () => {
  async function allProjects() {
    return withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      projectRepository.findByWorkspace(fx.workspaceId, tx),
    );
  }

  it('keeps only the bound project', async () => {
    const kept = await projectAccessService.filterBrowsable(await allProjects(), bound());

    expect(kept.map((p) => p.id)).toEqual([fx.projectId]);
  });

  it('keeps nothing when the bound project is not among the rows', async () => {
    const onlyOther = (await allProjects()).filter((p) => p.id === otherId);

    expect(await projectAccessService.filterBrowsable(onlyOther, bound())).toEqual([]);
  });
});
