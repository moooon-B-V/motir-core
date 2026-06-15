import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { NotificationPreferencesCard } from '../_components/NotificationPreferencesCard';

// The Notifications pane of the account-settings area (Story 7.8 · Subtask
// 7.8.12). The shipped per-user notification-preferences matrix (Story 5.7 ·
// 5.7.6), now in its own route/pane inside the area — NO redesign, it just moves
// here (the design's Panel 2 + the subtask scope). The card keeps its own header
// (title + helper + save indicator) and its shipped `settings.account.notifications`
// keys; it is the client island that owns its optimistic state + mutations. A
// server component (session gate + the initial matrix read).
export default async function AccountNotificationsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const notificationMatrix = await notificationPreferencesService.getMatrix(session.user.id);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <NotificationPreferencesCard initial={notificationMatrix} />
    </div>
  );
}
