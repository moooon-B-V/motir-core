import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from '@/lib/db';
import type { RawCodeAuditSurface } from '@/lib/ai/motirAiClient';

// The STORY gate for MOTIR-2244 (MOTIR-2252).
//
// Every card under this story ships its own units, and each of those suites
// mocks the card on the other side of the seam — which is exactly how a story
// ships four green cards and one broken feature. This drives one card's REAL
// output through the next card's REAL consumer, and adds the guards no coverage
// percentage can see.

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// The single sanctioned boundary mock: motir-ai's HTTP client. Everything below
// it — the services, the repositories, the DB — is real.
const getCodeAuditMock = vi.fn<(q: unknown) => Promise<RawCodeAuditSurface>>();
const refreshCodeAuditMock =
  vi.fn<
    (t: unknown, c: unknown, a: unknown) => Promise<{ auditJobId: string; conventionJobId: string }>
  >();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeAudit: (q: unknown) => getCodeAuditMock(q),
  getConvention: () => Promise.resolve({ convention: null, versions: [], nextCursor: null }),
  refreshCodeAudit: (t: unknown, c: unknown, a: unknown) => refreshCodeAuditMock(t, c, a),
}));

const { aiConventionService } = await import('@/lib/services/aiConventionService');
const { auditCoverageService } = await import('@/lib/services/auditCoverageService');
const { mergeReauditRun } = await import('@/lib/codeHealth/reauditRun');
const { buildRepoAuditRows } = await import('@/lib/codeHealth/repoAuditRows');
const { createTestWorkspace, createTestProject, createTestUser } = await import('../fixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { NotProjectAdminError } = await import('@/lib/projects/errors');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { truncateAuthTables } = await import('../helpers/db');

const REPOS = [
  {
    providerRepoId: '901',
    owner: 'moooon',
    name: 'motir-ai',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '902',
    owner: 'moooon',
    name: 'motir-core',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '903',
    owner: 'moooon',
    name: 'motir-meta',
    defaultBranch: 'main',
    archived: false,
  },
];

function audited(repoKey: string): RawCodeAuditSurface {
  return {
    audit: {
      id: `audit_${repoKey}`,
      aiProjectId: 'ai_1',
      healthSummary: { grade: 'B', conformancePct: 78 },
      codeGraphRef: null,
      repoKey,
      jobId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [],
    total: 4,
    nextOffset: null,
  };
}
const neverAudited = (): RawCodeAuditSurface => ({
  audit: null,
  findings: [],
  total: 0,
  nextOffset: null,
});

async function project(installationId: string) {
  const { workspace, owner } = await createTestWorkspace();
  const proj = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: REPOS,
  });
  return { workspace, owner, project: proj, ctx: { userId: owner.id, workspaceId: workspace.id } };
}

beforeEach(async () => {
  await truncateAuthTables();
  getCodeAuditMock.mockReset();
  refreshCodeAuditMock.mockReset();
  refreshCodeAuditMock.mockImplementation(() =>
    Promise.resolve({ auditJobId: 'job', conventionJobId: 'conv' }),
  );
});

afterAll(async () => {
  await db.$disconnect();
});

// ── SEAM 1 · the scoped trigger's targets → the submitted job envelopes ──────
describe('seam · a repo scope reaches the job envelopes', () => {
  it('submits one code_audit + one propose_convention per NAMED repo and none for the rest', async () => {
    const { project: p, ctx } = await project('inst-seam-1');

    await aiConventionService.reaudit(p.id, ctx, p.identifier, {
      repoKeys: ['moooon/motir-meta'],
    });

    // Read off the SUBMIT calls, not the return value: the envelope is the thing
    // that decides what gets derived and paid for.
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
    const [, context] = refreshCodeAuditMock.mock.calls[0]!;
    expect((context as { code: { repoRef: string } }).code.repoRef).toBe('moooon/motir-meta');

    const refs = refreshCodeAuditMock.mock.calls.map(
      (c) => (c[1] as { code: { repoRef?: string } }).code.repoRef,
    );
    expect(refs).not.toContain('moooon/motir-core');
    expect(refs).not.toContain('moooon/motir-ai');
  });
});

// ── SEAM 2 · the coverage read's real output → the count the banner prints ───
describe('seam · the coverage read produces the count the banner renders', () => {
  it('counts never-audited repos and EXCLUDES the unreadable one', async () => {
    const { project: p, ctx } = await project('inst-seam-2');
    getCodeAuditMock.mockImplementation((q) => {
      const { repoKey } = q as { repoKey: string };
      if (repoKey === 'moooon/motir-ai') return Promise.resolve(audited(repoKey));
      if (repoKey === 'moooon/motir-core')
        return Promise.reject(new MotirAiUnavailableError('down'));
      return Promise.resolve(neverAudited());
    });

    const coverage = await auditCoverageService.getCoverage(p.id, ctx);

    // One audited, one unreadable, one genuinely un-audited.
    expect(coverage.repos).toEqual([
      { repoKey: 'moooon/motir-ai', state: 'audited' },
      { repoKey: 'moooon/motir-core', state: 'unavailable' },
      { repoKey: 'moooon/motir-meta', state: 'not_audited' },
    ]);
    // The number the banner prints. If the unreadable repo were counted, the
    // banner would say "2" and send an admin to a page where one looks fine.
    expect(coverage.notAuditedCount).toBe(1);
  });
});

// ── SEAM 3 · the trigger's DTO → the in-flight record → a later mount ────────
describe('seam · a scoped run round-trips the in-flight record as ITSELF', () => {
  it('a scoped run merges into a broader record instead of narrowing it', async () => {
    const { project: p, ctx } = await project('inst-seam-3');
    let n = 0;
    refreshCodeAuditMock.mockImplementation(() => {
      n += 1;
      return Promise.resolve({ auditJobId: `job_${n}`, conventionJobId: `conv_${n}` });
    });

    // A whole-set run first — its REAL DTO becomes the stored record.
    const wholeSet = await aiConventionService.reaudit(p.id, ctx, p.identifier);
    expect(wholeSet.repos).toHaveLength(3);

    // …then a scoped one. Its REAL DTO merges in.
    const scoped = await aiConventionService.reaudit(p.id, ctx, p.identifier, {
      repoKeys: ['moooon/motir-meta'],
    });
    const merged = mergeReauditRun(wholeSet, scoped.repos);

    // Every repo the broader run queued is still watched…
    expect(merged.repos.map((r) => r.repoKey).sort()).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
      'moooon/motir-meta',
    ]);
    // …and the re-fired repo carries the NEWER job id.
    const meta = merged.repos.find((r) => r.repoKey === 'moooon/motir-meta')!;
    expect(meta.auditJobId).toBe(scoped.repos[0]!.auditJobId);
    expect(meta.auditJobId).not.toBe(
      wholeSet.repos.find((r) => r.repoKey === 'moooon/motir-meta')!.auditJobId,
    );
  });

  it('the coverage read and the page rows agree on what "no report" means', async () => {
    // The read's vocabulary is BOUND to the page's row states by construction
    // (`Extract<RepoAuditRowState, …>`); this pins that they agree in fact too.
    const rows = buildRepoAuditRows([
      {
        repoKey: 'a',
        surface: { audit: null, findings: [], total: 0, nextOffset: null, scanner: null },
      },
      { repoKey: 'b', surface: null },
    ]);
    expect(rows.map((r) => r.state)).toEqual(['not_audited', 'unavailable']);
  });
});

// ── GUARD 1 · no boundary drift ──────────────────────────────────────────────
describe('guard · the story crosses no boundary', () => {
  it('touches no file under motir-ai/ and adds no field to the 7.1 envelope', () => {
    // The diff this story contributes, measured against the branch point.
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const changed = execFileSync('git', ['diff', '--name-only', `${base}..HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

    expect(changed.filter((f) => f.startsWith('motir-ai/'))).toEqual([]);

    // The scoped trigger rides the EXISTING envelope: `repoRef` on `context.code`,
    // which motir-ai already treats as authoritative. If the service ever starts
    // sending a new key, this is where it shows up.
    const service = read('lib/services/aiConventionService.ts');
    const envelope = service.slice(service.indexOf('async reaudit('));
    expect(envelope).toMatch(/repoRef/);
    expect(envelope).not.toMatch(/repoKeys\s*:/); // never sent over the wire
  });
});

// ── GUARD 2 · the capability gate is on the SERVER ───────────────────────────
describe('guard · the admin gate exists on the server, not only in the component', () => {
  it('refuses a workspace member who is not a project admin, before any boundary read', async () => {
    const { workspace, project: p } = await project('inst-guard-2');
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    await expect(
      auditCoverageService.getCoverage(p.id, { userId: member.id, workspaceId: workspace.id }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    expect(getCodeAuditMock).not.toHaveBeenCalled();

    // …and the same for the derivation the banner points at.
    await expect(
      aiConventionService.reaudit(
        p.id,
        { userId: member.id, workspaceId: workspace.id },
        p.identifier,
      ),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });
});

// ── GUARD 3 · the UN-SCOPED path is unchanged ────────────────────────────────
describe('guard · a refresh with no scope still fans out over everything', () => {
  it('submits one pair per connected repo, exactly as before the scope existed', async () => {
    const { project: p, ctx } = await project('inst-guard-3');

    await aiConventionService.reaudit(p.id, ctx, p.identifier);

    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(3);
    expect(
      refreshCodeAuditMock.mock.calls.map(
        (c) => (c[1] as { code: { repoRef: string } }).code.repoRef,
      ),
    ).toEqual(['moooon/motir-ai', 'moooon/motir-core', 'moooon/motir-meta']);
  });

  it('and the shipped island still sends NO body, which is what "no scope" means', () => {
    // The wire contract this depends on, asserted at its source: if the island
    // ever started sending `{}` unconditionally, the whole-set path would change
    // meaning without a single test failing anywhere else.
    const client = read('app/(authed)/code-health/_components/CodeHealthClient.tsx');
    expect(client).toMatch(/repoKeys === undefined\s*\?\s*\{ method: 'POST' \}/);
  });
});

// ── GUARD 4 · failure isolation, on the read AND on the page ─────────────────
describe('guard · one repo failing never collapses the whole answer', () => {
  it('the READ degrades that repo only', async () => {
    const { project: p, ctx } = await project('inst-guard-4');
    getCodeAuditMock.mockImplementation((q) => {
      const { repoKey } = q as { repoKey: string };
      return repoKey === 'moooon/motir-core'
        ? Promise.reject(new MotirAiUnavailableError('down'))
        : Promise.resolve(audited(repoKey));
    });

    const coverage = await auditCoverageService.getCoverage(p.id, ctx);

    expect(coverage.repos.filter((r) => r.state === 'audited')).toHaveLength(2);
    expect(coverage.repos.filter((r) => r.state === 'unavailable')).toHaveLength(1);
  });

  it('the PAGE keeps its per-repo containment — no bare Promise.all over the reads', () => {
    // MOTIR-2207 removed the shape where one rejection failed the whole page.
    // Both readers catch INSIDE the per-repo mapper, which is what makes their
    // `Promise.all` safe; this fails if either one loses its catch.
    const page = read('app/(authed)/code-health/page.tsx');
    expect(page).toMatch(/catch\s*\(err\)\s*\{\s*\n?\s*if \(err instanceof MotirAiError\)/);

    const service = read('lib/services/auditCoverageService.ts');
    const perRepo = service.slice(service.indexOf('async function readRepoCoverage'));
    expect(perRepo).toMatch(/catch \(err\) \{/);
    expect(perRepo).toMatch(/MotirAiError/);
  });
});
