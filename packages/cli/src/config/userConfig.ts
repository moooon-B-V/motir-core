import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// The USER config — the machine-global credential store. Lives at
// `~/.config/motir/config.json` (XDG-respecting), chmod 600, dir 700. This is
// the ONLY place the PAT is written; `.motir.json` (the project link) never
// holds a secret, so it can be committed.
//
// Keyed by server URL so one machine can hold tokens for several Motir servers
// (the linked project picks which server, and we look up its token here).
//
// The config home is resolved from `MOTIR_CONFIG_HOME` → `XDG_CONFIG_HOME` →
// `~/.config`. The env override is what the test suite (and the 7.9.5
// integration suite) point at a temp dir so they never touch a real home.

export interface StoredUser {
  id: string;
  name: string;
  email: string;
}

export interface StoredCredential {
  token: string;
  user?: StoredUser;
}

export interface UserConfig {
  /** server URL (normalized, no trailing slash) → credential */
  tokens: Record<string, StoredCredential>;
  /**
   * The coding agent Motir launches on your behalf — a full command line
   * (`claude --dangerously-skip-permissions`), because BYOK means the agent is
   * yours, not Motir's. Read by `motir doctor` (and the dispatch commands);
   * overridden per-run by `--agent` or `MOTIR_AGENT`. Never a credential — the
   * agent authenticates with its OWN key, which Motir never reads.
   */
  agentCommand?: string;
}

const EMPTY: UserConfig = { tokens: {} };

/** Strip a trailing slash so `https://x/` and `https://x` key the same entry. */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function configDir(): string {
  const base =
    process.env['MOTIR_CONFIG_HOME'] ||
    process.env['XDG_CONFIG_HOME'] ||
    join(homedir(), '.config');
  return join(base, 'motir');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function readUserConfig(): UserConfig {
  const path = configPath();
  if (!existsSync(path)) return { tokens: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UserConfig>;
    // Every known key is carried through — the config is rewritten wholesale on
    // login/logout, so a key dropped here would be ERASED by the next write.
    const config: UserConfig = { tokens: parsed.tokens ?? {} };
    if (typeof parsed.agentCommand === 'string') config.agentCommand = parsed.agentCommand;
    return config;
  } catch {
    // A corrupt file shouldn't wedge every command — treat it as empty; the
    // next `auth login` rewrites it cleanly.
    return { ...EMPTY, tokens: {} };
  }
}

export function writeUserConfig(config: UserConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode only applies on CREATE; chmod unconditionally so an
  // existing file is tightened too.
  chmodSync(path, 0o600);
}

export function getCredential(serverUrl: string): StoredCredential | undefined {
  return readUserConfig().tokens[normalizeServerUrl(serverUrl)];
}

export function setCredential(serverUrl: string, credential: StoredCredential): void {
  const config = readUserConfig();
  config.tokens[normalizeServerUrl(serverUrl)] = credential;
  writeUserConfig(config);
}

/** Remove a server's credential. Returns true if one was present. */
export function removeCredential(serverUrl: string): boolean {
  const config = readUserConfig();
  const key = normalizeServerUrl(serverUrl);
  if (!(key in config.tokens)) return false;
  delete config.tokens[key];
  writeUserConfig(config);
  return true;
}

/** The configured coding-agent command line, if the user set one. */
export function getAgentCommand(): string | undefined {
  const value = readUserConfig().agentCommand?.trim();
  return value ? value : undefined;
}

export function listServers(): string[] {
  return Object.keys(readUserConfig().tokens);
}

/** A display-only prefix of a PAT — never enough to reconstruct it. */
export function displayTokenPrefix(token: string): string {
  const head = token.slice(0, 14);
  return token.length > head.length ? `${head}…` : head;
}
