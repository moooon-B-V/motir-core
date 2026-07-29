import { basename, join } from 'node:path';

// The per-agent PROFILE TABLE — what the BYOK preflight knows about the coding
// agents Motir supports first-class: the binary a profile runs, where that
// agent's CLI is installed FROM (so a missing binary can name its install
// source), and WHERE the agent keeps its own credential (so `motir doctor` can
// assert the credential is PRESENT without ever reading it).
//
// The table mirrors the sandbox profile matrix (7.9.7b). Tier-1 profiles are
// pinned by that matrix — install source AND credential location. Tier-2
// profiles carry their install source only: their credential location is
// deliberately left UNKNOWN rather than guessed, because an unverified path
// would make `doctor` FAIL a correctly-configured machine — strictly worse than
// reporting "verify this one yourself". (Same reason 7.9.7b treats the agents'
// auto-approve flags as verify-at-build rather than asserted-from-memory.)
//
// `binary` is a LOOKUP KEY, not a claim: the binary actually probed always comes
// from the user's own agent command (`--agent` / `MOTIR_AGENT` / config), and a
// name that matches nothing here simply falls through to the tier-3 generic
// path. Motir is agent-agnostic — an unlisted agent is supported, just not
// enriched with a remediation hint.

export interface AgentProfile {
  /** Profile id — also the command name a user would type. */
  id: string;
  /** Human label used in report lines. */
  label: string;
  /** 1 = pinned by the sandbox matrix; 2 = also-supported, credential unpinned. */
  tier: 1 | 2;
  /** The binary name this profile is matched by. */
  binary: string;
  /** Where the agent's own CLI comes from (the missing-binary remediation). */
  installSource: string;
  /**
   * Credential directories to test for PRESENCE. Resolved from the home +
   * XDG config dirs so the check honours a relocated config home.
   */
  credentialPaths: (home: string, xdgConfigHome: string) => string[];
  /**
   * Env vars whose PRESENCE also satisfies the credential check. Only ever
   * passed to a presence predicate — the VALUE is never read (see doctor.ts).
   */
  credentialEnv: string[];
  /** False when the matrix does not pin this agent's credential location. */
  credentialKnown: boolean;
  /** How the user provides the credential (the missing-credential remediation). */
  credentialHint: string;
  /**
   * The `codegraph install --target <id>` id that wires the code-graph MCP
   * server for this agent, or null when codegraph has no target for it
   * (7.9.7d). Read off `codegraph install --print-config` against the version
   * the sandbox ships — never assumed: the known set is
   * `claude, cursor, codex, opencode, hermes, gemini, antigravity, kiro`, which
   * covers five of the eight profiles here. A profile with no target is left
   * null rather than pointed at a near-miss id, for the same reason
   * `credentialKnown` is left false: a wrong id would claim a wiring the image
   * does not have.
   */
  codegraphTarget: string | null;
}

/**
 * Tier-1: the four profiles the sandbox matrix pins (install source AND
 * credential mount). Tier-2: also-supported agents whose credential location
 * the matrix does not pin.
 */
export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    tier: 1,
    binary: 'claude',
    installSource: 'npm install -g @anthropic-ai/claude-code',
    credentialPaths: (home) => [join(home, '.claude')],
    credentialEnv: ['ANTHROPIC_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `claude` once to sign in, or set ANTHROPIC_API_KEY.',
    codegraphTarget: 'claude',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    tier: 1,
    binary: 'codex',
    installSource: 'npm install -g @openai/codex',
    credentialPaths: (home) => [join(home, '.codex')],
    credentialEnv: ['OPENAI_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `codex` once to sign in, or set OPENAI_API_KEY.',
    codegraphTarget: 'codex',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    tier: 1,
    binary: 'opencode',
    installSource: 'npm, or the OpenCode install script (opencode.ai)',
    credentialPaths: (_home, xdgConfigHome) => [join(xdgConfigHome, 'opencode')],
    credentialEnv: [],
    credentialKnown: true,
    credentialHint: 'Sign in with the OpenCode CLI so it writes its config dir.',
    codegraphTarget: 'opencode',
  },
  {
    id: 'kimi',
    label: 'Kimi Code CLI',
    tier: 1,
    binary: 'kimi',
    installSource: 'npm (MoonshotAI/kimi-code) — needs Node ≥ 24.15',
    // The matrix names "the Kimi config dir" without pinning the path; we do
    // not guess one (a wrong path would FAIL a working setup).
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Sign in with the Kimi Code CLI (see its docs for the config dir).',
    codegraphTarget: null,
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    tier: 2,
    binary: 'antigravity',
    installSource: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Sign in with the Antigravity CLI (see its docs for the credential path).',
    codegraphTarget: 'antigravity',
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    tier: 2,
    binary: 'cursor',
    installSource: 'the Cursor CLI installer (Anysphere)',
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Sign in with the Cursor CLI (see its docs for the credential path).',
    codegraphTarget: 'cursor',
  },
  {
    id: 'aider',
    label: 'Aider',
    tier: 2,
    binary: 'aider',
    installSource: 'pip (Python)',
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Provide Aider with a model key (see its docs for the config/env it reads).',
    codegraphTarget: null,
  },
  {
    id: 'goose',
    label: 'Goose',
    tier: 2,
    binary: 'goose',
    installSource: 'the Goose installer (Block)',
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Configure Goose with a provider key (see its docs for the credential path).',
    codegraphTarget: null,
  },
];

/** The parsed form of an agent command string: the binary plus its flags. */
export interface ParsedAgentCommand {
  /** The command as given (binary + flags). */
  command: string;
  /** The executable to look for on PATH — the first whitespace-separated token. */
  binary: string;
  /** The remaining tokens (e.g. `--dangerously-skip-permissions`). */
  args: string[];
}

/**
 * Split an agent command (`claude --dangerously-skip-permissions`) into the
 * binary to probe and its flags. The tier-3 escape hatch passes a full command,
 * so the binary is always the FIRST token — never the whole string.
 * Returns null for an empty/blank command.
 */
export function parseAgentCommand(command: string | undefined): ParsedAgentCommand | null {
  const trimmed = (command ?? '').trim();
  if (!trimmed) return null;
  // Split at the FIRST whitespace rather than destructuring the split array:
  // the binary is then a string by construction, with no unreachable
  // "empty first token" branch to carry.
  const boundary = trimmed.search(/\s/);
  if (boundary === -1) return { command: trimmed, binary: trimmed, args: [] };
  return {
    command: trimmed,
    binary: trimmed.slice(0, boundary),
    args: trimmed
      .slice(boundary + 1)
      .trim()
      .split(/\s+/),
  };
}

/**
 * Find the profile for a binary. Matches on the basename (so an absolute path
 * like `/usr/local/bin/claude` still resolves), case-insensitively, ignoring a
 * Windows `.exe`/`.cmd` suffix. An unmatched binary is the tier-3 case → null.
 */
export function findAgentProfile(binary: string): AgentProfile | null {
  const name = basename(binary)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
  return AGENT_PROFILES.find((p) => p.binary === name) ?? null;
}

/** Every profile id, for help text / docs (`claude, codex, …`). */
export function agentProfileIds(): string[] {
  return AGENT_PROFILES.map((p) => p.id);
}

/**
 * The profiles whose agent the sandbox image wires the code-graph MCP server
 * into at build time (7.9.7d) — i.e. those codegraph has an install target for.
 * The sandbox suite drives its per-profile guards off this, so a profile that
 * gains (or loses) a codegraph target cannot leave the image's install seam
 * behind.
 */
export function codegraphWiredProfiles(): { id: string; target: string }[] {
  return AGENT_PROFILES.filter(
    (p): p is AgentProfile & { codegraphTarget: string } => p.codegraphTarget !== null,
  ).map((p) => ({ id: p.id, target: p.codegraphTarget }));
}
