import { sendEmail } from '@/lib/email';
import {
  passwordResetEmail,
  type PasswordResetEmailProps,
} from '@/lib/emailTemplates/passwordReset';
import {
  workspaceInviteEmail,
  type WorkspaceInviteEmailProps,
} from '@/lib/emailTemplates/workspaceInvite';
import {
  mentionNotificationEmail,
  type MentionNotificationEmailProps,
} from '@/lib/emailTemplates/mentionNotification';

// The execution-side email service (Story 1.6 · Subtask 1.6.3). This is the
// ONE place a transactional email is rendered and handed to the provider:
// it picks the template by the `template` discriminant, renders it, and
// dispatches via `sendEmail`. Per prodect-core/CLAUDE.md ("Email templates
// live in lib/emailTemplates/, NOT in service code" + "lib/email.ts ... ONLY
// services import this"), composition + dispatch belong to a service and the
// template stays a pure render function.
//
// WHO CALLS THIS: only the `email.send` background job
// (lib/jobs/definitions/emailSend.ts), via the injected jobServices bag. The
// request-lifecycle callers (password-reset in lib/auth, invites in
// workspaceInvitesService) NO LONGER render or dispatch inline — they enqueue
// an `email.send` event with sendEvent(). So the slow/flaky provider call
// runs in the durable job (with retries), not in the user-facing request.
// An ESLint no-restricted-imports rule pins `@/lib/email` to this file so a
// future caller can't regress to a synchronous send.

/**
 * A transactional email to render + dispatch. Discriminated by `template`;
 * each arm's `data` is exactly the matching template's props, so adding a
 * template is: add a template file, add an arm here, add a `case` in `send`.
 */
export type TransactionalEmail =
  | { to: string; template: 'password-reset'; data: PasswordResetEmailProps }
  | { to: string; template: 'workspace-invite'; data: WorkspaceInviteEmailProps }
  | { to: string; template: 'mention-notification'; data: MentionNotificationEmailProps };

/** Every template discriminant — handy for exhaustiveness + tests. */
export type EmailTemplate = TransactionalEmail['template'];

export const emailService = {
  /**
   * Render the chosen template and dispatch it. Throws whatever the provider
   * throws (the job wrapper turns that into a retried run, then a DLQ entry in
   * 1.6.4) — this method does not swallow failures, so a down provider is
   * visible to the runtime rather than silently dropped.
   */
  async send(message: TransactionalEmail): Promise<void> {
    const rendered = await renderTemplate(message);
    await sendEmail({ to: message.to, ...rendered });
  },
};

async function renderTemplate(message: TransactionalEmail) {
  switch (message.template) {
    case 'password-reset':
      return passwordResetEmail(message.data);
    case 'workspace-invite':
      return workspaceInviteEmail(message.data);
    case 'mention-notification':
      return mentionNotificationEmail(message.data);
    default: {
      // Exhaustiveness guard: a new template arm without a case here is a
      // compile error, not a silent fall-through.
      const _exhaustive: never = message;
      throw new Error(`Unhandled email template: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
