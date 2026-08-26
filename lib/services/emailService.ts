import { emailProviderName, sendEmail, type EmailSendResult } from '@/lib/email';
import { emailDeliveryService } from '@/lib/services/emailDeliveryService';
import {
  passwordResetEmail,
  type PasswordResetEmailProps,
} from '@/lib/emailTemplates/passwordReset';
import { emailChangeEmail, type EmailChangeEmailProps } from '@/lib/emailTemplates/emailChange';
import {
  workspaceInviteEmail,
  type WorkspaceInviteEmailProps,
} from '@/lib/emailTemplates/workspaceInvite';
import {
  mentionNotificationEmail,
  type MentionNotificationEmailProps,
} from '@/lib/emailTemplates/mentionNotification';
import {
  watcherCommentNotificationEmail,
  type WatcherCommentNotificationEmailProps,
} from '@/lib/emailTemplates/watcherCommentNotification';
import {
  watcherTransitionNotificationEmail,
  type WatcherTransitionNotificationEmailProps,
} from '@/lib/emailTemplates/watcherTransitionNotification';
import {
  filterSubscriptionEmail,
  type FilterSubscriptionEmailProps,
} from '@/lib/emailTemplates/filterSubscription';
import {
  automationRuleFailedEmail,
  type AutomationRuleFailedEmailProps,
} from '@/lib/emailTemplates/automationRuleFailed';

// The execution-side email service (Story 1.6 · Subtask 1.6.3). This is the
// ONE place a transactional email is rendered and handed to the provider:
// it picks the template by the `template` discriminant, renders it, and
// dispatches via `sendEmail`. Per motir-core/CLAUDE.md ("Email templates
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
  | { to: string; template: 'email-change'; data: EmailChangeEmailProps }
  | { to: string; template: 'workspace-invite'; data: WorkspaceInviteEmailProps }
  | { to: string; template: 'mention-notification'; data: MentionNotificationEmailProps }
  | {
      to: string;
      template: 'watcher-comment-notification';
      data: WatcherCommentNotificationEmailProps;
    }
  | {
      to: string;
      template: 'watcher-transition-notification';
      data: WatcherTransitionNotificationEmailProps;
    }
  | { to: string; template: 'filter-subscription'; data: FilterSubscriptionEmailProps }
  | {
      to: string;
      template: 'automation-rule-failed';
      data: AutomationRuleFailedEmailProps;
    };

/** Every template discriminant — handy for exhaustiveness + tests. */
export type EmailTemplate = TransactionalEmail['template'];

/**
 * A `TransactionalEmail` plus the background-job envelope the `email.send` job
 * already carries. Every field beyond the email itself is OPTIONAL, because
 * the email domain knows nothing about job envelopes and a direct caller need
 * supply none of them — they are what the delivery record (MOTIR-3513) is
 * correlated by, not what the send needs to work.
 *
 * `runId` / `eventId` are the ACTIVE lane's own identifiers — a `job_queue.id`
 * cuid on the Postgres engine, Inngest's ids on the Inngest lane. They are
 * recorded as given rather than normalised; the discriminator is the id's
 * shape, which is what the two ledgers already record.
 */
export type SendableEmail = TransactionalEmail & {
  idempotencyKey?: string;
  workspaceId?: string | null;
  runId?: string | null;
  eventId?: string | null;
};

export const emailService = {
  /**
   * Render the chosen template and dispatch it. Throws whatever the provider
   * throws (the job wrapper turns that into a retried run, then a DLQ entry in
   * 1.6.4) — this method does not swallow failures, so a down provider is
   * visible to the runtime rather than silently dropped.
   *
   * `idempotencyKey` is the envelope field the `email.send` event already
   * carries (`EmailSendData`), threaded to the provider so a job RETRY of an
   * accepted send is deduped AT THE PROVIDER too (MOTIR-1127). It is optional
   * because the parameter's shape is the email domain's `TransactionalEmail`,
   * which knows nothing about background-job envelopes; the job supplies it,
   * a direct caller need not. No caller changed to gain this — the job was
   * already passing the whole `EmailSendData` payload, envelope included.
   */
  async send(message: SendableEmail): Promise<EmailSendResult> {
    const rendered = await renderTemplate(message);
    const result = await sendEmail({
      to: message.to,
      ...rendered,
      idempotencyKey: message.idempotencyKey,
    });
    // AFTER the send returned, and deliberately not inside it: this records
    // something that has already happened. `recordAccepted` swallows its own
    // failures for that reason — see emailDeliveryService's header.
    await emailDeliveryService.recordAccepted({
      providerMessageId: result.providerMessageId,
      provider: emailProviderName(),
      recipient: message.to,
      template: message.template,
      workspaceId: message.workspaceId ?? null,
      idempotencyKey: message.idempotencyKey ?? null,
      runId: message.runId ?? null,
      eventId: message.eventId ?? null,
    });
    return result;
  },
};

async function renderTemplate(message: TransactionalEmail) {
  switch (message.template) {
    case 'password-reset':
      return passwordResetEmail(message.data);
    case 'email-change':
      return emailChangeEmail(message.data);
    case 'workspace-invite':
      return workspaceInviteEmail(message.data);
    case 'mention-notification':
      return mentionNotificationEmail(message.data);
    case 'watcher-comment-notification':
      return watcherCommentNotificationEmail(message.data);
    case 'watcher-transition-notification':
      return watcherTransitionNotificationEmail(message.data);
    case 'filter-subscription':
      return filterSubscriptionEmail(message.data);
    case 'automation-rule-failed':
      return automationRuleFailedEmail(message.data);
    default: {
      // Exhaustiveness guard: a new template arm without a case here is a
      // compile error, not a silent fall-through.
      const _exhaustive: never = message;
      throw new Error(`Unhandled email template: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
