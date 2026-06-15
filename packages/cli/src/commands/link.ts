import { MotirClient } from '../mcpClient.js';
import { CliError } from '../errors.js';
import { info, out } from '../output.js';
import { isInteractive, promptLine } from '../prompts.js';
import { resolveServerUrl } from '../serverResolve.js';
import { getCredential } from '../config/userConfig.js';
import {
  findLink,
  overrideRepoNames,
  requireLink,
  resolveRepo,
  withRepoOverride,
  withoutRepoOverride,
  writeLink,
  type LinkConfig,
} from '../config/linkConfig.js';

// `motir link` — bind a WORKSPACE ROOT directory to a server + workspace +
// project. Repo checkouts resolve by CONVENTION (`<root>/<repoName>`); the
// optional `repos` map carries overrides only. The file holds NO secret (safe
// to commit); the token stays in the user config.

export interface LinkOptions {
  server?: string;
  workspace?: string;
  project?: string;
  /** Mark this very directory as a single repo's checkout → `{ <repo>: "." }`. */
  repo?: string;
}

/** Get the token for `serverUrl` or fail with the standard login hint. */
function tokenFor(serverUrl: string): string {
  const cred = getCredential(serverUrl);
  if (!cred) {
    throw new CliError(`Not logged in to ${serverUrl}.`, { hint: 'Run `motir auth login` first.' });
  }
  return cred.token;
}

/** Confirm a project exists / is accessible under the token's workspace by
 * probing `list_ready` (an empty result is a valid empty project; a not-found
 * surfaces as the tool error). */
async function assertProjectAccessible(client: MotirClient, projectKey: string): Promise<void> {
  try {
    await client.listReady({ projectKey, limit: 1 });
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(`Project "${projectKey}" is not accessible with this token.`, {
        hint: 'Check the project key, or your token’s workspace.',
      });
    }
    throw err;
  }
}

export async function linkCommand(opts: LinkOptions): Promise<void> {
  const cwd = process.cwd();
  const existing = findLink(cwd);

  // Bare re-run on an existing link with no binding flags → SHOW it.
  const noBindingFlags = !opts.server && !opts.workspace && !opts.project && !opts.repo;
  if (existing && noBindingFlags) {
    showLink(existing.dir, existing.config);
    return;
  }

  const serverUrl = resolveServerUrl(opts.server ?? existing?.config.serverUrl);
  const token = tokenFor(serverUrl);

  const client = new MotirClient({ serverUrl, token });
  try {
    await client.connect();
    const who = await client.whoami();

    // Workspace: today the PAT is bound to one active workspace (lib/mcp/auth),
    // so default to it. An explicit flag (or a prior binding) wins as the label.
    const workspace = opts.workspace ?? existing?.config.workspace ?? who.workspace?.slug;
    if (!workspace) {
      throw new CliError('Could not determine the workspace.', {
        hint: 'Pass --workspace <slug>.',
      });
    }

    let project = opts.project ?? existing?.config.project;
    if (!project) {
      if (!isInteractive()) {
        throw new CliError('No project given.', { hint: 'Pass --project <key>.' });
      }
      project = await promptLine('Project key');
    }
    if (!project) throw new CliError('A project key is required.');

    await assertProjectAccessible(client, project);

    // Build the config, preserving any existing repo overrides; `--repo` marks
    // this root as that single repo's checkout (the single-repo "." override).
    const config: LinkConfig = {
      serverUrl,
      workspace,
      project,
      ...(existing?.config.repos ? { repos: { ...existing.config.repos } } : {}),
    };
    const withRepo = opts.repo ? withRepoOverride(config, opts.repo, '.') : config;

    // Edit the found link in place, else create one at the cwd.
    const targetDir = existing?.dir ?? cwd;
    const path = writeLink(targetDir, withRepo);
    info(`Linked ${targetDir} → ${workspace}/${project} on ${serverUrl}`);
    info(`Wrote ${path}`);
    showLink(targetDir, withRepo);
  } finally {
    await client.close();
  }
}

export function linkAddCommand(repo: string, path: string): void {
  const found = requireLink();
  const next = withRepoOverride(found.config, repo, path);
  writeLink(found.dir, next);
  info(`Override set: ${repo} → ${path}`);
  showLink(found.dir, next);
}

export function linkRemoveCommand(repo: string): void {
  const found = requireLink();
  let next: LinkConfig;
  try {
    next = withoutRepoOverride(found.config, repo);
  } catch {
    throw new CliError(`No override for repo "${repo}".`);
  }
  writeLink(found.dir, next);
  info(`Override removed: ${repo}`);
  showLink(found.dir, next);
}

/** Print the binding + how each KNOWN repo (override entries) resolves. Repos
 * without an override resolve by the convention `<root>/<repoName>`. */
function showLink(rootDir: string, config: LinkConfig): void {
  out(`Root:      ${rootDir}`);
  out(`Server:    ${config.serverUrl}`);
  out(`Workspace: ${config.workspace}`);
  out(`Project:   ${config.project}`);
  const names = overrideRepoNames(config);
  if (names.length === 0) {
    out('Repos:     (none listed) — checkouts resolve by convention <root>/<repoName>');
    return;
  }
  out('Repos:');
  for (const name of names) {
    const r = resolveRepo(rootDir, config, name);
    const state = r.exists ? 'exists' : 'not yet';
    out(`  ${name} → ${r.path}  [${r.source}, ${state}]`);
  }
}
