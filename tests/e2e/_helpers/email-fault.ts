// Deterministic email-fault control for E2E (Subtask 1.6.6).
//
// The dev server's email provider is wrapped by lib/email.ts's fault injector,
// which reads the file at EMAIL_FAULT_PATH on every send and throws when the
// recipient contains the armed substring. These helpers are the test-side of
// that channel: arm the fault before the forced-failure scenario, clear it
// before the replay scenario.
//
// Why a file and not an env var or in-memory flag: the Playwright runner and
// the Next dev server are separate processes (same reason email-capture.ts
// polls a file). An env var is fixed at server boot — it can't be flipped
// mid-spec to let a replay succeed. A file on disk can.
//
// EMAIL_FAULT_PATH is duplicated here (default) to match playwright.config.ts's
// webServer.env, exactly as email-capture.ts duplicates EMAIL_OUTBOX_PATH —
// the runner process doesn't auto-load the dev server's env.

import { rm, writeFile } from 'node:fs/promises';

const EMAIL_FAULT_PATH = process.env['EMAIL_FAULT_PATH'] ?? '/tmp/prodect-test-email-fault';

/**
 * Arm the fault: any subsequent send whose recipient contains `recipientPattern`
 * (case-insensitive substring) throws in the provider. Scope is whatever the
 * caller chooses — pass a substring unique to the spec's forced-failure address
 * so no other recipient is affected.
 */
export async function armEmailFault(recipientPattern: string): Promise<void> {
  await writeFile(EMAIL_FAULT_PATH, recipientPattern, 'utf8');
}

/**
 * Disarm the fault by removing the file. Idempotent — clearing an already-clear
 * fault is a no-op (so it's safe to call in afterEach unconditionally).
 */
export async function clearEmailFault(): Promise<void> {
  await rm(EMAIL_FAULT_PATH, { force: true });
}
