import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_ROLE_LADDER } from '@/lib/platform/auth';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE TOKEN BOUNDARY (Story MOTIR-7662 · MOTIR-7673 ·
// `docs/decisions/platform-staff-auth.md` §2, the 2026-10-07 amendment).
//
// The amendment lets a staff member's personal access token reach the IDEAS
// endpoints and nothing else on the platform. This file is what turns "nothing
// else" from a promise into a failing build, in two halves:
//
//  1. STRUCTURAL — the ideas gate (`lib/platform/ideasGate.ts`) is imported from
//     `app/api/platform/ideas/**` only. Any other importer under `app/` or `lib/`
//     fails here, by path.
//  2. BEHAVIOURAL — the ordinary gate, `requirePlatformStaff`, never accepts a
//     token: with a valid superadmin token and no session it refuses at every
//     degree, and every route handler under `app/api/**` that calls it (found by
//     scanning, not by a hand list) refuses a bearer-only request.

const ROOT = process.cwd();
const GATE_MODULE =
  /['"]@\/lib\/platform\/ideasGate['"]|['"](\.{1,2}\/)+(lib\/)?platform\/ideasGate['"]|['"]\.\/ideasGate['"]/;
const ALLOWED_DIR = 'app/api/platform/ideas/';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every file (repo-relative) that imports the ideas gate from outside the one
 * directory allowed to. Pure over its input, so the negative case is testable.
 */
function gateImportViolations(files: { file: string; source: string }[]): string[] {
  return files
    .filter(({ file }) => file !== 'lib/platform/ideasGate.ts')
    .filter(({ file }) => !file.startsWith(ALLOWED_DIR))
    .filter(({ source }) => GATE_MODULE.test(source))
    .map(({ file }) => file);
}

function sourceTree(): { file: string; source: string }[] {
  return ['app', 'lib'].flatMap((top) =>
    walk(path.join(ROOT, top)).map((full) => ({
      file: path.relative(ROOT, full).split(path.sep).join('/'),
      source: readFileSync(full, 'utf8'),
    })),
  );
}

describe('structural — only app/api/platform/ideas/** imports the ideas gate', () => {
  it('has no importer outside the allowed directory', () => {
    expect(gateImportViolations(sourceTree())).toEqual([]);
  });

  it('catches an importer outside it, by any spelling (the negative fixture)', () => {
    const offenders = gateImportViolations([
      {
        file: 'app/api/platform/orgs/route.ts',
        source: "import { x } from '@/lib/platform/ideasGate';",
      },
      { file: 'lib/services/fooService.ts', source: "import { x } from '../platform/ideasGate';" },
      { file: 'lib/platform/other.ts', source: "export * from './ideasGate';" },
      {
        file: 'app/(admin)/admin/ideas/actions.ts',
        source: "await import('@/lib/platform/ideasGate')",
      },
      {
        file: 'app/api/platform/ideas/route.ts',
        source: "import { x } from '@/lib/platform/ideasGate';",
      },
      { file: 'lib/platform/ideasGate.ts', source: "import './ideasGate';" },
    ]);
    expect(offenders).toEqual([
      'app/api/platform/orgs/route.ts',
      'lib/services/fooService.ts',
      'lib/platform/other.ts',
      'app/(admin)/admin/ideas/actions.ts',
    ]);
  });
});

// ── Behavioural ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => null),
}));

let token = '';

beforeEach(async () => {
  vi.resetModules();
  await truncateAuthTables();
  const { owner, workspace } = await createTestWorkspace({ name: 'Token boundary' });
  await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: 'superadmin' } });
  ({ token } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-ideas',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  }));
});

afterAll(async () => {
  await truncateAuthTables();
});

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Every route handler under `app/api/` (outside the ideas tree) that calls `requirePlatformStaff`. */
function platformRoutes(): string[] {
  return walk(path.join(ROOT, 'app/api'))
    .filter((full) => /route\.(ts|tsx)$/.test(full))
    .map((full) => path.relative(ROOT, full).split(path.sep).join('/'))
    .filter((file) => !file.startsWith(ALLOWED_DIR))
    .filter((file) =>
      /\brequirePlatformStaff\s*\(/.test(readFileSync(path.join(ROOT, file), 'utf8')),
    );
}

describe('behavioural — the ordinary platform gate never accepts a token', () => {
  it.each(PLATFORM_ROLE_LADDER)(
    'requirePlatformStaff(%s) refuses with a superadmin token and no session',
    async (minimum) => {
      const [{ requirePlatformStaff }, { NotPlatformStaffError }] = await Promise.all([
        import('@/lib/platform/auth'),
        import('@/lib/platform/errors'),
      ]);
      expect(token.startsWith('motir_pat_')).toBe(true);
      await expect(requirePlatformStaff(minimum)).rejects.toBeInstanceOf(NotPlatformStaffError);
    },
  );

  it('requirePlatformStaff reads no request header', () => {
    const source = readFileSync(path.join(ROOT, 'lib/platform/auth.ts'), 'utf8');
    expect(source).not.toMatch(/authorization/i);
    expect(source).not.toMatch(/apiTokensService/);
  });

  it('every app/api route that calls requirePlatformStaff refuses a bearer-only request', async () => {
    const routes = platformRoutes();
    const answered: string[] = [];
    for (const file of routes) {
      const mod = (await import(path.join(ROOT, file))) as Record<string, unknown>;
      for (const method of HTTP_METHODS) {
        const handler = mod[method];
        if (typeof handler !== 'function') continue;
        const req = new Request('http://localhost/api/platform/probe', {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
        });
        let status: number;
        try {
          const res = (await handler(req, { params: Promise.resolve({}) })) as Response;
          status = res.status;
        } catch (err) {
          status = (err as { code?: string }).code === 'NOT_PLATFORM_STAFF' ? 404 : 500;
        }
        expect({ file, method, status }).toEqual({ file, method, status: 404 });
        answered.push(`${method} ${file}`);
      }
    }
    // Today no app/api route outside the ideas tree is platform-gated — the
    // console is server actions behind the (admin) layout. The day one is added,
    // this loop starts probing it without anyone editing this file.
    expect(answered.length).toBeGreaterThanOrEqual(routes.length);
  });
});
