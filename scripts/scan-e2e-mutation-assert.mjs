#!/usr/bin/env node
// Scan the Playwright suite for the UNGUARDED MUTATION→ASSERT shape — the
// defect class MOTIR-3694 (activity.spec.ts) and MOTIR-4496 (the link panel)
// are both instances of, and which CLAUDE.md § *E2E tests wait on the
// AUTHORITATIVE signal* forbids.
//
// ── What the shape IS ────────────────────────────────────────────────────────
//
//   await page.getByRole('button', { name: 'Add' }).click();   // a server WRITE
//   await expect(page.getByText('the new row')).toBeVisible(); // persisted state
//
// with no `waitForResponse` / `waitForURL` / `expect(...).toPass` armed for the
// write. Playwright's implicit auto-retry hides it locally and on a fast runner
// (the assertion's own 5 s budget usually covers the round trip); under CI load
// the write, the `router.refresh()` it triggers and React's reconcile no longer
// fit inside that budget, and the spec reds a PR that never touched it.
//
// ── What this script is, and is NOT ─────────────────────────────────────────
//
// It is a CANDIDATE finder. It cannot tell a server write from a client-only
// interaction, so it reports an UPPER BOUND and then cuts that bound down with
// predicates that are each named and counted (`--explain` prints the ladder).
// Every site that survives the ladder is triaged BY HAND into one of the four
// dispositions in `docs/e2e/mutation-assert-sweep.md`. A number this script
// prints is the input to that triage, never its output.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//
//   node scripts/scan-e2e-mutation-assert.mjs                 # kept sites, one per line
//   node scripts/scan-e2e-mutation-assert.mjs --explain       # the drop ladder, with counts
//   node scripts/scan-e2e-mutation-assert.mjs --crude         # the unfiltered upper bound
//   node scripts/scan-e2e-mutation-assert.mjs --ref origin/main   # read a REF, not the worktree
//   node scripts/scan-e2e-mutation-assert.mjs --json          # machine-readable
//
// ⚠️ Prefer `--ref`. A count taken from a working tree is a measurement of your
// own edits, not a property of the suite (the enumeration rule in `run.md`: a
// card COUNTING a population owes the ref the count was taken on).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const REF = value('ref');
const DIR = 'tests/e2e';

/** An action that could commit something. `.press` catches Enter-to-submit. */
const ACTION = /\.(click|press|setChecked|check|uncheck|selectOption)\(/;

/** How many lines after the action an assertion still counts as "straight after". */
const ASSERT_WINDOW = 4;

/**
 * Anything that makes the wait DETERMINISTIC rather than a retry budget.
 *
 * `toPass` is here deliberately: a block wrapped in `expect(...).toPass()` gets
 * a re-loop rather than one 5 s budget, which is a different (and adequate)
 * remedy — see `tests/e2e/_helpers/settle.ts`.
 */
const ARMED =
  /waitForResponse|waitForRequest|waitForURL|waitForLoadState|\.toPass\(|actionWrite|detailPageRefresh|expectSettledVisible|expect\.poll|waitForFunction|responsePromise|writePromise/;

/**
 * Accessible names that MUTATE. Read off the suite's own click targets, not
 * invented: these are the verbs a control carries when pressing it writes.
 */
const MUTATING_NAME =
  /\b(Save|Add|Create|New|Delete|Remove|Confirm|Update|Submit|Apply|Move|Archive|Restore|Assign|Unassign|Invite|Send|Publish|Approve|Reject|Decline|Enable|Disable|Start|Stop|Complete|Finish|Rename|Upload|Import|Link|Unlink|Watch|Unwatch|Duplicate|Convert|Revoke|Rotate|Generate|Accept|Withdraw|Transition|Reorder|Promote|Retire|Set\b|Change|Post|Reply|Edit|Resolve|Reopen|Merge|Install|Connect|Disconnect|Sign up|Sign in|Log in|Register|Subscribe|Upgrade|Downgrade|Cancel subscription)\b/i;

/**
 * The assertion reads something a CLIENT already knows — a dialog it just
 * opened, a menu, a toast, a disabled button, the control's own pressed state.
 * These cannot be this defect: nothing is waited on because nothing is fetched.
 *
 * The second arm matches a locator held in a LOCAL VARIABLE whose name says it
 * is an overlay (`const dialog = …`, `const peek = …`). Reading only the inline
 * `getByRole('dialog')` form misses most of the suite, which hoists the locator
 * out of the assertion.
 */
const CLIENT_ONLY_ASSERT =
  /getByRole\(\s*'(dialog|menu|menuitem|alertdialog|tooltip|tab|tabpanel)'|\bexpect\(\s*(dialog|modal|menu|popover|peek|drawer|sheet|confirmDialog|createDialog|editModal|editDialog)\b|toBeDisabled|toBeEnabled|toBeFocused|toBeChecked|toHaveAttribute\(\s*'aria-(expanded|pressed|selected)'|toBeHidden|not\.toBeVisible/;

/**
 * A NAVIGATION, not a write: clicking an anchor, or asserting the URL. The URL
 * lands with the navigation itself, so there is no repaint budget to overrun —
 * a different race with a different remedy (`waitForURL`), and not this one.
 */
const NAVIGATION = /getByRole\(\s*'link'|\.getByRole\('link'|toHaveURL/;

function listSpecs() {
  if (REF) {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', REF, '--', DIR], {
      encoding: 'utf8',
    });
    return out.split('\n').filter((p) => p.endsWith('.spec.ts'));
  }
  const out = execFileSync('git', ['ls-files', '--', DIR], { encoding: 'utf8' });
  return out.split('\n').filter((p) => p.endsWith('.spec.ts'));
}

function readSpec(path) {
  if (REF) {
    return execFileSync('git', ['show', `${REF}:${path}`], { encoding: 'utf8', maxBuffer: 32e6 });
  }
  return readFileSync(path, 'utf8');
}

/** The 1-based line the enclosing `test(` / `test.step(` block opens on. */
function enclosingTestStart(lines, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    if (/^\s*(test|test\.step)\s*[.(]/.test(lines[i]) || /^\s*(test|test\.step)\(/.test(lines[i])) {
      return i;
    }
  }
  return 0;
}

/**
 * The action's OWN statement — the line, plus the continuation lines prettier
 * wrapped it onto. Walking a fixed number of lines back instead reads a
 * NEIGHBOURING statement's verb and calls a link click a mutation.
 */
function actionStatement(lines, idx) {
  let start = idx;
  while (start > 0) {
    const prev = lines[start - 1].trimEnd();
    if (prev === '' || /[;{}]$/.test(prev) || /^\s*\/\//.test(prev)) break;
    start -= 1;
  }
  return lines.slice(start, idx + 1).join(' ');
}

const DROPS = [
  ['armed-in-window', 'a deterministic wait is armed in the ±window around the action'],
  ['armed-in-test', 'a deterministic wait is armed earlier in the SAME test block'],
  ['navigation', 'the action follows a link, or the assertion is on the URL — not a repaint'],
  ['non-mutating-action', 'the clicked control carries no mutating verb — it cannot write'],
  ['client-only-assert', 'the assertion reads client-only state (dialog / menu / aria / hidden)'],
  [
    'superseded-by-later-action',
    'a LATER action sits between this one and the assertion — only the last action before an assertion is the one it races',
  ],
];

function scan() {
  const specs = listSpecs();
  const crude = [];
  const dropped = Object.fromEntries(DROPS.map(([k]) => [k, 0]));
  const kept = [];

  for (const path of specs) {
    const lines = readSpec(path).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!ACTION.test(line)) continue;

      // The assertion that follows within the window.
      let assertAt = -1;
      for (let j = i + 1; j <= Math.min(i + ASSERT_WINDOW, lines.length - 1); j += 1) {
        if (/await\s+expect\(/.test(lines[j])) {
          assertAt = j;
          break;
        }
      }
      if (assertAt === -1) continue;

      const site = {
        file: path,
        line: i + 1,
        assertLine: assertAt + 1,
        action: line.trim(),
        assertion: lines[assertAt].trim(),
      };
      crude.push(site);

      // ── the drop ladder, in order; the FIRST predicate that fires owns it ──
      const window = lines
        .slice(Math.max(0, i - 6), Math.min(lines.length, assertAt + 3))
        .join('\n');
      if (ARMED.test(window)) {
        dropped['armed-in-window'] += 1;
        continue;
      }
      const testStart = enclosingTestStart(lines, i);
      if (ARMED.test(lines.slice(testStart, i).join('\n'))) {
        dropped['armed-in-test'] += 1;
        continue;
      }
      const actionText = actionStatement(lines, i);
      const assertText = lines.slice(assertAt, Math.min(lines.length, assertAt + 3)).join(' ');
      if (NAVIGATION.test(actionText) || NAVIGATION.test(assertText)) {
        dropped['navigation'] += 1;
        continue;
      }
      if (!MUTATING_NAME.test(actionText)) {
        dropped['non-mutating-action'] += 1;
        continue;
      }
      if (CLIENT_ONLY_ASSERT.test(assertText)) {
        dropped['client-only-assert'] += 1;
        continue;
      }
      // A later action between this one and the assertion means the assertion
      // races THAT action, not this one. Keeping both double-counts one site.
      let superseded = false;
      for (let j = i + 1; j < assertAt; j += 1) {
        if (ACTION.test(lines[j])) {
          superseded = true;
          break;
        }
      }
      if (superseded) {
        dropped['superseded-by-later-action'] += 1;
        continue;
      }
      kept.push(site);
    }
  }

  return { specs, crude, dropped, kept };
}

const { specs, crude, dropped, kept } = scan();
const at = REF ?? '(working tree)';

if (flag('json')) {
  console.log(
    JSON.stringify({ ref: at, specs: specs.length, crude: crude.length, dropped, kept }, null, 2),
  );
} else if (flag('crude')) {
  for (const s of crude) console.log(`${s.file}:${s.line}`);
  console.error(
    `\ncrude candidates: ${crude.length} across ${new Set(crude.map((s) => s.file)).size} files, in ${specs.length} specs at ${at}`,
  );
} else if (flag('explain')) {
  console.log(`ref:             ${at}`);
  console.log(`spec files:      ${specs.length}`);
  console.log(
    `crude candidates: ${crude.length}  across ${new Set(crude.map((s) => s.file)).size} files`,
  );
  console.log('\ndropped by predicate (first match owns the site):');
  for (const [key, why] of DROPS) {
    console.log(`  ${String(dropped[key]).padStart(4)}  ${key.padEnd(20)} ${why}`);
  }
  console.log(
    `\nKEPT for hand triage: ${kept.length}  across ${new Set(kept.map((s) => s.file)).size} files`,
  );
  const byFile = {};
  for (const s of kept) byFile[s.file] = (byFile[s.file] ?? 0) + 1;
  for (const [file, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${file}`);
  }
} else {
  for (const s of kept) console.log(`${s.file}:${s.line}\t${s.action}\t→ ${s.assertion}`);
  console.error(
    `\nkept: ${kept.length} of ${crude.length} crude candidates, in ${specs.length} specs at ${at}`,
  );
}
