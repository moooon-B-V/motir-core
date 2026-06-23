import { dailyHealthCheck } from './definitions/dailyHealthCheck';
import { emailSend } from './definitions/emailSend';
import {
  mentionNotifyOnCommentCreated,
  mentionNotifyOnWorkItemMentioned,
} from './definitions/mentionNotify';
import {
  watcherNotifyOnCommentCreated,
  watcherNotifyOnTransitioned,
} from './definitions/watcherNotify';
import {
  notificationFanInOnCommentCreated,
  notificationFanInOnWorkItemMentioned,
  notificationFanInOnTransitioned,
} from './definitions/notificationFanIn';
import { attachmentGc } from './definitions/attachmentGc';
import { filterSubscriptionTick } from './definitions/filterSubscriptionTick';
import { filterSubscriptionDeliver } from './definitions/filterSubscriptionDeliver';
import {
  automationEngineOnCreated,
  automationEngineOnFieldChanged,
  automationEngineOnTransitioned,
  automationEngineOnCommented,
  automationRetentionSweep,
} from './definitions/automationEngine';
import { billingSeatSync } from './definitions/billingSeatSync';

// The list of registered Inngest functions the serve route mounts (Story 1.6 ·
// Subtask 1.6.2). Adding a new job = define it under `definitions/` and add it
// here; the serve route imports from THIS file, never from individual job
// files, so a new job never touches `app/api/inngest/route.ts`.
export const jobFunctions = [
  dailyHealthCheck,
  emailSend,
  mentionNotifyOnCommentCreated,
  mentionNotifyOnWorkItemMentioned,
  watcherNotifyOnCommentCreated,
  watcherNotifyOnTransitioned,
  notificationFanInOnCommentCreated,
  notificationFanInOnWorkItemMentioned,
  notificationFanInOnTransitioned,
  attachmentGc,
  filterSubscriptionTick,
  filterSubscriptionDeliver,
  automationEngineOnCreated,
  automationEngineOnFieldChanged,
  automationEngineOnTransitioned,
  automationEngineOnCommented,
  automationRetentionSweep,
  billingSeatSync,
];
