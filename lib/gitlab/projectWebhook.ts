import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { gitlabBaseUrl } from '@/lib/gitlab/gitlabOAuth';
import { GitlabWebhookNotConfiguredError, GitlabWebhookRegistrationError } from './errors';

// GitLab PROJECT WEBHOOK registration (MOTIR-5349) — the mechanism behind the
// connect screen's "Connecting a project adds a webhook". Until this module nothing
// registered one: MOTIR-1475 built the RECEIVING route (`/api/gitlab/webhook`) and
// its token check, and a connected project sent it nothing unless somebody added
// the hook by hand in GitLab — so the status sync, CI feedback, code-graph refresh
// and preview ingestion all read as silently broken.
//
// A leaf HTTP helper, like `gitlabOAuth.ts`: it takes the connection's access token
// from the caller (the service mints it) and holds no DB concern. The hook is
// identified by its URL — Motir's own webhook endpoint — which is what makes a
// re-connect converge on ONE hook rather than stacking a second, and what lets a
// disconnect find the hook to remove without storing GitLab's hook id.

const WEBHOOK_PATH = '/api/gitlab/webhook';
const SECRET_ENV = 'GITLAB_WEBHOOK_SECRET';
const REQUEST_TIMEOUT_MS = 10_000;

/** The event flags every Motir-registered hook carries — one per consumer:
 *  `merge_requests_events` (status sync), `pipeline_events` (CI feedback),
 *  `push_events` (code-graph refresh), `deployment_events` (preview URLs). */
export const GITLAB_WEBHOOK_EVENTS = {
  merge_requests_events: true,
  pipeline_events: true,
  push_events: true,
  deployment_events: true,
} as const;

/** Motir's own webhook endpoint, as GitLab will call it. */
export function gitlabWebhookUrl(): string {
  return `${resolveBaseUrlTrimmed()}${WEBHOOK_PATH}`;
}

interface HookRef {
  id: number;
  url: string;
}

async function call(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${gitlabBaseUrl()}/api/v4${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'motir',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const reason = controller.signal.aborted
      ? `no response within ${REQUEST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : 'unknown';
    throw new GitlabWebhookRegistrationError(null, `request (${reason})`);
  } finally {
    clearTimeout(timer);
  }
}

/** The project's hooks pointing at Motir's endpoint (normally zero or one). */
async function listMotirHooks(token: string, projectId: string): Promise<HookRef[]> {
  const res = await call(token, 'GET', `/projects/${encodeURIComponent(projectId)}/hooks`);
  if (!res.ok) throw new GitlabWebhookRegistrationError(res.status, 'listing project hooks');
  const body: unknown = await res.json().catch(() => null);
  const url = gitlabWebhookUrl();
  if (!Array.isArray(body)) return [];
  return body.flatMap((hook): HookRef[] => {
    if (typeof hook !== 'object' || hook === null) return [];
    const { id, url: hookUrl } = hook as Record<string, unknown>;
    return typeof id === 'number' && hookUrl === url ? [{ id, url: hookUrl }] : [];
  });
}

/**
 * Ensure the project carries exactly ONE Motir webhook with the current event
 * flags and secret token. Idempotent: an existing hook at Motir's URL is UPDATED
 * (so a rotated `GITLAB_WEBHOOK_SECRET` or a newly added event reaches a project
 * connected before it), duplicates at the same URL are removed, and only a project
 * with none gets a new one.
 *
 * Throws {@link GitlabWebhookNotConfiguredError} when this deployment has no
 * `GITLAB_WEBHOOK_SECRET` — a hook without the secret is one the receiving route
 * rejects on every delivery, so registering it would be the same silent failure
 * this module exists to end — and {@link GitlabWebhookRegistrationError} when
 * GitLab refuses or cannot be reached (most often a 403: adding a hook needs the
 * Maintainer role on the project).
 */
export async function ensureProjectWebhook(token: string, projectId: string): Promise<void> {
  const secret = process.env[SECRET_ENV];
  if (!secret) throw new GitlabWebhookNotConfiguredError();

  const payload = {
    url: gitlabWebhookUrl(),
    token: secret,
    enable_ssl_verification: true,
    ...GITLAB_WEBHOOK_EVENTS,
  };
  const project = encodeURIComponent(projectId);
  const [first, ...duplicates] = await listMotirHooks(token, projectId);

  const res = first
    ? await call(token, 'PUT', `/projects/${project}/hooks/${first.id}`, payload)
    : await call(token, 'POST', `/projects/${project}/hooks`, payload);
  if (!res.ok) {
    throw new GitlabWebhookRegistrationError(res.status, first ? 'updating hook' : 'adding hook');
  }

  for (const dup of duplicates) {
    const del = await call(token, 'DELETE', `/projects/${project}/hooks/${dup.id}`);
    if (!del.ok && del.status !== 404) {
      throw new GitlabWebhookRegistrationError(del.status, 'removing a duplicate hook');
    }
  }
}

/**
 * Remove every Motir webhook from the project. A 404 (the hook or the project is
 * already gone) is success. Throws {@link GitlabWebhookRegistrationError} on any
 * other refusal — the caller decides whether that is fatal (a disconnect treats it
 * as best-effort).
 */
export async function removeProjectWebhook(token: string, projectId: string): Promise<void> {
  const project = encodeURIComponent(projectId);
  let hooks: HookRef[];
  try {
    hooks = await listMotirHooks(token, projectId);
  } catch (err) {
    if (err instanceof GitlabWebhookRegistrationError && err.status === 404) return;
    throw err;
  }
  for (const hook of hooks) {
    const res = await call(token, 'DELETE', `/projects/${project}/hooks/${hook.id}`);
    if (!res.ok && res.status !== 404) {
      throw new GitlabWebhookRegistrationError(res.status, 'removing hook');
    }
  }
}
