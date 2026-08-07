import {
  COMMAND_CATALOG,
  DEFAULT_SERVER_URL,
  HELP_GROUP,
  type CommandCatalogEntry,
} from '../../packages/cli/src/commandCatalog';
import cliManifest from '../../packages/cli/package.json';
import type { GuideBlock } from '@/lib/apiDocs/guide';

// The Motir CLI guide, AS DATA (Story MOTIR-2308 · Subtask MOTIR-2329 · design
// `design/cli-guide/`).
//
// ── What this page IS ───────────────────────────────────────────────────────
// It gets a stranger from `npm install -g @motir/cli` to ONE work item
// dispatched, and it stops there. `docs/cli.md` is 1,147 lines and stays the
// reference: the three run shapes, session-branch semantics, the failure policy,
// troubleshooting and every flag all live there, and the finish line hands off
// to it by name. ADR `public-api-conventions.md` Amendment 9 Q2 draws that line
// — *"a fact belongs on the published page when a reader needs it to make their
// FIRST successful run happen, AND a test can hold it true"* — and Amendment 12
// Q3 applies it here fact by fact.
//
// ── Why data, and why the table is DERIVED ──────────────────────────────────
// Same argument `guide.ts` and `sandbox.ts` record. This page's most likely
// failure is not being wrong the day it ships; it is being right that day and
// wrong three months later, which has already happened twice to this project's
// published documentation (MOTIR-2010, MOTIR-2131). So the command table is not
// typed here: it is DERIVED from `COMMAND_CATALOG`, the CLI's own record, at
// build time. A command added to the CLI appears on this page with **no edit to
// this file**, which is the property the whole story is buying.
//
// The same goes for the three other facts Amendment 12 Q3 allocates to
// derivation: the published package name (read off the CLI's own manifest, as
// `tests/components/ConnectCliPanel.test.tsx` already does rather than trusting
// memory), the default server, and every flag the procedure prints.
//
// ── The cross-package import — the SECOND permitted crossing ────────────────
// Amendment 9 Q3 permitted exactly one module under `app/` or `lib/` to import
// from `packages/cli/**`. Amendment 12 Q4 amends that to a named TWO-module
// allowlist — `lib/apiDocs/cli.ts` and `lib/apiDocs/sandbox.ts` — under the same
// invariants, which `tests/api-docs/sandbox-page.test.tsx` asserts as an exact
// array and `tests/api-docs/cli-story-gate.test.tsx` re-asserts in its final
// shape:
//
//   1. these two modules are the ONLY such importers — named, not patterned, so
//      a third crossing is a deliberate edit somebody has to justify in a diff;
//   2. each reaches a CLI module with NO dependency graph — `agentProfiles.ts`
//      imports only `node:path`, `commandCatalog.ts` imports nothing at all —
//      which is what keeps `commander` out of `next build`;
//   3. what each exports is plain serializable data, so a row may cross to a
//      client component.
//
// `packages/cli/package.json` is the one other thing reached here, and it is a
// JSON manifest: it has no imports to acquire, which is invariant 2 satisfied by
// construction rather than by assertion.
//
// The `@/*` alias is rooted at the app and cannot express a path outside it, so
// the relative climb is the honest spelling and is greppable as the seam.
//
// ── English, per ADR Amendment 4 Q4 / Amendment 12 Q5 ───────────────────────
// Long-form prose lives here rather than in `messages/*.json` for the reason
// `guide.ts` records: a catalog entry per paragraph makes a document unreadable
// to edit and puts shell commands inside a localization file. The page CHROME
// goes through the `apiDocs` next-intl namespace with en/zh parity. Command
// names, flags, the package name and the default server URL are English by the
// rule that keeps operation text English: they are strings a machine consumes.

/** The published package, read off the CLI's own manifest — never retyped. */
export const CLI_PACKAGE_NAME: string = cliManifest.name;

/** What the page tells a reader to run first. Derived, so it cannot name a
 *  package that was never published under that name. */
export const CLI_INSTALL_COMMAND = `npm install -g ${CLI_PACKAGE_NAME}`;

/** The hosted instance the CLI talks to unless told otherwise — the CLI's own
 *  constant, so the self-hosting note cannot cite a host the tool does not use. */
export { DEFAULT_SERVER_URL };

/** The Node floor, from the CLI's own `engines` field. */
export const CLI_NODE_REQUIREMENT: string = cliManifest.engines.node;

/**
 * One row of the command table, flattened for rendering.
 *
 * Every field is READ from `COMMAND_CATALOG`; none is authored here.
 * `invocation` is what a reader types — the path plus the argument signature the
 * CLI actually registers — so `motir run <key>` cannot print as `motir run`.
 */
export interface CliCommandRow {
  path: string;
  invocation: string;
  description: string;
}

/** One group of the table, in the CLI's own help-group order. */
export interface CliCommandGroup {
  /** The help-group constant, e.g. `SETUP COMMANDS:`. */
  group: string;
  /** The caption the table renders — the heading, lowercased and de-suffixed. */
  caption: string;
  rows: CliCommandRow[];
}

/**
 * The groups the table renders, in order.
 *
 * FOUR tables, one per help group, rather than one table with a repeated Group
 * column (design § "The command table"). It mirrors what `motir help` already
 * prints, so the published table and the tool's own overview teach the same
 * shape — and it removes the column that would have cost the most in the narrow
 * rendering, where every cell carries its column name as a label.
 */
const GROUP_ORDER: readonly { group: string; caption: string }[] = [
  { group: HELP_GROUP.setup, caption: 'setup' },
  { group: HELP_GROUP.read, caption: 'read' },
  { group: HELP_GROUP.workLoop, caption: 'work loop' },
  { group: HELP_GROUP.topics, caption: 'help' },
];

/** `motir auth status` renders under `auth`'s group — commander gives a
 *  subcommand no group of its own, and a reader looks for it under its parent. */
function groupOf(entry: CommandCatalogEntry): string | null {
  if (entry.helpGroup) return entry.helpGroup;
  const parentPath = entry.path.slice(0, entry.path.lastIndexOf(' '));
  const parent = COMMAND_CATALOG.find((candidate) => candidate.path === parentPath);
  return parent ? groupOf(parent) : null;
}

/** What a reader types: the path plus the registered argument signature. */
export function cliInvocation(entry: CommandCatalogEntry): string {
  return `motir ${entry.path}${entry.signature ? ` ${entry.signature}` : ''}`;
}

/**
 * The command table, derived. Catalog order is preserved because it is
 * REGISTRATION order, which is the order `motir help` renders — re-sorting here
 * would be a second opinion about the CLI's own list.
 */
export function cliCommandGroups(): CliCommandGroup[] {
  return GROUP_ORDER.map(({ group, caption }) => ({
    group,
    caption,
    rows: COMMAND_CATALOG.filter((entry) => groupOf(entry) === group).map((entry) => ({
      path: entry.path,
      invocation: cliInvocation(entry),
      description: entry.description,
    })),
  })).filter((groupRow) => groupRow.rows.length > 0);
}

/** Every command invocation the table prints — the truth test's haystack. */
export function cliCommandInvocations(): string[] {
  return cliCommandGroups().flatMap((group) => group.rows.map((row) => row.invocation));
}

/** One numbered step of the procedure. */
export interface CliStep {
  id: string;
  title: string;
  /**
   * The commands this step tells the reader to run, in the form the truth test
   * checks against `COMMAND_CATALOG` — so the page cannot instruct a command
   * that does not exist. Paths, not invocations: `auth status`, not
   * `motir auth status`.
   */
  cliCommands?: readonly string[];
  blocks: readonly GuideBlock[];
}

/** The one context section above the numbered steps. */
export const CLI_INTRO: readonly CliStep[] = [
  {
    id: 'before-you-start',
    title: 'Before you start',
    blocks: [
      {
        kind: 'prose',
        text: `A Motir account, and **Node ${CLI_NODE_REQUIREMENT}**. That is the list. You do not need a checkout of Motir itself, and you do not need to mint a token by hand — step 2 signs you in from the terminal.`,
      },
    ],
  },
];

/** The six numbered steps, in order. */
export const CLI_STEPS: readonly CliStep[] = [
  {
    id: 'install',
    title: 'Install',
    blocks: [
      {
        kind: 'prose',
        text: `Motir ships as a global npm package. \`pnpm add -g\` and \`yarn global add\` install the same thing. Runtime: **Node ${CLI_NODE_REQUIREMENT}**, ESM.`,
      },
      {
        kind: 'code',
        caption: 'install',
        code: `${CLI_INSTALL_COMMAND}\nmotir --help`,
        copyable: true,
      },
    ],
  },
  {
    id: 'sign-in',
    title: 'Sign in',
    cliCommands: ['login'],
    blocks: [
      {
        kind: 'prose',
        text: '`motir login` prints a short code, opens Motir in your browser, and waits for you to approve it there. Nothing has to exist on this machine first — no token to mint, no file to create.',
      },
      { kind: 'code', caption: 'sign in', code: 'motir login', copyable: true },
      {
        kind: 'callout',
        tone: 'info',
        text: 'No browser on this box — an SSH session, a container? The code and the URL are printed either way: open the URL on any device and enter the code. For an unattended agent set `MOTIR_TOKEN` instead, and there is no login step and no file at all.',
      },
    ],
  },
  {
    id: 'link',
    title: 'Link your workspace root',
    cliCommands: ['link'],
    blocks: [
      {
        kind: 'prose',
        text: 'Your **workspace root** is the folder your repo checkouts live under — a Motir project usually spans several repositories, and the work loop runs across all of them. Linking that folder writes a `.motir.json` there, and every command finds it by walking **upward**, so any command works from inside any checkout.',
      },
      {
        kind: 'code',
        caption: 'link',
        code: 'cd ~/work                  # the folder holding your checkouts\nmotir link --project ACME',
        copyable: true,
      },
      {
        kind: 'prose',
        text: 'If your workspace has exactly one project, `motir link` on its own is the whole step. `.motir.json` holds **no secret** — server, workspace, project — so it is safe to commit. An empty folder is first class: bind it and go, and the first scaffold work items create the checkouts themselves.',
      },
    ],
  },
  {
    id: 'check-it',
    title: 'Check it',
    cliCommands: ['doctor'],
    blocks: [
      {
        kind: 'prose',
        text: 'One read-only pass that answers *is my setup correct?* before a dispatch stops halfway through — your credential, the link, the project, your agent binary and its own sign-in.',
      },
      { kind: 'code', caption: 'preflight', code: 'motir doctor', copyable: true },
      {
        kind: 'prose',
        text: 'It exits non-zero when a hard check fails, so `motir doctor && motir auto` is a usable gate, and `--json` emits the same report machine-readably. **It never reads your secret:** the credential checks ask only whether a path exists or an env var is set.',
      },
    ],
  },
  {
    id: 'see-whats-ready',
    title: 'See what is ready',
    cliCommands: ['status', 'sprint', 'ready'],
    blocks: [
      {
        kind: 'prose',
        text: 'Get your bearings before you pick anything up: where the project stands, what the current sprint holds, and what can actually start right now.',
      },
      {
        kind: 'code',
        caption: 'read',
        code: 'motir status      # ready / in-flight counts + the active sprint\nmotir sprint      # the active sprint, and what blocks what\nmotir ready       # what can be picked up right now',
        copyable: true,
      },
      {
        kind: 'prose',
        text: '`motir sprint` and `motir ready` print dependency edges in their own columns, so you can see which item unblocks the most before choosing one.',
      },
    ],
  },
  {
    id: 'dispatch-one-item',
    title: 'Dispatch one item',
    cliCommands: ['show', 'next', 'done'],
    blocks: [
      {
        kind: 'prose',
        text: 'Read the card first. `motir show` gives you the whole thing — its fields, its readiness, its dependency edges and, for a story, its children in build order. That is where you notice the item assumes something that does not exist yet.',
      },
      {
        kind: 'code',
        caption: 'dispatch',
        code: 'motir show MOTIR-42       # the item you are about to hand an agent\nmotir next --print        # claim the top item, print its prompt',
        copyable: true,
      },
      {
        kind: 'prose',
        text: '`--print` writes the **prompt to stdout** and everything else — the repo, the resolved path, the workflow mode — to stderr, so `motir next --print | pbcopy` copies the prompt alone while you still see the context. Paste it into whatever agent you like. When its pull request is merged, close the item out:',
      },
      {
        kind: 'code',
        caption: 'close out',
        code: 'motir done --via in_review MOTIR-42',
        copyable: true,
      },
      {
        kind: 'callout',
        tone: 'info',
        text: 'Want Motir to launch the agent for you? `motir next --agent "<your agent command>"` runs it on the prompt, and `motir auto` drains the whole ready set unattended. Motir is **BYOK**: you bring your own agent and your own model key, and Motir never reads either.',
      },
    ],
  },
];

/** Where the CLI keeps things — the two files, and which one is a secret. */
export const CLI_FILES: readonly GuideBlock[] = [
  {
    kind: 'prose',
    text: 'Motir keeps exactly two files, and only one of them holds a secret.',
  },
  {
    kind: 'table',
    caption: 'files',
    columns: ['Path', 'What it holds'],
    columnWidths: ['w-[34%]', null],
    rows: [
      [
        '`~/.config/motir/config.json`',
        '**Secret — never commit.** The credential store, `chmod 600` inside a `0700` directory, keyed by server URL.',
      ],
      [
        '`.motir.json` (workspace root)',
        '**No secret — safe to commit.** The link: server, workspace, project, and the optional repo checkout-path overrides.',
      ],
    ],
  },
  {
    kind: 'prose',
    text: `The CLI talks to \`${DEFAULT_SERVER_URL}\` unless you tell it otherwise. **Self-hosting?** \`--server <url>\` beats everything on any command, and \`motir help environment\` prints the whole resolution ladder from the shipped code.`,
  },
];

/** The finish line: what to read next, and what each of them owns. */
export const CLI_WHAT_NEXT: readonly GuideBlock[] = [
  {
    kind: 'prose',
    text: 'You have a working CLI and one item dispatched. Three places to go from here, and each owns something this page deliberately does not.',
  },
  {
    kind: 'table',
    caption: 'hand-offs',
    columns: ['Read this', 'For'],
    columnWidths: ['w-[34%]', null],
    rows: [
      [
        '`docs/cli.md`',
        'The reference: every flag, the three run shapes, session branches, the failure policy, agent wiring, troubleshooting.',
      ],
      [
        'The **agent sandbox** guide',
        'Running an agent unattended inside a confined container, so a loop cannot reach the rest of your machine.',
      ],
      [
        'The **API reference**',
        'Driving Motir over HTTP instead of from a terminal — the same work loop, as `/api/v1`.',
      ],
    ],
  },
];
