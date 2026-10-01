// MOTIR-7179 — the STATE-INK LEDGER: every site the design lane could not see
// until its CSS reader learned `@layer` and nesting, NAMED rather than hidden.
//
// ── Why this exists, and why it may only shrink ─────────────────────────────
// `tests/design-state-ink-contrast.test.ts` holds the state arm at ZERO findings
// and ZERO abstentions. That zero was measured through happy-dom, which drops
// every rule inside an `@layer` block and every nested rule — all of what
// compiled Tailwind emits. So 53 committed Tailwind-compiled mocks reached the
// arm with none of their `&:hover` rules, and read clean by construction.
// `flattenMockCss` (MOTIR-7179) lets the arm see them, and on `origin/main`
// @ `cd8f16440` it found what this file lists: 138 sub-AA findings in 8 assets,
// and 168 abstentions in 16. They were on `main` before the reader existed;
// the reader only made them visible.
//
// Each entry is one (asset, state selector, kind, reason) with the exact number
// of sites the scan produces for it. The gating spec subtracts these and holds
// the remainder at zero, so a NEW site still fails. And an entry whose count no
// longer matches fails as STALE — fewer sites means a fix landed and the entry
// must shrink with it; more means a regression the entry may not absorb. So the
// ledger cannot grow by accident, and it cannot outlive its subject.
//
// ── Who empties it ──────────────────────────────────────────────────────────
//   • the ABSTENTIONS — MOTIR-7184, which teaches the scanner the `color-mix()`
//     fallback pair and multi-state escaped Tailwind variants. A site it turns
//     into a measured FINDING moves to the findings half with the same format.
//   • the FINDINGS — MOTIR-7185, which swaps the muted ink in those assets and
//     then DELETES this file and the assertions that read it.
// Do not add an entry to make a new mock pass. A new mock's site is fixed in the
// mock, which is what the gating spec's failure message says how to do.

export interface StateInkLedgerEntry {
  /** Repo-relative path of the mock. */
  file: string;
  /** The interaction-state rule, exactly as `scanMockStateInk` reports it. */
  stateSelector: string;
  kind: 'finding' | 'abstention';
  /** A finding's `<ink> on <surface> at <ratio>:1`, or the abstention's reason verbatim. */
  reason: string;
  /** How many sites the scan reports for this key — exact, not a ceiling. */
  count: number;
}

export const STATE_INK_LEDGER: readonly StateInkLedgerEntry[] = [
  {
    file: 'design/ai-chat/planning-workspace--pick-seed.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 4,
  },
  {
    file: 'design/ai-planning/plan-folder-levels.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 10,
  },
  {
    file: 'design/ai-planning/plan-folder-placement.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 12,
  },
  {
    file: 'design/ai-planning/plan-review--live-drawing.mock.html',
    stateSelector: '.disabled\\:hover\\:bg-\\(--el-surface-soft\\):disabled:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".disabled\\\\\\\\:bg-\\\\(--el-surface-soft\\\\):disabled"',
    count: 1,
  },
  {
    file: 'design/ai-planning/plan-review--live-drawing.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 31,
  },
  {
    file: 'design/ai-planning/plan-review--surface-views.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 10,
  },
  {
    file: 'design/ai-planning/plan-review--surgical-edits.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 8,
  },
  {
    file: 'design/approvals/approvals-room.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 4,
  },
  {
    file: 'design/boards/approved-column.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 1,
  },
  {
    file: 'design/projects/public-page.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 11,
  },
  {
    file: 'design/shell/3d-immersive-shell.mock.html',
    stateSelector:
      '.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--el-accent\\)_16\\%\\,var\\(--el-build-bg\\)\\)\\]:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".hover\\\\:bg-\\\\[color-mix\\\\(in_srgb\\\\, var\\\\(--el-accent\\\\)_16\\\\%\\\\, var\\\\(--el-build-bg\\\\)\\\\)\\\\]"',
    count: 1,
  },
  {
    file: 'design/shell/3d-immersive-shell.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 18,
  },
  {
    file: 'design/shell/account-menu.mock.html',
    stateSelector:
      '.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--el-accent\\)_16\\%\\,var\\(--el-build-bg\\)\\)\\]:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".hover\\\\:bg-\\\\[color-mix\\\\(in_srgb\\\\, var\\\\(--el-accent\\\\)_16\\\\%\\\\, var\\\\(--el-build-bg\\\\)\\\\)\\\\]"',
    count: 1,
  },
  {
    file: 'design/shell/account-menu.mock.html',
    stateSelector:
      '.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--el-accent\\)_18\\%\\,var\\(--el-page-bg\\)\\)\\]:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".hover\\\\:bg-\\\\[color-mix\\\\(in_srgb\\\\, var\\\\(--el-accent\\\\)_18\\\\%\\\\, var\\\\(--el-page-bg\\\\)\\\\)\\\\]"',
    count: 1,
  },
  {
    file: 'design/shell/account-menu.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 7,
  },
  {
    file: 'design/shell/context-row.mock.html',
    stateSelector:
      '.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--el-accent\\)_16\\%\\,var\\(--el-build-bg\\)\\)\\]:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".hover\\\\:bg-\\\\[color-mix\\\\(in_srgb\\\\, var\\\\(--el-accent\\\\)_16\\\\%\\\\, var\\\\(--el-build-bg\\\\)\\\\)\\\\]"',
    count: 1,
  },
  {
    file: 'design/shell/context-row.mock.html',
    stateSelector:
      '.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--el-accent\\)_18\\%\\,var\\(--el-page-bg\\)\\)\\]:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".hover\\\\:bg-\\\\[color-mix\\\\(in_srgb\\\\, var\\\\(--el-accent\\\\)_18\\\\%\\\\, var\\\\(--el-page-bg\\\\)\\\\)\\\\]"',
    count: 1,
  },
  {
    file: 'design/shell/navigation-pending.mock.html',
    stateSelector:
      '.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--el-accent\\)_16\\%\\,var\\(--el-build-bg\\)\\)\\]:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".hover\\\\:bg-\\\\[color-mix\\\\(in_srgb\\\\, var\\\\(--el-accent\\\\)_16\\\\%\\\\, var\\\\(--el-build-bg\\\\)\\\\)\\\\]"',
    count: 1,
  },
  {
    file: 'design/shell/top-bar.mock.html',
    stateSelector:
      '.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--el-accent\\)_16\\%\\,var\\(--el-build-bg\\)\\)\\]:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".hover\\\\:bg-\\\\[color-mix\\\\(in_srgb\\\\, var\\\\(--el-accent\\\\)_16\\\\%\\\\, var\\\\(--el-build-bg\\\\)\\\\)\\\\]"',
    count: 1,
  },
  {
    file: 'design/shell/top-bar.mock.html',
    stateSelector:
      '.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--el-accent\\)_18\\%\\,var\\(--el-page-bg\\)\\)\\]:hover',
    kind: 'abstention',
    reason:
      'the engine could not match the base selector ".hover\\\\:bg-\\\\[color-mix\\\\(in_srgb\\\\, var\\\\(--el-accent\\\\)_18\\\\%\\\\, var\\\\(--el-page-bg\\\\)\\\\)\\\\]"',
    count: 1,
  },
  {
    file: 'design/work-items/decision-waiting.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 27,
  },
  {
    file: 'design/work-items/pending-plan-indicator.mock.html',
    stateSelector:
      ".rounded-\\(--radius-btn\\).border:not([role='group']):hover:not(:disabled), button.rounded-\\(--radius-input\\):hover:not(:disabled), [role='group'] [aria-pressed='false']:hover:not(:disabled)",
    kind: 'abstention',
    reason:
      'the state background "black" resolved to "black", which this scanner cannot read as a colour',
    count: 16,
  },
  {
    file: 'design/boards/implemented-column.mock.html',
    stateSelector: '.hover\\:bg-\\(--el-surface\\):hover',
    kind: 'finding',
    reason: '#787671 on #f6f5f4 at 4.17:1',
    count: 6,
  },
  {
    file: 'design/shell/3d-immersive-shell.mock.html',
    stateSelector: '.hover\\:bg-\\(--el-surface\\):hover',
    kind: 'finding',
    reason: '#787671 on #f6f5f4 at 4.17:1',
    count: 16,
  },
  {
    file: 'design/shell/account-menu.mock.html',
    stateSelector: '.hover\\:bg-\\(--el-surface\\):hover',
    kind: 'finding',
    reason: '#787671 on #f6f5f4 at 4.17:1',
    count: 12,
  },
  {
    file: 'design/shell/navigation-pending.mock.html',
    stateSelector: '.hover\\:bg-\\(--el-surface\\):hover',
    kind: 'finding',
    reason: '#787671 on #f6f5f4 at 4.17:1',
    count: 39,
  },
  {
    file: 'design/shell/top-bar.mock.html',
    stateSelector: '.hover\\:bg-\\(--el-surface\\):hover',
    kind: 'finding',
    reason: '#787671 on #f6f5f4 at 4.17:1',
    count: 40,
  },
  {
    file: 'design/work-items/child-panel-graph.mock.html',
    stateSelector: '.hover\\:bg-\\(--el-surface\\):hover',
    kind: 'finding',
    reason: '#787671 on #f6f5f4 at 4.17:1',
    count: 5,
  },
  {
    file: 'design/work-items/list--ci-badge.mock.html',
    stateSelector: '.hover\\:bg-\\(--el-surface\\):hover',
    kind: 'finding',
    reason: '#787671 on #f6f5f4 at 4.17:1',
    count: 10,
  },
  {
    file: 'design/workbench/approvals-row.mock.html',
    stateSelector: '.hover\\:bg-\\(--el-surface\\):hover',
    kind: 'finding',
    reason: '#787671 on #f6f5f4 at 4.17:1',
    count: 10,
  },
];
