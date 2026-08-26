import { describe, expect, it } from 'vitest';
import {
  agentSubmittedReplan,
  checkBootstrapCheckout,
  cwdReasonLabel,
  renderAgentFailure,
  renderAgentSuccess,
  renderDispatchAdvisories,
  renderDispatchSummary,
  renderReplanSubmitted,
  renderRepositoriesBlock,
  renderResumeNotice,
  renderSessionOutcomes,
  resolveDispatchTarget,
  resolveDispatchTargets,
  workflowLabel,
} from '../src/dispatch.js';
import { resolveAgent, notReadyError } from '../src/commands/dispatch.js';
import type { LinkConfig } from '../src/config/linkConfig.js';
import type {
  DispatchAdvisory,
  DispatchOrderingAdvisory,
  DispatchPrompt,
  DispatchReferenceAdvisory,
  DispatchRepoStraddleAdvisory,
  DispatchSubsumptionAdvisory,
} from '../src/client.js';

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
    parentKey: 'PROD-2',
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

describe('renderDispatchAdvisories — the prose-vs-graph WARNING (MOTIR-2079)', () => {
  const advisory = (over: Partial<DispatchReferenceAdvisory> = {}): DispatchAdvisory => ({
    item: 'PROD-7',
    referenced: 'PROD-5',
    referencedStatus: 'in_review',
    severity: 'likely-missing-edge',
    ...over,
  });

  /** The SHAPE family (MOTIR-2175) — no referenced item anywhere in it. */
  const shapeAdvisory = (over: Partial<DispatchOrderingAdvisory> = {}): DispatchAdvisory => ({
    kind: 'shape',
    item: 'PROD-7',
    severity: 'likely-ordering-violation',
    phrase: 'once it lands',
    criterionIndex: 5,
    ...over,
  });

  /** The REPO-STRADDLE member of the same family (MOTIR-2177). */
  const straddleAdvisory = (
    over: Partial<DispatchRepoStraddleAdvisory> = {},
  ): DispatchAdvisory => ({
    kind: 'shape',
    item: 'PROD-7',
    severity: 'likely-repo-straddle',
    path: 'motir-ai/src/services/codeRepoService.ts',
    repo: 'motir-ai',
    reason: 'contradiction',
    criterionIndex: 3,
    ...over,
  });

  it('names each reference and its status, and says what to do about it', () => {
    const text = renderDispatchAdvisories(prompt({ advisories: [advisory()] })) as string;
    expect(text).toContain('PROD-5 (in_review)');
    expect(text).toContain('origin/main');
    expect(text).toContain('blocked_by');
  });

  it('is a WARNING, not a refusal — it says so, and returns a string rather than throwing', () => {
    const text = renderDispatchAdvisories(prompt({ advisories: [advisory()] })) as string;
    expect(text).toContain('NOT a blocker');
    // The contrast with `notReadyError`, which is the shape this deliberately is
    // not: that one is a thrown CliError offering `--force`.
    expect(text).not.toContain('--force');
  });

  it('lists EVERY reference, not just the first', () => {
    const text = renderDispatchAdvisories(
      prompt({
        advisories: [
          advisory({ referenced: 'PROD-5', referencedStatus: 'in_review' }),
          advisory({ referenced: 'PROD-9', referencedStatus: 'todo' }),
        ],
      }),
    ) as string;
    expect(text).toContain('PROD-5 (in_review)');
    expect(text).toContain('PROD-9 (todo)');
  });

  it('renders NOTHING when there is nothing to say — no empty heading', () => {
    expect(renderDispatchAdvisories(prompt({ advisories: [] }))).toBeNull();
  });

  it('treats an ABSENT field as nothing to say — an older server sends no key', () => {
    // Version skew is the normal case for a separately-published CLI: absent
    // must read as "no advisories", never as a crash.
    expect(renderDispatchAdvisories(prompt())).toBeNull();
  });

  it('renders a SHAPE advisory by its criterion and phrase — never as a bare reference', () => {
    // The regression this variant exists to prevent: mapping a shape entry
    // through the reference renderer prints "- undefined (undefined)".
    const text = renderDispatchAdvisories(prompt({ advisories: [shapeAdvisory()] })) as string;
    expect(text).toContain('criterion 5 says "once it lands"');
    expect(text).toContain('NOT a blocker');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('--force');
  });

  it('renders BOTH families together, each with its own remedy', () => {
    const text = renderDispatchAdvisories(
      prompt({ advisories: [shapeAdvisory(), advisory()] }),
    ) as string;
    expect(text).toContain('PROD-5 (in_review)');
    expect(text).toContain('criterion 5 says "once it lands"');
    expect(text).not.toContain('undefined');
  });

  it('renders a REPO-STRADDLE advisory by its criterion, PATH and repo (MOTIR-2177)', () => {
    const text = renderDispatchAdvisories(prompt({ advisories: [straddleAdvisory()] })) as string;
    expect(text).toContain('criterion 3 names motir-ai/src/services/codeRepoService.ts');
    expect(text).toContain('which lives in motir-ai');
    expect(text).toContain("not this card's pinned repo");
    expect(text).toContain('NOT a blocker');
    // The same regression the ordering variant guards: rendering a straddle
    // through the ORDERING branch would print `says "undefined"`.
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('--force');
  });

  it('says UNPINNABLE rather than "pinned repo" when the card pins nothing', () => {
    const text = renderDispatchAdvisories(
      prompt({ advisories: [straddleAdvisory({ reason: 'unpinnable' })] }),
    ) as string;
    expect(text).toContain('pins no repo while its criteria name more than one');
    expect(text).not.toContain("not this card's pinned repo");
  });

  it('renders BOTH shape members together — neither is swallowed by the other', () => {
    const text = renderDispatchAdvisories(
      prompt({ advisories: [shapeAdvisory(), straddleAdvisory()] }),
    ) as string;
    expect(text).toContain('criterion 5 says "once it lands"');
    expect(text).toContain('criterion 3 names motir-ai/src/services/codeRepoService.ts');
    expect(text).not.toContain('undefined');
  });

  /** The SUBSUMPTION family (MOTIR-2903) — a far end that is a PULL REQUEST. */
  const subsumptionAdvisory = (
    over: Partial<DispatchSubsumptionAdvisory> = {},
  ): DispatchAdvisory => ({
    kind: 'subsumption',
    item: 'PROD-7',
    severity: 'likely-already-shipped',
    path: 'lib/services/workflowsService.ts',
    pullRequest: 'moooon-B-V/motir-core#2059',
    pullRequestTitle: 'Bind the READ surface for motir_app',
    mergedAt: '2026-08-15T14:00:00.000Z',
    ...over,
  });

  it('renders a SUBSUMPTION advisory by its path and covering pull request (MOTIR-2903)', () => {
    const text = renderDispatchAdvisories(
      prompt({ advisories: [subsumptionAdvisory()] }),
    ) as string;
    expect(text).toContain('lib/services/workflowsService.ts');
    expect(text).toContain('moooon-B-V/motir-core#2059');
    expect(text).toContain('NOT a blocker');
    // The regression the positive reference filter exists to prevent: the old
    // `kind !== 'shape'` catch-all swept this into the REFERENCE renderer and
    // printed "- undefined (undefined)".
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('--force');
  });

  it('renders all THREE families together, each with its own remedy', () => {
    const text = renderDispatchAdvisories(
      prompt({
        advisories: [shapeAdvisory(), straddleAdvisory(), subsumptionAdvisory(), advisory()],
      }),
    ) as string;
    expect(text).toContain('PROD-5 (in_review)');
    expect(text).toContain('criterion 5 says "once it lands"');
    expect(text).toContain('criterion 3 names motir-ai/src/services/codeRepoService.ts');
    expect(text).toContain('moooon-B-V/motir-core#2059');
    expect(text).not.toContain('undefined');
  });

  it('prints NOTHING for a FAMILY this build has never heard of', () => {
    // The same version skew as the severity case below, one level up: a fourth
    // `kind` from a newer server must match NO filter — which is exactly what
    // the old catch-all failed to do when `subsumption` was that new family.
    const future = {
      kind: 'provenance',
      item: 'PROD-7',
      severity: 'likely-something-new',
    } as unknown as DispatchAdvisory;
    expect(renderDispatchAdvisories(prompt({ advisories: [future] }))).toBeNull();
  });

  it('prints NOTHING for a shape severity this build has never heard of', () => {
    // Version skew in the OTHER direction: a separately-published CLI pointed at
    // a NEWER Motir. Selecting by family alone would run the unknown entry
    // through the ordering renderer and print `says "undefined"`.
    const future = {
      kind: 'shape',
      item: 'PROD-7',
      severity: 'likely-something-new',
      criterionIndex: 2,
    } as unknown as DispatchAdvisory;
    expect(renderDispatchAdvisories(prompt({ advisories: [future] }))).toBeNull();
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
    expect(
      cwdReasonLabel(
        resolveDispatchTarget(ROOT, LINK, 'x', {
          exists: none,
          cloneUrl: 'https://github.com/moooon/x.git',
        }),
      ),
    ).toContain('cloned first');
    // ⚠️ This assertion CHANGED with MOTIR-3588, and the old text is the reason.
    // It used to read "the prompt creates it", which was false: both GIT
    // WORKFLOW variants open with `git worktree add`, which cannot run outside a
    // git repository. The label now names the one case that legitimately reaches
    // this outcome — a repository that does not exist ANYWHERE yet.
    expect(cwdReasonLabel(resolveDispatchTarget(ROOT, LINK, 'x', { exists: none }))).toContain(
      'does not exist yet; this card creates it',
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

// ─────────────────────────────────────────────────────────────────────────────
// PER-REPOSITORY resolution (Story MOTIR-2731 · MOTIR-3133)
// ─────────────────────────────────────────────────────────────────────────────
//
// The CLI is the only participant that knows where anything actually IS. The
// server knows a repository is called `motir-ai`; the prompt tells the agent to
// work in a sibling directory; and between those two facts sits a link config
// that can put that repository anywhere on the machine, or nowhere. The moment
// before the agent starts is the only cheap moment to find that out — everything
// after it is an agent failing in a directory that does not exist, or quietly
// doing one repository's half and reporting success.
//
// Two properties, and the second is the one that costs if it breaks:
//
//   * a set is resolved ELEMENT BY ELEMENT through the existing single-repo
//     rule, so the routing matrix is applied rather than re-derived;
//   * a card with fewer than two repositories renders EXACTLY today's summary —
//     every card in the tenant pins one, and none of them should be able to tell
//     that this shipped.

describe('resolveDispatchTargets — the routing matrix, applied per repository', () => {
  it('answers identically to the single-repo resolver, for every outcome', () => {
    // Not "looks the same": the same function, run both ways over the same
    // matrix, compared. A set-aware copy of the rule is the thing this avoids.
    const config: LinkConfig = { ...LINK, repos: { 'motir-ai': '/elsewhere/ai' } };
    const exists = only(`${ROOT}/motir-core`, '/elsewhere/ai');
    const repos = ['motir-core', 'motir-ai', 'motir-gateway'];

    const set = resolveDispatchTargets(ROOT, config, repos, { exists });

    expect(set).toEqual(repos.map((repo) => resolveDispatchTarget(ROOT, config, repo, { exists })));
    expect(set.map((t) => t.reason)).toEqual(['repo_checkout', 'repo_checkout', 'bootstrap_root']);
    expect(set.map((t) => t.repoSource)).toEqual(['convention', 'override', 'convention']);
  });

  it('preserves the payload ORDER — element 0 is the primary, and its cwd is the agent’s', () => {
    const exists = only(`${ROOT}/motir-ai`, `${ROOT}/motir-core`);
    const set = resolveDispatchTargets(ROOT, LINK, ['motir-ai', 'motir-core'], { exists });
    expect(set.map((t) => t.targetRepo)).toEqual(['motir-ai', 'motir-core']);
    expect(set[0]!.cwd).toBe(`${ROOT}/motir-ai`);
  });

  it('returns [] for an empty set — the shape an older server produces', () => {
    // Not a special case in the resolver, and deliberately so: the CALLER falls
    // back to the scalar, which is the single path a pre-MOTIR-3131 server and a
    // genuinely unpinned card both take.
    expect(resolveDispatchTargets(ROOT, LINK, [], { exists: none })).toEqual([]);
  });
});

describe('the REPOSITORIES block', () => {
  const twoRepos = (exists: (p: string) => boolean) =>
    resolveDispatchTargets(ROOT, LINK, ['motir-core', 'motir-ai'], { exists });

  it('renders nothing at all for zero or one repository', () => {
    expect(renderRepositoriesBlock([])).toEqual([]);
    expect(
      renderRepositoriesBlock(resolveDispatchTargets(ROOT, LINK, ['motir-core'], { exists: none })),
    ).toEqual([]);
  });

  it('leaves the one-repo and unpinned SUMMARY byte-identical to today’s', () => {
    // The back-compatibility claim, stated as an equality rather than intended:
    // `motir next --print | pbcopy` still pipes the prompt alone, and the
    // stderr summary a person sees for an ordinary card has not moved.
    const exists = only(`${ROOT}/motir-core`);
    const one = { key: 'PROD-7', title: 'A card', agent: null };
    const target = resolveDispatchTarget(ROOT, LINK, 'motir-core', { exists });
    expect(
      renderDispatchSummary({
        ...one,
        dispatch: prompt({
          targetRepos: [
            { name: 'motir-core', cloneUrl: null, defaultBranch: null, delivery: 'awaiting' },
          ],
        }),
        target,
        targets: resolveDispatchTargets(ROOT, LINK, ['motir-core'], { exists }),
      }),
    ).toBe(renderDispatchSummary({ ...one, dispatch: prompt(), target }));

    const unpinnedTarget = resolveDispatchTarget(ROOT, LINK, null, { exists });
    expect(
      renderDispatchSummary({
        ...one,
        dispatch: prompt({ targetRepo: null, targetRepos: [] }),
        target: unpinnedTarget,
        targets: [],
      }),
    ).toBe(
      renderDispatchSummary({
        ...one,
        dispatch: prompt({ targetRepo: null }),
        target: unpinnedTarget,
      }),
    );
  });

  it('names every repository, its resolved path, how it resolved, and which one is the cwd', () => {
    const block = renderRepositoriesBlock(twoRepos(only(`${ROOT}/motir-core`, `${ROOT}/motir-ai`)));
    const text = block.join('\n');
    expect(text).toContain('2 — this item ships in every one of them');
    expect(text).toContain('motir-core  (the working directory)');
    expect(text).toContain('motir-ai  (a sibling checkout)');
    expect(text).toContain(`${ROOT}/motir-core  (convention)`);
    expect(text).toContain(`${ROOT}/motir-ai  (convention)`);
  });

  it('WARNS about a missing checkout, names the expected path and the fix — and does not refuse', () => {
    // The disposition ADR §B6(a) records, and the one an operator can act on:
    // they are the ones who know whether that repository's half is already
    // merged, or whether their checkout simply lives somewhere else.
    const text = renderRepositoriesBlock(twoRepos(only(`${ROOT}/motir-core`))).join('\n');
    expect(text).toContain('no checkout here yet');
    expect(text).toContain('NOT a blocker');
    expect(text).toContain(`${ROOT}/motir-ai`);
    expect(text).toContain('motir link add motir-ai <path>');
  });
});

describe('the bootstrap post-condition, over the whole set', () => {
  it('reports a NON-PRIMARY repository whose checkout never appeared', () => {
    // The failure this catches is the quiet one: the agent exits 0 having done
    // the primary's half in a real checkout, and the second repository's work
    // never had anywhere to happen.
    const targets = resolveDispatchTargets(ROOT, LINK, ['motir-core', 'motir-ai'], {
      exists: only(`${ROOT}/motir-core`),
    });
    const suspects = targets.map((t) => checkBootstrapCheckout(t, { exists: none }));
    expect(suspects[0]).toBeNull();
    expect(suspects[1]?.repoName).toBe('motir-ai');
    expect(suspects[1]?.message).toContain('motir-ai');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT HAS SHIPPED, and what has not (Story MOTIR-2731 · MOTIR-3136)
// ─────────────────────────────────────────────────────────────────────────────
//
// A multi-repository card has a MIDDLE state and the CLI had no vocabulary for
// it: one repository's pull request has merged and the other's has not, the
// completion gate is holding the card — correctly — and every line the run
// printed was about a single repository. `renderAgentSuccess` said *"its pull
// request should be open"* and *"review + merge the PR, then `motir done`"*,
// which for that card is not merely incomplete: it reads as reassurance, at the
// exact moment the operator could still notice that half the work has no pull
// request at all.
//
// Everything here is a PURE renderer over the payload the run already fetched —
// no client, no clock, no second request.

/** A payload carrying N repositories with the given delivery states. */
function withRepos(...states: [string, string | null][]): DispatchPrompt {
  return prompt({
    targetRepo: states[0]?.[0] ?? null,
    targetRepos: states.map(([name, delivery]) => ({
      name,
      cloneUrl: null,
      defaultBranch: 'main',
      delivery,
    })),
  });
}

describe('the RESUME notice', () => {
  it('names a partially delivered card, what is done and what remains', () => {
    const notice = renderResumeNotice(
      withRepos(['motir-core', 'delivered'], ['motir-ai', 'awaiting']),
    );
    expect(notice).toContain('PARTIALLY DELIVERED');
    expect(notice).toContain('already delivered: motir-core');
    expect(notice).toContain('still outstanding: motir-ai');
    expect(notice).toContain(
      'Do not re-open a pull request in a repository that has already merged',
    );
  });

  it('prints NOTHING when nothing has delivered, when everything has, or for one repository', () => {
    // A fresh card and a finished one are both "not a resume" — the notice
    // exists to mark the middle, and a line that always prints marks nothing.
    expect(
      renderResumeNotice(withRepos(['motir-core', 'awaiting'], ['motir-ai', 'awaiting'])),
    ).toBeNull();
    expect(
      renderResumeNotice(withRepos(['motir-core', 'delivered'], ['motir-ai', 'delivered'])),
    ).toBeNull();
    expect(renderResumeNotice(withRepos(['motir-core', 'delivered']))).toBeNull();
    expect(renderResumeNotice(prompt())).toBeNull();
  });
});

describe('the delivery state on each repository line', () => {
  const targets = (n: number) =>
    resolveDispatchTargets(ROOT, LINK, ['motir-core', 'motir-ai'].slice(0, n), { exists: none });

  it('distinguishes unestablished and excluded from awaiting — the reader’s next action differs', () => {
    // Not shades of one answer: `awaiting` points at the host, `unestablished`
    // at the project's establish step, and `excluded` says nothing is expected
    // there at all. Collapsing them is what produced a false "No pull request
    // yet" one level down.
    const text = renderRepositoriesBlock(targets(2), ['unestablished', 'excluded']).join('\n');
    expect(text).toContain('NOT ESTABLISHED');
    expect(text).toContain('does not exist yet');
    expect(text).toContain('excluded');
    expect(text).toContain('does not hold this card');
    expect(text).not.toContain('awaiting');
  });

  it('says a recorded merge whose branch is unknown is UNKNOWN, not delivered', () => {
    // `unknown` is not a lenient `delivered`: a merge whose base branch the
    // mirror never recorded does not prove the work reached the trunk, and
    // reading it as satisfied would complete a card on a stranded merge.
    const text = renderRepositoriesBlock(targets(2), ['unknown', 'awaiting']).join('\n');
    expect(text).toContain('a merge is recorded but not which branch it reached');
    expect(text).not.toContain('delivered');
  });

  it('renders an UNKNOWN state verbatim rather than mapping it onto a neighbour', () => {
    // The forward-compatibility rule the advisory renderer already follows: a
    // build that guesses is worse than one that admits.
    expect(renderRepositoriesBlock(targets(2), ['delivered', 'teleported']).join('\n')).toContain(
      'teleported',
    );
  });

  it('says nothing at all when the state is null — the repository the card does not carry', () => {
    expect(renderRepositoriesBlock(targets(2), [null, null]).join('\n')).not.toContain('awaiting');
  });
});

describe('renderAgentSuccess for a card that ships in more than one repository', () => {
  const success = () =>
    renderAgentSuccess('PROD-7', withRepos(['motir-core', 'delivered'], ['motir-ai', 'awaiting']));

  it('names every repository and says the card completes only when EVERY one has merged', () => {
    const text = success();
    expect(text).toContain('a pull request is expected in EACH of its 2 repositories');
    expect(text).toContain('motir-core');
    expect(text).toContain('motir-ai');
    expect(text).toContain("EVERY\nrepository's pull request has merged");
  });

  it('does NOT claim the card is finished, and drops the singular follow-up', () => {
    // `motir done PROD-7` on a card the completion gate is holding is an
    // instruction that cannot succeed, which is worse than no instruction.
    const text = success();
    expect(text).not.toContain('its pull request should be open');
    expect(text).not.toContain('motir done PROD-7');
    expect(text).not.toContain('(now In Review)');
  });

  it('calls out an UNESTABLISHED repository as a stopper, in its own words', () => {
    const text = renderAgentSuccess(
      'PROD-7',
      withRepos(['motir-core', 'awaiting'], ['motir-ai', 'unestablished']),
    );
    expect(text).toContain('cannot be delivered yet');
    expect(text).toContain('Establish it on the project');
  });

  it('is byte-identical to today’s for a one-repository card and an unpinned one', () => {
    expect(renderAgentSuccess('PROD-7', withRepos(['motir-core', 'awaiting']))).toBe(
      renderAgentSuccess('PROD-7', prompt()),
    );
    expect(renderAgentSuccess('PROD-7', prompt({ targetRepo: null, targetRepos: [] }))).toBe(
      renderAgentSuccess('PROD-7', prompt({ targetRepo: null })),
    );
  });

  it('carries the multi-repository form into SESSION LINEAGE too', () => {
    const text = renderAgentSuccess(
      'PROD-7',
      withRepos(['motir-core', 'awaiting'], ['motir-ai', 'awaiting']),
    );
    const lineage = renderAgentSuccess('PROD-7', {
      ...withRepos(['motir-core', 'awaiting'], ['motir-ai', 'awaiting']),
      workflowMode: 'session_lineage',
      sessionBranch: 'motir/auto-1',
    });
    expect(lineage).toContain('in 2');
    expect(lineage).toContain('review + merge the session PR in EACH of them');
    expect(lineage).not.toBe(text);
  });
});

describe('renderAgentFailure names how wide the half-done work is', () => {
  it('adds the repositories, and changes no part of the policy', () => {
    const text = renderAgentFailure(
      'PROD-7',
      3,
      withRepos(['motir-core', 'awaiting'], ['motir-ai', 'awaiting']),
    );
    expect(text).toContain('stays In Progress (nothing was reverted)');
    expect(text).toContain('motir run PROD-7');
    expect(text).toContain('ships in 2 repositories (motir-core, motir-ai)');
    expect(text).toContain('more than one checkout');
  });

  it('is byte-identical to today’s with no payload, and for a one-repository card', () => {
    expect(renderAgentFailure('PROD-7', 3)).toBe(
      renderAgentFailure('PROD-7', 3, withRepos(['motir-core', 'awaiting'])),
    );
  });
});

describe('the submitted RE-PLAN read-back (MOTIR-3018)', () => {
  it('reports a card left at planning as a submitted re-plan', async () => {
    const client = { getWorkItem: async () => ({ item: { status: 'planning' } }) };
    await expect(agentSubmittedReplan(client, 'PROD-7')).resolves.toBe(true);
  });

  it.each(['in_progress', 'implemented', 'todo', 'in_review', 'done'])(
    'reports a card at %s as an ordinary outcome',
    async (status) => {
      const client = { getWorkItem: async () => ({ item: { status } }) };
      await expect(agentSubmittedReplan(client, 'PROD-7')).resolves.toBe(false);
    },
  );

  // ⚠️ A READ THAT FAILS SAYS NOTHING ABOUT THE STATUS. Answering `true` on a
  // transport error would park a card on the strength of a network blip; the
  // caller falls through to today's close-out instead, which then surfaces its
  // own error rather than swallowing two.
  it('answers false when the read itself fails, rather than guessing', async () => {
    const client = {
      getWorkItem: async () => {
        throw new Error('ECONNRESET');
      },
    };
    await expect(agentSubmittedReplan(client, 'PROD-7')).resolves.toBe(false);
  });

  it('leads with the fact that this is a correct outcome, not a failure', () => {
    const text = renderReplanSubmitted('PROD-7');
    expect(text.split('\n')[0]).toContain('not a failure');
    expect(text).toContain('Planning');
    // It must not tell the operator to re-run the card as though it had broken —
    // the plan is what they act on next.
    expect(text).toContain('waiting for a human in Motir');
  });
});
