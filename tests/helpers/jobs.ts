import { vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { inngest } from '@/lib/jobs/client';
import { emailSend } from '@/lib/jobs/definitions/emailSend';
import type { EmailSendData } from '@/lib/jobs/types';

// Test helpers for the async email path (Story 1.6 · Subtask 1.6.3).
//
// After the 1.6.3 migration, password-reset + invite sends no longer call the
// email provider inline — they `sendEvent('email.send', …)`, which publishes
// to Inngest via the client's `send()`. In tests there is no dev server /
// cloud, so we SPY on `inngest.send` to (a) stop the publish from hitting the
// network and (b) capture the enqueued events for assertion. Then, to exercise
// the actual delivery, we drive the `email.send` job in-process with
// `runEmailSendJob` — the same InngestTestEngine surface the 1.6.2 ping smoke
// test uses.

export interface CapturedEmailEvent {
  name: 'email.send';
  data: EmailSendData;
}

/**
 * Spy on the Inngest client's `send()` so no test reaches a dev server / cloud,
 * and collect the `email.send` events that `sendEvent()` publishes. Returns the
 * live array (mutated as events arrive) plus a `restore()`. Install in a
 * `beforeEach`; call `restore()` in the matching `afterEach`.
 */
export function captureEmailEvents(): { events: CapturedEmailEvent[]; restore: () => void } {
  const events: CapturedEmailEvent[] = [];
  const spy = vi.spyOn(inngest, 'send').mockImplementation((async (payload: unknown) => {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const entry of list) {
      const evt = entry as { name?: string; data?: EmailSendData };
      if (evt?.name === 'email.send' && evt.data) {
        events.push({ name: 'email.send', data: evt.data });
      }
    }
    return { ids: [] as string[] };
  }) as typeof inngest.send);
  return { events, restore: () => spy.mockRestore() };
}

/**
 * Run the real `email.send` job in-process against a given event payload, the
 * same way 1.6.2's ping smoke test drives `system.ping`. The handler renders
 * the template via emailService and dispatches through the console provider
 * (so a `captureConsoleEmails()` spy sees the `[EMAIL]` line), and the
 * defineJob wrapper writes the job_run row.
 */
export async function runEmailSendJob(data: EmailSendData): Promise<{ result?: unknown }> {
  const engine = new InngestTestEngine({
    function: emailSend,
    events: [{ name: 'email.send', data }],
  });
  return engine.execute();
}

/**
 * Capture the dev-console provider's `[EMAIL] …` stdout lines (the same shape
 * 1.1.6's console provider emits), dropping all other console.log noise so the
 * reporter stays clean.
 */
export function captureConsoleEmails(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((arg) => {
    if (typeof arg === 'string' && arg.startsWith('[EMAIL]')) lines.push(arg);
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** Any event published through the Inngest client — name + raw payload. */
export interface CapturedJobEvent {
  name: string;
  data: unknown;
}

/**
 * Like {@link captureEmailEvents}, but collects EVERY event `sendEvent()`
 * publishes — the 5.4.5 emit-seam assertions read `work-item/transitioned`
 * off the same spy that stops the publish from hitting the network.
 */
export function captureJobEvents(): { events: CapturedJobEvent[]; restore: () => void } {
  const events: CapturedJobEvent[] = [];
  const spy = vi.spyOn(inngest, 'send').mockImplementation((async (payload: unknown) => {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const entry of list) {
      const evt = entry as { name?: string; data?: unknown };
      if (evt?.name) events.push({ name: evt.name, data: evt.data });
    }
    return { ids: [] as string[] };
  }) as typeof inngest.send);
  return { events, restore: () => spy.mockRestore() };
}
