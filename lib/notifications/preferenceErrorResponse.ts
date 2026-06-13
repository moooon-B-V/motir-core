import { NextResponse } from 'next/server';
import {
  NotificationEventTypeNotSettableError,
  UnknownNotificationChannelError,
  UnknownNotificationEventTypeError,
} from '@/lib/notifications/preferenceErrors';

/**
 * Shared typed-error → HTTP mapping for the notification-preference route
 * (Story 5.7 · Subtask 5.7.6), the `mapSavedFilterError` pattern. Returns
 * `null` for errors the caller should rethrow.
 *
 *   UnknownNotificationChannelError / UnknownNotificationEventTypeError /
 *   NotificationEventTypeNotSettableError → 422 (an invalid INCOMING channel /
 *     event type / a disabled seam — a rejection, not a server fault)
 */
export function mapNotificationPreferenceError(err: unknown): NextResponse | null {
  if (
    err instanceof UnknownNotificationChannelError ||
    err instanceof UnknownNotificationEventTypeError ||
    err instanceof NotificationEventTypeNotSettableError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
