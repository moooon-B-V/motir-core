import { describe, expect, it } from 'vitest';
import {
  checkBootstrapCheckout,
  cwdReasonLabel,
  renderAgentFailure,
  renderAgentSuccess,
  renderDispatchSummary,
  renderSessionOutcomes,
  resolveDispatchTarget,
  workflowLabel,
} from '../src/dispatch.js';
import { resolveAgent, notReadyError } from '../src/commands/dispatch.js';
import type { LinkConfig } from '../src/config/linkConfig.js';
import type { DispatchPrompt } from '../src/mcpClient.js';

// The PURE dispatch engine: repo routing, the bootstrap post-condition, agent
// resolution, and the human-facing text. No MCP, no spawn, no filesystem —
// existence is injected, so the whole routing matrix is exercised directly.

const ROOT = '/home/yue/work';
const LINK: LinkConfig = {
  serverUrl: 'https://app.motir.co',
  workspace: 'moooon',
  project: 'PROD',
};

/** An `exists` predicate over an explicit allow-list of paths. */
const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

const none = () => false;

function prompt(over: Partial<DispatchPrompt> = {}): DispatchPrompt {
  return {
    key: 'PROD-7',
    prompt: 'CONTEXT\nWHAT TO DO\n',
    targetRepo: 'motir-core',
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    ...over,
  };
}

describe('resolveDispatchTarget — repo routing', () => {
  it('runs INSIDE the target repo checkout when it exists (convention path)', () => {
    const target = resolveDispatchTarget(ROOT, LINK, 'motir-ai', {
      exists: only('/home/yue/work/motir-ai'),
    });
    expect(target).toMatchObject({
      targetRepo: 'motir-ai',
      cwd: '/home/yue/work/motir-ai',
      reason: 'repo_checkout',
      repoSource: 'convention',
      verifyCheckoutAfterRun: false,
    });
  });

  it('honours an override path from .motir.json over the convention', () => {
    const config: LinkConfig = { ...LINK, repos: { 'motir-ai': '../checkouts/ai' } };
    const target = resolveDispatchTarget(ROOT, config, 'motir-ai', {
      exists: only('/home/yue/checkouts/ai'),
    });
    expect(target.cwd).toBe('/home/yue/checkouts/ai');
    expect(target.repoSource).toBe('override');
    expect(target.reason).toBe('repo_checkout');
  });

  it('dispatches repo B from inside repo A — the cwd follows the ITEM, not the caller', () => {
    // The caller stands in motir-core; the item targets motir-ai. Both exist.
    const target = resolveDispatchTarget(ROOT, LINK, 'motir-ai', {
      exists: only('/home/yue/work/motir-core', '/home/yue/work/motir-ai'),
    });
    expect(target.cwd).toBe('/home/yue/work/motir-ai');
  });

  it('BOOTSTRAP: a missing checkout runs at the workspace root and asks to be verified', () => {
    const target = resolveDispatchTarget(ROOT, LINK, 'brand-new-repo', { exists: none });
    expect(target).toMatchObject({
      cwd: ROOT,
      reason: 'bootstrap_root',
      repoPath: '/home/yue/work/brand-new-repo',
      verifyCheckoutAfterRun: true,
    });
  });

  it('an UNPINNED item (targetRepo null) runs at the root and is never verified', () => {
    const target = resolveDispatchTarget(ROOT, LINK, null, { exists: none });
    expect(target).toMatchObject({
      targetRepo: null,
      cwd: ROOT,
      reason: 'unpinned_root',
      repoPath: null,
      repoSource: null,
      verifyCheckoutAfterRun: false,
    });
  });

  it('NEVER routes an item into a DIFFERENT existing checkout', () => {
    // Every OTHER repo exists; the item's own does not. The only legal answers
    // are its own path or the root — never a sibling checkout.
    const siblings = ['/home/yue/work/motir-core', '/home/yue/work/motir-ai'];
    const target = resolveDispatchTarget(ROOT, LINK, 'motir-gateway', {
      exists: only(...siblings),
    });
    expect(siblings).not.toContain(target.cwd);
    expect(target.cwd).toBe(ROOT);
  });
});

describe('checkBootstrapCheckout — the bootstrap post-condition', () => {
  const missing = resolveDispatchTarget(ROOT, LINK, 'brand-new-repo', { exists: none });

  it('reports a SUSPECT dispatch when the checkout never appeared', () => {
    const suspect = checkBootstrapCheckout(missing, { exists: none });
    expect(suspect).not.toBeNull();
    expect(suspect?.expectedPath).toBe('/home/yue/work/brand-new-repo');
    expect(suspect?.hint).toContain('motir link add brand-new-repo');
  });

  it('is silent once the checkout exists', () => {
    expect(
      checkBootstrapCheckout(missing, { exists: only('/home/yue/work/brand-new-repo') }),
    ).toBeNull();
  });

  it('is silent for a dispatch that had nothing to verify', () => {
    const inRepo = resolveDispatchTarget(ROOT, LINK, 'motir-ai', {
      exists: only('/home/yue/work/motir-ai'),
    });
    expect(checkBootstrapCheckout(inRepo, { exists: none })).toBeNull();
    const unpinned = resolveDispatchTarget(ROOT, LINK, null, { exists: none });
    expect(checkBootstrapCheckout(unpinned, { exists: none })).toBeNull();
  });
});

describe('resolveAgent — precedence', () => {
  it('prefers --agent, then MOTIR_AGENT, then the config', () => {
    const env = { MOTIR_AGENT: 'codex' };
    const config = () => 'opencode';
    expect(resolveAgent({ agent: 'claude --yolo' }, env, config)).toMatchObject({
      source: 'flag',
      parsed: { binary: 'claude', args: ['--yolo'] },
    });
    expect(resolveAgent({}, env, config)).toMatchObject({ source: 'env' });
    expect(resolveAgent({}, {}, config)).toMatchObject({ source: 'config' });
  });

  it('--print wins over every configured agent (print is the BYOK default)', () => {
    expect(
      resolveAgent({ print: true, agent: 'claude' }, { MOTIR_AGENT: 'codex' }, () => 'x'),
    ).toBe(null);
  });

  it('returns null when no agent is configured anywhere — printing is correct, not an error', () => {
    expect(resolveAgent({}, {}, () => undefined)).toBeNull();
    expect(resolveAgent({}, { MOTIR_AGENT: '   ' }, () => '  ')).toBeNull();
  });
});

describe('notReadyError', () => {
  it('names the open blockers and points at --force', () => {
    const err = notReadyError({
      identifier: 'PROD-7',
      openBlockers: [{ identifier: 'PROD-3', title: 'Schema' }],
      blockedByAncestor: null,
    });
    expect(err.message).toContain('PROD-7 is not ready.');
    expect(err.message).toContain('PROD-3 (Schema)');
    expect(err.hint).toContain('--force');
  });

  it('names a blocked ANCESTOR too', () => {
    const err = notReadyError({
      identifier: 'PROD-7',
      openBlockers: [],
      blockedByAncestor: { identifier: 'PROD-1' },
    });
    expect(err.message).toContain('ancestor PROD-1');
  });
});

describe('summary + outcome rendering', () => {
  it('the --print summary NAMES the target repo and the resolved path', () => {
    const target = resolveDispatchTarget(ROOT, LINK, 'motir-core', {
      exists: only('/home/yue/work/motir-core'),
    });
    const text = renderDispatchSummary({
      key: 'PROD-7',
      title: 'Add the thing',
      dispatch: prompt(),
      target,
      agent: null,
    });
    expect(text).toContain('motir-core');
    expect(text).toContain('/home/yue/work/motir-core');
    expect(text).toContain('printing the prompt');
  });

  it('says so plainly when Motir cannot name a repo', () => {
    const target = resolveDispatchTarget(ROOT, LINK, null, { exists: none });
    const text = renderDispatchSummary({
      key: 'PROD-7',
      title: null,
      dispatch: prompt({ targetRepo: null }),
      target,
      agent: { command: 'claude', source: 'env' },
    });
    expect(text).toContain('not pinned');
    expect(text).toContain('MOTIR_AGENT');
  });

  it('labels each routing outcome distinctly', () => {
    expect(
      cwdReasonLabel(
        resolveDispatchTarget(ROOT, LINK, 'motir-ai', { exists: only('/home/yue/work/motir-ai') }),
      ),
    ).toContain('checkout');
    expect(cwdReasonLabel(resolveDispatchTarget(ROOT, LINK, 'x', { exists: none }))).toContain(
      'the prompt creates it',
    );
    expect(cwdReasonLabel(resolveDispatchTarget(ROOT, LINK, null, { exists: none }))).toContain(
      'pins no repo',
    );
  });

  it('describes both git workflow modes', () => {
    expect(workflowLabel('per_item_pr', null)).toContain('pull request');
    expect(workflowLabel('session_lineage', 'story/PROD-9')).toContain('story/PROD-9');
  });

  it('the success message routes the human to the right close-out per mode', () => {
    expect(renderAgentSuccess('PROD-7', prompt())).toContain('motir done PROD-7');
    const session = prompt({ workflowMode: 'session_lineage', sessionBranch: 'story/PROD-9' });
    expect(renderAgentSuccess('PROD-7', session)).toContain('motir done --session story/PROD-9');
  });

  it('the failure message says the item was NOT reverted', () => {
    const text = renderAgentFailure('PROD-7', 2);
    expect(text).toContain('exited 2');
    expect(text).toContain('stays In Progress');
    expect(text).toContain('motir run PROD-7');
  });

  it('renders per-item session outcomes, including failures with reasons', () => {
    const text = renderSessionOutcomes('story/PROD-9', [
      { key: 'PROD-7', outcome: 'completed' },
      { key: 'PROD-8', outcome: 'failed', reason: 'no legal path to done' },
    ]);
    expect(text).toContain('1 completed');
    expect(text).toContain('PROD-8: failed — no legal path to done');
  });

  it('says so when a branch has no recorded items', () => {
    expect(renderSessionOutcomes('story/PROD-9', [])).toContain('No work items');
  });
});
