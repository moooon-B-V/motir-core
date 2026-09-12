import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE STORY'S VITEST GATE — the IMPORT BOUNDARY a coverage percentage cannot see
// (Story MOTIR-4928 · MOTIR-5263).
//
// Every consumer of a monitor provider resolves it through the registry, by the
// discriminator stored on the grant (`getMonitorProvider(grant.provider)`). A
// module that imports an implementation directly has hard-wired Sentry past the
// seam built to contain it, and — the sharper failure — has bypassed the E2E
// switch that re-registers the fake under `sentry`, so it would reach the real
// host from a test server that believes it is running against the fake.
//
// The registry's other half, refusing an unknown discriminator rather than
// defaulting to the only member, is asserted in `monitor-provider-seam.test.ts`
// ("THROWS on an unknown discriminator rather than defaulting to the only member").

const ROOT = process.cwd();
const SOURCE_ROOTS = ['lib', 'app', 'components'];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(path, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

const OUTSIDE = SOURCE_ROOTS.flatMap((root) => sourceFiles(root)).filter(
  (file) => !file.startsWith('lib/monitors/'),
);

/** An import whose SPECIFIER reaches a provider implementation module. */
const PATH_IMPORT =
  /from\s+['"][^'"]*monitors\/providers\/[^'"]+['"]|import\(\s*['"][^'"]*monitors\/providers\//;
/** An implementation pulled by NAME through the barrel, which the path check misses. */
const NAMED_IMPORT = /\b(sentryMonitorProvider|fakeMonitorProvider)\b/;

describe('nothing outside lib/monitors reaches a provider implementation directly', () => {
  it('found the source tree — the sweep is not walking an empty directory', () => {
    expect(OUTSIDE.length).toBeGreaterThan(1000);
    expect(OUTSIDE).toContain('lib/services/monitorConnectionService.ts');
  });

  it('no module imports providers/sentry or providers/fake by path', () => {
    const offenders = OUTSIDE.filter((file) =>
      PATH_IMPORT.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no module names an implementation, even through the lib/monitors barrel', () => {
    const offenders = OUTSIDE.filter((file) =>
      NAMED_IMPORT.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the sweep FIRES on a module that does — proven over a fixture, not assumed', () => {
    expect(PATH_IMPORT.test(`import { x } from '@/lib/monitors/providers/sentry';`)).toBe(true);
    expect(PATH_IMPORT.test(`const m = await import('@/lib/monitors/providers/fake');`)).toBe(true);
    expect(NAMED_IMPORT.test(`import { sentryMonitorProvider } from '@/lib/monitors';`)).toBe(true);
    expect(PATH_IMPORT.test(`import { getMonitorProvider } from '@/lib/monitors';`)).toBe(false);
  });

  it('the consumers resolve through the registry by the stored discriminator', () => {
    for (const file of [
      'lib/services/monitorConnectionService.ts',
      'lib/services/monitorCredentialService.ts',
    ]) {
      expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(
        /getMonitorProvider\((grant|credential)\.provider\)/,
      );
    }
  });
});
