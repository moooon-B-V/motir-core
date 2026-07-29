import { basename, join } from 'node:path';

// The per-agent PROFILE TABLE — what the BYOK preflight knows about the coding
// agents Motir supports first-class: the binary a profile runs, where that
// agent's CLI is installed FROM (so a missing binary can name its install
// source), and WHERE the agent keeps its own credential (so `motir doctor` can
// assert the credential is PRESENT without ever reading it).
//
// `sandbox/README.md`'s profile matrix is the VERIFIED SOURCE for both columns
// this table restates — the binary each agent installs as, and where that agent
// keeps its credential. Every value here was re-checked against that matrix (and
// against `sandbox/install-agent.sh`, which does the installing);
// `test/sandbox.test.ts` pins the two together so they cannot drift apart again.
// A profile whose credential the matrix does not pin is left UNKNOWN rather than
// guessed, because an unverified path would make `doctor` FAIL a correctly-
// configured machine. (Same reason 7.9.7b treats the agents' auto-approve flags
// as verify-at-build rather than asserted-from-memory.)
//
// The matrix pins a MOUNT, which is not always proof of AUTH — the two diverge
// wherever the mounted location also exists on a machine that never signed in.
// Where they diverge the profile tests the narrower thing (opencode's `auth.json`
// rather than its config dir) or declines to test a path at all (cursor, whose
// matrix path is also the install tree), with the reason written beside the
// entry. **A false PASS is worse than a false FAIL**: it tells the user their
// unattended run is ready when it will stop at a sign-in prompt.
//
// `binaries` is a LOOKUP KEY LIST, not a claim: the binary actually probed always
// comes from the user's own agent command (`--agent` / `MOTIR_AGENT` / config),
// and a name that matches nothing here simply falls through to the tier-3
// generic path. Motir is agent-agnostic — an unlisted agent is supported, just
// not enriched with a remediation hint.

/**
 * The directories a credential path is resolved against. Passed as one object
 * so a profile names the dir it means (`xdgDataHome`) instead of depending on
 * argument order — the shape the opencode entry got wrong when the data dir and
 * the config dir were conflated.
 */
export interface CredentialDirs {
  /** The user's home directory. */
  home: string;
  /** `XDG_CONFIG_HOME`, or `~/.config`. Configuration — not always credentials. */
  xdgConfigHome: string;
  /** `XDG_DATA_HOME`, or `~/.local/share`. Where opencode + cursor keep auth. */
  xdgDataHome: string;
}

export interface AgentProfile {
  /** Profile id — also the sandbox `AGENT=` selector and the docs' name for it. */
  id: string;
  /** Human label used in report lines. */
  label: string;
  /** 1 = pinned by the sandbox matrix; 2 = also-supported. */
  tier: 1 | 2;
  /**
   * Every binary name this profile is matched by, canonical one FIRST. A list
   * rather than a single name because an agent's own installer can link several
   * (Cursor links both `agent` and `cursor-agent`), and because a user may have
   * aliased the profile id — matching only one name silently drops such a user
   * onto the tier-3 generic path, with no remediation hint.
   */
  binaries: readonly string[];
  /** Where the agent's own CLI comes from (the missing-binary remediation). */
  installSource: string;
  /**
   * Credential locations to test for PRESENCE — a directory the agent creates
   * on sign-in, or the credential FILE itself where the directory alone would
   * not prove authentication.
   */
  credentialPaths: (dirs: CredentialDirs) => string[];
  /**
   * Env vars whose PRESENCE also satisfies the credential check. Only ever
   * passed to a presence predicate — the VALUE is never read (see doctor.ts).
   */
  credentialEnv: string[];
  /**
   * False when this profile has nowhere it can honestly look — no pinned path
   * and no env var. It is NOT "the matrix has no row": a matrix mount that
   * proves installation rather than authentication buys nothing.
   */
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
 * Tier-1: the four profiles the sandbox matrix makes first-class. Tier-2:
 * also-supported agents. Every `binaries` and `credentialPaths` value below is
 * the sandbox matrix's, narrowed only where a mount is not proof of auth.
 */
export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    tier: 1,
    binaries: ['claude'],
    installSource: 'npm install -g @anthropic-ai/claude-code',
    credentialPaths: ({ home }) => [join(home, '.claude')],
    credentialEnv: ['ANTHROPIC_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `claude` once to sign in, or set ANTHROPIC_API_KEY.',
    codegraphTarget: 'claude',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    tier: 1,
    binaries: ['codex'],
    installSource: 'npm install -g @openai/codex',
    credentialPaths: ({ home }) => [join(home, '.codex')],
    credentialEnv: ['OPENAI_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `codex` once to sign in, or set OPENAI_API_KEY.',
    codegraphTarget: 'codex',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    tier: 1,
    binaries: ['opencode'],
    installSource: 'npm, or the OpenCode install script (opencode.ai)',
    // OpenCode SPLITS the two: `~/.config/opencode` holds configuration, while
    // the credential is `auth.json` under the XDG DATA home — which is why the
    // sandbox mounts both dirs. Testing the config dir passed on any machine
    // that had ever run opencode, signed in or not; the check is the auth FILE.
    credentialPaths: ({ xdgDataHome }) => [join(xdgDataHome, 'opencode', 'auth.json')],
    credentialEnv: [],
    credentialKnown: true,
    credentialHint: 'Run `opencode auth login` to sign in — it writes auth.json.',
    codegraphTarget: 'opencode',
  },
  {
    id: 'kimi',
    label: 'Kimi Code CLI',
    tier: 1,
    binaries: ['kimi'],
    installSource: 'npm (@moonshot-ai/kimi-code) — needs Node ≥ 22.19',
    credentialPaths: ({ home }) => [join(home, '.kimi-code')],
    credentialEnv: [],
    credentialKnown: true,
    credentialHint: 'Run `kimi` once to sign in — it writes ~/.kimi-code.',
    codegraphTarget: null,
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    tier: 2,
    // The installer links `agy`, not `antigravity`; the profile id is kept as a
    // tolerated alias for anyone who aliased it that way.
    binaries: ['agy', 'antigravity'],
    installSource: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    // `agy` keeps its token in the OS KEYRING, with no documented portable
    // file — the one profile with genuinely nowhere to look (the sandbox
    // mounts no credential for it either).
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Sign in with `agy` (its token lives in the OS keyring, not a file).',
    codegraphTarget: 'antigravity',
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    tier: 2,
    // The installer symlinks the executable as `agent`, keeping `cursor-agent`
    // as the legacy alias — `cursor` is neither, and matched nothing until the
    // list arrived. It stays last so a user who aliased it keeps a profile.
    binaries: ['agent', 'cursor-agent', 'cursor'],
    installSource: 'curl https://cursor.com/install -fsS | bash',
    // The matrix's `~/.local/share/cursor-agent` mount is also where the
    // installer unpacks the CLI itself, so its presence proves an INSTALL, not
    // a sign-in. The API key is the one unambiguous signal, so it is the only
    // one tested.
    credentialPaths: () => [],
    credentialEnv: ['CURSOR_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `cursor-agent login` to sign in, or set CURSOR_API_KEY.',
    codegraphTarget: 'cursor',
  },
  {
    id: 'aider',
    label: 'Aider',
    tier: 2,
    binaries: ['aider'],
    installSource: 'pip (Python) — PyPI `aider-chat`',
    // Aider's credential IS the model key it reads from the environment. Its
    // `~/.aider.conf.yml` is configuration, and the sandbox asks the user to
    // create it (even empty) so docker can bind it — so its presence would
    // prove nothing at all.
    credentialPaths: () => [],
    credentialEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Give Aider a model key: set ANTHROPIC_API_KEY or OPENAI_API_KEY.',
    codegraphTarget: null,
  },
  {
    id: 'goose',
    label: 'Goose',
    tier: 2,
    binaries: ['goose'],
    installSource: 'the Goose installer (Block)',
    // Goose stores provider secrets in the OS KEYRING by default and only falls
    // back to a file under `~/.config/goose` when the keyring is disabled (as
    // the sandbox does). Neither state is testable from outside: an existing
    // config dir need not hold a key, and a keyring-backed key leaves no file.
    credentialPaths: () => [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Run `goose configure` to store a provider key.',
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
 * Find the profile for a binary, matching ANY of its names (`agent` resolves
 * Cursor just as `cursor-agent` does). Matches on the basename (so an absolute
 * path like `/usr/local/bin/claude` still resolves), case-insensitively,
 * ignoring a Windows `.exe`/`.cmd` suffix. An unmatched binary is the tier-3
 * case → null.
 */
export function findAgentProfile(binary: string): AgentProfile | null {
  const name = basename(binary)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
  return AGENT_PROFILES.find((p) => p.binaries.includes(name)) ?? null;
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
