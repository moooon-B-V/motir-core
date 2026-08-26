import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkBootstrapCheckout,
  materializeDispatchCheckouts,
  renderMaterialization,
  resolveDispatchTarget,
  resolveDispatchTargets,
} from '../src/dispatch.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { LinkConfig } from '../src/config/linkConfig.js';

// A DISPATCH NEVER STARTS WITHOUT THE CODE (Story MOTIR-3584 · Subtask
// MOTIR-3588) — the routing change and the pre-spawn materialization, driven
// with an injected `exists` and an injected `CommandRunner`, so no git process
// and no filesystem are involved.
//
// The defect this closes: `bootstrap_root` carried TWO different situations. A
// repository that does not exist anywhere yet (a scaffold card's own work) and
// one that exists on the host and simply is not cloned here both routed the
// agent to the workspace root — where the prompt's first command,
// `git worktree add`, cannot run. The discriminator is the presence of a CLONE
// URL on the payload, not the absence of a directory.

const ROOT = '/home/yue/work';
const LINK: LinkConfig = {
  serverUrl: 'https://app.motir.co',
  workspace: 'moooon',
  project: 'PROD',
};

const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);
const none = () => false;

const URL_CORE = 'https://github.com/moooon/motir-core.git';
const URL_AI = 'https://github.com/moooon/motir-ai.git';

function recorder(
  result: (bin: string, args: string[]) => CommandResult = () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }),
): { run: CommandRunner; calls: { args: string[] }[] } {
  const calls: { args: string[] }[] = [];
  const run: CommandRunner = (bin, args) => {
    calls.push({ args });
    return result(bin, args);
  };
  return { run, calls };
}

describe('resolveDispatchTarget — the clone-URL discriminator', () => {
  it('routes a MISSING checkout with a clone URL to the checkout, not the root', () => {
    const target = resolveDispatchTarget(ROOT, LINK, 'motir-core', {
      exists: none,
      cloneUrl: URL_CORE,
    });

    expect(target).toMatchObject({
      reason: 'clonable_checkout',
      cwd: '/home/yue/work/motir-core',
      repoPath: '/home/yue/work/motir-core',
      cloneUrl: URL_CORE,
      // Nothing to verify afterwards: the checkout is materialized BEFORE the
      // agent starts, so its absence is a refusal rather than a post-condition.
      verifyCheckoutAfterRun: false,
    });
  });

  it('PRESERVES bootstrap_root when the payload carries NO clone URL', () => {
    const target = resolveDispatchTarget(ROOT, LINK, 'brand-new', { exists: none });

    // The genuine empty-folder bootstrap: the repository does not exist
    // anywhere, so the dispatched card's own work is to create it. Unchanged.
    expect(target).toMatchObject({
      reason: 'bootstrap_root',
      cwd: ROOT,
      cloneUrl: null,
      verifyCheckoutAfterRun: true,
    });
  });

  it('treats an explicitly NULL clone URL exactly as an absent one', () => {
    // A server too old to send the field and a provider Motir cannot derive a
    // URL for are the same answer: there is nothing to clone from.
    expect(resolveDispatchTarget(ROOT, LINK, 'x', { exists: none, cloneUrl: null }).reason).toBe(
      'bootstrap_root',
    );
  });

  it('leaves an EXISTING checkout on the repo_checkout path', () => {
    const target = resolveDispatchTarget(ROOT, LINK, 'motir-core', {
      exists: only('/home/yue/work/motir-core'),
      cloneUrl: URL_CORE,
    });

    expect(target).toMatchObject({ reason: 'repo_checkout', cloneUrl: null });
  });

  it('leaves an UNPINNED item at the root, clone URL or not', () => {
    expect(
      resolveDispatchTarget(ROOT, LINK, null, { exists: none, cloneUrl: URL_CORE }).reason,
    ).toBe('unpinned_root');
  });

  it('keeps the bootstrap POST-CONDITION firing for the preserved case', () => {
    const target = resolveDispatchTarget(ROOT, LINK, 'brand-new', { exists: none });

    expect(checkBootstrapCheckout(target, { exists: none })?.repoName).toBe('brand-new');
    // …and silent once the card created it, exactly as before.
    expect(checkBootstrapCheckout(target, { exists: only('/home/yue/work/brand-new') })).toBeNull();
  });

  it('is never asked to verify a checkout the run itself cloned', () => {
    const target = resolveDispatchTarget(ROOT, LINK, 'motir-core', {
      exists: none,
      cloneUrl: URL_CORE,
    });

    expect(checkBootstrapCheckout(target, { exists: none })).toBeNull();
  });
});

describe('resolveDispatchTargets — per element', () => {
  it('reads EACH element’s own clone URL', () => {
    const targets = resolveDispatchTargets(
      ROOT,
      LINK,
      [
        { name: 'motir-core', cloneUrl: URL_CORE },
        { name: 'motir-ai', cloneUrl: null },
      ],
      { exists: none },
    );

    // A set with one materializable half and one that is not must not be routed
    // by whichever element happened to be first.
    expect(targets.map((t) => t.reason)).toEqual(['clonable_checkout', 'bootstrap_root']);
  });

  it('still accepts bare names, for the paths that have no URL to give', () => {
    const targets = resolveDispatchTargets(ROOT, LINK, ['motir-core'], { exists: none });

    expect(targets.map((t) => t.reason)).toEqual(['bootstrap_root']);
  });
});

describe('materializeDispatchCheckouts', () => {
  it('clones every clonable target, and nothing else', () => {
    const { run, calls } = recorder();
    const targets = resolveDispatchTargets(
      ROOT,
      LINK,
      [
        { name: 'motir-core', cloneUrl: URL_CORE },
        { name: 'motir-ai', cloneUrl: URL_AI },
      ],
      { exists: only('/home/yue/work/motir-ai') },
    );

    const result = materializeDispatchCheckouts(ROOT, targets, { run });

    // `motir-ai` already exists, so it is not touched — the same never-touch
    // invariant the link command holds, through the same primitive.
    expect(calls).toEqual([{ args: ['clone', URL_CORE, '/home/yue/work/motir-core'] }]);
    expect(result).toEqual({ cloned: ['motir-core'], failures: [] });
  });

  it('issues NOTHING when there is nothing to materialize', () => {
    const { run, calls } = recorder();
    const targets = [resolveDispatchTarget(ROOT, LINK, 'brand-new', { exists: none })];

    expect(materializeDispatchCheckouts(ROOT, targets, { run })).toEqual({
      cloned: [],
      failures: [],
    });
    expect(calls).toEqual([]);
  });

  it('reports a FAILURE with git’s own message, so the caller can refuse', () => {
    const { run } = recorder(() => ({
      exitCode: 128,
      stdout: '',
      stderr: 'remote: Repository not found.',
    }));
    const targets = resolveDispatchTargets(
      ROOT,
      LINK,
      [{ name: 'motir-core', cloneUrl: URL_CORE }],
      {
        exists: none,
      },
    );

    const result = materializeDispatchCheckouts(ROOT, targets, { run });

    expect(result.cloned).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.gitMessage).toBe('remote: Repository not found.');
    // The refusal names the pending-invitation case, through the link card's
    // primitive rather than a second message written here.
    expect(result.failures[0]?.detail).toContain('collaborator invitation');
  });

  it('renders a refusal that says NO AGENT WAS STARTED, and why', () => {
    const lines = renderMaterialization({
      cloned: [],
      failures: [{ repo: 'motir-core', detail: 'could not clone', gitMessage: 'fatal: nope' }],
    });

    expect(lines.join('\n')).toContain('No agent was started');
    expect(lines.join('\n')).toContain('git worktree add');
  });

  it('renders nothing at all when nothing happened', () => {
    expect(renderMaterialization({ cloned: [], failures: [] })).toEqual([]);
  });
});

describe('every dispatching call site routes through the changed resolution', () => {
  // A SOURCE guard, in the shape `architecture.test.ts` uses: the failure this
  // card removes is one call site left behind, and that is invisible to any test
  // that drives the others. Named here so a sixth call site added later has to
  // join the list rather than silently opt out.
  const SITES = ['commands/dispatch.ts', 'commands/auto.ts', 'commands/batch.ts'];

  it.each(SITES)('%s hands the payload’s clone URL to the resolution', (file) => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8');

    // The SET path carries a URL per element…
    expect(source).toMatch(/cloneUrl: (repo|r)\.cloneUrl/);
    // …and the single-repository fallback carries the scalar.
    expect(source).toContain('cloneUrl: dispatch.targetRepoCloneUrl ?? null');
  });

  it.each(SITES)('%s materializes BEFORE it spawns an agent', (file) => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8');

    expect(source).toContain('materializeDispatchCheckouts');
    // The refusal is what makes it a gate rather than a courtesy: every site
    // reads the failures and stops.
    expect(source).toContain('materialized.failures.length > 0');
  });
});
