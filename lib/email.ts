// Email-sending abstraction.
//
// Every caller in motir-core uses `sendEmail(...)` from this module. No
// caller imports a vendor SDK directly. That makes "which mailer to run in
// production" a per-project planner decision (Layer 2 — pre-plan work for
// each Motir-planned project), not a starter-baked assumption (Layer 1).
//
// v1 of motir-core ships THREE dev-grade providers:
//   - 'console' (default) — prints emails to stdout so dev/test flows can
//     grep the reset link. Tests in tests/password-reset.test.ts capture
//     it via a console.log spy.
//   - 'file'              — appends each email as a JSON line to the file
//     at EMAIL_OUTBOX_PATH (default /tmp/motir-test-emails.jsonl). Used
//     by the Playwright E2E suite, which can't reliably tap the dev
//     server's stdout from a separate test process. Dev/test only — the
//     file is unauthenticated, so this MUST NOT be selected in
//     production. Choosing it in NODE_ENV=production throws at module
//     load with a clear message.
//   - 'resend' / 'postmark' — stubs that throw a loud not-yet-implemented
//     error if selected. Real provider wiring is planner work for each
//     Motir-planned project's pre-plan phase.
//
// The provider is resolved eagerly at module-import time (see the
// `sendEmail` export at the bottom). An unknown EMAIL_PROVIDER value
// therefore crashes the app at boot with a clear message — not on the
// first email two days into a deploy.

import { appendFile, readFile } from 'node:fs/promises';
import { isE2EProdHarness } from '@/lib/e2eProdHarness';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export type SendEmail = (msg: EmailMessage) => Promise<void>;

// Strips HTML tags from a body for the plain-text fallback. Intentionally
// dumb — the console provider prints whichever body the caller passed; this
// only kicks in when a caller skipped `text`. Real providers should be given
// both an html and a text body by the caller, so this fallback is mostly a
// dev-console nicety.
function htmlToText(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      // Surface anchor hrefs inline ("text (url)") so reset links remain
      // grep-able when a caller passes only html. Critical for the
      // console-provider's "tests can read the link off stdout" promise.
      .replace(
        /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_, href, inner) =>
          `${String(inner)
            .replace(/<[^>]+>/g, '')
            .trim()} (${href})`,
      )
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

const consoleProvider: SendEmail = async (msg) => {
  const body = msg.text ?? htmlToText(msg.html);
  // The reset link MUST appear unredacted so dev/test flows can grep it.
  // (Better-Auth's password-reset flow puts the token in the URL body of
  // the email; tests in tests/password-reset.test.ts capture this stdout.)
  // eslint-disable-next-line no-console -- console is the entire point of this provider
  console.log(`[EMAIL] To: ${msg.to} Subject: ${msg.subject}\n${body}`);
};

function unimplementedProvider(name: string): SendEmail {
  return async () => {
    throw new Error(
      `Email provider '${name}' is not yet implemented in motir-core. ` +
        `Production providers are planner work for each Motir-planned project's ` +
        `pre-plan phase — see lib/email.ts and the Story 1.1 decisions log. ` +
        `Set EMAIL_PROVIDER=console for local dev.`,
    );
  };
}

// Dev-only file provider. Appends each email as a single JSON line to the
// path in EMAIL_OUTBOX_PATH (defaults to /tmp/motir-test-emails.jsonl).
// Playwright E2E specs subscribe to this file to read the reset link —
// the dev server's stdout isn't reliably tappable from a separate test
// process, but a file on disk is.
//
// Atomicity: Node's fs.appendFile opens the file with O_APPEND, so even
// if multiple concurrent emails are flushing at once the OS guarantees
// each line-sized write lands intact (POSIX guarantees writes ≤ PIPE_BUF
// against an O_APPEND fd are atomic; a single 1–2KB JSON line is well
// inside that). No external lockfile needed.
//
// Trailing newline is REQUIRED — readers split on `\n`, so a missing
// final newline would silently drop the last email.
//
// SECURITY: the outbox file is unauthenticated and world-readable by
// whatever process started the dev server. Refusing to enable this
// provider in production keeps the contract obvious: 'file' is a test
// harness, not a deliverability path.
function fileProvider(): SendEmail {
  // Refused in real production, but ALLOWED under the E2E production harness
  // (MOTIR-1679): that runs a `next start` build, which forces
  // NODE_ENV=production even though it is the test suite writing to the file
  // outbox the specs poll. isE2EProdHarness() is only ever true for the E2E
  // webServer, never a real deploy.
  if (process.env['NODE_ENV'] === 'production' && !isE2EProdHarness()) {
    throw new Error(
      `Email provider 'file' is not allowed in production. ` +
        `It is a test-only sink that writes emails to a local file. ` +
        `Set EMAIL_PROVIDER to a real provider (or 'console' for dev).`,
    );
  }
  const path = process.env['EMAIL_OUTBOX_PATH'] ?? '/tmp/motir-test-emails.jsonl';
  return async (msg) => {
    const line =
      JSON.stringify({
        to: msg.to,
        subject: msg.subject,
        text: msg.text ?? htmlToText(msg.html),
        html: msg.html,
        sentAt: new Date().toISOString(),
      }) + '\n';
    await appendFile(path, line, { encoding: 'utf8' });
  };
}

// Dev/test-only deterministic fault injector. Wraps whichever provider is
// resolved so a Playwright spec can make a send FAIL on demand — the only way
// to exercise the real Story-1.6 failure path (provider throws → job retries →
// dead-letters → operator replays) end-to-end through the running stack
// (Subtask 1.6.6).
//
// Cross-process by design. The Playwright runner and the Next dev server are
// SEPARATE processes, so an in-memory flag can't reach the provider running in
// the server. We reuse the same channel the file outbox already relies on — a
// file on disk: the test writes a recipient SUBSTRING into the file at
// EMAIL_FAULT_PATH to arm the fault, and deletes the file to disarm it. The
// provider reads the file on every send and throws iff the file exists and its
// content is a (case-insensitive) substring of `msg.to`.
//
// Per-recipient, not global. Because the trigger is the RECIPIENT matching the
// armed substring (not a blanket "fail everything" switch), only the spec's
// chosen forced-failure address fails; every other email in the same dev
// server keeps flowing. Combined with the file's set/clear lifecycle being
// owned by the spec, the fault scope is per-spec, never global.
//
// Off unless explicitly armed. The wrapper is a no-op unless EMAIL_FAULT_PATH
// is set, so production and ordinary dev never pay for it. Setting it in
// production is refused at module load — like the 'file' provider, this is a
// test harness and must never ship as a deliverability path.
function withFaultInjection(provider: SendEmail): SendEmail {
  const faultPath = process.env['EMAIL_FAULT_PATH'];
  if (faultPath === undefined || faultPath === '') return provider;
  // Refused in real production, allowed under the E2E production harness — same
  // rationale as fileProvider() above (MOTIR-1679).
  if (process.env['NODE_ENV'] === 'production' && !isE2EProdHarness()) {
    throw new Error(
      `EMAIL_FAULT_PATH is set in production. It is a test-only deterministic ` +
        `email-fault injector and must never be enabled in production. Unset it.`,
    );
  }
  return async (msg) => {
    // Read the armed pattern fresh on every send so the test can arm/disarm it
    // mid-run (the forced-failure path arms it, the replay path clears it).
    let pattern: string | null = null;
    try {
      pattern = (await readFile(faultPath, 'utf8')).trim();
    } catch (err) {
      // No file → fault disarmed. Any other error is a real problem.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (pattern && msg.to.toLowerCase().includes(pattern.toLowerCase())) {
      // A typed-ish provider failure: the email.send job surfaces this as a
      // retried run, then a DLQ entry once the retry budget is spent.
      throw new Error(
        `Injected email-delivery fault: send to '${msg.to}' failed deterministically ` +
          `(matched armed pattern '${pattern}' at EMAIL_FAULT_PATH).`,
      );
    }
    return provider(msg);
  };
}

export function getEmailProvider(): SendEmail {
  const provider = process.env['EMAIL_PROVIDER'] ?? 'console';
  switch (provider) {
    case 'console':
      return consoleProvider;
    case 'file':
      return fileProvider();
    case 'resend':
      return unimplementedProvider('resend');
    case 'postmark':
      return unimplementedProvider('postmark');
    default:
      throw new Error(
        `Unknown EMAIL_PROVIDER='${provider}'. ` +
          `Valid values: 'console' (default), 'file' (dev/test only), 'resend', 'postmark'. ` +
          `See lib/email.ts for the abstraction.`,
      );
  }
}

export const sendEmail: SendEmail = withFaultInjection(getEmailProvider());
