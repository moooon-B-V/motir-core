import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_MODULE_DIR } from '../../src/agentTerminal/pty.js';

// Where the terminal server's PTY comes from (MOTIR-6938 ·
// `docs/decisions/agent-terminal.md` Q4): compiled in its own image stage, at a
// pinned exact version, copied into the image at the path `serve` loads — and
// never a dependency of the published package.

const dockerfile = readFileSync(new URL('../../sandbox/Dockerfile', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };

describe('node-pty in the sandbox image', () => {
  it('is built in a stage with build tools, on the SAME Node base as the runtime', () => {
    const stage = dockerfile.slice(dockerfile.indexOf('AS terminal-pty'));
    expect(dockerfile).toMatch(/^FROM node:\$\{NODE_TAG\} AS terminal-pty$/m);
    expect(stage).toMatch(/install -y --no-install-recommends python3 make g\+\+/);
  });

  it('at a PINNED EXACT version', () => {
    expect(dockerfile).toMatch(/^ARG NODE_PTY_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toContain('--save-exact');
    expect(dockerfile).toContain('"node-pty@${NODE_PTY_VERSION}"');
  });

  it('is copied to the directory `serve` loads it from', () => {
    expect(DEFAULT_TERMINAL_MODULE_DIR).toBe('/opt/motir-terminal');
    expect(dockerfile).toContain(
      `COPY --from=terminal-pty ${DEFAULT_TERMINAL_MODULE_DIR} ${DEFAULT_TERMINAL_MODULE_DIR}`,
    );
    expect(dockerfile).toContain('motir agent-terminal --help >/dev/null');
  });

  it('is NOT a dependency of @motir/cli — commander stays the only one', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['commander']);
    expect(manifest.optionalDependencies).toBeUndefined();
  });
});
