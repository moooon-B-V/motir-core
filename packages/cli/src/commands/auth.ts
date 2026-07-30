import { MotirClient } from '../mcpClient.js';
import { CliError } from '../errors.js';
import { info, out } from '../output.js';
import { isInteractive, promptLine, promptSecret } from '../prompts.js';
import { DEFAULT_SERVER_URL, resolveServerUrl } from '../serverResolve.js';
import {
  TOKEN_ENV_VAR,
  displayTokenPrefix,
  envToken,
  normalizeServerUrl,
  removeCredential,
  resolveCredential,
  setCredential,
} from '../config/userConfig.js';

// `motir auth` — the credential commands. A STORED PAT lives only in the user
// config (chmod 600); login validates it with a real connect + tool-list
// round-trip before storing, so an invalid/revoked token is rejected at login
// time rather than failing later mid-dispatch.
//
// `auth login` deliberately keeps its own shape: `MOTIR_TOKEN` is a fallback for
// the PROMPT here (an explicit login on a laptop should still persist), whereas
// everywhere else the env var is a credential in its own right that is never
// written to disk. `auth status` is the command that makes the difference
// visible — it names which tier supplied the credential it is reporting on.

export interface AuthLoginOptions {
  server?: string;
  token?: string;
}

export async function authLogin(opts: AuthLoginOptions): Promise<void> {
  let serverUrl = opts.server;
  if (!serverUrl) {
    if (!isInteractive()) {
      throw new CliError('No server URL given.', { hint: 'Pass --server <url>.' });
    }
    serverUrl = await promptLine('Server URL', DEFAULT_SERVER_URL);
  }
  serverUrl = normalizeServerUrl(serverUrl);

  let token = opts.token ?? envToken();
  if (!token) {
    if (!isInteractive()) {
      throw new CliError('No token given.', {
        hint: 'Pass --token <pat>, set MOTIR_TOKEN, or run interactively.',
      });
    }
    token = await promptSecret('Personal access token');
  }
  if (!token) throw new CliError('A token is required.');

  // Validate by connecting + listing tools, then resolve the owner via whoami.
  const client = new MotirClient({ serverUrl, token });
  try {
    await client.connect();
    await client.listToolNames();
    const who = await client.whoami();
    setCredential(serverUrl, { token, user: who.user });
    const ws = who.workspace ? ` (workspace ${who.workspace.name})` : '';
    info(`Logged in as ${who.user.email} on ${serverUrl}${ws}.`);
  } finally {
    await client.close();
  }
}

export interface AuthScopeOptions {
  server?: string;
}

export async function authStatus(opts: AuthScopeOptions): Promise<void> {
  const serverUrl = resolveServerUrl(opts.server);
  const cred = resolveCredential(serverUrl);
  if (!cred) {
    throw new CliError(`Not logged in to ${serverUrl}.`, {
      hint: `Run \`motir auth login\`, or set ${TOKEN_ENV_VAR}.`,
    });
  }

  out(`Server:    ${serverUrl}`);
  out(`Token:     ${displayTokenPrefix(cred.token)}`);
  // WHICH tier supplied it — the answer to "why am I the wrong account". A
  // `MOTIR_TOKEN` exported in a shell profile outranks a stored login silently,
  // so the source belongs beside the token, not in a troubleshooting doc.
  out(`Source:    ${cred.origin}`);

  // A live whoami both confirms the token is still valid (a revoked one surfaces
  // as the auth error) and shows the current owner + active workspace.
  const client = new MotirClient({ serverUrl, token: cred.token });
  try {
    await client.connect();
    const who = await client.whoami();
    out(`User:      ${who.user.name || who.user.email} <${who.user.email}>`);
    if (who.workspace) out(`Workspace: ${who.workspace.name} (${who.workspace.slug})`);
  } finally {
    await client.close();
  }
}

export async function authLogout(opts: AuthScopeOptions): Promise<void> {
  const serverUrl = resolveServerUrl(opts.server);
  const removed = removeCredential(serverUrl);
  if (removed) info(`Logged out of ${serverUrl}.`);
  else info(`No stored credential for ${serverUrl}.`);
  // Logout can only remove what is on DISK. Saying "logged out" while an env
  // credential is still in force would be a lie the next command exposes, so
  // name it here instead.
  if (envToken()) {
    info(`${TOKEN_ENV_VAR} is still set — it overrides the stored credential. Unset it to finish.`);
  }
}
