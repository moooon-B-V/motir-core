import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Staging must run the machine size production runs for the `app` group: the load
// test measures what one production-sized machine holds, and `pnpm loadtest:run`
// exits 4 on a mismatch. A production resize that forgets staging fails here, not at
// the next run (MOTIR-9117).

const ROOT = join(__dirname, '../..');

/** The `[[vm]]` block whose `processes` names `app`: its size, cpus and memory. */
export function appVm(toml: string): { size: string; cpus: string; memory: string } {
  const blocks = toml.split(/^\[\[vm\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const body = block.split(/^\[/m)[0]!;
    const get = (k: string) =>
      new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'm')
        .exec(body)?.[1]
        ?.replace(/^["']|["']$/g, '');
    if (/"app"/.test(get('processes') ?? '')) {
      return { size: get('size') ?? '', cpus: get('cpus') ?? '', memory: get('memory') ?? '' };
    }
  }
  throw new Error('no [[vm]] block for the app process group');
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('staging app machine size', () => {
  it('reads the app group out of a fly.toml, not the worker', () => {
    const t = `[[vm]]\n  size = "performance-1x"\n  cpus = 1\n  memory = "2gb"\n  processes = ["app"]\n\n[[vm]]\n  size = "shared-cpu-1x"\n  memory = "1gb"\n  processes = ["worker"]\n`;
    expect(appVm(t)).toEqual({ size: 'performance-1x', cpus: '1', memory: '2gb' });
  });

  it('loadtest/staging/fly.staging.toml declares the same app size as fly.toml', () => {
    const prod = appVm(read('fly.toml'));
    const staging = appVm(read('loadtest/staging/fly.staging.toml'));
    expect(staging).toEqual(prod);
  });
});
