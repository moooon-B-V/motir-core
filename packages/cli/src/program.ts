import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { COMMAND_CATALOG, type CommandCatalogEntry } from './commandCatalog.js';
import { authLogin, authLogout, authStatus } from './commands/auth.js';
import { loginCommand } from './commands/login.js';
import { linkAddCommand, linkCommand, linkRemoveCommand } from './commands/link.js';
import {
  openCommand,
  readyCommand,
  showCommand,
  sprintCommand,
  sprintsCommand,
  statusCommand,
} from './commands/read.js';
import { doctorCommand } from './commands/doctor.js';
import { doneCommand, nextCommand, runCommand } from './commands/dispatch.js';
import { autoCommand } from './commands/auto.js';
import { batchCommand } from './commands/batch.js';
import { planCommand } from './commands/plan.js';
import { applyHelpConfiguration, registerHelpSurface } from './help.js';

// The command tree. 7.9.1 ships the scaffold + auth + link; the read commands
// (`ready` / `status` / `open`) are 7.9.2, single dispatch (`next` / `run` /
// `done`) is 7.9.3, and the loop (`auto` / `batch`) is 7.9.4+ — they register
// onto this same program as they land.
//
// Each command carries a `.helpGroup(...)` so it renders under a heading in the
// curated overview (help.ts). REGISTRATION ORDER IS THE RENDER ORDER — commander
// builds the group map in the order groups first appear in `program.commands` —
// so a new command joins its group by being registered next to its peers, or
// falls into ADDITIONAL COMMANDS if it declares none.
//
// ── Where a command's NAME, ARGUMENTS, DESCRIPTION and GROUP come from ───────
// Not from this file. They are declared once in `commandCatalog.ts` — a module
// that imports NOTHING — and `register()` below builds each command FROM that
// record, because `/docs/cli` publishes the same four facts to people with no
// checkout and a documentation page must not be a second place to state them
// (ADR `docs/decisions/public-api-conventions.md` Amendment 12 Q2; Subtask
// MOTIR-2324).
//
// What STAYS here: the options, the `.addHelpText(...)` bodies, and the
// actions. Options are PINNED rather than built-from — generating `.option(...)`
// calls from data would rewrite flag order, the negated-boolean spellings and
// the per-flag descriptions that `test/help.test.ts` pins as OUTPUT, for a
// failure `test/commandCatalog.test.ts` already catches at the moment it is
// introduced (it walks this tree and compares it to the record in both
// directions, options included).
const CATALOG_BY_PATH = new Map<string, CommandCatalogEntry>(
  COMMAND_CATALOG.map((entry) => [entry.path, entry]),
);

/**
 * Register `path`'s command on `parent`, taking its name, argument syntax,
 * description and help group from the catalog. The caller chains its options,
 * help text and action as before.
 *
 * A path with no entry THROWS rather than registering a nameless command: the
 * record is the source, so a command that is not in it is a bug in this file,
 * not a command the catalog is missing.
 */
function register(parent: Command, path: string): Command {
  const entry = CATALOG_BY_PATH.get(path);
  if (!entry) {
    throw new Error(
      `commandCatalog.ts has no entry for "${path}". Add one there — it is what ` +
        `both this program and the published /docs/cli table are built from.`,
    );
  }
  const name = path.slice(path.lastIndexOf(' ') + 1);
  const command = parent
    .command(entry.signature ? `${name} ${entry.signature}` : name)
    .description(entry.description);
  if (entry.helpGroup) command.helpGroup(entry.helpGroup);
  return command;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('motir')
    .description(
      'Motir CLI — terminal dispatch of the work loop (an MCP client of the Motir server).',
    )
    .version(CLI_VERSION, '-v, --version', 'Print the CLI version.');

  // Before ANY command is registered: commander applies the default command
  // group at registration time.
  applyHelpConfiguration(program);

  // ── login / logout ────────────────────────────────────────────────────────
  // Registered FIRST in the SETUP group because this is the command a person
  // reaches for: `motir login` is the interactive default (a device grant), and
  // `auth login --token` below stays for the token you already hold. The `auth`
  // subtree is unchanged — CI keeps its `--token` path and 7.9.1 keeps working.
  register(program, 'login')
    .option('--server <url>', 'Server base URL, e.g. https://app.motir.co')
    .option(
      '--no-browser',
      'Do not launch a browser — just print the code and the URL to open anywhere.',
    )
    .addHelpText(
      'after',
      [
        '',
        'No browser on this machine? The code and URL are printed either way, so an',
        'SSH session or a container uses this same command — open the URL on any',
        'device, sign in, and enter the code. For an unattended agent set MOTIR_TOKEN',
        'instead (`motir help environment`).',
      ].join('\n'),
    )
    // Arity-1 wrapper: commander appends the Command object, which must not land
    // in `loginCommand`'s injectable-deps parameter.
    .action((opts) => loginCommand(opts));
  register(program, 'logout')
    .option('--server <url>', 'Server to log out of (defaults to the linked / single server).')
    .addHelpText(
      'after',
      [
        '',
        'This removes the credential from THIS machine only. The server-side kill',
        'switch is revoking the token in Settings → Account → API tokens — a terminal',
        'connected by `motir login` appears there as `CLI · <hostname>`.',
      ].join('\n'),
    )
    .action(authLogout);

  // ── auth ──────────────────────────────────────────────────────────────────
  const auth = register(program, 'auth');
  register(auth, 'auth login')
    .option('--server <url>', 'Server base URL, e.g. https://app.motir.co')
    .option('--token <pat>', 'Personal access token (or set MOTIR_TOKEN; prompted if omitted).')
    .action(authLogin);
  register(auth, 'auth status')
    .option('--server <url>', 'Server to report (defaults to the linked / single server).')
    .action(authStatus);
  register(auth, 'auth logout')
    .option('--server <url>', 'Server to log out of (defaults to the linked / single server).')
    .action(authLogout);

  // ── link ───────────────────────────────────────────────────────────────────
  const link = register(program, 'link')
    .option('--server <url>', 'Server base URL (defaults to the existing link / single server).')
    .option('--workspace <slug>', 'Workspace slug (defaults to the token’s active workspace).')
    .option(
      '--project <key>',
      'Project key, e.g. PROD. Omit it and the workspace’s only project is used.',
    )
    .option(
      '--repo <name>',
      'Mark THIS directory as a single repo’s checkout (writes a "." override).',
    )
    .action(linkCommand);
  register(link, 'link add').action(linkAddCommand);
  register(link, 'link remove').action(linkRemoveCommand);

  // ── read ───────────────────────────────────────────────────────────────────
  register(program, 'ready')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--assignee <id>', 'Filter by assignee: a user id, "me", or "unassigned".')
    .option('--json', 'Emit the ready items as JSON.')
    .action(readyCommand);
  register(program, 'status').option('--json', 'Emit the pulse as JSON.').action(statusCommand);
  register(program, 'sprints')
    .option('--state <state>', 'Only sprints in this state: planned, active, or complete.')
    .option('--json', 'Emit the sprint rows as JSON.')
    .action(sprintsCommand);
  register(program, 'sprint')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--json', 'Emit the sprint and its items as JSON.')
    // Arity-2 wrapper: commander appends the Command object, which must not
    // land in `sprintCommand`'s options parameter when `[ref]` is omitted.
    .action((ref: string | undefined, opts) => sprintCommand(ref, opts));
  // The single-ITEM read, next to `open` (its browser twin) rather than among
  // the list reads above.
  register(program, 'show')
    .option('--json', 'Emit the get_work_item payload as JSON.')
    // The discussion is OPT-IN, on the detail view rather than in a command of
    // its own — the mirror product's shape (`gh issue view <n> --comments`), and
    // it keeps the default read to one tool call.
    .option('--activity', 'Also print the activity stream: comments and history, one page.')
    .option('--comments', 'Also print the comment threads only, one page.')
    .addHelpText(
      'after',
      [
        '',
        'ONE page of the stream is printed, never a drain loop: when more remains,',
        'the output says how much and points at `motir open <key>` for the rest.',
      ].join('\n'),
    )
    .action(showCommand);
  // ── doctor ────────────────────────────────────────────────────────────────
  register(program, 'doctor')
    .option('--agent <cmd>', 'Check THIS agent command instead of the configured one.')
    .option('--json', 'Emit the check results as JSON.')
    // Arity-1 wrapper: commander passes the Command as a second argument, which
    // must not land in `doctorCommand`'s injectable probe parameter.
    .action((opts) => doctorCommand(opts));

  register(program, 'open')
    .option('--print', 'Print the URL only; do not launch a browser.')
    .action(openCommand);

  // ── dispatch (the work loop) ───────────────────────────────────────────────
  // The prompt each of these delivers is generated SERVER-SIDE (dispatch_prompt)
  // and printed verbatim — the CLI never assembles prompt text. These are the
  // first members of the reserved WORK LOOP group (`auto` / `batch` join them).
  register(program, 'next')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--print', 'Print the prompt to stdout instead of launching an agent (default).')
    .option('--agent <cmd>', 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).')
    .option('--reset', 'Clear this project’s session exclude list before picking.')
    .action(nextCommand);
  register(program, 'run')
    .option('--print', 'Print the prompt to stdout instead of launching an agent (default).')
    .option('--agent <cmd>', 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).')
    .option('--force', 'Dispatch even though the item is not ready (dependencies unmet).')
    .action(runCommand);
  register(program, 'auto')
    .option('--agent <cmd>', 'Run THIS agent command on every prompt (overrides MOTIR_AGENT).')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--max <n>', 'Stop after dispatching n work items.')
    .option('--keep-going', 'Continue past a failed agent instead of halting on the first one.')
    .option('--reset', 'Clear this project’s session exclude list before starting.')
    .option(
      '--include-planning',
      'Trigger an AI expansion for each unexpanded epic/story instead of skipping it. Never waits: the plan needs your approval.',
    )
    // Registered PRECISELY so it can be refused properly (MOTIR-1828). `auto`
    // does not support `--print`, but leaving the flag unregistered made
    // commander reject it first with a generic `unknown option '--print'` —
    // which told the user nothing and made `autoCommand`'s own guard, the one
    // carrying the "use `motir next --print` instead" hint, unreachable from the
    // command line. A rejected flag with guidance beats an unknown flag.
    .option('--print', 'Not supported — an unattended loop has nobody to paste a prompt.')
    // Arity-1 wrapper: commander appends the Command object, which must not land
    // in `autoCommand`'s injectable-deps parameter.
    .action((opts) => autoCommand(opts));
  register(program, 'batch')
    .option('--agent <cmd>', 'Run THIS agent command on every prompt (overrides MOTIR_AGENT).')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--max <n>', 'Stop after dispatching n work items.')
    .option('--keep-going', 'Continue past a failed agent instead of halting on the first one.')
    .option('--reset', 'Clear this project’s session exclude list before snapshotting.')
    // Registered PRECISELY so it can be refused properly — the same reason as
    // `auto` above (MOTIR-1828, missed on this command until MOTIR-1830). The
    // rule the two share: a command whose module GUARDS a flag must REGISTER
    // that flag, or commander rejects it first and the guard is dead code from
    // the command line. `test/optionRegistrationAudit.test.ts` now enforces it
    // across every command, so this cannot go unswept a third time.
    .option('--print', 'Not supported — a frozen snapshot has nobody to paste a prompt.')
    // Arity-1 wrapper: commander appends the Command object, which must not land
    // in `batchCommand`'s injectable-deps parameter.
    .action((opts) => batchCommand(opts));
  // The planning front door. NOT a dispatch command: it changes the PLAN (a
  // conversation whose submit produces proposals awaiting approval in Motir),
  // which is why it sits at the end of the work-loop group rather than among
  // `next` / `run` / `auto`.
  register(program, 'plan')
    .option('--detach', 'Submit and return with the job/plan ids; do not wait for the planner.')
    .addHelpText(
      'after',
      [
        '',
        'Leading MOTIR-<n> arguments ANCHOR the conversation at those items; the rest is a turn.',
        '',
        '  $ motir plan                       # resume the project-wide conversation',
        '  $ motir plan MOTIR-42              # resume the conversation anchored at MOTIR-42',
        '  $ motir plan "split the billing epic"   # one turn, submitted, proposals printed',
        '  $ motir plan MOTIR-42 "size these" --detach',
        '',
        'In the conversation: /submit sends every turn as ONE change, /exit leaves it saved.',
        'A submit produces PROPOSALS — approving the plan in Motir is what creates work items.',
      ].join('\n'),
    )
    // Arity-2 wrapper: commander appends the Command object, which must not land
    // in `planCommand`'s injectable-deps parameter.
    .action((args: string[], opts) => planCommand(args, opts));
  register(program, 'done')
    .option('--session <branch>', 'Bulk close-out: flip every item on this session branch.')
    .option('--via <status>', 'Move through this status first (e.g. in_review).')
    // Arity-2 wrapper: commander appends the Command object, which must not
    // land in `doneCommand`'s options parameter when `[key]` is omitted.
    .action((key: string | undefined, opts) => doneCommand(key, opts));

  // After the real commands, so HELP TOPICS renders below them.
  registerHelpSurface(program);

  return program;
}
