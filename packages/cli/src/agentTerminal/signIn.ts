import { stat as fsStat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PROFILES, type AgentConfigHomeVar, type CredentialDirs } from '../agentProfiles.js';
import type { SignInState } from './protocol.js';

// The sign-in check (MOTIR-6938 · `docs/decisions/agent-terminal.md` Q7).
//
// ⚠️ IT STATS, IT NEVER OPENS. `agent-instances.md` §9 condition 4 forbids
// Motir to collect, store or intermediate a Claude.ai credential, so the check
// answers only whether the profile's credential FILE exists: `fs.stat` of each
// path from `agentProfiles.ts` `credentialPaths`, resolved in this process's
// own environment (the entrypoint gave it CLAUDE_CONFIG_DIR / CODEX_HOME) —
// or whether one of the profile's `credentialEnv` variables is SET. An API-key
// sign-in (ANTHROPIC_API_KEY, no credentials file) leaves nothing on disk, and
// reading it `signed_out` told a working agent to `/login` (MOTIR-7053). The
// variable is tested for presence only, the same predicate `motir doctor`
// uses; its value is never read.
//
//   signed_in   a credentialEnv variable is non-empty, or any path is a
//               regular file of non-zero size
//   signed_out  otherwise
//   unknown     the profile pins no path and no variable is set (kimi, aider,
//               goose, …), or there is no profile at all
//
// A DIRECTORY is never proof of a sign-in (MOTIR-4957), which is why the check
// is `isFile()`, not existence. The answer is `{ profile, state }` only — no
// path, no size, no time.

export interface SignInStatus {
  profile: string | null;
  state: SignInState;
}

/** `fs.stat`'s answer, narrowed to the two facts the check reads. */
export interface StatLike {
  isFile(): boolean;
  size: number;
}

export type StatFn = (path: string) => Promise<StatLike>;

/** The credential directories, from an environment (the same ladder `doctor` uses). */
export function credentialDirsFromEnv(
  env: NodeJS.ProcessEnv,
  home = env['HOME'] || homedir(),
): CredentialDirs {
  return {
    home,
    xdgConfigHome: env['XDG_CONFIG_HOME'] || join(home, '.config'),
    xdgDataHome: env['XDG_DATA_HOME'] || join(home, '.local', 'share'),
    configHome: (name: AgentConfigHomeVar) => env[name] || undefined,
  };
}

/** PRESENCE only: whether the variable is set and non-empty. */
function hasEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.length > 0;
}

export async function checkSignIn(
  env: NodeJS.ProcessEnv,
  stat: StatFn = fsStat,
): Promise<SignInStatus> {
  const id = env['MOTIR_SANDBOX_AGENT']?.trim() || null;
  const profile = id ? AGENT_PROFILES.find((candidate) => candidate.id === id) : undefined;
  if (!profile) return { profile: id, state: 'unknown' };
  if (profile.credentialEnv.some((name) => hasEnv(env, name))) {
    return { profile: id, state: 'signed_in' };
  }
  const paths = profile.credentialPaths(credentialDirsFromEnv(env));
  if (paths.length === 0) return { profile: id, state: 'unknown' };
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (info.isFile() && info.size > 0) return { profile: id, state: 'signed_in' };
    } catch {
      // Absent or unreadable: not proof of a sign-in. The error (which names
      // the path) is dropped, never logged.
    }
  }
  return { profile: id, state: 'signed_out' };
}
