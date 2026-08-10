import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET as specRoute } from '@/app/api/openapi/v1.json/route';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import {
  CLI_API_DIR,
  generateCliApi,
  readCommittedArtifacts,
  staleArtifacts,
} from '../../scripts/generateCliApi';

// The TWO guards that make a committed, machine-written artifact trustworthy
// (Story 11.5 · Subtask 11.5.2 — MOTIR-2210), implementing
// `docs/decisions/cli-v1-client.md` Q2 (c) and (d).
//
// They are deliberately TWO guards over one document, not one:
//
//   Guard A — our COMMITTED client matches our EMITTER.
//   Guard B — our EMITTER matches what the WORLD can fetch.
//
// Collapsing them would leave a world where the CLI is correct and the published
// spec is wrong, or the reverse, with one green check either way. `packages/cli`
// generates from the emitter (a build that needs a running server is a build
// nobody can run); external integrators generate from `/api/openapi/v1.json`.
// Guard B is what makes those two the same bytes, for people who will never see
// this repository.

const REPO_ROOT = process.cwd();

describe('Guard A — the committed v1 client is FRESH', () => {
  it('every generated artifact matches what the emitter produces right now', async () => {
    const generated = await generateCliApi();
    const committed = await readCommittedArtifacts(REPO_ROOT, Object.keys(generated));

    // Named per file rather than as one object comparison: a 1.7 MB validator
    // diff printed in full is unreadable, and the file NAME is the whole
    // actionable content of this failure.
    expect(
      staleArtifacts(generated, committed),
      'Run `pnpm generate:cli-api` and commit the result.',
    ).toEqual([]);
  });

  it('is byte-identical across two runs, so the guard cannot flap', async () => {
    // The guard is only a signal if regeneration is deterministic. If it were
    // not, every PR would show a diff and the guard would be disabled within a
    // week — which is exactly how a generated file goes back to being a
    // hand-written mirror with extra ceremony.
    const [first, second] = await Promise.all([generateCliApi(), generateCliApi()]);
    expect(staleArtifacts(first, second)).toEqual([]);
  });

  it('REPORTS a deliberately stale artifact — the guard is driven, not trusted', async () => {
    const generated = await generateCliApi();
    const operations = generated['operations.ts'];
    expect(operations).toBeDefined();

    const handEdited = {
      ...generated,
      'operations.ts': `${operations ?? ''}\n// a hand edit\n`,
    };
    expect(staleArtifacts(generated, handEdited)).toEqual(['operations.ts']);
  });

  it('REPORTS a missing artifact rather than passing it', async () => {
    const generated = await generateCliApi();
    const { 'validators.js': _deleted, ...withoutValidators } = generated;
    expect(staleArtifacts(generated, withoutValidators)).toEqual(['validators.js']);
  });

  it('writes only into `packages/cli/src/api`', async () => {
    // The output directory is part of the contract: the ADR's Q4 import rule is
    // stated over this one path, and a generator that wrote elsewhere would put
    // generated code somewhere the rule does not reach.
    expect(CLI_API_DIR).toBe(join('packages', 'cli', 'src', 'api'));
    const generated = await generateCliApi();
    for (const name of Object.keys(generated)) {
      expect(name, `${name} must be a bare file name`).not.toContain('/');
    }
  });

  it('marks every artifact as generated, naming the command that rebuilds it', async () => {
    const generated = await generateCliApi();
    for (const [name, contents] of Object.entries(generated)) {
      expect(contents, `${name} carries no do-not-edit banner`).toContain(
        'GENERATED FILE — DO NOT EDIT BY HAND',
      );
      expect(contents, `${name} does not name its regeneration command`).toContain(
        'pnpm generate:cli-api',
      );
    }
  });
});

describe('Guard B — the SERVED spec matches the emitter', () => {
  it('`GET /api/openapi/v1.json` returns exactly what the emitter produces', async () => {
    const response = await specRoute();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(emitOpenApiDocument());
  });

  it('serves it as JSON, so a generator can consume it without negotiation', async () => {
    const response = await specRoute();
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('Q4’s import rule — a wire type never reaches a renderer', () => {
  // `docs/decisions/cli-v1-client.md` Q4: only `src/transport.ts` and
  // `src/adapters/` may import from `src/api/`. This is what makes the story's
  // byte-identical promise AUDITABLE rather than asserted — if no generated type
  // can reach `render.ts`, a server shape change can only arrive through an
  // adapter, where it is a visible edit.
  //
  // (11.5.2 asserted the stronger "nothing imports it at all", which was true
  // for exactly one card. 11.5.3 wires the transport, so the rule becomes the
  // one the ADR actually pinned — and 11.5.7 extends it with the import-graph
  // walk. The lists below are the allowance, and adding to them is the edit a
  // reviewer should notice.)
  const ALLOWED = [
    'packages/cli/src/transport.ts',
    // `src/adapters/` arrives with its first consumer in 11.5.4.
  ];

  it('only the transport and the adapters import `src/api`', async () => {
    const { globSync } = await import('node:fs');
    const files = globSync('packages/cli/src/**/*.ts', { cwd: REPO_ROOT })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => !file.includes('packages/cli/src/api/'));
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      if (ALLOWED.includes(file) || file.startsWith('packages/cli/src/adapters/')) continue;
      const source = await readFile(join(REPO_ROOT, file), 'utf8');
      expect(source, `${file} may not import the generated client (ADR Q4)`).not.toMatch(
        /from\s+['"][^'"]*\/api(\/[^'"]*)?['"]/,
      );
    }
  });

  it('`render.ts` is the file the rule exists to protect, and it is clean', async () => {
    const source = await readFile(join(REPO_ROOT, 'packages/cli/src/render.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*\/api(\/[^'"]*)?['"]/);
  });
});

describe('Guard C — the CLI table agrees with the emitted x-motir-permission (MOTIR-2583)', () => {
  // Guard A proves the committed artifacts are what the generator produces
  // right now. It does NOT, on its own, say the field the CLI's 403 hint reads
  // means what the server publishes: a generator that read the wrong extension,
  // or a rename that moved only one side, regenerates cleanly and stays green.
  //
  // So this compares the two halves DIRECTLY, per operation. The CLI names the
  // missing permission from its own table rather than parsing the server's
  // English (`docs/decisions/cli-v1-client.md` Q5), which is the right design
  // and has exactly one cost — the table is a mirror, and a mirror of a contract
  // that moved is simply wrong. Wrong in the quietest way, too: every command
  // still works, and only the FAILURE path lies, telling someone to grant
  // something that does not exist on a screen that does not offer it. That is
  // the worst moment to be wrong, because they are already stuck.
  it('every operation requires what the document says it requires', async () => {
    const { V1_OPERATIONS } = await import('../../packages/cli/src/api/operations');
    const { V1_PERMISSION_EXTENSION } = await import('@/lib/api/v1/openapi/security');
    const document = emitOpenApiDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    let compared = 0;
    for (const [operationId, entry] of Object.entries(V1_OPERATIONS)) {
      const published = document.paths[entry.path]?.[entry.method.toLowerCase()];
      expect(published, `${entry.method} ${entry.path} is not in the document`).toBeDefined();
      expect(
        published?.[V1_PERMISSION_EXTENSION],
        `${operationId}: the CLI table and the document disagree`,
      ).toBe(entry.permission);
      compared += 1;
    }
    // The sweep really covered the surface rather than an empty map.
    expect(compared).toBe(Object.keys(V1_OPERATIONS).length);
    expect(compared).toBeGreaterThanOrEqual(40);
  });

  it('names no retired scope string anywhere in the table', () => {
    // The 403 hint is rendered from these values, so a straggler here is a
    // message pointing at a vocabulary the product no longer has.
    const table = readFileSync(join(REPO_ROOT, 'packages/cli/src/api/operations.ts'), 'utf8');
    for (const retired of [
      'work_items:write',
      'work_items:archive',
      'work_items:delete',
      'sprints:write',
    ]) {
      expect(table, `the CLI table still names "${retired}"`).not.toContain(retired);
    }
  });
});
