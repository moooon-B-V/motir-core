import type {
  ChatErrorCode,
  ChatRefusal,
  ChatSessionSummary,
  TranscriptEvent,
} from './protocol.js';
import { claudeChatAdapter } from './adapters/claude.js';
import { codexChatAdapter } from './adapters/codex.js';

// The chat adapter contract (MOTIR-7012 · `docs/decisions/agent-chat.md` Q3,
// Q5, Q7, Q11).
//
// An adapter is the CLI-SPECIFIC half of a chat: which binary, which flags, how
// its stream maps to transcript events, and where its sessions live. One file
// per profile under `chat/adapters/`, written by that profile's adapter card
// (Claude Code, Codex, OpenCode, kimi, goose). Everything around it — who may
// connect, spawning, Stop, one turn per agent, `turn_end`, and never logging a
// word of it — is the runner's (`turns.ts`), built once.
//
// ⚠️ NO ADAPTER IS REGISTERED YET. Until an adapter card lands, every profile
// answers `unsupported`, which is also aider's permanent answer (Q1: it has no
// machine-readable output for a chat to follow).

/** What an adapter is told about the machine it runs on. */
export interface ChatContext {
  /** `$HOME`. */
  home: string;
  /** `$HOME/workspace`: the terminal's working directory, so the chat sees the same stores. */
  cwd: string;
  /** The server's own environment minus `MOTIR_TERMINAL_KEY` (Q11). */
  env: Readonly<Record<string, string>>;
}

/** Q1/Q2: whether a turn may run now. */
export type ChatSupport = { supported: true } | { supported: false; code: ChatRefusal };

/**
 * Q3: how one turn is started. `file` is the vendor binary by its bare name,
 * resolved on `PATH` and spawned directly — no wrapper, shim or `sh -c` (Q11).
 */
export interface TurnCommand {
  file: string;
  args: string[];
  /** The prompt, when the CLI takes it on stdin; null when it rides in `args`. */
  stdin: string | null;
  /**
   * The ONLY environment additions allowed (Q11): a permission mode that is not
   * a credential. The runner refuses a name outside `CHAT_ENV_ADDITIONS`.
   */
  env?: Record<string, string>;
}

/** Q5: a fresh, stateful mapper per turn, fed the turn's stdout line by line. */
export interface TranscriptMapper {
  /** Map one stdout line (without its newline). Never `turn_end`: the runner writes that. */
  onLine(line: string): TranscriptEvent[];
  /** Q4's `session` frame: the CLI's session id, once the stream has revealed it. */
  sessionId(): string | null;
  /** Q1's _turn end_ column: the adapter saw its CLI's end-of-turn marker. */
  sawEnd(): boolean;
  /**
   * A kill the adapter asks for, with the code the turn fails with — Claude
   * Code's `apiKeySource:"none"` backstop (Q2) answers `subscription_signin`.
   * Read after every line; when non-null the runner SIGKILLs the process group
   * at once and ends the turn `failed` with this code.
   */
  killCode(): ChatErrorCode | null;
}

export interface ChatAdapter {
  /** The `MOTIR_SANDBOX_AGENT` id it serves. */
  readonly profile: string;
  /** Q1/Q2: whether a turn may run now. Claude Code's runs `claude auth status --json`. */
  support(ctx: ChatContext): Promise<ChatSupport>;
  /** Q3: the argv, the stdin (if the prompt goes there) and the only env additions allowed. */
  turnCommand(input: { prompt: string; sessionId: string | null; ctx: ChatContext }): TurnCommand;
  /** Q5: a fresh stateful mapper per turn. */
  createMapper(): TranscriptMapper;
  /** Q7: newest first, at most `limit`. */
  listSessions(ctx: ChatContext, limit: number): Promise<ChatSessionSummary[]>;
  /** Q7: a resumed session's earlier turns, within `budgetBytes`. May return `unavailable`. */
  readHistory(
    ctx: ChatContext,
    sessionId: string,
    budgetBytes: number,
  ): Promise<{ events: TranscriptEvent[]; truncated: boolean } | { unavailable: true }>;
}

/** Q7: the list's bound. */
export const MAX_LISTED_SESSIONS = 50;
/** Q7: a title is cut to 120 characters. */
export const MAX_TITLE_CHARS = 120;
/** Q7: a resume's history budget, newest turns kept. */
export const HISTORY_BUDGET_BYTES = 256 * 1024;

/**
 * Q11: the environment names an adapter may add. goose's `GOOSE_MODE=auto` is
 * the only one: a permission mode, not a credential. No adapter sets an API
 * key, a base URL, a provider, a model or a token.
 */
export const CHAT_ENV_ADDITIONS: ReadonlySet<string> = new Set(['GOOSE_MODE']);

/** The answer for a profile no adapter serves (Q1's verdict). */
export const UNSUPPORTED: ChatSupport = { supported: false, code: 'unsupported' };

/**
 * The registry, keyed on `MOTIR_SANDBOX_AGENT`. EMPTY until the adapter cards
 * land; each adds its adapter here.
 */
export const CHAT_ADAPTERS: readonly ChatAdapter[] = [claudeChatAdapter, codexChatAdapter];

/** The adapter serving this machine's profile, or null (answered `unsupported`). */
export function resolveChatAdapter(
  profile: string | null,
  adapters: readonly ChatAdapter[] = CHAT_ADAPTERS,
): ChatAdapter | null {
  if (!profile) return null;
  return adapters.find((adapter) => adapter.profile === profile) ?? null;
}
