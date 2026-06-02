import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import { EMAIL_SEND_IDEMPOTENCY } from '@/lib/jobs/definitions/emailSend';
import type { EmailSendData } from '@/lib/jobs/types';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureConsoleEmails, runEmailSendJob } from '../helpers/jobs';

// The canonical production job (Story 1.6 · Subtask 1.6.3). These tests drive
// `email.send` IN-PROCESS via @inngest/test (no dev server / cloud) and assert
// the contract the job provides:
//   1. it renders the chosen template + dispatches via the provider (the
//      `[EMAIL]` line proves emailService → sendEmail ran);
//   2. the defineJob wrapper persisted a succeeded job_run row carrying the
//      event's workspaceId (null for cross-workspace) + idempotencyKey;
//   3. the idempotency expression is wired into the job's Inngest config (the
//      runtime dedup itself is enforced by Inngest, not the in-process harness
//      — see docs/jobs.md → "Canonical job: email.send").

const RESET_URL = 'http://localhost:3000/reset-password/reset-token-xyz?callbackURL=';

function passwordResetEvent(overrides: Partial<EmailSendData> = {}): EmailSendData {
  return {
    workspaceId: null,
    idempotencyKey: 'reset-token-xyz',
    to: 'reset@example.com',
    template: 'password-reset',
    data: { recipientName: 'Reset User', resetUrl: RESET_URL },
    ...overrides,
  } as EmailSendData;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('email.send job — handler', () => {
  let emails: ReturnType<typeof captureConsoleEmails>;
  beforeEach(() => {
    emails = captureConsoleEmails();
  });
  afterEach(() => {
    emails.restore();
  });

  it('renders + sends the password-reset template and records an untenanted run', async () => {
    const { result } = await runEmailSendJob(passwordResetEvent());

    expect(result).toEqual({ to: 'reset@example.com', template: 'password-reset' });

    // The console provider emitted exactly one email with the rendered
    // subject, the recipient, and the (unredacted) reset link.
    expect(emails.lines).toHaveLength(1);
    expect(emails.lines[0]).toContain('To: reset@example.com');
    expect(emails.lines[0]).toContain('Reset your Prodect password');
    expect(emails.lines[0]).toContain(RESET_URL);

    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.functionId).toBe('email.send');
    expect(run.eventName).toBe('email.send');
    expect(run.status).toBe('succeeded');
    expect(run.workspaceId).toBeNull(); // cross-workspace → null FK, NOT "system"
    expect(run.idempotencyKey).toBe('reset-token-xyz');
    expect(run.finishedAt).not.toBeNull();
    expect(run.failure).toBeNull();
  });

  it('renders + sends the workspace-invite template scoped to a real workspace', async () => {
    const inviter = await usersService.createUser({
      email: 'inviter@example.com',
      password: 'hunter2hunter2',
      name: 'Inviter',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme Co.',
      ownerUserId: inviter.id,
    });

    const acceptUrl = 'http://localhost:3000/invite/accept?token=invite-token-1';
    const event: EmailSendData = {
      workspaceId: workspace.id,
      idempotencyKey: 'invite-token-1',
      to: 'newbie@example.com',
      template: 'workspace-invite',
      data: { inviterName: 'Inviter', workspaceName: 'Acme Co.', acceptUrl },
    };

    const { result } = await runEmailSendJob(event);
    expect(result).toEqual({ to: 'newbie@example.com', template: 'workspace-invite' });

    expect(emails.lines).toHaveLength(1);
    expect(emails.lines[0]).toContain('To: newbie@example.com');
    expect(emails.lines[0]).toContain("You're invited to join Acme Co. on Prodect");
    expect(emails.lines[0]).toContain(acceptUrl);

    const run = (await db.jobRun.findMany())[0]!;
    expect(run.status).toBe('succeeded');
    expect(run.workspaceId).toBe(workspace.id); // tenanted → real FK
    expect(run.idempotencyKey).toBe('invite-token-1');
  });
});

describe('email.send job — idempotency wiring', () => {
  // The runtime dedup is an Inngest platform behavior the in-process harness
  // can't simulate; what we CAN (and must) verify is that the dedup is wired:
  // the canonical expression is the documented one, and defineJob forwards it
  // into the Inngest function config. That's the contract a future edit could
  // silently break.

  it('uses the documented idempotency-key expression', () => {
    expect(EMAIL_SEND_IDEMPOTENCY).toBe('event.data.idempotencyKey');
  });

  it('defineJob forwards the idempotency expression into the Inngest config', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob({ id: 'email.send', idempotency: EMAIL_SEND_IDEMPOTENCY }, () => undefined);
      const config = spy.mock.calls.at(-1)?.[0] as { idempotency?: string } | undefined;
      expect(config?.idempotency).toBe('event.data.idempotencyKey');
    } finally {
      spy.mockRestore();
    }
  });
});
