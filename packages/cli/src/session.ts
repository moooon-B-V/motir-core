import { MotirClient, type ReadyItemSummary } from './mcpClient.js';
import { CliError } from './errors.js';
import { requireLink, type FoundLink } from './config/linkConfig.js';
import { getCredential, normalizeServerUrl } from './config/userConfig.js';

// Shared plumbing for the commands that talk to a linked project: resolve the
// `.motir.json` binding (walked up from cwd), look up the server's stored PAT,
// and open ONE connected MCP client. Every read/dispatch command runs inside a
// session so the connect + close (and the not-linked / not-logged-in errors)
// live in one place.

export interface ProjectSession {
  link: FoundLink;
  serverUrl: string;
  projectKey: string;
  client: MotirClient;
}

/** Resolve the linked project + token and open a connected MCP client. Throws
 * {@link CliError} (NotLinked / not-logged-in) before any network call. The
 * caller MUST close the client — prefer {@link withProjectSession}. */
export async function openProjectSession(): Promise<ProjectSession> {
  const link = requireLink();
  const serverUrl = normalizeServerUrl(link.config.serverUrl);
  const cred = getCredential(serverUrl);
  if (!cred) {
    throw new CliError(`Not logged in to ${serverUrl}.`, {
      hint: 'Run `motir auth login` first.',
    });
  }
  const client = new MotirClient({ serverUrl, token: cred.token });
  await client.connect();
  return { link, serverUrl, projectKey: link.config.project, client };
}

/** Run `fn` with an open project session, always closing the client after. */
export async function withProjectSession<T>(
  fn: (session: ProjectSession) => Promise<T>,
): Promise<T> {
  const session = await openProjectSession();
  try {
    return await fn(session);
  } finally {
    await session.client.close();
  }
}

/** The list_ready page size cap (server clamps `limit` to 200). We page at the
 * cap so collecting the whole ready set costs the fewest round-trips. */
export const READY_PAGE_SIZE = 200;

export interface ReadyFilter {
  kinds?: string[];
  assigneeId?: string | null;
}

/**
 * Page through the ENTIRE ready set with the tool's cursor, accumulating every
 * row. Renders all pages for the table but never asks for more than the server
 * page size in a single call (the 7.9.2 acceptance contract). The ready set is
 * the actionable subset, so this stays small in practice.
 */
export async function collectReady(
  client: MotirClient,
  projectKey: string,
  filter: ReadyFilter = {},
): Promise<ReadyItemSummary[]> {
  const all: ReadyItemSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listReady({
      projectKey,
      kinds: filter.kinds,
      assigneeId: filter.assigneeId,
      cursor,
      limit: READY_PAGE_SIZE,
    });
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}
