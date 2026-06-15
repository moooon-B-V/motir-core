import { CliError } from '../errors.js';
import { info, json, out } from '../output.js';
import { requireLink } from '../config/linkConfig.js';
import { collectReady, withProjectSession } from '../session.js';
import { openUrl } from '../browser.js';
import {
  inFlightFilter,
  issueUrl,
  renderReadyTable,
  renderStatusBlock,
  type StatusPulse,
} from '../render.js';
import type { MotirClient } from '../mcpClient.js';

// `motir ready` / `motir status` / `motir open <key>` — the read surface a user
// checks before and between dispatches (Story 7.9 · Subtask 7.9.2). Every read
// rides the existing MCP tools (list_ready / search_work_items / list_sprints):
// NO new server surface, so the CLI can never disagree with the web app on what
// "ready" or "in flight" means.

const WORK_ITEM_KINDS = new Set(['epic', 'story', 'task', 'bug', 'subtask']);

/** Parse a `--kinds epic,story` list into validated lower-case kinds. */
export function parseKinds(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const kinds = raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
  if (kinds.length === 0) return undefined;
  const bad = kinds.filter((k) => !WORK_ITEM_KINDS.has(k));
  if (bad.length > 0) {
    throw new CliError(`Unknown work item kind(s): ${bad.join(', ')}.`, {
      hint: `Valid kinds: ${[...WORK_ITEM_KINDS].join(', ')}.`,
    });
  }
  return kinds;
}

/** Resolve a `--assignee` value to the tool's `assigneeId` tri-state: `me` →
 * the token owner's id (a whoami round-trip), `unassigned`/`none` → the
 * unassigned bucket sentinel, any other value → that id verbatim, omitted →
 * undefined (any). */
async function resolveAssignee(
  client: MotirClient,
  raw: string | undefined,
): Promise<string | null | undefined> {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'unassigned' || value === 'none') return 'unassigned';
  if (value === 'me') {
    const who = await client.whoami();
    return who.user.id;
  }
  return raw;
}

export interface ReadyOptions {
  kinds?: string;
  assignee?: string;
  json?: boolean;
}

export async function readyCommand(opts: ReadyOptions): Promise<void> {
  const kinds = parseKinds(opts.kinds);
  await withProjectSession(async ({ client, projectKey }) => {
    const assigneeId = await resolveAssignee(client, opts.assignee);
    const items = await collectReady(client, projectKey, { kinds, assigneeId });
    if (opts.json) {
      json(items);
      return;
    }
    out(renderReadyTable(items));
  });
}

export interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(opts: StatusOptions): Promise<void> {
  const pulse = await withProjectSession(async ({ client, projectKey }) => {
    // Ready count: page the whole ready set (no count tool exists; the set is
    // the small actionable subset). In-flight count: search_work_items returns
    // the matching `total` directly, so one call suffices. Active sprint:
    // list_sprints, pick the single `active` one.
    const ready = await collectReady(client, projectKey);
    const search = await client.searchWorkItems({
      projectKey,
      filter: inFlightFilter(),
      limit: 1,
    });
    const { sprints } = await client.listSprints({ projectKey });
    const result: StatusPulse = {
      projectKey,
      readyCount: ready.length,
      inFlightCount: search.total,
      activeSprint: sprints.find((s) => s.state === 'active') ?? null,
      totalSprints: sprints.length,
    };
    return result;
  });

  if (opts.json) {
    json(pulse);
    return;
  }
  out(renderStatusBlock(pulse));
}

export interface OpenOptions {
  /** Print the URL only; don't try to launch a browser. */
  print?: boolean;
}

export async function openCommand(key: string, opts: OpenOptions): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir open PROD-7`.');
  // No MCP call needed — the canonical URL comes straight from the link config
  // (no hardcoded host). Resolving the link also enforces the not-linked error.
  const link = requireLink();
  const url = issueUrl(link.config.serverUrl, trimmed);
  out(url);
  if (opts.print) return;
  const launched = await openUrl(url);
  if (!launched) info('(Could not open a browser here — the URL is above.)');
}
