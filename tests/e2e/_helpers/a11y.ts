// Shared axe-core helpers for the a11y sweeps (Subtask 1.5.5 and its
// Epic-2-7 extensions). Extracted from the original single shell-a11y.spec.ts
// when that file was split into shell-a11y / shell-a11y-tokens /
// shell-a11y-detail so Playwright's file-level sharding can spread the heavy
// axe sweeps across CI legs instead of pinning all 16 into one shard.

// WCAG 2.1 Level A + AA — the ruleset the AC names. Scoped explicitly rather
// than relying on axe's defaults so the bar can't silently shift under us when
// the axe-core version bumps.
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: unknown[] }[];
}

// Render axe violations as a readable block so a CI failure points straight at
// the rule + element instead of a wall of JSON.
export function formatViolations(route: string, violations: AxeViolation[]): string {
  const lines = violations.map((v) => {
    const selectors = v.nodes.map((n) => `      - ${JSON.stringify(n.target)}`).join('\n');
    return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${selectors}`;
  });
  return `axe found ${violations.length} violation(s) on ${route}:\n${lines.join('\n')}`;
}
