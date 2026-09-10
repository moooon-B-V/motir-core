import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { resolveProjectCodeContext } from '@/lib/ai/codeContext';
import { enqueueReposMissingFirstIndex } from '@/lib/github/indexEnqueue';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveEffectiveRepoDomain } from '@/lib/projectRepos/effectiveDomain';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch, dispatchedEvents } from '../helpers/jobs';
import { organizationIdOf } from '../helpers/organizationOf';

// ─────────────────────────────────────────────────────────────────────────────
// The Story-level ARCHITECTURE / CONTRACT guards for the repository set (Story
// MOTIR-1775 · MOTIR-1784) — the things a coverage percentage cannot see.
//
// Every assertion here fails on a change that leaves the whole suite otherwise
// green, which is the only reason to write it:
//
//   1. `project_repository` is tenant data, so `workspace_id` and its RLS
//      policies must ship in the SAME migration — asserted against the migration
//      SQL, not against prose. A later migration adding the policy would leave a
//      window in which the table is deployed unguarded, and no runtime test can
//      see that window because by then the policy exists.
//   2. The webhook → reconcile → index chain got NO new code. The repo-creation
//      path reaches the index through the shipped chokepoint with the shipped
//      payload, proved by driving BOTH producers and comparing what they emit.
//   3. AI grounding is pinned — and the two halves now answer DIFFERENTLY.
//      `resolveProjectCodeContext` is PROJECT-scoped as of MOTIR-4653 (the adoption
//      this guard was written to defer, arriving on its own card with its own
//      decision — `code-graph-index-fan-out.md`, MOTIR-2029); its assertions are
//      INVERTED rather than deleted, so the change is met head-on by the next
//      reader. `codeGraphIndexService` is still WORKSPACE-keyed and its
//      assertion is untouched, because MOTIR-4652 — the card that retires that
//      fan-out — has not shipped. Pinning both is what stops a well-meant "while
//      I'm here, these should match" edit from silently moving what a planning
//      job sees or what the index job dispatches. (MOTIR-1974 re-pointed the
//      index assertion at `resolveIndexTarget`, the method that now owns the
//      fan-out after the job was split into per-project steps — the SCOPE it
//      guards is unchanged, which is the point of re-pointing it rather than
//      dropping it.)
//   4. The row's two FKs behave as modelled: a deleted project takes its rows
//      with it, while a deleted `GithubRepo` leaves a READABLE row with no claim
//      rather than a dangling reference or a vanished plan.
//   5. The SHIPPED COPY agrees with the isolation boundary (MOTIR-4997). This one
//      is an IMPLICATION rather than a vocabulary rule, and that is the whole
//      point of it: the antecedent is measured behaviour (a set-less project
//      reaches nothing) and the consequent is the catalogs (no `github.*` string
//      promises it reaches anything). A blocklist over the phrase would have been
//      red from the day the phrase was written, because the phrase was TRUE then.
//      This guard's verdict CHANGES when the rung retires, which is the only
//      shape that could have caught MOTIR-4997.
//
// The assembled behavioural seams live in
// `tests/integration/projectRepos/repositorySetStoryGate.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

/** Every migration's SQL, newest-name-last (the directory names sort by stamp). */
function migrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }));
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── 1 · the table and its RLS ship together ─────────────────────────────────

describe('project_repository — workspace_id and RLS in ONE migration', () => {
  it('creates the table, its workspace_id and its policies in the SAME file — no unguarded window', () => {
    const creating = migrations().filter((m) => /CREATE TABLE\s+"project_repository"/i.test(m.sql));
    expect(creating).toHaveLength(1);
    const { sql } = creating[0]!;

    // The tenant column is NOT NULL — a nullable one would make "whose row is
    // this?" unanswerable for exactly the rows RLS has to judge.
    expect(sql).toMatch(/"workspace_id"\s+TEXT\s+NOT NULL/i);

    // RLS is ENABLED and FORCED (forced, so the table owner is not exempt) and
    // the policy gates on the row's OWN workspace_id against the request GUC.
    expect(sql).toMatch(/ALTER TABLE\s+"project_repository"\s+ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/ALTER TABLE\s+"project_repository"\s+FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY[\s\S]*ON\s+"project_repository"/i);
    expect(sql).toMatch(/USING\s*\(\s*"workspace_id"\s*=\s*current_setting\('app\.workspace_id'/i);
    // WITH CHECK too — without it a tenant could MOVE its own row to another
    // workspace, which reads as a write it is allowed to make.
    expect(sql).toMatch(
      /WITH CHECK\s*\(\s*"workspace_id"\s*=\s*current_setting\('app\.workspace_id'/i,
    );
  });

  it('adds no LATER migration that first enables RLS on the table', () => {
    // The failure this catches is the one the rule exists for: a follow-up
    // migration "fixing up" the policy means the table shipped unguarded.
    const enabling = migrations().filter((m) =>
      /ALTER TABLE\s+"project_repository"\s+ENABLE ROW LEVEL SECURITY/i.test(m.sql),
    );
    expect(enabling.map((m) => m.name)).toHaveLength(1);
  });
});

// ── 2 · the webhook → reconcile → index chain is untouched ──────────────────

describe('the index chain got no new code', () => {
  it('the repo-set creation path emits the SAME job payload as the shipped reconcile path', async () => {
    // Both producers are driven for real and their payloads compared key-for-key.
    // A repo-set-specific field bolted onto the job — or a key renamed on one
    // side — fails here, which no per-subtask suite can see because each knows
    // only its own producer.
    const send = spyOnJobDispatch();

    await enqueueReposMissingFirstIndex({
      installationId: '556677',
      workspaceId: 'ws-1',
      repos: [
        {
          providerRepoId: 'r1',
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        } as never,
      ],
      indexedRepoRefs: [],
    });

    expect(send).toHaveBeenCalledTimes(1);
    const shipped = dispatchedEvents(send)[0]! as { name: string; data: Record<string, unknown> };
    expect(shipped.name).toBe('system.code-graph-index');
    // The exact contract the establish run must also satisfy — asserted in the
    // story-gate suite, which drives a real establish and reads these same keys.
    expect(Object.keys(shipped.data).sort()).toEqual([
      'defaultBranch',
      'installationId',
      'repoName',
      'repoOwner',
      'workspaceId',
    ]);
  });

  it('the enqueue chokepoint knows nothing about the repository set', () => {
    // Structural, and deliberately narrow: the chokepoint is shared by the
    // webhook reconcile, the fresh-install bind AND the creation primitive, so
    // a repo-set import here would be the first branch in a path that must stay
    // one path for all three.
    const source = readFileSync(join(process.cwd(), 'lib', 'github', 'indexEnqueue.ts'), 'utf8');
    expect(source).not.toMatch(/projectRepo/i);
    expect(source).not.toMatch(/project_repository/i);
  });
});

// ── 3 · AI grounding: the envelope is project-scoped, the index job is not ──

describe('resolveProjectCodeContext is project-scoped and codeGraphIndexService is unchanged', () => {
  /** Connect a repo to the workspace's OWN installation — the 7.10.3 mirror the
   *  code-context resolver reads. */
  async function connectRepo(workspaceId: string, name: string): Promise<string> {
    const installationId = `inst-${workspaceId}`;
    const inst = await adminDb.githubInstallation.upsert({
      where: { installationId },
      create: {
        installationId,
        workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
      update: {},
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId,
        organizationId: await organizationIdOf(workspaceId),
        repoId: `${name}-id`,
        owner: 'moooon',
        name,
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    return repo.id;
  }

  it('answers with the PROJECT’s configured set, not the workspace’s wider grant', async () => {
    // ⚠️ INVERTED BY MOTIR-4653, DELIBERATELY — this assertion used to read
    // "still answers with the WORKSPACE's repos, not the project's narrower set".
    // It was written to stop a well-meant drive-by re-pointing while MOTIR-1754
    // owned the adoption; MOTIR-4653 IS that adoption, arriving on its own card
    // with its own decision (`code-graph-index-fan-out.md`, MOTIR-2029). The
    // guard is kept and turned around rather than deleted, so the next reader
    // meets the change rather than an absence.
    //
    // The set exists and names ONE repo; the workspace connects TWO. A planning
    // job must now see only the one this project works on.
    const fx = await makeWorkItemFixture();
    const webId = await connectRepo(fx.workspaceId, 'acme-web');
    await connectRepo(fx.workspaceId, 'acme-api');
    // ⚠️ ESTABLISHED, through `linkProjectRepo` — `addRow` writes a PROPOSED row
    // and `resolveProjectCodeContext` filters proposals out.
    await linkProjectRepo({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: webId,
      name: 'acme-web',
      role: 'web',
    });

    const context = await resolveProjectCodeContext({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(context!.repos.map((r) => r.repoRef)).toEqual(['moooon/acme-web']);
  });

  it('is unaffected by a SIBLING project’s set — each project sees only its own', async () => {
    // Also inverted (MOTIR-4653). The property it guards is the one that
    // matters either way: one project's configuration must never decide another's
    // grounding. Before, that held because the resolver read NO set; now it holds
    // because it reads exactly THIS project's.
    const fx = await makeWorkItemFixture();
    const webId = await connectRepo(fx.workspaceId, 'acme-web');
    const siblingApiId = await connectRepo(fx.workspaceId, 'sibling-api');
    await linkProjectRepo({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: webId,
      name: 'acme-web',
      role: 'web',
    });

    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Sibling',
      identifier: 'SIB',
    });
    const siblingFx: WorkItemFixture = { ...fx, project: sibling, projectId: sibling.id };
    await linkProjectRepo({
      workspaceId: siblingFx.workspaceId,
      projectId: siblingFx.projectId,
      githubRepoId: siblingApiId,
      name: 'sibling-api',
      role: 'api',
    });

    const context = await resolveProjectCodeContext({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    expect(context!.repos.map((r) => r.repoRef)).toEqual(['moooon/acme-web']);
  });

  it('resolves to undefined for a project whose set is EMPTY, however much the workspace connected', async () => {
    // ⚠️ THE OTHER HALF OF THE INVERSION, and the one that is NOT symmetrical.
    // This used to prove a repo SET is not a code context (an unrealized row must
    // not become grounding). It now proves the mirror image, which is the shipped
    // contract the resolver has always carried: an EMPTY answer is `undefined`,
    // never an empty `repos` array, so the caller omits `context.code` entirely
    // and a start-fresh project's envelope stays byte-identical to a code-less
    // one — even in a workspace with two repositories connected.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'acme-web');
    await connectRepo(fx.workspaceId, 'acme-api');

    await expect(
      resolveProjectCodeContext({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).resolves.toBeUndefined();
  });

  it('an UNREALIZED row contributes nothing — an intent is not a repository', async () => {
    // The row exists and names a repository that was never realized
    // (`githubRepoId` null), so there is no host, no default branch and no graph.
    // Returning it would put a repository on the wire that does not exist.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'acme-web');
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);

    await expect(
      resolveProjectCodeContext({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).resolves.toBeUndefined();
  });

  it('the index job is keyed by WORKSPACE — its input carries no project', async () => {
    const { codeGraphIndexService } = await import('@/lib/services/codeGraphIndexService');
    // MOTIR-1974 split the job's single method into `resolveIndexTarget` (reads)
    // + a per-project network half, so each could be its own durable step; the
    // network half is now the fleet dispatch (MOTIR-2027 / MOTIR-2057) and no
    // longer lives in this service. `resolveIndexTarget` is where the guarded
    // property sits either way: it takes the SAME workspace-keyed input (no
    // project) and it is what decides the fan-out. Neither move narrowed it — the
    // projectIds it returns are still every project of the workspace, and it still
    // never reads `project_repository`. (The dispatch does take a projectId, but
    // only one this resolver handed out.)
    //
    // Driving it with an installation that does not exist is the cheapest way to
    // prove the shape it accepts without a tarball fetch: the no-op it returns is
    // itself part of the contract (the job never throws on a vanished tenant).
    await expect(
      codeGraphIndexService.resolveIndexTarget({
        installationId: 'nope',
        workspaceId: 'nope',
        repoOwner: 'moooon',
        repoName: 'motir-core',
        defaultBranch: 'main',
      }),
    ).resolves.toEqual({ indexed: false, reason: 'installation_missing' });
  });
});

// ── 4 · the row's two foreign keys ──────────────────────────────────────────

describe('what a delete does to a repository row', () => {
  async function realizedRow(fx: WorkItemFixture): Promise<{ rowId: string; repoId: string }> {
    const inst = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: 'acme-web-id',
        owner: 'moooon',
        name: 'acme-web',
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    // Through `creating`, so the row settles as `created` — a repository Motir
    // MADE, which is the case where losing the mirror row matters most.
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    return { rowId: row.id, repoId: repo.id };
  }

  it('a deleted GithubRepo leaves a READABLE row with no claim — not a dangling FK', async () => {
    // SetNull, not Cascade: disconnecting a repository is not losing the plan.
    // The role, name and seed source survive so the row can be re-established,
    // and `established` goes false while `state` keeps saying what happened.
    const fx = await makeWorkItemFixture();
    const { rowId, repoId } = await realizedRow(fx);

    await adminDb.githubRepo.delete({ where: { id: repoId } });

    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    const row = rows.find((r) => r.id === rowId)!;
    expect(row).toMatchObject({
      name: 'acme-web',
      role: 'web',
      state: 'created',
      established: false,
      realizedRepo: null,
    });
    // …and the claim is released, so the row can realize against a new repo.
    const raw = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
    expect(raw.githubRepoId).toBeNull();
  });

  it('a deleted PROJECT takes its rows with it, leaving the repository alone', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, repoId } = await realizedRow(fx);

    await adminDb.project.delete({ where: { id: fx.projectId } });

    const projectRepoRow = await adminDb.projectRepo.findUnique({ where: { id: rowId } });
    expect(projectRepoRow).toBeNull();
    // The repository is a real artifact on GitHub — deleting a Motir project
    // must not pretend it went away.
    const githubRepoRow = await adminDb.githubRepo.findUnique({ where: { id: repoId } });
    expect(githubRepoRow).not.toBeNull();
  });
});

// ── 5 · The shipped COPY agrees with the isolation boundary (MOTIR-4997) ─────

describe('a set-less project reaches NOTHING, and the catalogs say so', () => {
  /** The claim the retired workspace rung used to license, in both shipped
   *  locales. Never an identifier — these are sentences a user reads. */
  const REACH_CLAIMS: { label: string; re: RegExp }[] = [
    // "can also reach", "could also reach", "can still reach" — any case.
    { label: 'en: also/still reach', re: /can (also|still) reach|could also reach/i },
    // "…的项目…仍可访问…" — a project that lacks its own repositories reaching one anyway.
    { label: 'zh: 仍可访问', re: /仍可访问/ },
  ];

  /** Connect a repository to the ORGANISATION, linking it to no project. This is
   *  the state the retired rung used to make reachable: the organisation HAS a
   *  repository, and the project has no rows of its own. */
  async function connectOrgRepo(workspaceId: string, name: string): Promise<void> {
    const installationId = `inst-${workspaceId}`;
    const inst = await adminDb.githubInstallation.upsert({
      where: { installationId },
      create: {
        installationId,
        workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
      update: {},
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId,
        organizationId: await organizationIdOf(workspaceId),
        repoId: `${name}-id`,
        owner: 'moooon',
        name,
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
  }

  /** Every string under `github.*` in one catalog, flattened to `key → value`. */
  function githubStrings(locale: string): { key: string; value: string }[] {
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
    ) as Record<string, unknown>;
    const out: { key: string; value: string }[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        out.push({ key: path, value: node });
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(catalog.github, 'github');
    return out;
  }

  it('⚠️ the DOMAIN grants no inheritance — so no `github.*` string may promise it', async () => {
    // ── THE ANTECEDENT, measured rather than asserted from the type ──────────
    // MOTIR-4955 made the project link the repository isolation boundary. A
    // project with NO rows of its own therefore reaches nothing: not for
    // dispatch, not for pinning, not for the room.
    const fx = await makeWorkItemFixture();
    // The organisation connects a repository. Nobody links it to this project.
    await connectOrgRepo(fx.workspaceId, 'acme-web');

    const domain = await resolveEffectiveRepoDomain(fx.projectId, fx.ctx);

    expect(domain.hasSet).toBe(false);
    expect(domain.layersConnected).toBe(false);
    expect(domain.connected).toEqual([]);
    expect(domain.dispatchable).toEqual([]);
    expect(domain.pinnable).toEqual([]);

    // ── THE CONSEQUENT — the catalogs, in both locales ───────────────────────
    // ⚠️ THIS IS THE HALF THAT WOULD HAVE GONE RED ON 2026-09-10. Before
    // MOTIR-4955 the assertions above were FALSE — the workspace rung really did
    // let a set-less project reach the organisation's repositories — so this
    // block never ran and the copy describing that rung was correct. The moment
    // the rung retired, the antecedent became true and these two sentences
    // became the only thing standing between a person and a false blast radius
    // on a destructive act:
    //
    //     github.inventory.foot            "…can also reach the ones connected in its workspace…"
    //     github.orgDisconnect.alsoReachable "Any project with no repositories of its own can also reach this one…"
    //
    // Nothing was watching them. `tests/settings/organizationGitPage.test.tsx`
    // asserted both by substring, which pins a sentence as PRESENT and says
    // nothing about whether it is TRUE — so the mechanism could retire under
    // them without a single check going red.
    const offenders: string[] = [];
    for (const locale of ['en', 'zh']) {
      for (const { key, value } of githubStrings(locale)) {
        for (const { label, re } of REACH_CLAIMS) {
          if (re.test(value)) offenders.push(`${locale}:${key} matched ${label} — ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('⚠️ the guard can FAIL — the patterns match the sentences this card removed', () => {
    // A copy guard that matches nothing is indistinguishable from a broken
    // regex, and it degrades silently as the catalogs are reworded. Pin the
    // patterns against the exact strings MOTIR-4997 retired, so the guard is
    // known to be load-bearing rather than merely green.
    const retired = [
      'Any project here that has no repositories of its own can also reach the ones connected in its workspace, whether or not it is named above.',
      'Any project with no repositories of its own can also reach this one, whether or not it is named here.',
      '尚未拥有自有仓库的项目，无论此处是否列出，都仍可访问该仓库。',
    ];
    for (const sentence of retired) {
      expect(REACH_CLAIMS.some(({ re }) => re.test(sentence))).toBe(true);
    }
  });
});
