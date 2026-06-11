// Email capture for E2E.
//
// The dev server runs with EMAIL_PROVIDER=file (set in playwright.config.ts's
// webServer.env), which appends each email as a JSON line to
// EMAIL_OUTBOX_PATH (default /tmp/motir-test-emails.jsonl). This helper
// polls the file and returns the most recent email matching a recipient
// predicate.
//
// Why poll rather than tap stdout: Playwright's webServer API doesn't
// expose the spawned process's stdout to test code in a portable way. A
// file on disk is the cheapest cross-process IPC we can rely on.
//
// Why include EMAIL_OUTBOX_PATH default here too: tests are executed in
// the Playwright runner's process, not the dev server's, so the .env's
// EMAIL_OUTBOX_PATH isn't auto-loaded. Keep the default in lockstep with
// playwright.config.ts.

import { readFile } from 'node:fs/promises';

const EMAIL_OUTBOX_PATH = process.env['EMAIL_OUTBOX_PATH'] ?? '/tmp/motir-test-emails.jsonl';

interface CapturedEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  sentAt: string;
}

async function readOutbox(): Promise<CapturedEmail[]> {
  try {
    const contents = await readFile(EMAIL_OUTBOX_PATH, 'utf8');
    return contents
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as CapturedEmail);
  } catch (err) {
    // The file doesn't exist until the first email is sent. Treat that
    // as "no emails yet" instead of bubbling ENOENT.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Wait until at least one email has been sent to `to`. Resolves with
 * the latest matching email. Times out after `timeoutMs` (default 10s)
 * with a descriptive error pointing at the outbox path so debugging
 * a hung test starts from the file the dev server should have written.
 *
 * Polls every 100ms — cheap (single readFile call) and fast enough that
 * the reset round-trip never takes more than ~1s in practice.
 */
export async function waitForEmail(
  to: string,
  options: { timeoutMs?: number } = {},
): Promise<CapturedEmail> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 0;

  while (Date.now() < deadline) {
    const all = await readOutbox();
    lastSeen = all.length;
    // Match on lowercased recipient so capitalisation in test fixtures
    // doesn't accidentally miss the email.
    const matches = all.filter((e) => e.to.toLowerCase() === to.toLowerCase());
    if (matches.length > 0) return matches[matches.length - 1]!;
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(
    `waitForEmail timed out after ${timeoutMs}ms waiting for an email to ` +
      `'${to}'. Outbox path: ${EMAIL_OUTBOX_PATH}. Saw ${lastSeen} email(s) total.`,
  );
}

/**
 * Every outbox email sent to `to` (case-insensitive). Unlike waitForEmail
 * this does NOT poll — it's the negative-assertion read ("no mention email
 * went to the author themselves", Subtask 5.1.7). The outbox file persists
 * across tests in a run, so callers scope the assertion further (subject
 * substring) rather than expecting an empty array.
 */
export async function emailsTo(to: string): Promise<CapturedEmail[]> {
  const all = await readOutbox();
  return all.filter((e) => e.to.toLowerCase() === to.toLowerCase());
}

/**
 * Pulls the first http(s):// URL out of an email body. Reset emails from
 * Better-Auth put the link in both the text and html bodies; we read it
 * from text because text comes through unescaped and we don't have to
 * worry about &amp; → & decoding.
 */
export function extractResetUrl(email: CapturedEmail): string {
  const match = email.text.match(/https?:\/\/[^\s)]+/);
  if (!match) {
    throw new Error(
      `Could not find a URL in the reset email. Body:\n${email.text}\n` +
        `(Did Better-Auth's sendResetPassword wiring change shape?)`,
    );
  }
  return match[0];
}

/**
 * Pulls the first http(s):// URL out of a workspace-invite email body.
 * The invite email template (lib/emailTemplates/workspaceInvite.tsx)
 * keeps the accept link unredacted in the plain-text body, mirroring the
 * reset email's dev-console contract — so the same regex works.
 */
export function extractInviteUrl(email: CapturedEmail): string {
  const match = email.text.match(/https?:\/\/[^\s)]+/);
  if (!match) {
    throw new Error(
      `Could not find a URL in the invite email. Body:\n${email.text}\n` +
        `(Did the workspaceInvite template's plain-text body change shape?)`,
    );
  }
  return match[0];
}
