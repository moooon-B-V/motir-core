import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_K6,
  REMOTE_RUN_DIR,
  VOLUME_MOUNT,
  parseVersionsEnv,
} from '@/loadtest/run/generator';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('the load-test generator image recipe (MOTIR-9116)', () => {
  const dockerfile = read('loadtest/generator/Dockerfile');
  const toml = read('loadtest/generator/fly.loadgen.toml');
  const pins = parseVersionsEnv(read('loadtest/k6/versions.env'));

  it('defaults every build arg to the versions.env pin', () => {
    for (const name of ['XK6_IMAGE_TAG', 'K6_VERSION', 'XK6_SSE_MODULE', 'XK6_SSE_VERSION']) {
      expect(dockerfile).toContain(`ARG ${name}=${pins[name]}\n`);
    }
  });

  // xk6 binds a K6_VERSION env var to its --k6-version flag and refuses a version given as both flag
  // and argument. `ARG K6_VERSION` puts the var in the RUN's environment, so a positional version
  // must come with the var unset (MOTIR-9125).
  it('never hands xk6 the k6 version twice', () => {
    const build = dockerfile.match(/^RUN .*\bxk6 build\b.*$/m)?.[0];
    expect(build).toBeDefined();
    if (build!.includes('"${K6_VERSION}"')) {
      expect(build).toMatch(/\benv -u K6_VERSION xk6 build\b/);
    }
  });

  it('places the binary where the run command looks for it', () => {
    expect(dockerfile).toContain(`COPY --from=k6 /k6 ${REMOTE_K6}`);
  });

  it('declares the /data volume the run command requires', () => {
    expect(toml).toMatch(new RegExp(`destination\\s*=\\s*"${VOLUME_MOUNT}"`));
    expect(REMOTE_RUN_DIR.startsWith(`${VOLUME_MOUNT}/`)).toBe(true);
  });

  it('passes the pins from versions.env in deploy.sh', () => {
    const script = read('loadtest/generator/deploy.sh');
    expect(script).toContain('k6/versions.env');
    for (const name of ['XK6_IMAGE_TAG', 'K6_VERSION', 'XK6_SSE_MODULE', 'XK6_SSE_VERSION']) {
      expect(script).toContain(`${name}=`);
    }
  });
});
