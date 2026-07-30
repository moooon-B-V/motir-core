import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { CliError } from './errors.js';
import { info } from './output.js';
import { isInteractive, promptLine } from './prompts.js';
import { findLink, writeLink, type LinkConfig } from './config/linkConfig.js';
import type { MotirClient, ProjectSummary } from './mcpClient.js';

// How the CLI RESOLVES a project, and the one place a link is written on the
// user's behalf (MOTIR-1880).
//
// Until `list_projects` (MOTIR-1879) there was nothing on the MCP surface that
// could enumerate projects, so `motir link` could only PROBE a key the user had
// already typed — which meant a workspace holding exactly ONE project still made
// its owner know and type that project's key. There is nothing to disambiguate
// in that case, so the CLI resolves it.
//
// ⚠️ THE CWD HAZARD is why the auto-link conditions below are not optional.
// `motir login` is MACHINE-GLOBAL (it writes `~/.config/motir/config.json`);
// a link is PER-FOLDER (`.motir.json`, resolved by walking UPWARD from cwd).
// Hanging one off the other means login writes a file into whatever directory
// the user happened to be standing in — and a `.motir.json` dropped in `$HOME`
// silently binds EVERY project beneath it, which is a genuinely bad day to
// debug. Hence: never overwrite an existing link, never write in `$HOME`, and
// always print the absolute path written plus how to change it.

/** A project the CLI chose, and HOW it chose it — the report has to say which,
 *  because "we picked the only one" and "you picked one of several" are
 *  different claims about what just happened. */
export interface ResolvedProject {
  project: ProjectSummary;
  /** True when it was the workspace's ONLY project (no choice was made). */
  sole: boolean;
}

/** How a resolved project is described in the line that reports the link. */
export function describeProject(resolved: ResolvedProject, workspace: string): string {
  const where = resolved.sole
    ? `the only project in workspace ${workspace}`
    : `in workspace ${workspace}`;
  return `${resolved.project.key} — ${resolved.project.name} (${where})`;
}

/** The `motir link` invocation to print as the next step, pre-filled when there
 *  is a key worth pre-filling. */
export function nextLinkCommand(projectKey?: string): string {
  return projectKey ? `motir link --project ${projectKey}` : 'motir link';
}

/**
 * Resolve the project to link when the user named none.
 *
 * Exactly one → that one, with no prompt: a question with a single possible
 * answer is a step, not a choice. Several → a numbered picker when there is a
 * TTY (they can be SHOWN the keys now, so making them type one is the old
 * behaviour with extra steps), and `--project` stays required without one.
 * None → a `CliError` naming where projects are created, never an empty link.
 */
export async function resolveProject(
  client: MotirClient,
  workspace: string,
  serverUrl: string,
): Promise<ResolvedProject> {
  const { projects } = await client.listProjects();

  if (projects.length === 0) {
    throw new CliError(`The workspace ${workspace} has no projects yet.`, {
      hint: `Create one at ${serverUrl}, then run \`${nextLinkCommand()}\` again.`,
    });
  }
  const only = projects[0];
  if (projects.length === 1 && only) return { project: only, sole: true };

  const keys = projects.map((p) => p.key);
  if (!isInteractive()) {
    throw new CliError(`The workspace ${workspace} has ${projects.length} projects.`, {
      hint: `Pass --project <key> — one of: ${keys.join(', ')}.`,
    });
  }

  info(`Projects in ${workspace}:`);
  projects.forEach((p, index) => info(`  ${index + 1}) ${p.key} — ${p.name}`));
  const answer = await promptLine(`Project [1-${projects.length}, or a key]`);
  const picked = pickProject(projects, answer);
  if (!picked) {
    throw new CliError(`"${answer}" is not one of this workspace’s projects.`, {
      hint: `Choose 1-${projects.length}, or pass --project <key> — one of: ${keys.join(', ')}.`,
    });
  }
  return { project: picked, sole: false };
}

/** Match a picker answer: a 1-based ORDINAL from the printed list, or a project
 *  key (case-insensitive, since keys are shown upper-case but typed however). */
export function pickProject(
  projects: ProjectSummary[],
  answer: string,
): ProjectSummary | undefined {
  const trimmed = answer.trim();
  if (/^\d+$/.test(trimmed)) return projects[Number(trimmed) - 1];
  return projects.find((p) => p.key.toLowerCase() === trimmed.toLowerCase());
}

export interface AutoLinkInput {
  serverUrl: string;
  workspace: string;
  /** Enumerate the token's projects. Injected so `motir login`'s own tests can
   *  drive every branch without standing up a second (MCP) server. */
  listProjects: () => Promise<ProjectSummary[]>;
  /** Overridden only by tests that must not depend on the runner's cwd/$HOME. */
  cwd?: string;
  home?: string;
}

/**
 * The `motir login` success hook: bind THIS folder when — and only when — doing
 * so is unambiguous, so the common case is genuinely one command.
 *
 * Every guard below is a case where writing would be a guess, and each ends by
 * printing the exact command the user would run instead. The link is never
 * silent either way: the path written, the project and the workspace go out on
 * one line, so a user who wanted a different root moves or deletes one file.
 *
 * A failure to enumerate is NOT a login failure — the credential is already
 * stored and valid. It degrades to the printed next step.
 */
export async function autoLinkAfterLogin(input: AutoLinkInput): Promise<string | null> {
  const cwd = resolve(input.cwd ?? process.cwd());
  const home = resolve(input.home ?? homedir());

  // A `.motir.json` that exists but does not PARSE throws here. That is still an
  // existing link as far as this step is concerned — the one thing it must never
  // do is overwrite a file the user put there, least of all one it could not read.
  let existing: ReturnType<typeof findLink>;
  try {
    existing = findLink(cwd);
  } catch {
    info(`Found a .motir.json that could not be read — leaving it alone.`);
    info(`Run \`${nextLinkCommand()}\` to rewrite it once it is fixed.`);
    return null;
  }
  if (existing) {
    info(
      `Already linked: ${existing.dir} → ${existing.config.workspace}/${existing.config.project}.`,
    );
    info(`Run \`${nextLinkCommand(existing.config.project)}\` here to change it.`);
    return null;
  }

  // `$HOME` is the one directory a link must never be created in unasked: the
  // upward walk would make it the fallback root for every project on the machine.
  if (cwd === home) {
    info(`Not linking your home directory — a link there would bind every folder under it.`);
    info(`cd to your workspace root and run \`${nextLinkCommand()}\`.`);
    return null;
  }

  let projects: ProjectSummary[];
  try {
    projects = await input.listProjects();
  } catch {
    info(`Run \`${nextLinkCommand()}\` in your workspace root to bind it to a project.`);
    return null;
  }

  const only = projects[0];
  if (projects.length !== 1 || !only) {
    if (projects.length === 0) {
      info(`No projects in workspace ${input.workspace} yet — create one at ${input.serverUrl},`);
      info(`then run \`${nextLinkCommand()}\` in your workspace root.`);
    } else {
      const keys = projects.map((p) => p.key).join(', ');
      info(`${projects.length} projects in workspace ${input.workspace}: ${keys}.`);
      info(`Run \`${nextLinkCommand('<key>')}\` in your workspace root to pick one.`);
    }
    return null;
  }

  const config: LinkConfig = {
    serverUrl: input.serverUrl,
    workspace: input.workspace,
    project: only.key,
  };
  let path: string;
  try {
    path = writeLink(cwd, config);
  } catch {
    // A read-only cwd (the sandbox's own posture for some mounts) is a supported
    // configuration, not a reason to fail a login that already succeeded.
    info(`Could not write a link in ${cwd}.`);
    info(`Run \`${nextLinkCommand(only.key)}\` from a writable workspace root.`);
    return null;
  }
  info(`Linked ${cwd} → ${describeProject({ project: only, sole: true }, input.workspace)}`);
  info(`Wrote ${path} — move or delete it to bind a different folder.`);
  return path;
}
