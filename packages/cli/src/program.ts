import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { authLogin, authLogout, authStatus } from './commands/auth.js';
import { linkAddCommand, linkCommand, linkRemoveCommand } from './commands/link.js';
import { openCommand, readyCommand, statusCommand } from './commands/read.js';
import { doctorCommand } from './commands/doctor.js';
import { doneCommand, nextCommand, runCommand } from './commands/dispatch.js';

// The command tree. 7.9.1 ships the scaffold + auth + link; the read commands
// (`ready` / `status` / `open`) are 7.9.2, single dispatch (`next` / `run` /
// `done`) is 7.9.3, and the loop (`auto` / `batch`) is 7.9.4+ — they register
// onto this same program as they land.
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('motir')
    .description(
      'Motir CLI — terminal dispatch of the work loop (an MCP client of the Motir server).',
    )
    .version(CLI_VERSION, '-v, --version', 'Print the CLI version.');

  // ── auth ──────────────────────────────────────────────────────────────────
  const auth = program.command('auth').description('Authenticate to a Motir server with a PAT.');
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
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--assignee <id>', 'Filter by assignee: a user id, "me", or "unassigned".')
    .option('--json', 'Emit the ready items as JSON.')
    .action(readyCommand);
  program
    .command('status')
    .description('Show the project pulse: ready / in-flight counts + the active sprint.')
    .option('--json', 'Emit the pulse as JSON.')
    .action(statusCommand);
  // ── doctor ────────────────────────────────────────────────────────────────
  program
    .command('doctor')
    .description(
      'Preflight your BYOK setup: auth, project link, agent binary, credential presence.',
    )
    .option('--agent <cmd>', 'Check THIS agent command instead of the configured one.')
    .option('--json', 'Emit the check results as JSON.')
    // Arity-1 wrapper: commander passes the Command as a second argument, which
    // must not land in `doctorCommand`'s injectable probe parameter.
    .action((opts) => doctorCommand(opts));

  program
    .command('open <key>')
    .description('Open a work item (e.g. PROD-7) in the browser; prints the URL.')
    .option('--print', 'Print the URL only; do not launch a browser.')
    .action(openCommand);

  // ── dispatch ───────────────────────────────────────────────────────────────
  // The prompt each of these delivers is generated SERVER-SIDE (dispatch_prompt)
  // and printed verbatim — the CLI never assembles prompt text.
  program
    .command('next')
    .description('Dispatch the next ready work item: claim it and deliver its prompt.')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--print', 'Print the prompt to stdout instead of launching an agent (default).')
    .option('--agent <cmd>', 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).')
    .option('--reset', 'Clear this project’s session exclude list before picking.')
    .action(nextCommand);
  program
    .command('run <key>')
    .description('Dispatch a SPECIFIC work item (e.g. PROD-7), ready or forced.')
    .option('--print', 'Print the prompt to stdout instead of launching an agent (default).')
    .option('--agent <cmd>', 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).')
    .option('--force', 'Dispatch even though the item is not ready (dependencies unmet).')
    .action(runCommand);
  program
    .command('done [key]')
    .description('Close out a merged item — or a whole merged session branch.')
    .option('--session <branch>', 'Bulk close-out: flip every item on this session branch.')
    .option('--via <status>', 'Move through this status first (e.g. in_review).')
    // Arity-2 wrapper: commander appends the Command object, which must not
    // land in `doneCommand`'s options parameter when `[key]` is omitted.
    .action((key: string | undefined, opts) => doneCommand(key, opts));

  return program;
}
