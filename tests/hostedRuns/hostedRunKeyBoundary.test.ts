import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE BOUNDARY OF THE HOSTED RUN'S GATEWAY WIRING (MOTIR-689, criterion 5):
//
//   - motir-core reaches the gateway and motir-ai over HTTP only — no import of
//     either codebase;
//   - `MOTIR_RUN_KEY_MINT_SECRET` is read in exactly one server-only module, and
//     no client component names it;
//   - nothing reads `MOTIR_HOSTED_AGENT_MODEL`, which the model choice retired
//     (`docs/decisions/hosted-agent-run.md` §6, §7).

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['lib', 'app', 'components', 'packages'];
const SKIP = new Set(['node_modules', 'dist', '.next', 'generated']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const files = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((full) => ({
  path: relative(ROOT, full),
  text: readFileSync(full, 'utf8'),
}));

describe('the hosted run gateway wiring stays on its side of the boundary', () => {
  it('imports neither motir-gateway nor motir-ai', () => {
    const offenders = files
      .filter(({ text }) =>
        /from\s+['"][^'"]*(motir-gateway|motir-ai)(\/[^'"]*)?['"]|require\(\s*['"][^'"]*(motir-gateway|motir-ai)/.test(
          text,
        ),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('reads MOTIR_RUN_KEY_MINT_SECRET in exactly one server-only module', () => {
    // A READ names the variable as a string (the env lookup's key); prose that
    // mentions it in a comment does not.
    const readers = files
      .filter(({ text }) => /['"]MOTIR_RUN_KEY_MINT_SECRET['"]/.test(text))
      .map(({ path }) => path);
    expect(readers).toEqual(['lib/gateway/runKeyClient.ts']);
    const clientComponents = files
      .filter(({ text }) => /^['"]use client['"]/m.test(text))
      .filter(({ text }) => text.includes('MOTIR_RUN_KEY_MINT_SECRET'))
      .map(({ path }) => path);
    expect(clientComponents).toEqual([]);
    const client = files.find(({ path }) => path === 'lib/gateway/runKeyClient.ts');
    expect(client?.text.startsWith("import 'server-only';")).toBe(true);
    const service = files.find(({ path }) => path === 'lib/services/hostedRunKeyService.ts');
    expect(service?.text.startsWith("import 'server-only';")).toBe(true);
  });

  it('never reads MOTIR_HOSTED_AGENT_MODEL', () => {
    const readers = files
      .filter(({ text }) => text.includes('MOTIR_HOSTED_AGENT_MODEL'))
      .map(({ path }) => path);
    expect(readers).toEqual([]);
  });
});
