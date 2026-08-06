import { readFile } from 'node:fs/promises';
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

describe('the generated client is not yet wired into the CLI', () => {
  it('no file under `packages/cli/src` outside `src/api` imports it', async () => {
    // This card ships the pipeline and NO client behaviour: the hand-written
    // interfaces are still the live types until 11.5.3 replaces them. Asserting
    // it here is what makes "the CLI's behaviour is unchanged" a fact rather
    // than an intention.
    const { globSync } = await import('node:fs');
    const files = globSync('packages/cli/src/**/*.ts', { cwd: REPO_ROOT }).filter(
      (file) => !file.replaceAll('\\', '/').includes('packages/cli/src/api/'),
    );
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const source = await readFile(join(REPO_ROOT, file), 'utf8');
      expect(source, `${file} already imports the generated client`).not.toMatch(
        /from\s+['"][^'"]*\/api(\/[^'"]*)?['"]/,
      );
    }
  });
});
