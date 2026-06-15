import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { authLogin, authLogout, authStatus } from './commands/auth.js';
import { linkAddCommand, linkCommand, linkRemoveCommand } from './commands/link.js';

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

  return program;
}
