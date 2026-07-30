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

/**
 * The STATE home — mutable, non-secret CLI state (the session exclude list).
 * Separate from `configDir()` because the two have opposite write requirements:
 * the config dir holds ONE secret the CLI reads and, in the sandbox, is mounted
 * READ-ONLY on purpose (the container consumes a credential and never mints
 * one). State that lived beside it therefore had no writable home at all —
 * which crashed unattended runs (MOTIR-1836).
 *
 * The chain is `MOTIR_STATE_HOME` → `MOTIR_CONFIG_HOME` → `XDG_STATE_HOME` →
 * `~/.local/state`. `MOTIR_CONFIG_HOME` sits ABOVE the XDG variable so the
 * "one relocation moves the whole CLI state" property the exclude list was
 * built on still holds — that is what keeps the test suite (which points only
 * `MOTIR_CONFIG_HOME` at a temp dir) off a real home, and it means an existing
 * user's relocated state stays exactly where it already is.
 */
export function stateDir(): string {
  const base =
    process.env['MOTIR_STATE_HOME'] ||
    process.env['MOTIR_CONFIG_HOME'] ||
    process.env['XDG_STATE_HOME'] ||
    join(homedir(), '.local', 'state');
  return join(base, 'motir');
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

// ── the env tier ────────────────────────────────────────────────────────────
//
// `MOTIR_TOKEN` / `MOTIR_SERVER` are the CI / container / ephemeral-box tier —
// `GH_TOKEN` / `GH_HOST` one-for-one. They are read by EVERY command, not just
// `auth login`, which is what gives a machine that never ran a login a route in
// at all: the sandbox mounts the config dir READ-ONLY on purpose (it consumes a
// credential, it never mints one), and a CI runner has no home to write to.
//
// An env credential is deliberately NEVER persisted — no `setCredential`, no
// config file created, nothing to clean up afterwards. That is what makes it
// work on a read-only mount, and it is why `resolveCredential` is a pure read.

/** The env var names of the credential tier, in the order they are consulted. */
export const TOKEN_ENV_VAR = 'MOTIR_TOKEN';
export const SERVER_ENV_VAR = 'MOTIR_SERVER';

/**
 * Read an env var as a VALUE, treating empty/whitespace as ABSENT.
 *
 * The empty-string case is load-bearing, not defensive tidiness: `FOO=` in a
 * compose file, a CI secret that did not resolve, and an unset-by-blanking shell
 * export all arrive as `''`, and taking that as a token turns "no credential" into
 * a 401 far from its cause. `gh` shipped exactly that bug (cli/cli#7800) — an
 * empty `GH_TOKEN` beat a perfectly good stored credential — so we treat it as
 * unset here, at the single read point, rather than at each call site.
 */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** `MOTIR_TOKEN`, or undefined when unset / empty. */
export function envToken(): string | undefined {
  return envValue(TOKEN_ENV_VAR);
}

/** `MOTIR_SERVER`, normalized, or undefined when unset / empty. */
export function envServerUrl(): string | undefined {
  const value = envValue(SERVER_ENV_VAR);
  return value ? normalizeServerUrl(value) : undefined;
}

/** Where a resolved credential came from. */
export type CredentialSource = 'environment' | 'config';

export interface ResolvedCredential extends StoredCredential {
  source: CredentialSource;
  /**
   * A human-readable origin for `auth status` / `doctor` — the env var's NAME or
   * the config file's path. Never the token itself.
   */
  origin: string;
}

/** How a source is named in output: `environment (MOTIR_TOKEN)` / the path. */
export function credentialOriginLabel(source: CredentialSource): string {
  return source === 'environment' ? `environment (${TOKEN_ENV_VAR})` : configPath();
}

/**
 * THE credential ladder — `MOTIR_TOKEN` above the stored config entry — and the
 * single resolver every command routes through (`session.ts`, `doctor.ts`,
 * `link.ts`). {@link getCredential} stays the pure config reader beneath it, so
 * nothing gains a second path to the file.
 *
 * The env tier is NOT server-scoped (again: `GH_TOKEN`). One exported variable is
 * the credential for whatever server the run resolves to — which is the only
 * shape that works where the env tier is needed, since a container knows its
 * token but not necessarily the URL it will be pointed at.
 *
 * The sharp edge, and the reason the source is part of the return value rather
 * than an implementation detail: a stale `MOTIR_TOKEN` left in a shell profile
 * silently outranks a fresh `motir auth login`, and the failure surfaces as a 401
 * deep inside an unattended run. `auth status` and `doctor` NAME the tier that
 * supplied the credential so that is one line of output away, not a debugging
 * session.
 */
export function resolveCredential(serverUrl: string): ResolvedCredential | undefined {
  const token = envToken();
  if (token) return { token, source: 'environment', origin: credentialOriginLabel('environment') };

  const stored = getCredential(serverUrl);
  if (!stored) return undefined;
  return { ...stored, source: 'config', origin: credentialOriginLabel('config') };
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
