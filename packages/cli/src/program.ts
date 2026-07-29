import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { authLogin, authLogout, authStatus } from './commands/auth.js';
import { linkAddCommand, linkCommand, linkRemoveCommand } from './commands/link.js';
import { openCommand, readyCommand, statusCommand } from './commands/read.js';
import { doctorCommand } from './commands/doctor.js';
import { doneCommand, nextCommand, runCommand } from './commands/dispatch.js';
import { autoCommand } from './commands/auto.js';
import { batchCommand } from './commands/batch.js';
import { HELP_GROUP, applyHelpConfiguration, registerHelpSurface } from './help.js';

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

  // ── auth ──────────────────────────────────────────────────────────────────
  const auth = program
    .command('auth')
    .description('Authenticate to a Motir server with a PAT.')
    .helpGroup(HELP_GROUP.setup);
  auth
    .command('login')
    .description('Validate and store a personal access token for a server.')
    .option('--server <url>', 'Server base URL, e.g. https://app.motir.co')
    .option('--token <pat>', 'Personal access token (or set MOTIR_TOKEN; prompted if omitted).')
    .action(authLogin);
  auth
    .command('status')
    .description('Show the resolved server, token prefix, and owning user.')
    .option('--server <url>', 'Server to report (defaults to the linked / single server).')
    .action(authStatus);
  auth
    .command('logout')
    .description('Remove the stored token for a server.')
    .option('--server <url>', 'Server to log out of (defaults to the linked / single server).')
    .action(authLogout);

  // ── link ───────────────────────────────────────────────────────────────────
  const link = program
    .command('link')
    .description('Bind this workspace-root folder to a server + workspace + project.')
    .helpGroup(HELP_GROUP.setup)
    .option('--server <url>', 'Server base URL (defaults to the existing link / single server).')
    .option('--workspace <slug>', 'Workspace slug (defaults to the token’s active workspace).')
    .option('--project <key>', 'Project key, e.g. PROD.')
    .option(
      '--repo <name>',
      'Mark THIS directory as a single repo’s checkout (writes a "." override).',
    )
    .action(linkCommand);
  link
    .command('add <repo> <path>')
    .description('Add a repo checkout-path override (relative to the link root, or absolute).')
    .action(linkAddCommand);
  link
    .command('remove <repo>')
    .description('Remove a repo checkout-path override.')
    .action(linkRemoveCommand);

  // ── read ───────────────────────────────────────────────────────────────────
  program
    .command('ready')
    .description('List the linked project’s ready set (every dependency satisfied).')
    .helpGroup(HELP_GROUP.read)
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--assignee <id>', 'Filter by assignee: a user id, "me", or "unassigned".')
    .option('--json', 'Emit the ready items as JSON.')
    .action(readyCommand);
  program
    .command('status')
    .description('Show the project pulse: ready / in-flight counts + the active sprint.')
    .helpGroup(HELP_GROUP.read)
    .option('--json', 'Emit the pulse as JSON.')
    .action(statusCommand);
  // ── doctor ────────────────────────────────────────────────────────────────
  program
    .command('doctor')
    .description(
      'Preflight your BYOK setup: auth, project link, agent binary, credential presence.',
    )
    .helpGroup(HELP_GROUP.setup)
    .option('--agent <cmd>', 'Check THIS agent command instead of the configured one.')
    .option('--json', 'Emit the check results as JSON.')
    // Arity-1 wrapper: commander passes the Command as a second argument, which
    // must not land in `doctorCommand`'s injectable probe parameter.
    .action((opts) => doctorCommand(opts));

  program
    .command('open <key>')
    .description('Open a work item (e.g. PROD-7) in the browser; prints the URL.')
    .helpGroup(HELP_GROUP.read)
    .option('--print', 'Print the URL only; do not launch a browser.')
    .action(openCommand);

  // ── dispatch (the work loop) ───────────────────────────────────────────────
  // The prompt each of these delivers is generated SERVER-SIDE (dispatch_prompt)
  // and printed verbatim — the CLI never assembles prompt text. These are the
  // first members of the reserved WORK LOOP group (`auto` / `batch` join them).
  program
    .command('next')
    .description('Dispatch the next ready work item: claim it and deliver its prompt.')
    .helpGroup(HELP_GROUP.workLoop)
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--print', 'Print the prompt to stdout instead of launching an agent (default).')
    .option('--agent <cmd>', 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).')
    .option('--reset', 'Clear this project’s session exclude list before picking.')
    .action(nextCommand);
  program
    .command('run <key>')
    .description('Dispatch a SPECIFIC work item (e.g. PROD-7), ready or forced.')
    .helpGroup(HELP_GROUP.workLoop)
    .option('--print', 'Print the prompt to stdout instead of launching an agent (default).')
    .option('--agent <cmd>', 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).')
    .option('--force', 'Dispatch even though the item is not ready (dependencies unmet).')
    .action(runCommand);
  program
    .command('auto')
    .description('Drain the ready set unattended: one item at a time onto a session branch.')
    .helpGroup(HELP_GROUP.workLoop)
    .option('--agent <cmd>', 'Run THIS agent command on every prompt (overrides MOTIR_AGENT).')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--max <n>', 'Stop after dispatching n work items.')
    .option('--keep-going', 'Continue past a failed agent instead of halting on the first one.')
    .option('--reset', 'Clear this project’s session exclude list before starting.')
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
  program
    .command('batch')
    .description('Implement a FROZEN snapshot of the ready set: one pull request per item.')
    .helpGroup(HELP_GROUP.workLoop)
    .option('--agent <cmd>', 'Run THIS agent command on every prompt (overrides MOTIR_AGENT).')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--max <n>', 'Stop after dispatching n work items.')
    .option('--keep-going', 'Continue past a failed agent instead of halting on the first one.')
    .option('--reset', 'Clear this project’s session exclude list before snapshotting.')
    // Arity-1 wrapper: commander appends the Command object, which must not land
    // in `batchCommand`'s injectable-deps parameter.
    .action((opts) => batchCommand(opts));
  program
    .command('done [key]')
    .description('Close out a merged item — or a whole merged session branch.')
    .helpGroup(HELP_GROUP.workLoop)
    .option('--session <branch>', 'Bulk close-out: flip every item on this session branch.')
    .option('--via <status>', 'Move through this status first (e.g. in_review).')
    // Arity-2 wrapper: commander appends the Command object, which must not
    // land in `doneCommand`'s options parameter when `[key]` is omitted.
    .action((key: string | undefined, opts) => doneCommand(key, opts));

  // After the real commands, so HELP TOPICS renders below them.
  registerHelpSurface(program);

  return program;
}
